import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_LIMITS, ImageError, imageHeader, toPortrait, toVisionImage } from "../src/images.ts";
import { pngChunks } from "../src/png.ts";
import {
  bombPng,
  compressedMetadataPng,
  displayP3Png,
  gif,
  html,
  jpegWithMetadata,
  plainJpeg,
  plainPng,
  plainWebp,
  pngChunk,
  pngClaiming,
  pngWithNoise,
  pngWithText,
  polyglotPng,
  svg,
  tiff,
} from "./image-fixtures.ts";

vi.mock("sharp", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof sharp }>();
  return { default: Object.assign(vi.fn(original.default), original.default) };
});

vi.mock("node:zlib", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:zlib")>();
  return { ...original, inflateSync: vi.fn(original.inflateSync) };
});

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImageError) return error.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("avatar pipeline: allowed types", () => {
  it.each([
    ["PNG", plainPng],
    ["JPEG", plainJpeg],
    ["WebP", plainWebp],
  ])("re-encodes a %s into a PNG portrait and a WebP thumbnail", async (_label, make) => {
    const portrait = await toPortrait(new Uint8Array(await make()));
    expect((await sharp(portrait.png).metadata()).format).toBe("png");
    expect((await sharp(portrait.thumb).metadata()).format).toBe("webp");
    expect([portrait.width, portrait.height]).toEqual([30, 45]);
  });

  it.each([
    ["SVG", () => svg],
    ["an SVG with an image name (bytes decide)", () => svg],
    ["HTML", () => html],
    ["GIF", gif],
    ["TIFF", tiff],
    ["empty bytes", () => new Uint8Array()],
  ])("rejects %s", async (_label, make) => {
    const bytes = new Uint8Array(await make());
    expect(await rejection(toPortrait(bytes))).toBe("unsupported_image");
  });

  it("blocks every other decoder in sharp itself", async () => {
    await expect(sharp(svg).metadata()).rejects.toThrow();
    await expect(sharp(await gif()).metadata()).rejects.toThrow();
  });
});

describe("avatar pipeline: caps", () => {
  it("rejects a header claiming huge dimensions without decoding it", async () => {
    const started = performance.now();
    expect(await rejection(toPortrait(pngClaiming(50_000, 50_000)))).toBe("image_too_large");
    expect(await rejection(imageHeader(pngClaiming(6000, 6000)))).toBe("image_too_large");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects a real image over the pixel cap that compresses to almost nothing", async () => {
    const bomb = new Uint8Array(await bombPng());
    expect(bomb.byteLength).toBeLessThan(1_000_000);
    expect(await rejection(toPortrait(bomb))).toBe("image_too_large");
  });

  it("fits large images inside the portrait size and never enlarges small ones", async () => {
    const large = await toPortrait(new Uint8Array(await plainPng(3000, 3000)));
    expect([large.width, large.height]).toEqual([1024, 1024]);
    const thumb = await sharp(large.thumb).metadata();
    expect([thumb.width, thumb.height]).toEqual([256, 256]);
    const tall = await toPortrait(new Uint8Array(await plainPng(800, 4000)));
    expect(tall.height).toBe(IMAGE_LIMITS.portrait.height);
    const small = await toPortrait(new Uint8Array(await plainPng(10, 15)));
    expect([small.width, small.height]).toEqual([10, 15]);
  });
});

describe("vision copy", () => {
  it.each([
    ["random", 1024, 1536, [683, 1024], false],
    ["random", 1024, 1024, [1024, 1024], false],
    // Every channel 0 or 255: the largest JPEG measured, about 715 KB.
    ["binary", 1024, 1024, [1024, 1024], true],
  ] as const)(
    "turns a %s noise %ix%i portrait into a JPEG within the vision bounds",
    async (_noise, width, height, size, binary) => {
      const portrait = await toPortrait(pngWithNoise(width, height, height, binary));
      const vision = await toVisionImage(portrait.png);
      const meta = await sharp(vision).metadata();
      expect(meta.format).toBe("jpeg");
      expect([meta.width, meta.height]).toEqual(size);
      expect(vision.byteLength).toBeLessThan(IMAGE_LIMITS.vision.worstCaseBytes);
      expect([meta.exif, meta.xmp, meta.icc]).toEqual([undefined, undefined, undefined]);
    },
  );

  it("never enlarges a small portrait", async () => {
    const vision = await toVisionImage((await toPortrait(new Uint8Array(await plainPng()))).png);
    const meta = await sharp(vision).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 30, 45]);
  });
});

