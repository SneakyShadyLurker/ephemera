import { ART_STREAM_TYPE, creatorCardEventSchema, encodeArtFrame } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { artEvents, CreatorStreamError, readEvents } from "./stream.ts";

/** A body that arrives in exactly these pieces. */
function body(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<Uint8Array>) {
  const all = [];
  for await (const event of readEvents(stream, creatorCardEventSchema)) all.push(event);
  return all;
}

describe("readEvents", () => {
  it("cancels a fragmented binary body on early return", async () => {
    let cancelled = false;
    const frame = encodeArtFrame({ type: "progress", phase: "sending", value: 0, max: 4 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame.subarray(0, 3));
        controller.enqueue(frame.subarray(3));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of artEvents(
      new Response(stream, { headers: { "Content-Type": ART_STREAM_TYPE } }),
    )) {
      expect(event).toMatchObject({ phase: "sending" });
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("rejects a malformed binary body with a content-free error", async () => {
    for (const response of [
      new Response(Uint8Array.of(2, 0, 0), { headers: { "Content-Type": ART_STREAM_TYPE } }),
    ]) {
      const read = async () => {
        for await (const _ of artEvents(response)) {
          /* consume */
        }
      };
      await expect(read()).rejects.toBeInstanceOf(CreatorStreamError);
    }
  });
  it("joins lines split across chunks, multi-byte characters included", async () => {
    const line = JSON.stringify({ type: "delta", text: "Ada sagte: „Grüß dich.“" });
    const bytes = new TextEncoder().encode(`${line}\n{"type":"error","code":"upstream"}\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte at a time, splitting every character and every line.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    expect(await read(stream)).toEqual([
      { type: "delta", text: "Ada sagte: „Grüß dich.“" },
      { type: "error", code: "upstream" },
    ]);
  });

  it("reads a line of megabytes delivered in small chunks without searching it again per chunk", async () => {
    const text = "x".repeat(8 * 1024 * 1024);
    const bytes = new TextEncoder().encode(`${JSON.stringify({ type: "delta", text })}\n`);
    const size = 256;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    });
    const started = performance.now();
    const [event] = await read(stream);
    // Splitting the whole buffer on each of the 32,768 chunks takes seconds; scanning only new text, milliseconds.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(event?.type === "delta" && event.text.length).toBe(text.length);
  });

  it("reads the content-free thinking and retry events and the new error codes", async () => {
    expect(
      await read(
        body(
          '{"type":"thinking"}\n',
          '{"type":"retry","problems":[{"code":"missing","section":"firstMessage"}]}\n',
          '{"type":"error","code":"cut"}\n',
          '{"type":"error","code":"filtered"}\n',
        ),
      ),
    ).toEqual([
      { type: "thinking" },
      { type: "retry", problems: [{ code: "missing", section: "firstMessage" }] },
      { type: "error", code: "cut" },
      { type: "error", code: "filtered" },
    ]);
  });

  it("refuses a thinking event that carries text", async () => {
    await expect(read(body('{"type":"thinking","text":"hidden"}\n'))).rejects.toBeInstanceOf(
      CreatorStreamError,
    );
  });

  it("skips blank keepalive lines", async () => {
    expect(
      await read(
        body("\n", '{"type":"delta","text":"Hi"}\n', "\n\n", '{"type":"delta","text":"!"}\n', "\n"),
      ),
    ).toEqual([
      { type: "delta", text: "Hi" },
      { type: "delta", text: "!" },
    ]);
  });

  it("fails on an event the schema refuses, after the valid ones before it", async () => {
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const event of readEvents(
        body('{"type":"delta","text":"Hi"}\n{"type":"delta","text":3}\n'),
        creatorCardEventSchema,
      )) {
        seen.push(event);
      }
    })();
    await expect(reading).rejects.toBeInstanceOf(CreatorStreamError);
    expect(seen).toEqual([{ type: "delta", text: "Hi" }]);
  });

  it("fails on a line that is not JSON and on a body cut mid-line", async () => {
    await expect(read(body("not json\n"))).rejects.toBeInstanceOf(CreatorStreamError);
    await expect(read(body('{"type":"delta","te'))).rejects.toBeInstanceOf(CreatorStreamError);
  });
});
