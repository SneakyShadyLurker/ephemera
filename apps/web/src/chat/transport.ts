import {
  type CallAccounting,
  CHAT_DATA_PARTS,
  callAccountingSchema,
  type GenerateRequest,
  type InspectedPrompt,
  inspectedPromptSchema,
  type PreviewRequest,
  previewResponseSchema,
  promptUsageSchema,
  type RefusalCode,
  refusalCodeSchema,
  streamFailureSchema,
  UPSTREAM_BUSY,
} from "@ephemera/core";
import {
  isReasoningUIPart,
  isTextUIPart,
  parseJsonEventStream,
  readUIMessageStream,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from "ai";
import { z } from "zod";
import { api } from "../api.ts";
import { refusedBeforeCall } from "../model-call.ts";
import { SignedOut } from "../signin/signin.ts";

const refusalSchema = z.object({ error: refusalCodeSchema });

type FailureReason = "http" | "stream" | "aborted" | "refused" | "signed_out";

export class GenerationError extends Error {
  override name = "GenerationError";
  readonly reason: FailureReason;
  readonly code: RefusalCode | undefined;
  /** The stream said the model's provider stayed busy through the server's retries. */
  readonly busy: boolean;
  constructor(reason: FailureReason, code?: RefusalCode, busy = false) {
    super(`Generation failed (${reason})`);
    this.reason = reason;
    this.code = code;
    this.busy = busy;
  }
}

/** Provider-ended partial replies, using the SDK's exact finish reason spelling. */
export type PartialReplyFinishReason = "length" | "content-filter";

/** The reply so far, with the exact prompt sent and, at the end, the model's own count. */
export interface ReplyUpdate {
  accounting?: CallAccounting;
  text: string;
  /** A provider-ended partial reply; exact SDK spelling, separate from transport failure. */
  finishReason?: PartialReplyFinishReason;
  /**
   * The model's reasoning so far; chat content, shown apart. It goes back to
   * the model only when the prompt preset's Add to Prompts says so.
   */
  reasoning?: string;
  prompt?: InspectedPrompt;
  inputTokens?: number;
  /** Of `inputTokens`, how many the provider read from its prompt cache. */
  cachedTokens?: number;
  /** What the model wrote, when the provider says. */
  outputTokens?: number;
  /** Of `outputTokens`, how many were reasoning, when the provider says. */
  reasoningTokens?: number;
}

type ParsedChunk =
  ReturnType<typeof parseJsonEventStream<UIMessageChunk>> extends ReadableStream<infer T>
    ? T
    : never;

async function refusal(response: Response): Promise<RefusalCode | undefined> {
  const parsed = refusalSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data.error : undefined;
}

/** Streams one reply from the server. */
export async function* streamReply(
  request: GenerateRequest,
  signal: AbortSignal,
): AsyncGenerator<ReplyUpdate> {
  let response: Awaited<ReturnType<typeof api.chat.$post>>;
  try {
    response = await api.chat.$post({ json: request }, { init: { signal } });
  } catch (error) {
    // Refused before anything was generated: the store waits for the session.
    // A stale refusal also waits: signed in again, the store retries it at once.
    if (error instanceof SignedOut) throw new GenerationError("signed_out");
    throw error;
  }
  if (!response.ok || response.body === null) {
    const code = response.body === null ? undefined : await refusal(response);
    throw code === undefined && !refusedBeforeCall(response.status)
      ? new GenerationError("http")
      : new GenerationError("refused", code);
  }

  const seen = { finish: false, error: false, abort: false, busy: false };
  const extra: Omit<ReplyUpdate, "text"> = {};
  const chunks = parseJsonEventStream({
    stream: response.body,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream<ParsedChunk, UIMessageChunk>({
      transform(parsed, controller) {
        if (!parsed.success) throw parsed.error;
        const chunk = parsed.value;
        // The prompt part is the inspector's, validated at this boundary; the message never holds it.
        if (chunk.type === CHAT_DATA_PARTS.prompt) {
          extra.prompt = inspectedPromptSchema.parse(chunk.data);
          return;
        }
        if (chunk.type === CHAT_DATA_PARTS.usage) {
          extra.accounting = callAccountingSchema.parse(chunk.data);
          return;
        }
        if (chunk.type === "finish") {
          if (chunk.finishReason === "length" || chunk.finishReason === "content-filter")
            extra.finishReason = chunk.finishReason;
          const usage = promptUsageSchema.safeParse(chunk.messageMetadata);
          if (usage.success) {
            extra.inputTokens = usage.data.inputTokens;
            if (usage.data.cachedTokens !== undefined) extra.cachedTokens = usage.data.cachedTokens;
            if (usage.data.outputTokens !== undefined) extra.outputTokens = usage.data.outputTokens;
            if (usage.data.reasoningTokens !== undefined)
              extra.reasoningTokens = usage.data.reasoningTokens;
          }
        }
        if (chunk.type === "finish" || chunk.type === "error" || chunk.type === "abort") {
          seen[chunk.type] = true;
        }
        // The error's text is a content-free code (core's streamFailureSchema).
        if (chunk.type === "error") {
          seen.busy = streamFailureSchema.safeParse(chunk.errorText).data === UPSTREAM_BUSY;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  // readUIMessageStream ends quietly on stream errors, aborts included; record them instead.
  let failed = false;
  const messages = readUIMessageStream({
    stream: chunks,
    onError: () => {
      failed = true;
    },
  });
  let text = "";
  let reasoning = "";
  let promptShown = false;
  for await (const message of messages) {
    text = message.parts
      .filter(isTextUIPart)
      .map((part) => part.text)
      .join("");
    reasoning = message.parts
      .filter(isReasoningUIPart)
      .map((part) => part.text)
      .join("");
    promptShown ||= extra.prompt !== undefined;
    yield { text, reasoning, ...extra };
  }
  // A request that failed before any output was still sent: the inspector shows it.
  if ((!promptShown && extra.prompt !== undefined) || extra.accounting !== undefined)
    yield { text, reasoning, ...extra };
  signal.throwIfAborted();
  // The server ended the generation, e.g. at its lifetime bound.
  if (seen.abort) throw new GenerationError("aborted");
  // A reply is complete only when the server said so; a cut stream is a failure.
  if (failed || seen.error || !seen.finish) {
    throw new GenerationError("stream", undefined, seen.busy);
  }
  yield { text, reasoning, ...extra };
}

export type PreviewResult =
  | { ok: true; prompt: InspectedPrompt }
  | { ok: false; error: RefusalCode | "unavailable" };

/** What sending now would send: assembled by the server, nothing sent upstream. */
export async function fetchPreview(
  request: PreviewRequest,
  signal: AbortSignal,
): Promise<PreviewResult> {
  const response = await api.chat.preview.$post({ json: request }, { init: { signal } });
  if (!response.ok) return { ok: false, error: (await refusal(response)) ?? "unavailable" };
  const parsed = previewResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success
    ? { ok: true, prompt: parsed.data.prompt }
    : { ok: false, error: "unavailable" };
}
