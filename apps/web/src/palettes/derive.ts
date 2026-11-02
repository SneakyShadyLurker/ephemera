import {
  contrastRatio,
  PALETTE_ROLES,
  type Palette,
  type PaletteRole,
  type PaletteScheme,
  paletteProperty,
  paletteSchemeSchema,
} from "@ephemera/core";
import { type FollowingRole, isFollowing, type KeyRole } from "./roles.ts";

/*
 * The palette editor's colour work, done by the browser's own colour
 * functions (relative `oklch(from …)` and `color(from … srgb …)`) through a
 * hidden probe, so no colour library is needed. Every value is `#rrggbb`.
 *
 * A role the player has not set by hand follows its key colour relative to
 * the palette it started from: surfaces, borders and secondary text keep
 * their OKLCH distance from their key, and inks keep their contrast on their
 * ground. The result depends only on the base, the current key colours and
 * the hand-set roles, never on the order of edits, and a role whose key and
 * ground are unchanged keeps the base's exact value.
 */

type Oklch = [l: number, c: number, h: number];

/** Below this chroma a colour is grey and its hue means nothing. */
const GREY = 0.02;

let probe: HTMLElement | undefined;

function computed(color: string): string {
  if (probe === undefined || !probe.isConnected) {
    probe = document.createElement("span");
    probe.hidden = true;
    probe.setAttribute("aria-hidden", "true");
    document.body.append(probe);
  }
  probe.style.color = color;
  return getComputedStyle(probe).color;
}

const numbers = (value: string) => (value.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);

const toHex = (channels: number[]) =>
  `#${channels
    .slice(0, 3)
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** Any CSS colour as `#rrggbb`, clipped to sRGB. */
const hexOf = (color: string): string =>
  toHex(numbers(computed(`color(from ${color} srgb r g b)`)));

const oklchCache = new Map<string, Oklch>();

function oklchOf(hex: string): Oklch {
  const cached = oklchCache.get(hex);
  if (cached !== undefined) return cached;
  // An achromatic colour's hue serialises as `none`: no third number.
  const [l = 0, c = 0, h = 0] = numbers(computed(`oklch(from ${hex} l c h)`));
  const value: Oklch = [l, c, h];
  oklchCache.set(hex, value);
  return value;
}

const fromOklch = ([l, c, h]: Oklch) =>
  hexOf(`oklch(${Math.min(1, Math.max(0, l))} ${Math.max(0, c)} ${h})`);

/** The role's chroma and hue moved with its key's change since the base. */
function tinted(role: Oklch, keyBefore: Oklch, keyNow: Oklch): [c: number, h: number] {
  const c = Math.max(0, role[1] + keyNow[1] - keyBefore[1]);
  if (keyBefore[1] < GREY) return [c, keyNow[1] < GREY ? role[2] : keyNow[2]];
  return [c, role[2] + keyNow[2] - keyBefore[2]];
}

/** The lightness at which `[c, h]` meets `target` contrast on `ground`, on the given side of it. */
function atContrast(c: number, h: number, ground: string, target: number, lighter: boolean) {
  const groundL = oklchOf(ground)[0];
  let [lo, hi] = lighter ? [groundL, 1] : [0, groundL];
  for (let step = 0; step < 18; step++) {
    const mid = (lo + hi) / 2;
    const short = contrastRatio(fromOklch([mid, c, h]), ground) < target;
    if (short === lighter) lo = mid;
    else hi = mid;
  }
  return fromOklch([lighter ? hi : lo, c, h]);
}

/** How each following role follows: by its distance from its key, or by its contrast on a ground. */
type Rule =
  | { by: "distance"; key: KeyRole; hue: "key" | "own" }
  | { by: "contrast"; ground: KeyRole; hue: KeyRole | "own" };

