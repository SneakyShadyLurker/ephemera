import { createMiddleware } from "hono/factory";
import { payloadTooLarge } from "./routes.ts";

export type LifetimeEnv = { Variables: { deadline: AbortSignal } };

/**
 * Bounds a streaming request's whole lifetime from arrival, body upload
 * included (PRINCIPLES.md 1). Binds to the original runtime request, before
 * any middleware replaces `c.req.raw`: the deadline follows its disconnect
 * signal, and `onStreamingRequest` lifts the runtime idle timeout on it.
 */
export function requestLifetime(
  timeoutMs: number,
  onStreamingRequest?: (request: Request) => void,
) {
  return createMiddleware<LifetimeEnv>(async (c, next) => {
    onStreamingRequest?.(c.req.raw);
    c.set("deadline", AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]));
    await next();
  });
}

/** Whether a signal ended on its timeout (`AbortSignal.timeout`), not a disconnect or a stop. */
export const timedOut = (signal: AbortSignal) =>
  signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";

/**
 * Reads a body of at most `max` bytes; undefined once it passes them (the
 * rest is cancelled). An aborted `signal` cancels the read, which then ends
 * with what arrived; the caller checks the signal.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = body.getReader();
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // A cancelled reader resolves its pending read as done.
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > max) {
        cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A response's JSON body of at most `max` bytes (`readBounded`): `json` is
 * undefined when the body is not JSON. A declared or read size past `max`
 * cancels the body and answers `too_large`.
 */
export async function readBoundedJson(
  response: Response,
  max: number,
  signal?: AbortSignal,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: "too_large" }> {
  if (Number(response.headers.get("Content-Length")) > max) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: "too_large" };
  }
  const bytes =
    response.body === null ? new Uint8Array() : await readBounded(response.body, max, signal);
  if (bytes === undefined) return { ok: false, reason: "too_large" };
  try {
    return { ok: true, json: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: true, json: undefined };
  }
}

/** Settles as `promise` does, or with undefined once `signal` aborts first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  const { promise: aborted, resolve } = Promise.withResolvers<undefined>();
  const stop = () => resolve(undefined);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", stop));
}

/**
 * Reads the request body within the size limit and the deadline, cancelling
 * the upload when either is exceeded, then hands the bytes on.
 */
export function boundedBody(maxBytes: number) {
  return createMiddleware<LifetimeEnv>(async (c, next) => {
    if (Number(c.req.header("Content-Length")) > maxBytes) {
      return payloadTooLarge(c);
    }
    const stream = c.req.raw.body;
    if (stream === null) return await next();

    const deadline = c.get("deadline");
    let body: Uint8Array<ArrayBuffer> | undefined;
    try {
      body = await readBounded(stream, maxBytes, deadline);
    } catch (error) {
      if (!deadline.aborted) throw error;
    }
    if (deadline.aborted) return c.json({ error: "request_timeout" }, 408);
    if (body === undefined) return payloadTooLarge(c);
    c.req.raw = new Request(c.req.raw, { body });
    await next();
  });
}
