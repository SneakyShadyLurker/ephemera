import {
  type AnswerBlock,
  ART_KEEPALIVE,
  ART_STREAM_TYPE,
  type ArtStreamEvent,
  applySheetPatch,
  artBatchGuard,
  artMetaprompt,
  artPrompt,
  type BlockTokens,
  blankCard,
  CARD_SYSTEM_PROMPTS,
  type CallPurpose,
  type CallSettings,
  type CardProblem,
  CREATOR_ART,
  CREATOR_LIMITS,
  type CreatorArtStatus,
  type CreatorCardErrorCode,
  type CreatorCardEvent,
  type CreatorErrorCode,
  type CreatorImageCardErrorCode,
  type CreatorImageCardEvent,
  type CreatorKind,
  cardPrompt,
  cardRetryPrompt,
  creatorArtRequestSchema,
  creatorArtStatusQuerySchema,
  creatorArtStatusSchema,
  creatorCardEventSchema,
  creatorCardRequestSchema,
  creatorImageCardEventSchema,
  creatorKindSchema,
  creatorOutputTokens,
  encodeArtFrame,
  fitsNativeFile,
  type GeneratedCard,
  imageCardPrompt,
  incompleteForAutomaticKeep,
  type ModelInfo,
  parseReworkAnswer,
  REWORK_LIMITS,
  REWORK_SYSTEM_PROMPT,
  type ReasoningEffort,
  type ReworkEvent,
  randomSeed,
  reworkEventSchema,
  reworkPrompt,
  reworkRequestSchema,
  type Settings,
  toSheetFields,
  validateCardAnswer,
  WORKFLOW_LIMITS,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { type FinishReason, generateText, type ModelMessage, streamText } from "ai";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Catalog } from "./catalog.ts";
import {
  type CatalogFor,
  type RunWorkflow,
  runWorkflow,
  type WorkflowCatalog,
} from "./comfyui/catalog.ts";
import { type Comfyui, ComfyuiError, type ComfyuiStatus } from "./comfyui/client.ts";
import type { WorkflowId } from "./comfyui/workflow.ts";
import { toPortrait, toSceneReference, toVisionImage } from "./images.ts";
import { boundedBody, requestLifetime, timedOut } from "./lifetime.ts";
import { errorClass, type Logger } from "./log.ts";
import { promptRoom } from "./object-call.ts";
import { IMAGE_CARD_PATH } from "./paths.ts";
import type { Portrait } from "./persistence/store.ts";
import { chosenPersona } from "./personas.ts";
import {
  fileBytes,
  imageRefused,
  invalid,
  invalidRequest,
  MAX_JSON_BYTES,
  MAX_REQUEST_BYTES,
} from "./routes.ts";
import { type StreamContext, streamedResponse, streamSignal } from "./streams.ts";
import { countText } from "./tokens.ts";
import {
  busyCode,
  type CallEvents,
  type CallFailure,
  effortSettings,
  logCallError,
  requestCacheKey,
  resolveModel,
  streamLogging,
  type Upstream,
  waitOf,
} from "./upstream.ts";
import type { CallRecorder } from "./usage.ts";
import type { UserEnv } from "./user.ts";

/*
 * AI card creation (PRINCIPLES.md 1). The owner's description, the card the
 * model writes, the image prompt and the four portraits are creation drafts:
 * they live in this request's memory only, stream to the browser as NDJSON
 * and are never written, cached or logged. A chosen persona joins the
 * description in the prompt, as it joins a chat's. A rework's request, the
 * card the browser sends, the stored portrait and the answer are drafts in
 * the same way. An image card's upload, notes and answer are drafts too;
 * only the card it keeps, with its portrait, is written.
 */

/** Largest accepted creator request body: a description or an art source, JSON-escaped. */
export const MAX_CREATOR_BODY_BYTES = 1024 * 1024;
/** The art request's own lifetime: an image prompt, then a ComfyUI batch of four. */
export const ART_TIMEOUT_MS = 10 * 60_000;
/** Most one `thinking` event a second: the browser shows that the model thinks, nothing of what. */
const THINKING_INTERVAL_MS = 1_000;
/** Largest accepted rework body: the sheet's fields and the whole lorebook, as a character edit carries. */
export const MAX_REWORK_BODY_BYTES = MAX_JSON_BYTES;
/** Image card requests running at once; bounds the decode load (two 25-megapixel decodes). */
const IMAGE_CARD_MAX_IN_FLIGHT = 2;
/** Seconds a refused image card request is told to wait. */
const IMAGE_CARD_RETRY_AFTER_S = 10;

/**
 * The image card form: the image, the caller's id for the character, the
 * card's kind (a Subject card when absent), optional notes and the owner's
 * optional direction.
 */
const imageCardFormSchema = z.object({
  file: z.instanceof(File),
  id: z.uuid(),
  kind: creatorKindSchema.default("subject"),
  notes: z.string().trim().max(CREATOR_LIMITS.descriptionLength).optional(),
  direction: z.string().trim().max(CREATOR_LIMITS.imageCardDirectionLength).optional(),
});

