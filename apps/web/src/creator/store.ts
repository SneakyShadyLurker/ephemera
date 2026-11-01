import {
  artSource,
  type BlockTokens,
  type CardProblem,
  type CreatorCardErrorCode,
  type CreatorCardEvent,
  type CreatorCardRequest,
  type CreatorKind,
  parseCardAnswer,
  type ReasoningEffort,
  type SheetFields,
  toSheetFields,
  validateCardAnswer,
} from "@ephemera/core";
import { createStore } from "zustand/vanilla";
import { PORTRAIT_UPLOAD_TIMEOUT_MS } from "../portraits/limits.ts";
import type { CreateResult } from "../sheet/saving.ts";
import { SignedOut } from "../signin/signin.ts";
import {
  ART_DROPPED,
  ART_EMPTY,
  type ArtImage,
  type ArtSliceDeps,
  type ArtSliceState,
  createArtSlice,
  effortOf,
} from "./art-slice.ts";
import {
  BRAINSTORM_EMPTY,
  type BrainstormSliceState,
  createBrainstormSlice,
  type StreamBrainstorm,
} from "./brainstorm-slice.ts";

/*
 * The creator's session (PRINCIPLES.md 1): the owner's description, the
 * brainstorm's request and ideas, the card the model writes and the four
 * candidate portraits are creation drafts, held in this store in tab memory
 * only. A session epoch, as in chat: every
 * operation that drops a card advances it and aborts what is in flight, and a
 * late result tagged with an older epoch is dropped.
 */

export type StreamCard = (
  request: CreatorCardRequest,
  signal: AbortSignal,
) => Promise<AsyncIterable<CreatorCardEvent>>;

/** The screens of the flow before the showcase: choose a kind (or brainstorm one), describe, then the card. */
type Stage = "choose" | "brainstorm" | "describe" | "card";

/**
 * Where a card stands: being written, waiting for a sign-in, stopped by the
 * owner, failed, finished without the expected structure, or complete.
 */
export type CardStatus = "writing" | "waiting" | "stopped" | "failed" | "invalid" | "complete";

export interface CardRun {
  kind: CreatorKind;
  model: string;
  /** The effort chosen with the model; "provider-default" sends none. */
  reasoning: ReasoningEffort;
  /** The persona {{user}} is in this card, as chosen when Create was pressed; null for none. */
  personaId: string | null;
  status: CardStatus;
  /** The model's tagged answer so far; `parseCardAnswer` reads it. */
  answer: string;
  /** The model has been reasoning; shown until its answer's first text. Never what it thought. */
  thinking: boolean;
  /** The first answer lacked parts, and the server is writing the card once more. */
  retried: boolean;
  /**
   * Why a failed card stopped: the model, its deadline, its output ceiling,
   * the provider's filter, a description too large for the model, or a
   * stream that broke off.
   */
  failure: CreatorCardErrorCode | "stream" | null;
  /** What a structurally invalid card lacks. */
  problems: CardProblem[];
  /** Estimated tokens per counted block of a complete card. */
  tokens: BlockTokens[];
}

/**
 * What Keep saves: the card as sheet fields and one client-chosen id, taken
 * once, so a retry never duplicates the card; and the portrait chosen when
 * Keep (or its retry) is pressed, or none.
 */
interface KeepSnapshot {
  id: string;
  name: string;
  fields: SheetFields;
  image: ArtImage | null;
}

/** A portrait upload's answer as Keep reads it. */
type PortraitAnswer = { ok: true; version: number } | { ok: false; reason: string };

/** Why a Keep stopped: the card was not saved, or it was and its portrait was not. */
export type KeepFailure =
  | { step: "card"; reason: Extract<CreateResult, { ok: false }>["reason"] }
  | { step: "portrait"; reason: string };

export interface KeepRun {
  snapshot: KeepSnapshot;
  status: "saving" | "failed" | "kept";
  /** The card is saved; only its portrait can be left. */
  saved: boolean;
  /** The saved portrait's version. */
  portrait: number | null;
  failure: KeepFailure | null;
}

