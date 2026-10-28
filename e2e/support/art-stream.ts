import { decodeArtFrames } from "../../packages/core/src/creator/art-stream.ts";

/** Decode the art stream's frames as the tab received them: its PNGs, by index. */
export async function artImages(body: Buffer): Promise<Buffer[]> {
  const images: Buffer[] = [];
  async function* chunks() {
    yield body;
  }
  for await (const event of decodeArtFrames(chunks())) {
    if (event.type === "image") images[event.index] = Buffer.from(event.png);
  }
  return images;
}
