import { z } from "zod";
import { clipText } from "../card/limits.ts";
import { isNativeFileAttempt } from "../file-format.ts";
import { upgradeLegacyPromptPreset } from "../imports/prompt-upgrade.ts";
import { promptPresetFileSchema, samplerPresetFileSchema } from "../native-files.ts";
import {
  BUILT_IN_NAMES,
  DEFAULT_PROMPT_ACTIONS,
  DEFAULT_PROMPT_REASONING,
  defaultPromptPreset,
  GENERATION_TYPES,
  type GenerationType,
  OPTIONAL_BLOCKS,
  PRESET_LIMITS,
  type PromptBlock,
  type PromptPreset,
  type PromptRole,
  promptPresetSchema,
  type SOURCE_BLOCKS,
} from "./prompt.ts";
import {
  defaultSamplerPreset,
  type ReasoningEffort,
  SAMPLER_RANGES,
  type SamplerPreset,
  type SamplerValues,
  samplerPresetSchema,
} from "./sampler.ts";

/*
 * SillyTavern Chat Completion presets, mapped from their documented fields
 * (docs.sillytavern.app: Prompt Manager, Reasoning; the default preset's
 * field names). A file is untrusted input: parsed with Zod, every known
 * field mapped or reported, every other field reported and dropped.
 */

/** The `prompt_order` entry SillyTavern uses for its global order. */
export const SILLYTAVERN_ORDER_ID = 100_001;
const LEGACY_ORDER_ID = 100_000;

type SourceId = (typeof SOURCE_BLOCKS)[number];

/** SillyTavern identifier to Ephemera's built-in block, with SillyTavern's display name. */
const BUILT_INS: Record<
  string,
  { block: "main" | "postHistory" | SourceId | "chatHistory"; name: string }
> = {
  main: { block: "main", name: "Main Prompt" },
  jailbreak: { block: "postHistory", name: "Post-History Instructions" },
  worldInfoBefore: { block: "lorebookBefore", name: "World Info (before)" },
  personaDescription: { block: "personaDescription", name: "Persona Description" },
  charDescription: { block: "charDescription", name: "Char Description" },
  charPersonality: { block: "charPersonality", name: "Char Personality" },
  scenario: { block: "scenario", name: "Scenario" },
  worldInfoAfter: { block: "lorebookAfter", name: "World Info (after)" },
  dialogueExamples: { block: "dialogueExamples", name: "Chat Examples" },
  chatHistory: { block: "chatHistory", name: "Chat History" },
};
const IDENTIFIER_OF = Object.fromEntries(
  Object.entries(BUILT_INS).map(([identifier, { block }]) => [block, identifier]),
);
/** SillyTavern's built-in text prompts Ephemera has no block of its own for. */
const AUXILIARY: Record<string, string> = {
  nsfw: "Auxiliary Prompt",
  enhanceDefinitions: "Enhance Definitions",
};
/**
 * Ephemera's default order of the built-in blocks, for placing one the file
 * lacks; an optional block stays out, for assembly to place.
 */
const DEFAULT_ORDER = defaultPromptPreset().blocks.flatMap((block) =>
  block.kind === "custom" || OPTIONAL_BLOCKS.has(block.id) ? [] : [block.id],
);

/** A table entry for an untrusted key: own properties only, never `toString` or `__proto__`. */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

const text = z.string();
const promptSchema = z.looseObject({
  identifier: z.string().min(1).max(PRESET_LIMITS.nameLength),
  name: text.optional(),
  role: text.optional(),
  content: text.optional(),
  marker: z.boolean().optional(),
  enabled: z.boolean().optional(),
  injection_position: z.number().optional(),
  injection_depth: z.number().optional(),
  injection_order: z.number().optional(),
  injection_trigger: z.array(z.unknown()).optional(),
  forbid_overrides: z.boolean().optional(),
});
type StPrompt = z.infer<typeof promptSchema>;
const orderSchema = z.array(
  z.looseObject({
    character_id: z.union([z.number(), z.string()]),
    order: z.array(z.looseObject({ identifier: z.string(), enabled: z.boolean().optional() })),
  }),
);
/** What makes a file a Chat Completion preset: its prompts. */
const fileSchema = z.looseObject({
  prompts: z.array(promptSchema).max(1_000),
  prompt_order: orderSchema.optional(),
});

