import {
  type AppliedChanges,
  applyChanges,
  fieldKey,
  fieldLabel,
  isClearing,
  isConversion,
  type PlacedChange,
  parseReworkAnswer,
  placeChanges,
  type RawChange,
  type ReasoningEffort,
  type ReworkCard,
  type ReworkErrorCode,
  type ReworkEvent,
  type ReworkField,
  type ReworkPlacement,
  type ReworkProblem,
  type ReworkRequest,
  readChanges,
  reworkCardSchema,
} from "@ephemera/core";
import { createStore } from "zustand/vanilla";
import { effortOf } from "../creator/art-slice.ts";
import { SignedOut } from "../signin/signin.ts";
import { clearWordDiffs } from "./tracked.ts";

/*
 * AI Rework's session (PRINCIPLES.md 1): the owner's request, the model's
 * answer, the changes read from it, the review's decisions and the Undo
 * snapshot are creation drafts, held in this store in tab memory only and
 * bound to one character's sheet. A session epoch, as in the creator: every
 * operation that drops a run advances it and aborts what is in flight, and a
 * late event of an older run is dropped.
 */

export type StreamRework = (
  request: ReworkRequest,
  signal: AbortSignal,
) => Promise<AsyncIterable<ReworkEvent>>;

/**
 * Why the server refused a request before the model saw it: the body passed
 * its size cap (413), or failed its schema (400). Content-free.
 */
/** Named as the server answers them; the stream route's RPC type carries no error bodies. */
export type Refused = "payload_too_large" | "invalid_request";

/** Thrown by `StreamRework` when the server refuses the request outright. */
export class ReworkRefused extends Error {
  override name = "ReworkRefused";
  readonly reason: Refused;
  constructor(reason: Refused) {
    super(`Rework refused (${reason})`);
    this.reason = reason;
  }
}

/**
 * Where a rework stands: nothing asked, the model writing, waiting for a
 * sign-in, the changes under review, or applied with Undo on offer.
 */
type Phase = "idle" | "working" | "waiting" | "review" | "applied";

/** One change as the review shows it: placed or not, the owner's decision, and the pair it goes with. */
export type ReviewChange = ReworkPlacement & {
  /** A change that could not be placed is always rejected: it is never applied. */
  decision: "accepted" | "rejected";
  /**
   * The change's field key; the parts of one new entry share `entry_new_K`,
   * so they are accepted or rejected as one. Each new greeting is a group
   * of its own (`alternate_greeting_new_<at>`).
   */
  group: string;
};

export interface Applied {
  /** The fields Apply wrote, with the exact values it wrote. */
  written: Partial<ReworkCard>;
  /** Those fields as they were before. */
  previous: Partial<ReworkCard>;
  /** The changes Apply wrote. */
  count: number;
  /** Per field written, how many of the changes went into it. */
  counts: Partial<Record<keyof ReworkCard, number>>;
  /** A conversion's fields, the description and those it cleared, which Undo restores together; empty without one. */
  converted: (keyof ReworkCard)[];
  /**
   * Once Undo ran: the changes it restored, and the labels of the fields it
   * left, those typed in since Apply (`skipped`) and the conversion's others (`kept`).
   */
  undone: { restored: number; skipped: string[]; kept: string[] } | null;
}

/** Why Apply refused the accepted changes: the field they would take past its schema. */
interface ApplyProblem {
  /** The field's name as the sheet shows it. */
  field: string;
  /** Left empty where it must have text, or past a length or count limit. */
  kind: "empty" | "too_long";
}

interface StartOptions {
  /** The sheet's character: binds the session when nothing does (after `pagehide`). */
  characterId: string;
  model: string;
  /** The resolved effort at submission; provider-default sends none. */
  reasoning: ReasoningEffort;
  /** The persona {{user}} is; null for none. */
  personaId: string | null;
  /** Whether the stored portrait goes to the model. */
  portrait: boolean;
  /** The sheet's fields as they stand: the card the changes are placed against. */
  card: ReworkCard;
}

