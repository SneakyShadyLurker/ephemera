/**
 * A fake OpenAI-compatible upstream for tests. It streams synthetic chat
 * completion chunks, honors abort signals and records what it saw.
 */

import {
  type CastChanges,
  type CastSheetAnswer,
  KEEPER_OPENING,
  SHEET_OPENING,
} from "@ephemera/core";

/** One entry of CLIProxyAPI's model catalog (`/v1/models?client_version=`), fields trimmed. */
export interface CatalogEntry {
  slug: string;
  context_window?: unknown;
  supported_reasoning_levels?: unknown;
  input_modalities?: unknown;
  visibility?: unknown;
}

/** The window every listed model reports unless a test gives its own catalog. */
export const FAKE_WINDOW = 131_072;

export interface FakeUpstreamOptions {
  /** Model ids, each reporting FAKE_WINDOW and every reasoning level. */
  models?: string[];
  /** The whole catalog, instead of `models`. */
  catalog?: CatalogEntry[];
  /** The model list answers 500. */
  catalogDown?: boolean;
  /** The catalog query (`client_version`) answers 404, as a plain OpenAI upstream does; the plain list still answers. */
  catalogQueryMissing?: boolean;
  /** Usage the completion reports; prompt_tokens defaults to 3. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    /** The provider's prompt-cache share; absent, as some providers send it. */
    prompt_tokens_details?: { cached_tokens: number };
    /** The provider's reasoning share of the output; absent, as some providers send it. */
    completion_tokens_details?: { reasoning_tokens: number };
  };
  /** A non-streamed completion reports no usage, as some providers answer. */
  withoutUsage?: boolean;
  /** Content deltas to stream; the reply is their concatenation. */
  chunks?: string[];
  /** Reasoning deltas streamed before the content. */
  reasoning?: string[];
  delayMs?: number;
  /** After the chunks, keep the stream open without sending anything. */
  hang?: boolean;
  /** The last chunk's `finish_reason`; "stop" unless given. */
  finishReason?: string;
  /** Fail the completion with this status, body and headers (a `Retry-After`) instead of streaming. */
  failWith?: { status: number; body: string; headers?: Record<string, string> };
  /** After the chunks, send this message as an in-stream error, then keep the stream open. */
  streamError?: string;
  /** Per completion request in order: its own reply, over the options above. */
  turns?: FakeTurn[];
}

/** One completion's reply, for a test that makes more than one call. */
export type FakeTurn = Pick<
  FakeUpstreamOptions,
  "chunks" | "reasoning" | "finishReason" | "streamError" | "failWith"
>;

export interface UpstreamRecord {
  url: string;
  authorization: string | null;
  /** The `x-session-affinity` header: the chat's cache affinity id, when it carried one. */
  affinity: string | null;
  body: unknown;
  aborted: boolean;
  completed: boolean;
}

const encoder = new TextEncoder();

