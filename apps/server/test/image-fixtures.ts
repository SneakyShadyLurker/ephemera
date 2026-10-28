import { crc32, deflateSync } from "node:zlib";
import { decode, encode } from "fast-png";
import sharp from "sharp";

/** Hostile and ordinary images for the avatar and card tests. Built in memory. */

const create = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#305070" } });

export const plainPng = (width = 30, height = 45) => create(width, height).png().toBuffer();
export const plainJpeg = (width = 30, height = 45) => create(width, height).jpeg().toBuffer();
export const plainWebp = (width = 30, height = 45) => create(width, height).webp().toBuffer();
export const displayP3Png = () =>
  sharp(Uint8Array.of(200, 100, 50), { raw: { width: 1, height: 1, channels: 3 } })
    .withIccProfile("p3")
    .png()
    .toBuffer();
export const tiff = () => create(4, 4).tiff().toBuffer();
export const gif = () => create(4, 4).gif().toBuffer();

/** A PNG carrying `tEXt` chunks, as card PNGs do. */
export function pngWithText(text: Record<string, string>, width = 12, height = 18): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(180);
  return encode({ width, height, data, channels: 4, text });
}

/**
 * An opaque PNG whose top `rows` rows are random pixels, so no two encode alike; the rest is flat.
 * `binary` sets every channel of the noise to 0 or 255, the hardest noise for a JPEG.
 */
export function pngWithNoise(
  width: number,
  height: number,
  rows: number,
  binary = false,
): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(180);
  const noise = data.subarray(0, width * rows * 4);
  // getRandomValues fills at most 65,536 bytes a call.
  for (let start = 0; start < noise.length; start += 65_536) {
    crypto.getRandomValues(noise.subarray(start, start + 65_536));
  }
  if (binary) noise.set(noise.map((value) => (value & 1 ? 255 : 0)));
  for (let alpha = 3; alpha < noise.length; alpha += 4) noise[alpha] = 255;
  return encode({ width, height, data, channels: 4 });
}

export const cardChunk = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/** A JPEG with EXIF (author, description, GPS), XMP and a rotated orientation. */
export function jpegWithMetadata(): Promise<Buffer> {
  const xmp = `<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>metadata-canary</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return (
    create(40, 20)
      .jpeg()
      // sharp writes the orientation tag itself; set through withExif it is overwritten.
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Artist: "metadata-canary", ImageDescription: "metadata-canary" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "49/1 36/1 0/1" },
      })
      .withXmp(xmp)
      .toBuffer()
  );
}

/** A tiny PNG whose header claims the given size: a decompression-bomb header. */
export function pngClaiming(width: number, height: number): Uint8Array {
  const png = Uint8Array.from(pngWithText({}, 1, 1));
  const view = new DataView(png.buffer);
  // IHDR data starts at byte 16: width, height; its CRC covers type and data (bytes 12..28).
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(png.subarray(12, 29)));
  return png;
}

/** A real PNG over the pixel cap that compresses to almost nothing. */
export const bombPng = () => create(6000, 6000).png({ compressionLevel: 9 }).toBuffer();

export const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);
export const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

/** A valid PNG followed by an HTML payload. */
export async function polyglotPng(): Promise<Uint8Array> {
  return Buffer.concat([await plainPng(), Buffer.from("<script>alert('polyglot')</script>")]);
}

/** For e2e specs, which cannot resolve the server's image libraries themselves. */
export const imageMetadata = (bytes: Uint8Array | Buffer) => sharp(bytes).metadata();
export const pngText = (bytes: Uint8Array | Buffer): Record<string, string> =>
  decode(new Uint8Array(bytes)).text;

export function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Small metadata chunks that inflate to many megabytes if handed to libpng. */
export function compressedMetadataPng(
  type: "zTXt" | "iTXt" | "iCCP",
  text: Record<string, string> = {},
): Buffer {
  const base = Buffer.from(pngWithText(text, 1, 1));
  const compressed = deflateSync(Buffer.alloc(32 * 1024 * 1024, 65));
  const prefix = type === "iTXt" ? "Comment\0\x01\0\0\0" : "Comment\0\0";
  return Buffer.concat([
    base.subarray(0, 33),
    pngChunk(type, Buffer.concat([Buffer.from(prefix, "latin1"), compressed])),
    base.subarray(33),
  ]);
}

/**
 * A small card PNG (a few hundred KB) whose image data inflates to
 * `inflatedMb` megabytes: a full decoder would allocate all of it.
 */
export function bombCardPng(text: Record<string, string>, inflatedMb = 300): Buffer {
  const base = Buffer.from(pngWithText(text, 8, 8));
  const iend = base.length - 12;
  const idat = deflateSync(Buffer.alloc(inflatedMb * 1024 * 1024));
  return Buffer.concat([base.subarray(0, iend), pngChunk("IDAT", idat), base.subarray(iend)]);
}
