import { z } from "zod";
import { CARD_LIMITS } from "../card/limits.ts";
import { fitsNativeFile, hasIssue } from "../file-format.ts";
import { storedFields, withRevision } from "../revision.ts";
import {
  DEFAULT_FORMAT_PROMPT,
  DEFAULT_MAIN_PROMPT,
  DEFAULT_NOTE_PROMPT,
  DEFAULT_NPC_PROMPT,
  DEFAULT_PERSONA_FORMAT,
  DEFAULT_WORLD_PROMPT,
  SOURCE_PLACEHOLDER,
} from "./defaults.ts";

/** Native ordered prompt blocks. All text is untrusted data; assembly owns source expansion and placement. */

export const PRESET_LIMITS = {
  nameLength: CARD_LIMITS.nameLength,
  blockText: CARD_LIMITS.textLength,
  customBlocks: 128,
  /** Messages from the end of the chat history. */
  maxDepth: 1_000,
  /** Initial depth for an in-chat block. */
  defaultDepth: 4,
  /** Default ordering for in-chat blocks and notes. */
  defaultOrder: 100,
  /** The widest `injection_order` kept from an imported preset. */
  maxOrder: 1_000_000,
  /** The longest reasoning tag name. */
  reasoningTagLength: 32,
} as const;

/** Built-in blocks with their own text. */
const TEXT_BLOCKS = ["main", "postHistory"] as const;
/** Built-in blocks whose text comes from the character, persona or lorebook. */
export const SOURCE_BLOCKS = [
  "lorebookBefore",
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "castAnchors",
  "lorebookAfter",
  "dialogueExamples",
] as const;
/** Optional built-ins are placed by assembly when absent from older saved presets. */
export const OPTIONAL_BLOCKS: ReadonlySet<BuiltInBlock> = new Set(["castAnchors"]);

export const presetNameSchema = z.string().trim().min(1).max(PRESET_LIMITS.nameLength);
export const promptRoleSchema = z.enum(["system", "user", "assistant"]);
export type PromptRole = z.infer<typeof promptRoleSchema>;
export const GENERATION_TYPES = [
  "normal",
  "regenerate",
  "swipe",
  "continue",
  "impersonate",
  "quiet",
] as const;
export const generationTypeSchema = z.enum(GENERATION_TYPES);
export type GenerationType = z.infer<typeof generationTypeSchema>;

const blockText = z.string().max(PRESET_LIMITS.blockText);
const orderSchema = z.number().int().min(-PRESET_LIMITS.maxOrder).max(PRESET_LIMITS.maxOrder);
const placement = {
  role: promptRoleSchema.exactOptional(),
  depth: z.number().int().min(0).max(PRESET_LIMITS.maxDepth).nullable().exactOptional(),
  order: orderSchema.exactOptional(),
  forbidOverrides: z.boolean().exactOptional(),
  triggers: z.array(generationTypeSchema).max(GENERATION_TYPES.length).exactOptional(),
};

/** Optional source templates insert already-expanded data (`SOURCE_PLACEHOLDER`) without evaluating it again. */
const validSourceTemplate = (value: string) => value === "" || value.includes(SOURCE_PLACEHOLDER);
const storedSourceTemplateSchema = z
  .string()
  .refine(validSourceTemplate, `A nonempty template must contain ${SOURCE_PLACEHOLDER}`);
export const sourceTemplateSchema = blockText.refine(
  validSourceTemplate,
  `A nonempty template must contain ${SOURCE_PLACEHOLDER}`,
);
export const promptActionsSchema = z.strictObject({
  continue: blockText,
  writeForMe: blockText,
});
export type PromptActions = z.infer<typeof promptActionsSchema>;
export const DEFAULT_PROMPT_ACTIONS: PromptActions = {
  continue:
    "[Your last message was cut off. Continue it from the exact word where it stops, without repeating or restating anything already written.]",
  writeForMe:
    "[Write {{user}}'s next message in this roleplay, in {{user}}'s voice and style as the chat so far shows it. Write only {{user}}'s words and actions, never {{char}}'s or a narrator's.]",
};

const textBlockSchema = z.strictObject({
  kind: z.literal("text"),
  id: z.enum(TEXT_BLOCKS),
  enabled: z.boolean(),
  content: blockText,
  ...placement,
});
const sourceBlockSchema = z.strictObject({
  kind: z.literal("source"),
  id: z.enum(SOURCE_BLOCKS),
  enabled: z.boolean(),
  template: sourceTemplateSchema.exactOptional(),
  ...placement,
});
/** Older rows omit enabled and keep their original always-on behavior. */
const historyBlockSchema = z.strictObject({
  kind: z.literal("chatHistory"),
  id: z.literal("chatHistory"),
  enabled: z.boolean().exactOptional(),
});
const customBlockSchema = z.strictObject({
  ...placement,
  kind: z.literal("custom"),
  id: z.uuid(),
  name: presetNameSchema,
  role: promptRoleSchema,
  content: blockText,
  enabled: z.boolean(),
  /** Null: at its place in the order. A number: inside the chat, that many messages from the end. */
  depth: z.number().int().min(0).max(PRESET_LIMITS.maxDepth).nullable(),
  /**
   * An imported preset's `injection_order` for an in-chat block: at one depth
   * lower orders go first, and blocks of one order and role are sent as one
   * message (prompt/assemble.ts). Absent, `PRESET_LIMITS.defaultOrder`.
   */
  order: orderSchema.exactOptional(),
});
const promptBlockSchema = z.discriminatedUnion("kind", [
  textBlockSchema,
  sourceBlockSchema,
  historyBlockSchema,
  customBlockSchema,
]);
const storedPromptBlockSchema = z.discriminatedUnion("kind", [
  textBlockSchema.extend({ content: z.string() }),
  sourceBlockSchema.extend({ template: storedSourceTemplateSchema.exactOptional() }),
  historyBlockSchema,
  customBlockSchema.extend({ content: z.string() }),
]);
export type PromptBlock = z.infer<typeof promptBlockSchema>;

