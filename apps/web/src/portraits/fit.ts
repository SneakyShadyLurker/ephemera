import { PORTRAIT_RENDITIONS } from "@ephemera/core";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { PortraitSize } from "./queries.ts";

/** A size in device pixels. */
export interface Pixels {
  width: number;
  height: number;
}

/** The WebP renditions a leaf chooses between. */
export type Fitted = Exclude<PortraitSize, "full">;

const THUMB = PORTRAIT_RENDITIONS.thumb;

/** Rounding between CSS and device pixels: a pixel short is not a reason for a larger image. */
const SLACK = 1;

/**
 * Whether the thumbnail has fewer pixels than a leaf draws. A leaf wider
 * than the thumbnail's box always does. Within the box it depends on the
 * art: the leaf is filled (`object-cover`), so art of other proportions than
 * 2:3 is stretched over it from the shorter of its sides, which only the
 * thumbnail's own size, `drawn`, tells once it has loaded. Art smaller than
 * the box is whole in the thumbnail, and no rendition has more of it.
 */
export function thumbFallsShort(leaf: Pixels, drawn: Pixels | null): boolean {
  if (leaf.width > THUMB.width + SLACK) return true;
  if (drawn === null || (drawn.width < THUMB.width && drawn.height < THUMB.height)) return false;
  return drawn.width + SLACK < leaf.width || drawn.height + SLACK < leaf.height;
}

/**
 * The sharpest rendition each portrait's leaves settled on in this tab, by
 * owner and id. A leaf mounted again starts from it, so its image is in the
 * first frame (a gallery tile under the transition back from its sheet), and
 * the viewer opens on the image already on screen.
 */
const settled = new Map<string, Fitted>();

const settle = (portrait: string, size: Fitted) => {
  if (size === "medium" || !settled.has(portrait)) settled.set(portrait, size);
};

/** The rendition a fitted leaf of this portrait shows, as far as this tab has measured. */
export const fittedSize = (portrait: string): Fitted => settled.get(portrait) ?? "thumb";

const pixelsOf = (leaf: HTMLElement): Pixels => ({
  width: leaf.clientWidth * window.devicePixelRatio,
  height: leaf.clientHeight * window.devicePixelRatio,
});

/**
 * The WebP a leaf draws at the size and density it is shown at: the
 * thumbnail while that has the leaf's device pixels, else the medium.
 * `portrait` names the portrait (owner and id), null for a leaf that does not
 * fit its image.
 *
 * A leaf starts on what the tab last settled for its portrait, else on the
 * thumbnail, and is measured before its first paint, then whenever its
 * device pixels change (a wider window, another screen, zoom). Only a leaf
 * that needs the medium renders again for it: a state update in a layout
 * effect also runs the commit's other effects before the paint, which a leaf
 * the thumbnail serves must not cause. A leaf that took the medium keeps it:
 * it never trades a sharp image for a soft one.
 *
 * `start` is the size as of the first measurement. Until then nothing of the
 * leaf was painted, so its image may be swapped whole (the caller keys the
 * image on it); a later change of `size` keeps the image drawn until the
 * sharper one has loaded. `drawn` takes each image as it loads.
 */
export function useFitted(
  frame: RefObject<HTMLElement | null>,
  portrait: string | null,
): { size: Fitted; start: Fitted; drawn: (image: HTMLImageElement) => void } {
  const [fit, setFit] = useState<{ size: Fitted; start: Fitted }>(() => {
    const size = portrait === null ? "thumb" : fittedSize(portrait);
    return { size, start: size };
  });
  /** The thumbnail's own pixels once it loaded. */
  const thumb = useRef<Pixels | null>(null);
  const sharp = fit.size === "medium";
  useLayoutEffect(() => {
    const leaf = frame.current;
    if (portrait === null || leaf === null || sharp) return;
    // Mounted or given another portrait: the last thumbnail's size says nothing of this one.
    thumb.current = null;
    const short = () => thumbFallsShort(pixelsOf(leaf), thumb.current);
    if (short()) {
      settle(portrait, "medium");
      setFit({ size: "medium", start: "medium" });
      return;
    }
    settle(portrait, "thumb");
    const observer = new ResizeObserver(() => {
      if (!short()) return;
      settle(portrait, "medium");
      setFit((last) => ({ ...last, size: "medium" }));
    });
    try {
      // Device pixels also change with the screen's density and with zoom, at one CSS size.
      observer.observe(leaf, { box: "device-pixel-content-box" });
    } catch {
      // Safari has no device-pixel box: the leaf's CSS size alone.
      observer.observe(leaf);
    }
    return () => observer.disconnect();
  }, [frame, portrait, sharp]);
  return {
    ...fit,
    drawn(image) {
      const leaf = frame.current;
      if (portrait === null || leaf === null || sharp) return;
      thumb.current = { width: image.naturalWidth, height: image.naturalHeight };
      if (!thumbFallsShort(pixelsOf(leaf), thumb.current)) return;
      settle(portrait, "medium");
      setFit((last) => ({ ...last, size: "medium" }));
    },
  };
}
