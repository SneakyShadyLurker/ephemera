import {
  answerRoom,
  type CallPurpose,
  type CallSettings,
  creatorOutputTokens,
  type ReasoningEffort,
  repairObject,
  UPSTREAM_BUSY,
} from "@ephemera/core";
import { generateText, type LanguageModelUsage, type ModelMessage } from "ai";
import type { z } from "zod";
import type { Catalog } from "./catalog.ts";
import { calibrate } from "./generation.ts";
import type { Logger } from "./log.ts";
import type { UserInstance } from "./persistence/store.ts";
import { countMessage, PRIMING } from "./tokens.ts";
import {
  effortSettings,
  instanceCacheKey,
  logCallError,
  resolveModel,
  type Upstream,
  waitOf,
} from "./upstream.ts";
import { type CallRecorder, reportedUsage } from "./usage.ts";

/*
 * One bounded model call for a JSON object, shared by memory and the cast
 * keeper and sheet (PRINCIPLES.md 1): the prompt and the answer live in the
 * call's memory only; logs carry operational fields only.
 */

/** A model call's target: the model, its window and output, the calibration and the cache key. */
export interface ObjectCallTarget {
  model: string;
  window: number;
  /** The most an answer may ask for: the model's output limit, when lower (`creatorOutputTokens`). */
  maxOutput: number;
  ratio: number;
  /** The chosen effort as the model offers it (`effortSettings`): one it lacks sends its default. */
  settings: CallSettings;
  /** The scope's cache key in this instance, the same for each of its calls. */
  cacheKey: string;
  calibration?: Map<string, number>;
}

/** The user's call target for `model` with its effort, or why there is none; `scope` keys its cache. */
export async function objectCallTarget(
  catalog: Pick<Catalog, "current">,
  user: UserInstance,
  request: { model: string; reasoning?: ReasoningEffort | undefined },
  scope: string,
  signal: AbortSignal,
): Promise<
  { ok: true; call: ObjectCallTarget } | { ok: false; error: "aborted" | "context_window_unknown" }
> {
  const { model } = request;
  const resolved = await resolveModel(catalog, model, user.stores.settings.get(), signal);
  if (resolved === null) return { ok: false, error: "aborted" };
  if (resolved.window === null) return { ok: false, error: "context_window_unknown" };
  return {
    ok: true,
    call: {
      model,
      window: resolved.window.tokens,
      maxOutput: creatorOutputTokens(resolved.info),
      ratio: user.calibration.get(model) ?? 1,
      // An effort the model does not offer goes as its default.
      settings: effortSettings(resolved.info, request.reasoning),
      cacheKey: instanceCacheKey(user, scope),
      calibration: user.calibration,
    },
  };
}

/** The events an object call logs under, each caller's own: every call purpose but the streamed ones. */
export type ObjectCallEvent = Exclude<CallPurpose, "narration" | "scene.prompt">;

/** Why a call gave no object: the request ended, the provider stayed busy, or the caller's failure. */
type ObjectCallRefused<F extends string> = {
  ok: false;
  error: "aborted" | F | typeof UPSTREAM_BUSY;
  retryAfterS?: number;
};

/** The tokens `texts` take as an object call's messages, before calibration. */
export const helperInputTokens = (texts: readonly string[]): number =>
  PRIMING +
  texts.reduce(
    (sum, content, index) =>
      sum +
      countMessage({
        role: index === 0 ? "system" : index % 2 === 1 ? "user" : "assistant",
        content,
      }),
    0,
  );

/**
 * The answer's room in `window` after `texts` as a call's messages, plus
 * `extraTokens` (an image's share), calibrated by `ratio` (`answerRoom`):
 * null when the prompt leaves too little. Every model call's fit rule.
 */
export const promptRoom = (
  window: number,
  ratio: number,
  texts: readonly string[],
  extraTokens = 0,
): number | null => answerRoom(window, (helperInputTokens(texts) + extraTokens) * ratio);

/** The answer's room in the target's window after `texts` (`promptRoom`), at most its output. */
export function roomFor(call: ObjectCallTarget, texts: readonly string[]): number | null {
  const room = promptRoom(call.window, call.ratio, texts);
  return room === null ? null : Math.min(room, call.maxOutput);
}

