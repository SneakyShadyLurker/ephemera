import { z } from "zod";

/*
 * The one owner of Settings' categories: their ids (the `section` search on
 * /settings), names and the one-line purposes the phone's list shows. The
 * route, the index, the phone list and the tests all read these.
 */

export const SECTIONS = ["appearance", "chat", "setup", "memory", "pictures", "kept"] as const;

export type Section = (typeof SECTIONS)[number];

export const sectionSchema = z.enum(SECTIONS);

/** Where Settings opens on tablet and desktop when no category is asked for. */
export const DEFAULT_SECTION: Section = "appearance";

/** Where a `window` link lands: Context, inside Model setup. */
export const WINDOW_SECTION: Section = "setup";

export const SECTION_TEXT = {
  appearance: { label: "Appearance", purpose: "Theme and colours." },
  chat: { label: "Chat", purpose: "Who you are, which model replies, and how replies are shown." },
  setup: { label: "Model setup", purpose: "Context limits and prompt format, model by model." },
  memory: { label: "Memory & cast", purpose: "What characters remember, and who is in the scene." },
  pictures: {
    label: "Pictures",
    purpose: "The model that writes image prompts, and the ComfyUI that paints them.",
  },
  kept: { label: "What is kept", purpose: "What is saved, and what ends with the chat." },
} as const satisfies Record<Section, { label: string; purpose: string }>;

/**
 * The category Settings shows: Model setup while a `window` link is being
 * followed, else the one asked for; with neither, Appearance from tablet up
 * and the phone's list (null) on phones.
 */
export function shownSection(
  search: { section?: Section | undefined; window?: string | undefined },
  phone: boolean,
): Section | null {
  if (search.window !== undefined) return WINDOW_SECTION;
  return search.section ?? (phone ? null : DEFAULT_SECTION);
}
