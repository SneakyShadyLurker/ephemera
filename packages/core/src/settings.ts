import { z } from "zod";
import { modelIdSchema } from "./chat.ts";
import { MEMORY_LIMITS } from "./memory/limits.ts";
import { contextLimitsSchema, contextWindowsSchema, perModel } from "./models.ts";
import { DEFAULT_PALETTE, PALETTE_CHOICES } from "./palettes.ts";
import { REASONING_EFFORTS } from "./preset/sampler.ts";
import { PROMPT_PROCESSING } from "./prompt/postprocess.ts";

/*
 * UI settings: what the app comes back to after a reload. Not chat content
 * (PRINCIPLES.md 1): they persist on the server, never in the browser.
 */

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * A built-in ComfyUI workflow for card portraits, by its file name: the
 * server finds the graphs and says which exist (`ComfyuiWorkflowOption`).
 */
export const comfyuiWorkflowIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** One workflow the owner can choose, with its name on screen. */
export const comfyuiWorkflowOptionSchema = z.strictObject({
  id: comfyuiWorkflowIdSchema,
  name: z.string().min(1).max(128),
});
export type ComfyuiWorkflowOption = z.infer<typeof comfyuiWorkflowOptionSchema>;

const MAX_COMFYUI_URL_LENGTH = 2048;

/**
 * The owner's ComfyUI, or empty for none. Only http and https; no
 * credentials, query or fragment, since the client appends its own paths
 * and the token lives in the server environment (PRINCIPLES.md 2).
 */
const comfyuiBaseUrl = z.union([
  z.literal(""),
  z
    .url({ protocol: /^https?$/ })
    .max(MAX_COMFYUI_URL_LENGTH)
    .refine((value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    }, "must be a plain http or https address"),
]);

const reference = z.uuid().nullable();

/** A whole number within one of the memory limits' ranges. */
const ranged = ({ min, max }: { min: number; max: number }) => z.number().int().min(min).max(max);

/** Post-processing set for models whose chat template needs it; a model not listed gets none. */
const promptProcessingSchema = perModel(
  z.enum(PROMPT_PROCESSING).exclude(["none"]),
  "post-processing settings",
);
export type PromptProcessingSettings = z.infer<typeof promptProcessingSchema>;

export const settingsSchema = z.strictObject({
  theme: z.enum(THEMES),
  /** A built-in palette or a saved custom one; the server refuses an empty slot. */
  palette: z.enum(PALETTE_CHOICES),
  /** The model replies use. */
  model: modelIdSchema.nullable(),
  /**
   * The model that starts writing image prompts; null uses each surface's own
   * default. A session's Prompt model still overrides it.
   */
  imagePromptModel: modelIdSchema.nullable(),
  /** The character chosen last. */
  characterId: reference,
  /** The persona chosen last. */
  personaId: reference,
  /** The persona new chats start as, unless the character goes with another. */
  defaultPersonaId: reference,
  promptPresetId: reference,
  samplerPresetId: reference,
  /** Windows the owner set for models the provider reports none for. */
  contextWindows: contextWindowsSchema,
  /**
   * The most of each model's window a prompt may use; a model not listed uses
   * `DEFAULT_CONTEXT_LIMIT`. A Settings value, never a preset value: an
   * imported preset's `openai_max_context` stays ignored.
   */
  contextLimits: contextLimitsSchema,
  promptProcessing: promptProcessingSchema,
  /** Reasoning shows open instead of collapsed. */
  reasoningOpen: z.boolean(),
  /** Thinking time for models that keep their reasoning hidden. */
  showHiddenReasoning: z.boolean(),
  /**
   * A card's own System Prompt replaces the preset's Main Prompt
   * when preferred; otherwise the preset's text is used.
   */
  preferCharacterPrompt: z.boolean(),
  /**
   * A card's own Post-History Instructions replace the preset's
   * when preferred; otherwise the preset's instructions are used.
   */
  preferCharacterInstructions: z.boolean(),
  /** Where card portraits are painted; empty leaves AI cards without art. */
  comfyuiBaseUrl,
  /** Chosen in Create with AI; the server refuses an id it has no graph for. */
  comfyuiWorkflow: comfyuiWorkflowIdSchema,
  /**
   * A new chat with a character opens on the memory's opening, the card's
   * greetings following as swipes; off, the card's greeting opens it.
   */
  memoryOpening: z.boolean(),
  /** The model memory calls use; null uses the reply's. */
  memoryModel: modelIdSchema.nullable(),
  /** The memory call's reasoning effort; null leaves it to the model. */
  memoryReasoning: z.enum(REASONING_EFFORTS).nullable(),
  /** Estimated tokens of unremembered turns that start a memory call. */
  memorySpanTokens: ranged(MEMORY_LIMITS.spanTokens),
  /** Newest turns a memory call leaves live. */
  memoryKeepTurns: ranged(MEMORY_LIMITS.keepTurns),
  /**
   * The most estimated tokens of a chat's episodes before the oldest merge
   * into a chapter; null leaves it to the window (`recapBudget`).
   */
  memoryRecapTokens: ranged(MEMORY_LIMITS.recapTokens).nullable(),
  /** The model the cast keeper and the cast sheet use; null uses memory's (`castModelOf`). */
  castModel: modelIdSchema.nullable(),
  /** The cast calls' reasoning effort; null uses memory's (`castReasoningOf`). */
  castReasoning: z.enum(REASONING_EFFORTS).nullable(),
});
export type Settings = z.infer<typeof settingsSchema>;

/** What a new installation starts with, and what a tab uses until the server answers. */
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  palette: DEFAULT_PALETTE,
  model: null,
  imagePromptModel: null,
  characterId: null,
  personaId: null,
  defaultPersonaId: null,
  promptPresetId: null,
  samplerPresetId: null,
  contextWindows: {},
  contextLimits: {},
  promptProcessing: {},
  reasoningOpen: false,
  showHiddenReasoning: false,
  preferCharacterPrompt: true,
  preferCharacterInstructions: true,
  comfyuiBaseUrl: "",
  comfyuiWorkflow: "krea2-gonzalomo",
  memoryOpening: true,
  memoryModel: null,
  memoryReasoning: null,
  memorySpanTokens: MEMORY_LIMITS.spanTokens.default,
  memoryKeepTurns: MEMORY_LIMITS.keepTurns.default,
  memoryRecapTokens: null,
  castModel: null,
  castReasoning: null,
};

/**
 * The model that writes an image prompt: the session's own choice, else
 * Settings' image prompt model, else the surface's default (the card's, the
 * saved chat model, the chat's); null without any.
 */
export const imagePromptModelOf = (
  chosen: string | null,
  setting: Settings["imagePromptModel"],
  fallback: string | null,
): string | null => chosen ?? setting ?? fallback;

/** The model memory calls go to: the memory model, else the reply's; null without either. */
export const memoryModelOf = (settings: Pick<Settings, "memoryModel" | "model">): string | null =>
  settings.memoryModel ?? settings.model;

/**
 * The model cast calls go to: the cast model, else memory's, else the reply's;
 * background bookkeeping like memory, so it does not fall back to the reply's first.
 */
export const castModelOf = (
  settings: Pick<Settings, "castModel" | "memoryModel" | "model">,
): string | null => settings.castModel ?? memoryModelOf(settings);

/** The cast calls' reasoning effort, following the same chain as `castModelOf` up to memory's. */
export const castReasoningOf = (
  settings: Pick<Settings, "castReasoning" | "memoryReasoning">,
): Settings["castReasoning"] => settings.castReasoning ?? settings.memoryReasoning;

export const settingsPatchSchema = settingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
