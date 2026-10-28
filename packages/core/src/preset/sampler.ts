import { z } from "zod";
import { modelIdSchema } from "../chat.ts";
import { storedFields, withRevision } from "../revision.ts";
import { presetNameSchema } from "./prompt.ts";

/*
 * A sampler preset: how replies are drawn. Every value may be null, meaning
 * the model's own default: nothing is sent for it. The context window is the
 * model's own (models.ts), not a preset value.
 */

/** Bounds, control steps and the value Set starts from. One owner for schema and controls. */
export const SAMPLER_RANGES = {
  maxOutputTokens: { min: 1, max: 200_000, step: 64, start: 1_024 },
  temperature: { min: 0, max: 2, step: 0.05, start: 1 },
  topP: { min: 0, max: 1, step: 0.01, start: 1 },
  frequencyPenalty: { min: -2, max: 2, step: 0.05, start: 0 },
  presencePenalty: { min: -2, max: 2, step: 0.05, start: 0 },
  seed: { min: 0, max: 2_147_483_647, step: 1, start: 0 },
} as const;

/**
 * Every effort a preset can choose: the AI SDK's `reasoning` levels, which the
 * server checks against the SDK's own type (upstream.ts); "provider-default"
 * sends nothing. CLIProxyAPI's catalog also lists `ultra`, which its chat
 * endpoint refuses, so it is not one.
 */
export const REASONING_EFFORTS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const ranged = (key: keyof typeof SAMPLER_RANGES, integer = false) => {
  const { min, max } = SAMPLER_RANGES[key];
  return (integer ? z.number().int() : z.number()).min(min).max(max);
};

const samplerValuesSchema = z.strictObject({
  /** Null: the chat's model. */
  model: modelIdSchema.nullable(),
  maxOutputTokens: ranged("maxOutputTokens", true).nullable(),
  temperature: ranged("temperature").nullable(),
  topP: ranged("topP").nullable(),
  frequencyPenalty: ranged("frequencyPenalty").nullable(),
  presencePenalty: ranged("presencePenalty").nullable(),
  /** Null: random each reply. */
  seed: ranged("seed", true).nullable(),
  reasoning: z.enum(REASONING_EFFORTS),
});
export type SamplerValues = z.infer<typeof samplerValuesSchema>;

export const samplerPresetSchema = z.strictObject({
  name: presetNameSchema,
  values: samplerValuesSchema,
});
export type SamplerPreset = z.infer<typeof samplerPresetSchema>;

/** A PATCH body: the sheet's edit and the revision it was made against. */
export const samplerPresetPatchRequestSchema = withRevision(samplerPresetSchema.partial());

/** Overrides nothing: replies are drawn exactly as without a preset. */
export function defaultSamplerPreset(name = "Model defaults"): SamplerPreset {
  return {
    name,
    values: {
      model: null,
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      reasoning: "provider-default",
    },
  };
}

/** One sampler preset as the API returns it. */
export const storedSamplerPresetSchema = z.strictObject({
  id: z.string(),
  ...samplerPresetSchema.shape,
  ...storedFields,
});
export type StoredSamplerPreset = z.infer<typeof storedSamplerPresetSchema>;
