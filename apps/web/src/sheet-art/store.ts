import {
  type CreatorKind,
  type ModelInfo,
  type SheetFields,
  savedCardArtSource,
  savedCardKind,
} from "@ephemera/core";
import { createStore } from "zustand/vanilla";
import {
  ART_EMPTY,
  type ArtImage,
  type ArtSliceDeps,
  type ArtSliceState,
  createArtSlice,
} from "../creator/art-slice.ts";
import { PORTRAIT_UPLOAD_TIMEOUT_MS } from "../portraits/limits.ts";
import type { PortraitResult } from "../portraits/queries.ts";
import { portraitDefault } from "../rework/portrait-switch.ts";

/*
 * New art for a saved character (PRINCIPLES.md 1): the owner's choices, the
 * run and the four candidates are creation drafts in this store, in tab
 * memory only, bound to the sheet that opened it. Leaving the sheet,
 * opening it for another character and `pagehide` drop the session: the
 * epoch advances, what is in flight is aborted and a late result is dropped.
 * Use as portrait is the one boundary where a candidate leaves it, through
 * the existing upload.
 */

/** The sheet's card as a run or a save reads it when it starts. */
export interface SheetArtCard {
  fields: Pick<
    SheetFields,
    "name" | "description" | "personality" | "scenario" | "firstMessage" | "tags"
  >;
  /** The stored portrait's version; null for none. */
  portrait: number | null;
}

/** The sheet the session belongs to. */
export interface SheetArtBinding {
  characterId: string;
  /** Reads the sheet's live fields when a run or a save starts (a ref the sheet keeps current). */
  card: () => SheetArtCard;
  /** The sheet's one portrait-update owner (local version, cache, gallery, arrival), called on a saved Use. */
  onPortrait: (version: number) => void;
}

/** Use as portrait, once asked: saving, waiting for a sign-in, failed with its reason, or saved. */
export type UseRun =
  | { status: "saving" }
  | { status: "waiting" }
  | { status: "failed"; reason: string }
  | { status: "saved"; version: number };

export interface SheetArtState extends ArtSliceState {
  /** The bound character; null until a sheet opens the studio, and after a drop. */
  characterId: string | null;
  /** Subject, Group or Scenario: the image prompt's shape, preset from the card's tags. */
  kind: CreatorKind;
  /** The owner's Match choice; null follows `portraitDefault` for the effective model. */
  reference: boolean | null;
  useRun: UseRun | null;
  /** A Use the sign-in refused; one renewal retries it. */
  usePending: boolean;
  /**
   * Binds the session to the sheet opening the studio: the same character's
   * live session is kept with the new binding, anything else is dropped.
   */
  open: (binding: SheetArtBinding) => void;
  setKind: (kind: CreatorKind) => void;
  setReference: (on: boolean) => void;
  /** Uploads the chosen candidate as the portrait; true once saved, which drops the session. */
  use: () => Promise<boolean>;
  /** Retries the Use a sign-in refused, if it still waits. */
  resumeUse: () => void;
  /** The studio closes: a run in flight stops, a Use waiting for the sign-in is dropped; the candidates stay. */
  close: () => void;
  /** Empties everything, the binding included: leaving the sheet, `pagehide`, a saved Use. */
  clear: () => void;
}

interface SheetArtDeps
  extends Omit<ArtSliceDeps, "subject" | "reference" | "locked" | "register" | "onArtPending"> {
  /** The model the image prompt defaults to without Settings' image prompt model: the saved one. */
  savedModel: () => string | null;
  /** The catalog entry for a model, or undefined; throws `SignedOut` when the sign-in refused the list. */
  modelInfo: (model: string) => Promise<ModelInfo | undefined>;
  /** Uploads the PNG as the character's portrait (the existing upload), ended by `signal`. */
  savePortrait: (id: string, png: ArtImage, signal: AbortSignal) => Promise<PortraitResult>;
  /** While an AI Rework works or is under review, the portrait waits. */
  reworkLocked: () => boolean;
  /** Told whether portraits are on their way, for the navigation lamp's pace. */
  writing: (active: boolean) => void;
}

type Session = Pick<SheetArtState, "characterId" | "kind" | "reference" | "useRun" | "usePending">;

const EMPTY: Session = {
  characterId: null,
  kind: "subject",
  reference: null,
  useRun: null,
  usePending: false,
};

