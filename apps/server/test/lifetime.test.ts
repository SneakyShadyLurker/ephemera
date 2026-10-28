import { MAX_CHAT_BODY_BYTES } from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import { readBounded } from "../src/lifetime.ts";
import { fakeUpstream } from "./fake-upstream.ts";
import { CLOCK, ownerHeaders, PICK_SEED, testApp } from "./helpers.ts";

const encoder = new TextEncoder();
const body = JSON.stringify({
  model: "m",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  messages: [{ role: "user", content: "hi" }],
});

/** A chunked upload (no Content-Length) that sends `parts` with `gapMs` between them. */
function trickle(parts: string[], gapMs: number) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        if (cancelled) return;
        controller.enqueue(encoder.encode(part));
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

function chunkedRequest(stream: ReadableStream<Uint8Array>): Request {
  return new Request("http://app.test/api/chat", {
    method: "POST",
    headers: ownerHeaders(),
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("readBounded", () => {
  it("cancels a stalled source exactly once when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const cancel = vi.fn();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel,
    });
    const reading = readBounded(stream, 100, abort.signal);
    try {
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(await reading).toEqual(new Uint8Array());
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      if (cancel.mock.calls.length === 0) source?.close();
      await reading;
    }
  });
});

describe("chat request lifetime", () => {
  it("lifts the runtime idle timeout on the original request, even for a chunked body", async () => {
    const onStreamingRequest = vi.fn();
    const { app } = testApp({ fetch: fakeUpstream({ chunks: ["a"] }).fetch, onStreamingRequest });
    const request = chunkedRequest(trickle([body.slice(0, 10), body.slice(10)], 1).stream);
    const response = await app.fetch(request);
    expect(response.status).toBe(200);
    await response.text();
    expect(onStreamingRequest).toHaveBeenCalledWith(request);
  });

  it("ends a trickled upload at the lifetime bound and stops reading it", async () => {
    const { app } = testApp({ fetch: fakeUpstream().fetch }, { requestTimeoutMs: 100 });
    const upload = trickle(Array.from(body), 40);
    const started = Date.now();
    const response = await app.fetch(chunkedRequest(upload.stream));
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "request_timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(upload.wasCancelled()).toBe(true);
  });

  it("rejects an oversized chunked body once it passes the limit", async () => {
    const { app } = testApp({ fetch: fakeUpstream().fetch });
    const big = "x".repeat(1024 * 1024);
    const upload = trickle(
      Array.from({ length: 10 }, () => big),
      0,
    );
    const response = await app.fetch(chunkedRequest(upload.stream));
    expect(response.status).toBe(413);
    expect(upload.wasCancelled()).toBe(true);
    expect(MAX_CHAT_BODY_BYTES).toBeLessThan(10 * big.length);
  });

  it("rejects a declared oversized body without reading it", async () => {
    const { app } = testApp({ fetch: fakeUpstream().fetch });
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: ownerHeaders({ "Content-Length": String(MAX_CHAT_BODY_BYTES + 1) }),
      body: "{}",
    });
    expect(response.status).toBe(413);
  });
});
