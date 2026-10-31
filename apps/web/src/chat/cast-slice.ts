import {
  applyCastChanges,
  CAST_LIMITS,
  type CallAccounting,
  type CallPurpose,
  type CallUsage,
  type CastAnchor,
  type CastCorrectionPatch,
  type CastEntry,
  type CastRegister,
  type CastSheetEntry,
  type CastSheetRequest,
  type CastState,
  type CastUpdateRequest,
  type CharacterMemory,
  type ChatTurn,
  castIdentity,
  castKey,
  clampCastCorrection,
  emptyCastState,
  fillMemoryCastEntries,
  memoryCastContext,
  memoryCastEntries,
  memoryIsOn,
  NO_PERSONA_NAME,
  type ReasoningEffort,
  resolveCastEntry,
  withKnownIdentities,
  withSheet,
} from "@ephemera/core";
import type { StoreApi } from "zustand/vanilla";
import type { CastFailure, CastSheetOutcome, CastUpdateOutcome } from "../cast/queries.ts";
import { type AssistantMessage, type ChatMessage, shownReply } from "./store.ts";
import type { UsageHandle } from "./usage.ts";

/*
 * The cast register (PRINCIPLES.md 1): a snapshot per reply of
 * who is in the story and how they stand, kept by a keeper call after each
 * complete reply, the owner's corrections over it, and the cast sheet this
 * chat acknowledged. All of it is chat content, held in this store only: no
 * storage, URL, history state or log. Clear and `pagehide` drop it whole,
 * and a late answer for another epoch, character or call changes nothing.
 */

/** The register as a keeper call left it after one reply. */
interface CastSnapshot {
  register: CastRegister;
  /** Unused notebook admissions, recomposed after established people and the card. */
  seedOnly?: readonly string[];
  usage: CallUsage | null;
  at: number;
}

/** Deleted snapshots and the exact catch-up memberships a deletion can undo. */
export interface CastTaken {
  snapshots: Record<string, CastSnapshot>;
  recovery: Record<string, readonly string[] | undefined>;
}

/** A state correction and the correction version it was set at. */
type StateCorrections = {
  [K in keyof CastState]?: { value: CastState[K]; version: number };
};

/** The owner's corrections to one entry. */
interface CastCorrection {
  /** Hold for the chat: applied over every base. */
  anchor: Partial<CastAnchor>;
  /** Yield to the first snapshot of a call built after them. */
  state: StateCorrections;
  /** Removed from the cast for this chat: left out everywhere, never added again. */
  removed?: true;
}

export interface CastCall {
  id: string;
  kind: "seed" | "update";
  replyId: string;
  replyVersion: number;
  correctionVersion: number;
}

export interface ChatCast {
  /** A replaceable notebook overlay, never a second memory query cache. */
  memory: {
    characterId: string;
    revision: number;
    player: string | null;
    entries: CastSheetEntry[];
  } | null;
  /** The sheet this chat acknowledged, laid over every base; null without one. */
  sheet: { fingerprint: string; entries: CastSheetEntry[] } | null;
  /** `waiting`: no usable cast model yet (none, or no known window), so nothing was asked. */
  sheetStatus: "idle" | "waiting" | "loading" | "failed";
  /** By reply id, greetings included. */
  snapshots: Record<string, CastSnapshot>;
  /** By entry id. */
  corrections: Record<string, CastCorrection>;
  /** One more per correction; a call records the value it was built at. */
  correctionVersion: number;
  /** The call in flight; every mutation a call makes checks its id first. */
  activeCall: CastCall | null;
  status: "idle" | "seeding" | "updating" | "failed";
  failure: CastFailure | null;
  /** Failures in a row since the last good snapshot. */
  failures: number;
  /** The last good call, for the inspector. */
  lastCall: { model: string; usage: CallUsage; at: number } | null;
}

export const EMPTY_CAST: ChatCast = {
  memory: null,
  sheet: null,
  sheetStatus: "idle",
  snapshots: {},
  corrections: {},
  correctionVersion: 0,
  activeCall: null,
  status: "idle",
  failure: null,
  failures: 0,
  lastCall: null,
};

export type CastField = keyof CastAnchor | keyof CastState;

export interface CastSliceState {
  cast: ChatCast;
  /** Writes the owner's correction of an entry's fields, as the record shows them. */
  correctCast: (entryId: string, patch: CastCorrectionPatch) => void;
  /** Takes back the correction of one field, so the recorded value shows again. */
  revertCast: (entryId: string, field: CastField) => void;
  /** Leaves an entry out of the cast for this chat. */
  removeCast: (entryId: string) => void;
  /** Takes a removal back. */
  restoreCast: (entryId: string) => void;
  /** Runs the keeper for the newest reply now (Try again). */
  retryCast: () => void;
  /** A cast model became available: a sheet that waited for one is asked for now. */
  castModelReady: () => void;
  /** A memory query changed or became unavailable. Old seed-only identities are replaced. */
  receiveCastMemory: (characterId: string, memory: CharacterMemory | undefined) => void;
}

export interface CastDeps {
  /** Uses the existing memory query lifecycle; missing or failed memory supplies no seed. */
  memory?: (characterId: string) => Promise<CharacterMemory | undefined>;
  update: (
    request: CastUpdateRequest,
    signal: AbortSignal,
    onAccounting?: (accounting: CallAccounting) => void,
  ) => Promise<CastUpdateOutcome>;
  sheet: (
    characterId: string,
    request: CastSheetRequest,
    signal: AbortSignal,
    onAccounting?: (accounting: CallAccounting) => void,
  ) => Promise<CastSheetOutcome>;
  /**
   * The cast model and effort Settings choose (core `castModelOf`,
   * `castReasoningOf`), and whether that model's context window is known: a
   * sheet waits for one, as the server cannot read the card without it.
   */
  settings: () => {
    model: string | null;
    reasoning: ReasoningEffort | null;
    windowKnown: boolean;
  };
  /** A new entry's id. */
  newId: () => string;
  /** The persona's name, never an entry; null when unknown. */
  player?: (personaId: string) => string | null;
}

/** What the chat store lends the slice. */
interface CastHost {
  generation?: (replyId: string) => string | null;
  trackUsage?: (
    purpose: CallPurpose,
    model: string,
    generation: string | null,
    id?: string,
  ) => UsageHandle;
  /** The chat's character and persona now. */
  chosen: () => { characterId: string | null; personaId: string | null };
  /** The shown turns of `messages[from, to)`. */
  turns: (from: number, to: number) => ChatTurn[];
  /** The register the next prompt carries changed: its preview follows. */
  changed: () => void;
}

