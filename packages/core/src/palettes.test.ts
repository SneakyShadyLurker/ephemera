import { describe, expect, it } from "vitest";
import {
  type CustomPaletteInput,
  contrastRatio,
  contrastShortfalls,
  customPaletteCss,
  customPaletteInputSchema,
  PALETTE_ROLES,
  paletteSchemeSchema,
} from "./palettes.ts";

const scheme = (hex: string, ink: string) =>
  paletteSchemeSchema.parse({
    ...Object.fromEntries(PALETTE_ROLES.map((role) => [role, hex])),
    ink,
  });

const input = (): CustomPaletteInput => ({
  name: "Dusk",
  base: "nord",
  light: scheme("#e5e9f0", "#2e3440"),
  dark: scheme("#2e3440", "#eef1f6"),
  origin: { light: scheme("#e5e9f0", "#2e3440"), dark: scheme("#2e3440", "#eef1f6") },
  handSet: { light: ["canvas"], dark: [] },
});

describe("custom palettes", () => {
  it("accepts a full palette and trims its name", () => {
    const palette = { ...input(), name: "  Dusk  ", base: "custom-2" };
    expect(customPaletteInputSchema.parse(palette)).toEqual({ ...palette, name: "Dusk" });
  });

  it.each([
    [
      "an uppercase hex",
      (p: CustomPaletteInput) => ({ ...p, light: { ...p.light, ink: "#2E3440" } }),
    ],
    ["a short hex", (p: CustomPaletteInput) => ({ ...p, dark: { ...p.dark, dusk: "#abc" } })],
    [
      "a missing role",
      (p: CustomPaletteInput) => {
        const { "tone-mist": _missing, ...light } = p.light;
        return { ...p, light };
      },
    ],
    [
      "an unknown role",
      (p: CustomPaletteInput) => ({ ...p, dark: { ...p.dark, glow: "#ffffff" } }),
    ],
    ["an unknown key", (p: CustomPaletteInput) => ({ ...p, messages: [] })],
    ["an empty name", (p: CustomPaletteInput) => ({ ...p, name: "   " })],
    [
      "a repeated hand-set role",
      (p: CustomPaletteInput) => ({ ...p, handSet: { light: ["ink", "ink"], dark: [] } }),
    ],
  ])("rejects %s", (_case, change) => {
    expect(customPaletteInputSchema.safeParse(change(input())).success).toBe(false);
  });

  it("writes one light-dark rule per palette, with the scrim from the light ink", () => {
    const css = customPaletteCss([{ ...input(), slot: 2, updatedAt: 1 }]);
    expect(css.startsWith('[data-palette="custom-2"] {\n')).toBe(true);
    expect(css).toContain("  --canvas-base: light-dark(#e5e9f0, #2e3440);\n");
    expect(css).toContain("  --rush-base: light-dark(#e5e9f0, #2e3440);\n");
    expect(css).toContain("  --ink: light-dark(#2e3440, #eef1f6);\n");
    expect(css).toContain("  --tone-mist: light-dark(#e5e9f0, #2e3440);\n");
    expect(css).toContain("  --scrim: light-dark(rgb(46 52 64 / 0.3), rgb(0 0 0 / 0.55));\n");
    expect(css).toContain(
      "  --shadow-overlay: light-dark(rgb(46 52 64 / 0.14), rgb(0 0 0 / 0.5));\n}\n",
    );
    expect(css.match(/^ {2}--/gm)).toHaveLength(PALETTE_ROLES.length + 2);
    expect(customPaletteCss([])).toBe("");
  });

  it("refuses to write a value that is not a validated colour", () => {
    const palette = { ...input(), slot: 1 as const, updatedAt: 1 };
    const injected = { ...palette, light: { ...palette.light, ink: "red;} body{x:y" } };
    expect(() => customPaletteCss([injected])).toThrow();
  });
});

/** Lamplight by day, as styles.css declares it. */
const LAMPLIGHT_DAY = paletteSchemeSchema.parse({
  canvas: "#e6e2dc",
  surface: "#f0ede8",
  "surface-hover": "#d9d4cd",
  "surface-pressed": "#cdc6bd",
  "surface-selected": "#d6d0c7",
  rush: "#cec8c0",
  ink: "#2a231e",
  narration: "#4f463e",
  "ink-action": "#574d45",
  "ink-thought": "#675d55",
  "ink-narration": "#5a6065",
  reed: "#625850",
  "control-edge": "#837a70",
  "text-disabled": "#9a928a",
  dusk: "#c77f1e",
  "dusk-hover": "#b7731a",
  "dusk-line": "#9a6210",
  "on-dusk": "#17130f",
  ember: "#9e3325",
  "error-surface": "#f0dad2",
  "tone-rose": "#7c3253",
  "tone-sage": "#1a5d45",
  "tone-iris": "#4e4388",
  "tone-mist": "#525c67",
});

describe("contrast floors", () => {
  it("measures WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  it("finds nothing short in a built-in palette", () => {
    expect(contrastShortfalls(LAMPLIGHT_DAY)).toEqual([]);
  });

  it("names a role's weakest ground, its wash included", () => {
    const shortfalls = contrastShortfalls({
      ...LAMPLIGHT_DAY,
      ink: "#a09890",
      "tone-sage": "#6f9a86",
    });
    expect(shortfalls.map(({ role, ground }) => [role, ground])).toEqual([
      ["ink", { role: "surface-selected", wash: false }],
      ["tone-sage", { role: "canvas", wash: true }],
    ]);
    expect(shortfalls[0]?.floor).toBe(7);
    expect(shortfalls[0]?.ratio).toBeLessThan(7);
  });
});
