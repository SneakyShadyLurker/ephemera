import {
  type BrainstormOption,
  type BrainstormRound,
  CREATOR_LIMITS,
  type CreatorBrainstormErrorCode,
  type CreatorBrainstormEvent,
  type CreatorBrainstormRequest,
  type CreatorKind,
  type ReasoningEffort,
} from "@ephemera/core";
import type { StoreApi } from "zustand/vanilla";
import { SignedOut } from "../signin/signin.ts";
import { effortOf } from "./art-slice.ts";
import type { CreatorState } from "./store.ts";

/*
 * The creator's brainstorm (PRINCIPLES.md 1): the player's request, the
 * feedback on its ideas and the ideas themselves are creation drafts, held in
 * this slice in tab memory only and sent whole with every round, since the
 * server keeps nothing between requests. The host's epoch drops the session;
 * each round also carries its own token, so a stopped or replaced round's
 * late events change nothing.
 */

export type StreamBrainstorm = (
  request: CreatorBrainstormRequest,
  signal: AbortSignal,
) => Promise<AsyncIterable<CreatorBrainstormEvent>>;

/**
 * Where the brainstorm stands: asking, reading the request for its kind,
 * writing the ideas, waiting for a sign-in, stopped by the player, failed, or
 * complete with the validated list.
 */
export type BrainstormStatus =
  | "idle"
  | "classifying"
  | "writing"
  | "waiting"
  | "stopped"
  | "failed"
  | "complete";

export interface BrainstormSession {
  /** The player's words, as typed. */
  request: string;
  /** The Ask field's text, sent or not: the request once sent, what Edit request brings back. */
  draft: string;
  /** The feedback field's text, until a round gives a list. */
  feedback: string;
  /** The kind shown above the list; null before classification or after `kind_unclear`. */
  kind: CreatorKind | null;
  /** The list on show: the last settled list, or the validated result. */
  options: BrainstormOption[];
  /** The round being written, as its lines arrive; empty when none runs. */
  incoming: BrainstormOption[];
  /** Earlier real lists with what followed each, oldest first, at most `brainstormRounds`. */
  rounds: BrainstormRound[];
  status: BrainstormStatus;
  /** The model has been reasoning; never what it thought. */
  thinking: boolean;
  /** The first answer lacked ideas, and the server is writing the list once more. */
  retried: boolean;
  failure: CreatorBrainstormErrorCode | "stream" | null;
  /** How many ideas the stopped round had written when Stop came; 0 when the list on show is the one before it. */
  arrived: number;
  /** The row picked into Describe, while this list lives. */
  picked: number | null;
  /** The player's Describe edits per idea of this list. */
  edits: Record<number, string>;
  /** The list's scroll offset at the pick, restored by Back to ideas. */
  scroll: number;
}

export interface BrainstormSliceState {
  brainstorm: BrainstormSession;
  /** The tile: the brainstorm stage, the session as it is. */
  openBrainstorm: () => void;
  /** A fresh session for `request`: classified first, no history. */
  askIdeas: (request: string, model: string, reasoning: ReasoningEffort) => void;
  /** The next round with the shown kind; empty feedback asks for ten new ideas. */
  adjustIdeas: (feedback: string, model: string, reasoning: ReasoningEffort) => void;
  /** The next round for `kind`; after `kind_unclear`, the first one. */
  switchIdeasKind: (kind: CreatorKind, model: string, reasoning: ReasoningEffort) => void;
  /** Ends a running or waiting round; the ideas that arrived become the list. */
  stopIdeas: () => void;
  /** Opens Describe for idea `index`, its brief (or the remembered edit) as the description. */
  pickIdea: (index: number, scroll: number) => void;
  /** Back from Describe to the list, remembering the edit of the picked idea. */
  backToIdeas: () => void;
  /** Ask with the text kept; the list stays until the next `askIdeas`. */
  editIdeasRequest: () => void;
  /** Start over: an empty session, the stage stays. */
  resetIdeas: () => void;
  setIdeasDraft: (draft: string) => void;
  setIdeasFeedback: (feedback: string) => void;
  /** Sends the round a sign-in interrupted once more, if it still waits. */
  resumeIdeas: () => void;
}

/** A session before anything is asked. */
export const BRAINSTORM_EMPTY: BrainstormSession = {
  request: "",
  draft: "",
  feedback: "",
  kind: null,
  options: [],
  incoming: [],
  rounds: [],
  status: "idle",
  thinking: false,
  retried: false,
  failure: null,
  arrived: 0,
  picked: null,
  edits: {},
  scroll: 0,
};

