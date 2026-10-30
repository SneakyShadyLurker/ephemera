import { z } from "zod";
import { HIGHLIGHT_TONES } from "./preset/highlight.ts";

/*
 * Colour palettes: the built-ins and up to three the player makes. A custom
 * palette is a UI setting (PRINCIPLES.md 1), kept on the server per user.
 */

/**
 * The colour palette, each with a light and a dark scheme the theme picks
 * between; colours only, never layout or type. Lamplight is Ephemera's own;\n * Tokyo Night is the default.
 */
export const PALETTES = [
  "lamplight",
  "catppuccin",
  "rose-pine",
  "nord",
  "gruvbox",
  "tokyo-night",
] as const;
export type Palette = (typeof PALETTES)[number];

/** The palette a new installation starts on; it needs no `data-palette` attribute. */
export const DEFAULT_PALETTE = "tokyo-night" satisfies Palette;

/** The player's palettes, one per slot. */
const CUSTOM_PALETTES = ["custom-1", "custom-2", "custom-3"] as const;
type CustomPaletteId = (typeof CUSTOM_PALETTES)[number];

export const CUSTOM_SLOTS = [1, 2, 3] as const;
export type CustomSlot = (typeof CUSTOM_SLOTS)[number];
export const customSlotSchema = z.literal(CUSTOM_SLOTS);

/** Every palette the settings may choose: a built-in or a custom slot. */
export const PALETTE_CHOICES = [...PALETTES, ...CUSTOM_PALETTES] as const;
export type PaletteChoice = Palette | CustomPaletteId;

const SLOT_OF = {
  "custom-1": 1,
  "custom-2": 2,
  "custom-3": 3,
} as const satisfies Record<CustomPaletteId, CustomSlot>;

export const isCustomPalette = (palette: string): palette is CustomPaletteId =>
  CUSTOM_PALETTES.some((id) => id === palette);
export const customPaletteId = (slot: CustomSlot): CustomPaletteId => `custom-${slot}`;
export const customPaletteSlot = (id: CustomPaletteId): CustomSlot => SLOT_OF[id];

/** The built-in palette a choice stands for: itself, or the default for a custom one. */
export const builtInBase = (palette: PaletteChoice): Palette =>
  isCustomPalette(palette) ? DEFAULT_PALETTE : palette;

/** The `data-palette` attribute a choice sets on `<html>`; the default sets none. */
export const paletteAttribute = (palette: PaletteChoice): PaletteChoice | undefined =>
  palette === DEFAULT_PALETTE ? undefined : palette;

/** Every colour a palette sets, per scheme; scrim and overlay shadow derive from `ink`. */
export const PALETTE_ROLES = [
  "canvas",
  "surface",
  "surface-hover",
  "surface-pressed",
  "surface-selected",
  "rush",
  "ink",
  "narration",
  "ink-action",
  "ink-thought",
  "ink-narration",
  "reed",
  "control-edge",
  "text-disabled",
  "dusk",
  "dusk-hover",
  "dusk-line",
  "on-dusk",
  "ember",
  "error-surface",
  ...HIGHLIGHT_TONES.map((tone) => `tone-${tone}` as const),
] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];

/** The roles the editor always shows; the rest follow them unless set by hand. */
export const KEY_ROLES = [
  "canvas",
  "surface",
  "ink",
  "dusk",
  "tone-rose",
  "tone-sage",
  "tone-iris",
] as const satisfies readonly PaletteRole[];

/** Surface tokens the stylesheet tints with the portrait; they take the `-base` suffix. */
const BASE_ROLES: ReadonlySet<PaletteRole> = new Set([
  "canvas",
  "surface",
  "surface-hover",
  "surface-pressed",
  "surface-selected",
  "rush",
]);

/** Lowercase `#rrggbb` only, so a colour can reach CSS as it is. */
const hexColourSchema = z.string().regex(/^#[0-9a-f]{6}$/);

const roleSchema = z.enum(PALETTE_ROLES);

/** Every role, each once; a record over an enum is exhaustive and refuses other keys. */
export const paletteSchemeSchema = z.record(roleSchema, hexColourSchema);
export type PaletteScheme = z.infer<typeof paletteSchemeSchema>;

const handSetRoles = z
  .array(roleSchema)
  .refine((roles) => new Set(roles).size === roles.length, "roles must be unique");

/** The longest palette name. */
export const PALETTE_NAME_LENGTH = 40;

export const customPaletteInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(PALETTE_NAME_LENGTH),
  /** The palette it started from, which a deletion of the selected one returns to when built in. */
  base: z.enum(PALETTE_CHOICES),
  light: paletteSchemeSchema,
  dark: paletteSchemeSchema,
  /** The base's own colours, which the editor derives from. */
  origin: z.strictObject({ light: paletteSchemeSchema, dark: paletteSchemeSchema }),
  /** Roles the player set by hand, which key colour changes leave alone. */
  handSet: z.strictObject({ light: handSetRoles, dark: handSetRoles }),
});
export type CustomPaletteInput = z.infer<typeof customPaletteInputSchema>;

/**
 * A replacement names the save it changes (its `updatedAt`), so a tab whose
 * copy is behind another's is refused rather than overwriting it.
 */
export const customPaletteReplaceSchema = customPaletteInputSchema.extend({
  updatedAt: z.number().int(),
});

export const customPaletteSchema = customPaletteInputSchema.extend({
  slot: customSlotSchema,
  updatedAt: z.number().int(),
});
export type CustomPalette = z.infer<typeof customPaletteSchema>;

