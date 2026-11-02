import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { sampledPixels } from "../portraits/atmosphere.ts";
import type { ArtImage, ArtSliceState } from "./art-slice.ts";

/*
 * The candidate portraits as the showcase draws them: the PNG bytes decoded
 * from memory into bitmaps drawn on canvas, so no image ever has a URL (no
 * object URL, no `data:` or `blob:` source) or passes through a Blob, which
 * the browser may move to disk. WebCodecs' `ImageDecoder` decodes them.
 */

/** One PNG decoded from its bytes; the bytes are copied, never transferred, as Keep still needs them. */
export async function decodePng(png: ArtImage): Promise<ImageBitmap> {
  const decoder = new ImageDecoder({ data: png, type: "image/png" });
  try {
    const { image } = await decoder.decode();
    try {
      return await createImageBitmap(image);
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

/** A batch as the showcase can show it: decoded together, so all four arrive at once. */
export type DecodedBatch =
  | { status: "none" }
  | { status: "decoding" }
  | { status: "failed" }
  | {
      status: "ready";
      bitmaps: ImageBitmap[];
      /** Each portrait drawn small, for the room's hue lean. */
      pixels: Uint8ClampedArray[];
    };

type Decoded = {
  source: ArtImage[];
  epoch: number;
  result: Extract<DecodedBatch, { status: "ready" | "failed" }>;
};

/**
 * Decodes the batch on show in the art session `store`. The bitmaps are
 * closed when the batch is replaced, on unmount and when the session epoch
 * changes, and a decode that resolves after any of those is closed at once
 * and never shown.
 */
export function useDecodedBatch(store: StoreApi<ArtSliceState>, images: ArtImage[]): DecodedBatch {
  const epoch = useStore(store, (state) => state.epoch);
  const [decoded, setDecoded] = useState<Decoded | null>(null);

  useEffect(() => {
    if (images.length === 0) return;
    let live = true;
    let bitmaps: ImageBitmap[] = [];
    const current = () => live && store.getState().epoch === epoch;
    void Promise.allSettled(images.map(decodePng)).then((settled) => {
      const done = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (!current() || done.length !== images.length) {
        for (const bitmap of done) bitmap.close();
        if (current()) setDecoded({ source: images, epoch, result: { status: "failed" } });
        return;
      }
      bitmaps = done;
      setDecoded({
        source: images,
        epoch,
        result: { status: "ready", bitmaps: done, pixels: done.map(sampledPixels) },
      });
    });
    return () => {
      live = false;
      for (const bitmap of bitmaps) bitmap.close();
    };
  }, [store, images, epoch]);

  if (images.length === 0) return { status: "none" };
  if (decoded === null || decoded.source !== images || decoded.epoch !== epoch) {
    return { status: "decoding" };
  }
  return decoded.result;
}

const batchKeys = new WeakMap<ArtImage[], string>();
let batches = 0;

/** A key per batch, so a new batch remounts its canvases and its reveal plays again. */
export function batchKey(images: ArtImage[]): string {
  let key = batchKeys.get(images);
  if (key === undefined) {
    key = String(++batches);
    batchKeys.set(images, key);
  }
  return key;
}

/** The shared-element name of the art that morphs from an alternate into the main frame. */
export const ART_TRANSITION = "creator-art";