/** Every built-in block, each in a preset exactly once, an optional one at most once. */
const BUILT_IN_BLOCKS = [...TEXT_BLOCKS, ...SOURCE_BLOCKS, "chatHistory"] as const;
export type BuiltInBlock = (typeof BUILT_IN_BLOCKS)[number];

/** What the app calls each built-in block, in the editor, the inspector and import reports. */
export const BUILT_IN_NAMES: Record<BuiltInBlock, string> = {
  main: "Main prompt",
  postHistory: "Post-history instructions",
  lorebookBefore: "Lorebook, before character",
  personaDescription: "Persona description",
  charDescription: "Character description",
  charPersonality: "Character personality",
  scenario: "Scenario",
  castAnchors: "Cast",
  lorebookAfter: "Lorebook, after character",
  dialogueExamples: "Example dialogue",
  chatHistory: "Chat history",
};

/** A block with a role, a place, an order and triggers. */
export type Placeable = Exclude<PromptBlock, { kind: "chatHistory" }>;

/**
 * Source blocks prompt assembly sends at their role, depth and order (its
 * `placed`); the lorebook and example dialogue blocks always send at their
 * place in the order.
 */
const PLACED_SOURCE_BLOCKS: ReadonlySet<BuiltInBlock> = new Set([
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
]);

/** Whether a block's role, place, order and triggers take effect. */
export const isPlaceable = (block: PromptBlock): block is Placeable =>
  block.kind === "text" ||
  block.kind === "custom" ||
  (block.kind === "source" && PLACED_SOURCE_BLOCKS.has(block.id));

/** The role a block is sent as: a built-in's is the system's until set. */
export const blockRole = (block: Placeable): PromptRole => block.role ?? "system";

/** An in-chat block's `injection_order`, the default until set. */
export const blockOrder = (block: Placeable): number => block.order ?? PRESET_LIMITS.defaultOrder;

/**
 * Blocks in send order: every built-in exactly once (an optional one at
 * most once), custom blocks with unique ids.
 */
const blocksSchema = (blockSchema: typeof promptBlockSchema) =>
  z
    .array(blockSchema)
    .max(BUILT_IN_BLOCKS.length + PRESET_LIMITS.customBlocks)
    .check((ctx) => {
      const ids = ctx.value.map((block) => block.id);
      for (const id of BUILT_IN_BLOCKS) {
        const count = ids.filter((other) => other === id).length;
        if (count > 1 || (count === 0 && !OPTIONAL_BLOCKS.has(id))) {
          ctx.issues.push({
            code: "custom",
            message: OPTIONAL_BLOCKS.has(id)
              ? `${id} must appear at most once`
              : `${id} must appear exactly once`,
            input: ctx.value,
            continue: true,
          });
        }
      }
      const custom = ctx.value.filter((block) => block.kind === "custom").map((block) => block.id);
      if (new Set(custom).size !== custom.length) {
        ctx.issues.push({
          code: "custom",
          message: "custom block ids repeat",
          input: ctx.value,
          continue: true,
        });
      }
      if (custom.length > PRESET_LIMITS.customBlocks) {
        ctx.issues.push({
          code: "custom",
          message: "too many custom blocks",
          input: ctx.value,
          continue: true,
        });
      }
    });

/** Reasoning may be parsed from a tagged reply and optionally returned for the latest maxAdditions replies. Both behaviors default off. */
/** A reasoning tag's name, XML-style: a letter, then letters, digits, `_`, `-` and `.`. */
export const reasoningTagSchema = z
  .string()
  .min(1)
  .max(PRESET_LIMITS.reasoningTagLength)
  .regex(/^[A-Za-z][\w.-]*$/);

const promptReasoningSchema = z.strictObject({
  autoParse: z.boolean(),
  tag: reasoningTagSchema,
  addToPrompts: z.boolean(),
  maxAdditions: z.number().int().min(1).max(PRESET_LIMITS.maxDepth),
});
export type PromptReasoning = z.infer<typeof promptReasoningSchema>;

/** Default reasoning tag; nothing is parsed or sent until enabled. */
export const DEFAULT_PROMPT_REASONING: PromptReasoning = {
  autoParse: false,
  tag: "think",
  addToPrompts: false,
  maxAdditions: 1,
};

