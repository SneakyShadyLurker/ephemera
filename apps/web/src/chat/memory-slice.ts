import {
  type CallPurpose,
  type ChatMemoryState,
  type ChatTurn,
  estimateTokens,
  eventsAfterFold,
  lorebookStateAfterFold,
  MAX_CHAT_BODY_BYTES,
  MAX_CHAT_TURNS,
  MEMORY_GREETING,
  MEMORY_LIMITS,
  memoryModelOf,
  type RememberRequest,
} from "@ephemera/core";
import type { StoreApi } from "zustand/vanilla";
import type { RememberOutcome } from "../memory/queries.ts";
import { memoryContextAt } from "./cast-slice.ts";
import {
  ENDING_LEAST,
  editHolds,
  latestMemory,
  NO_MEMORY,
  rememberedEnd,
  spanToRemember,
  TRANSIENT_FAILURES,
} from "./memory-span.ts";
import { isUser, sentMessages, shownTurns } from "./messages.ts";
import { shownReply } from "./shown-reply.ts";
import type {
  ChatMemory,
  ChatState,
  HeldSpan,
  MemoryDeps,
  RememberRun,
  Selection,
} from "./store.ts";
import { type UsageHandle, unknownEnd } from "./usage.ts";

/*
 * The chat's memory (PRINCIPLES.md 1): the calls that remember a span of the
 * chat and forget a memory, the remembered spans requests still send, and
 * the fold that leaves the oldest of them out once a request no longer fits.
 * Which turns are held or folded is chat content, in tab memory only; the
 * server keeps what the memories say. A Clear or a reset aborts the call on
 * its way, and an answer for an older epoch is dropped.
 */

/** What the chat store lends the slice. */
interface MemoryHost {
  /** What the saved settings choose now. */
  selection: () => Selection;
  /** The store's subscription, to wait for a change of the chat. */
  subscribe: StoreApi<ChatState>["subscribe"];
  trackUsage: (
    purpose: CallPurpose,
    model: string,
    generation: string | null,
    id?: string,
  ) => UsageHandle;
}

type MemoryActions = Pick<
  ChatState,
  "rememberNow" | "rememberEnding" | "forgetLatest" | "episodeGone" | "memoryReset" | "showFolded"
>;