export function createSheetArtStore(deps: SheetArtDeps) {
  const store = createStore<SheetArtState>()((set, get) => {
    const inFlight = new Set<AbortController>();
    /** Held apart from the state: functions over the sheet, replaced by every opening. */
    let binding: SheetArtBinding | undefined;
    /** Bumped by every Use and every drop, so an upload answered late changes nothing. */
    let uses = 0;

    /** Aborts every request and advances the epoch, so nothing late lands. */
    const drop = () => {
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
      uses++;
      return get().epoch + 1;
    };

    /** This session's save is under way: uploading, or waiting for the sign-in to send it again. */
    const saving = () => {
      const status = get().useRun?.status;
      return status === "saving" || status === "waiting";
    };
    /**
     * The sheet holds the portrait: a rework, or this session's own save. A
     * save waiting for the sign-in holds the choice and the art too, so the
     * renewal uploads the candidate Use was pressed on and nothing paints
     * under it.
     */
    const locked = () => deps.reworkLocked() || saving();

    return {
      epoch: 0,
      ...ART_EMPTY,
      ...EMPTY,

      ...createArtSlice(set, get, {
        ...deps,
        subject: () => {
          if (binding === undefined) return null;
          const { kind } = get();
          const { fields } = binding.card();
          return {
            kind,
            source: savedCardArtSource(kind, fields, fields.name),
            model: deps.savedModel(),
            reasoning: "provider-default",
          };
        },
        // The stored portrait goes to the prompt model as the switch shows it for the same model.
        reference: async (model) => {
          const bound = binding;
          if (bound === undefined || bound.card().portrait === null) return undefined;
          const shown = portraitDefault(await deps.modelInfo(model), true);
          const on = shown.enabled && (get().reference ?? shown.on);
          return on ? { characterId: bound.characterId } : undefined;
        },
        locked,
        register: (controller) => {
          inFlight.add(controller);
          return () => inFlight.delete(controller);
        },
      }),

      open: (next) => {
        const state = get();
        const live =
          state.art !== null ||
          state.images.length > 0 ||
          state.artModel !== null ||
          state.artReasoning !== null ||
          state.artDirection !== "" ||
          state.artComposition !== "regular" ||
          state.artLook !== "auto" ||
          state.reference !== null;
        if (state.characterId === next.characterId && live) {
          binding = next;
          return;
        }
        get().clear();
        binding = next;
        set({ characterId: next.characterId, kind: savedCardKind(next.card().fields.tags) });
      },

      setKind: (kind) =>
        set({
          kind,
          ...(kind === "subject" ? {} : { artComposition: "regular" }),
          ...(kind === "scenario" ? { artLook: "auto" } : {}),
        }),
      setReference: (reference) => set({ reference }),

      use: async () => {
        const bound = binding;
        const { images, selected } = get();
        const image = images[selected];
        // A save waiting for the sign-in is this one's to send again; one uploading is not.
        const held = deps.reworkLocked() || get().useRun?.status === "saving";
        if (bound === undefined || held || image === undefined) return false;
        const attempt = ++uses;
        set({ useRun: { status: "saving" }, usePending: false });
        const signal = AbortSignal.timeout(PORTRAIT_UPLOAD_TIMEOUT_MS);
        const result = await deps.savePortrait(bound.characterId, image, signal);
        if (uses !== attempt) return false;
        if (result.ok) {
          bound.onPortrait(result.version);
          set({ useRun: { status: "saved", version: result.version } });
          get().clear();
          return true;
        }
        if (result.signedOut) {
          set({ useRun: { status: "waiting" }, usePending: true });
          return false;
        }
        set({
          useRun: {
            status: "failed",
            reason: signal.aborted ? "The upload took too long." : result.reason,
          },
        });
        return false;
      },

      resumeUse: () => {
        if (get().usePending && get().useRun?.status === "waiting") void get().use();
      },

      close: () => {
        get().stopArt();
        if (get().useRun?.status === "saving") return;
        uses++;
        set({ useRun: null, usePending: false });
      },

      clear: () => {
        binding = undefined;
        set({ ...ART_EMPTY, ...EMPTY, epoch: drop() });
      },
    };
  });

  // The lamp breathes at the in-flight pace while portraits are on their way; told only on a change.
  let writing = false;
  store.subscribe((state) => {
    const now = state.art?.status === "running";
    if (now === writing) return;
    writing = now;
    deps.writing(now);
  });

  return store;
}
