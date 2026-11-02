import {
  type ArtLookId,
  type ArtStreamEvent,
  CREATOR_ART,
  type CreatorArtComposition,
  type CreatorArtRequest,
  type CreatorArtStatus,
  type CreatorErrorCode,
  type CreatorKind,
  DEFAULT_SETTINGS,
  imagePromptModelOf,
  type ReasoningEffort,
} from "@ephemera/core";
import type { StoreApi } from "zustand/vanilla";
import { SignedOut } from "../signin/signin.ts";

/*
 * One art session, whoever hosts it (the creator's showcase, a saved
 * character's sheet): the owner's choices for the next batch, the run that
 * paints it and the batch on show, all creation drafts in tab memory. The
 * host owns the epoch and drops the session; a run reads the epoch to drop
 * its late results, and registers its request so the host's drop aborts it.
 */

export type StreamArt = (
  request: CreatorArtRequest,
  signal: AbortSignal,
) => Promise<AsyncIterable<ArtStreamEvent>>;

/**
 * Where a run stands: checking that ComfyUI is ready, the server's phases
 * (the image prompt, the queue, loading the models, sampling), then the
 * batch arriving (`value` of `max` images).
 */
export type ArtPhase =
  | "status"
  | Extract<ArtStreamEvent, { type: "progress" }>["phase"]
  | "receiving";

/**
 * The latest request for portraits: not asked for (with the status that said
 * so), being made, waiting for a sign-in, stopped by the owner, failed, or
 * complete. A batch is all or nothing: its images reach `images` only once
 * all four arrived, and a new request leaves the batch on show until it is
 * replaced. `empty` and `no_model` fail a run before any request: nothing to
 * paint from, or no model to write the image prompt.
 */
export type ArtRun =
  | { status: "skipped"; reason: Exclude<CreatorArtStatus["state"], "ready"> | "unknown" }
  | {
      status: "running";
      phase: ArtPhase;
      value: number;
      max: number;
      /** While ComfyUI is busy: the run's place in its waiting list, 1 being next. */
      position?: number;
      /** When the run started and when the last word from it arrived, on the page's clock. */
      started: number;
      heard: number;
    }
  | { status: "waiting" }
  | { status: "stopped" }
  | { status: "failed"; code: CreatorErrorCode | "stream" | "empty" | "no_model" }
  | { status: "complete" };

/** A candidate portrait: PNG bytes in memory, never a URL. */
export type ArtImage = Uint8Array<ArrayBuffer>;

/** What a host paints from, read when New art is pressed. */
interface ArtSubject {
  kind: CreatorKind;
  /** Empty: nothing to paint from (the run fails with `empty`). */
  source: string;
  /** Defaults when none is chosen in the session; null: no model (the run fails with `no_model`). */
  model: string | null;
  reasoning: ReasoningEffort;
}

/** The look for the next batch: one from the catalogue, or auto to let the model choose. */
export type ArtLookChoice = ArtLookId | "auto";

/** The slice's own keys; `pending` is not among them, so any host's `pending` may coexist. */
export interface ArtSliceState {
  /** Owned by the host; the slice reads it to drop late results. */
  epoch: number;
  /** The model chosen under New art to write the image prompt; null follows the host's. */
  artModel: string | null;
  /** The image prompt's effort chosen under New art; null follows the host's. */
  artReasoning: ReasoningEffort | null;
  /** The owner's direction for the next batch, read when it starts; dropped with the session. */
  artDirection: string;
  /** Subject composition for the next batch, kept only in this session. */
  artComposition: CreatorArtComposition;
  /** Look for the next batch, kept only in this session; auto lets the model choose. */
  artLook: ArtLookChoice;
  art: ArtRun | null;
  /** The batch on show: the latest whole one, empty until one arrives. */
  images: ArtImage[];
  /** The chosen portrait's index in the batch. */
  selected: number;
  /** A run the sign-in refused before it answered; one renewal resends it. */
  artPending: boolean;
  setArtModel: (model: string) => void;
  setArtReasoning: (reasoning: ReasoningEffort) => void;
  setArtDirection: (direction: string) => void;
  setArtComposition: (composition: CreatorArtComposition) => void;
  setArtLook: (look: ArtLookChoice) => void;
  /** Asks for a batch of portraits; the batch on show stays until a new one is whole. */
  requestArt: () => void;
  /** Ends a run that is `running` or `waiting`; the batch on show and its choice stay. */
  stopArt: () => void;
  select: (index: number) => void;
  /** Sends the run a sign-in interrupted once more, if it still waits. */
  resumeArt: () => void;
}

