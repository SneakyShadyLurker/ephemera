import { parseJsonEventStream, type UIMessageChunk, uiMessageChunkSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEADLINE_GRACE_MS, KEEPALIVE_INTERVAL_MS, withKeepalive } from "../src/keepalive.ts";
import { type FakeUpstreamOptions, fakeUpstream } from "./fake-upstream.ts";
import { CLOCK, PICK_SEED, postJson, testApp } from "./helpers.ts";

/** The AI SDK's comment frame on the chat stream (`keepAliveMs`). */
const FRAME = ": keep-alive\n\n";
/** A frame for `withKeepalive`'s own timer, as the NDJSON routes pass theirs. */
const OWN_FRAME = ": keepalive\n\n";
const ownFrame = new TextEncoder().encode(OWN_FRAME);
const request = {
  model: "fake-model",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  messages: [{ role: "user", content: "Say hello" }],
};
const reply: FakeUpstreamOptions = { reasoning: ["thinking"], chunks: ["Hel", "lo"] };

/** What the web app's parser (`apps/web/src/chat/transport.ts`) reads from a body. */
async function parse(body: string): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const stream = parseJsonEventStream({
    stream: new Response(body).body ?? new ReadableStream(),
    schema: uiMessageChunkSchema,
  });
  for await (const parsed of stream) {
    if (!parsed.success) throw parsed.error;
    chunks.push(parsed.value);
  }
  return chunks;
}

const frames = (body: string) => body.split(FRAME).length - 1;

const useFakeTimers = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

/** Reads a response body in the background, as a client would; an aborted request errors it. */
function read(response: Response) {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (reader === undefined) throw new Error("no body");
  const state = { received: "", done: false, errored: false, cancel: () => reader.cancel() };
  void (async () => {
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        state.received += chunk.value;
      }
    } catch {
      state.errored = true;
    } finally {
      state.done = true;
    }
  })();
  return state;
}

