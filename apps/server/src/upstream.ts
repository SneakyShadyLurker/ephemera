import { createHmac, randomBytes } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type CallPurpose,
  type CallSettings,
  DEFAULT_PROMPT_REASONING,
  type EffectiveWindow,
  effectiveWindow,
  effortFor,
  MAX_RETRY_AFTER_S,
  type ModelInfo,
  modelInfo,
  type ReasoningEffort,
  type Settings,
  type StreamFailure,
  UPSTREAM_BUSY,
} from "@ephemera/core";
import {
  APICallError,
  type FinishReason,
  type LanguageModel,
  type LanguageModelCallOptions,
  type LogWarningsFunction,
  RetryError,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";
import type { Catalog, UpstreamFetch } from "./catalog.ts";
import type { AppConfig } from "./config.ts";
import { readBounded } from "./lifetime.ts";
import { errorClass, type LogFields, type Logger } from "./log.ts";
import { startReasoningMiddleware } from "./reasoning.ts";
import type { CallRecorder } from "./usage.ts";

/*
 * Every model call goes through here (PRINCIPLES.md 1): the provider, a
 * call's settings with its effort, cache key and retries, and how a failed
 * call is logged and named. Prompts, answers and error messages are chat
 * content: only classes, statuses and fixed names are logged.
 */

/** The provider's name; its options travel under this key (`providerOptions.upstream`). */
const UPSTREAM_PROVIDER = "upstream";

/**
 * Retries of a call the provider answered with a retryable status (408, 409,
 * 429, 5xx) before any output: the AI SDK's backoff of 2 s then 4 s, or the
 * provider's `Retry-After` up to 60 s, each wait ended by the call's abort
 * signal, the request's deadline.
 */
const UPSTREAM_RETRIES = 2;

type SdkEffort = NonNullable<LanguageModelCallOptions["reasoning"]>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Core's efforts are the SDK's `reasoning` levels exactly: a level either side adds fails the build.
true satisfies Same<ReasoningEffort, SdkEffort>;

/**
 * A call's settings as the AI SDK takes them; every effort goes as its
 * `reasoning` setting, which the OpenAI-compatible provider sends as
 * `reasoning_effort`. A cache key goes as body `prompt_cache_key` (the
 * provider spreads its unknown options into the body) and header
 * `x-session-affinity`; it lives as long as the call. Server calls go
 * through `Upstream.settings`, which honours `EPHEMERA_UPSTREAM_SESSION_CACHE`.
 */
export function upstreamSettings(settings: CallSettings, cacheKey: string | undefined) {
  return {
    ...settings,
    ...(cacheKey === undefined
      ? {}
      : {
          providerOptions: { [UPSTREAM_PROVIDER]: { prompt_cache_key: cacheKey } },
          headers: { "x-session-affinity": cacheKey },
        }),
    maxRetries: UPSTREAM_RETRIES,
  };
}

/**
 * A chosen effort as call settings, narrowed to what the catalog says the
 * model offers (`effortFor`): none chosen, or one the model lacks, sends the
 * model default.
 */
export function effortSettings(
  info: ModelInfo | undefined,
  chosen: ReasoningEffort | undefined,
): CallSettings {
  if (chosen === undefined) return {};
  const effort = effortFor(info, chosen);
  return effort === "provider-default" ? {} : { reasoning: effort };
}

/** A cache key for one request's calls, its retry included. */
export const requestCacheKey = (): string => crypto.randomUUID();

/** Per instance, random and in server memory only: never persisted or logged. */
const salts = new WeakMap<object, Buffer>();

/**
 * A cache key for one `scope` (a character's id) within an instance: the
 * same for every call of that scope while the instance lives, and no one's
 * id can be read from it or predicted.
 */
export function instanceCacheKey(instance: object, scope: string): string {
  let salt = salts.get(instance);
  if (salt === undefined) {
    salt = randomBytes(32);
    salts.set(instance, salt);
  }
  return createHmac("sha256", salt).update(scope).digest("base64url");
}

/** What the log and the caller learn of a failed call; nothing of its message. */
export interface CallFailure {
  /** The error's class: the last attempt's when the retries ran out. */
  errorClass: string;
  /** The provider's HTTP status, when it answered one. */
  status?: number;
  /** The provider stayed busy (429 or 503) through the retries. */
  busy: boolean;
  /** Seconds the provider asked to wait, when it said. */
  retryAfterS?: number;
}

/** The provider's `retry-after-ms` or `Retry-After` (seconds or a date), in whole seconds. */
function retryAfter(headers: Record<string, string> | undefined): number | undefined {
  const ms = headers?.["retry-after-ms"];
  const after = headers?.["retry-after"];
  let seconds: number | undefined;
  if (ms !== undefined) seconds = Number(ms) / 1_000;
  else if (after !== undefined) {
    const value = Number(after);
    seconds = Number.isNaN(value) ? (Date.parse(after) - Date.now()) / 1_000 : value;
  }
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_S);
}

