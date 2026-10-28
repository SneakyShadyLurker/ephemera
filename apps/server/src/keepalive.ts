/**
 * Interval of the streams' keepalive frames. Cloudflare ends a proxied
 * response after 125 s without bytes from the origin, and the stream is
 * silent while a model reasons without showing it.
 */
export const KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * How long a stream whose reader keeps up may still run after the request's
 * deadline, so the AI SDK's closing `abort` part reaches the client.
 */
export const DEADLINE_GRACE_MS = 5_000;

/** A blank line: no content, and the web app's NDJSON reader skips it (creator.ts). */
export const NDJSON_KEEPALIVE_FRAME = new TextEncoder().encode("\n");

/**
 * Writes a keepalive `frame` into a serialized event stream at every interval
 * while it is open and its reader keeps up: a frame is skipped while the
 * readable side has no room, so a stalled client never piles frames up. Each
 * chunk of the creator's and memory's NDJSON bodies is one whole event, so a
 * frame never splits one. A null `frame` writes none, for a body that sends
 * its own: the chat's AI SDK stream writes an SSE comment after each
 * `KEEPALIVE_INTERVAL_MS` without a part (`keepAliveMs`), skipped while its
 * reader is behind, and the deadline below still applies.
 * The timer ends with the stream: at its end, on an error, when the client
 * cancels it, or when the request's `deadline` (lifetime.ts) aborts. At the
 * deadline a stalled reader's stream is errored at once, releasing every
 * queued chunk; a reader that keeps up still receives the closing `abort`
 * part, and the stream is errored if it has not ended within
 * `DEADLINE_GRACE_MS`, so no content outlives the request by more than that.
 * Status and headers are kept.
 */
export function withKeepalive(
  response: Response,
  deadline: AbortSignal,
  frame: Uint8Array | null,
): Response {
  if (response.body === null) return response;
  let timer: ReturnType<typeof setInterval> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stop = () => {
    clearInterval(timer);
    clearTimeout(grace);
    if (abort !== undefined) deadline.removeEventListener("abort", abort);
  };
  // `cancel` is in the Streams standard and Bun runs it; the DOM and Bun type libraries lack it.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel: () => void } = {
    start(controller) {
      const fail = () => {
        stop();
        controller.error(deadline.reason);
      };
      abort = () => {
        if ((controller.desiredSize ?? 0) <= 0) {
          fail();
          return;
        }
        clearInterval(timer);
        grace = setTimeout(fail, DEADLINE_GRACE_MS);
      };
      if (deadline.aborted) {
        abort();
        return;
      }
      deadline.addEventListener("abort", abort, { once: true });
      if (frame === null) return;
      timer = setInterval(() => {
        if ((controller.desiredSize ?? 0) > 0) controller.enqueue(frame);
      }, KEEPALIVE_INTERVAL_MS);
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush: stop,
    cancel: stop,
  };
  // Room for one chunk on the readable side: a frame goes out only while it is empty.
  const body = response.body.pipeThrough(
    new TransformStream(transformer, undefined, { highWaterMark: 1 }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
