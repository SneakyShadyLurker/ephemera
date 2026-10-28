import { z } from "zod";
import { fitsNativeFile, hasIssue } from "../file-format.ts";
import { entrySettingsSchema } from "../lorebook/settings.ts";
import { storedFields, withRevision } from "../revision.ts";
import { characterNoteSchema } from "./character-note.ts";
import { CARD_LIMITS as L } from "./limits.ts";
import { tagsSchema } from "./tags.ts";

/** Native character and lorebook contracts. Stored reads omit public file-size refinements so legacy rows remain reducible. */

const text = z.string().max(L.textLength);
const shortText = z.string().max(L.shortTextLength);

const lorebookEntrySchema = z.strictObject({
  keys: z.array(shortText).max(L.tags),
  content: text,
  settings: entrySettingsSchema.exactOptional(),
  enabled: z.boolean(),
  insertionOrder: z.number(),
  useRegex: z.boolean(),
  constant: z.boolean().optional(),
  name: shortText.optional(),
  id: z.union([z.number(), shortText]).optional(),
  comment: text.optional(),
  selective: z.boolean().optional(),
  secondaryKeys: z.array(shortText).max(L.tags).optional(),
});
export type LorebookEntry = z.infer<typeof lorebookEntrySchema>;

export const lorebookSchema = z.strictObject({
  name: shortText.optional(),
  description: text.optional(),
  scanDepth: z.number().optional(),
  tokenBudget: z.number().optional(),
  recursiveScanning: z.boolean().optional(),
  entries: z.array(lorebookEntrySchema).max(L.lorebookEntries),
});
export type Lorebook = z.infer<typeof lorebookSchema>;

/** Alias conversion can widen saved content and keywords; public books retain their bounds. */
export const storedLorebookDataSchema = lorebookSchema.extend({
  entries: z
    .array(
      lorebookEntrySchema.extend({
        content: z.string(),
        keys: z.array(z.string()).max(L.tags),
        secondaryKeys: z.array(z.string()).max(L.tags).optional(),
      }),
    )
    .max(L.lorebookEntries),
});

/** Fields the character sheet edits; everything else is kept as imported. */
export const editableFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(L.nameLength),
  nickname: shortText,
  description: text,
  personality: text,
  scenario: text,
  firstMessage: text,
  alternateGreetings: z.array(text).max(L.alternateGreetings),
  exampleDialogue: text,
  systemPrompt: text,
  postHistoryInstructions: text,
  creatorNotes: text,
  tags: tagsSchema,
  creator: shortText,
  characterVersion: shortText,
});
export type EditableFields = z.infer<typeof editableFieldsSchema>;

const publicCharacterCardSchema = z.strictObject({
  ...editableFieldsSchema.shape,
  characterNote: characterNoteSchema.exactOptional(),
  lorebook: lorebookSchema.optional(),
});
/** Stored text may exceed write bounds after legacy aliases expand, without losing any text. */
export const storedCharacterCardSchema = publicCharacterCardSchema.extend({
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  firstMessage: z.string(),
  alternateGreetings: z.array(z.string()).max(L.alternateGreetings),
  exampleDialogue: z.string(),
  systemPrompt: z.string(),
  postHistoryInstructions: z.string(),
  lorebook: storedLorebookDataSchema.optional(),
});

/** Imports and writes enforce exportability; legacy rows remain readable so they can be reduced. */
export const characterCardSchema = publicCharacterCardSchema.refine(
  (card) => fitsNativeFile("ephemera.character", card),
  {
    message: "The card is past the size limit",
    params: { code: "card_too_large" },
  },
);
/** Whether a parse failed because the whole card is past the limit, not because a field is invalid. */
export const isCardTooLarge = (error: z.ZodError): boolean => hasIssue(error, "card_too_large");
export type CharacterCard = z.infer<typeof characterCardSchema>;

/**
 * What the character sheet edits: the card's editable fields and the
 * Character's Note (character-note.ts), stored directly on the card.
 */
export const sheetFieldsSchema = z.strictObject({
  ...editableFieldsSchema.shape,
  characterNote: characterNoteSchema.nullable().optional(),
});
export type SheetFields = z.infer<typeof sheetFieldsSchema>;

/** What the app calls each field the sheet edits, in the sheet and in a rework's review. */
export const CARD_FIELD_LABELS: Readonly<Record<keyof SheetFields, string>> = {
  name: "Name",
  nickname: "Nickname",
  description: "Description",
  personality: "Personality",
  scenario: "Scenario",
  firstMessage: "First message",
  alternateGreetings: "Alternates",
  exampleDialogue: "Examples",
  systemPrompt: "System prompt",
  postHistoryInstructions: "Post-history instructions",
  creatorNotes: "Creator notes",
  tags: "Tags",
  creator: "Creator",
  characterVersion: "Version",
  characterNote: "Character's Note",
};

/** A partial edit from the sheet: known fields only, nothing else. */
export const characterPatchSchema = sheetFieldsSchema
  .extend({
    /** The whole embedded lorebook, as the lorebook screen edits it; null removes it. */
    lorebook: lorebookSchema.nullable(),
  })
  .partial();
export type CharacterPatch = z.infer<typeof characterPatchSchema>;

/** A PATCH body: the sheet's edit and the revision it was made against. */
export const characterPatchRequestSchema = withRevision(characterPatchSchema);

/** A card with every editable field empty but the name, for "New character". */
export function blankCard(name: string): CharacterCard {
  return {
    name,
    nickname: "",
    description: "",
    personality: "",
    scenario: "",
    firstMessage: "",
    alternateGreetings: [],
    exampleDialogue: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    creatorNotes: "",
    tags: [],
    creator: "",
    characterVersion: "",
  };
}

/** What the gallery lists: enough to search, filter, order and show a portrait. */
export const characterSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  nickname: z.string(),
  creator: z.string(),
  tags: z.array(z.string()),
  /** Portrait version for its URL; null without a portrait. */
  portrait: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type CharacterSummary = z.infer<typeof characterSummarySchema>;

/** One character as the API returns it for the sheet. */
export const storedCharacterSchema = z.strictObject({
  id: z.string(),
  card: storedCharacterCardSchema,
  /** Portrait version, or null without a portrait. */
  portrait: z.number().int().nullable(),
  ...storedFields,
});
export type StoredCharacter = z.infer<typeof storedCharacterSchema>;