export function callFailure(error: unknown): CallFailure {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(last)) return { errorClass: errorClass(last), busy: false };
  const status = last.statusCode;
  const busy = status === 429 || status === 503;
  const wait = busy ? retryAfter(last.responseHeaders) : undefined;
  return {
    errorClass: errorClass(last),
    ...(status === undefined ? {} : { status }),
    busy,
    ...(wait === undefined ? {} : { retryAfterS: wait }),
  };
}

/** A failed call's error event, by class and status only; its failure for the caller. */
export function logCallError(
  log: Logger,
  fields: Omit<LogFields, "errorClass" | "status">,
  error: unknown,
): CallFailure {
  const failure = callFailure(error);
  log.error({
    ...fields,
    errorClass: failure.errorClass,
    ...(failure.status === undefined ? {} : { status: failure.status }),
  });
  return failure;
}

/** A busy provider's wait, for an error answer or event: none when it did not say. */
export const waitOf = ({ retryAfterS }: { retryAfterS?: number | undefined }) =>
  retryAfterS === undefined ? {} : { retryAfterS };

/** A busy provider's code for a route's error event, with its wait when known. */
export const busyCode = (failure: CallFailure) => ({ code: UPSTREAM_BUSY, ...waitOf(failure) });

/** The chat stream's error text for a failed call. */
export const streamFailure = (error: unknown): StreamFailure =>
  callFailure(error).busy ? UPSTREAM_BUSY : "generation_failed";

/** A route's log events for one call. */
export interface CallEvents {
  error: string;
  end: string;
  abort: string;
}

/**
 * A `streamText` call's callbacks, logging its end, abort or error with
 * operational fields only; they replace the default console.error(error),
 * since an error can carry the prompt. `failure` is the error the call
 * reported, once it did.
 */
export function streamLogging(
  log: Logger,
  events: CallEvents,
  fields: { model: string; attempt?: number },
) {
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  let failure: CallFailure | undefined;
  return {
    callbacks: {
      onError: ({ error }: { error: unknown }) => {
        failure = logCallError(log, { event: events.error, ...fields }, error);
      },
      onEnd: ({ finishReason }: { finishReason: FinishReason }) =>
        log.info({ event: events.end, ...fields, finishReason, durationMs: durationMs() }),
      onAbort: () => log.info({ event: events.abort, ...fields, durationMs: durationMs() }),
    },
    failure: () => failure,
  };
}

/**
 * The AI SDK's warnings (a setting a model does not support, a value
 * coerced, a deprecated option) as operational events: the model, the
 * warning's type and the feature or setting it names, never its message or
 * details. Process-wide, as the SDK reads it from `globalThis`.
 */