export interface ReworkState {
  /** The character whose sheet this session belongs to. */
  characterId: string | null;
  /** Advances whenever a run is dropped; events of an older run are dropped. */
  epoch: number;
  phase: Phase;
  /** The owner's request: survives closing the composer and Discard, cleared by Apply and leaving the sheet. */
  request: string;
  /** The model chosen in the composer; null follows the saved model. */
  model: string | null;
  /** The composer's effort choice; unsupported levels follow the model's default. */
  reasoning: ReasoningEffort;
  /** Whether to show the portrait; null follows the model's default. */
  portrait: boolean | null;
  /** The card as sent, snapshotted at start; changes are placed and applied against it. */
  base: ReworkCard | null;
  /** The model's answer so far. */
  answer: string;
  /** Where the next read of `answer` starts: after the last closed block. */
  parsedUpTo: number;
  /** Every change read, in arrival order. */
  changes: ReviewChange[];
  /** Closed blocks that could not be read at all. */
  malformed: number;
  /** The model's summary, once the answer is complete. */
  summary: string | null;
  /**
   * How the run ended: complete, stopped by the owner, or failed (an answer
   * cut off before it finished included); null while it runs.
   */
  ended: null | "complete" | "stopped" | "failed";
  /**
   * Why a run failed: the server's code, a stream that broke off or was cut
   * off, or a request the server refused before the model saw it.
   */
  failure: ReworkErrorCode | Refused | "stream" | null;
  /** What is wrong with a complete answer as a whole. */
  problems: ReworkProblem[];
  /** Set when Apply refused the accepted changes; cleared by the next decision. */
  applyProblem: ApplyProblem | null;
  /** After Apply, until Done, another rework or leaving the sheet. */
  applied: Applied | null;
  /** Binds the session to a character's sheet; another character's empties it first. */
  open: (characterId: string) => void;
  setRequest: (request: string) => void;
  setModel: (model: string) => void;
  setReasoning: (reasoning: ReasoningEffort) => void;
  setPortrait: (portrait: boolean) => void;
  /**
   * Sends the request about `card`; from idle, or from applied, which ends
   * that Apply's Undo. Whether a run began: nothing begins without a request,
   * while another run is under way or for another character's session.
   */
  start: (options: StartOptions) => boolean;
  /** Ends the run; the changes that arrived stay under review. */
  stop: () => void;
  accept: (at: number) => void;
  reject: (at: number) => void;
  /** Accepts or rejects every placed change of a group (a new entry's parts). */
  setGroup: (group: string, decision: ReviewChange["decision"]) => void;
  /** Drops the run and its changes; the request is kept. */
  discard: () => void;
  /**
   * The accepted changes applied to the card as sent, which the sheet then
   * writes through its `edit()`. The session moves to `applied` first, so
   * the fields are no longer locked when the sheet writes; the request and
   * the review are dropped, the Undo snapshot is kept. Null when nothing is
   * accepted or nothing is under review, and when the result would break a
   * field's schema: the review stays and `applyProblem` names the field.
   */
  apply: () => AppliedChanges | null;
  /**
   * The values to write back: the previous value of each applied field the
   * owner has not typed in since (`current` is the sheet as it stands). The
   * fields left are recorded in `applied.undone.skipped`. Once only.
   */
  undo: (current: ReworkCard) => Partial<ReworkCard>;
  /** Done: back to idle. */
  finish: () => void;
  /** Empties everything, the request and the character included: leaving the sheet, `pagehide`. */
  clear: () => void;
  /** Sends a run a sign-in interrupted once more, if it is still this session's. */
  resume: () => void;
}

interface ReworkDeps {
  streamRework: StreamRework;
  /** False while the Authelia session is gone. */
  signedIn?: () => boolean;
  /** Told whether the model is writing, for the navigation lamp's pace. */
  writing?: (writing: boolean) => void;
}

/** While the model works or its changes are under review, the sheet takes no edits. */
export const isLocked = (state: Pick<ReworkState, "phase">): boolean =>
  state.phase === "working" || state.phase === "waiting" || state.phase === "review";

const arrival = (change: ReviewChange): number => (change.ok ? change.change.at : change.at);

/**
 * Whether deciding `target` decides `change` too: a conversion carries the
 * fields it clears, and accepting a clearing accepts its conversion, so a
 * field is never emptied without the description that now holds its text.
 */
const decidedWith = (
  target: PlacedChange,
  change: PlacedChange,
  decision: ReviewChange["decision"],
): boolean =>
  (isConversion(target) && isClearing(change)) ||
  (decision === "accepted" && isClearing(target) && isConversion(change));

