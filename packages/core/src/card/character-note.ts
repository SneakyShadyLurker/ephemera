import { z } from "zod";
import { PRESET_LIMITS, promptRoleSchema } from "../preset/prompt.ts";

/** Native note text and request-local depth placement. Whole-card writes bound its bytes. */

export const characterNoteSchema = z.strictObject({
  prompt: z.string(),
  /** Messages from the end of the chat, as for the Author's Note. */
  depth: z.number().int().min(0).max(PRESET_LIMITS.maxDepth),
  role: promptRoleSchema,
});
export type CharacterNote = z.infer<typeof characterNoteSchema>;

/** A new note, and what an import falls back to: empty, at the default depth, as a system message. */
export const DEFAULT_CHARACTER_NOTE: CharacterNote = {
  prompt: "",
  depth: PRESET_LIMITS.defaultDepth,
  role: "system",
};