/** Hands the admitted request's slot to its stream, which releases it when it ends. */
type ImageCardEnv = { Variables: { imageCardSlot: () => () => void } };

/**
 * The requester's stores (user.ts) give a card request's persona, whose text
 * goes to the model as written, macros included; a rework's character, which
 * must still exist and whose stored portrait may go to the model; an image
 * card's character, which is created there; and the settings.
 */
export interface CreatorDeps {
  log: Logger;
  /** The model catalog: a call's context window, efforts and whether the model reads images. */
  catalog: Pick<Catalog, "current">;
  /** The configured upstream's chat models (api.ts). */
  upstream: Upstream;
  comfyui: Comfyui;
  /** The requester's workflows and the server's, built for each request (api.ts). */
  catalogFor: CatalogFor;
  /** The card request's lifetime: chat's. */
  requestTimeoutMs: number;
  onStreamingRequest?: (request: Request) => void;
  /** The process is stopping (index.ts): every creator run ends, and ComfyUI cleanup follows. */
  stopping?: AbortSignal;
}

/** Each creator route's error event, one name for every failure it logs. */
const CARD_ERROR = "creator.card.error";
const REWORK_ERROR = "creator.rework.error";
const ART_ERROR = "creator.art.error";
const IMAGE_CARD_ERROR = "creator.image_card.error";

/** A streamed call's log events, by route. */
const CARD_EVENTS: CallEvents = {
  error: CARD_ERROR,
  end: "creator.card.end",
  abort: "creator.card.abort",
};
const IMAGE_CARD_EVENTS: CallEvents = {
  error: IMAGE_CARD_ERROR,
  end: "creator.image_card.end",
  abort: "creator.image_card.abort",
};
const REWORK_EVENTS: CallEvents = {
  error: REWORK_ERROR,
  end: "creator.rework.end",
  abort: "creator.rework.abort",
};

/**
 * One JSON event per line (`streamedResponse`), each checked against its
 * core schema before it is written. Cancelling the body (the client went
 * away) aborts `run`'s signal, as do the request's deadline and the process
 * stopping.
 */