export function warningLogger(log: Logger): LogWarningsFunction {
  return ({ warnings, model }) => {
    for (const warning of warnings) {
      const name =
        warning.type === "unsupported" || warning.type === "compatibility"
          ? warning.feature
          : warning.type === "deprecated"
            ? warning.setting
            : undefined;
      log.warn({
        event: "ai.warning",
        ...(model === undefined ? {} : { model }),
        errorClass: name === undefined ? warning.type : `${warning.type}:${name.slice(0, 64)}`,
      });
    }
  };
}

/** A model's entry and window in the current catalog. */
interface ModelContext {
  /** Undefined when there is no catalog or it lists no such model. */
  info: ModelInfo | undefined;
  /** Null when neither the catalog nor the owner gives the model one. */
  window: EffectiveWindow | null;
}

/**
 * The current catalog's view of a model (`effectiveWindow` with the owner's
 * settings); null when `signal` aborted while the catalog loaded, so the
 * caller does nothing more.
 */
export async function resolveModel(
  catalog: Pick<Catalog, "current">,
  id: string,
  settings: Pick<Settings, "contextWindows" | "contextLimits">,
  signal: AbortSignal,
): Promise<ModelContext | null> {
  const models = await catalog.current(signal);
  if (signal.aborted) return null;
  return { info: modelInfo(models, id), window: effectiveWindow(id, models, settings) };
}

/** Far past any provider's refusal; a longer error body is not read for a field's name. */
const MAX_REFUSAL_BYTES = 64 * 1024;

/**
 * Request fields some OpenAI-compatible providers refuse, by the names a
 * refusal of each carries: the session cache key with its header
 * (`upstreamSettings`), the output cap the AI SDK sends as `max_tokens`, and
 * the streamed usage report (`includeUsage`).
 */
const REFUSABLE = {
  cache: {
    names: ["prompt_cache_key"],
    fields: ["prompt_cache_key"],
    header: "x-session-affinity",
  },
  outputCap: {
    names: ["max_tokens", "max_completion_tokens"],
    fields: ["max_tokens", "max_completion_tokens"],
  },
  streamUsage: { names: ["stream_options", "include_usage"], fields: ["stream_options"] },
} as const satisfies Record<
  string,
  { names: readonly string[]; fields: readonly string[]; header?: string }
>;
type Refusable = keyof typeof REFUSABLE;
const REFUSABLES = Object.keys(REFUSABLE) as Refusable[];
const requestBodySchema = z.looseObject({});
type RequestBody = z.infer<typeof requestBodySchema>;

/**
 * A completion request's JSON body; undefined for any other request. The
 * body is chat content: parsed in memory for this call only.
 */
function requestBody(init: RequestInit | undefined): RequestBody | undefined {
  if (init?.method !== "POST" || typeof init.body !== "string") return undefined;
  try {
    const body = requestBodySchema.safeParse(JSON.parse(init.body));
    return body.success ? body.data : undefined;
  } catch {
    return undefined;
  }
}

const carries = (body: RequestBody, refusable: Refusable) =>
  REFUSABLE[refusable].fields.some((field) => Object.hasOwn(body, field));

/** The request without `dropped`'s fields and headers. */
function without(init: RequestInit, body: RequestBody, dropped: Iterable<Refusable>): RequestInit {
  const rest = { ...body };
  const headers = new Headers(init.headers);
  for (const refusable of dropped) {
    const extension: { fields: readonly string[]; header?: string } = REFUSABLE[refusable];
    for (const field of extension.fields) delete rest[field];
    if (extension.header !== undefined) headers.delete(extension.header);
  }
  return { ...init, body: JSON.stringify(rest), headers };
}

/**
 * An error answer's text, to look for a refused field's name. A clone is
 * read, at most `MAX_REFUSAL_BYTES`, so the answer stays whole for the AI
 * SDK; the text is the provider's message, compared and dropped, never
 * logged. Undefined when it cannot be read.
 */
