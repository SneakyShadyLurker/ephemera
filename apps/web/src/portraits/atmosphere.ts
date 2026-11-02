import type { CharacterSummary } from "@ephemera/core";
import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import { portraitUrl } from "./queries.ts";

/**
 * The room's faint lean toward the character's portrait: a hue and how far
 * the surfaces mix toward it. Derived in the browser from the same-origin
 * thumb and held in memory only; never saved, sent or logged.
 */
interface Tint {
  /** OKLCH hue in degrees, 0 to 360. */
  hue: number;
  /** Share of the tint colour in each surface, in percent. */
  mix: number;
}

export type Scheme = "light" | "dark";

/** The strongest lean per scheme; dark surfaces show chroma less, so they take a little more. */
export const TINT_CAP: Record<Scheme, number> = { light: 10, dark: 14 };

/** Mean chroma at which a portrait reaches the cap. */
const FULL_CHROMA = 0.15;
const MIN_CHROMA = 0.04;
const MIN_LIGHTNESS = 0.2;
const MAX_LIGHTNESS = 0.85;
/** Below this share of colourful pixels a portrait counts as grey, black or white. */
const MIN_SURVIVORS = 0.08;

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** sRGB bytes to OKLab (Björn Ottosson's matrices). */
function oklab(r8: number, g8: number, b8: number): [number, number, number] {
  const r = linear(r8);
  const g = linear(g8);
  const b = linear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * The tint of RGBA pixels: the chroma-weighted hue of the colourful,
 * mid-light pixels, and a mix from their mean chroma up to the scheme's cap,
 * scaled by how much their hues agree.
 * Null when too few pixels are colourful.
 */
export function tintFromPixels(data: Uint8ClampedArray, scheme: Scheme): Tint | null {
  const pixels = Math.floor(data.length / 4);
  let survivors = 0;
  let chroma = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    if ((data[i + 3] ?? 0) < 128) continue;
    const [l, a, b] = oklab(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    const c = Math.hypot(a, b);
    if (l < MIN_LIGHTNESS || l > MAX_LIGHTNESS || c <= MIN_CHROMA) continue;
    survivors++;
    chroma += c;
    // Each pixel's unit hue weighted by its chroma is its own (a, b).
    sumA += a;
    sumB += b;
  }
  if (pixels === 0 || survivors / pixels < MIN_SURVIVORS) return null;
  const hue = ((Math.atan2(sumB, sumA) * 180) / Math.PI + 360) % 360;
  // How much the colours agree, 0 to 1, squared: a portrait split between
  // distant hues averages to a hue it does not contain, so it leans the room
  // far less, while a portrait of one hue keeps its full lean.
  const agreement = (Math.hypot(sumA, sumB) / chroma) ** 2;
  const cap = TINT_CAP[scheme];
  const mix = Math.min(cap, (cap * chroma) / survivors / FULL_CHROMA) * agreement;
  return { hue, mix };
}

/** The thumb drawn small; the browser does the downsampling. */
async function portraitPixels(src: string): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return sampledPixels(image);
}

/**
 * An image drawn small enough to read its tint, as RGBA pixels: a portrait
 * thumb, or a candidate portrait decoded in memory (the creator's showcase).
 */
export function sampledPixels(image: CanvasImageSource): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 36;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("No 2D context");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

/**
 * The tint of the chat character's portrait. Null without a character, a
 * portrait or a colourful one, or when the image fails. Switching characters
 * keeps the previous tint until the next one is ready. The thumb's pixels are
 * read once per portrait version; a scheme change only re-derives the tint.
 * A thumb refused while signed out loads again after the renewal (app/query.ts
 * refetches failed queries).
 */
export function useAtmosphere(character: CharacterSummary | undefined, scheme: Scheme) {
  const id = character?.id;
  const version = character?.portrait ?? null;
  const pixels = useQuery({
    queryKey: ["portrait-pixels", id, version],
    queryFn:
      id === undefined || version === null
        ? skipToken
        : () => portraitPixels(portraitUrl("characters", id, version, "thumb")),
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (id === undefined || version === null || pixels.data === undefined) return null;
  return tintFromPixels(pixels.data, scheme);
}

/** Bumped by every change, so a fade-out that finishes late leaves a newer tint alone. */
let applied = 0;

/**
 * Leans the root's surfaces toward the tint (styles.css `data-atmosphere`),
 * or fades the lean to nothing and then drops it. The hue takes the short
 * way round, so a change of character never sweeps through the wheel.
 */
export function applyAtmosphere(tint: Tint | null): void {
  const root = document.documentElement;
  const change = ++applied;
  if (tint === null) {
    if (root.dataset.atmosphere === undefined) return;
    root.style.setProperty("--tint-mix", "0%");
    const fade = root
      .getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSTransition && animation.transitionProperty === "--tint-mix",
      );
    const drop = () => {
      if (change !== applied) return;
      withoutTransition(root, () => {
        delete root.dataset.atmosphere;
        root.style.removeProperty("--tint-mix");
        root.style.removeProperty("--tint-h");
      });
    };
    if (fade === undefined) drop();
    else fade.finished.then(drop, () => undefined);
    return;
  }
  const previous = Number.parseFloat(root.style.getPropertyValue("--tint-h"));
  if (Number.isNaN(previous)) {
    // A first tint takes its hue at once, while the mix is still nothing, so
    // it never sweeps in from hue 0; only the mix fades in.
    withoutTransition(root, () => root.style.setProperty("--tint-h", String(tint.hue)));
  } else {
    const hue = previous + ((((tint.hue - previous) % 360) + 540) % 360) - 180;
    root.style.setProperty("--tint-h", String(hue));
  }
  root.dataset.atmosphere = "";
  root.style.setProperty("--tint-mix", `${tint.mix}%`);
}

/** Applies a style change with transitions off, then turns them back on for later changes. */
function withoutTransition(root: HTMLElement, change: () => void): void {
  root.style.setProperty("transition", "none");
  change();
  // Reading a computed value applies the change before transitions return.
  getComputedStyle(root).getPropertyValue("--tint-h");
  root.style.removeProperty("transition");
}
