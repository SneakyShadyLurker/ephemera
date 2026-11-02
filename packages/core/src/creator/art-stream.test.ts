import { describe, expect, it } from "vitest";
import { ART_CONTROL_BYTES, ART_KEEPALIVE, decodeArtFrames, encodeArtFrame } from "./art-stream.ts";
import { CREATOR_ART } from "./limits.ts";

async function* pieces(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}
async function read(bytes: Uint8Array, size = 17) {
  const events = [];
  for await (const event of decodeArtFrames(pieces(bytes, size))) events.push(event);
  return events;
}
const concat = (...chunks: Uint8Array[]) => {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
function header(kind: number, length: number) {
  const bytes = new Uint8Array(5);
  bytes[0] = kind;
  new DataView(bytes.buffer).setUint32(1, length);
  return bytes;
}

describe("binary art frames", () => {
  it("reads fragmented headers, controls, keepalives and raw images, including 4MiB", async () => {
    const png = new Uint8Array(4 * 1024 * 1024).fill(213);
    const progress = { type: "progress", phase: "decoding", value: 0, max: 4 } as const;
    const bytes = concat(
      ART_KEEPALIVE,
      encodeArtFrame(progress),
      encodeArtFrame({ type: "image", index: 0, png }),
      ART_KEEPALIVE,
      encodeArtFrame({ type: "done" }),
    );
    const events = await read(bytes, 4093);
    expect(events[0]).toEqual(progress);
    const image = events[1];
    expect(image?.type === "image" && image.index).toBe(0);
    expect(image?.type === "image" && image.png.byteLength).toBe(png.byteLength);
    expect(image?.type === "image" && image.png.every((byte) => byte === 213)).toBe(true);
    expect(events[2]).toEqual({ type: "done" });
    expect(await read(encodeArtFrame(progress), 1)).toEqual([progress]);
  });
  it.each([
    header(3, 0),
    header(0, 1),
    header(1, 0),
    header(1, ART_CONTROL_BYTES + 1),
    header(2, CREATOR_ART.imageBytes + 2),
    header(2, 1),
    header(2, 0),
    header(1, 3).subarray(0, 4),
    header(1, 3),
    concat(header(1, 1), Uint8Array.of(255)),
    concat(header(2, 2), Uint8Array.of(4, 1)),
  ])(
    "rejects unknown, malformed, truncated or oversized frames before allocation",
    async (bytes) => {
      await expect(read(bytes)).rejects.toThrow("invalid_art_stream");
    },
  );
  it("rejects invalid controls, duplicate images and an oversized complete batch", async () => {
    const control = new TextEncoder().encode('{"type":"image","index":0,"png":"AA=="}');
    await expect(read(concat(header(1, control.length), control))).rejects.toThrow();
    const image = encodeArtFrame({ type: "image", index: 0, png: Uint8Array.of(1) });
    await expect(read(concat(image, image))).rejects.toThrow();
    const png = new Uint8Array(CREATOR_ART.imageBytes);
    const batch = concat(
      ...[0, 1, 2, 3].map((index) => encodeArtFrame({ type: "image", index, png })),
    );
    await expect(read(batch, 65536)).rejects.toThrow();
  });
});
