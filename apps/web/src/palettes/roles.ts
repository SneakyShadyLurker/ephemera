import type { KEY_ROLES, Palette, PaletteRole } from "@ephemera/core";

/*
 * How the palette editor names core's PALETTE_ROLES and groups them: the
 * key colours always shown, the rest under All colours, each with the key
 * colour it follows until the player sets it by hand (derive.ts).
 */

export type KeyRole = (typeof KEY_ROLES)[number];

/** The built-in palettes' names on screen. */
export const BUILT_IN_NAMES = {
  lamplight: "Lamplight",
  catppuccin: "Catppuccin",
  "rose-pine": "Rosé Pine",
  nord: "Nord",
  gruvbox: "Gruvbox",
  "tokyo-night": "Tokyo Night",
} as const satisfies Record<Palette, string>;

export const ROLE_LABELS = {
  canvas: "Background",
  surface: "Panels",
  "surface-hover": "Hover",
  "surface-pressed": "Pressed",
  "surface-selected": "Selected",
  rush: "Borders",
  ink: "Text",
  narration: "Secondary text",
  "ink-action": "Actions",
  "ink-thought": "Thoughts",
  "ink-narration": "Narration",
  reed: "Muted text",
  "control-edge": "Control outlines",
  "text-disabled": "Disabled text",
  dusk: "Accent",
  "dusk-hover": "Accent hover",
  "dusk-line": "Focus line",
  "on-dusk": "Text on accent",
  ember: "Error",
  "error-surface": "Error background",
  "tone-rose": "Highlight 1",
  "tone-sage": "Highlight 2",
  "tone-iris": "Highlight 3",
  "tone-mist": "Quiet passages",
} as const satisfies Record<PaletteRole, string>;

/** The key colour each other role follows, for the "Follows …" note. */
export const FOLLOWS = {
  "surface-hover": "surface",
  "surface-pressed": "surface",
  "surface-selected": "surface",
  rush: "canvas",
  narration: "ink",
  "ink-action": "ink",
  "ink-thought": "ink",
  "ink-narration": "ink",
  reed: "ink",
  "control-edge": "ink",
  "text-disabled": "ink",
  "dusk-hover": "dusk",
  "dusk-line": "dusk",
  "on-dusk": "dusk",
  ember: "canvas",
  "error-surface": "canvas",
  "tone-mist": "canvas",
} as const satisfies Record<Exclude<PaletteRole, KeyRole>, KeyRole>;

export type FollowingRole = keyof typeof FOLLOWS;

export const isFollowing = (role: PaletteRole): role is FollowingRole => role in FOLLOWS;

/** The key colours, grouped as the editor shows them. */
export const KEY_GROUPS: readonly { title: string; roles: readonly KeyRole[]; note: string }[] = [
  {
    title: "Room",
    roles: ["canvas", "surface"],
    note: "The page and the panels on it; hover, borders and outlines follow.",
  },
  { title: "Text", roles: ["ink"], note: "Interface text and speech; the story's voices follow." },
  { title: "Accent", roles: ["dusk"], note: "Buttons, the lamp and focus." },
  {
    title: "Highlights",
    roles: ["tone-rose", "tone-sage", "tone-iris"],
    note: "Highlighted words, with a faint wash of the same colour behind them.",
  },
];

/** Every other role, grouped under All colours. */
export const MORE_GROUPS: readonly { title: string; roles: readonly FollowingRole[] }[] = [
  { title: "Room", roles: ["surface-hover", "surface-pressed", "surface-selected", "rush"] },
  { title: "Interface text", roles: ["reed", "narration", "text-disabled"] },
  { title: "Story voices", roles: ["ink-action", "ink-thought", "ink-narration"] },
  { title: "Accent and controls", roles: ["dusk-hover", "dusk-line", "on-dusk", "control-edge"] },
  { title: "Signals", roles: ["ember", "error-surface"] },
  { title: "Highlights", roles: ["tone-mist"] },
];