/** The custom property a role sets, as the built-in palettes in styles.css declare it. */
export const paletteProperty = (role: PaletteRole) =>
  BASE_ROLES.has(role) ? `--${role}-base` : `--${role}`;

/** The red, green and blue channels of `#rrggbb`, 0 to 255. */
const hexChannels = (hex: string) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

/** `#rrggbb` as the space-separated channels of `rgb()`. */
const channels = (hex: string) => hexChannels(hex).join(" ");

/**
 * The stylesheet of the player's palettes, one rule each, in the built-ins'
 * shape (apps/web/src/styles.css): every role as a `light-dark()` pair, the
 * scrim and overlay shadow from the light `ink`. Each palette is parsed
 * first, so only validated hex colours reach the CSS. The server's
 * `/api/palettes.css` and the browser's constructed sheet both use it.
 */
export function customPaletteCss(palettes: readonly CustomPalette[]): string {
  return palettes
    .map((input) => {
      const { slot, light, dark } = customPaletteSchema.parse(input);
      const ink = channels(light.ink);
      const lines = [
        ...PALETTE_ROLES.map(
          (role) => `  ${paletteProperty(role)}: light-dark(${light[role]}, ${dark[role]});`,
        ),
        `  --scrim: light-dark(rgb(${ink} / 0.3), rgb(0 0 0 / 0.55));`,
        `  --shadow-overlay: light-dark(rgb(${ink} / 0.14), rgb(0 0 0 / 0.5));`,
      ];
      return `[data-palette="${customPaletteId(slot)}"] {\n${lines.join("\n")}\n}\n`;
    })
    .join("\n");
}

/**
 * The ground a role is read on: another role, or (`wash`) the role's own 14%
 * highlight wash over that role, as styles.css `prose-turn` draws it.
 */
interface ContrastGround {
  role: PaletteRole;
  wash: boolean;
}

const on = (...roles: PaletteRole[]): ContrastGround[] =>
  roles.map((role) => ({ role, wash: false }));
const washed = (...roles: PaletteRole[]): ContrastGround[] =>
  roles.map((role) => ({ role, wash: true }));

/**
 * Each role's least contrast against the grounds it is read on. Every
 * built-in palette meets them in both schemes (e2e/design.spec.ts); the
 * palette editor warns when a custom one does not, and never refuses it.
 */
export const CONTRAST_FLOORS: readonly {
  role: PaletteRole;
  grounds: readonly ContrastGround[];
  floor: number;
}[] = [
  { role: "ink", grounds: on("canvas", "surface", "surface-hover", "surface-selected"), floor: 7 },
  { role: "narration", grounds: on("canvas", "surface"), floor: 6 },
  { role: "ink-action", grounds: on("canvas", "surface"), floor: 6 },
  { role: "ink-thought", grounds: on("canvas", "surface"), floor: 4.8 },
  { role: "ink-narration", grounds: on("canvas", "surface"), floor: 4.8 },
  {
    role: "reed",
    grounds: on("canvas", "surface", "surface-hover", "surface-selected"),
    floor: 4.5,
  },
  { role: "control-edge", grounds: on("canvas", "surface"), floor: 3 },
  { role: "dusk-line", grounds: on("canvas", "surface"), floor: 3 },
  { role: "on-dusk", grounds: on("dusk", "dusk-hover"), floor: 4.5 },
  {
    role: "ember",
    grounds: on("canvas", "surface", "surface-hover", "surface-selected", "error-surface"),
    floor: 4.5,
  },
  // Mist is the ink alone, with no wash (styles.css), so only the plain grounds apply.
  ...HIGHLIGHT_TONES.map((tone) => ({
    role: `tone-${tone}` as const,
    grounds:
      tone === "mist"
        ? on("canvas", "surface")
        : [...on("canvas", "surface"), ...washed("canvas", "surface")],
    floor: 4.5,
  })),
];

/** The wash's opacity over its ground (styles.css `prose-turn`). */
export const WASH_OPACITY = 0.14;

const rgb = (hex: string) => hexChannels(hex).map((channel) => channel / 255);

const luminance = ([r = 0, g = 0, b = 0]: number[]) => {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const ratio = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** WCAG contrast of two `#rrggbb` colours. */
export const contrastRatio = (a: string, b: string): number => ratio(rgb(a), rgb(b));

/** A role under its floor on its weakest ground, the ratio rounded down to hundredths. */
export interface ContrastShortfall {
  role: PaletteRole;
  ground: ContrastGround;
  ratio: number;
  floor: number;
}

/** The roles of one scheme that miss their floors, in CONTRAST_FLOORS order. */
export function contrastShortfalls(scheme: PaletteScheme): ContrastShortfall[] {
  return CONTRAST_FLOORS.flatMap(({ role, grounds, floor }) => {
    const ink = rgb(scheme[role]);
    const [weakest] = grounds
      .map((ground) => {
        const under = rgb(scheme[ground.role]);
        const back = ground.wash
          ? under.map((c, i) => (ink[i] ?? 0) * WASH_OPACITY + c * (1 - WASH_OPACITY))
          : under;
        return { ground, ratio: Math.floor(ratio(ink, back) * 100) / 100 };
      })
      .sort((a, b) => a.ratio - b.ratio);
    return weakest === undefined || weakest.ratio >= floor ? [] : [{ role, floor, ...weakest }];
  });
}
