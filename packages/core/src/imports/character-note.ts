import { DEFAULT_CHARACTER_NOTE } from "../card/character-note.ts";
import { PRESET_LIMITS, type PromptRole, promptRoleSchema } from "../preset/prompt.ts";

/** Lenient import/upgrade coercion for a foreign depth prompt. */
export function importedNoteDepth(value: unknown): number {
  const number =
    typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  return Number.isInteger(number) && number >= 0 && number <= PRESET_LIMITS.maxDepth
    ? number
    : DEFAULT_CHARACTER_NOTE.depth;
}

export const importedNoteRole = (value: unknown): PromptRole => {
  const parsed = promptRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_CHARACTER_NOTE.role;
};
