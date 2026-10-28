import { CARD_LIMITS } from "@ephemera/core";
import sharp, { type Metadata } from "sharp";
import type { Portrait } from "./persistence/store.ts";
import { isPng, pngChunks, pngPortraitInput } from "./png.ts";

/*
 * The avatar pipeline (PRINCIPLES.md 3): only PNG, JPEG and WebP reach a
 * decoder; dimensions are checked from the header before any pixel is
 * decoded; every accepted image is decoded and re-encoded, which drops EXIF,
 * XMP, IPTC, ICC and PNG text chunks (sharp strips metadata by default and
 * converts to sRGB). No SVG, GIF, TIFF, HEIF or anything else.
 */

// Every loader is blocked, then only the three buffer loaders come back (sharp docs, Security).
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: ["VipsForeignLoadPngBuffer", "VipsForeignLoadJpegBuffer", "VipsForeignLoadWebpBuffer"],
});
// Decoded images are not kept between requests.
sharp.cache(false);

export const IMAGE_LIMITS = {
  /** Largest decoded image: 25 megapixels, about 100 MB as RGBA. */
  inputPixels: 25_000_000,
  portrait: { width: 1024, height: 1536 },
  thumb: { width: 256, height: 384 },
  /**
   * The copy of a portrait a model reads: a JPEG within 1024 px on the long
   * edge. Worst case, noise filling 1024 x 1024 with every channel 0 or 255,
   * measured 715 KB (sharp 0.35.5, mozjpeg; uniform random noise 567 KB),
   * about 954,000 characters as a data URL: well under a 4.5 MB upstream
   * request body limit, which a 1024 x 1536 PNG of uniform noise (5.4 MB)
   * exceeds. `worstCaseBytes` is the bound the tests hold it to; nothing is
   * cut at run time.
   */
  vision: { width: 1024, height: 1024, quality: 80, worstCaseBytes: 800_000 },
  /** Image of a PNG export for a character without a portrait. */
  placeholder: { width: 512, height: 768, background: "#e6e2dc" },
} as const;

const ALLOWED_FORMATS = new Set(["png", "jpeg", "webp"]);

export type ImageErrorCode = "unsupported_image" | "image_too_large" | "invalid_image";

export class ImageError extends Error {
  override name = "ImageError";
  readonly code: ImageErrorCode;
  constructor(code: ImageErrorCode) {
    super(code);
    this.code = code;
  }
}

const decodeOptions = { failOn: "error", limitInputPixels: IMAGE_LIMITS.inputPixels } as const;

/** Strip PNG text and bound ICC before even a header read: libvips inflates metadata there. */
function portraitInput(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > CARD_LIMITS.uploadBytes) throw new ImageError("image_too_large");
  if (!isPng(bytes)) return bytes;
  const chunks = pngChunks(bytes);
  if (chunks === undefined) throw new ImageError("invalid_image");
  const input = pngPortraitInput(chunks);
  if (input === undefined) throw new ImageError("invalid_image");
  return input;
}

/** Format and size from the header alone; throws ImageError for anything not allowed. */
export async function imageHeader(
  bytes: Uint8Array,
): Promise<{ format: "png" | "jpeg" | "webp"; width: number; height: number }> {
  return readImageHeader(portraitInput(bytes));
}

async function readImageHeader(
  bytes: Uint8Array,
): Promise<{ format: "png" | "jpeg" | "webp"; width: number; height: number }> {
  let meta: Metadata;
  try {
    // Header only: no pixel data is decoded here. Unlimited so an oversized header is reported, not thrown.
    meta = await sharp(bytes, { failOn: "error", limitInputPixels: false }).metadata();
  } catch {
    throw new ImageError("unsupported_image");
  }
  const { format, width, height } = meta;
  if (!ALLOWED_FORMATS.has(format)) throw new ImageError("unsupported_image");
  if (!width || !height) throw new ImageError("invalid_image");
  if (width * height > IMAGE_LIMITS.inputPixels) throw new ImageError("image_too_large");
  return { format: format as "png" | "jpeg" | "webp", width, height };
}

/**
 * Turns an uploaded image into a stored portrait: oriented, fitted inside
 * 1024 × 1536 (never enlarged), re-encoded as PNG with nothing but pixels,
 * plus a WebP thumbnail.
 */
export async function toPortrait(bytes: Uint8Array): Promise<Portrait> {
  const input = portraitInput(bytes);
  await readImageHeader(input);
  try {
    const { data: png, info } = await sharp(input, decodeOptions)
      .autoOrient()
      .resize({ ...IMAGE_LIMITS.portrait, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    const thumb = await sharp(png, decodeOptions)
      .resize({ ...IMAGE_LIMITS.thumb, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return {
      png: new Uint8Array(png),
      thumb: new Uint8Array(thumb),
      width: info.width,
      height: info.height,
    };
  } catch {
    throw new ImageError("invalid_image");
  }
}

/**
 * The copy of a stored portrait PNG a vision model is sent: oriented, fitted
 * inside `IMAGE_LIMITS.vision` (never enlarged), flattened onto white and
 * re-encoded as a JPEG with no metadata. The stored portrait is unchanged.
 */
export async function toVisionImage(portraitPng: Uint8Array): Promise<Uint8Array> {
  const { width, height, quality } = IMAGE_LIMITS.vision;
  try {
    const jpeg = await sharp(portraitInput(portraitPng), decodeOptions)
      .autoOrient()
      .resize({ width, height, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return new Uint8Array(jpeg);
  } catch {
    throw new ImageError("invalid_image");
  }
}

/**
 * The face reference a scene's reference graph loads: the top third of a
 * stored portrait PNG at its full width, re-encoded as PNG with no metadata.
 * The crop carries the face where the whole portrait, scaled down by the
 * graph, does not. The stored portrait is unchanged.
 */
export async function toSceneReference(portraitPng: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const input = portraitInput(portraitPng);
    const { width, height } = await readImageHeader(input);
    const png = await sharp(input, decodeOptions)
      .extract({ left: 0, top: 0, width, height: Math.max(1, Math.floor(height / 3)) })
      .png()
      .toBuffer();
    return new Uint8Array(png);
  } catch {
    throw new ImageError("invalid_image");
  }
}

/**
 * The image of a PNG export: the stored portrait as it is (sharp wrote it,
 * metadata stripped, at upload), or a plain Canvas-colored placeholder.
 */
export async function exportImage(portraitPng: Uint8Array | undefined): Promise<Uint8Array> {
  if (portraitPng !== undefined) return portraitPng;
  const { width, height, background } = IMAGE_LIMITS.placeholder;
  return sharp({ create: { width, height, channels: 4, background } })
    .png()
    .toBuffer();
}