export function createMemorySlice(
  set: StoreApi<ChatState>["setState"],
  get: StoreApi<ChatState>["getState"],
  deps: MemoryDeps | undefined,
  host: MemoryHost,
) {
  const { selection } = host;
  /** The memory call running, apart from generations: Stop leaves it, Clear aborts it. */
  let remembering: AbortController | undefined;
  /** That call's run until the chat took its answer: remembering the ending waits for it. */
  let rememberRun: Promise<RememberRun> | undefined;
  /** The Forget running, by a token only it holds; nothing is remembered meanwhile. */
  let forgetting: object | null = null;
  /** That Forget's call until it answered: remembering the ending waits for it. */
  let forgetRun: Promise<unknown> | undefined;
  /**
   * The last automatic memory call was held by an open edit in its span: once
   * that edit closes or another opens, it is asked for again.
   */
  let heldForEdit = false;
  let heldMemoryGeneration: string | null = null;

  /** Resolves once `done` holds, checked now and on every change of the state. */
  const until = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      if (done()) return resolve();
      const stop = host.subscribe(() => {
        if (!done()) return;
        stop();
        resolve();
      });
    });

  /** Memory is on for the character a request goes with. */
  const memoryOn = (characterId: string | null): characterId is string =>
    characterId !== null && deps?.enabled(characterId) === true;

  /** The history turns a held span covers, as a request sends them. */
  const spanTurns = (span: HeldSpan) =>
    sentMessages(get().messages.slice(span.from, span.to)).length;

  /**
   * The memory a request carries while memory is on, nothing otherwise:
   * this chat's folded episodes, how many turns they fold, and the held
   * spans whose turns lead the request's history.
   */
  const recapFor = (chosen: Selection): ChatMemoryState | null => {
    if (!memoryOn(chosen.characterId)) return null;
    const { messages, memory } = get();
    const { recap, held } = memory;
    const folded = sentMessages(messages.slice(0, memory.horizon));
    const [first] = messages;
    return {
      recap,
      folded: folded.length,
      // Sent even at zero: it tells the server this tab carries timing inside folded turns.
      foldedUsers: folded.filter(isUser).length,
      held: held.map((span) => ({ id: span.id, turns: spanTurns(span) })),
      // The chat opens on the memory's opening, edited or not: the day after the last ended.
      continued:
        first?.role === "assistant" &&
        first.greeting &&
        shownReply(first).greetingKey === MEMORY_GREETING,
    };
  };

  /**
   * The history turns between two horizons, oldest first, by role, and their
   * count: positive when `to` folds more, negative when it unfolds.
   */
  const crossed = (from: number, to: number) => {
    const { messages } = get();
    const roles = sentMessages(messages.slice(Math.min(from, to), Math.max(from, to))).map(
      (message) => message.role,
    );
    return { count: from <= to ? roles.length : -roles.length, roles };
  };

  /**
   * Moves the horizon to `to`, with the rest of `memory`: the timed lorebook
   * state and the events state move with the history, as deleting (or
   * putting back) the turns would; an Undo saved before is no longer
   * right, and an edit of a message now read-only closes.
   */
  const moveHorizon = (to: number, memory: Partial<ChatMemory>) => {
    const { count, roles } = crossed(get().memory.horizon, to);
    set((state) => {
      const next = { ...state.memory, ...memory, horizon: to };
      const editing =
        state.editing === null
          ? null
          : state.messages.findIndex((message) => message.id === state.editing?.id);
      return {
        memory: next,
        lorebookState: lorebookStateAfterFold(state.lorebookState, count),
        eventsState: eventsAfterFold(state.eventsState, count, roles),
        ...(count !== 0 && state.deleted?.kind === "messages" ? { deleted: null } : {}),
        ...(editing !== null && editing < to ? { editing: null } : {}),
      };
    });
  };

  /**
   * Folds the oldest `count` held spans: the horizon moves to where the
   * last of them ends and their memories join the recap, the newest of
   * them now the latest folded one.
   */
  const applyFold = (count: number) => {
    const { held, recap } = get().memory;
    const folding = held.slice(0, count);
    const last = folding.at(-1);
    if (last === undefined) return;
    moveHorizon(last.to, {
      held: held.slice(count),
      recap: [...recap, ...folding.map((span) => span.id)],
      foldedLatest: { id: last.id, title: last.title, from: last.from },
    });
  };

  /**
   * The request `build` makes, within the server's bounds: while it would
   * carry more turns than `MAX_CHAT_TURNS` or more bytes than
   * `MAX_CHAT_BODY_BYTES`, or the chat holds more than
   * `MEMORY_LIMITS.held` memories, the oldest held span folds here, as the
   * server would fold it, and the request is built again. Without a held
   * memory it goes as it is, for the server to refuse.
   */
  const withinLimits = <T extends { messages: ChatTurn[] }>(build: () => T): T => {
    const encoder = new TextEncoder();
    for (;;) {
      const request = build();
      const { held } = get().memory;
      if (held.length === 0) return request;
      const fits =
        held.length <= MEMORY_LIMITS.held &&
        request.messages.length <= MAX_CHAT_TURNS &&
        encoder.encode(JSON.stringify(request)).length <= MAX_CHAT_BODY_BYTES;
      if (fits) return request;
      applyFold(1);
    }
  };

  /**
   * One memory call over the unremembered turns but the newest `keep`
   * (Settings' `keepTurns` by default), at least `least` turns: `force`
   * (Remember now, the ending) whatever their size, otherwise once they
   * reach the span. A call whose answer was lost goes again with its
   * attempt and span. An open edit in the span holds the call before
   * anything locks or goes out. On success for this chat the span is held:
   * its turns are still sent until a request folds them.
   */
  const rememberSpan = async (
    force: boolean,
    keep?: number,
    least = 2,
    generation: string | null = null,
  ): Promise<RememberRun> => {
    const nothing: RememberRun = { status: "none" };
    // An automatic call is held only by the edit open when it was last asked for.
    if (!force) {
      heldForEdit = false;
      heldMemoryGeneration = null;
    }
    const memoryDeps = deps;
    const chosen = selection();
    const { characterId, personaId } = chosen;
    if (memoryDeps === undefined || !memoryOn(characterId)) {
      return { status: "failed", reason: "memory_off" };
    }
    let { memory } = get();
    const { messages, epoch } = get();
    if (forgetting !== null || memory.status === "remembering") return { status: "busy" };
    // A lost answer's attempt holds only for its span: once the remembered end or the messages
    // moved, a new one is drawn.
    const stale = memory.pending;
    if (
      stale !== null &&
      (rememberedEnd(memory) !== stale.from || stale.boundary > messages.length)
    ) {
      memory = { ...memory, status: "idle", boundary: null, pending: null };
      set({ memory });
    }
    // A lost answer and a transient refusal are asked for again with the next reply; another refusal waits for Try again.
    if (
      !force &&
      memory.status === "failed" &&
      memory.pending === null &&
      (memory.failure === null || !TRANSIENT_FAILURES.has(memory.failure))
    )
      return nothing;
    const settings = memoryDeps.settings();
    const model = memoryModelOf({ memoryModel: settings.memoryModel, model: chosen.model });
    if (model === null) return { status: "failed", reason: "no_model" };
    const {
      from,
      to: boundary,
      again,
    } = spanToRemember({ memory, messages }, keep ?? settings.keepTurns);
    if (boundary <= from) return nothing;
    const turns = shownTurns(messages.slice(from, boundary));
    // A lost attempt goes again over its own span, one turn if an ending's was.
    if (turns.length < (again === null ? least : 1)) return nothing;
    const size = estimateTokens(turns.map((turn) => turn.content).join("\n\n"));
    if (!force && again === null && size < settings.spanTokens) return nothing;
    // The span would go as it was and lock the edit's message: an automatic call is asked for
    // again once that edit closes (saved, cancelled, deleted or ended) or another opens.
    if (editHolds(get(), { from, to: boundary })) {
      if (!force) {
        heldForEdit = true;
        heldMemoryGeneration = generation;
      }
      return { status: "editing" };
    }
    const run = callMemory(
      memoryDeps,
      memory,
      { characterId, personaId, model, settings },
      {
        epoch,
        from,
        boundary,
        turns,
        attempt: again?.attempt ?? crypto.randomUUID(),
        generation,
      },
    );
    rememberRun = run;
    void run.finally(() => {
      if (rememberRun === run) rememberRun = undefined;
    });
    return run;
  };

  /** The memory call `rememberSpan` decided on, its answer taken for this chat. */
  const callMemory = async (
    memoryDeps: MemoryDeps,
    memory: ChatMemory,
    chosen: {
      characterId: string;
      personaId: string | null;
      model: string;
      settings: ReturnType<MemoryDeps["settings"]>;
    },
    call: {
      epoch: number;
      from: number;
      boundary: number;
      turns: ChatTurn[];
      attempt: string;
      generation: string | null;
    },
  ): Promise<RememberRun> => {
    const { characterId, personaId, model, settings } = chosen;
    const { epoch, from, boundary, turns, attempt } = call;
    const controller = new AbortController();
    remembering = controller;
    set({
      memory: {
        ...memory,
        status: "remembering",
        boundary,
        pending: { attempt, boundary, from },
      },
    });
    const castContext = memoryContextAt(get(), boundary);
    const request: RememberRequest = {
      characterId,
      ...(personaId === null ? {} : { personaId }),
      model,
      ...(settings.reasoning === null ? {} : { reasoning: settings.reasoning }),
      turns,
      ...(castContext === undefined ? {} : { castContext }),
      episodes: memory.recap,
      held: memory.held.map((span) => span.id),
      attempt,
    };
    let outcome: RememberOutcome;
    const accounting = host.trackUsage("memory.remember", model, call.generation, attempt);
    let received = false;
    try {
      outcome = await memoryDeps.remember(request, controller.signal, (receipt) => {
        received = true;
        accounting.receive(receipt);
      });
    } catch {
      outcome = { ok: false, reason: "unreachable", lost: true };
    }
    accounting.finish(
      unknownEnd(outcome, {
        received,
        aborted: controller.signal.aborted,
        failed: "memory_failed",
      }),
    );
    if (remembering === controller) remembering = undefined;
    // Cleared, reset or another character meanwhile: the server's write stands, this chat moves on.
    if (controller.signal.aborted || get().epoch !== epoch) return { status: "cancelled" };
    if (rememberedEnd(get().memory) !== from) {
      // The memory before it was deleted meanwhile: this span no longer starts where the
      // remembered turns end, so nothing is held. (A request folding held spans meanwhile
      // moves the horizon, never the remembered end.)
      set((state) => ({
        memory: { ...state.memory, status: "idle", boundary: null, pending: null },
      }));
      return { status: "moved" };
    }
    if (!outcome.ok) {
      set((state) => ({
        memory: {
          ...state.memory,
          status: "failed",
          failure: outcome.reason,
          pending: outcome.lost ? { attempt, boundary, from } : null,
        },
      }));
      if (outcome.reason === "memory_off") memoryDeps.changed?.(characterId);
      return { status: "failed", reason: outcome.reason };
    }
    const { episode, recap, notebook } = outcome.response;
    // No edit is open in the span: none was when the call went out (`editHolds`), and the span
    // has been read-only since.
    set((state) => ({
      memory: {
        ...state.memory,
        held: [...state.memory.held, { id: episode.id, title: episode.title, from, to: boundary }],
        // The answer's recap is the one the call sent, as the server has it now; memories a
        // request folded meanwhile were held then, newer than all of it, so they follow it.
        recap: [
          ...recap,
          ...state.memory.recap.filter((id) => !memory.recap.includes(id) && !recap.includes(id)),
        ],
        boundary: null,
        status: "idle",
        pending: null,
      },
    }));
    get().schedulePreview();
    memoryDeps.changed?.(characterId, notebook);
    return { status: "written" };
  };

  /**
   * The automatic call an edit held is asked for again, unless a reply is
   * streaming: once it settles, it asks.
   */
  const releaseHeld = () => {
    if (!heldForEdit || get().generating) return;
    void rememberSpan(false, undefined, 2, heldMemoryGeneration);
  };

  const actions: MemoryActions = {
    rememberNow: async () => {
      await rememberSpan(true);
    },

    rememberEnding: async () => {
      const { epoch } = get();
      const moved = () => get().epoch !== epoch;
      for (;;) {
        // An open edit among the ending's turns holds it whole, before anything is written or
        // waited for: the chat stays as it is until the edit is saved or cancelled.
        const state = get();
        if (editHolds(state, { from: rememberedEnd(state.memory), to: state.messages.length })) {
          return { status: "editing" };
        }
        // A reply still streaming settles first, whole; then a memory call or a Forget under
        // way answers. Each may start the next (a settled reply starts a call), so all of
        // them are checked again after any wait.
        if (get().generating) {
          await until(() => !get().generating || moved());
        } else if (rememberRun !== undefined) {
          await rememberRun;
        } else if (forgetRun !== undefined) {
          await forgetRun;
        }
        if (moved()) return { status: "cancelled" };
        if (get().generating || rememberRun !== undefined || forgetRun !== undefined) continue;
        // Newest turns included, and a single one is enough: nothing of the ending is left out.
        const run = await rememberSpan(true, 0, ENDING_LEAST);
        switch (run.status) {
          case "written":
          case "busy":
          case "moved":
            // Written: a lost answer's span may have been all it took, so the rest goes next.
            continue;
          case "none":
            return { status: "done" };
          case "editing":
            return { status: "editing" };
          case "cancelled":
            return { status: "cancelled" };
          case "failed":
            // A lost answer keeps its span read-only, with its attempt, for the next call.
            return { status: "failed", reason: run.reason };
        }
      }
    },

    forgetLatest: async () => {
      const memoryDeps = deps;
      const { epoch, memory } = get();
      const latest = latestMemory(memory);
      const end = rememberedEnd(memory);
      // A memory being written, or one whose answer was lost, starts where the latest ends.
      if (memoryDeps === undefined || latest === null || memory.pending !== null) return;
      if (forgetting !== null) return;
      const token = {};
      forgetting = token;
      let forgot: boolean;
      const call = memoryDeps.forget(latest.id);
      forgetRun = call;
      try {
        forgot = await call;
      } catch {
        forgot = false;
      } finally {
        if (forgetting === token) forgetting = null;
        if (forgetRun === call) forgetRun = undefined;
      }
      // Only for the chat, the memory and the remembered turns it was asked for. A request
      // folding it meanwhile leaves both as they were: it unfolds instead of being freed.
      const now = get();
      if (!forgot || now.epoch !== epoch) return;
      if (latestMemory(now.memory)?.id !== latest.id || rememberedEnd(now.memory) !== end) return;
      get().episodeGone(latest.id);
      const { characterId } = selection();
      if (characterId !== null) memoryDeps.changed?.(characterId);
    },

    episodeGone: (id) => {
      const { memory } = get();
      const { held, foldedLatest } = memory;
      const at = held.findIndex((span) => span.id === id);
      const recap = memory.recap.filter((other) => other !== id);
      // The remembered end moves back: a lost answer's attempt was for the chat as it was, so
      // it is dropped; the call running keeps its span until it answers.
      const dropped: Partial<ChatMemory> =
        memory.pending === null || memory.status === "remembering"
          ? {}
          : { status: "idle", boundary: null, pending: null };
      if (at !== -1 && at === held.length - 1) {
        // The latest memory, held: its turns are no longer remembered, and the next memory
        // call takes them again.
        set({ memory: { ...memory, held: held.slice(0, -1), ...dropped } });
      } else if (at !== -1) {
        // An older held one: its turns join the next held span, so nothing is remembered
        // twice, and the story goes without that memory, as without a deleted folded one.
        const next = held[at + 1];
        if (next === undefined) return;
        set({
          memory: {
            ...memory,
            held: held.toSpliced(at, 2, { ...next, from: held[at]?.from ?? next.from }),
          },
        });
      } else if (foldedLatest?.id === id && held.length === 0) {
        // The latest memory, folded: the horizon moves back and its turns unfold.
        moveHorizon(foldedLatest.from, { recap, foldedLatest: null, ...dropped });
      } else if (memory.recap.includes(id) || foldedLatest?.id === id) {
        // An older folded episode leaves the recap; the horizon stays, and so does a pending
        // attempt. Behind held memories, the newest folded one is no longer Forget's to unfold.
        set({
          memory: {
            ...memory,
            recap,
            ...(foldedLatest?.id === id ? { foldedLatest: null } : {}),
          },
        });
      } else {
        return;
      }
      get().schedulePreview();
    },

    memoryReset: () => {
      remembering?.abort();
      remembering = undefined;
      forgetting = null;
      const { horizon, held, boundary, recap, foldedLatest, status, pending } = get().memory;
      const empty =
        horizon === 0 &&
        held.length === 0 &&
        boundary === null &&
        recap.length === 0 &&
        foldedLatest === null &&
        pending === null;
      if (empty && status === "idle") return;
      moveHorizon(0, NO_MEMORY);
      get().schedulePreview();
    },

    showFolded: (shown) => set((state) => ({ memory: { ...state.memory, shown } })),
  };

  return {
    actions,
    recapFor,
    withinLimits,
    applyFold,
    crossed,
    rememberSpan,
    releaseHeld,
    /** The last automatic memory call is held by an open edit in its span. */
    heldForEdit: () => heldForEdit,
    /** Clear: the call and the Forget on their way end; the store empties `memory`. */
    reset: () => {
      // A memory call of the old chat is aborted; the server's write, if any, stands.
      remembering?.abort();
      remembering = undefined;
      forgetting = null;
      heldForEdit = false;
      heldMemoryGeneration = null;
    },
  };
}