const RULES = {
  "surface-hover": { by: "distance", key: "surface", hue: "key" },
  "surface-pressed": { by: "distance", key: "surface", hue: "key" },
  "surface-selected": { by: "distance", key: "surface", hue: "key" },
  rush: { by: "distance", key: "canvas", hue: "key" },
  "error-surface": { by: "distance", key: "canvas", hue: "own" },
  narration: { by: "distance", key: "ink", hue: "key" },
  "dusk-hover": { by: "distance", key: "dusk", hue: "key" },
  reed: { by: "contrast", ground: "canvas", hue: "ink" },
  "ink-action": { by: "contrast", ground: "canvas", hue: "ink" },
  "ink-thought": { by: "contrast", ground: "canvas", hue: "ink" },
  "ink-narration": { by: "contrast", ground: "canvas", hue: "ink" },
  "text-disabled": { by: "contrast", ground: "canvas", hue: "ink" },
  "control-edge": { by: "contrast", ground: "canvas", hue: "ink" },
  "dusk-line": { by: "contrast", ground: "canvas", hue: "dusk" },
  "on-dusk": { by: "contrast", ground: "dusk", hue: "own" },
  ember: { by: "contrast", ground: "canvas", hue: "own" },
  "tone-mist": { by: "contrast", ground: "canvas", hue: "own" },
} as const satisfies Record<FollowingRole, Rule>;

function follow(role: FollowingRole, base: PaletteScheme, now: PaletteScheme): string {
  const rule: Rule = RULES[role];
  const inputs: KeyRole[] =
    rule.by === "distance" ? [rule.key] : [rule.ground, ...(rule.hue === "own" ? [] : [rule.hue])];
  if (inputs.every((key) => base[key] === now[key])) return base[role];
  const own = oklchOf(base[role]);
  if (rule.by === "distance") {
    const before = oklchOf(base[rule.key]);
    const after = oklchOf(now[rule.key]);
    const [c, h] = rule.hue === "key" ? tinted(own, before, after) : [own[1], own[2]];
    return fromOklch([after[0] + own[0] - before[0], c, h]);
  }
  const [c, h] =
    rule.hue === "own"
      ? [own[1], own[2]]
      : tinted(own, oklchOf(base[rule.hue]), oklchOf(now[rule.hue]));
  const target = contrastRatio(base[role], base[rule.ground]);
  const lighter = own[0] > oklchOf(base[rule.ground])[0];
  return atContrast(c, h, now[rule.ground], target, lighter);
}

/**
 * The scheme with every role the player has not set by hand following the
 * current key colours, relative to `base` (the palette it started from).
 */
export function deriveScheme(
  base: PaletteScheme,
  now: PaletteScheme,
  handSet: readonly PaletteRole[],
): PaletteScheme {
  const derived = { ...now };
  for (const role of PALETTE_ROLES) {
    if (isFollowing(role) && !handSet.includes(role)) derived[role] = follow(role, base, now);
  }
  return derived;
}

/**
 * The classes that set a scheme. A stylesheet rule rather than an inline
 * style: the production build rewrites `light-dark()` into variables that
 * only a `color-scheme` rule in a stylesheet sets, and that resolve on the
 * element declaring a palette token, so a scheme reads a palette only on the
 * element carrying both; the dev server resolves it natively from the same
 * property. PalettePicker's swatches use them too.
 */
export const SCHEME_CLASS = { light: "[color-scheme:light]", dark: "[color-scheme:dark]" } as const;

/** A built-in palette's two schemes, from styles.css as the browser resolves them. */
export function readBuiltIn(palette: Palette): { light: PaletteScheme; dark: PaletteScheme } {
  const host = document.createElement("div");
  host.hidden = true;
  host.setAttribute("aria-hidden", "true");
  host.dataset.palette = palette;
  const swatch = document.createElement("span");
  host.append(swatch);
  document.body.append(host);
  const read = (scheme: "light" | "dark") => {
    host.className = SCHEME_CLASS[scheme];
    return paletteSchemeSchema.parse(
      Object.fromEntries(
        PALETTE_ROLES.map((role) => {
          swatch.style.color = `color(from var(${paletteProperty(role)}) srgb r g b)`;
          return [role, toHex(numbers(getComputedStyle(swatch).color))];
        }),
      ),
    );
  };
  const schemes = { light: read("light"), dark: read("dark") };
  host.remove();
  return schemes;
}
