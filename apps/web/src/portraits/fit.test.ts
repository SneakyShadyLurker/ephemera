import { PORTRAIT_RENDITIONS } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { thumbFallsShort } from "./fit.ts";

const { thumb } = PORTRAIT_RENDITIONS;
/** A 2:3 leaf of this width, in device pixels. */
const leaf = (width: number) => ({ width, height: width * 1.5 });

describe("thumbFallsShort", () => {
  it("keeps the thumbnail for a leaf within its box", () => {
    expect(thumbFallsShort(leaf(thumb.width), null)).toBe(false);
    expect(thumbFallsShort(leaf(thumb.width), thumb)).toBe(false);
    expect(thumbFallsShort(leaf(40), thumb)).toBe(false);
  });

  it("asks for more once the leaf is wider than the box, before any image loaded", () => {
    // A gallery tile on a 4K screen at 2x, and a full HD tile at 1x.
    expect(thumbFallsShort(leaf(562), null)).toBe(true);
    expect(thumbFallsShort(leaf(281), null)).toBe(true);
  });

  it("does not count a pixel of rounding as falling short", () => {
    const off = { width: thumb.width + 1, height: thumb.height + 1 };
    expect(thumbFallsShort(off, thumb)).toBe(false);
    expect(thumbFallsShort(leaf(thumb.width + 2), thumb)).toBe(true);
  });

  it("asks for more when art of other proportions fills the leaf from too few pixels", () => {
    // Square art: the thumbnail is 256 x 256, stretched over the leaf's height.
    const square = { width: thumb.width, height: thumb.width };
    expect(thumbFallsShort(leaf(250), square)).toBe(true);
    expect(thumbFallsShort(leaf(170), square)).toBe(false);
    // Tall art: the thumbnail is narrower than its box.
    const tall = { width: 128, height: thumb.height };
    expect(thumbFallsShort(leaf(200), tall)).toBe(true);
    expect(thumbFallsShort(leaf(128), tall)).toBe(false);
  });

  it("keeps a thumbnail that holds the whole of small art", () => {
    expect(thumbFallsShort(leaf(250), { width: 60, height: 90 })).toBe(false);
  });
});
