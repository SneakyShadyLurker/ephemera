import { describe, expect, it } from "vitest";
import { TINT_CAP, tintFromPixels } from "./atmosphere.ts";

type Rgb = readonly [number, number, number];

/** A 24 by 36 thumb, as the hook draws it, filled with `fill` except for the first `patch` pixels. */
function pixels(fill: Rgb, patch: { color: Rgb; count: number } = { color: fill, count: 0 }) {
  const count = 24 * 36;
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    data.set([...(i < patch.count ? patch.color : fill), 255], i * 4);
  }
  return data;
}

const WARM: Rgb = [190, 60, 40];
const COOL: Rgb = [30, 130, 210];

describe("tintFromPixels", () => {
  it("takes a warm hue from a saturated warm field", () => {
    const tint = tintFromPixels(pixels(WARM), "light");
    expect(tint?.hue).toBeGreaterThan(25);
    expect(tint?.hue).toBeLessThan(40);
  });

  it("takes a hue near 250 from a saturated cool field", () => {
    const tint = tintFromPixels(pixels(COOL), "dark");
    expect(tint?.hue).toBeGreaterThan(240);
    expect(tint?.hue).toBeLessThan(260);
  });

  it("gives no tint for a mid grey", () => {
    expect(tintFromPixels(pixels([128, 128, 128]), "light")).toBeNull();
    expect(tintFromPixels(pixels([128, 128, 128]), "dark")).toBeNull();
  });

  it("gives no tint when only a small patch of a white field has colour", () => {
    // 60 of 864 pixels, about 7 %: below the 8 % that make a portrait colourful.
    const data = pixels([250, 250, 250], { color: WARM, count: 60 });
    expect(tintFromPixels(data, "light")).toBeNull();
  });

  it("follows the colourful pixels once enough of them survive", () => {
    const tint = tintFromPixels(pixels([250, 250, 250], { color: COOL, count: 200 }), "light");
    expect(tint?.hue).toBeGreaterThan(240);
    expect(tint?.hue).toBeLessThan(260);
  });

  it("caps the mix per scheme, a little higher in dark", () => {
    expect(tintFromPixels(pixels(WARM), "light")?.mix).toBeCloseTo(TINT_CAP.light, 6);
    expect(tintFromPixels(pixels(WARM), "dark")?.mix).toBeCloseTo(TINT_CAP.dark, 6);
    expect(TINT_CAP).toEqual({ light: 10, dark: 14 });
  });

  it("leans less for a muted portrait than for a saturated one", () => {
    const muted = tintFromPixels(pixels([150, 110, 95]), "light");
    expect(muted).not.toBeNull();
    expect(muted?.mix).toBeLessThan(TINT_CAP.light);
    expect(muted?.mix).toBeGreaterThan(0);
  });

  it("leans little toward a portrait split between opposite hues", () => {
    // Half orange, half teal: their average is a hue neither half has.
    const teal: Rgb = [20, 150, 150];
    const orange: Rgb = [220, 120, 40];
    const split = tintFromPixels(pixels(teal, { color: orange, count: (24 * 36) / 2 }), "light");
    expect(split?.mix).toBeLessThan(TINT_CAP.light * 0.25);
  });

  it("leans little toward a saturated portrait of opposite hues, however vivid", () => {
    const red: Rgb = [230, 20, 40];
    const cyan: Rgb = [0, 200, 220];
    const split = tintFromPixels(pixels(cyan, { color: red, count: (24 * 36) / 2 }), "dark");
    expect(split?.mix).toBeLessThan(TINT_CAP.dark * 0.25);
  });
});