type CastView = { messages: ChatMessage[]; cast: ChatCast };
type CastStore = CastSliceState & CastView & { epoch: number };

const isAssistant = (message: ChatMessage | undefined): message is AssistantMessage =>
  message?.role === "assistant";

/** The newest assistant message before `index` whose shown reply has a snapshot; -1 for none. */
function baseIndex(state: CastView, index: number): number {
  for (let at = Math.min(index, state.messages.length) - 1; at >= 0; at--) {
    const message = state.messages[at];
    if (isAssistant(message) && state.cast.snapshots[shownReply(message).id] !== undefined) {
      return at;
    }
  }
  return -1;
}

const EMPTY_REGISTER: CastRegister = { entries: [] };

/** The register the newest snapshot before `index` holds; empty without one. */
export function baseBefore(state: CastView, index: number): CastRegister {
  const message = state.messages[baseIndex(state, index)];
  return isAssistant(message)
    ? (state.cast.snapshots[shownReply(message).id]?.register ?? EMPTY_REGISTER)
    : EMPTY_REGISTER;
}

const putState = <K extends keyof CastState>(
  target: CastState,
  field: K,
  value: CastState[K] | undefined,
) => {
  if (value !== undefined) target[field] = value;
};

const putAnchor = <K extends keyof CastAnchor>(
  target: CastAnchor,
  field: K,
  value: CastAnchor[K],
) => {
  target[field] = value;
};

/** The owner's state corrections over a register: a call's snapshot keeps the ones it read. */
const withStateCorrections = (
  register: CastRegister,
  corrections: ChatCast["corrections"],
): CastRegister => ({
  entries: register.entries.map((entry) => {
    const correction = corrections[entry.id];
    if (correction === undefined || Object.keys(correction.state).length === 0) return entry;
    const state = { ...entry.state };
    for (const field of Object.keys(correction.state) as (keyof CastState)[]) {
      putState(state, field, correction.state[field]?.value);
    }
    return { ...entry, state };
  }),
});

/** The owner's anchor corrections over a register: never kept in a snapshot. */
const withAnchorCorrections = (
  register: CastRegister,
  corrections: ChatCast["corrections"],
): CastRegister => ({
  entries: register.entries.map((entry) => {
    const anchor = corrections[entry.id]?.anchor;
    if (anchor === undefined || Object.keys(anchor).length === 0) return entry;
    const developments = { ...entry.developments };
    for (const field of Object.keys(developments) as (keyof typeof developments)[]) {
      const value = anchor[field];
      if (value !== undefined) developments[field] = value;
    }
    return {
      ...entry,
      anchor: { ...entry.anchor, ...anchor },
      ...(entry.developments === undefined ? {} : { developments }),
    };
  }),
});

/** The sheet over the base at `index`, with no correction. */
function sheetedAt(
  state: CastView,
  index: number,
  recovering: CastRegister = EMPTY_REGISTER,
): CastRegister {
  const base = baseBefore(state, index);
  const { sheet, memory } = state.cast;
  const message = state.messages[baseIndex(state, index)];
  const seedOnly = new Set(
    isAssistant(message) ? state.cast.snapshots[shownReply(message).id]?.seedOnly : [],
  );
  // Let the shared sheet resolver claim seed identities before recomposing unused seeds.
  // A claimed entry is copied by withSheet, preserving its id and scene state.
  const overlaid = sheet === null ? base : withSheet(sheet, base);
  const originals = new Map(base.entries.map((entry) => [entry.id, entry]));
  const retained = {
    entries: overlaid.entries.filter((entry) => {
      const original = originals.get(entry.id);
      return (
        original !== undefined &&
        (!seedOnly.has(entry.id) ||
          state.cast.corrections[entry.id] !== undefined ||
          entry !== original)
      );
    }),
  };
  const recovered = withKnownIdentities(retained, recovering);
  // Sheet admission comes first, remembered lines fill gaps, and the card's anchors win.
  const card = sheet === null ? recovered : withSheet(sheet, recovered);
  const seeded =
    memory === null
      ? card
      : withSheet(
          { entries: fillMemoryCastEntries(memory.entries, memory.player ?? NO_PERSONA_NAME) },
          card,
          { fillOnly: true, player: memory.player ?? NO_PERSONA_NAME },
        );
  return sheet === null ? seeded : withSheet(sheet, seeded);
}

/** The sheet over the base at `index`, with the state corrections; no anchor correction. */
const recordedAt = (state: CastView, index: number): CastRegister =>
  withStateCorrections(sheetedAt(state, index), state.cast.corrections);

/** Every correction over the sheet over the base at `index`, removed entries kept. */
const chainAt = (state: CastView, index: number): CastRegister =>
  withAnchorCorrections(recordedAt(state, index), state.cast.corrections);

/**
 * The keeper's answer as a snapshot keeps it: an anchor field still as the
 * owner corrected it takes back the value recorded before, so a Revert shows
 * that value and only the overlay carries the correction.
 */
function withoutAnchorCorrections(
  applied: CastRegister,
  recorded: readonly CastRegister[],
  corrections: ChatCast["corrections"],
): CastRegister {
  return {
    entries: applied.entries.map((entry) => {
      const corrected = corrections[entry.id]?.anchor;
      const before = entryIn(recorded, entry.id);
      if (corrected === undefined || before === undefined) return entry;
      const anchor = { ...entry.anchor };
      for (const field of Object.keys(corrected) as (keyof CastAnchor)[]) {
        if (anchor[field] === corrected[field]) putAnchor(anchor, field, before.anchor[field]);
      }
      // A correction masks a development only for readers, never in the saved snapshot.
      const developments = { ...entry.developments };
      for (const field of Object.keys(developments) as (keyof typeof developments)[]) {
        if (!(field in corrected)) continue;
        const original = before.developments?.[field];
        if (original === undefined) delete developments[field];
        else developments[field] = original;
      }
      return { ...entry, anchor, ...(entry.developments === undefined ? {} : { developments }) };
    }),
  };
}