export interface ArtSliceDeps {
  streamArt: StreamArt;
  /** The portrait status when a run starts; art is asked for only when it is ready. */
  artStatus: (workflow: string) => Promise<CreatorArtStatus>;
  /** The workflow this tab shows, read when art starts; the default without one. */
  workflow?: () => string;
  /** Settings' image prompt model, read when art starts; none without this (`imagePromptModelOf`). */
  imagePromptModel?: () => string | null;
  /** The effort the image prompt's `model` takes for the chosen `reasoning`; that one without this. */
  artEffort?: (model: string, reasoning: ReasoningEffort) => Promise<ReasoningEffort>;
  /** False while the Authelia session is gone. */
  signedIn?: () => boolean;
  /** The host's subject when New art is pressed; null refuses the run silently (nothing bound). */
  subject: () => ArtSubject | null;
  /**
   * Asynchronous preparation after the effort is narrowed and before the
   * request: the sheet decides the reference here. A sign-in refusal waits,
   * another throw fails the run as `stream`.
   */
  reference?: (model: string) => Promise<{ characterId: string } | undefined>;
  /** The host forbids art now (the creator while Keep saves; the sheet while held). */
  locked: () => boolean;
  /** Every in-flight controller, so the host's drop aborts it; returns its release. */
  register: (controller: AbortController) => () => void;
  /** Mirrors `artPending` into a host field that must stay in step (the creator's `pending`). */
  onArtPending?: (pending: boolean) => void;
}

/** A session's art before anything is chosen or painted. */
export const ART_EMPTY: Pick<
  ArtSliceState,
  | "artModel"
  | "artReasoning"
  | "artDirection"
  | "artComposition"
  | "artLook"
  | "art"
  | "images"
  | "selected"
  | "artPending"
> = {
  artModel: null,
  artReasoning: null,
  artDirection: "",
  artComposition: "regular",
  artLook: "auto",
  art: null,
  images: [],
  selected: 0,
  artPending: false,
};

/** What dropping the subject empties: its art and direction; the model choices stay. */
export const ART_DROPPED: Pick<
  ArtSliceState,
  "art" | "artDirection" | "artComposition" | "artLook" | "images" | "selected" | "artPending"
> = {
  art: null,
  artDirection: "",
  artComposition: "regular",
  artLook: "auto",
  images: [],
  selected: 0,
  artPending: false,
};

/** An effort as requests carry it: none for the model default. */
export const effortOf = ({ reasoning }: { reasoning: ReasoningEffort }) =>
  reasoning === "provider-default" ? {} : { reasoning };

/**
 * The art actions over a host's store. `set` and `get` are the host's own:
 * a host whose state extends `ArtSliceState` passes them as they are.
 */
export function createArtSlice(
  set: StoreApi<ArtSliceState>["setState"],
  get: StoreApi<ArtSliceState>["getState"],
  deps: ArtSliceDeps,
): Pick<
  ArtSliceState,
  | "setArtModel"
  | "setArtReasoning"
  | "setArtDirection"
  | "setArtComposition"
  | "setArtLook"
  | "requestArt"
  | "stopArt"
  | "select"
  | "resumeArt"
