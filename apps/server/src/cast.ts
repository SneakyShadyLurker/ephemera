import { createHash } from "node:crypto";
import {
  CAST_LIMITS,
  type CallAccounting,
  type CallUsage,
  type CastChanges,
  type CastRefusal,
  type CastSheet,
  type CastSheetRequest,
  type CastUpdateRequest,
  type CharacterCard,
  castCanon,
  castChangesSchema,
  castFingerprintInput,
  castSheetAnswerSchema,
  castSheetRequestSchema,
  castUpdateRequestSchema,
  clampCastChanges,
  clampCastSheetAnswer,
  groundedCastChanges,
  keeperInstructions,
  keeperMessage,
  MAX_CHAT_BODY_BYTES,
  NO_CHARACTER_NAME,
  NO_PERSONA_NAME,
  sheetEntriesFromAnswer,
  sheetInstructions,
  sheetMessage,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Catalog } from "./catalog.ts";
import { boundedBody, requestLifetime, untilAborted } from "./lifetime.ts";
import { errorClass, type Logger } from "./log.ts";
import { type ObjectCallTarget, objectCaller, objectCallTarget, roomFor } from "./object-call.ts";
import type { UserInstance } from "./persistence/store.ts";
import { chosenPersona } from "./personas.ts";
import {
  invalid,
  MAX_JSON_BYTES,
  notFound,
  type RefusalStatuses,
  refusedBeforeCall,
} from "./routes.ts";
import { streamedResponse, streamSignal } from "./streams.ts";
import { type Upstream, waitOf } from "./upstream.ts";
import { type CallRecorder, callRecorder, reportedUsage } from "./usage.ts";
import type { UserEnv } from "./user.ts";

/*
 * The cast register's server side (PRINCIPLES.md 1). A keeper call's
 * register, turns, prompt and answer are chat content: they live in this
 * request's memory only and are never written, kept or logged; the browser
 * applies the changes. A cast sheet is character data read from the card
 * alone: its job reads the card by id, never a request body, and writes
 * only the sheet.
 */

export interface CastDeps {
  log: Logger;
  /** The model catalog: the call's context window and the efforts the model offers. */
  catalog: Pick<Catalog, "current">;
  /** The configured upstream's chat models (api.ts). */
  upstream: Upstream;
  /** A keeper request's lifetime, and a sheet job's: chat's. */
  requestTimeoutMs: number;
  onStreamingRequest?: (request: Request) => void;
}

/** Why a keeper or sheet call gave no result: a refusal its body names. */
type Refused = { ok: false; error: CastRefusal; retryAfterS?: number };

/** A cast sheet's fingerprint: sha256 hex of the card's fingerprint input. */
const fingerprintOf = (card: CharacterCard) =>
  createHash("sha256").update(castFingerprintInput(card)).digest("hex");

/** A sheet job's outcome: the stored sheet, or why there is none. */
type SheetOutcome = ({ ok: true; sheet: CastSheet } | Refused) & { accounting?: CallAccounting };

/**
 * Each character's running sheet job, per instance: one at a time, joined
 * by every caller. Operational state; it lives and dies with the instance.
 */
const sheetJobs = new WeakMap<UserInstance, Map<string, Promise<SheetOutcome>>>();

const jobsOf = (user: UserInstance) => {
  let jobs = sheetJobs.get(user);
  if (jobs === undefined) {
    jobs = new Map();
    sheetJobs.set(user, jobs);
  }
  return jobs;
};

const characterParam = zValidator("param", z.object({ characterId: z.uuid() }), invalid);

/** The status of each refusal before a keeper or sheet call. */
const REFUSAL_STATUSES = {
  not_found: 404,
  prompt_too_long: 422,
  context_window_unknown: 409,
  upstream_busy: 409,
  cast_failed: 409,
} as const satisfies RefusalStatuses<CastRefusal>;

/** A refusal's body: the deadline as `request_timeout`, a busy provider with its wait. */
const refusalBody = (refused: Refused) => ({
  error: refused.error === "aborted" ? ("request_timeout" as const) : refused.error,
  ...waitOf(refused),
});