/** The placed changes the owner accepted, in arrival order: what Apply writes. */
export const acceptedChanges = (state: Pick<ReworkState, "changes">): PlacedChange[] =>
  state.changes.flatMap((change) =>
    change.ok && change.decision === "accepted" ? [change.change] : [],
  );

/** The card field a change writes. */
export function cardKey(field: ReworkField): keyof ReworkCard {
  switch (field.kind) {
    case "text":
      return field.key;
    case "tags":
      return "tags";
    case "alternate":
    case "alternate_new":
      return "alternateGreetings";
    case "entry":
    case "entry_new":
      return "lorebook";
  }
}

/** A card field's name as the sheet shows it. */
function keyLabel(key: keyof ReworkCard, card: ReworkCard): string {
  switch (key) {
    case "tags":
      return "Tags";
    case "alternateGreetings":
      return "Alternates";
    case "lorebook":
      return "Lorebook";
    default:
      return fieldLabel({ kind: "text", key }, card);
  }
}

/**
 * The fields Apply wrote that Undo leaves: those the owner has typed in
 * since (`edited`), whose value is no longer the one Apply wrote, and with
 * any of a conversion's fields among them, its others (`kept`), so a cleared
 * field's text never goes back without the description that holds it.
 * Strings compare by value, lists, notes and the book by identity, as every
 * edit makes a new value.
 */
function heldBack(applied: Applied, current: ReworkCard) {
  const keys = Object.keys(applied.written) as (keyof ReworkCard)[];
  const edited = keys.filter((key) => current[key] !== applied.written[key]);
  const kept = edited.some((key) => applied.converted.includes(key))
    ? applied.converted.filter((key) => key in applied.written && !edited.includes(key))
    : [];
  return { edited, kept };
}

/** The labels of the fields Undo leaves, as the dock's button counts them. */
export function leftByUndo(state: Pick<ReworkState, "applied">, current: ReworkCard): string[] {
  if (state.applied === null) return [];
  const { edited, kept } = heldBack(state.applied, current);
  return [...edited, ...kept].map((key) => keyLabel(key, current));
}

/**
 * The first field of `card` its schema refuses, as the sheet names it, and
 * how: null when the card is valid. Content-free: it names fields only.
 */
export function invalidField(card: ReworkCard): ApplyProblem | null {
  const parsed = reworkCardSchema.safeParse(card);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const key = issue?.path[0];
  const field =
    typeof key === "string" && key in card ? keyLabel(key as keyof ReworkCard, card) : "A field";
  return { field, kind: issue?.code === "too_small" ? "empty" : "too_long" };
}

/** The group a change is decided with; `key` is the field key as written. */
function groupOf(placement: ReworkPlacement, key: string): string {
  const field = placement.ok ? placement.change.field : placement.field;
  if (field === null) return key;
  if (field.kind === "entry_new") return `entry_new_${field.number}`;
  if (field.kind === "alternate_new") {
    return `alternate_greeting_new_${placement.ok ? placement.change.at : placement.at}`;
  }
  return fieldKey(field);
}

type Run = Pick<
  ReworkState,
  | "phase"
  | "base"
  | "answer"
  | "parsedUpTo"
  | "changes"
  | "malformed"
  | "summary"
  | "ended"
  | "failure"
  | "problems"
  | "applyProblem"
  | "applied"
>;

/** No run: what discarding, finishing and every new start begin from. */
const NO_RUN: Run = {
  phase: "idle",
  base: null,
  answer: "",
  parsedUpTo: 0,
  changes: [],
  malformed: 0,
  summary: null,
  ended: null,
  failure: null,
  problems: [],
  applyProblem: null,
  applied: null,
};

const EMPTY: Run &
  Pick<ReworkState, "characterId" | "request" | "model" | "reasoning" | "portrait"> = {
  ...NO_RUN,
  characterId: null,
  request: "",
  model: null,
  reasoning: "provider-default",
  portrait: null,
};