/** The creator's session; art drops with the card, composition stays until the session clears. */
export interface CreatorState extends ArtSliceState, BrainstormSliceState {
  stage: Stage;
  /** Subject, Group or Scenario; null until chosen. */
  kind: CreatorKind | null;
  /** The owner's description: survives in-app navigation, never a reload. */
  description: string;
  /** The model chosen on this screen; null follows the saved model. */
  model: string | null;
  /** The reasoning effort chosen on this screen; one the model lacks falls back to its default. */
  reasoning: ReasoningEffort;
  card: CardRun | null;
  /** Keep, once asked: the snapshot and how far it got. */
  keepRun: KeepRun | null;
  /** The request a sign-in interrupted before it was answered; one renewal sends it once more. */
  pending: "card" | "art" | "brainstorm" | null;
  choose: (kind: CreatorKind) => void;
  /** Back to the choice of kind, the description and the brainstorm kept; a running round stops. */
  change: () => void;
  setDescription: (description: string) => void;
  setModel: (model: string) => void;
  setReasoning: (reasoning: ReasoningEffort) => void;
  /**
   * Writes a card from the description with `model` at `reasoning`, for the
   * persona `personaId` (null: none).
   */
  create: (model: string, reasoning: ReasoningEffort, personaId: string | null) => void;
  /** Ends the writing; what was written stays, marked incomplete. */
  stop: () => void;
  /** Drops the card and its art and writes another from the same description. */
  rewrite: () => void;
  /**
   * Drops the card and its art and returns to the description, which is
   * kept, with the brainstorm it may have come from; to the choice of kind
   * when none was chosen.
   */
  returnToDescription: () => void;
  /** Leaving the route: as `returnToDescription`, and the brainstorm goes too. */
  leave: () => void;
  /** Drops the card and its art, back at the description, which is kept. */
  discard: () => void;
  /**
   * Saves the complete card and the chosen portrait, from one snapshot taken
   * on the first call; a call after a failure retries what is left (the
   * portrait alone once the card is saved), with the portrait chosen now.
   * True once both are saved.
   */
  keep: () => Promise<boolean>;
  /** Empties everything: reload, tab close, `pagehide`, Keep. */
  clear: () => void;
  /** Sends the request a sign-in interrupted once more, if it is still this session's. */
  resume: () => void;
}

export interface CreatorDeps
  extends Omit<ArtSliceDeps, "subject" | "reference" | "locked" | "register" | "onArtPending"> {
  streamCard: StreamCard;
  streamBrainstorm: StreamBrainstorm;
  /** Creates the character under the given id (the existing create call). */
  saveCard: (id: string, fields: SheetFields) => Promise<CreateResult>;
  /** Uploads the chosen PNG as the character's portrait (the existing upload), ended by `signal`. */
  savePortrait: (id: string, png: ArtImage, signal: AbortSignal) => Promise<PortraitAnswer>;
  /** How long Keep waits for the portrait upload; a minute without this. */
  portraitTimeoutMs?: number;
}

/** Whether leaving would lose a card that has not been kept. */
export const hasUnsavedCard = (state: Pick<CreatorState, "card" | "keepRun">): boolean =>
  state.card !== null &&
  state.keepRun?.saved !== true &&
  (state.card.status === "writing" || state.card.answer !== "");

/** While Keep saves, nothing else changes the card or its art, and leaving waits for it. */
export const keeping = (state: Pick<CreatorState, "keepRun">): boolean =>
  state.keepRun?.status === "saving";

type Session = Pick<
  CreatorState,
  | "stage"
  | "kind"
  | "description"
  | "model"
  | "reasoning"
  | "artModel"
  | "artReasoning"
  | "artDirection"
  | "artComposition"
  | "artLook"
  | "card"
  | "art"
  | "images"
  | "selected"
  | "artPending"
  | "pending"
  | "keepRun"
  | "brainstorm"
>;

const EMPTY: Session = {
  stage: "choose",
  kind: null,
  description: "",
  model: null,
  reasoning: "provider-default",
  ...ART_EMPTY,
  card: null,
  pending: null,
  keepRun: null,
  brainstorm: BRAINSTORM_EMPTY,
};

/** What dropping a card empties: the card's art, its direction and any Keep of it. */
const DROPPED: Pick<
  Session,
  | "art"
  | "artDirection"
  | "artComposition"
  | "artLook"
  | "images"
  | "selected"
  | "artPending"
  | "pending"
  | "keepRun"
> = {
  ...ART_DROPPED,
  pending: null,
  keepRun: null,
};

const writingRun = (): Pick<
  CardRun,
  "status" | "answer" | "thinking" | "retried" | "failure" | "problems" | "tokens"
> => ({
  status: "writing",
  answer: "",
  thinking: false,
  retried: false,
  failure: null,
  problems: [],
  tokens: [],
});