/**
 * An object call over the configured upstream, logging to `log`.
 *
 * One bounded model call for a JSON object, read from the answer's text:
 * no `response_format` is sent, since some providers refuse any, and the
 * instructions describe the object. The answer is repaired once (stray
 * text, a draft before it, past a bound: `repairObject`, `clamp`); one
 * that still does not parse or validate, or that the answer's room cut
 * short, is asked for once more. A valid first answer that `correct` finds
 * past a bound is asked for once more with that correction, when the
 * window holds it, and kept should the second answer be unusable or its
 * call fail. A failed call is not repeated here: the AI SDK's retries
 * (upstream.ts) already waited out what a retry could fix. The caller
 * fitted the input to the window, and the answer gets `room`. A call that
 * gives no object answers the caller's `failure`. The value comes with the
 * AI SDK's usage of the call that gave it.
 */
export function objectCaller({ log, upstream }: { log: Logger; upstream: Upstream }) {
  return async function objectCall<T, F extends string>(
    call: ObjectCallTarget,
    options: {
      event: ObjectCallEvent;
      instructions: string;
      message: string;
      room: number;
      schema: z.ZodType<T>;
      clamp: (value: unknown) => unknown;
      correct?: (value: T) => string | null;
      /** What a call that gives no object answers. */
      failure: F;
      signal: AbortSignal;
      recorder?: CallRecorder;
    },
  ): Promise<{ ok: true; value: T; usage: LanguageModelUsage } | ObjectCallRefused<F>> {
    const { event, signal, failure } = options;
    const { model } = call;
    let messages: ModelMessage[] = [{ role: "user", content: options.message }];
    let room = options.room;
    /** A valid first answer past a bound, while its correction is asked for. */
    let kept: { value: T; usage: LanguageModelUsage } | undefined;
    for (const attempt of [1, 2]) {
      const started = performance.now();
      const durationMs = () => Math.round(performance.now() - started);
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model: upstream.model(
            model,
            undefined,
            options.recorder === undefined
              ? undefined
              : { recorder: options.recorder, purpose: event },
          ),
          instructions: options.instructions,
          messages,
          maxOutputTokens: room,
          ...upstream.settings(call.settings, call.cacheKey),
          // Ends the call, retries' waits included, when the request ends.
          abortSignal: signal,
        });
      } catch (error) {
        if (signal.aborted) {
          log.info({ event: `${event}.abort`, model, durationMs: durationMs(), attempt });
          return { ok: false, error: "aborted" };
        }
        const failed = logCallError(
          log,
          { event: `${event}.error`, model, durationMs: durationMs(), attempt },
          error,
        );
        // A correction that failed leaves the first answer, as an unusable one does.
        if (kept !== undefined) return { ok: true, ...kept };
        return failed.busy
          ? { ok: false, error: UPSTREAM_BUSY, ...waitOf(failed) }
          : { ok: false, error: failure };
      }
      const { finishReason, text, usage } = result;
      if (call.calibration !== undefined) {
        const estimate = helperInputTokens([
          options.instructions,
          ...messages.map((message) =>
            typeof message.content === "string" ? message.content : "",
          ),
        ]);
        calibrate(call.calibration, model, estimate, reportedUsage(usage).inputTokens);
      }
      // An answer its room cut short is no answer, even where a draft before the cut parses.
      const truncated = finishReason === "length";
      const value = truncated ? undefined : repairObject(text, options.schema, options.clamp);
      if (value !== undefined) {
        const correction = attempt === 1 ? (options.correct?.(value) ?? null) : null;
        const corrected =
          correction === null
            ? null
            : roomFor(call, [
                options.instructions,
                ...messages.map((message) =>
                  typeof message.content === "string" ? message.content : "",
                ),
                text,
                correction,
              ]);
        if (correction === null || corrected === null) {
          log.info({ event, model, durationMs: durationMs(), finishReason, attempt });
          return { ok: true, value, usage };
        }
        log.warn({
          event: `${event}.error`,
          model,
          durationMs: durationMs(),
          errorClass: "AnswerPastBound",
          finishReason,
          attempt,
        });
        kept = { value, usage };
        room = corrected;
        messages = [
          ...messages,
          { role: "assistant", content: text },
          { role: "user", content: correction },
        ];
        continue;
      }
      log.error({
        event: `${event}.error`,
        model,
        durationMs: durationMs(),
        errorClass: truncated ? "TruncatedAnswer" : "UnusableAnswer",
        finishReason,
        attempt,
      });
      if (attempt === 1) {
        const correction =
          "Return the complete valid JSON object requested above, without surrounding prose. The previous answer was unusable or cut short.";
        const next = roomFor(call, [
          options.instructions,
          ...messages.map((message) =>
            typeof message.content === "string" ? message.content : "",
          ),
          text,
          correction,
        ]);
        if (next === null) break;
        messages = [
          ...messages,
          { role: "assistant", content: text },
          { role: "user", content: correction },
        ];
        room = next;
      }
    }
    return kept === undefined ? { ok: false, error: failure } : { ok: true, ...kept };
  };
}