/** Every field this module reads; any other field is reported as left out. */
const CONSUMED = new Set([
  "prompts",
  "prompt_order",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "openai_max_tokens",
  "seed",
  "reasoning_effort",
  "custom_model",
  "personality_format",
  "scenario_format",
  "new_chat_prompt",
  "new_example_chat_prompt",
  "continue_nudge_prompt",
  "impersonation_prompt",
  "continue_postfix",
  "continue_prefill",
  "send_if_empty",
  "names_behavior",
  "squash_system_messages",
  "wi_format",
  "top_k",
  "top_a",
  "min_p",
  "repetition_penalty",
  "openai_max_context",
]);

/** What an import kept as it was, changed on the way and left out, in words. */
export const importReportSchema = z.object({
  kept: z.array(z.string()),
  changed: z.array(z.string()),
  skipped: z.array(z.string()),
});
export type ImportReport = z.infer<typeof importReportSchema>;

export type ImportResult =
  | { ok: true; prompt: PromptPreset; sampler: SamplerPreset; report: ImportReport }
  | { ok: false; reason: "not_a_preset" | "too_large" };

export interface ImportOptions {
  /** A new UUID for each custom block. */
  newId: () => string;
  /** The catalog's model ids; the preset's model is kept only when listed. */
  models: string[] | undefined;
}

