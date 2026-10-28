import { z } from "zod";
import { clipText, CARD_LIMITS as L } from "./card/limits.ts";
import { storedFields, withRevision } from "./revision.ts";

/*
 * A persona: who the user is in the story. Its text is untrusted like card
 * fields (PRINCIPLES.md 3) and bounded by the same limits.
 */

export const personaFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(L.nameLength),
  description: z.string().max(L.textLength),
});
export type PersonaFields = z.infer<typeof personaFieldsSchema>;

/** A partial edit from the persona sheet. */
export const personaPatchSchema = personaFieldsSchema.partial();
export type PersonaPatch = z.infer<typeof personaPatchSchema>;

/** A PATCH body: the sheet's edit and the revision it was made against. */
export const personaPatchRequestSchema = withRevision(personaPatchSchema);

/** What the gallery and Session list. */
export const personaSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** Portrait version for its URL; null without a portrait. */
  portrait: z.number().int().nullable(),
  /** The characters this persona goes with. */
  characterIds: z.array(z.string()),
  updatedAt: z.number().int(),
});
export type PersonaSummary = z.infer<typeof personaSummarySchema>;

/** One persona as the API returns it for the sheet. */
export const storedPersonaSchema = z.strictObject({
  ...personaSummarySchema.shape,
  description: z.string(),
  ...storedFields,
});
export type StoredPersona = z.infer<typeof storedPersonaSchema>;

/**
 * The persona a new chat with a character starts as: the one the character
 * goes with, else the default persona, else the one already in use.
 */
export function resolvePersona(choice: {
  bound: string | null;
  defaultPersona: string | null;
  current: string | null;
}): string | null {
  return choice.bound ?? choice.defaultPersona ?? choice.current;
}

/** The name of a duplicate, kept within the name limit. */
export function copyName(name: string): string {
  const suffix = " (copy)";
  return clipText(name, L.nameLength - suffix.length) + suffix;
}
