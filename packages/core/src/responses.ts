import { z } from "zod";
import { characterCardSchema, characterSummarySchema } from "./card/schema.ts";
import { storedEventSchema } from "./events/event.ts";
import { lorebookLinksSchema, lorebookSummarySchema } from "./lorebook/stored.ts";
import { memoryStateSchema, storedEpisodeSchema } from "./memory/memory.ts";
import { modelInfoSchema } from "./models.ts";
import { customPaletteSchema } from "./palettes.ts";
import { personaSummarySchema } from "./persona.ts";
import { storedPromptPresetSchema } from "./preset/prompt.ts";
import { storedSamplerPresetSchema } from "./preset/sampler.ts";
import { importReportSchema } from "./preset/sillytavern.ts";
import { inspectedPromptSchema } from "./prompt/inspect.ts";
import { revisionSchema } from "./revision.ts";
import { settingsSchema } from "./settings.ts";

/*
 * The JSON bodies the server answers and the web app reads, each defined
 * once: the server builds its body against the schema, the web app parses
 * the body with it, so a renamed field fails the typecheck on both sides.
 */

/**
 * A card, World Info or lorebook file imported: the new character or book
 * and what the import did (for a card, the lorebook features it keeps but
 * does not act on, and what was fitted to the limits).
 */
export const importResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  report: importReportSchema,
});
export type ImportResponse = z.infer<typeof importResponseSchema>;

/** A native preset imported: its one kind, the new preset and what the import did. */
const nativePresetImport = <F extends "prompt" | "sampler">(format: F) =>
  z.object({
    format: z.literal(format),
    id: z.uuid(),
    name: z.string(),
    report: importReportSchema,
  });

/** Native imports create one kind; a foreign preset creates both kinds atomically. */
export const presetImportResponseSchema = z.discriminatedUnion("format", [
  nativePresetImport("prompt"),
  nativePresetImport("sampler"),
  z.object({
    format: z.literal("foreign"),
    promptId: z.uuid(),
    samplerId: z.uuid(),
    name: z.string(),
    report: importReportSchema,
  }),
]);

/** A portrait uploaded: its new version, which portrait addresses carry. */
export const portraitResponseSchema = z.object({ portrait: z.number().int().nonnegative() });

/** A copy made (a duplicate): the new entity's id. */
export const createdResponseSchema = z.object({ id: z.uuid() });

/** Every character, as the gallery lists them. */
export const charactersResponseSchema = z.object({ characters: z.array(characterSummarySchema) });

/** A character's saved edit: the whole card and its new revision. */
export const savedCharacterResponseSchema = z.object({
  card: characterCardSchema,
  revision: revisionSchema,
});

/** Every persona, as the gallery lists them. */
export const personasResponseSchema = z.object({ personas: z.array(personaSummarySchema) });

/** Every prompt preset, and one. */
export const promptPresetsResponseSchema = z.object({ presets: z.array(storedPromptPresetSchema) });
export const promptPresetResponseSchema = z.object({ preset: storedPromptPresetSchema });

/** Every sampler preset, and one. */
export const samplerPresetsResponseSchema = z.object({
  presets: z.array(storedSamplerPresetSchema),
});
export const samplerPresetResponseSchema = z.object({ preset: storedSamplerPresetSchema });

/** The models CLIProxyAPI offers. */
export const modelsResponseSchema = z.object({ models: z.array(modelInfoSchema) });

/** A book in a character's card, as the library lists it: the character's name and its entry count. */
const embeddedLorebookSchema = z.object({
  characterId: z.string(),
  name: z.string(),
  entries: z.number().int().nonnegative(),
});
export type EmbeddedLorebook = z.infer<typeof embeddedLorebookSchema>;

/** The lorebook library: its books, the books in cards, and which characters each library book is linked to. */
export const libraryResponseSchema = z.object({
  lorebooks: z.array(lorebookSummarySchema),
  embedded: z.array(embeddedLorebookSchema),
  links: lorebookLinksSchema,
});
export type Library = z.infer<typeof libraryResponseSchema>;

/** Every event definition. */
export const eventsResponseSchema = z.object({ events: z.array(storedEventSchema) });

/** The requester's settings, as read and after a change. */
export const settingsResponseSchema = z.object({ settings: settingsSchema });

/** Every custom palette. */
export const palettesResponseSchema = z.object({ palettes: z.array(customPaletteSchema) });

/** One custom palette as saved. */
export const paletteResponseSchema = z.object({ palette: customPaletteSchema });

/** A chat preview: the prompt a send would make, for the inspector. */
export const previewResponseSchema = z.object({ prompt: inspectedPromptSchema });

/** A character's memory: its notebook row (null while it has none) and its episodes, oldest first. */
export const characterMemorySchema = z.object({
  state: memoryStateSchema.nullable(),
  episodes: z.array(storedEpisodeSchema),
});
export type CharacterMemory = z.infer<typeof characterMemorySchema>;