const EFFORTS: Record<string, ReasoningEffort> = {
  auto: "provider-default",
  min: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

/** The prompt order that applies: the global entry, the legacy one, else the first. */
function chooseOrder(file: z.infer<typeof fileSchema>) {
  const orders = file.prompt_order ?? [];
  const byId = (id: number) => orders.find((entry) => Number(entry.character_id) === id);
  return (byId(SILLYTAVERN_ORDER_ID) ?? byId(LEGACY_ORDER_ID) ?? orders[0])?.order;
}

const roleOf = (role: string | undefined): PromptRole | undefined =>
  role === "system" || role === "user" || role === "assistant" ? role : undefined;

function metadata(
  prompt: StPrompt | undefined,
  report: ImportReport,
): {
  role?: PromptRole;
  depth?: number | null;
  order?: number;
  forbidOverrides?: boolean;
  triggers?: GenerationType[];
} {
  if (prompt === undefined) return {};
  if (
    prompt.injection_position !== undefined &&
    prompt.injection_position !== 0 &&
    prompt.injection_position !== 1
  )
    report.changed.push(
      `Prompt “${prompt.name ?? prompt.identifier}” had an unknown placement; relative placement is used.`,
    );
  const role = roleOf(prompt.role);
  if (prompt.role !== undefined && role === undefined)
    report.changed.push(
      `Prompt “${prompt.name ?? prompt.identifier}” had an unknown role; system is used.`,
    );
  const depth =
    prompt.injection_position === 1
      ? Math.min(
          PRESET_LIMITS.maxDepth,
          Math.max(0, Math.trunc(prompt.injection_depth ?? PRESET_LIMITS.defaultDepth)),
        )
      : null;
  const order = Math.min(
    PRESET_LIMITS.maxOrder,
    Math.max(
      -PRESET_LIMITS.maxOrder,
      Math.trunc(prompt.injection_order ?? PRESET_LIMITS.defaultOrder),
    ),
  );
  const triggers = prompt.injection_trigger?.filter(
    (value): value is GenerationType =>
      typeof value === "string" && (GENERATION_TYPES as readonly string[]).includes(value),
  );
  if (triggers !== undefined && triggers.length !== prompt.injection_trigger?.length)
    report.changed.push(
      `Unknown generation triggers on “${prompt.name ?? prompt.identifier}” were left out.`,
    );
  if (
    prompt.injection_depth !== undefined &&
    prompt.injection_position === 1 &&
    depth !== prompt.injection_depth
  )
    report.changed.push(
      `Prompt “${prompt.name ?? prompt.identifier}” depth was limited to ${depth}.`,
    );
  if (prompt.injection_order !== undefined && order !== prompt.injection_order)
    report.changed.push(
      `Prompt “${prompt.name ?? prompt.identifier}” order was limited to ${order}.`,
    );
  return {
    ...(role === undefined || role === "system" ? {} : { role }),
    ...(depth === null ? {} : { depth }),
    ...(prompt.injection_order === undefined || order === PRESET_LIMITS.defaultOrder
      ? {}
      : { order }),
    ...(prompt.forbid_overrides === true ? { forbidOverrides: true } : {}),
    ...(triggers === undefined || triggers.length === 0
      ? {}
      : { triggers: [...new Set(triggers)] }),
  };
}

export function fromSillyTavern(
  input: unknown,
  name: string,
  { newId, models }: ImportOptions,
): ImportResult {
  if (isNativeFileAttempt(input)) return { ok: false, reason: "not_a_preset" };
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "not_a_preset" };
  const file = parsed.data;
  const report: ImportReport = { kept: [], changed: [], skipped: [] };
  const record = file as Record<string, unknown>;
  const formats = readFormats(record);
  let customLimit: number;
  try {
    // Every wrapper source is a required built-in. Run their shared conversion
    // without original custom prompts to reserve exactly its material blocks.
    const base = defaultPromptPreset(name);
    const wrappers = upgradeLegacyPromptPreset({
      ...base,
      blocks: base.blocks.filter((block) => block.kind !== "custom"),
      formats,
    });
    customLimit =
      PRESET_LIMITS.customBlocks -
      wrappers.blocks.filter((block) => block.kind === "custom").length;
  } catch {
    return { ok: false, reason: "too_large" };
  }

  const promptFields = new Set([
    "identifier",
    "name",
    "system_prompt",
    "role",
    "content",
    "marker",
    "enabled",
    "injection_position",
    "injection_depth",
    "injection_order",
    "injection_trigger",
    "forbid_overrides",
  ]);
  const unusedPromptFields = [
    ...new Set(
      file.prompts.flatMap((prompt) => Object.keys(prompt).filter((key) => !promptFields.has(key))),
    ),
  ];
  if (unusedPromptFields.length > 0)
    report.skipped.push(
      `Prompt settings with no counterpart here: ${unusedPromptFields.join(", ")}.`,
    );
  const prompts = new Map<string, StPrompt>();
  for (const prompt of file.prompts) {
    if (!prompts.has(prompt.identifier)) prompts.set(prompt.identifier, prompt);
  }
  const order =
    chooseOrder(file) ??
    file.prompts.map((prompt) => ({
      identifier: prompt.identifier,
      enabled: prompt.enabled ?? true,
    }));

  const blocks: PromptBlock[] = [];
  const seen = new Set<string>();
  /** In-chat blocks keep their slots; among themselves they follow `injection_order`. */
  const inChat: { index: number; order: number }[] = [];
  let custom = 0;
  const unknownMarkers: string[] = [];
  const dropped: string[] = [];

  for (const entry of order) {
    if (seen.has(entry.identifier)) continue;
    seen.add(entry.identifier);
    const prompt = prompts.get(entry.identifier);
    const enabled = entry.enabled ?? true;
    const builtIn = own(BUILT_INS, entry.identifier);
    if (builtIn !== undefined) {
      const { block } = builtIn;
      if (block === "chatHistory") {
        blocks.push({
          kind: "chatHistory",
          id: "chatHistory",
          ...(enabled ? {} : { enabled: false }),
        });
      } else if (block === "main" || block === "postHistory") {
        blocks.push({
          kind: "text",
          id: block,
          enabled,
          content: prompt?.content ?? "",
          ...metadata(prompt, report),
        });
      } else {
        blocks.push({ kind: "source", id: block, enabled, ...metadata(prompt, report) });
      }
      continue;
    }
    if (prompt === undefined) {
      dropped.push(entry.identifier);
      continue;
    }
    if (prompt.marker === true && own(AUXILIARY, entry.identifier) === undefined) {
      unknownMarkers.push(prompt.name?.trim() || entry.identifier);
      continue;
    }
    if (custom === customLimit) {
      dropped.push(prompt.name?.trim() || entry.identifier);
      continue;
    }
    custom += 1;
    const blockName = clipText(
      prompt.name?.trim() || own(AUXILIARY, entry.identifier) || "Custom prompt",
      PRESET_LIMITS.nameLength,
    );
    const auxiliary = own(AUXILIARY, entry.identifier);
    if (auxiliary !== undefined) {
      report.changed.push(
        `The ${auxiliary.toLowerCase()} became the custom block “${blockName}”${enabled ? "" : ", switched off as it was"}.`,
      );
    }
    // A missing role is SillyTavern's default, system; `metadata` reports an unknown one.
    const { role, depth = null, order, ...details } = metadata(prompt, report);
    if (depth !== null) {
      inChat.push({ index: blocks.length, order: order ?? PRESET_LIMITS.defaultOrder });
    }
    blocks.push({
      kind: "custom",
      id: newId(),
      name: blockName,
      role: role ?? "system",
      content: prompt.content ?? "",
      enabled,
      depth,
      // Kept for in-chat blocks whose order is not the default, as assembly reads it.
      ...(depth !== null && order !== undefined ? { order } : {}),
      ...details,
    });
  }

  // Inactive library prompts remain available without entering generation order.
  let inactive = 0;
  for (const [identifier, item] of prompts) {
    if (seen.has(identifier) || own(BUILT_INS, identifier) !== undefined) continue;
    if (item.marker === true && own(AUXILIARY, identifier) === undefined) {
      unknownMarkers.push(item.name?.trim() || identifier);
      continue;
    }
    if (custom >= customLimit || (item.content?.length ?? 0) > PRESET_LIMITS.blockText) {
      dropped.push(item.name?.trim() || identifier);
      continue;
    }
    custom += 1;
    inactive += 1;
    const details = metadata(item, report);
    blocks.push({
      kind: "custom",
      id: newId(),
      name: clipText(item.name?.trim() || "Custom prompt", PRESET_LIMITS.nameLength),
      role: details.role ?? "system",
      content: item.content ?? "",
      enabled: false,
      depth: details.depth ?? null,
      ...details,
    });
  }
  if (inactive > 0)
    report.changed.push(
      `${inactive} inactive library prompts were kept as disabled custom blocks at the end.`,
    );

  // In-chat prompts at one depth follow `injection_order`; their list slots stay.
  const sorted = inChat
    .map(({ index, order: position }) => ({ block: blocks[index], position }))
    .sort((a, b) => a.position - b.position);
  inChat.forEach(({ index }, i) => {
    const block = sorted[i]?.block;
    if (block !== undefined) blocks[index] = block;
  });

  // Missing built-ins are appended and enabled in Ephemera's default order.
  const present = new Set(blocks.map((block) => block.id));
  for (const id of DEFAULT_ORDER) {
    if (present.has(id)) continue;
    const content = prompts.get(IDENTIFIER_OF[id] ?? "")?.content ?? "";
    const block: PromptBlock =
      id === "chatHistory"
        ? { kind: "chatHistory", id }
        : id === "main" || id === "postHistory"
          ? {
              kind: "text",
              id,
              enabled: true,
              content,
              ...metadata(prompts.get(IDENTIFIER_OF[id] ?? ""), report),
            }
          : {
              kind: "source",
              id,
              enabled: true,
              ...metadata(prompts.get(IDENTIFIER_OF[id] ?? ""), report),
            };
    blocks.push(block);
    present.add(id);
    if (id !== "chatHistory") {
      report.changed.push(
        `${BUILT_IN_NAMES[id]} was not in the preset's order; added at the end and enabled.`,
      );
    }
  }

  // Reasoning formatting lives in SillyTavern's Advanced Formatting, not in this file.
  let converted: PromptPreset;
  try {
    converted = upgradeLegacyPromptPreset(
      {
        name,
        blocks,
        formats,
        reasoning: DEFAULT_PROMPT_REASONING,
      },
      report,
    );
  } catch {
    return { ok: false, reason: "too_large" };
  }

  if (!promptPresetSchema.safeParse(converted).success) return { ok: false, reason: "too_large" };
  report.kept.push(
    `${blocks.length} prompt blocks in the preset's order, ${custom} of them custom${inChat.length > 0 ? `, ${inChat.length} placed inside the chat` : ""}.`,
    "Useful source wrappers became native source templates or custom instructions.",
    "Continue and Write for me instructions were retained.",
  );
  report.kept.push("Prompt roles, in-chat placement, generation triggers and override locks.");
  // SillyTavern keeps its note per chat, not in the preset; the parse gave the default.
  report.kept.push("Author's Note: Ephemera's default, on; edit it in the preset.");
  if (unknownMarkers.length > 0) {
    report.skipped.push(`Markers Ephemera doesn't fill: ${unknownMarkers.join(", ")}.`);
  }
  if (dropped.length > 0) report.skipped.push(`Prompts left out: ${dropped.join(", ")}.`);

  const sampler = readSampler(record, name, models, report);
  const leftOver = Object.keys(record).filter((key) => !CONSUMED.has(key));
  if (leftOver.length > 0) {
    report.skipped.push(`SillyTavern settings with no counterpart here: ${leftOver.join(", ")}.`);
  }
  return { ok: true, prompt: converted, sampler, report };
}