export function createCastApi(deps: CastDeps) {
  const { log, catalog, upstream } = deps;
  const objectCall = objectCaller({ log, upstream });

  /**
   * A keeper call's checks that need no model call, then the call to run:
   * the character there when named, a model with a known window and a
   * prompt that fits it. Canon goes in unless the chat acknowledged the
   * stored sheet and that sheet is the card's current one.
   */
  async function prepareUpdate(
    request: CastUpdateRequest,
    signal: AbortSignal,
    user: UserInstance,
    recorder: CallRecorder,
  ): Promise<
    { ok: true; run: () => Promise<{ changes: CastChanges; usage: CallUsage } | Refused> } | Refused
  > {
    const { stores } = user;
    const { characterId } = request;
    const card = characterId === undefined ? undefined : stores.characters.get(characterId)?.card;
    if (characterId !== undefined && card === undefined) return { ok: false, error: "not_found" };
    const target = await objectCallTarget(
      catalog,
      user,
      request,
      `cast:${characterId ?? ""}`,
      signal,
    );
    if (!target.ok) return target;
    const { call } = target;
    const persona = chosenPersona(stores.personas, request.personaId);
    const names = { char: card?.name ?? NO_CHARACTER_NAME, user: persona?.name ?? NO_PERSONA_NAME };
    let canon: string | null = null;
    if (card !== undefined && characterId !== undefined) {
      const sheet = stores.castSheets.get(characterId);
      // The sheet stands in for canon only when the chat acknowledged it, it is the card's current
      // one and it names someone: an empty sheet (a Scenario card has no fixed people) leaves the
      // keeper the card's people and setting to invent from.
      const covered =
        sheet !== null &&
        sheet.entries.length > 0 &&
        request.sheetFingerprint === sheet.fingerprint &&
        sheet.fingerprint === fingerprintOf(card);
      // Canon: input for this request only, never stored, kept or logged.
      if (!covered) canon = castCanon(card, names, persona?.description);
    }
    const instructions = keeperInstructions();
    const message = keeperMessage({
      canon,
      names,
      register: request.register,
      turns: request.turns,
      mode: request.mode,
      full: request.register.entries.length >= CAST_LIMITS.entries,
    });
    const room = roomFor(call, [instructions, message]);
    if (room === null) {
      log.warn({ event: "cast.update", model: call.model, errorClass: "prompt_too_long" });
      return { ok: false, error: "prompt_too_long" };
    }
    const run = async () => {
      const answered = await objectCall(call, {
        event: "cast.update",
        instructions,
        message,
        room,
        schema: castChangesSchema,
        clamp: clampCastChanges,
        failure: "cast_failed",
        signal,
        recorder,
      });
      if (!answered.ok) return answered;
      return {
        changes: groundedCastChanges(
          answered.value,
          request.turns.map((turn) => turn.scanText ?? turn.content),
        ),
        usage: reportedUsage(answered.usage),
      };
    };
    return { ok: true, run };
  }

  /**
   * The character's sheet job: one model call over the card alone, under its
   * own lifetime, not any caller's; its answer is clamped, given ids and
   * stored with `fingerprint`, the card's as read before the call, whoever
   * still waits. The instance stays in use, and the sheet is made durable,
   * until it settles.
   */
  function startSheetJob(
    user: UserInstance,
    characterId: string,
    job: {
      call: ObjectCallTarget;
      instructions: string;
      message: string;
      room: number;
      fingerprint: string;
    },
  ): Promise<SheetOutcome> {
    const jobs = jobsOf(user);
    const { call } = job;
    const recorder = callRecorder();
    user.enter();
    const work = async (): Promise<SheetOutcome> => {
      const answered = await objectCall(call, {
        event: "cast.sheet",
        instructions: job.instructions,
        message: job.message,
        room: job.room,
        schema: castSheetAnswerSchema,
        clamp: clampCastSheetAnswer,
        failure: "cast_failed",
        signal: AbortSignal.timeout(deps.requestTimeoutMs),
        recorder,
      });
      if (!answered.ok) return answered;
      // Deleted during the call: nothing is stored.
      if (!user.stores.characters.exists(characterId)) return { ok: false, error: "not_found" };
      const entries = sheetEntriesFromAnswer(answered.value, () => crypto.randomUUID());
      const sheet = user.stores.castSheets.put(characterId, {
        fingerprint: job.fingerprint,
        entries,
      });
      return { ok: true, sheet };
    };
    const settle = async (): Promise<SheetOutcome> => {
      try {
        return { ...(await work()), accounting: recorder.snapshot() };
      } catch (error) {
        log.error({ event: "cast.sheet.error", model: call.model, errorClass: errorClass(error) });
        return { ok: false, error: "cast_failed", accounting: recorder.snapshot() };
      } finally {
        // Settled: the next caller starts a new job; the sheet is durable before any answer.
        if (jobs.get(characterId) === outcome) jobs.delete(characterId);
        await user.flushIfDirty().catch((error: unknown) => {
          log.error({ event: "instance.flush", errorClass: errorClass(error) });
        });
        user.leave();
      }
    };
    const outcome = settle();
    jobs.set(characterId, outcome);
    return outcome;
  }

  /** The character's running sheet job, or a new one; a refusal when none can start. */
  async function sheetJob(
    user: UserInstance,
    characterId: string,
    card: CharacterCard,
    request: CastSheetRequest,
    signal: AbortSignal,
  ): Promise<{ ok: true; outcome: Promise<SheetOutcome> } | Refused> {
    const running = jobsOf(user).get(characterId);
    if (running !== undefined) return { ok: true, outcome: running };
    const fingerprint = fingerprintOf(card);
    const target = await objectCallTarget(
      catalog,
      user,
      request,
      `cast-sheet:${characterId}`,
      signal,
    );
    // Another caller started one while the catalog loaded: this one joins it.
    const started = jobsOf(user).get(characterId);
    if (started !== undefined) return { ok: true, outcome: started };
    if (!target.ok) return target;
    const { call } = target;
    const instructions = sheetInstructions();
    const message = sheetMessage(card);
    const room = roomFor(call, [instructions, message]);
    if (room === null) {
      log.warn({ event: "cast.sheet", model: call.model, errorClass: "prompt_too_long" });
      return { ok: false, error: "prompt_too_long" };
    }
    return {
      ok: true,
      outcome: startSheetJob(user, characterId, { call, instructions, message, room, fingerprint }),
    };
  }

  /** A sheet as a caller reads it: with whether it matches the card now. */
  const sheetView = (sheet: CastSheet | null, card: CharacterCard) => ({
    sheet,
    current: sheet !== null && sheet.fingerprint === fingerprintOf(card),
  });

  return new Hono<UserEnv>()
    .post(
      "/update",
      requestLifetime(deps.requestTimeoutMs, deps.onStreamingRequest),
      boundedBody(MAX_CHAT_BODY_BYTES),
      zValidator("json", castUpdateRequestSchema, invalid),
      async (c) => {
        const request = c.req.valid("json");
        const recorder = callRecorder();
        const { cancelled, signal } = streamSignal(c);
        const prepared = await prepareUpdate(request, signal, c.var.user, recorder);
        if (!prepared.ok)
          return refusedBeforeCall(
            c,
            log,
            "cast.refused",
            request.model,
            prepared.error,
            REFUSAL_STATUSES,
          );
        // As a memory call: 200 at once, keepalives, then the changes or the refusal as JSON.
        return streamedResponse(
          c,
          {
            contentType: "application/json",
            cancelled,
            failure: { log, event: "cast.update.error", code: "cast_failed" },
          },
          async (write) => {
            const outcome = await prepared.run().catch((error: unknown): Refused => {
              log.error({
                event: "cast.update.error",
                model: request.model,
                errorClass: errorClass(error),
              });
              return { ok: false, error: "cast_failed" };
            });
            write(
              JSON.stringify({
                ...("changes" in outcome ? outcome : refusalBody(outcome)),
                accounting: recorder.snapshot(),
              }),
            );
          },
        );
      },
    )
    .get("/sheets/:characterId", characterParam, (c) => {
      const { characterId } = c.req.valid("param");
      const { stores } = c.var.user;
      const card = stores.characters.get(characterId)?.card;
      if (card === undefined) return notFound(c);
      return c.json(sheetView(stores.castSheets.get(characterId), card), 200);
    })
    .post(
      "/sheets/:characterId",
      requestLifetime(deps.requestTimeoutMs, deps.onStreamingRequest),
      characterParam,
      // The body is read within the deadline: the runtime's idle timeout is off here.
      boundedBody(MAX_JSON_BYTES),
      zValidator("json", castSheetRequestSchema, invalid),
      async (c) => {
        const { characterId } = c.req.valid("param");
        const request = c.req.valid("json");
        const { user } = c.var;
        const card = user.stores.characters.get(characterId)?.card;
        if (card === undefined) return notFound(c);
        const stored = user.stores.castSheets.get(characterId);
        if (stored !== null && stored.fingerprint === fingerprintOf(card) && !request.force) {
          return c.json(
            {
              sheet: stored,
              current: true,
              accounting: { calls: [], truncated: false },
            },
            200,
          );
        }
        const { cancelled, signal } = streamSignal(c);
        const job = await sheetJob(user, characterId, card, request, signal);
        if (!job.ok)
          return refusedBeforeCall(
            c,
            log,
            "cast.refused",
            request.model,
            job.error,
            REFUSAL_STATUSES,
          );
        // 200 at once, keepalives, then the stored sheet or the refusal. A caller that goes
        // only stops waiting: the job runs on and stores its sheet.
        return streamedResponse(
          c,
          {
            contentType: "application/json",
            cancelled,
            failure: { log, event: "cast.sheet.error", code: "cast_failed" },
          },
          async (write) => {
            const outcome = (await untilAborted(job.outcome, signal)) ?? {
              ok: false as const,
              error: "aborted" as const,
            };
            const accounting = "accounting" in outcome ? { accounting: outcome.accounting } : {};
            if (!outcome.ok)
              return write(JSON.stringify({ ...refusalBody(outcome), ...accounting }));
            const now = user.stores.characters.get(characterId)?.card;
            write(
              JSON.stringify({
                ...(now === undefined
                  ? { sheet: outcome.sheet, current: false }
                  : sheetView(outcome.sheet, now)),
                ...accounting,
              }),
            );
          },
        );
      },
    );
}