> {
  const signedIn = deps.signedIn ?? (() => true);
  let running: AbortController | undefined;

  const setPending = (pending: boolean) => {
    set({ artPending: pending });
    deps.onArtPending?.(pending);
  };

  const runArt = async (retried = false) => {
    const subject = deps.subject();
    if (subject === null || deps.locked()) return;
    const { epoch } = get();
    // The batch on show and its choice stay until a new batch is whole.
    setPending(false);
    const model = imagePromptModelOf(
      get().artModel,
      deps.imagePromptModel?.() ?? null,
      subject.model,
    );
    if (model === null) {
      set({ art: { status: "failed", code: "no_model" } });
      return;
    }
    if (subject.source === "") {
      set({ art: { status: "failed", code: "empty" } });
      return;
    }
    const controller = new AbortController();
    const release = deps.register(controller);
    running = controller;
    const current = () => get().epoch === epoch && !controller.signal.aborted;
    const started = performance.now();
    const progress = (phase: ArtPhase, value: number, max: number, position?: number) =>
      set({
        art: {
          status: "running",
          phase,
          value,
          max,
          ...(position === undefined ? {} : { position }),
          started,
          heard: performance.now(),
        },
      });
    progress("status", 0, 1);
    try {
      // An unknown status skips the art; a sign-in refusal waits for the renewal below.
      const workflow = deps.workflow?.() ?? DEFAULT_SETTINGS.comfyuiWorkflow;
      const chosen = get().artReasoning ?? subject.reasoning;
      const direction = get().artDirection.trim();
      const composition = get().artComposition;
      const look = get().artLook;
      const status = await deps.artStatus(workflow).catch((error: unknown) => {
        if (error instanceof SignedOut) throw error;
        return undefined;
      });
      if (!current()) return;
      if (status?.state !== "ready") {
        set({ art: { status: "skipped", reason: status?.state ?? "unknown" } });
        return;
      }
      // ComfyUI answered; the server writes the image prompt first.
      progress("prompt", 0, 1);
      const reasoning = (await deps.artEffort?.(model, chosen)) ?? chosen;
      if (!current()) return;
      const reference = await deps.reference?.(model);
      if (!current()) return;
      const events = await deps.streamArt(
        {
          kind: subject.kind,
          ...(subject.kind === "subject" ? { composition } : {}),
          ...(subject.kind !== "scenario" && look !== "auto" ? { look } : {}),
          model,
          ...effortOf({ reasoning }),
          source: subject.source,
          ...(direction === "" ? {} : { direction }),
          workflow,
          ...(reference === undefined ? {} : { reference }),
        },
        controller.signal,
      );
      // Held apart until the batch is whole: no partial batch is shown.
      const images: ArtImage[] = [];
      for await (const event of events) {
        if (!current()) return;
        if (event.type === "progress") {
          progress(event.phase, event.value, event.max, event.position);
        } else if (event.type === "image") {
          images[event.index] = event.png;
          progress("receiving", images.filter(Boolean).length, CREATOR_ART.count);
        } else if (event.type === "error") {
          set({ art: { status: "failed", code: event.code } });
          return;
        } else {
          const whole = images.filter(Boolean).length === CREATOR_ART.count;
          set(
            whole
              ? { art: { status: "complete" }, images, selected: 0 }
              : { art: { status: "failed", code: "stream" } },
          );
          return;
        }
      }
      if (current()) set({ art: { status: "failed", code: "stream" } });
    } catch (error) {
      if (!current()) return;
      if (error instanceof SignedOut) {
        // It waits for the renewal, or goes again now for a stale refusal.
        set({ art: { status: "waiting" } });
        setPending(true);
        if (error.stale && signedIn() && !retried) get().resumeArt();
      } else {
        set({ art: { status: "failed", code: "stream" } });
      }
    } finally {
      release();
      if (running === controller) running = undefined;
    }
  };

  return {
    setArtModel: (artModel) => set({ artModel }),
    setArtReasoning: (artReasoning) => set({ artReasoning }),
    setArtDirection: (artDirection) => set({ artDirection }),
    setArtComposition: (artComposition) => {
      if (!deps.locked()) set({ artComposition });
    },
    setArtLook: (artLook) => {
      if (!deps.locked()) set({ artLook });
    },

    requestArt: () => {
      const { art } = get();
      if (deps.locked() || art?.status === "running" || art?.status === "waiting") return;
      void runArt();
    },

    stopArt: () => {
      const status = get().art?.status;
      if (status !== "running" && status !== "waiting") return;
      running?.abort();
      setPending(false);
      set({ art: { status: "stopped" } });
    },

    select: (index) => {
      const { images } = get();
      if (!deps.locked() && index >= 0 && index < images.length) set({ selected: index });
    },

    resumeArt: () => {
      if (get().artPending && get().art?.status === "waiting") void runArt(true);
    },
  };
}