function sse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function chunk(delta: Record<string, string>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** Builds the streaming chat completion response for one request. */
export function completionResponse(
  options: FakeUpstreamOptions,
  signal: AbortSignal,
  record: UpstreamRecord,
): Response {
  if (options.failWith) {
    record.completed = true;
    return new Response(options.failWith.body, {
      status: options.failWith.status,
      headers: { "Content-Type": "application/json", ...options.failWith.headers },
    });
  }
  const delayMs = options.delayMs ?? 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => {
        record.aborted = true;
      };
      signal.addEventListener("abort", onAbort);
      try {
        controller.enqueue(sse(chunk({ role: "assistant", content: "" })));
        for (const text of options.reasoning ?? []) {
          await sleep(delayMs, signal);
          controller.enqueue(sse(chunk({ reasoning_content: text })));
        }
        for (const text of options.chunks ?? []) {
          await sleep(delayMs, signal);
          controller.enqueue(sse(chunk({ content: text })));
        }
        if (options.streamError !== undefined) {
          await sleep(delayMs, signal);
          controller.enqueue(sse({ error: { message: options.streamError } }));
        }
        if (options.hang || options.streamError !== undefined)
          await new Promise((_, reject) => signal.addEventListener("abort", reject));
        controller.enqueue(
          sse({
            ...chunk({}, options.finishReason ?? "stop"),
            usage: {
              ...(options.usage ?? { prompt_tokens: 3, completion_tokens: 5 }),
              total_tokens:
                (options.usage?.prompt_tokens ?? 3) + (options.usage?.completion_tokens ?? 5),
            },
          }),
        );
        controller.enqueue(sse("[DONE]"));
        record.completed = true;
        controller.close();
      } catch {
        record.aborted = true;
        controller.error(signal.reason);
      }
    },
    cancel() {
      record.aborted = true;
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/** What a cast keeper call (`KEEPER_OPENING`) gets when nothing else is scripted for it. */
export const FAKE_KEEPER_CHANGES = {
  cast: {
    "Ilse Brandt": {
      role: "principal",
      gender: "female",
      anchor: { age: "24", hair: "black, cropped, coarse" },
      state: { present: true, activity: "tending the bar" },
    },
  },
  absent: [],
} as const satisfies CastChanges;

/** What a cast sheet call (`SHEET_OPENING`) gets when nothing else is scripted for it. */
export const FAKE_SHEET_ANSWER = {
  cast: [
    {
      name: "Maren Holt",
      gender: "female",
      role: "principal",
      anchor: { age: "29", eyes: "grey, hooded" },
    },
  ],
} as const satisfies CastSheetAnswer;

/** The cast call a completion request is, by its instructions' opening, or null. */
function castCall(body: unknown): string | null {
  const messages = typeof body === "object" && body !== null ? Reflect.get(body, "messages") : [];
  if (!Array.isArray(messages)) return null;
  const system: unknown = messages.find(
    (message) => typeof message === "object" && message !== null && message.role === "system",
  )?.content;
  if (typeof system !== "string") return null;
  if (system.startsWith(KEEPER_OPENING)) return JSON.stringify(FAKE_KEEPER_CHANGES);
  if (system.startsWith(SHEET_OPENING)) return JSON.stringify(FAKE_SHEET_ANSWER);
  return null;
}

/** Ids the chat tests send. */
const DEFAULT_MODELS = ["fake-model", "m", "model-a", "model-b"];

/** The reasoning levels every listed model reports, as CLIProxyAPI's catalog names them. */
export const FAKE_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function catalogEntry(slug: string): CatalogEntry {
  return {
    slug,
    context_window: FAKE_WINDOW,
    supported_reasoning_levels: FAKE_LEVELS.map((effort) => ({ effort, description: effort })),
  };
}

export function fakeUpstream(options: FakeUpstreamOptions = {}) {
  /** Completion requests only. */
  const records: UpstreamRecord[] = [];
  /** Model list requests. */
  const modelRequests: UpstreamRecord[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const record: UpstreamRecord = {
      url: url.pathname,
      authorization: request.headers.get("Authorization"),
      affinity: request.headers.get("x-session-affinity"),
      body: request.method === "POST" ? await request.json() : undefined,
      aborted: false,
      completed: false,
    };
    if (url.pathname.endsWith("/models")) {
      modelRequests.push(record);
      if (options.catalogDown) return new Response("down", { status: 500 });
      const ids = options.models ?? DEFAULT_MODELS;
      const query = url.searchParams.has("client_version");
      if (query && options.catalogQueryMissing) return new Response("missing", { status: 404 });
      if (!query) {
        return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });
      }
      return Response.json({ models: options.catalog ?? ids.map(catalogEntry) });
    }
    const turn = options.turns?.[records.length];
    records.push(record);
    // A cast call with nothing scripted for it gets its deterministic answer.
    const cast = turn === undefined && options.chunks === undefined ? castCall(record.body) : null;
    const reply =
      turn === undefined
        ? cast === null
          ? options
          : { ...options, chunks: [cast] }
        : { ...options, ...turn };
    const streamed =
      typeof record.body === "object" && record.body !== null && Reflect.get(record.body, "stream");
    if (streamed !== true && !reply.failWith) {
      // A non-streamed call (generateText): the whole reply at once.
      record.completed = true;
      return Response.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: "fake-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: (reply.chunks ?? []).join("") },
            finish_reason: reply.finishReason ?? "stop",
          },
        ],
        ...(options.withoutUsage
          ? {}
          : { usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }),
      });
    }
    return completionResponse(reply, request.signal, record);
  };
  return { fetch, records, modelRequests };
}
