import { crc32, inflateSync } from "node:zlib";

/** PNG framing only: the walker never decodes pixels or decompresses metadata. */
const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export const isPng = (bytes: Uint8Array): boolean =>
  SIGNATURE.every((byte, index) => bytes[index] === byte);

interface PngChunk {
  type: string;
  /** The whole chunk, including its existing CRC. */
  bytes: Uint8Array;
  data: Uint8Array;
}

/** One bounded walker for card extraction and portrait sanitation. CRCs remain the decoder's job. */
export function pngChunks(bytes: Uint8Array): PngChunk[] | undefined {
  if (!isPng(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = SIGNATURE.length;
  while (offset + 12 <= bytes.byteLength) {
    // Bound framing overhead as well as bytes, including hostile zero-length chunks.
    if (chunks.length >= 16_384) return undefined;
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) return undefined;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) return undefined;
    chunks.push({
      type,
      bytes: bytes.subarray(offset, end),
      data: bytes.subarray(offset + 8, end - 4),
    });
    if (type === "IEND") return length === 0 ? chunks : undefined;
    offset = end;
  }
  return undefined;
}

/** Bytes a `tEXt` chunk of this keyword and Latin-1 text takes: length, type, data and CRC. */
const textChunkBytes = (keyword: string, text: string): number =>
  12 + keyword.length + 1 + text.length;

/** A `tEXt` chunk: the keyword, a null separator and the text, both Latin-1 (card text is base64). */
export function textChunk(keyword: string, text: string): Uint8Array {
  const chunk = Buffer.alloc(textChunkBytes(keyword, text));
  const end = chunk.byteLength - 4;
  chunk.writeUInt32BE(end - 8, 0);
  chunk.write("tEXt", 4, "latin1");
  chunk.write(`${keyword}\0${text}`, 8, "latin1");
  chunk.writeUInt32BE(crc32(chunk.subarray(4, end)), end);
  return chunk;
}

/**
 * `png` with `chunks` inserted before its `IEND`, every byte it had kept as
 * it was: no pixel is decoded or encoded again. Undefined when it is not a
 * PNG the walker reads.
 */
export function withChunks(png: Uint8Array, chunks: readonly Uint8Array[]): Uint8Array | undefined {
  const end = pngChunks(png)?.at(-1);
  if (end === undefined) return undefined;
  const at = end.bytes.byteOffset - png.byteOffset;
  return Buffer.concat([png.subarray(0, at), ...chunks, png.subarray(at)]);
}

// Pixel/color information is uncompressed except IDAT. A small uncompressed
// eXIf chunk can carry orientation. Text never reaches sharp; one bounded ICC
// profile may reach it for color conversion, then is stripped from output.
const PORTRAIT_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
]);

const MAX_ICC_PROFILE_BYTES = 1024 * 1024;

export function pngPortraitInput(chunks: PngChunk[]): Uint8Array | undefined {
  const profiles = chunks.filter((chunk) => chunk.type === "iCCP");
  // Check duplicates before inflation, so many chunks cannot multiply native work.
  if (profiles.length > 1) return undefined;
  const profile = profiles[0];
  if (profile !== undefined) {
    const separator = profile.data.indexOf(0);
    if (
      separator < 1 ||
      separator > 79 ||
      profile.data[separator + 1] !== 0 ||
      separator + 2 >= profile.data.byteLength
    )
      return undefined;
    try {
      const inflated = inflateSync(profile.data.subarray(separator + 2), {
        maxOutputLength: MAX_ICC_PROFILE_BYTES,
      });
      if (inflated.byteLength === 0) return undefined;
    } catch {
      return undefined;
    }
  }
  const kept = chunks.filter(
    (chunk) =>
      PORTRAIT_CHUNKS.has(chunk.type) ||
      chunk === profile ||
      (chunk.type === "eXIf" && chunk.data.byteLength <= 65_536),
  );
  return Buffer.concat([SIGNATURE, ...kept.map((chunk) => chunk.bytes)]);
}