function readFormats(record: Record<string, unknown>) {
  const field = (key: string, fallback: string) => {
    const value = record[key];
    return typeof value === "string" ? value : fallback;
  };
  return {
    personality: field("personality_format", "{{personality}}"),
    scenario: field("scenario_format", "{{scenario}}"),
    newChat: field("new_chat_prompt", ""),
    newExampleChat: field("new_example_chat_prompt", ""),
    continueNudge: field("continue_nudge_prompt", DEFAULT_PROMPT_ACTIONS.continue),
    impersonation: field("impersonation_prompt", DEFAULT_PROMPT_ACTIONS.writeForMe),
    lorebook: field("wi_format", "{0}"),
    ...(Object.hasOwn(record, "continue_postfix")
      ? { continuePostfix: record.continue_postfix }
      : {}),
    ...(typeof record.send_if_empty === "string" ? { sendIfEmpty: record.send_if_empty } : {}),
    ...(record.names_behavior === undefined ? {} : { namesBehavior: record.names_behavior }),
    ...(record.continue_prefill === true ? { continuePrefill: true } : {}),
    ...(record.squash_system_messages === true ? { squashSystemMessages: true } : {}),
  };
}

type Ranged = keyof typeof SAMPLER_RANGES;

function readSampler(
  record: Record<string, unknown>,
  name: string,
  models: string[] | undefined,
  report: ImportReport,
): SamplerPreset {
  const values: SamplerValues = { ...defaultSamplerPreset().values };
  const kept: string[] = [];
  const outOfRange: string[] = [];
  const ranged = (key: string, target: Ranged, label: string, integer = false) => {
    const value = record[key];
    if (value === undefined) return;
    const { min, max } = SAMPLER_RANGES[target];
    if (
      typeof value === "number" &&
      value >= min &&
      value <= max &&
      (!integer || Number.isInteger(value))
    ) {
      values[target] = value;
      kept.push(label);
    } else {
      outOfRange.push(label);
    }
  };
  ranged("temperature", "temperature", "Temperature");
  ranged("top_p", "topP", "Top-p");
  ranged("frequency_penalty", "frequencyPenalty", "Frequency penalty");
  ranged("presence_penalty", "presencePenalty", "Presence penalty");
  ranged("openai_max_tokens", "maxOutputTokens", "Reply length", true);
  const seed = record.seed;
  if (typeof seed === "number" && seed < 0) {
    // SillyTavern's -1: a random seed each reply, Ephemera's unset seed.
  } else if (seed !== undefined) {
    ranged("seed", "seed", "Seed", true);
  }
  const effort = record.reasoning_effort;
  const mapped = typeof effort === "string" ? own(EFFORTS, effort) : undefined;
  if (typeof effort === "string" && mapped !== undefined) {
    values.reasoning = mapped;
    kept.push("Reasoning");
    if (effort === "min") report.changed.push("Reasoning “min” became Minimal.");
  } else if (effort !== undefined) {
    outOfRange.push("Reasoning");
  }
  const model = record.custom_model;
  if (typeof model === "string" && model !== "") {
    if (models?.includes(model)) {
      values.model = model;
      kept.push("Model");
    } else {
      report.skipped.push(
        `Model “${model}”: not offered by the provider, so the chat's model is used.`,
      );
    }
  }
  if (kept.length > 0) report.kept.push(`${kept.join(", ")}.`);
  if (outOfRange.length > 0) {
    report.skipped.push(`${outOfRange.join(", ")}: outside what Ephemera accepts.`);
  }
  const unsupported = [
    ["top_k", "Top K"],
    ["top_a", "Top A"],
    ["min_p", "Min P"],
    ["repetition_penalty", "Repetition penalty"],
  ]
    .filter(([key]) => record[key as string] !== undefined)
    .map(([, label]) => label);
  if (unsupported.length > 0) {
    report.skipped.push(`${unsupported.join(", ")}: Ephemera doesn't send them.`);
  }
  if (record.openai_max_context !== undefined) {
    report.skipped.push("Context size: each model's own window is used instead.");
  }
  return samplerPresetSchema.parse({ name, values });
}

/** Fail-closed dispatch for independent native presets and foreign paired imports. */
export function importPresetFile(input: unknown, name: string, options: ImportOptions) {
  if (isNativeFileAttempt(input)) {
    const prompt = promptPresetFileSchema.safeParse(input);
    if (prompt.success)
      return {
        ok: true as const,
        format: "prompt" as const,
        prompt: prompt.data.data,
        report: { kept: [], changed: [], skipped: [] },
      };
    const sampler = samplerPresetFileSchema.safeParse(input);
    if (sampler.success)
      return {
        ok: true as const,
        format: "sampler" as const,
        sampler: sampler.data.data,
        report: { kept: [], changed: [], skipped: [] },
      };
    return { ok: false as const, reason: "not_a_preset" as const };
  }
  const result = fromSillyTavern(input, name, options);
  return result.ok ? { ...result, format: "foreign" as const } : result;
}