describe("avatar pipeline: metadata stripped", () => {
  it("drops EXIF, GPS and XMP and applies the orientation", async () => {
    const input = await jpegWithMetadata();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.xmp).toBeDefined();
    expect(before.orientation).toBe(6);
    expect(input.includes("metadata-canary")).toBe(true);

    const portrait = await toPortrait(new Uint8Array(input));
    for (const image of [portrait.png, portrait.thumb]) {
      const meta = await sharp(image).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(Buffer.from(image).includes("metadata-canary")).toBe(false);
    }
    // Orientation 6 rotates the 40 × 20 image upright.
    expect([portrait.width, portrait.height]).toEqual([20, 40]);
  });

  it("drops PNG text chunks, card data included", async () => {
    const portrait = await toPortrait(pngWithText({ chara: "Y2FuYXJ5", Comment: "text-canary" }));
    expect(Buffer.from(portrait.png).includes("chara")).toBe(false);
    expect(Buffer.from(portrait.png).includes("text-canary")).toBe(false);
    expect(Buffer.from(portrait.png).includes("tEXt")).toBe(false);
  });

  it("drops a payload appended after the image", async () => {
    const portrait = await toPortrait(await polyglotPng());
    expect(Buffer.from(portrait.png).includes("polyglot")).toBe(false);
  });

  it.each(["zTXt", "iTXt"] as const)(
    "removes compressed %s before header reads and pixel decoding",
    async (type) => {
      const hostile = compressedMetadataPng(type);
      expect(hostile.byteLength).toBeLessThan(40_000);
      vi.mocked(sharp).mockClear();
      expect(await imageHeader(hostile)).toEqual({ format: "png", width: 1, height: 1 });
      const portrait = await toPortrait(hostile);
      expect([portrait.width, portrait.height]).toEqual([1, 1]);
      expect(Buffer.from(portrait.png).includes(type)).toBe(false);
      // Observe the actual native boundary, not just metadata absent from output:
      // the vulnerable decoder also stripped metadata after first inflating it.
      const calls = vi.mocked(sharp).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const [input] of calls) {
        if (input instanceof Uint8Array) {
          const chunks = pngChunks(input);
          expect(chunks).toBeDefined();
          expect(
            chunks?.some((chunk) => ["zTXt", "iTXt", "iCCP", "tEXt"].includes(chunk.type)),
          ).toBe(false);
        }
      }
    },
  );

  it("preserves bounded Display P3 color conversion and strips the profile from output", async () => {
    const input = await displayP3Png();
    expect((await sharp(input).metadata()).icc).toBeDefined();
    const native = await sharp(input).raw().toBuffer();
    expect([...native]).toEqual([200, 100, 51]);
    const portrait = await toPortrait(input);
    expect(await sharp(portrait.png).raw().toBuffer()).toEqual(native);
    for (const output of [portrait.png, portrait.thumb]) {
      expect((await sharp(output).metadata()).icc).toBeUndefined();
    }
    expect(pngChunks(portrait.png)?.some((chunk) => chunk.type === "iCCP")).toBe(false);
  });

  it("rejects an ICC decompression bomb before any sharp call", async () => {
    const hostile = compressedMetadataPng("iCCP");
    vi.mocked(sharp).mockClear();
    expect(await rejection(imageHeader(hostile))).toBe("invalid_image");
    expect(await rejection(toPortrait(hostile))).toBe("invalid_image");
    expect(sharp).not.toHaveBeenCalled();
  });

  it.each([
    ["empty name", "\0\0broken"],
    ["overlong name", `${"p".repeat(80)}\0\0broken`],
    ["unknown compression method", "profile\0\x01broken"],
    ["missing compressed data", "profile\0\0"],
    ["invalid compressed data", "profile\0\0broken"],
  ])("rejects malformed ICC with %s before sharp", async (_label, data) => {
    const base = Buffer.from(pngWithText({}, 1, 1));
    const hostile = Buffer.concat([
      base.subarray(0, 33),
      pngChunk("iCCP", Buffer.from(data, "latin1")),
      base.subarray(33),
    ]);
    vi.mocked(sharp).mockClear();
    expect(await rejection(imageHeader(hostile))).toBe("invalid_image");
    expect(await rejection(toPortrait(hostile))).toBe("invalid_image");
    expect(sharp).not.toHaveBeenCalled();
  });

  it("rejects duplicate ICC chunks before performing any inflation", async () => {
    const input = await displayP3Png();
    const profile = pngChunks(input)?.find((chunk) => chunk.type === "iCCP");
    if (profile === undefined) throw new Error("expected an ICC profile");
    const duplicate = Buffer.concat([input.subarray(0, 33), profile.bytes, input.subarray(33)]);
    vi.mocked(sharp).mockClear();
    vi.mocked(inflateSync).mockClear();
    expect(await rejection(imageHeader(duplicate))).toBe("invalid_image");
    expect(await rejection(toPortrait(duplicate))).toBe("invalid_image");
    expect(sharp).not.toHaveBeenCalled();
    expect(inflateSync).not.toHaveBeenCalled();
  });

  it("rejects attacker-sized chunk lists before allocating metadata views", async () => {
    const base = Buffer.from(pngWithText({}, 1, 1));
    const empty = pngChunk("tEXt", new Uint8Array());
    const hostile = Buffer.concat([
      base.subarray(0, 33),
      ...Array<Buffer>(16_384).fill(empty),
      base.subarray(33),
    ]);
    expect(await rejection(imageHeader(hostile))).toBe("invalid_image");
  });
});
