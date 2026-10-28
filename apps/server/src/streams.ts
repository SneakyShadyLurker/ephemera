import { NDJSON_KEEPALIVE_FRAME, withKeepalive } from "./keepalive.ts";
import { errorClass, type Logger } from "./log.ts";

const encoder = new TextEncoder();
const settle = () => {};

/** What a stream reads and marks of its route's context (`UserEnv`, `LifetimeEnv`). */
export interface StreamContext {
  get(key: "deadline"): AbortSignal;
  set(key: "streaming", value: Promise<void>): void;
}

/**
 * Marks the response as a stream (user.ts): the instance stays in use, and
 * its writes are made durable, until the body ends or the client cancels it
 * and `work` settled, the work the stream answers.
 */
export function markStreaming(
  c: Pick<StreamContext, "set">,
  work: Promise<unknown> = Promise.resolve(),
) {
  c.set("streaming", work.then(settle, settle));
}

/**
 * The signal of the work a streamed request starts: its deadline, the client
 * cancelling the body (`cancelled`, for `streamedResponse`) and `stopping`
 * each end it.
 */
export function streamSignal(c: Pick<StreamContext, "get">, stopping?: AbortSignal) {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    c.get("deadline"),
    cancelled.signal,
    ...(stopping === undefined ? [] : [stopping]),
  ]);
  return { cancelled, signal };
}

/**
 * A streamed answer: 200 at once, then the texts `run` writes, the body
 * closed once it returns. Blank lines keep a silent stream (a model
 * reasoning, a queue) open through Cloudflare (keepalive.ts); JSON and NDJSON
 * readers skip them as whitespace. Cancelling the body (the client went
 * away) aborts `cancelled`, the work this request started; the request's
 * deadline ends the stream (keepalive.ts). A run that throws errors the
 * stream with `failure.code` and is logged by class only, so neither names
 * any content. The context is marked (`markStreaming`) until `run` settles.
 */
export function streamedResponse(
  c: StreamContext,
  options: {
    contentType: string;
    cancelled: AbortController;
    failure: { log: Logger; event: string; code: string };
    keepalive?: Uint8Array;
  },
  run: (write: (text: string | Uint8Array) => void) => Promise<void>,
): Response {
  const { cancelled, failure } = options;
  let open = true;
  const done = Promise.withResolvers<void>();
  markStreaming(c, done.promise);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string | Uint8Array) => {
        if (open) controller.enqueue(typeof text === "string" ? encoder.encode(text) : text);
      };
      run(write)
        .then(
          () => {
            if (open) controller.close();
            open = false;
          },
          (error: unknown) => {
            // The stream ends first, so a failing logger cannot hold it open.
            if (open) controller.error(new TypeError(failure.code));
            open = false;
            failure.log.error({ event: failure.event, errorClass: errorClass(error) });
          },
        )
        .finally(done.resolve);
    },
    cancel() {
      open = false;
      cancelled.abort();
    },
  });
  return withKeepalive(
    new Response(body, {
      status: 200,
      headers: { "Content-Type": options.contentType },
    }),
    c.get("deadline"),
    options.keepalive ?? NDJSON_KEEPALIVE_FRAME,
  );
}