async function refusalText(response: Response, signal: AbortSignal | undefined) {
  const body = response.clone().body;
  if (body === null) return undefined;
  const bytes = await readBounded(body, MAX_REFUSAL_BYTES, signal).catch(() => undefined);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/**
 * The configured upstream: any OpenAI-compatible provider's chat models.
 * Some providers refuse a field Ephemera sends (`REFUSABLE`): a call they
 * answer with a 400 or 422 naming it is sent once more without it, each
 * field at most once per call; an error that names none is returned as it
 * came. Once a call without the cache key or the stream usage request
 * answers, this upstream sends that one no more; the output cap goes again
 * with the next call, as its value is that call's.
 */
export function createUpstream(
  config: Pick<AppConfig, "upstreamBaseUrl" | "upstreamApiKey" | "upstreamSessionCache">,
  fetch: UpstreamFetch,
  log: Logger,
) {
  const off = { cache: false, streamUsage: false };
  async function send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let request = init;
    if (off.cache) {
      const body = requestBody(init);
      if (init !== undefined && body !== undefined && carries(body, "cache")) {
        request = without(init, body, ["cache"]);
      }
    }
    let response = await fetch(input, request);
    const dropped = new Set<Refusable>();
    while (response.status === 400 || response.status === 422) {
      const body = requestBody(request);
      if (request === undefined || body === undefined) break;
      const carried = REFUSABLES.filter((name) => !dropped.has(name) && carries(body, name));
      if (carried.length === 0) break;
      const text = await refusalText(response, init?.signal ?? undefined);
      if (text === undefined) break;
      const refused = carried.filter((name) =>
        REFUSABLE[name].names.some((field) => text.includes(field)),
      );
      if (refused.length === 0) break;
      for (const name of refused) dropped.add(name);
      await response.body?.cancel().catch(() => {});
      request = without(request, body, refused);
      response = await fetch(input, request);
    }
    if (response.ok) {
      if (dropped.has("cache") && !off.cache) {
        off.cache = true;
        log.warn({ event: "upstream.cache_extensions_off" });
      }
      if (dropped.has("streamUsage") && !off.streamUsage) {
        off.streamUsage = true;
        log.warn({ event: "upstream.stream_usage_off" });
      }
    }
    return response;
  }
  const provider = createOpenAICompatible({
    name: UPSTREAM_PROVIDER,
    baseURL: config.upstreamBaseUrl,
    // None sends no Authorization header, for a local server that needs no key.
    ...(config.upstreamApiKey === undefined ? {} : { apiKey: config.upstreamApiKey }),
    includeUsage: true,
    // The provider's own hook leaves the usage request out once the upstream refused it.
    transformRequestBody: (body) => {
      if (!off.streamUsage) return body;
      const { stream_options: _usage, ...rest } = body;
      return rest;
    },
    // Bun's fetch type adds `preconnect`; a no-op keeps the wrapper assignable in every runtime.
    fetch: Object.assign(send, { preconnect: () => {} }),
  });
  return {
    /** A call's settings (`upstreamSettings`), its cache key left out while the session cache is off. */
    settings(settings: CallSettings, cacheKey: string | undefined) {
      return upstreamSettings(settings, config.upstreamSessionCache ? cacheKey : undefined);
    },
    /**
     * The chat model for an id. Reasoning a model writes inside its answer,
     * in a leading block of `tag` (the creator's and memory's `think`, or a
     * chat preset's Auto-Parse tag), is read out as reasoning (reasoning.ts),
     * so no parser sees it; a null tag reads none.
     */
    model(
      id: string,
      tag: string | null = DEFAULT_PROMPT_REASONING.tag,
      recording?: { recorder: CallRecorder; purpose: CallPurpose },
    ): Exclude<LanguageModel, string> {
      const model = provider.chatModel(id);
      const reasoned =
        tag === null
          ? model
          : wrapLanguageModel({ model, middleware: startReasoningMiddleware(tag) });
      return recording === undefined
        ? reasoned
        : wrapLanguageModel({
            model: reasoned,
            middleware: recording.recorder.middleware(recording.purpose, id),
          });
    },
  };
}

export type Upstream = ReturnType<typeof createUpstream>;