export function createReworkStore(deps: ReworkDeps) {
  const signedIn = deps.signedIn ?? (() => true);

  const store = createStore<ReworkState>()((set, get) => {
    let controller: AbortController | undefined;
    /** The request of the current run, kept to send again after a sign-in. */
    let sent: ReworkRequest | undefined;
    /** The current run's change blocks as read, for placing each new one against the earlier ones. */
    let raw: RawChange[] = [];

    /** Aborts the run and forgets its drafts; returns the next epoch, so nothing late lands. */
    const drop = () => {
      controller?.abort();
      controller = undefined;
      sent = undefined;
      raw = [];
      clearWordDiffs();
      return get().epoch + 1;
    };

    /** Reads the blocks that closed since the last read and places them against the card as sent. */
    const readNew = (base: ReworkCard) => {
      const { answer, parsedUpTo } = get();
      const read = readChanges(answer, parsedUpTo, raw.length);
      if (read.next === parsedUpTo) return;
      raw = [...raw, ...read.changes];
      // Placing is deterministic, so the earlier changes place as before; only the new ones are kept.
      const placements = placeChanges(base, raw).slice(raw.length - read.changes.length);
      set((state) => {
        const fresh = placements.map((placement, index): ReviewChange => {
          const group = groupOf(placement, read.changes[index]?.field ?? "");
          if (!placement.ok) return { ...placement, decision: "rejected", group };
          // A new entry is decided as one: a part arriving later takes the decision its group has.
          // A clearing takes its conversion's, which always arrives first.
          const decided =
            placement.change.field.kind === "entry_new"
              ? state.changes.find((change) => change.ok && change.group === group)?.decision
              : isClearing(placement.change)
                ? state.changes.find((change) => change.ok && isConversion(change.change))?.decision
                : undefined;
          return { ...placement, decision: decided ?? "accepted", group };
        });
        return {
          parsedUpTo: read.next,
          malformed: state.malformed + read.malformed,
          changes: [...state.changes, ...fresh],
        };
      });
    };

    /** A run refused by the sign-in redirect: it waits for the renewal, or goes again now for a stale refusal. */
    const waitForSignIn = (error: SignedOut, retried: boolean) => {
      set({ phase: "waiting" });
      if (error.stale && signedIn() && !retried) get().resume();
    };

    const run = async (retried = false) => {
      const { epoch, base } = get();
      const request = sent;
      if (request === undefined || base === null) return;
      const own = new AbortController();
      controller = own;
      const working = () =>
        get().epoch === epoch && controller === own && get().phase === "working";
      set({ phase: "working" });
      let answered = false;
      try {
        const events = await deps.streamRework(request, own.signal);
        for await (const event of events) {
          answered = true;
          if (!working()) break;
          if (event.type === "delta") {
            set((state) => ({ answer: state.answer + event.text }));
            readNew(base);
          } else if (event.type === "error") {
            set({ phase: "review", ended: "failed", failure: event.code });
          } else {
            const { summary } = parseReworkAnswer(get().answer);
            // An answer cut off at the output ceiling, or one with neither a change nor a summary,
            // ended before it finished: shown as a cut stream, never as "nothing to change".
            const cut =
              event.problems.includes("incomplete") ||
              (summary === null && get().changes.length === 0);
            set({
              phase: "review",
              ...(cut ? { ended: "failed", failure: "stream" } : { ended: "complete" }),
              problems: event.problems,
              summary,
            });
          }
        }
        // The stream ended before its result: cut off, unless Stop or a drop ended it.
        if (working()) set({ phase: "review", ended: "failed", failure: "stream" });
      } catch (error) {
        if (!working()) return;
        if (error instanceof SignedOut && !answered && !own.signal.aborted) {
          waitForSignIn(error, retried);
        } else if (error instanceof ReworkRefused) {
          set({ phase: "review", ended: "failed", failure: error.reason });
        } else {
          set({ phase: "review", ended: "failed", failure: "stream" });
        }
      } finally {
        if (controller === own) controller = undefined;
      }
    };

    const decide = (at: number, decision: ReviewChange["decision"]) =>
      set((state) => {
        const target = state.changes.find((change) => change.ok && arrival(change) === at);
        // A decision that changes nothing leaves the linked ones, which the owner may have set apart.
        const decides = (change: ReviewChange) =>
          change.ok &&
          (arrival(change) === at ||
            (target?.ok === true &&
              target.decision !== decision &&
              decidedWith(target.change, change.change, decision)));
        return {
          applyProblem: null,
          changes: state.changes.map((change) =>
            decides(change) ? { ...change, decision } : change,
          ),
        };
      });

    /** Back to idle; the request and the composer's choices stay. */
    const end = () => set({ ...NO_RUN, epoch: drop() });

    return {
      ...EMPTY,
      epoch: 0,

      open: (characterId) => {
        if (get().characterId === characterId) return;
        get().clear();
        set({ characterId });
      },

      setRequest: (request) => set({ request }),
      setModel: (model) => set({ model }),
      setReasoning: (reasoning) => set({ reasoning }),
      setPortrait: (portrait) => set({ portrait }),

      start: ({ characterId, model, reasoning, personaId, portrait, card }) => {
        const { characterId: bound, request, phase } = get();
        // `pagehide` unbinds the session while the sheet stays (a back/forward restore): a run binds it again.
        if ((bound !== null && bound !== characterId) || request.trim() === "") return false;
        if (phase !== "idle" && phase !== "applied") return false;
        const epoch = drop();
        sent = {
          characterId,
          model,
          ...effortOf({ reasoning }),
          request,
          ...(personaId === null ? {} : { personaId }),
          portrait,
          card,
        };
        set({ ...NO_RUN, characterId, epoch, phase: "working", base: card });
        void run();
        return true;
      },

      stop: () => {
        if (get().phase !== "working") return;
        controller?.abort();
        set({ phase: "review", ended: "stopped" });
      },

      accept: (at) => decide(at, "accepted"),
      reject: (at) => decide(at, "rejected"),

      setGroup: (group, decision) =>
        set((state) => ({
          applyProblem: null,
          changes: state.changes.map((change) =>
            change.ok && change.group === group ? { ...change, decision } : change,
          ),
        })),

      discard: () => {
        const { phase } = get();
        if (phase === "working" || phase === "waiting" || phase === "review") end();
      },

      apply: () => {
        const state = get();
        if (state.phase !== "review" || state.base === null) return null;
        const accepted = acceptedChanges(state);
        if (accepted.length === 0) return null;
        const { base } = state;
        const result = applyChanges(base, accepted);
        // Placement measures each change against the proposal as a whole; the selection may differ.
        const problem = invalidField({ ...base, ...result.next });
        if (problem !== null) {
          set({ applyProblem: problem });
          return null;
        }
        const counts: Partial<Record<keyof ReworkCard, number>> = {};
        for (const change of accepted) {
          const key = cardKey(change.field);
          counts[key] = (counts[key] ?? 0) + 1;
        }
        const previous = Object.fromEntries(
          result.touched.map((key) => [key, base[key]]),
        ) as Partial<ReworkCard>;
        const cleared = accepted.filter(isClearing).map((change) => cardKey(change.field));
        set({
          ...NO_RUN,
          epoch: drop(),
          phase: "applied",
          request: "",
          applied: {
            written: result.next,
            previous,
            count: accepted.length,
            counts,
            converted: cleared.length > 0 ? ["description", ...cleared] : [],
            undone: null,
          },
        });
        return result;
      },

      undo: (current) => {
        const { phase, applied } = get();
        if (phase !== "applied" || applied === null || applied.undone !== null) return {};
        const restore: Partial<ReworkCard> = {};
        const { edited, kept } = heldBack(applied, current);
        let restored = 0;
        for (const key of Object.keys(applied.written) as (keyof ReworkCard)[]) {
          if (edited.includes(key) || kept.includes(key)) continue;
          Object.assign(restore, { [key]: applied.previous[key] });
          restored += applied.counts[key] ?? 0;
        }
        const labels = (keys: (keyof ReworkCard)[]) => keys.map((key) => keyLabel(key, current));
        set({
          applied: {
            ...applied,
            undone: { restored, skipped: labels(edited), kept: labels(kept) },
          },
        });
        return restore;
      },

      finish: () => {
        const { phase } = get();
        if (phase === "applied" || phase === "review") end();
      },

      clear: () => set({ ...EMPTY, epoch: drop() }),

      resume: () => {
        if (get().phase === "waiting") void run(true);
      },
    };
  });

  // The lamp breathes at the in-flight pace while the model writes; told only on a change.
  let writing = false;
  store.subscribe((state) => {
    const now = state.phase === "working";
    if (now === writing) return;
    writing = now;
    deps.writing?.(now);
  });

  return store;
}