/** Lets stream work settle, moving the fake clock one millisecond at a time (far below the interval). */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 200) throw new Error("condition not met in time");
    await vi.advanceTimersByTimeAsync(1);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("chat stream keepalive", () => {
  it("writes comment frames while the upstream is silent, and the parsed reply is unchanged", async () => {
    const quick = testApp({ fetch: fakeUpstream(reply).fetch }).app;
    const expected = await parse(
      await (await quick.request("/api/chat", postJson(request))).text(),
    );

    useFakeTimers();
    const silentMs = 2 * KEEPALIVE_INTERVAL_MS + 5_000;
    const upstream = fakeUpstream({ ...reply, delayMs: silentMs });
    const { app } = testApp({ fetch: upstream.fetch });
    const response = await app.request("/api/chat", postJson(request));
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const reading = read(response);
    await vi.advanceTimersByTimeAsync(3 * silentMs + 1_000);
    await until(() => reading.done);
    const body = reading.received;

    // Three silences of two intervals each, before the reasoning and each text delta.
    expect(frames(body)).toBeGreaterThanOrEqual(6);
    // SSE comments (the stream's opening one and the frames) and data events only.
    for (const event of body.split("\n\n").filter(Boolean)) {
      expect(event.startsWith(": ") || event.startsWith("data: ")).toBe(true);
    }
    // Only the random message id and the attempt receipt differ between two replies.
    expect(await parse(body)).toEqual(
      expected.map((chunk) =>
        chunk.type === "start"
          ? { ...chunk, messageId: expect.any(String) }
          : chunk.type === "data-usage"
            ? { ...chunk, data: expect.any(Object) }
            : chunk,
      ),
    );
    expect(upstream.records[0]?.completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends no frame once the stream has ended", async () => {
    useFakeTimers();
    const { app } = testApp({ fetch: fakeUpstream(reply).fetch });
    const reading = read(await app.request("/api/chat", postJson(request)));
    await until(() => reading.done);
    expect(frames(reading.received)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["aborts the request", "abort"],
    ["cancels the body", "cancel"],
  ] as const)("stops the frames when the client %s", async (_, how) => {
    useFakeTimers();
    const upstream = fakeUpstream({ reasoning: ["thinking"], hang: true });
    const { app } = testApp({ fetch: upstream.fetch });
    const client = new AbortController();
    const reading = read(
      await app.request("/api/chat", postJson(request, { signal: client.signal })),
    );
    await until(() => reading.received.includes('"type":"reasoning-delta"'));
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    await until(() => frames(reading.received) === 1);

    if (how === "abort") client.abort();
    else await reading.cancel();
    // A disconnect aborts the request (chat.test.ts); cancelling the body alone does not reach upstream.
    const upstreamDone = () => how === "cancel" || upstream.records[0]?.aborted === true;
    await until(() => reading.done && upstreamDone() && vi.getTimerCount() === 0);
    // The stream ended: after an abort the closing part arrives within the deadline's grace (keepalive.ts).
    const sent = frames(reading.received);
    await vi.advanceTimersByTimeAsync(3 * KEEPALIVE_INTERVAL_MS);
    expect(frames(reading.received)).toBe(sent);
  });

  it("a stalled reader: the deadline clears the timer and errors the stream, and no frame follows", async () => {
    useFakeTimers();
    const encoder = new TextEncoder();
    const enqueue = vi.spyOn(TransformStreamDefaultController.prototype, "enqueue");
    const framesEnqueued = () =>
      enqueue.mock.calls.filter(([chunk]) => new TextDecoder().decode(chunk) === OWN_FRAME).length;
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sourceCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const deadline = new AbortController();
    const reader = withKeepalive(
      new Response(upstream),
      deadline.signal,
      ownFrame,
    ).body?.getReader();
    if (reader === undefined || source === undefined) throw new Error("no body");

    // The reader takes the first event, then stops consuming while events keep arriving.
    source.enqueue(encoder.encode("data: 1\n\n"));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: 1\n\n");
    source.enqueue(encoder.encode("data: 2\n\n"));
    source.enqueue(encoder.encode("data: 3\n\n"));
    await vi.advanceTimersByTimeAsync(3 * KEEPALIVE_INTERVAL_MS);
    // The readable side is full, so every interval skipped its frame.
    expect(framesEnqueued()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    const reason = new DOMException("the request's lifetime passed", "TimeoutError");
    deadline.abort(reason);
    expect(vi.getTimerCount()).toBe(0);
    // The queued events are dropped: the next read fails with the deadline's reason.
    await expect(reader.read()).rejects.toBe(reason);
    await until(() => sourceCancelled);
    await vi.advanceTimersByTimeAsync(3 * KEEPALIVE_INTERVAL_MS);
    expect(framesEnqueued()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a reader that keeps up still receives the closing part after the deadline, then the stream ends", async () => {
    useFakeTimers();
    const encoder = new TextEncoder();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    });
    const deadline = new AbortController();
    const reader = withKeepalive(
      new Response(upstream),
      deadline.signal,
      ownFrame,
    ).body?.getReader();
    if (reader === undefined || source === undefined) throw new Error("no body");

    deadline.abort(new DOMException("the request's lifetime passed", "TimeoutError"));
    // The interval is gone; only the grace timer remains.
    expect(vi.getTimerCount()).toBe(1);
    source.enqueue(encoder.encode('data: {"type":"abort"}\n\n'));
    source.close();
    const last = await reader.read();
    expect(new TextDecoder().decode(last.value)).toBe('data: {"type":"abort"}\n\n');
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stream that has not ended within the grace after the deadline is errored", async () => {
    useFakeTimers();
    const upstream = new ReadableStream<Uint8Array>();
    const deadline = new AbortController();
    const reader = withKeepalive(
      new Response(upstream),
      deadline.signal,
      ownFrame,
    ).body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const reason = new DOMException("the request's lifetime passed", "TimeoutError");
    deadline.abort(reason);
    const failed = expect(reader.read()).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(DEADLINE_GRACE_MS);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
});