/**
 * What a new list empties: the pick, the edits and the scroll offset belong
 * to the list they were made on.
 */
const NEW_LIST: Pick<BrainstormSession, "picked" | "edits" | "scroll"> = {
  picked: null,
  edits: {},
  scroll: 0,
};

const running = (status: BrainstormStatus) =>
  status === "classifying" || status === "writing" || status === "waiting";

export interface BrainstormSliceDeps {
  streamBrainstorm: StreamBrainstorm;
  /** False while the Authelia session is gone. */
  signedIn: () => boolean;
  /** Every in-flight controller, so the host's drop aborts it; returns its release. */
  register: (controller: AbortController) => () => void;
  /** A round refused by the sign-in redirect: the host's pending request, or sent again now. */
  waitForSignIn: (error: SignedOut, retried: boolean) => void;
}

/** One round: what it sends, what it commits on success and what it restores on failure. */
interface Round {
  request: CreatorBrainstormRequest;
  /** `rounds` once this round gives a list. */
  history: BrainstormRound[];
  /** The kind of the list on show before the round, restored when the round gives none. */
  previousKind: CreatorKind | null;
  /** The feedback field's text when the round went out: heard once it gives a list. */
  feedback: string;
}

/** The brainstorm actions over the creator store. */
export function createBrainstormSlice(
  set: StoreApi<CreatorState>["setState"],
  get: StoreApi<CreatorState>["getState"],
  deps: BrainstormSliceDeps,
): Omit<BrainstormSliceState, "brainstorm"> {
  /** The round being written or waiting; a late event of any other is dropped. */
  let round: Round | undefined;
  let controller: AbortController | undefined;

  const patch = (next: Partial<BrainstormSession>) =>
    set((state) => ({ brainstorm: { ...state.brainstorm, ...next } }));

  const clearPending = () => {
    if (get().pending === "brainstorm") set({ pending: null });
  };

  /** The feedback field once `end` gives a list: emptied if it still holds what was heard, kept if retyped. */
  const heard = (end: Round) =>
    get().brainstorm.feedback === end.feedback ? "" : get().brainstorm.feedback;

  /** Ends the current round without a list: what was written of it goes, the shown list and its kind stay. */
  const settleEmpty = (end: Round, next: Partial<BrainstormSession>) =>
    patch({
      ...next,
      incoming: [],
      kind: get().brainstorm.options.length > 0 ? end.previousKind : get().brainstorm.kind,
    });

  /** Aborts the current round, if any; its late events are dropped. */
  const abort = () => {
    controller?.abort();
    controller = undefined;
    round = undefined;
  };

  const runRound = async (current: Round, retried = false) => {
    const { epoch } = get();
    const own = new AbortController();
    const release = deps.register(own);
    controller = own;
    const live = () =>
      get().epoch === epoch && round === current && controller === own && !own.signal.aborted;
    clearPending();
    patch({
      status: current.request.kind === undefined ? "classifying" : "writing",
      incoming: [],
      thinking: false,
      retried: false,
      failure: null,
    });
    let answered = false;
    try {
      const events = await deps.streamBrainstorm(current.request, own.signal);
      for await (const event of events) {
        answered = true;
        if (!live()) break;
        if (event.type === "kind") {
          patch({ kind: event.kind, status: "writing" });
        } else if (event.type === "thinking") {
          if (!get().brainstorm.thinking) patch({ thinking: true });
        } else if (event.type === "option") {
          set((state) => ({
            brainstorm: {
              ...state.brainstorm,
              status: "writing",
              incoming: [...state.brainstorm.incoming, event.option],
            },
          }));
        } else if (event.type === "retry") {
          // The first list is dropped; the second one's lines follow.
          patch({ incoming: [], thinking: false, retried: true });
        } else if (event.type === "error") {
          round = undefined;
          settleEmpty(current, { status: "failed", failure: event.code });
          return;
        } else {
          round = undefined;
          patch({
            ...NEW_LIST,
            feedback: heard(current),
            status: "complete",
            options: event.options,
            incoming: [],
            rounds: current.history,
          });
          return;
        }
      }
      // The stream ended before its result: cut off, unless Stop or a drop ended it.
      if (live()) {
        round = undefined;
        settleEmpty(current, { status: "failed", failure: "stream" });
      }
    } catch (error) {
      if (!live()) return;
      if (error instanceof SignedOut && !answered) {
        patch({ status: "waiting" });
        deps.waitForSignIn(error, retried);
      } else {
        round = undefined;
        settleEmpty(current, { status: "failed", failure: "stream" });
      }
    } finally {
      release();
      if (controller === own) controller = undefined;
    }
  };

  /** Starts a round for `kind` (classified first when null) after the list on show. */
  const next = (
    kind: CreatorKind | null,
    feedback: string,
    model: string,
    reasoning: ReasoningEffort,
  ) => {
    // A round still running gives way, as if it had given no list.
    const left = round;
    abort();
    if (left !== undefined && running(get().brainstorm.status)) settleEmpty(left, {});
    const shown = get().brainstorm;
    const said = feedback.trim();
    // The list on show joins the history; an attempt that ended with no idea is no round.
    const history =
      shown.options.length > 0 && shown.kind !== null
        ? [
            ...shown.rounds,
            {
              kind: shown.kind,
              options: shown.options,
              ...(said === "" ? {} : { feedback: said }),
            },
          ].slice(-CREATOR_LIMITS.brainstormRounds)
        : shown.rounds;
    const current: Round = {
      request: {
        description: shown.request,
        ...(kind === null ? {} : { kind }),
        // Without a kind there is no list yet, so no history either.
        rounds: kind === null ? [] : history,
        model,
        ...effortOf({ reasoning }),
      },
      history: kind === null ? [] : history,
      previousKind: shown.kind,
      feedback: shown.feedback,
    };
    round = current;
    patch({ kind });
    void runRound(current);
  };

  return {
    openBrainstorm: () => set({ stage: "brainstorm" }),

    askIdeas: (request, model, reasoning) => {
      if (request.trim() === "") return;
      abort();
      clearPending();
      set({ brainstorm: { ...BRAINSTORM_EMPTY, request, draft: request } });
      next(null, "", model, reasoning);
    },

    adjustIdeas: (feedback, model, reasoning) => {
      const { brainstorm } = get();
      if (brainstorm.request.trim() === "") return;
      next(brainstorm.kind, brainstorm.options.length > 0 ? feedback : "", model, reasoning);
    },

    switchIdeasKind: (kind, model, reasoning) => {
      if (get().brainstorm.request.trim() === "") return;
      next(kind, "", model, reasoning);
    },

    stopIdeas: () => {
      const { brainstorm } = get();
      const left = round;
      if (left === undefined || !running(brainstorm.status)) return;
      abort();
      clearPending();
      if (brainstorm.incoming.length > 0) {
        // What arrived is the list now; the one before it joins the history.
        patch({
          ...NEW_LIST,
          feedback: heard(left),
          status: "stopped",
          arrived: brainstorm.incoming.length,
          options: brainstorm.incoming,
          incoming: [],
          rounds: left.history,
        });
      } else {
        settleEmpty(left, { status: "stopped", arrived: 0 });
      }
    },

    pickIdea: (index, scroll) => {
      const { brainstorm } = get();
      const option = brainstorm.options[index];
      if (option === undefined || brainstorm.kind === null || running(brainstorm.status)) return;
      get().choose(brainstorm.kind);
      set({
        description: brainstorm.edits[index] ?? option.brief,
        brainstorm: { ...brainstorm, picked: index, scroll },
      });
    },

    backToIdeas: () => {
      const { brainstorm, description } = get();
      const { picked } = brainstorm;
      const option = picked === null ? undefined : brainstorm.options[picked];
      if (picked === null || option === undefined) return;
      const { [picked]: _, ...others } = brainstorm.edits;
      set({
        stage: "brainstorm",
        brainstorm: {
          ...brainstorm,
          edits: description === option.brief ? others : { ...others, [picked]: description },
        },
      });
    },

    editIdeasRequest: () => {
      get().stopIdeas();
      patch({ status: "idle" });
    },

    resetIdeas: () => {
      abort();
      clearPending();
      set({ brainstorm: BRAINSTORM_EMPTY });
    },

    setIdeasDraft: (draft) => patch({ draft }),

    setIdeasFeedback: (feedback) => patch({ feedback }),

    resumeIdeas: () => {
      const current = round;
      if (current !== undefined && get().brainstorm.status === "waiting")
        void runRound(current, true);
    },
  };
}
