import { z } from "zod";
import {
  type CharacterCard,
  characterCardSchema,
  type Lorebook,
  legacyStoredCharacterCardSchema,
} from "./card/schema.ts";
import { nativeEnvelope, nativeEnvelopeSchema } from "./file-format.ts";
import { retireLegacyPresetBlocks } from "./imports/prompt-upgrade.ts";
import { publicLorebookSchema } from "./lorebook/stored.ts";
import { type PromptPreset, promptPresetSchema } from "./preset/prompt.ts";
import { type SamplerPreset, samplerPresetSchema } from "./preset/sampler.ts";

/*
 * The size rule lives on each data schema (`fitsNativeFile`); a sampler
 * preset's bounded fields keep it far below the limit.
 */
export const characterFileSchema = nativeEnvelopeSchema("ephemera.character", characterCardSchema);
/** A character file written before the five removed fields were folded; import folds it and re-checks the public bounds. */
export const legacyCharacterFileSchema = z.strictObject({
  format: z.literal("ephemera.character"),
  version: z.literal(1),
  data: legacyStoredCharacterCardSchema,
});
export const lorebookFileSchema = nativeEnvelopeSchema("ephemera.lorebook", publicLorebookSchema);
export const promptPresetFileSchema = nativeEnvelopeSchema(
  "ephemera.prompt-preset",
  promptPresetSchema,
);
/**
 * A prompt preset file written before the personality and scenario blocks
 * and the override locks were retired: its data is retired, then held to the
 * public bounds.
 */
export const legacyPromptPresetFileSchema = z.strictObject({
  format: z.literal("ephemera.prompt-preset"),
  version: z.literal(1),
  data: z.unknown().transform(retireLegacyPresetBlocks).pipe(promptPresetSchema),
});
export const samplerPresetFileSchema = nativeEnvelopeSchema(
  "ephemera.sampler-preset",
  samplerPresetSchema,
);

/** Validate at export too: an oversized legacy row must be reduced first. */
export const toCharacterFile = (data: CharacterCard) =>
  characterFileSchema.parse(nativeEnvelope("ephemera.character", data));
export const toLorebookFile = (data: Lorebook) =>
  lorebookFileSchema.parse(nativeEnvelope("ephemera.lorebook", data));
export const toPromptPresetFile = (data: PromptPreset) =>
  promptPresetFileSchema.parse(nativeEnvelope("ephemera.prompt-preset", data));
export const toSamplerPresetFile = (data: SamplerPreset) =>
  samplerPresetFileSchema.parse(nativeEnvelope("ephemera.sampler-preset", data));
export const serializeCharacter = (data: CharacterCard): string =>
  JSON.stringify(toCharacterFile(data));
export const serializeLorebook = (data: Lorebook): string => JSON.stringify(toLorebookFile(data));
