import { type ConversionReport, emptyConversionReport } from "../card/import.ts";
import { isRecord } from "../card/json.ts";
import { SOURCE_PLACEHOLDER } from "../preset/defaults.ts";
import {
  DEFAULT_PROMPT_ACTIONS,
  type PromptBlock,
  type PromptPreset,
  storedPromptPresetDataSchema,
} from "../preset/prompt.ts";
import { normalizeMacroAliases } from "./aliases.ts";

/** Converts raw old prompt data without public file-size validation or truncation. */
export function upgradeLegacyPromptPreset(
  value: unknown,
  report: ConversionReport = emptyConversionReport(),
): PromptPreset {
  const native = storedPromptPresetDataSchema.safeParse(value);
  if (native.success) return native.data;
  if (!isRecord(value) || !Array.isArray(value.blocks))
    throw new Error("Invalid stored prompt preset");
  const formats = isRecord(value.formats) ? value.formats : {};
  let blocks: Record<string, unknown>[] = value.blocks.map((block) => {
    if (!isRecord(block)) throw new Error("Invalid stored prompt block");
    return {
      ...block,
      ...(typeof block.content === "string"
        ? { content: normalizeMacroAliases(block.content) }
        : {}),
      ...(typeof block.template === "string"
        ? { template: normalizeMacroAliases(block.template) }
        : {}),
    };
  });
  let converted = 0;
  const custom = (target: Record<string, unknown>, content: string, name: string) => {
    let id: string;
    do {
      id = `13f4fb9c-642e-4fd4-b889-${String(++converted).padStart(12, "0")}`;
    } while (blocks.some((block) => block.id === id));
    const { role, depth, order, triggers } = target;
    return {
      kind: "custom",
      id,
      name,
      content: normalizeMacroAliases(content),
      role: role ?? "system",
      depth: depth ?? null,
      enabled: target.enabled !== false,
      ...(order === undefined ? {} : { order }),
      ...(triggers === undefined ? {} : { triggers }),
    };
  };
  for (const [key, ids, placeholder] of [
    ["personality", ["charPersonality"], "{{personality}}"],
    ["scenario", ["scenario"], "{{scenario}}"],
    ["persona", ["personaDescription"], "{{persona}}"],
    ["lorebook", ["lorebookBefore", "lorebookAfter"], "{0}"],
  ] as const) {
    const wrapper = formats[key];
    if (typeof wrapper !== "string") continue;
    if (wrapper === "") {
      if (key === "personality" || key === "scenario") {
        blocks = blocks.map((block) => {
          if (block.kind !== "source" || !(ids as readonly unknown[]).includes(block.id))
            return block;
          report.changed.push(`The empty ${key} wrapper disabled its source block.`);
          return { ...block, enabled: false };
        });
      }
      continue;
    }
    blocks = blocks.flatMap((block) => {
      if (block.kind !== "source" || !(ids as readonly unknown[]).includes(block.id))
        return [block];
      if (wrapper.includes(placeholder))
        return [
          {
            ...block,
            template: normalizeMacroAliases(wrapper.replaceAll(placeholder, SOURCE_PLACEHOLDER)),
          },
        ];
      report.changed.push(
        `The ${key} source instruction became a custom block and its source was disabled.`,
      );
      return [
        { ...block, enabled: false },
        custom(
          block,
          wrapper,
          `${key === "lorebook" ? "Lorebook" : key === "persona" ? "Persona" : key === "scenario" ? "Scenario" : "Personality"} instruction`,
        ),
      ];
    });
  }
  for (const [key, target, generic] of [
    ["newChat", "chatHistory", /^\[start a new chat\]$/i],
    ["newExampleChat", "dialogueExamples", /^\[example chat\]$/i],
  ] as const) {
    const wrapper = formats[key];
    if (typeof wrapper !== "string" || wrapper.trim() === "" || generic.test(wrapper.trim()))
      continue;
    const index = blocks.findIndex((block) => block.id === target);
    blocks.splice(
      index < 0 ? blocks.length : index,
      0,
      custom(
        { enabled: blocks[index]?.enabled !== false },
        wrapper,
        key === "newChat" ? "Before the chat" : "Before examples",
      ),
    );
    report.changed.push(
      `${key === "newChat" ? "Before the chat" : "Before examples"} became one custom block before ${key === "newChat" ? "the chat" : "the examples"}.`,
    );
  }
  for (const [key, label] of [
    ["namesBehavior", "Character names"],
    ["sendIfEmpty", "Send if empty"],
    ["continuePrefill", "Continue prefill"],
    ["squashSystemMessages", "Join system messages"],
    ["continuePostfix", "Continue postfix"],
  ] satisfies [string, string][]) {
    if (Object.hasOwn(formats, key))
      report.skipped.push(`${label} was omitted; native prompt presets do not use this setting.`);
  }
  const action = (key: string, fallback: string) =>
    typeof formats[key] === "string" ? normalizeMacroAliases(formats[key]) : fallback;
  const note =
    isRecord(value.authorsNote) && typeof value.authorsNote.text === "string"
      ? { ...value.authorsNote, text: normalizeMacroAliases(value.authorsNote.text) }
      : value.authorsNote;
  return storedPromptPresetDataSchema.parse({
    name: value.name,
    blocks: blocks as PromptBlock[],
    actions: {
      continue: action("continueNudge", DEFAULT_PROMPT_ACTIONS.continue),
      writeForMe: action("impersonation", DEFAULT_PROMPT_ACTIONS.writeForMe),
    },
    reasoning: value.reasoning,
    ...(note === undefined ? {} : { authorsNote: note }),
  });
}
