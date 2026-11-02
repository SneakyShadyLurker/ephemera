import {
  applyMemoryAnswer,
  bookStory,
  type CallAccounting,
  chapterAnswerSchema,
  chapterCorrection,
  chapterInstructions,
  chapterMessage,
  chapterOutputSchema,
  chapterRoom,
  type characterMemorySchema,
  clampChapterOutput,
  clampMemoryAnswer,
  clampOpeningAnswer,
  episodePatchRequestSchema,
  fitChapterMembers,
  MAX_CHAT_BODY_BYTES,
  MEMORY_LIMITS,
  type MemoryRefusal,
  type MemoryState,
  memberTurns,
  memoryAnswerSchema,
  memoryCanon,
  memoryIsOn,
  memoryStateOf,
  memoryStatePatchRequestSchema,
  NO_PERSONA_NAME,
  notebookHasContent,
  notebookRoom,
  type OpeningRefusal,
  type OpeningRequest,
  type OpeningResponse,
  openingAnswerSchema,
  openingInstructions,
  openingMessage,
  openingRequestSchema,
  previousEpisodes,
  RECAP_IDS,
  type RememberRequest,
  type RememberResponse,
  recapAfter,
  recapBudget,
  reconcileRecap,
  rememberInstructions,
  rememberMessage,
  rememberRequestSchema,
  rollupMembers,
  type SpeakerNames,
  type StoredEpisode,
  storyBefore,
  summaryWords,
  transcriptLines,
  unnamedAnswer,
  userNameForms,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { z } from "zod";
import type { Catalog } from "./catalog.ts";
import { boundedBody, requestLifetime, untilAborted } from "./lifetime.ts";
import { errorClass, type Logger } from "./log.ts";
import { type ObjectCallTarget, objectCaller, objectCallTarget, roomFor } from "./object-call.ts";
import type { UserInstance } from "./persistence/store.ts";
import { chosenPersona } from "./personas.ts";
import {
  answerUpdate,
  idParam,
  invalid,
  jsonLimit,
  MAX_JSON_BYTES,
  notFound,
  type RefusalStatuses,
  refusedBeforeCall,
  removed,
} from "./routes.ts";
import { type StreamContext, streamedResponse, streamSignal } from "./streams.ts";
import { countText } from "./tokens.ts";
import { type Upstream, waitOf } from "./upstream.ts";
import { callRecorder } from "./usage.ts";
import type { UserEnv } from "./user.ts";

/*
 * A character's memory (PRINCIPLES.md 1): the notebook and episodes are
 * character data, read and edited here. The span a memory call reads, its
 * transcript and the model's raw answer are chat content: they live in this
 * request's memory only and are never written, kept or logged. Only the
 * validated memory (title, summary, cues, notebook) is written. An opening
 * call writes nothing: its answer goes back to the owner, whose field saves it.
 */

/** Answers kept per instance for repeated attempts: a retry after a lost answer gets the same memory. */
export const KEPT_ATTEMPTS = 16;

export interface MemoryDeps {
  log: Logger;
  /** The model catalog: the call's context window and the efforts the model offers. */
  catalog: Pick<Catalog, "current">;
  /** The configured upstream's chat models (api.ts). */
  upstream: Upstream;
  /** The remember request's lifetime: chat's. */
  requestTimeoutMs: number;
  onStreamingRequest?: (request: Request) => void;
}

/** Why a remember request got no memory: a refusal its body names, or the request ended. */
type Refusal = MemoryRefusal | "aborted";

/** A refusal, with a busy provider's wait when it said. */
type Refused = { ok: false; error: Refusal; retryAfterS?: number };

/** Why an opening request got no opening: a refusal its body names, or the request ended. */
type OpeningRefused = {
  ok: false;
  error: OpeningRefusal | "aborted";
  retryAfterS?: number;
  accounting?: CallAccounting;
};

/**
 * What an attempt keeps: the memory it wrote and the chapter, character data
 * only, with the character. The chat's recap is built for each answer from
 * that request's own episodes, so no chat's ids outlive their request.
 */
interface Written {
  characterId: string;
  episode: StoredEpisode;
  notebook: MemoryState;
  chapter?: StoredEpisode;
  /** The chapter merged the book's story before the chat, so it is not the chat's. */
  book?: true;
}

type Outcome = ({ ok: true; written: Written } | Refused) & { accounting?: CallAccounting };

/** An attempt's answer, and while its call runs, the requests waiting on it. */
interface Attempt {
  outcome: Promise<Outcome>;
  settled: boolean;
  waiting: number;
  /** Ends the call once no request waits on it any more. */
  call: AbortController;
}

/** Answers kept by attempt id, per instance; they live and die with it. */
const attempts = new WeakMap<UserInstance, Map<string, Attempt>>();

/**
 * Counts the request `signal` ends with as waiting on the attempt's call. A
 * request that ends (its deadline, or its client gone) stops waiting; the
 * call ends only once none waits, so a repeat is not cut off with the
 * request that started it.
 */
function waitOn(entry: Attempt, signal: AbortSignal) {
  if (entry.settled) return;
  entry.waiting += 1;
  const gone = () => {
    entry.waiting -= 1;
    if (entry.waiting === 0 && !entry.settled) entry.call.abort();
  };
  if (signal.aborted) return gone();
  signal.addEventListener("abort", gone, { once: true });
  void entry.outcome.then(() => signal.removeEventListener("abort", gone));
}

/**
 * The outcome of an attempt: the one already running or kept, or `run`'s,
 * which runs until no request waits on it. A refused attempt is dropped once
 * it settles, so a retry calls again; at most `KEPT_ATTEMPTS` settled ones
 * are kept, the oldest evicted first, and a running one is never evicted.
 */
function attemptOnce(
  user: UserInstance,
  attempt: string,
  run: (signal: AbortSignal) => Promise<Outcome>,
  signal: AbortSignal,
) {
  let kept = attempts.get(user);
  if (kept === undefined) {
    kept = new Map();
    attempts.set(user, kept);
  }
  const known = kept.get(attempt);
  if (known !== undefined) {
    waitOn(known, signal);
    return known.outcome;
  }
  const map = kept;
  const evict = () => {
    for (const [id, entry] of map) {
      if (map.size <= KEPT_ATTEMPTS) break;
      if (entry.settled) map.delete(id);
    }
  };
  const call = new AbortController();
  const entry: Attempt = { outcome: run(call.signal), settled: false, waiting: 0, call };
  map.set(attempt, entry);
  evict();
  waitOn(entry, signal);
  void entry.outcome.then((settled) => {
    entry.settled = true;
    if (!settled.ok && map.get(attempt) === entry) map.delete(attempt);
    evict();
  });
  return entry.outcome;
}

/** An attempt already running or kept, without starting one; the request `signal` ends with waits on it. */
function joinAttempt(user: UserInstance, attempt: string, signal: AbortSignal) {
  const entry = attempts.get(user)?.get(attempt);
  if (entry !== undefined) waitOn(entry, signal);
  return entry?.outcome;
}

/** Drops a kept attempt whose memory no longer stands, so a retry calls again. */
function dropAttempt(user: UserInstance, attempt: string, outcome: Promise<Outcome>) {
  const kept = attempts.get(user);
  if (kept?.get(attempt)?.outcome === outcome) kept.delete(attempt);
}

/**
 * The tail of each character's queue of memory calls, per instance: a call
 * reads the notebook only once the one before it wrote, so one rewrite
 * never overwrites another. Operational state, no content.
 */
const queues = new WeakMap<UserInstance, Map<string, Promise<unknown>>>();

/**
 * A place in the character's queue: `ready` settles once every earlier call
 * for it finished, and `leave` lets the next one in once this one did.
 */
function queueFor(user: UserInstance, characterId: string) {
  let tails = queues.get(user);
  if (tails === undefined) {
    tails = new Map();
    queues.set(user, tails);
  }
  const map = tails;
  const previous = map.get(characterId);
  const ready = previous ?? Promise.resolve();
  const left = Promise.withResolvers<void>();
  const tail = ready.then(() => left.promise);
  map.set(characterId, tail);
  void tail.then(() => {
    if (map.get(characterId) === tail) map.delete(characterId);
  });
  return { ready, waiting: previous !== undefined, leave: () => left.resolve() };
}

/** The status of each refusal before a remember call. */
const REMEMBER_STATUSES = {
  memory_off: 409,
  context_window_unknown: 409,
  prompt_too_long: 422,
  upstream_busy: 409,
  too_many_memories: 409,
  too_many_chat_memories: 409,
  memory_failed: 409,
} as const satisfies RefusalStatuses<MemoryRefusal>;

/** The status of each refusal before an opening call. */
const OPENING_STATUSES = {
  memory_off: 409,
  context_window_unknown: 409,
  prompt_too_long: 422,
  upstream_busy: 409,
  nothing_to_remember: 409,
  memory_failed: 409,
} as const satisfies RefusalStatuses<OpeningRefusal>;

/**
 * Writes a call's refusal into its streamed answer: the deadline as
 * `request_timeout`, a busy provider with its wait; the owner's switch and a
 * full book are logged.
 */
function writeRefusal(
  write: (text: string) => void,
  log: Logger,
  model: string,
  refused: { error: string; retryAfterS?: number | undefined },
  accounting?: CallAccounting,
) {
  const { error } = refused;
  if (error === "memory_off" || error === "too_many_memories") {
    log.warn({ event: "memory.refused", model, errorClass: error });
  }
  write(
    JSON.stringify({
      error: error === "aborted" ? "request_timeout" : error,
      ...waitOf(refused),
      ...(accounting === undefined ? {} : { accounting }),
    }),
  );
}

/** A memory call's canon, fitted to its target's window as the target's model counts. */
const canonFor = (
  call: ObjectCallTarget,
  input: Omit<Parameters<typeof memoryCanon>[0], "window" | "count">,
) => memoryCanon({ ...input, window: call.window, count: (text) => countText(text) * call.ratio });

/** Settles true once `ready` does, or false once `signal` aborts first. */
const awaitTurn = async (ready: Promise<unknown>, signal: AbortSignal) =>
  (await untilAborted(
    ready.then(() => true),
    signal,
  )) === true && !signal.aborted;

/**
 * How often each character's memory was forgotten or turned off, per
 * instance: a memory call that saw another count before it writes nothing.
 * Operational state, no content; it lives and dies with the instance.
 */
const generations = new WeakMap<UserInstance, Map<string, number>>();

const generationOf = (user: UserInstance, characterId: string) =>
  generations.get(user)?.get(characterId) ?? 0;

function advanceGeneration(user: UserInstance, characterId: string) {
  let counts = generations.get(user);
  if (counts === undefined) {
    counts = new Map();
    generations.set(user, counts);
  }
  counts.set(characterId, generationOf(user, characterId) + 1);
}

/** A character's memory as the screen reads it: the notebook row (null while it has none) and the book. */
const memoryView = (
  stores: UserInstance["stores"],
  characterId: string,
): z.output<typeof characterMemorySchema> => ({
  state: stores.memory.state(characterId) ?? null,
  episodes: stores.memory.list(characterId),
});

export function createMemoryApi(deps: MemoryDeps) {
  const { log, catalog, upstream } = deps;

  const objectCall = objectCaller({ log, upstream });

  /**
   * Spec § Automatic creation, step 1: every check that needs no model call.
   * Passed, it gives the model phase (steps 2 to 5) to run once per attempt.
   * `generation` is the character's as the request entered its queue.
   */
  async function prepare(
    request: RememberRequest,
    generation: number,
    signal: AbortSignal,
    user: UserInstance,
  ): Promise<{ ok: true; run: (signal: AbortSignal) => Promise<Outcome> } | Refused> {
    const { stores } = user;
    const { characterId, model } = request;
    const moved = () => generationOf(user, characterId) !== generation;
    // Forgotten or turned off while it waited its turn, even if on again since.
    if (moved()) return { ok: false, error: "memory_off" };
    // A character without a notebook row reads as on, an empty notebook at revision 0.
    const state = memoryStateOf(stores.memory.state(characterId) ?? null);
    const character = stores.characters.get(characterId)?.card;
    if (!memoryIsOn(state) || character === undefined) {
      return { ok: false, error: "memory_off" };
    }
    const settings = stores.settings.get();
    // Per character within this instance: its calls share instructions and canon.
    const target = await objectCallTarget(catalog, user, request, characterId, signal);
    if (!target.ok) return target;
    const { call } = target;
    const book = stores.memory.list(characterId);
    // This chat's folded episodes and the ones it holds, as the book has them now (the one
    // recap rule).
    const recap = reconcileRecap(request.episodes, book);
    const held = reconcileRecap(request.held, book);
    // A full book takes no memory, and a chat at its bound could not hold the new one.
    if (book.length >= MEMORY_LIMITS.episodes) return { ok: false, error: "too_many_memories" };
    if (recap.length + held.length >= RECAP_IDS) {
      return { ok: false, error: "too_many_chat_memories" };
    }

    const persona = chosenPersona(stores.personas, request.personaId);
    const names: SpeakerNames = { char: character.name, user: persona?.name ?? NO_PERSONA_NAME };
    // The calls read the story as it is; what they write calls the persona `{{user}}`.
    const userNames = userNameForms(names);
    // Canon: input for this request only, never stored, kept or logged.
    const linked = stores.lorebooks.booksOf(characterId);
    const canonOf = (turns: RememberRequest["turns"]) =>
      canonFor(call, {
        card: character,
        names,
        ...(persona === null ? {} : { persona: persona.description }),
        linked,
        turns,
      });
    const transcript = transcriptLines(request.turns, names);
    // A window too small for a full notebook tells the call the notebook's room.
    const notebookChars = notebookRoom(call.window);
    const instructions = rememberInstructions(names, {
      words: summaryWords(transcript),
      room: notebookChars,
    });
    const message = rememberMessage({
      canon: canonOf(request.turns),
      notebook: state.notebook,
      // The story just before the span: the held memories are its newest part.
      previous: previousEpisodes([...recap, ...held], book),
      transcript,
      ...(request.castContext === undefined ? {} : { castContext: request.castContext }),
      room: notebookChars,
    });
    const room = roomFor(call, [instructions, message]);
    if (room === null) {
      log.warn({ event: "memory.remember", model, errorClass: "prompt_too_long" });
      return { ok: false, error: "prompt_too_long" };
    }

    // The model phase runs on the attempt's signal, not this request's (attemptOnce).
    const recorder = callRecorder();
    let committed: Extract<Outcome, { ok: true }> | undefined;
    const work = async (signal: AbortSignal): Promise<Outcome> => {
      const written = await objectCall(call, {
        event: "memory.remember",
        recorder,
        instructions,
        message,
        room,
        schema: memoryAnswerSchema,
        clamp: clampMemoryAnswer,
        failure: "memory_failed",
        signal,
      });
      if (!written.ok) return written;
      // Forgotten or turned off during the call, even if on again since: nothing is written.
      if (moved()) return { ok: false, error: "memory_off" };
      const stored = stores.memory.remember(characterId, {
        // The edits apply to the notebook the message showed; the store keeps an owner's
        // edit made since instead.
        output: applyMemoryAnswer(
          state.notebook,
          unnamedAnswer(written.value, userNames, memoryAnswerSchema, clampMemoryAnswer),
        ),
        turns: request.turns.length,
        notebookRevision: state.revision,
      });
      if (stored === "off" || stored === "missing") return { ok: false, error: "memory_off" };
      if (stored === "full") return { ok: false, error: "too_many_memories" };
      const { episode, notebook } = stored;
      const unrolled: Outcome = {
        ok: true,
        written: { characterId, episode, notebook },
      };
      // Optional roll-up must never make a committed episode retryable.
      committed = unrolled;

      // Roll-up: the folded recap past its weight or its count merges its oldest half into a
      // chapter. Held memories, the new one among them, are never members: their turns are
      // still in the history, and a fold brings them into the recap first. Else the book's
      // story before this chat, past the same weight or count, merges its oldest half, so
      // the story every later chat is told keeps fitting, its oldest part ever more condensed.
      const budget = recapBudget(call.window, notebook.notebook, settings.memoryRecapTokens);
      const chatMembers = rollupMembers(recap, budget);
      const own = new Set([
        episode.id,
        ...request.held,
        ...[...recap, ...held].map(({ id }) => id),
      ]);
      const ofBook = chatMembers.length === 0;
      const members = ofBook
        ? rollupMembers(bookStory(stores.memory.list(characterId), own), budget)
        : chatMembers;
      if (members.length === 0) return unrolled;
      // The chapter's summary takes its share of the recap it lives in.
      const summaryRoom = chapterRoom(budget);
      const chapterSystem = chapterInstructions(names, summaryRoom);
      // Too much to merge in this window (a long book's oldest half): the oldest part that fits.
      const fitted = fitChapterMembers(
        members,
        (merged) =>
          chapterMessage({
            canon: canonOf(memberTurns(merged, names.user)),
            notebook: notebook.notebook,
            members: merged,
          }),
        (chapterInput) => roomFor(call, [chapterSystem, chapterInput]),
      );
      if (fitted === null) {
        log.warn({ event: "memory.chapter", model, errorClass: "prompt_too_long" });
        return unrolled;
      }
      const chapter = await objectCall(call, {
        event: "memory.chapter",
        recorder,
        instructions: chapterSystem,
        message: fitted.input,
        room: fitted.room,
        schema: chapterAnswerSchema,
        // Title and cues within bounds; a summary past its room is asked to compress, not cut.
        clamp: (value) => clampChapterOutput(value, Number.POSITIVE_INFINITY),
        correct: ({ summary }) => chapterCorrection(summary, summaryRoom),
        failure: "memory_failed",
        signal,
      });
      // A chapter that fails leaves the episode written; the next memory tries again.
      if (!chapter.ok) return unrolled;
      // Forgotten or turned off during the chapter call: the episode is written and stays the
      // answer (after Forget it is gone, and `standing` refuses it); no chapter is written.
      if (moved()) return unrolled;
      // Cut only when the correction went past the room too, or the window held none. A cut
      // that leaves nothing valid writes no chapter; the episode stays written and answered.
      const clamped = chapterOutputSchema.safeParse(clampChapterOutput(chapter.value, summaryRoom));
      if (!clamped.success) {
        log.warn({ event: "memory.chapter", model, errorClass: "invalid_chapter" });
        return unrolled;
      }
      const output = clamped.data;
      const kept = stores.memory.chapter(characterId, {
        output: unnamedAnswer(output, userNames, chapterOutputSchema, clampChapterOutput),
        members: fitted.members.map(({ id, revision, chapterId }) => ({ id, revision, chapterId })),
      });
      if (typeof kept === "string") {
        log.warn({ event: "memory.chapter.error", model, errorClass: kept });
        return unrolled;
      }
      return {
        ok: true,
        written: {
          characterId,
          episode,
          notebook,
          chapter: kept,
          ...(ofBook ? { book: true as const } : {}),
        },
      };
    };
    return {
      ok: true,
      run: async (signal: AbortSignal): Promise<Outcome> => {
        try {
          return { ...(await work(signal)), accounting: recorder.snapshot() };
        } catch (error) {
          log.error({
            event: committed === undefined ? "memory.remember.error" : "memory.chapter.error",
            model,
            errorClass: errorClass(error),
          });
          return {
            ...(committed ?? { ok: false as const, error: "memory_failed" as const }),
            accounting: recorder.snapshot(),
          };
        }
      },
    };
  }

  /**
   * An opening call's checks that need no model call, then the call to run:
   * memory on and the character there, something remembered to write from
   * (the notebook or a memory), a model with a known window and a prompt
   * that fits it. The call reads canon, the notebook and the newest of the
   * book's story that the memory blocks' share holds, as a new chat's
   * "Before this chat" tells it (generation.ts). It writes nothing; a
   * Forget or memory off during it refuses its answer.
   */
  async function prepareOpening(
    characterId: string,
    request: OpeningRequest,
    signal: AbortSignal,
    user: UserInstance,
  ): Promise<{ ok: true; run: () => Promise<OpeningResponse | OpeningRefused> } | OpeningRefused> {
    const { stores } = user;
    const { model } = request;
    const generation = generationOf(user, characterId);
    const state = memoryStateOf(stores.memory.state(characterId) ?? null);
    const character = stores.characters.get(characterId)?.card;
    if (!memoryIsOn(state) || character === undefined) return { ok: false, error: "memory_off" };
    const book = stores.memory.list(characterId);
    if (!notebookHasContent(state.notebook) && book.length === 0) {
      return { ok: false, error: "nothing_to_remember" };
    }
    const target = await objectCallTarget(catalog, user, request, characterId, signal);
    if (!target.ok) return target;
    const { call } = target;
    const persona = chosenPersona(stores.personas, request.personaId);
    const names: SpeakerNames = { char: character.name, user: persona?.name ?? NO_PERSONA_NAME };
    // Canon: input for this request only, never stored, kept or logged; no turns, so constant entries only.
    const canon = canonFor(call, {
      card: character,
      names,
      ...(persona === null ? {} : { persona: persona.description }),
      linked: stores.lorebooks.booksOf(characterId),
      turns: [],
    });
    const instructions = openingInstructions(names);
    const message = openingMessage({
      canon,
      notebook: state.notebook,
      // The newest of the story that fit, in story order, as a new chat is told them.
      episodes: storyBefore(book, call.window),
    });
    const room = roomFor(call, [instructions, message]);
    if (room === null) {
      log.warn({ event: "memory.opening", model, errorClass: "prompt_too_long" });
      return { ok: false, error: "prompt_too_long" };
    }
    const recorder = callRecorder();
    const work = async (): Promise<OpeningResponse | OpeningRefused> => {
      const written = await objectCall(call, {
        event: "memory.opening",
        recorder,
        instructions,
        message,
        room,
        schema: openingAnswerSchema,
        clamp: clampOpeningAnswer,
        failure: "memory_failed",
        signal,
      });
      if (!written.ok) return written;
      // Forgotten or turned off during the call, even if on again since: no answer.
      if (generationOf(user, characterId) !== generation) return { ok: false, error: "memory_off" };
      const { opening } = unnamedAnswer(
        written.value,
        userNameForms(names),
        openingAnswerSchema,
        clampOpeningAnswer,
      );
      return { opening };
    };
    return {
      ok: true,
      run: async (): Promise<OpeningResponse | OpeningRefused> => {
        try {
          return { ...(await work()), accounting: recorder.snapshot() };
        } catch (error) {
          log.error({ event: "memory.opening.error", model, errorClass: errorClass(error) });
          return { ok: false, error: "memory_failed", accounting: recorder.snapshot() };
        }
      },
    };
  }

  /**
   * What of a kept memory still stands for this request: its episode, while
   * it is there (Forget and a delete take it), with its chapter while that is
   * there too; undefined once the episode is gone or the attempt was another
   * character's. A written episode is answered whatever memory did since, so
   * a refusal always means nothing of the attempt stands, and a retry under a
   * new attempt never writes the span twice.
   */
  function standing(
    request: RememberRequest,
    written: Written,
    user: UserInstance,
  ): Written | undefined {
    const { characterId, episode, chapter, ...rest } = written;
    const { memory } = user.stores;
    if (request.characterId !== characterId || memory.get(episode.id) === undefined) {
      return undefined;
    }
    return chapter === undefined || memory.get(chapter.id) !== undefined
      ? written
      : { characterId, episode, ...rest };
  }

  /**
   * Spec § Automatic creation, step 6, for one request: the memory written
   * and this chat's folded recap from its own episodes, reconciled with the
   * book as it is now (`recapAfter`), so a replay sees later chapters too.
   * The new episode is not in it: the tab holds it.
   */
  function answerOf(
    request: RememberRequest,
    { characterId, episode, notebook, chapter, book }: Written,
    stores: UserInstance["stores"],
  ): RememberResponse {
    // A chapter of the story before the chat stays out of the recap.
    const recap = recapAfter(request.episodes, stores.memory.list(characterId), {
      episode,
      chapter: book ? undefined : chapter,
    });
    return { episode, notebook, recap, ...(chapter === undefined ? {} : { chapter }) };
  }

  /**
   * A queued call's or model phase's answer (`streamedResponse`): 200 at
   * once, then one JSON text once the outcome settles, the memory or
   * `{ error }`. Blank lines keep the connection open meanwhile; a JSON
   * parser skips them as whitespace. The instance stays in use until the
   * outcome settled, and its writes are made durable before the body ends
   * (user.ts). Cancelling the body (the client went away) aborts
   * `cancelled`, the call this request started.
   */
  function answered(
    c: StreamContext,
    user: UserInstance,
    request: RememberRequest,
    outcome: Promise<Outcome>,
    cancelled: AbortController,
    attemptOutcome: () => Promise<Outcome> | undefined = () => outcome,
  ): Response {
    return streamedResponse(
      c,
      {
        contentType: "application/json",
        cancelled,
        failure: { log, event: "memory.remember.error", code: "memory_failed" },
      },
      async (write) => {
        let settled = await outcome;
        const accounting = settled.accounting ?? { calls: [], truncated: false };
        // A kept memory gone since is not replayed: the attempt goes, a retry calls again.
        if (settled.ok) {
          const written = standing(request, settled.written, user);
          const original = attemptOutcome();
          if (written === undefined && original !== undefined) {
            dropAttempt(user, request.attempt, original);
          }
          settled =
            written === undefined ? { ok: false, error: "memory_off" } : { ok: true, written };
        }
        if (settled.ok) {
          const answer = answerOf(request, settled.written, user.stores);
          write(JSON.stringify({ ...answer, accounting }));
          return;
        }
        writeRefusal(write, log, request.model, settled, accounting);
      },
    );
  }

  return new Hono<UserEnv>()
    .get("/characters/:id", idParam, (c) => {
      const { id } = c.req.valid("param");
      const { stores } = c.var.user;
      if (!stores.characters.exists(id)) return notFound(c);
      return c.json(memoryView(stores, id), 200);
    })
    .patch(
      "/characters/:id",
      idParam,
      jsonLimit,
      zValidator("json", memoryStatePatchRequestSchema, invalid),
      (c) => {
        const { id } = c.req.valid("param");
        const { revision, ...patch } = c.req.valid("json");
        // A character without a notebook row is at revision 0; this write creates it.
        const result = c.var.user.stores.memory.setState(id, patch, revision);
        // Off: a memory call running now writes nothing.
        if (result.status === "updated" && patch.enabled === false) {
          advanceGeneration(c.var.user, id);
        }
        return answerUpdate(c, result);
      },
    )
    .delete("/characters/:id", idParam, (c) => {
      const { id } = c.req.valid("param");
      const { user } = c.var;
      if (!user.stores.memory.forget(id)) return notFound(c);
      // Forgotten: a memory call running now writes nothing.
      advanceGeneration(user, id);
      // The memory as Forget left it: the emptied notebook at its new revision, and no memories.
      return c.json(memoryView(user.stores, id), 200);
    })
    .patch(
      "/episodes/:id",
      idParam,
      jsonLimit,
      zValidator("json", episodePatchRequestSchema, invalid),
      (c) => {
        const { revision, ...patch } = c.req.valid("json");
        return answerUpdate(
          c,
          c.var.user.stores.memory.update(c.req.valid("param").id, patch, revision),
        );
      },
    )
    .delete("/episodes/:id", idParam, (c) =>
      removed(c, c.var.user.stores.memory.remove(c.req.valid("param").id)),
    )
    .post(
      "/characters/:id/opening",
      requestLifetime(deps.requestTimeoutMs, deps.onStreamingRequest),
      idParam,
      // The body is read within the deadline: the runtime's idle timeout is off here.
      boundedBody(MAX_JSON_BYTES),
      zValidator("json", openingRequestSchema, invalid),
      async (c) => {
        const { id } = c.req.valid("param");
        const request = c.req.valid("json");
        const { cancelled, signal } = streamSignal(c);
        const prepared = await prepareOpening(id, request, signal, c.var.user);
        if (!prepared.ok) {
          return refusedBeforeCall(
            c,
            log,
            "memory.refused",
            request.model,
            prepared.error,
            OPENING_STATUSES,
          );
        }
        // As a memory call's model phase: 200 at once, then the opening or the refusal as JSON.
        return streamedResponse(
          c,
          {
            contentType: "application/json",
            cancelled,
            failure: { log, event: "memory.opening.error", code: "memory_failed" },
          },
          async (write) => {
            const outcome = await prepared.run();
            const { accounting, ...body } = outcome;
            if (!("ok" in body))
              return write(
                JSON.stringify({ ...body, ...(accounting === undefined ? {} : { accounting }) }),
              );
            writeRefusal(write, log, request.model, body, accounting);
          },
        );
      },
    )
    .post(
      "/remember",
      requestLifetime(deps.requestTimeoutMs, deps.onStreamingRequest),
      boundedBody(MAX_CHAT_BODY_BYTES),
      zValidator("json", rememberRequestSchema, invalid),
      async (c) => {
        const request = c.req.valid("json");
        const { user } = c.var;
        const { cancelled, signal } = streamSignal(c);
        // A repeat of a known attempt waits for its answer; a new one is checked first.
        let outcome = joinAttempt(user, request.attempt, signal);
        if (outcome !== undefined) return answered(c, user, request, outcome, cancelled);
        // Forget everything or memory off while this one waits refuses it.
        const generation = generationOf(user, request.characterId);
        // One call per character at a time: this one reads the notebook once the one before wrote.
        const place = queueFor(user, request.characterId);
        const start = (prepared: Extract<Awaited<ReturnType<typeof prepare>>, { ok: true }>) =>
          attemptOnce(
            user,
            request.attempt,
            (call) =>
              prepared.run(call).catch((error: unknown): Outcome => {
                log.error({
                  event: "memory.remember.error",
                  model: request.model,
                  errorClass: errorClass(error),
                });
                return { ok: false, error: "memory_failed" };
              }),
            signal,
          );
        if (place.waiting) {
          // Send headers and keepalives while queued, before reading the previous call's notebook.
          let original: Promise<Outcome> | undefined;
          const waiting = (async (): Promise<Outcome> => {
            try {
              if (!(await awaitTurn(place.ready, signal))) return { ok: false, error: "aborted" };
              original = joinAttempt(user, request.attempt, signal);
              if (original === undefined) {
                const prepared = await prepare(request, generation, signal, user);
                if (!prepared.ok) return prepared;
                original = start(prepared);
              }
              return await original;
            } finally {
              place.leave();
            }
          })();
          return answered(c, user, request, waiting, cancelled, () => original);
        }
        try {
          if (!(await awaitTurn(place.ready, signal))) {
            place.leave();
            return c.json({ error: "request_timeout" as const }, 408);
          }
          outcome = joinAttempt(user, request.attempt, signal);
          if (outcome === undefined) {
            const prepared = await prepare(request, generation, signal, user);
            if (!prepared.ok) {
              place.leave();
              return refusedBeforeCall(
                c,
                log,
                "memory.refused",
                request.model,
                prepared.error,
                REMEMBER_STATUSES,
              );
            }
            outcome = start(prepared);
          }
        } catch (error) {
          place.leave();
          throw error;
        }
        void outcome.then(place.leave, place.leave);
        return answered(c, user, request, outcome, cancelled);
      },
    );
}
