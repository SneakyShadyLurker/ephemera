import type { z } from "zod";
import { CREATOR_ART } from "./limits.ts";
import { artControlEventSchema } from "./schema.ts";

export const ART_STREAM_TYPE = "application/vnd.ephemera.art-stream.v1";
export const ART_FRAME_HEADER_BYTES = 5;
export const ART_CONTROL_BYTES = 64 * 1024;
export const ART_KEEPALIVE = new Uint8Array(ART_FRAME_HEADER_BYTES);

/** One event of the art stream: progress, the four images, then done; or an error. */
export type ArtStreamEvent =
  | z.infer<typeof artControlEventSchema>
  | {
      type: "image";
      index: number;
      png: Uint8Array<ArrayBuffer>;
    };

const invalid = () => new TypeError("invalid_art_stream");

/** One atomic envelope, including its payload. The stream's keepalive cannot split it. */
export function encodeArtFrame(event: ArtStreamEvent): Uint8Array<ArrayBuffer> {
  let payload: Uint8Array;
  if (event.type === "image") {
    if (
      !Number.isInteger(event.index) ||
      event.index < 0 ||
      event.index >= CREATOR_ART.count ||
      event.png.byteLength === 0 ||
      event.png.byteLength > CREATOR_ART.imageBytes
    )
      throw invalid();
    payload = new Uint8Array(1 + event.png.byteLength);
    payload[0] = event.index;
    payload.set(event.png, 1);
  } else {
    payload = new TextEncoder().encode(JSON.stringify(artControlEventSchema.parse(event)));
    if (payload.byteLength > ART_CONTROL_BYTES) throw invalid();
  }
  const frame = new Uint8Array(ART_FRAME_HEADER_BYTES + payload.byteLength);
  frame[0] = event.type === "image" ? 2 : 1;
  new DataView(frame.buffer).setUint32(1, payload.byteLength);
  frame.set(payload, ART_FRAME_HEADER_BYTES);
  return frame;
}

/** Validates the batch's bounds at either reader boundary, before the consumer holds it. */
export function artBatchGuard() {
  let bytes = 0;
  const indices = new Set<number>();
  return (event: ArtStreamEvent): ArtStreamEvent => {
    if (event.type === "image") {
      bytes += event.png.byteLength;
      if (indices.has(event.index) || bytes > CREATOR_ART.batchBytes) throw invalid();
      indices.add(event.index);
    }
    return event;
  };
}

/** Linear framing across arbitrary network fragments; allocate only after checking the envelope. */
export async function* decodeArtFrames(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<ArtStreamEvent> {
  const header = new Uint8Array(ART_FRAME_HEADER_BYTES);
  let headerUsed = 0;
  let payload: Uint8Array<ArrayBuffer> | undefined;
  let used = 0;
  const guard = artBatchGuard();
  for await (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (payload === undefined) {
        const take = Math.min(header.byteLength - headerUsed, chunk.byteLength - offset);
        header.set(chunk.subarray(offset, offset + take), headerUsed);
        headerUsed += take;
        offset += take;
        if (headerUsed !== header.byteLength) continue;
        const kind = header[0];
        const length = new DataView(header.buffer).getUint32(1);
        if (kind === 0 && length === 0) {
          headerUsed = 0;
          continue;
        }
        if (
          !(
            (kind === 1 && length > 0 && length <= ART_CONTROL_BYTES) ||
            (kind === 2 && length > 1 && length <= CREATOR_ART.imageBytes + 1)
          )
        )
          throw invalid();
        payload = new Uint8Array(length);
        used = 0;
      }
      const take = Math.min(payload.byteLength - used, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + take), used);
      used += take;
      offset += take;
      if (used !== payload.byteLength) continue;
      if (header[0] === 2) {
        const index = payload[0];
        if (index === undefined || index >= CREATOR_ART.count) throw invalid();
        yield guard({ type: "image", index, png: payload.subarray(1) });
      } else {
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        } catch {
          throw invalid();
        }
        const parsed = artControlEventSchema.safeParse(value);
        if (!parsed.success) throw invalid();
        yield parsed.data;
      }
      payload = undefined;
      headerUsed = 0;
    }
  }
  if (headerUsed !== 0 || payload !== undefined) throw invalid();
}
