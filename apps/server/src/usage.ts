import {
  type CallAccounting,
  type CallPurpose,
  type CallRecord,
  type CallUsage,
  callRecordSchema,
  MAX_CALL_RECORDS,
} from "@ephemera/core";
import type { LanguageModelMiddleware, LanguageModelUsage } from "ai";

const numeric = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Compatible providers normalize absent fields to zero. Only raw numeric presence is evidence. */
export function reportedUsage(usage: Pick<LanguageModelUsage, "raw">): CallUsage {
  const raw = object(usage.raw);
  const cached = object(raw.prompt_tokens_details).cached_tokens;
  const reasoning = object(raw.completion_tokens_details).reasoning_tokens;
  return {
    ...(numeric(raw.prompt_tokens) ? { inputTokens: raw.prompt_tokens } : {}),
    ...(numeric(cached) ? { cachedTokens: cached } : {}),
    ...(numeric(raw.completion_tokens) ? { outputTokens: raw.completion_tokens } : {}),
    ...(numeric(reasoning) ? { reasoningTokens: reasoning } : {}),
  };
}

/** One request/job's bounded numeric outcome. Never shared globally or written to an entity. */
export function callRecorder() {
  const calls: CallRecord[] = [];
  let truncated = false;
  return {
    snapshot: (): CallAccounting => ({ calls: [...calls], truncated }),
    middleware(purpose: CallPurpose, model: string): LanguageModelMiddleware {
      const begin = () => {
        const id = crypto.randomUUID();
        const started = performance.now();
        // Reserve in causal order, even when completion order differs.
        const at = calls.length;
        if (at < MAX_CALL_RECORDS) calls.push({ id, purpose, model, status: "aborted", usage: {} });
        else truncated = true;
        let ended = false;
        return (status: CallRecord["status"], usage: CallUsage = {}, finishReason?: string) => {
          if (ended) return;
          ended = true;
          if (at >= MAX_CALL_RECORDS) return;
          const parsed = callRecordSchema.parse({
            id,
            purpose,
            model,
            status,
            usage,
            durationMs: Math.max(0, Math.round(performance.now() - started)),
            ...(finishReason === undefined ? {} : { finishReason }),
          });
          calls[at] = parsed;
        };
      };
      return {
        wrapGenerate: async ({ doGenerate, params }) => {
          const end = begin();
          try {
            const result = await doGenerate();
            end(
              result.finishReason.unified === "error" ? "failed" : "completed",
              reportedUsage(result.usage),
              result.finishReason.unified,
            );
            return result;
          } catch (error) {
            end(params.abortSignal?.aborted ? "aborted" : "failed");
            throw error;
          }
        },
        wrapStream: async ({ doStream, params }) => {
          const end = begin();
          try {
            const result = await doStream();
            let finished = false;
            let failed = false;
            // Register on the request signal as downstream cancellation may skip flush.
            const aborted = () => end("aborted");
            params.abortSignal?.addEventListener("abort", aborted, { once: true });
            const reader = result.stream.getReader();
            const cleanup = () => params.abortSignal?.removeEventListener("abort", aborted);
            return {
              ...result,
              stream: new ReadableStream({
                async pull(controller) {
                  try {
                    const next = await reader.read();
                    if (next.done) {
                      cleanup();
                      if (!finished) end(params.abortSignal?.aborted ? "aborted" : "failed");
                      controller.close();
                      return;
                    }
                    const part = next.value;
                    if (part.type === "finish") {
                      finished = true;
                      end(
                        failed || part.finishReason.unified === "error" ? "failed" : "completed",
                        reportedUsage(part.usage),
                        part.finishReason.unified,
                      );
                    }
                    if (part.type === "error") failed = true;
                    controller.enqueue(part);
                  } catch (error) {
                    cleanup();
                    end(params.abortSignal?.aborted ? "aborted" : "failed");
                    controller.error(error);
                  }
                },
                async cancel(reason) {
                  cleanup();
                  end("aborted");
                  await reader.cancel(reason);
                },
              }),
            };
          } catch (error) {
            end(params.abortSignal?.aborted ? "aborted" : "failed");
            throw error;
          }
        },
      };
    },
  };
}
export type CallRecorder = ReturnType<typeof callRecorder>;