/** The entry with `id` in the first of these registers that has one. */
const entryIn = (registers: readonly CastRegister[], id: string) =>
  registers.flatMap((register) => register.entries).find((entry) => entry.id === id);

/**
 * The keeper's answer without the state corrections the call read that the
 * owner took back (or replaced) while it ran: a field still at the value it
 * read takes back the recorded one.
 */
function withoutRevertedState(
  applied: CastRegister,
  raw: readonly CastRegister[],
  read: ChatCast["corrections"],
  now: ChatCast["corrections"],
): CastRegister {
  return {
    entries: applied.entries.map((entry) => {
      const consumed = read[entry.id]?.state;
      const before = entryIn(raw, entry.id);
      if (consumed === undefined || before === undefined) return entry;
      const state = { ...entry.state };
      for (const field of Object.keys(consumed) as (keyof CastState)[]) {
        const correction = consumed[field];
        if (correction === undefined || now[entry.id]?.state[field] === correction) continue;
        if (state[field] === correction.value) putState(state, field, before.state[field]);
      }
      return { ...entry, state };
    }),
  };
}

const removedIds = (corrections: ChatCast["corrections"]): Set<string> =>
  new Set(Object.keys(corrections).filter((id) => corrections[id]?.removed === true));

const withoutRemoved = (register: CastRegister, removed: ReadonlySet<string>): CastRegister =>
  removed.size === 0
    ? register
    : { entries: register.entries.filter((entry) => !removed.has(entry.id)) };

/** The register as it stands before message `index`, removed entries left out. */
export const registerAt = (state: CastView, index: number): CastRegister =>
  withoutRemoved(chainAt(state, index), removedIds(state.cast.corrections));

/** Only a shown snapshot at/before the archival boundary lends context, never current seeds. */
export function memoryContextAt(state: CastView, boundary: number) {
  const register = withoutRemoved(
    withAnchorCorrections(baseBefore(state, boundary), state.cast.corrections),
    removedIds(state.cast.corrections),
  );
  return register.entries.length === 0 ? undefined : memoryCastContext(register);
}

/** By the messages and the cast it was read from: held no longer than they are. */
const currents = new WeakMap<ChatMessage[], WeakMap<ChatCast, CastRegister>>();

/**
 * The register as it stands after the newest message: what the next
 * request, the next keeper base and the panel read. The same object while
 * the messages and the cast are, so a component can select it.
 */
export function currentRegister(state: CastView): CastRegister {
  const byCast = currents.get(state.messages) ?? new WeakMap<ChatCast, CastRegister>();
  currents.set(state.messages, byCast);
  const known = byCast.get(state.cast);
  if (known !== undefined) return known;
  const register = registerAt(state, state.messages.length);
  byCast.set(state.cast, register);
  return register;
}

/** The newest assistant message whose shown reply has text. */
const newestReply = (messages: ChatMessage[]): AssistantMessage | undefined =>
  messages.findLast(
    (message): message is AssistantMessage =>
      isAssistant(message) && shownReply(message).text !== "",
  );

/** The newest shown completion the keeper may cover, independent of visible stale text. */
const newestKeeperTarget = (messages: readonly ChatMessage[]): AssistantMessage | undefined =>
  messages.findLast((message): message is AssistantMessage => {
    if (!isAssistant(message)) return false;
    const reply = shownReply(message);
    return (
      reply.status === "complete" &&
      reply.text !== "" &&
      reply.finishReason !== "length" &&
      reply.finishReason !== "content-filter"
    );
  });

/** Whether the newest eligible shown completion still needs keeper coverage. */
export function keeperTargetUncovered(state: CastView): boolean {
  const target = newestKeeperTarget(state.messages);
  return target !== undefined && state.cast.snapshots[shownReply(target).id] === undefined;
}

/** The newest reply has no snapshot and no call is writing one: the panel shows the previous one. */
export function stale(state: CastView): boolean {
  const newest = newestReply(state.messages);
  if (newest === undefined || state.cast.snapshots[shownReply(newest).id] !== undefined) {
    return false;
  }
  return state.cast.status !== "updating" && state.cast.status !== "seeding";
}

/** A correction with nothing in it is no correction. */
const isEmpty = (correction: CastCorrection) =>
  correction.removed !== true &&
  Object.keys(correction.anchor).length === 0 &&
  Object.keys(correction.state).length === 0;

const withCorrection = (
  corrections: ChatCast["corrections"],
  entryId: string,
  correction: CastCorrection,
): ChatCast["corrections"] => {
  const { [entryId]: _old, ...rest } = corrections;
  return isEmpty(correction) ? rest : { ...rest, [entryId]: correction };
};

const NO_CORRECTION: CastCorrection = { anchor: {}, state: {} };