/** The preset owns its Author's Note. Frequency counts user turns: zero never, n every nth turn. Disabling it preserves its settings. */
const authorsNoteSchema = z.strictObject({
  enabled: z.boolean(),
  text: blockText,
  /** Placed inside history at depth, or immediately after the main prompt. */
  position: z.enum(["inChat", "afterMain"]),
  /** Messages from the end, as for in-chat preset blocks. */
  depth: z.number().int().min(0).max(PRESET_LIMITS.maxDepth),
  role: promptRoleSchema,
  frequency: z.number().int().min(0).max(PRESET_LIMITS.maxDepth),
});
export type AuthorsNote = z.infer<typeof authorsNoteSchema>;

/**
 * On, as the user directly before the player's latest message: a user
 * message keeps its place on every backend, where a system one may be
 * lifted into the system prompt. A preset without a note reads as this one.
 */
export const DEFAULT_AUTHORS_NOTE: AuthorsNote = {
  enabled: true,
  text: DEFAULT_NOTE_PROMPT,
  position: "inChat",
  depth: 1,
  role: "user",
  frequency: 1,
};

const presetFields = {
  name: presetNameSchema,
  blocks: blocksSchema(promptBlockSchema),
  actions: promptActionsSchema,
  reasoning: promptReasoningSchema,
};

const publicPromptPresetDataSchema = z.strictObject({
  ...presetFields,
  /** Absent in presets stored or imported before the note: the default, each parse its own copy. */
  authorsNote: authorsNoteSchema.default(() => ({ ...DEFAULT_AUTHORS_NOTE })),
});
/** Alias and source-placeholder conversion may widen saved text; all structural bounds remain. */
export const storedPromptPresetDataSchema = publicPromptPresetDataSchema.extend({
  blocks: blocksSchema(storedPromptBlockSchema),
  actions: promptActionsSchema.extend({ continue: z.string(), writeForMe: z.string() }),
  authorsNote: authorsNoteSchema
    .extend({ text: z.string() })
    .default(() => ({ ...DEFAULT_AUTHORS_NOTE })),
});
/** Public writes retain field bounds and must remain exportable. */
export const promptPresetSchema = publicPromptPresetDataSchema.refine(
  (preset) => fitsNativeFile("ephemera.prompt-preset", preset),
  { message: "The prompt preset is past the size limit", params: { code: "preset_too_large" } },
);
export type PromptPreset = z.infer<typeof promptPresetSchema>;
/** Whether a parse failed because the whole preset is past the limit, not because a field is invalid. */
export const isPromptPresetTooLarge = (error: z.ZodError): boolean =>
  hasIssue(error, "preset_too_large");

/**
 * A PATCH body: the sheet's edit and the revision it was made against. Not
 * `promptPresetSchema.partial()`, which keeps the note's default and would
 * reset an edited note on every patch that leaves it out.
 */
export const promptPresetPatchRequestSchema = withRevision(
  z.strictObject({ ...presetFields, authorsNote: authorsNoteSchema }).partial(),
);

/** The default's NPC, world and formatting instructions follow its main prompt. Stable ids keep every call deterministic. */
export function defaultPromptPreset(name = "Default"): PromptPreset {
  const source = (id: (typeof SOURCE_BLOCKS)[number]): PromptBlock => ({
    kind: "source",
    id,
    enabled: true,
    ...(id === "personaDescription" ? { template: DEFAULT_PERSONA_FORMAT } : {}),
  });
  const custom = (id: string, blockName: string, content: string): PromptBlock => ({
    kind: "custom",
    id,
    name: blockName,
    role: "system",
    content,
    enabled: true,
    depth: null,
  });
  return {
    name,
    blocks: [
      { kind: "text", id: "main", enabled: true, content: DEFAULT_MAIN_PROMPT },
      custom("301e6f36-12c1-48c7-a43d-ed0d8cc55fa1", "NPC details", DEFAULT_NPC_PROMPT),
      custom("9a9c25c3-02cf-4be2-95ed-862a64a36cb5", "World model", DEFAULT_WORLD_PROMPT),
      custom("ed9db645-c360-4d94-8010-a66610c69a0e", "Formatting", DEFAULT_FORMAT_PROMPT),
      source("lorebookBefore"),
      source("personaDescription"),
      source("charDescription"),
      source("charPersonality"),
      source("scenario"),
      source("castAnchors"),
      source("lorebookAfter"),
      source("dialogueExamples"),
      { kind: "chatHistory", id: "chatHistory" },
      { kind: "text", id: "postHistory", enabled: true, content: "" },
    ],
    actions: { ...DEFAULT_PROMPT_ACTIONS },
    reasoning: DEFAULT_PROMPT_REASONING,
    authorsNote: { ...DEFAULT_AUTHORS_NOTE },
  };
}

/** One prompt preset as the API returns it. */
export const storedPromptPresetSchema = z.strictObject({
  id: z.string(),
  ...storedPromptPresetDataSchema.shape,
  ...storedFields,
});
export type StoredPromptPreset = z.infer<typeof storedPromptPresetSchema>;