function eventStream<Event>(
  c: StreamContext,
  schema: z.ZodType<Event>,
  stopping: AbortSignal | undefined,
  /** Where a run that throws is logged: the route's own error event, class only. */
  failure: { log: Logger; event: string },
  run: (send: (event: Event) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const { cancelled, signal } = streamSignal(c, stopping);
  /*
   * Runs send a typed error for every failure they expect, saving included;
   * only an event that fails its schema, or an unexpected throw such as a
   * failed store read, ends the stream as `invalid_event`.
   */
  return streamedResponse(
    c,
    {
      contentType: "application/x-ndjson; charset=utf-8",
      cancelled,
      failure: { ...failure, code: "invalid_event" },
    },
    (write) => run((event) => write(`${JSON.stringify(schema.parse(event))}\n`), signal),
  );
}

/** The art stream: control events and raw PNG frames, with keepalives between them. */
export function artEventStream(
  c: StreamContext,
  stopping: AbortSignal | undefined,
  failure: { log: Logger; event: string },
  run: (send: (event: ArtStreamEvent) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const { cancelled, signal } = streamSignal(c, stopping);
  const guard = artBatchGuard();
  return streamedResponse(
    c,
    {
      contentType: ART_STREAM_TYPE,
      cancelled,
      failure: { ...failure, code: "invalid_event" },
      keepalive: ART_KEEPALIVE,
    },
    (write) =>
      run((event) => {
        guard(event);
        write(encodeArtFrame(event));
      }, signal),
  );
}

/** Estimated tokens of each subject block, or of a Scenario's whole description, against its cap. */
function blockTokens(kind: CreatorKind, card: GeneratedCard, blocks: AnswerBlock[]): BlockTokens[] {
  if (kind === "scenario") {
    return [
      {
        block: "description",
        tokens: countText(card.description),
        cap: CREATOR_LIMITS.scenarioDescriptionTokens,
      },
    ];
  }
  return blocks.map((block) => ({
    block: block.name,
    tokens: countText(block.text),
    cap: CREATOR_LIMITS.subjectBlockTokens,
  }));
}

/** How a missing list names a loader input left without a file. */
const NO_FILE = "(no file chosen)";

/**
 * A missing list as the status answer carries it: distinct names, each cut to
 * the length cap, at most the count cap, an empty one shown as no file
 * chosen. An imported graph can name more, or longer, files than the answer
 * holds.
 */
export function shownNames(names: readonly string[]): string[] {
  const shown = names.map((name) =>
    name.length === 0 ? NO_FILE : name.slice(0, WORKFLOW_LIMITS.missingNameLength),
  );
  return [...new Set(shown)].slice(0, WORKFLOW_LIMITS.missingNames);
}

/** The client's status as the route reports it; node and model names are configuration. */
function artStatus(status: ComfyuiStatus): CreatorArtStatus {
  if (!status.reachable) {
    const { reason } = status;
    if (
      reason === "not_allowed" ||
      reason === "unauthorized" ||
      reason === "not_ready" ||
      reason === "insecure"
    )
      return { state: "unavailable", reason };
    if (reason === "invalid_response" || reason === "oversized") {
      return { state: "unavailable", reason: "invalid_response" };
    }
    return { state: "unavailable", reason: "unreachable" };
  }
  const nodes = shownNames(status.missingNodes);
  const models = shownNames(status.missingModels);
  return nodes.length === 0 && models.length === 0
    ? { state: "ready" }
    : { state: "missing", nodes, models };
}

/**
 * Admits at most `IMAGE_CARD_MAX_IN_FLIGHT` image card requests before any
 * body is read. The slot is released when the request answers without a
 * stream, or, once the handler takes it, when the stream's run ends.
 */
function imageCardAdmission() {
  let inFlight = 0;
  return createMiddleware<ImageCardEnv>(async (c, next) => {
    if (inFlight >= IMAGE_CARD_MAX_IN_FLIGHT) {
      return c.json({ error: "busy" as const }, 429, {
        "Retry-After": String(IMAGE_CARD_RETRY_AFTER_S),
      });
    }
    inFlight += 1;
    let held = true;
    let taken = false;
    const release = () => {
      if (held) inFlight -= 1;
      held = false;
    };
    c.set("imageCardSlot", () => {
      taken = true;
      return release;
    });
    try {
      await next();
    } finally {
      if (!taken) release();
    }
  });
}

/** One streamed call: its answer, kept in the request's memory, and how the call ended. */
interface CardCall {
  answer: string;
  /** The call failed, or the request's signal ended it. */
  failed: boolean;
  /** The error the call reported, when it did. */
  failure: CallFailure | undefined;
  finish: FinishReason | undefined;
}

/** Why a card run ended before its answer was checked. */
type CardCallEnd = Exclude<CreatorCardErrorCode, "too_large">;

/** A run that ended before its answer was checked, with a busy provider's wait. */
interface Ended {
  end: CardCallEnd;
  retryAfterS?: number;
}

/** A failed call's code: a busy provider, the deadline, or any other failure. */
export const failedCode = (failure: CallFailure | undefined, signal: AbortSignal) =>
  failure?.busy === true
    ? busyCode(failure)
    : { code: timedOut(signal) ? ("timeout" as const) : ("upstream" as const) };

/**
 * A user turn of `text`, after the image when one goes: AI SDK 7's user file
 * part, which @ai-sdk/openai-compatible 3.0.71 sends as `{ type: "image_url",
 * image_url: { url: "data:image/jpeg;base64,..." } }`.
 */
export const userTurn = (text: string, image?: Uint8Array): ModelMessage => ({
  role: "user",
  content:
    image === undefined
      ? text
      : [
          { type: "file", data: image, mediaType: "image/jpeg" },
          { type: "text", text },
        ],
});

/**
 * The workflow an art or scene run takes, resolved before any stream opens:
 * the one the request names or else the saved one. Undefined, for an unknown
 * id or one with classes the allowlist no longer admits, refuses the request.
 */
export function admittedWorkflow(
  catalog: WorkflowCatalog,
  named: WorkflowId | undefined,
  saved: WorkflowId,
): RunWorkflow | undefined {
  const id = catalog.requested(named, saved);
  if (id === undefined) return undefined;
  const workflow = runWorkflow(catalog, id);
  return workflow.blocked.length > 0 ? undefined : workflow;
}

/** What an art run paints from: the route's own source for the image prompt. */
export interface ArtSource {
  /** The stored portrait (PNG) that goes to a model reading images, read where its failure answers `reference`. */
  portrait?: () => Promise<Uint8Array | undefined>;
  /** Whether the portrait's top third also goes to the workflow's reference graph. */
  referenceGraph?: boolean;
  instructions: string;
  /** The user text, told whether the portrait goes with it. */
  text: (portrait: boolean) => string;
}

/**
 * One art run, the art route's and the scene's: the model writes an image
 * prompt from the route's source, the vision copy of a portrait before the
 * text, then ComfyUI paints `count` pictures. Every failure is sent as an
 * error event and logged under `${event}.error` or `${event}.comfyui`, by
 * class only; an owner who stopped or left ends the run with an abort log.
 */
export async function paint(
  deps: Pick<CreatorDeps, "log" | "catalog" | "upstream" | "comfyui">,
  options: {
    event: "creator.art" | "scene";
    model: string;
    reasoning: ReasoningEffort | undefined;
    settings: Settings;
    /** Resolved when the request was admitted, so a delete or replace since changes nothing. */
    workflow: RunWorkflow;
    count: number;
    /** The route's source once the model is known; `not_found` when its character is gone. */
    source: (info: ModelInfo | undefined) => ArtSource | "not_found";
    recording?: { recorder: CallRecorder; purpose: CallPurpose };
    send: (event: ArtStreamEvent) => void;
    signal: AbortSignal;
  },
): Promise<void> {
  const { log, catalog, upstream, comfyui } = deps;
  const { event, model, settings, workflow, send, signal } = options;
  const baseUrl = settings.comfyuiBaseUrl;
  if (baseUrl === "") return send({ type: "error", code: "not_configured" });
  // An address saved before the server stopped allowing its origin: nothing is sent anywhere.
  if (!comfyui.allows(baseUrl)) {
    log.warn({ event: `${event}.comfyui`, model, errorClass: "not_allowed" });
    return send({ type: "error", code: "not_allowed" });
  }
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  /** The vision copy of the stored portrait (images.ts), when one goes to the model. */
  let portrait: Uint8Array | undefined;
  /** The owner stopped the picture or left: an ended run, not a failure. */
  const ended = () => {
    if (!signal.aborted || timedOut(signal)) return false;
    log.info({
      event: `${event}.abort`,
      model,
      reference: portrait !== undefined,
      durationMs: elapsed(),
    });
    return true;
  };
  // What the model offers: the effort it is sent at and whether it reads a reference.
  const resolved = await resolveModel(catalog, model, settings, signal);
  if (resolved === null) {
    if (!ended()) send({ type: "error", code: "timeout" });
    return;
  }
  const source = options.source(resolved.info);
  if (source === "not_found") {
    log.warn({ event: `${event}.error`, model, errorClass: "CharacterNotFound" });
    return send({ type: "error", code: "not_found" });
  }
  /** The face reference the private worker's reference graph loads. */
  let reference: Uint8Array<ArrayBuffer> | undefined;
  if (source.portrait !== undefined) {
    try {
      const stored = await source.portrait();
      if (stored !== undefined) {
        if (resolved.info?.images !== false) portrait = await toVisionImage(stored);
        if (source.referenceGraph === true && workflow.reference !== undefined) {
          reference = await toSceneReference(stored);
        }
        if (ended()) return;
      }
    } catch (error) {
      if (ended()) return;
      log.error({ event: `${event}.error`, model, errorClass: errorClass(error) });
      return send({ type: "error", code: "reference" });
    }
  }
  send({ type: "progress", phase: "prompt", value: 0, max: 1 });
  let prompt: string;
  try {
    const result = await generateText({
      model: upstream.model(model, undefined, options.recording),
      instructions: source.instructions,
      messages: [userTurn(source.text(portrait !== undefined), portrait)],
      maxOutputTokens: creatorOutputTokens(resolved.info),
      ...upstream.settings(effortSettings(resolved.info, options.reasoning), requestCacheKey()),
      // Ends the call, retries' waits included, when the owner stops or the deadline passes.
      abortSignal: signal,
    });
    prompt = result.text.trim();
  } catch (error) {
    if (ended()) return;
    const failure = logCallError(log, { event: `${event}.error`, model }, error);
    return send({ type: "error", ...failedCode(failure, signal) });
  }
  if (prompt === "") {
    log.warn({ event: `${event}.error`, model, errorClass: "EmptyImagePrompt" });
    return send({ type: "error", code: "upstream" });
  }
  send({ type: "progress", phase: "prompt", value: 1, max: 1 });

  let referenceGraph = false;
  try {
    const run = comfyui.generate({
      baseUrl,
      workflow,
      prompt,
      seed: randomSeed(),
      count: options.count,
      ...(reference === undefined ? {} : { reference }),
      signal,
    });
    for await (const progress of run) {
      if (progress.type === "progress") {
        send(progress);
        continue;
      }
      referenceGraph = progress.referenceGraph;
      for (const [index, png] of progress.pngs.entries()) {
        send({ type: "image", index, png: new Uint8Array(png) });
      }
    }
  } catch (error) {
    if (ended()) return;
    const code: CreatorErrorCode = error instanceof ComfyuiError ? error.code : "comfyui";
    log.error({
      event: `${event}.comfyui`,
      model,
      errorClass: error instanceof ComfyuiError ? error.reason : errorClass(error),
      durationMs: elapsed(),
    });
    return send({ type: "error", code });
  }
  log.info({
    event: `${event}.end`,
    model,
    reference: portrait !== undefined,
    referenceGraph,
    durationMs: elapsed(),
  });
  send({ type: "done" });
}

/**
 * The end of an answer that is not checked: a failure, the output ceiling or
 * the filter. None when the answer finished normally and goes to its check.
 */
function cardCallEnd(
  { failed, failure, finish }: CardCall,
  signal: AbortSignal,
): Ended | undefined {
  if (failed) {
    const { code, ...wait } = failedCode(failure, signal);
    return { end: code, ...wait };
  }
  if (finish === "length") return { end: "cut" };
  if (finish === "content-filter") return { end: "filtered" };
  return undefined;
}

/**
 * A card written as both card routes write it: a call that ends unchecked
 * (`cardCallEnd`) ends the run. An answer that finished normally and fails
 * `check` is written once more in the same request, with the answer and its
 * correction sent back, when that still fits the window.
 */
async function writeCheckedCard<Checked extends { ok: boolean }>(options: {
  write: (messages: ModelMessage[], attempt: 1 | 2) => Promise<CardCall>;
  /** The request's user turn: the description, or an image and its text. */
  user: ModelMessage;
  signal: AbortSignal;
  check: (answer: string) => Checked;
  /** The user turn after a rejected answer (core's `cardRetryPrompt`). */
  correction: (checked: Checked) => string;
  /** Whether the request, the first answer and the correction fit the window. */
  fits: (answer: string, correction: string) => boolean;
  /** The retry is starting. */
  onRetry: (checked: Checked) => void;
}): Promise<Ended | { end?: undefined; checked: Checked }> {
  const { write, user, signal, check } = options;
  const first = await write([user], 1);
  const firstEnd = cardCallEnd(first, signal);
  if (firstEnd !== undefined) return firstEnd;
  const checked = check(first.answer);
  if (checked.ok) return { checked };
  const correction = options.correction(checked);
  if (!options.fits(first.answer, correction)) return { checked };
  // One more call in the same request: the answer and what it lacks go back to the model.
  // An empty answer (all of it reasoning, say) has nothing to correct, and an empty
  // assistant turn is one some backends refuse, so it is asked for again from the start.
  options.onRetry(checked);
  const second = await write(
    first.answer.trim() === ""
      ? [user]
      : [user, { role: "assistant", content: first.answer }, { role: "user", content: correction }],
    2,
  );
  const secondEnd = cardCallEnd(second, signal);
  if (secondEnd !== undefined) return secondEnd;
  return { checked: check(second.answer) };
}

/** An image card's check: the validator's, then the stricter bar for a keep without review. */
type ImageCardCheck =
  | { ok: true; card: GeneratedCard }
  | { ok: false; problems: CardProblem[]; empty: string[] };

export function createCreatorApi(deps: CreatorDeps) {
  const { log, catalog, upstream, comfyui } = deps;

  /**
   * One streamed call, a card's, an image card's or a rework's, through a
   * model that reads a leading `<think>` block out as reasoning (upstream.ts),
   * so the answer's parser never sees it. The answer stays in this request's
   * memory; an in-stream error ends the call at once.
   */
  async function writeCard(options: {
    model: string;
    instructions: string;
    messages: ModelMessage[];
    /** The model's catalog entry, for its output limit (`creatorOutputTokens`). */
    info: ModelInfo | undefined;
    /** The effort, narrowed to the model's (`effortSettings`); none sends the model default. */
    settings: CallSettings;
    /** The request's cache key, the same for its retry. */
    cacheKey: string;
    signal: AbortSignal;
    /** Which call of the request this is, for a route that retries. */
    attempt?: 1 | 2;
    /** The route's log events. */
    events: CallEvents;
    /** Text as written, for a route that streams it. */
    onText?: (text: string) => void;
    /** The model is reasoning, for a route that says so. */
    onReasoning?: () => void;
  }): Promise<CardCall> {
    const { model, attempt, signal } = options;
    // Ends this call alone, at once, when the stream reports an error.
    const call = new AbortController();
    let failed = false;
    const logging = streamLogging(log, options.events, {
      model,
      ...(attempt === undefined ? {} : { attempt }),
    });
    const result = streamText({
      model: upstream.model(model),
      instructions: options.instructions,
      messages: options.messages,
      maxOutputTokens: creatorOutputTokens(options.info),
      ...upstream.settings(options.settings, options.cacheKey),
      // Ends upstream work, retries' waits included, when the client disconnects or the
      // lifetime bound passes.
      abortSignal: AbortSignal.any([signal, call.signal]),
      ...logging.callbacks,
      onError: (event) => {
        failed = true;
        logging.callbacks.onError(event);
      },
    });
    let answer = "";
    let finish: FinishReason | undefined;
    try {
      for await (const part of result.stream) {
        if (part.type === "text-delta" && part.text !== "") {
          answer += part.text;
          options.onText?.(part.text);
        } else if (part.type === "reasoning-delta") {
          options.onReasoning?.();
        } else if (part.type === "finish") {
          finish = part.finishReason;
        } else if (part.type === "error") {
          failed = true;
          call.abort();
          break;
        }
      }
    } catch {
      failed = true;
    }
    return { answer, failed: failed || signal.aborted, failure: logging.failure(), finish };
  }

  return new Hono<UserEnv>()
    .post(
      "/card",
      requestLifetime(deps.requestTimeoutMs, deps.onStreamingRequest),
      boundedBody(MAX_CREATOR_BODY_BYTES),
      zValidator("json", creatorCardRequestSchema, invalid),
      (c) => {
        const { kind, description, model, reasoning, personaId } = c.req.valid("json");
        // A persona deleted since it was chosen leaves {{user}} to the description, as in chat.
        const prompt = cardPrompt(
          description,
          chosenPersona(c.var.user.stores.personas, personaId),
        );
        const instructions = CARD_SYSTEM_PROMPTS[kind];
        // The run reads the requester's settings after the handler returned.
        const { stores, calibration } = c.var.user;
        const { settings } = stores;
        return eventStream<CreatorCardEvent>(
          c,
          creatorCardEventSchema,
          deps.stopping,
          { log, event: CARD_ERROR },
          async (send, signal) => {
            const failure = (): CreatorCardErrorCode => (timedOut(signal) ? "timeout" : "upstream");
            // An unknown window does not refuse: the catalog reports none for some models.
            const resolved = await resolveModel(catalog, model, settings.get(), signal);
            if (resolved === null) return send({ type: "error", code: failure() });
            const { window } = resolved;
            // One cache key for the request's calls, its retry included.
            const cacheKey = requestCacheKey();
            const fits = (...retry: string[]) =>
              window === null ||
              promptRoom(window.tokens, calibration.get(model) ?? 1, [
                instructions,
                prompt,
                ...retry,
              ]) !== null;
            if (!fits()) {
              log.warn({ event: CARD_ERROR, model, errorClass: "PromptTooLarge" });
              return send({ type: "error", code: "too_large" });
            }

            let thought = Number.NEGATIVE_INFINITY;
            const run = await writeCheckedCard({
              write: (messages, attempt) =>
                writeCard({
                  model,
                  instructions,
                  messages,
                  info: resolved.info,
                  // The effort as the model offers it, whatever the tab's catalog said.
                  settings: effortSettings(resolved.info, reasoning),
                  cacheKey,
                  signal,
                  attempt,
                  events: CARD_EVENTS,
                  onText: (text) => send({ type: "delta", text }),
                  onReasoning: () => {
                    // That the model thinks, never what: at most one event a second.
                    const now = performance.now();
                    if (now - thought >= THINKING_INTERVAL_MS) {
                      thought = now;
                      send({ type: "thinking" });
                    }
                  },
                }),
              user: { role: "user", content: prompt },
              signal,
              check: (answer) => validateCardAnswer(kind, answer),
              correction: (checked) => (checked.ok ? "" : cardRetryPrompt(checked.problems)),
              // The retry carries the first answer back: it runs only when that still fits the window.
              fits: (answer, correction) => fits(answer, correction),
              onRetry: (checked) => {
                if (!checked.ok) send({ type: "retry", problems: checked.problems });
              },
            });
            if (run.end !== undefined) {
              return send({ type: "error", code: run.end, ...waitOf(run) });
            }
            const { checked } = run;
            send(
              checked.ok
                ? {
                    type: "result",
                    validation: { ok: true },
                    tokens: blockTokens(kind, checked.card, checked.blocks),
                  }
                : {
                    type: "result",
                    validation: { ok: false, problems: checked.problems },
                    tokens: [],
                  },
            );
          },
        );
      },
    )
    .post(
      IMAGE_CARD_PATH,
      requestLifetime(deps.requestTimeoutMs, deps.onStreamingRequest),
      imageCardAdmission(),
      boundedBody(MAX_REQUEST_BYTES),
      zValidator("form", imageCardFormSchema, invalid),
      async (c) => {
        const { file, id, kind, notes, direction } = c.req.valid("form");
        // The requester's own instance: a kept character, and the retry that finds it, stay theirs.
        const { user } = c.var;
        const { characters, settings } = user.stores;
        // A replayed id (a retry after a lost result) names the kept character, with no image or model work.
        const kept = characters.get(id);
        if (kept !== undefined) {
          return eventStream<CreatorImageCardEvent>(
            c,
            creatorImageCardEventSchema,
            deps.stopping,
            { log, event: IMAGE_CARD_ERROR },
            async (send) => {
              // An earlier save whose flush failed is made durable before its result is named.
              try {
                await user.flushIfDirty();
              } catch (error) {
                log.error({ event: IMAGE_CARD_ERROR, errorClass: errorClass(error) });
                send({ type: "error", code: "save_failed" });
                return;
              }
              send({ type: "result", id, name: kept.card.name });
            },
          );
        }
        let portrait: Portrait;
        /** The model's copy: a small JPEG, since a full PNG can pass a proxy's request body limit. */
        let vision: Uint8Array;
        try {
          portrait = await toPortrait(await fileBytes(file));
          vision = await toVisionImage(portrait.png);
        } catch (error) {
          return imageRefused(c, log, IMAGE_CARD_ERROR, error);
        }
        const given = (field: string | undefined) =>
          field === undefined || field === "" ? null : field;
        const text = imageCardPrompt(kind, given(notes), given(direction));
        const release = c.get("imageCardSlot")();
        return eventStream<CreatorImageCardEvent>(
          c,
          creatorImageCardEventSchema,
          deps.stopping,
          { log, event: IMAGE_CARD_ERROR },
          async (send, signal) => {
            const stopped = () =>
              send({ type: "error", code: timedOut(signal) ? "timeout" : "upstream" });
            const refuse = (
              code: CreatorImageCardErrorCode,
              errorClass: string,
              model?: string,
            ) => {
              log.warn({
                event: IMAGE_CARD_ERROR,
                ...(model === undefined ? {} : { model }),
                errorClass,
              });
              send({ type: "error", code });
            };
            try {
              const saved = settings.get();
              const { model } = saved;
              if (model === null) return refuse("no_model", "NoModel");
              const resolved = await resolveModel(catalog, model, saved, signal);
              if (resolved === null) return stopped();
              // A catalog silent on images proceeds with the image, as rework does.
              if (resolved.info?.images === false) {
                return refuse("text_only_model", "TextOnlyModel", model);
              }
              const { window } = resolved;
              if (window === null) {
                return refuse("context_window_unknown", "ContextWindowUnknown", model);
              }
              const fits = (...retry: string[]) =>
                promptRoom(
                  window.tokens,
                  user.calibration.get(model) ?? 1,
                  [CARD_SYSTEM_PROMPTS[kind], text, ...retry],
                  REWORK_LIMITS.portraitTokens,
                ) !== null;
              if (!fits()) return refuse("too_large", "PromptTooLarge", model);

              send({ type: "status", phase: "writing" });
              const cacheKey = requestCacheKey();
              const run = await writeCheckedCard<ImageCardCheck>({
                write: (messages, attempt) =>
                  // No effort, and no text to the caller: the model writes at its default.
                  writeCard({
                    model,
                    instructions: CARD_SYSTEM_PROMPTS[kind],
                    messages,
                    info: resolved.info,
                    settings: {},
                    cacheKey,
                    signal,
                    attempt,
                    events: IMAGE_CARD_EVENTS,
                  }),
                // The vision copy of the stored portrait, as rework sends it.
                user: userTurn(text, vision),
                signal,
                check: (answer) => {
                  const checked = validateCardAnswer(kind, answer);
                  if (!checked.ok) return { ok: false, problems: checked.problems, empty: [] };
                  const empty = incompleteForAutomaticKeep(kind, checked.card, checked.blocks);
                  return empty.length === 0
                    ? { ok: true, card: checked.card }
                    : { ok: false, problems: [], empty };
                },
                correction: (checked) =>
                  checked.ok ? "" : cardRetryPrompt(checked.problems, checked.empty),
                fits: (answer, correction) => fits(answer, correction),
                onRetry: () => {
                  log.warn({ event: IMAGE_CARD_ERROR, model, errorClass: "UnusableAnswer" });
                  send({ type: "status", phase: "rewriting" });
                },
              });
              /*
               * The caller's codes: a filtered answer is a refusal, which ends as a
               * failed call does; a cut one is an unusable card, never retried.
               */
              if (run.end === "filtered") return refuse("upstream", "ContentFiltered", model);
              if (run.end === "cut") return refuse("invalid_card", "AnswerCut", model);
              if (run.end !== undefined) {
                return send({ type: "error", code: run.end, ...waitOf(run) });
              }
              if (!run.checked.ok) return refuse("invalid_card", "UnusableAnswers", model);
              send({ type: "status", phase: "saving" });
              const fields = toSheetFields(kind, run.checked.card);
              const card = applySheetPatch(blankCard(fields.name), fields);
              if (!fitsNativeFile("ephemera.character", card))
                return refuse("invalid_card", "CardTooLarge", model);
              if (signal.aborted) return stopped();
              let name: string;
              try {
                // The click in Atelier is the user's Keep: the card and its portrait become character data.
                characters.create(card, portrait, id);
                // A concurrent first request with this id may have saved first: name what exists, not this draft.
                const stored = characters.get(id);
                if (stored === undefined) throw new Error("character_missing");
                name = stored.card.name;
                // The result is relied on as kept: the encrypted file holds it before the result is sent.
                await user.flushIfDirty();
              } catch (error) {
                // Also when the create committed and only the read-back or the flush failed.
                log.error({
                  event: IMAGE_CARD_ERROR,
                  model,
                  errorClass: errorClass(error),
                });
                send({ type: "error", code: "save_failed" });
                return;
              }
              send({ type: "result", id, name });
            } catch (error) {
              // Any other fault, such as a failed settings read: one typed error, logged by class.
              log.error({ event: IMAGE_CARD_ERROR, errorClass: errorClass(error) });
              send({ type: "error", code: "internal" });
            } finally {
              release();
            }
          },
        );
      },
    )
    .post(
      "/rework",
      requestLifetime(deps.requestTimeoutMs, deps.onStreamingRequest),
      boundedBody(MAX_REWORK_BODY_BYTES),
      zValidator("json", reworkRequestSchema, invalid),
      (c) => {
        const request = c.req.valid("json");
        const { model, characterId } = request;
        // The run reads the requester's stores after the handler returned.
        const { stores, calibration } = c.var.user;
        const { characters, personas, settings } = stores;
        return eventStream<ReworkEvent>(
          c,
          reworkEventSchema,
          deps.stopping,
          { log, event: REWORK_ERROR },
          async (send, signal) => {
            const refuse = (code: "not_found" | "context_window_unknown" | "too_large") => {
              const errorClass = {
                not_found: "CharacterNotFound",
                context_window_unknown: "ContextWindowUnknown",
                too_large: "PromptTooLarge",
              }[code];
              log.warn({ event: REWORK_ERROR, model, errorClass });
              send({ type: "error", code });
            };
            if (!characters.exists(characterId)) return refuse("not_found");
            // A persona deleted since it was chosen leaves {{user}} to the card, as in chat.
            const persona = chosenPersona(personas, request.personaId);
            const resolved = await resolveModel(catalog, model, settings.get(), signal);
            if (resolved === null) {
              send({ type: "error", code: timedOut(signal) ? "timeout" : "upstream" });
              return;
            }
            const { window } = resolved;
            if (window === null) return refuse("context_window_unknown");
            const reads = resolved.info?.images;
            // The vision copy of the stored PNG (images.ts), small enough for a proxy's body limit.
            const stored =
              request.portrait && reads !== false
                ? (await characters.portrait(characterId, "full"))?.bytes
                : undefined;
            const portrait = stored === undefined ? undefined : await toVisionImage(stored);
            const text = reworkPrompt(
              request.card,
              request.request,
              persona,
              portrait !== undefined,
            );
            const room = promptRoom(
              window.tokens,
              calibration.get(model) ?? 1,
              [REWORK_SYSTEM_PROMPT, text],
              portrait === undefined ? 0 : REWORK_LIMITS.portraitTokens,
            );
            if (room === null) return refuse("too_large");

            // The whole answer stays in this request's memory for the final check.
            const call = await writeCard({
              model,
              instructions: REWORK_SYSTEM_PROMPT,
              messages: [userTurn(text, portrait)],
              info: resolved.info,
              settings: effortSettings(resolved.info, request.reasoning),
              cacheKey: requestCacheKey(),
              signal,
              events: REWORK_EVENTS,
              onText: (text) => send({ type: "delta", text }),
            });
            if (call.failed) return send({ type: "error", ...failedCode(call.failure, signal) });
            /** The model hit its output ceiling, even between two change blocks. */
            const cut = call.finish === "length";
            const { answer } = call;
            const { problems } = parseReworkAnswer(answer);
            send({
              type: "result",
              problems:
                cut && !problems.includes("incomplete") ? ["incomplete", ...problems] : problems,
            });
          },
        );
      },
    )
    .post(
      "/art",
      requestLifetime(ART_TIMEOUT_MS, deps.onStreamingRequest),
      boundedBody(MAX_CREATOR_BODY_BYTES),
      zValidator("json", creatorArtRequestSchema, invalid),
      (c) => {
        const { kind, composition, look, model, reasoning, source, direction, reference, ...body } =
          c.req.valid("json");
        // A Scenario poster has no catalogue; an explicit look is dropped as composition is for other kinds.
        const chosenLook = kind === "scenario" ? null : (look ?? null);
        // The run reads the requester's own stores after the handler returned.
        const { characters } = c.var.user.stores;
        const saved = c.var.user.stores.settings.get();
        const workflow = admittedWorkflow(deps.catalogFor(c), body.workflow, saved.comfyuiWorkflow);
        if (workflow === undefined) return invalidRequest(c);
        return artEventStream(c, deps.stopping, { log, event: ART_ERROR }, (send, signal) =>
          paint(deps, {
            event: "creator.art",
            model,
            reasoning,
            settings: saved,
            workflow,
            count: CREATOR_ART.count,
            /*
             * A reference loads the character's stored portrait from the
             * requester's own instance, so another user's id finds nothing. A
             * text-only model, or a portrait removed since, paints without it.
             */
            source: (info) => {
              if (reference !== undefined && !characters.exists(reference.characterId)) {
                return "not_found";
              }
              return {
                ...(reference === undefined || info?.images === false
                  ? {}
                  : {
                      portrait: async () =>
                        (await characters.portrait(reference.characterId, "full"))?.bytes,
                    }),
                instructions: artMetaprompt(workflow.family, kind, composition),
                text: (portrait) => artPrompt(source, direction ?? null, portrait, chosenLook),
              };
            },
            send,
            signal,
          }),
        );
      },
    )
    .get("/art/status", zValidator("query", creatorArtStatusQuerySchema, invalid), async (c) => {
      const saved = c.var.user.stores.settings.get();
      const baseUrl = saved.comfyuiBaseUrl;
      const catalog = deps.catalogFor(c);
      const id = catalog.requested(c.req.valid("query").workflow, saved.comfyuiWorkflow);
      if (id === undefined) return invalidRequest(c);
      // A blocked workflow answers `missing` with its blocked classes, never refused.
      const workflow = runWorkflow(catalog, id);
      if (baseUrl === "") return c.json(creatorArtStatusSchema.parse({ state: "off" }), 200);
      const status: CreatorArtStatus = comfyui.allows(baseUrl)
        ? artStatus(await comfyui.status({ baseUrl, workflow, signal: c.req.raw.signal }))
        : { state: "unavailable", reason: "not_allowed" };
      if (status.state === "unavailable") {
        log.warn({ event: "creator.art.status", errorClass: status.reason });
      }
      return c.json(creatorArtStatusSchema.parse(status), 200);
    })
    .get("/art/workflows", (c) => c.json(deps.catalogFor(c).list, 200));
}