export function createCreatorStore(deps: CreatorDeps) {
  const signedIn = deps.signedIn ?? (() => true);

  return createStore<CreatorState>()((set, get) => {
    const inFlight = new Set<AbortController>();
    let card: AbortController | undefined;
    /** Bumped by every Keep and every drop, so a save answered late changes nothing. */
    let keeps = 0;

    /** Aborts every request and advances the epoch, so nothing late lands. */
    const drop = () => {
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
      card = undefined;
      keeps++;
      return get().epoch + 1;
    };

    const patchKeep = (patch: Partial<KeepRun>) =>
      set((state) => (state.keepRun === null ? {} : { keepRun: { ...state.keepRun, ...patch } }));

    const patchCard = (patch: Partial<CardRun>) =>
      set((state) => (state.card === null ? {} : { card: { ...state.card, ...patch } }));

    /** A request refused by the sign-in redirect: it waits for the renewal, or goes again now for a stale refusal. */
    const waitForSignIn = (error: SignedOut, retried: boolean, pending: "card" | "brainstorm") => {
      set({ pending });
      if (error.stale && signedIn() && !retried) get().resume();
    };

    const runCard = async (retried = false) => {
      const { epoch, card: run, description } = get();
      if (run === null) return;
      const controller = new AbortController();
      inFlight.add(controller);
      card = controller;
      const current = () => get().epoch === epoch && card === controller;
      const writing = () => current() && get().card?.status === "writing";
      set({ pending: null });
      patchCard(writingRun());
      let answered = false;
      try {
        const events = await deps.streamCard(
          {
            kind: run.kind,
            description,
            model: run.model,
            ...effortOf(run),
            ...(run.personaId === null ? {} : { personaId: run.personaId }),
          },
          controller.signal,
        );
        for await (const event of events) {
          answered = true;
          if (!writing()) break;
          if (event.type === "delta") {
            set((state) =>
              state.card === null
                ? {}
                : { card: { ...state.card, answer: state.card.answer + event.text } },
            );
          } else if (event.type === "thinking") {
            if (get().card?.thinking === false) patchCard({ thinking: true });
          } else if (event.type === "retry") {
            // The first draft is dropped; the second one's text follows.
            patchCard({ answer: "", thinking: false, retried: true });
          } else if (event.type === "error") {
            patchCard({ status: "failed", failure: event.code });
          } else if (event.validation.ok) {
            patchCard({ status: "complete", tokens: event.tokens });
            get().requestArt();
          } else {
            patchCard({ status: "invalid", problems: event.validation.problems });
          }
        }
        // The stream ended before its result: cut off, unless Stop or a drop ended it.
        if (writing())
          patchCard({
            status: controller.signal.aborted ? "stopped" : "failed",
            failure: "stream",
          });
      } catch (error) {
        if (!writing()) return;
        if (error instanceof SignedOut && !answered && !controller.signal.aborted) {
          patchCard({ status: "waiting" });
          waitForSignIn(error, retried, "card");
        } else {
          patchCard(
            controller.signal.aborted
              ? { status: "stopped" }
              : { status: "failed", failure: "stream" },
          );
        }
      } finally {
        inFlight.delete(controller);
        if (card === controller) card = undefined;
      }
    };

    /**
     * Keep's portrait upload, answered within the timeout whether or not the
     * upload heeds its signal; a drop aborts it too. It never throws, so the
     * card stays kept and the candidate stays for the retry.
     */
    const uploadPortrait = async (id: string, image: ArtImage): Promise<PortraitAnswer> => {
      const controller = new AbortController();
      inFlight.add(controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(deps.portraitTimeoutMs ?? PORTRAIT_UPLOAD_TIMEOUT_MS),
      ]);
      const tooLong: PortraitAnswer = { ok: false, reason: "The upload took too long." };
      const thrown: PortraitAnswer = { ok: false, reason: "The portrait was not saved." };
      let onAbort = () => {};
      const ended = new Promise<PortraitAnswer>((resolve) => {
        onAbort = () => resolve(tooLong);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const answer = await Promise.race([
          deps.savePortrait(id, image, signal).catch(() => thrown),
          ended,
        ]);
        return !answer.ok && signal.aborted ? tooLong : answer;
      } finally {
        signal.removeEventListener("abort", onAbort);
        inFlight.delete(controller);
      }
    };

    return {
      epoch: 0,
      ...EMPTY,

      // A kind tile opens Describe as a tile: no idea is picked (`pickIdea` sets its own after).
      choose: (kind) =>
        set((state) => ({
          kind,
          stage: "describe",
          artComposition: kind === "subject" ? get().artComposition : "regular",
          artLook: kind === "scenario" ? "auto" : get().artLook,
          brainstorm: { ...state.brainstorm, picked: null },
        })),
      // A running brainstorm round stops; its session stays for the tile to reopen.
      change: () => {
        get().stopIdeas();
        set({ stage: "choose" });
      },
      setDescription: (description) => set({ description }),
      setModel: (model) => set({ model }),
      setReasoning: (reasoning) => set({ reasoning }),
      ...createArtSlice(set, get, {
        ...deps,
        subject: () => {
          const run = get().card;
          if (run?.status !== "complete") return null;
          const card = parseCardAnswer(run.answer);
          return {
            kind: run.kind,
            source: artSource(
              run.kind,
              card.description.text,
              card.firstMessage.text,
              card.name.text,
            ),
            model: run.model,
            reasoning: run.reasoning,
          };
        },
        locked: () => keeping(get()),
        register: (controller) => {
          inFlight.add(controller);
          return () => inFlight.delete(controller);
        },
        // A run waiting for the sign-in is the creator's pending request; one starting clears it.
        onArtPending: (pending) => set({ pending: pending ? "art" : null }),
      }),
      ...createBrainstormSlice(set, get, {
        streamBrainstorm: deps.streamBrainstorm,
        signedIn,
        register: (controller) => {
          inFlight.add(controller);
          return () => inFlight.delete(controller);
        },
        waitForSignIn: (error, retried) => waitForSignIn(error, retried, "brainstorm"),
      }),

      create: (model, reasoning, personaId) => {
        const { kind, description, card: run, artComposition, artLook } = get();
        if (kind === null || description.trim() === "" || run !== null) return;
        set({
          stage: "card",
          card: { kind, model, reasoning, personaId, ...writingRun() },
          ...DROPPED,
          artComposition: kind === "subject" ? artComposition : "regular",
          artLook: kind === "scenario" ? "auto" : artLook,
        });
        void runCard();
      },

      stop: () => {
        if (get().card?.status !== "writing") return;
        card?.abort();
        patchCard({ status: "stopped" });
      },

      rewrite: () => {
        const run = get().card;
        if (run === null || keeping(get())) return;
        set({
          epoch: drop(),
          card: { ...run, ...writingRun() },
          ...DROPPED,
          artComposition: get().artComposition,
          artLook: get().artLook,
        });
        void runCard();
      },

      returnToDescription: () => {
        // A round would lose its controller to the drop below; it ends as a Stop instead.
        get().stopIdeas();
        set((state) => ({
          epoch: drop(),
          stage: state.kind === null ? "choose" : "describe",
          card: null,
          ...DROPPED,
          artComposition: state.artComposition,
          artLook: state.artLook,
        }));
      },

      leave: () => {
        get().resetIdeas();
        get().returnToDescription();
      },

      discard: () => {
        if (!keeping(get())) get().returnToDescription();
      },

      keep: async () => {
        const { card: run, keepRun: keep, images, selected } = get();
        if (keep?.status === "saving") return false;
        if (keep?.status === "kept") return true;
        const image = images[selected] ?? null;
        let snapshot = keep === null ? undefined : { ...keep.snapshot, image };
        if (snapshot === undefined) {
          if (run?.status !== "complete") return false;
          const result = validateCardAnswer(run.kind, run.answer);
          if (!result.ok) return false;
          snapshot = {
            id: crypto.randomUUID(),
            name: result.card.name,
            fields: toSheetFields(run.kind, result.card),
            image,
          };
        }
        const attempt = ++keeps;
        const current = () => keeps === attempt;
        set({
          keepRun: {
            snapshot,
            status: "saving",
            saved: keep?.saved ?? false,
            portrait: null,
            failure: null,
          },
        });
        if (keep?.saved !== true) {
          const created = await deps
            .saveCard(snapshot.id, snapshot.fields)
            .catch((): CreateResult => ({ ok: false, reason: "unreachable" }));
          if (!current()) return false;
          if (!created.ok) {
            patchKeep({ status: "failed", failure: { step: "card", reason: created.reason } });
            return false;
          }
          patchKeep({ saved: true });
        }
        if (snapshot.image !== null) {
          const portrait = await uploadPortrait(snapshot.id, snapshot.image);
          if (!current()) return false;
          if (!portrait.ok) {
            patchKeep({
              status: "failed",
              failure: { step: "portrait", reason: portrait.reason },
            });
            return false;
          }
          patchKeep({ portrait: portrait.version });
        }
        patchKeep({ status: "kept" });
        return true;
      },

      clear: () => {
        // The brainstorm's round lives in its slice's closure; it goes with the session.
        get().resetIdeas();
        set({ ...EMPTY, epoch: drop() });
      },

      resume: () => {
        const { pending } = get();
        if (pending === "card" && get().card?.status === "waiting") void runCard(true);
        else if (pending === "art") get().resumeArt();
        else if (pending === "brainstorm") get().resumeIdeas();
      },
    };
  });
}

export type CreatorStore = ReturnType<typeof createCreatorStore>;