export function createCastSlice(
  set: StoreApi<CastStore>["setState"],
  get: StoreApi<CastStore>["getState"],
  deps: CastDeps | undefined,
  host: CastHost,
) {
  /** The keeper call in flight; one at a time. */
  let calling: AbortController | undefined;
  type Start = {
    generation: string | null;
    epoch: number;
    characterId: string | null;
    personaId: string | null;
    messageId: string;
    replyId: string;
    replyVersion: number;
    replyText: string;
    source: readonly ChatMessage[];
    /** Only an explicit failed-sheet retry waits for canon before spending on the keeper. */
    waitForSheet: Promise<void> | undefined;
  };
  /** Reserve before awaiting readiness, including starts from same-tick source completions. */
  let pending: Start | undefined;
  let replacement: Start | undefined;
  let running: Start | undefined;
  let queued: Start | undefined;
  let runningValid: (() => boolean) | undefined;
  type Continuation = {
    source: readonly ChatMessage[];
    base: number;
    epoch: number;
    characterId: string | null;
    personaId: string | null;
    model: string;
    reasoning: ReasoningEffort | null;
    player: string | null;
    sheet: ChatCast["sheet"];
    memoryEntries: readonly CastSheetEntry[] | undefined;
    memoryPlayer: string | null | undefined;
    corrections: ChatCast["corrections"];
    correctionVersion: number;
    chain: CastRegister;
    previous: CastRegister;
    sheeted: CastRegister;
    recorded: CastRegister;
    recovering: { id: string; ids: readonly string[] }[];
    offset: number;
    limit: number;
    multibatch: boolean;
    sent: Set<string>;
    affirmed: Set<string>;
  };
  // One tab-only prefix, with source object identities rather than another transcript copy.
  let continuation: Continuation | undefined;
  const sourceValid = (source: readonly ChatMessage[]) =>
    source.every((message, at) => get().messages[at] === message);
  const startValid = (start: Start) =>
    get().epoch === start.epoch &&
    host.chosen().characterId === start.characterId &&
    host.chosen().personaId === start.personaId &&
    sourceValid(start.source);
  const contextValid = (progress: Continuation) =>
    get().epoch === progress.epoch &&
    host.chosen().characterId === progress.characterId &&
    host.chosen().personaId === progress.personaId &&
    deps?.settings().model === progress.model &&
    deps?.settings().reasoning === progress.reasoning &&
    playerNow() === progress.player &&
    get().cast.sheet === progress.sheet &&
    get().cast.memory?.entries === progress.memoryEntries &&
    get().cast.memory?.player === progress.memoryPlayer &&
    get().cast.corrections === progress.corrections &&
    sourceValid(progress.source);
  type ReplySource = Pick<Start, "messageId" | "replyId" | "replyVersion" | "replyText">;
  const failedStarts = new Map<string, ReplySource>();
  const matches = (start: ReplySource, message: AssistantMessage | undefined) =>
    message?.id === start.messageId &&
    shownReply(message).id === start.replyId &&
    (shownReply(message).castVersion ?? 0) === start.replyVersion &&
    shownReply(message).text === start.replyText;
  /**
   * Every entry this chat has known, by id: each committed snapshot's
   * (removed ones included) and the acknowledged sheet's, the latest per id.
   * A name the base lacks resolves here before a new id is minted, so a
   * person keeps her id, corrections and removal whatever became of the
   * reply that introduced her. Chat content: only Clear empties it.
   */
  const known = new Map<string, CastEntry>();
  /** Only edited or stopped replies lend identities to catch-up, never discarded branches. */
  const recovery = new Map<string, readonly string[]>();
  const learn = (entries: readonly CastEntry[]) => {
    for (const entry of entries) known.set(entry.id, entry);
  };
  /** The sheet request this chat made, and for which epoch and character. */
  let sheetFor: { epoch: number; characterId: string; controller: AbortController } | undefined;
  let sheetLoading: Promise<void> | undefined;
  let memoryFor: { epoch: number; characterId: string; token: object; loaded: boolean } | undefined;
  let memoryLoading: Promise<void> | undefined;
  const seedIds = new Map<string, string>();
  const established = new Set<string>();
  const playerNow = () => {
    const { personaId } = host.chosen();
    return personaId === null ? null : (deps?.player?.(personaId) ?? null);
  };

  const patchCast = (patch: Partial<ChatCast> | ((cast: ChatCast) => Partial<ChatCast>)) =>
    set((state) => ({
      cast: { ...state.cast, ...(typeof patch === "function" ? patch(state.cast) : patch) },
    }));

  /** Card adoption and owner affirmation make an identity part of this chat. */
  const affirm = (entries: readonly CastEntry[]) => {
    for (const entry of entries) established.add(entry.id);
    learn(entries);
    patchCast((cast) => ({
      snapshots: Object.fromEntries(
        Object.entries(cast.snapshots).map(([id, snapshot]) => [
          id,
          snapshot.seedOnly === undefined
            ? snapshot
            : { ...snapshot, seedOnly: snapshot.seedOnly.filter((id) => !established.has(id)) },
        ]),
      ),
    }));
  };

  /** Context changes transfer existing authority, never create work from a failed checkpoint. */
  const handoffContext = (install: () => void = () => {}) => {
    const restart = [queued, replacement, pending, running].find(
      (start) =>
        start !== undefined &&
        startValid(start) &&
        matches(start, newestKeeperTarget(get().messages)),
    );
    cancelKeep(true);
    install();
    if (restart === undefined) return;
    replacement = restart;
    queueMicrotask(() => {
      if (replacement !== restart) return;
      replacement = undefined;
      if (
        startValid(restart) &&
        matches(restart, newestKeeperTarget(get().messages)) &&
        deps?.settings().model !== null
      )
        keep(restart.messageId, { waitForSheet: restart.waitForSheet });
    });
  };

  /** An owner's change to the corrections: the next prompt's preview follows. */
  const correct = (change: (cast: ChatCast) => Partial<ChatCast>) => {
    const before = get().cast.corrections;
    patchCast(change);
    if (get().cast.corrections !== before) {
      // Single-request corrections retain their existing merge/revert semantics. A dependent
      // batch chain, however, cannot reuse results computed under another correction context.
      if (continuation?.multibatch) handoffContext();
      else continuation = undefined;
      host.changed();
    }
  };

  /** Seed-only people come from this overlay, including after a snapshot or Undo. */
  const replaceSeedOverlay = (memory: ChatCast["memory"]) => {
    const prior = get().cast.memory;
    const removed = new Set(
      (prior?.entries ?? []).map((entry) => entry.id).filter((id) => !established.has(id)),
    );
    for (const id of removed) known.delete(id);
    handoffContext(() =>
      patchCast((cast) => ({
        memory,
        snapshots: Object.fromEntries(
          Object.entries(cast.snapshots).map(([id, snapshot]) => [
            id,
            {
              ...snapshot,
              register: {
                entries: snapshot.register.entries.filter((entry) => !removed.has(entry.id)),
              },
            },
          ]),
        ),
      })),
    );
    host.changed();
  };

  const receiveMemory = (characterId: string, memory: CharacterMemory | undefined) => {
    if (host.chosen().characterId !== characterId) return;
    const revision = memory?.state?.revision ?? -1;
    const on = memory !== undefined && memoryIsOn(memory.state);
    const prior = get().cast.memory;
    const player = playerNow();
    // Invalidate an older query completion even when this came from a manual cache update.
    memoryFor = { epoch: get().epoch, characterId, token: {}, loaded: memory !== undefined };
    if (!on && prior === null) return;
    const entries = on
      ? memoryCastEntries(memory.state?.notebook.cast ?? [], (name) => {
          const key = castKey(name);
          const id = seedIds.get(key) ?? deps?.newId() ?? crypto.randomUUID();
          seedIds.set(key, id);
          return id;
        })
      : [];
    // Other notebook fields advance the revision without changing any keeper input.
    if (
      on &&
      prior?.characterId === characterId &&
      prior.player === player &&
      JSON.stringify(prior.entries) === JSON.stringify(entries)
    ) {
      if (prior.revision !== revision) patchCast({ memory: { ...prior, revision } });
      return;
    }
    replaceSeedOverlay(on ? { characterId, revision, player, entries } : null);
  };

  const followMemory = (retry = true) => {
    const characterId = host.chosen().characterId;
    if (deps?.memory === undefined || characterId === null) return;
    if (
      memoryFor?.epoch === get().epoch &&
      memoryFor.characterId === characterId &&
      (memoryFor.loaded || memoryLoading !== undefined || !retry)
    )
      return;
    if (get().cast.memory !== null && get().cast.memory?.characterId !== characterId)
      receiveMemory(characterId, undefined);
    const token = {};
    const epoch = get().epoch;
    memoryFor = { epoch, characterId, token, loaded: false };
    const loading = deps
      .memory(characterId)
      .catch(() => undefined)
      .then((memory) => {
        if (
          memoryFor?.token !== token ||
          get().epoch !== epoch ||
          host.chosen().characterId !== characterId
        )
          return;
        receiveMemory(characterId, memory);
      })
      .finally(() => {
        if (memoryLoading === loading) memoryLoading = undefined;
      });
    memoryLoading = loading;
    void loading.then(seedGreeting);
  };

  /** Generations read saved notebook seeds; the model-derived sheet stays in the background. */
  const ready = async (retry = true) => {
    follow(retry);
    if (deps?.memory !== undefined) await memoryLoading;
  };

  /** Attach explicit reload authority before any reserved target can be handed off. */
  const reloadFor = (start: Start) => {
    follow();
    start.waitForSheet = sheetLoading ?? start.waitForSheet;
  };

  /** The keeper reads the turns since the last good snapshot through message `messageId`. */
  const keep = (
    messageId: string,
    {
      reloadSheet = false,
      waitForSheet = [queued, replacement, pending, running].find(
        (start) => start !== undefined && startValid(start) && start.waitForSheet !== undefined,
      )?.waitForSheet,
    }: { reloadSheet?: boolean; waitForSheet?: Promise<void> | undefined } = {},
  ) => {
    if (deps === undefined || deps.settings().model === null) return;
    const state = get();
    const message = newestKeeperTarget(state.messages);
    if (message?.id !== messageId) return;
    const reply = shownReply(message);
    const start: Start = {
      generation: host.generation?.(reply.id) ?? null,
      epoch: state.epoch,
      characterId: host.chosen().characterId,
      personaId: host.chosen().personaId,
      messageId,
      replyId: reply.id,
      replyVersion: reply.castVersion ?? 0,
      replyText: reply.text,
      source: state.messages.slice(0, state.messages.indexOf(message) + 1),
      waitForSheet,
    };
    if (
      [pending, running].some(
        (current) => current !== undefined && startValid(current) && matches(current, message),
      )
    )
      return;
    const earlier = running ?? pending;
    if (
      earlier !== undefined &&
      earlier.source.length < start.source.length &&
      startValid(earlier) &&
      (runningValid?.() ?? true)
    ) {
      queued = start;
      if (reloadSheet) reloadFor(start);
      return;
    }
    queued = undefined;
    pending = start;
    replacement = undefined;
    calling?.abort();
    if (reloadSheet) reloadFor(start);
    void runKeep(start).finally(() => {
      if (pending === start) pending = undefined;
      if (calling !== undefined || pending !== undefined) return;
      const next = queued;
      queued = undefined;
      if (
        next !== undefined &&
        startValid(next) &&
        matches(next, newestKeeperTarget(get().messages))
      )
        keep(next.messageId, { waitForSheet: next.waitForSheet });
    });
  };

  const runKeep = async (start: Start) => {
    if (deps === undefined) return;
    const { messageId } = start;
    if (start.waitForSheet !== undefined) await start.waitForSheet;
    if (pending !== start || !startValid(start) || deps.settings().model === null) return;
    if (deps.memory !== undefined) await ready(false);
    else follow(false);
    // A joined retry may attach its barrier while this reservation awaits notebook readiness.
    if (start.waitForSheet !== undefined) await start.waitForSheet;
    if (
      pending !== start ||
      !startValid(start) ||
      !matches(start, newestKeeperTarget(get().messages.slice(0, start.source.length)))
    )
      return;
    const state = get();
    const index = state.messages.findIndex((message) => message.id === messageId);
    const message = state.messages[index];
    if (!isAssistant(message)) return;
    const reply = shownReply(message);
    const { model, reasoning } = deps.settings();
    if (model === null) return;
    const { characterId, personaId } = host.chosen();
    const base = baseIndex(state, index);
    const turns = host.turns(base + 1, index + 1);
    if (turns.length === 0) return;
    const { corrections } = state.cast;
    const previous: CastRegister = {
      entries: [...known.values()].map((entry) => ({
        ...castIdentity(entry),
        state: emptyCastState(false),
      })),
    };
    const recovering = state.messages.slice(base + 1, index + 1).flatMap((message) => {
      const id = isAssistant(message) ? shownReply(message).id : undefined;
      const ids = id === undefined ? undefined : recovery.get(id);
      return id === undefined || ids === undefined ? [] : [{ id, ids }];
    });
    const candidates = new Set(recovering.flatMap(({ ids }) => ids));
    const sheeted = sheetedAt(state, index, {
      entries: previous.entries.filter((entry) => candidates.has(entry.id)),
    });
    const recorded = withStateCorrections(sheeted, corrections);
    // The keeper reads every correction, so it never writes over one; removed entries stay in for
    // resolution and out of what it reads.
    const player = playerNow();
    const progress: Continuation =
      continuation !== undefined &&
      continuation.base === base &&
      continuation.source.length <= index + 1 &&
      contextValid(continuation)
        ? continuation
        : {
            source: state.messages.slice(0, index + 1),
            base,
            epoch: state.epoch,
            characterId,
            personaId,
            model,
            reasoning,
            player,
            sheet: state.cast.sheet,
            memoryEntries: state.cast.memory?.entries,
            memoryPlayer: state.cast.memory?.player,
            corrections,
            correctionVersion: state.cast.correctionVersion,
            chain: withAnchorCorrections(recorded, corrections),
            previous,
            sheeted,
            recorded,
            recovering,
            offset: 0,
            limit: CAST_LIMITS.turns,
            multibatch: turns.length > CAST_LIMITS.turns,
            sent: new Set<string>(),
            affirmed: new Set<string>(),
          };
    progress.source = state.messages.slice(0, index + 1);
    progress.multibatch ||= turns.length > progress.limit;
    continuation = progress;
    // Everyone the chat has known, as who they are, never how they stood: a name the base lacks
    // keeps its id, names and looks; the keeper describes her state from the turns it reads.
    const { epoch } = state;
    calling?.abort();
    const controller = new AbortController();
    calling = controller;
    running = start;
    const kind = message.greeting ? "seed" : "update";
    const call: CastCall = {
      id: crypto.randomUUID(),
      kind,
      replyId: reply.id,
      replyVersion: reply.castVersion ?? 0,
      correctionVersion: progress.correctionVersion,
    };
    patchCast({ activeCall: call, status: kind === "seed" ? "seeding" : "updating" });
    if (pending === start) pending = undefined;
    const request: CastUpdateRequest = {
      ...(characterId === null ? {} : { characterId }),
      ...(personaId === null ? {} : { personaId }),
      model,
      ...(reasoning === null ? {} : { reasoning }),
      mode: kind,
      sheetFingerprint: state.cast.sheet?.fingerprint ?? null,
      register: withoutRemoved(progress.chain, removedIds(corrections)),
      turns: [],
    };
    const own = () => get().epoch === epoch && get().cast.activeCall?.id === call.id;
    const source = state.messages.slice(0, index + 1);
    const valid = () =>
      !controller.signal.aborted &&
      deps.settings().model === model &&
      deps.settings().reasoning === reasoning &&
      host.chosen().characterId === characterId &&
      host.chosen().personaId === personaId &&
      playerNow() === player &&
      sourceValid(source) &&
      (!progress.multibatch || contextValid(progress));
    runningValid = valid;
    const ask = async (body: CastUpdateRequest) => {
      const accounting = host.trackUsage?.("cast.update", model, start.generation);
      let received = false;
      const outcome = await deps
        .update(body, controller.signal, (receipt) => {
          received = true;
          accounting?.receive(receipt);
        })
        .catch((): CastUpdateOutcome => ({ ok: false, reason: "unreachable" }));
      accounting?.finish(
        received
          ? undefined
          : outcome.ok
            ? "completed"
            : controller.signal.aborted
              ? "aborted"
              : ["unreachable", "timeout", "aborted", "cast_failed", "upstream_busy"].includes(
                    outcome.reason,
                  )
                ? "failed"
                : undefined,
      );
      return outcome;
    };
    try {
      // Only complete batches advance the private prefix. No target snapshot is visible until
      // every preceding turn is covered, including when a retry extends this unchanged source.
      let usage: CallUsage = {};
      const { sent, affirmed } = progress;
      while (progress.offset < turns.length) {
        // A single call may merge a correction or sheet, but shrinking it creates a dependent
        // chain. Recheck before every dispatch so that transition never pays for a stale batch.
        if (!own()) return;
        if (!valid()) {
          handoffContext();
          return;
        }
        const batch = turns.slice(progress.offset, progress.offset + progress.limit);
        const body = {
          ...request,
          register: withoutRemoved(progress.chain, removedIds(get().cast.corrections)),
          turns: batch,
        };
        const outcome = await ask(body);
        if (!own()) return;
        if (!valid()) {
          handoffContext();
          return;
        }
        if (!outcome.ok) {
          if (outcome.reason === "prompt_too_long" && batch.length > 1) {
            progress.limit = Math.ceil(batch.length / 2);
            progress.multibatch = true;
            continue;
          }
          failedStarts.set(start.replyId, {
            messageId: start.messageId,
            replyId: start.replyId,
            replyVersion: start.replyVersion,
            replyText: start.replyText,
          });
          patchCast((cast) => ({
            activeCall: null,
            status: "failed",
            failure: outcome.reason,
            failures: cast.failures + 1,
          }));
          return;
        }
        const { changes } = outcome.response;
        usage = outcome.response.usage;
        for (const entry of body.register.entries) sent.add(entry.id);
        progress.chain = applyCastChanges(progress.chain, changes, {
          player,
          newId: deps.newId,
          removed: removedIds(get().cast.corrections),
          previous: progress.previous,
          shown: batch.map((turn) => turn.scanText ?? turn.content),
          corrected: Object.fromEntries(
            [...new Set([...Object.keys(corrections), ...Object.keys(get().cast.corrections)])].map(
              (id) => [
                id,
                {
                  anchor: { ...corrections[id]?.anchor, ...get().cast.corrections[id]?.anchor },
                },
              ],
            ),
          ),
        });
        for (const name of [...Object.keys(changes.cast), ...changes.absent]) {
          const entry = resolveCastEntry(progress.chain, name);
          if (entry !== undefined) affirmed.add(entry.id);
        }
        progress.offset += batch.length;
        progress.limit = CAST_LIMITS.turns;
      }
      failedStarts.delete(start.replyId);
      const register = withoutRevertedState(
        withoutAnchorCorrections(
          progress.chain,
          [progress.recorded, progress.previous],
          corrections,
        ),
        [progress.sheeted, progress.previous],
        corrections,
        get().cast.corrections,
      );
      for (const id of affirmed) established.add(id);
      learn(register.entries.filter((entry) => established.has(entry.id)));
      for (const { id, ids } of progress.recovering) {
        if (recovery.get(id) === ids) recovery.delete(id);
      }
      const at = Date.now();
      if (continuation === progress) continuation = undefined;
      const seedOnly = [...seedIds.values()].filter(
        (id) =>
          !established.has(id) &&
          corrections[id] === undefined &&
          get().cast.corrections[id] === undefined,
      );
      patchCast((cast) => ({
        snapshots: { ...cast.snapshots, [call.replyId]: { register, seedOnly, usage, at } },
        // State corrections the call read yield to its snapshot; later ones stay, and so do those
        // of entries its request did not carry (one a re-read reply introduced, a removed one):
        // the keeper never saw them, so they hold until a call that did commits.
        corrections: Object.fromEntries(
          Object.entries(cast.corrections).flatMap(([id, correction]) => {
            if (!sent.has(id)) return [[id, correction]];
            const state = Object.fromEntries(
              Object.entries(correction.state).filter(
                ([, value]) => value.version > call.correctionVersion,
              ),
            ) as StateCorrections;
            const next = { ...correction, state };
            return isEmpty(next) ? [] : [[id, next]];
          }),
        ),
        activeCall: null,
        status: "idle",
        failure: null,
        failures: 0,
        lastCall: { model, usage, at },
      }));
      host.changed();
    } finally {
      if (calling === controller) {
        calling = undefined;
        running = undefined;
        runningValid = undefined;
      }
    }
  };

  /** A seed call over the greeting, while it is the newest reply, has no snapshot and a sheet landed. */
  const seedGreeting = () => {
    const { messages, cast } = get();
    const newest = messages.findLast(isAssistant);
    if (newest === undefined || !newest.greeting || (cast.sheet === null && cast.memory === null))
      return;
    if (deps?.memory !== undefined && (sheetLoading !== undefined || memoryLoading !== undefined))
      return;
    if (cast.activeCall !== null) return;
    const failed = failedStarts.get(shownReply(newest).id);
    if (failed !== undefined && matches(failed, newest)) return;
    if (cast.snapshots[shownReply(newest).id] !== undefined) return;
    void keep(newest.id);
  };

  /** Loads the character's sheet for this chat; when it lands for the same chat, it seeds. */
  const loadSheet = async (characterId: string) => {
    if (deps === undefined) return;
    const { epoch } = get();
    const changedCharacter =
      sheetFor !== undefined && (sheetFor.epoch !== epoch || sheetFor.characterId !== characterId);
    sheetFor?.controller.abort();
    const { model, reasoning, windowKnown } = deps.settings();
    // Nothing the server could read it with: the sheet waits, without a failure, until it can.
    if (model === null || !windowKnown) {
      sheetFor = undefined;
      patchCast({ ...(changedCharacter ? { sheet: null } : {}), sheetStatus: "waiting" });
      return;
    }
    const controller = new AbortController();
    sheetFor = { epoch, characterId, controller };
    patchCast({ ...(changedCharacter ? { sheet: null } : {}), sheetStatus: "loading" });
    /** No sheet this time: the next trigger, or Try again, asks again. */
    const failed = () => {
      sheetFor = undefined;
      patchCast({ sheetStatus: "failed" });
    };
    const accounting = host.trackUsage?.("cast.sheet", model, null);
    let received = false;
    const outcome = await deps
      .sheet(
        characterId,
        { model, ...(reasoning === null ? {} : { reasoning }) },
        controller.signal,
        (receipt) => {
          received = true;
          accounting?.receive(receipt);
        },
      )
      .catch((): CastSheetOutcome => ({ ok: false, reason: "unreachable" }));
    accounting?.finish(
      received
        ? undefined
        : outcome.ok
          ? outcome.sheet === null
            ? undefined
            : "completed"
          : controller.signal.aborted
            ? "aborted"
            : ["unreachable", "timeout", "aborted", "cast_failed", "upstream_busy"].includes(
                  outcome.reason,
                )
              ? "failed"
              : undefined,
    );
    // Cleared, another character, or another request since: it is not this chat's.
    if (
      sheetFor?.controller !== controller ||
      get().epoch !== epoch ||
      host.chosen().characterId !== characterId
    ) {
      return;
    }
    // A sheet read from the card as it was is not this chat's canon: none is acknowledged.
    if (!outcome.ok || !outcome.current) {
      failed();
      return;
    }
    const { sheet } = outcome;
    const prior = get().cast.sheet;
    const changed =
      prior?.fingerprint !== sheet?.fingerprint ||
      JSON.stringify(prior?.entries) !== JSON.stringify(sheet?.entries);
    const install = () =>
      patchCast({
        sheet: !changed
          ? prior
          : sheet === null
            ? null
            : { fingerprint: sheet.fingerprint, entries: sheet.entries },
        sheetStatus: "idle",
      });
    if (changed && continuation?.multibatch) handoffContext(install);
    else install();
    if (changed && sheet !== null) {
      const register = sheetedAt(get(), get().messages.length);
      // withSheet copies exactly the entries it claims, retaining their chat ids.
      affirm(
        withSheet(sheet, register).entries.filter((entry, at) => entry !== register.entries[at]),
      );
    }
    host.changed();
    if (deps.memory === undefined) seedGreeting();
  };

  /**
   * The sheet follows the chat's character: asked for once per chat and
   * character (a chat start, or the character changed in a chat under way),
   * dropped without one. True when this chat's request for it is already made.
   */
  function follow(retryMemory = true): boolean {
    if (deps === undefined) return false;
    const overlay = get().cast.memory;
    if (overlay !== null && overlay.player !== playerNow())
      replaceSeedOverlay({ ...overlay, player: playerNow() });
    followMemory(retryMemory);
    const { characterId } = host.chosen();
    if (characterId === null) {
      if (get().cast.memory !== null) {
        memoryFor = undefined;
        replaceSeedOverlay(null);
      }
      const { sheet, sheetStatus } = get().cast;
      if (sheetFor !== undefined || sheet !== null || sheetStatus !== "idle") {
        sheetFor?.controller.abort();
        sheetFor = undefined;
        patchCast({ sheet: null, sheetStatus: "idle" });
      }
      return false;
    }
    if (sheetFor?.epoch === get().epoch && sheetFor.characterId === characterId) return true;
    // Completion callbacks may seed card-only casting, but never retry their own failed sheet.
    if (!retryMemory && get().cast.sheetStatus === "failed") return false;
    const loading = loadSheet(characterId).finally(() => {
      if (sheetLoading === loading) sheetLoading = undefined;
    });
    sheetLoading = loading;
    if (deps.memory !== undefined) void loading.then(seedGreeting);
    return false;
  }

  const actions: CastSliceState = {
    cast: EMPTY_CAST,
    receiveCastMemory: receiveMemory,

    correctCast: (entryId, patch) => {
      // Within the register's bounds, so the next request stays valid; a blank name is refused.
      const clamped = clampCastCorrection(patch);
      if (clamped === null) return;
      const entry = sheetedAt(get(), get().messages.length).entries.find(
        (entry) => entry.id === entryId,
      );
      if (entry !== undefined) affirm([entry]);
      correct((cast) => {
        const version = cast.correctionVersion + 1;
        const old = cast.corrections[entryId] ?? NO_CORRECTION;
        const state: StateCorrections = { ...old.state };
        for (const [field, value] of Object.entries(clamped.state ?? {})) {
          Object.assign(state, { [field]: { value, version } });
        }
        return {
          corrections: withCorrection(cast.corrections, entryId, {
            ...old,
            anchor: { ...old.anchor, ...clamped.anchor },
            state,
          }),
          correctionVersion: version,
        };
      });
    },

    revertCast: (entryId, field) =>
      correct((cast) => {
        const old = cast.corrections[entryId];
        if (old === undefined) return {};
        const { [field as keyof CastAnchor]: _anchor, ...anchor } = old.anchor;
        const { [field as keyof CastState]: _state, ...state } = old.state;
        return {
          corrections: withCorrection(cast.corrections, entryId, { ...old, anchor, state }),
        };
      }),

    removeCast: (entryId) =>
      correct((cast) => ({
        corrections: withCorrection(cast.corrections, entryId, {
          ...(cast.corrections[entryId] ?? NO_CORRECTION),
          removed: true,
        }),
      })),

    restoreCast: (entryId) =>
      correct((cast) => {
        const old = cast.corrections[entryId];
        if (old === undefined) return {};
        const { removed: _removed, ...rest } = old;
        return { corrections: withCorrection(cast.corrections, entryId, rest) };
      }),

    retryCast: () => {
      followMemory();
      const sheetFailed = get().cast.sheetStatus === "failed";
      const newest = newestKeeperTarget(get().messages);
      if (newest === undefined || !keeperTargetUncovered(get())) {
        if (sheetFailed) follow();
        return;
      }
      // Join existing authority, including a reserved sheet wait or queued newest target.
      // Reloading canon alone must not discard valid paid work or its completed prefix.
      const authorized = [queued, replacement, pending, running].find(
        (start) => start !== undefined && startValid(start) && matches(start, newest),
      );
      if (authorized !== undefined) {
        if (sheetFailed) reloadFor(authorized);
        if (runningValid?.() === false) handoffContext();
        return;
      }
      keep(newest.id, { reloadSheet: sheetFailed });
    },

    castModelReady: () => {
      if (get().cast.sheetStatus !== "waiting") return;
      // As a chat start does: the sheet is asked for, and the greeting seeds once it lands.
      if (follow()) seedGreeting();
    },
  };

  const cancelKeep = (preserveFailure = false) => {
    pending = undefined;
    replacement = undefined;
    queued = undefined;
    continuation = undefined;
    runningValid = undefined;
    calling?.abort();
    calling = undefined;
    running = undefined;
    patchCast((cast) => ({
      activeCall: null,
      status: preserveFailure && cast.status === "failed" ? "failed" : "idle",
    }));
  };

  /** Takes these replies' snapshots out, returning them (for a deletion's Undo). */
  const take = (replyIds: readonly string[], invalidate = false): CastTaken => {
    cancelKeep();
    const { snapshots } = get().cast;
    const held: CastTaken["recovery"] = {};
    for (const id of replyIds) {
      const snapshot = snapshots[id];
      if (invalidate) {
        if (snapshot !== undefined)
          recovery.set(
            id,
            snapshot.register.entries.map((entry) => entry.id),
          );
      } else {
        const ids = recovery.get(id);
        held[id] = ids;
        recovery.delete(id);
      }
    }
    const taken = Object.fromEntries(
      replyIds.flatMap((id) => {
        const snapshot = snapshots[id];
        return snapshot === undefined ? [] : [[id, snapshot]];
      }),
    );
    if (Object.keys(taken).length > 0) {
      patchCast((cast) => ({
        snapshots: Object.fromEntries(
          Object.entries(cast.snapshots).filter(([id]) => !(id in taken)),
        ),
      }));
    }
    return { snapshots: taken, recovery: held };
  };

  return {
    actions,
    /** A reply ended complete: the keeper reads it. */
    replied: (messageId: string) => void keep(messageId),
    seedGreeting,
    /**
     * A chat's greeting was set: the character's sheet is asked for once per
     * chat and character; a refill of the same chat's greeting seeds again.
     */
    started: () => {
      if (follow()) seedGreeting();
    },
    follow,
    ready,
    take,
    /** A changed source invalidates every dependent branch, retaining only shown identities. */
    invalidateFrom: (index: number, deleting = false): CastTaken => {
      const messages = get().messages.slice(index);
      const taken = take(
        messages.flatMap((message) =>
          isAssistant(message) ? message.replies.map((reply) => reply.id) : [],
        ),
      );
      for (const [at, message] of messages.entries()) {
        if (!isAssistant(message) || (deleting && at === 0)) continue;
        const id = shownReply(message).id;
        const snapshot = taken.snapshots[id];
        const ids = snapshot?.register.entries.map((entry) => entry.id) ?? taken.recovery[id];
        if (ids !== undefined) recovery.set(id, ids);
      }
      return taken;
    },
    /** Puts snapshots back (Undo of a deletion). */
    restore: (taken: CastTaken | undefined) => {
      cancelKeep();
      if (taken === undefined) return;
      for (const [id, ids] of Object.entries(taken.recovery)) {
        if (ids === undefined) recovery.delete(id);
        else recovery.set(id, ids);
      }
      const { snapshots } = taken;
      if (Object.keys(snapshots).length === 0) return;
      // Undo restores chat identities, while seed-only people come from today's overlay.
      const seedOnly = new Set([...seedIds.values()].filter((id) => !established.has(id)));
      const restored = Object.fromEntries(
        Object.entries(snapshots).map(([id, snapshot]) => [
          id,
          {
            ...snapshot,
            register: {
              entries: snapshot.register.entries.filter((entry) => !seedOnly.has(entry.id)),
            },
          },
        ]),
      );
      patchCast((cast) => ({ snapshots: { ...cast.snapshots, ...restored } }));
    },
    /** Clear: the call and the sheet wait end, and the chat's identities go; the store empties `cast`. */
    reset: () => {
      known.clear();
      recovery.clear();
      established.clear();
      seedIds.clear();
      failedStarts.clear();
      memoryFor = undefined;
      memoryLoading = undefined;
      sheetLoading = undefined;
      pending = undefined;
      replacement = undefined;
      queued = undefined;
      continuation = undefined;
      runningValid = undefined;
      calling?.abort();
      calling = undefined;
      running = undefined;
      sheetFor?.controller.abort();
      sheetFor = undefined;
    },
  };
}
