import { describe, expect, it } from "vitest";
import { blankCard } from "../card/index.ts";
import { type CastRegister, emptyCastAnchor, emptyCastState } from "../cast/register.ts";
import { assemblePrompt, flatten } from "../prompt/assemble.ts";
import {
  DEFAULT_AUTHORS_NOTE,
  PRESET_LIMITS,
  type PromptBlock,
  promptPresetSchema,
  samplerPresetSchema,
} from "./index.ts";
import { fromSillyTavern, SILLYTAVERN_ORDER_ID } from "./sillytavern.ts";

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const marker = (identifier: string, name: string) => ({
  identifier,
  name,
  system_prompt: true,
  marker: true,
});

/**
 * A SillyTavern Chat Completion preset, synthetic, built from the documented
 * field names and the default preset's shape.
 */
function stPreset(overrides: Record<string, unknown> = {}) {
  return {
    chat_completion_source: "custom",
    custom_model: "kimi-k3",
    openai_model: "gpt-4-turbo",
    temperature: 0.85,
    frequency_penalty: 0.1,
    presence_penalty: 0,
    top_p: 0.95,
    top_k: 40,
    top_a: 0,
    min_p: 0.05,
    repetition_penalty: 1,
    openai_max_context: 32_768,
    openai_max_tokens: 1_200,
    seed: -1,
    reasoning_effort: "max",
    stream_openai: true,
    names_behavior: 0,
    personality_format: "[{{char}}'s personality: {{personality}}]",
    scenario_format: "[Scenario: {{scenario}}]",
    new_chat_prompt: "[Start a new Chat]",
    new_example_chat_prompt: "[Example Chat]",
    continue_nudge_prompt: "[Keep going, {{char}}.]",
    impersonation_prompt: "[Write as {{user}}.]",
    continue_postfix: "\n",
    continue_prefill: false,
    assistant_impersonation: "",
    wi_format: "{0}",
    prompts: [
      {
        identifier: "main",
        name: "Main Prompt",
        system_prompt: true,
        role: "system",
        content: "Write {{char}}'s next reply.",
      },
      {
        identifier: "nsfw",
        name: "Auxiliary Prompt",
        system_prompt: true,
        role: "system",
        content: "Keep it grounded.",
      },
      marker("dialogueExamples", "Chat Examples"),
      {
        identifier: "jailbreak",
        name: "Post-History Instructions",
        system_prompt: true,
        role: "system",
        content: "Two paragraphs.",
        forbid_overrides: true,
      },
      marker("chatHistory", "Chat History"),
      marker("worldInfoAfter", "World Info (after)"),
      marker("worldInfoBefore", "World Info (before)"),
      {
        identifier: "enhanceDefinitions",
        name: "Enhance Definitions",
        system_prompt: true,
        role: "system",
        content: "Add lore.",
      },
      marker("charDescription", "Char Description"),
      marker("charPersonality", "Char Personality"),
      marker("scenario", "Scenario"),
      marker("personaDescription", "Persona Description"),
      {
        identifier: "a1b2",
        name: "Stay in scene",
        system_prompt: false,
        role: "system",
        content: "Keep the storm present.",
        injection_position: 1,
        injection_depth: 4,
        injection_order: 100,
      },
      {
        identifier: "c3d4",
        name: "Voice",
        system_prompt: false,
        role: "user",
        content: "Short lines.",
        injection_position: 0,
        injection_depth: 4,
      },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [{ identifier: "main", enabled: true }],
      },
      {
        character_id: 100001,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "worldInfoBefore", enabled: true },
          { identifier: "personaDescription", enabled: true },
          { identifier: "charDescription", enabled: true },
          { identifier: "charPersonality", enabled: true },
          { identifier: "scenario", enabled: true },
          { identifier: "enhanceDefinitions", enabled: false },
          { identifier: "nsfw", enabled: true },
          { identifier: "c3d4", enabled: true },
          { identifier: "worldInfoAfter", enabled: true },
          { identifier: "dialogueExamples", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "a1b2", enabled: true },
          { identifier: "jailbreak", enabled: true },
        ],
      },
    ],
    ...overrides,
  };
}

const options = { newId, models: ["kimi-k3", "qwen3.8-max"] };

function imported(overrides: Record<string, unknown> = {}) {
  const result = fromSillyTavern(stPreset(overrides), "Harbourlight", options);
  if (!result.ok) throw new Error(`not imported: ${result.reason}`);
  return result;
}

const ids = (blocks: PromptBlock[]) =>
  blocks.map((block) => (block.kind === "custom" ? block.name : block.id));

describe("SillyTavern preset import", () => {
  it("keeps the global prompt order with every built-in in place", () => {
    const { prompt } = imported();
    expect(promptPresetSchema.parse(prompt)).toEqual(prompt);
    expect(prompt.name).toBe("Harbourlight");
    expect(ids(prompt.blocks)).toEqual([
      "main",
      "lorebookBefore",
      "personaDescription",
      "charDescription",
      "charPersonality",
      "scenario",
      "Enhance Definitions",
      "Auxiliary Prompt",
      "Voice",
      "lorebookAfter",
      "dialogueExamples",
      "chatHistory",
      "Stay in scene",
      "postHistory",
    ]);
  });

  it("places the cast's anchors right after the scenario, the file having no block for them", () => {
    const { prompt } = imported();
    const cast: CastRegister = {
      entries: [
        {
          id: newId(),
          role: "minor",
          anchor: { ...emptyCastAnchor("Ilse Brandt", "female"), age: "29" },
          aka: [],
          state: emptyCastState(true),
        },
      ],
    };
    const sources = flatten(
      assemblePrompt({
        preset: prompt,
        character: { ...blankCard("Mara Voss"), scenario: "A storm night." },
        persona: null,
        history: [{ role: "user", content: "Hi." }],
        clock: { now: 0, timeZone: "UTC" },
        pickSeed: 0,
        random: () => 0,
        cast,
      }),
    ).map((message) => message.source);
    const scenario = sources.findIndex((s) => s.kind === "block" && s.id === "scenario");
    expect(sources[scenario + 1]).toEqual({ kind: "block", id: "castAnchors" });
  });

  it("keeps text, roles, states and in-chat depth", () => {
    const { prompt } = imported();
    const find = (name: string) =>
      prompt.blocks.find((block) => (block.kind === "custom" ? block.name : block.id) === name);
    expect(find("main")).toEqual({
      kind: "text",
      id: "main",
      enabled: true,
      content: "Write {{char}}'s next reply.",
    });
    expect(find("postHistory")).toMatchObject({ content: "Two paragraphs.", enabled: true });
    expect(find("Enhance Definitions")).toMatchObject({
      kind: "custom",
      role: "system",
      content: "Add lore.",
      enabled: false,
      depth: null,
    });
    expect(find("Stay in scene")).toMatchObject({ role: "system", depth: 4, enabled: true });
    expect(find("Voice")).toMatchObject({ role: "user", depth: null });
  });

  it("preserves inactive library prompts without enabling them", () => {
    const file = stPreset();
    const unused = {
      identifier: "unused",
      name: "Unused",
      role: "assistant",
      content: "{{setvar::x::unused}}",
      injection_position: 1,
      injection_depth: 3,
      injection_trigger: ["swipe"],
      forbid_overrides: true,
    };
    const { prompt, report } = imported({ prompts: [...file.prompts, unused] });
    expect(prompt.blocks.at(-1)).toMatchObject({
      kind: "custom",
      name: "Unused",
      enabled: false,
      role: "assistant",
      depth: 3,
      triggers: ["swipe"],
      forbidOverrides: true,
    });
    expect(report.changed.join("\n")).toMatch(/inactive library/);
  });

  it("disables explicitly empty personality and scenario wrappers at import", () => {
    const { prompt, report } = imported({
      personality_format: "",
      scenario_format: "",
      wi_format: "",
    });
    for (const id of ["charPersonality", "scenario"])
      expect(prompt.blocks.find((block) => block.id === id)).toMatchObject({ enabled: false });
    expect(prompt.blocks.find((block) => block.id === "lorebookBefore")).toEqual({
      kind: "source",
      id: "lorebookBefore",
      enabled: true,
    });
    expect(report.changed).toEqual(
      expect.arrayContaining([
        "The empty personality wrapper disabled its source block.",
        "The empty scenario wrapper disabled its source block.",
      ]),
    );
  });

  it.each([
    { label: "no added wrappers", formats: {}, instructions: [] },
    {
      label: "one material wrapper",
      formats: { new_chat_prompt: "Begin at midnight." },
      instructions: ["Begin at midnight."],
    },
    {
      label: "all material wrappers",
      formats: {
        personality_format: "Keep the personality grounded.",
        scenario_format: "Keep the storm present.",
        wi_format: "Remember the harbour.",
        new_chat_prompt: "Begin at midnight.",
        new_example_chat_prompt: "Follow the examples closely.",
      },
      instructions: [
        "Keep the personality grounded.",
        "Keep the storm present.",
        "Remember the harbour.",
        "Remember the harbour.",
        "Begin at midnight.",
        "Follow the examples closely.",
      ],
    },
  ])("reserves exactly the conversion capacity for $label", ({ formats, instructions }) => {
    const prompts = Array.from({ length: PRESET_LIMITS.customBlocks }, (_, index) => ({
      identifier: `original-${index}`,
      name: `Original ${index}`,
      content: `Instruction ${index}`,
    }));
    const { prompt, report } = imported({ prompts, prompt_order: undefined, ...formats });
    const customs = prompt.blocks.filter((block) => block.kind === "custom");
    expect(customs).toHaveLength(PRESET_LIMITS.customBlocks);
    const kept = PRESET_LIMITS.customBlocks - instructions.length;
    expect(
      customs.filter((block) => block.name.startsWith("Original ")).map((block) => block.content),
    ).toEqual(prompts.slice(0, kept).map((item) => item.content));
    expect(
      customs
        .filter((block) => !block.name.startsWith("Original "))
        .map((block) => block.content)
        .sort(),
    ).toEqual([...instructions].sort());
    expect(report.skipped.filter((line) => line.startsWith("Prompts left out:"))).toEqual(
      instructions.length === 0
        ? []
        : [
            `Prompts left out: ${prompts
              .slice(kept)
              .map((item) => item.name)
              .join(", ")}.`,
          ],
    );
  });

  it("fills remaining wrapper capacity from the ordered prompts before the inactive library", () => {
    const prompts = Array.from({ length: 130 }, (_, index) => ({
      identifier: `original-${index}`,
      name: `Original ${index}`,
      content: `Instruction ${index}`,
    }));
    const ordered = prompts.slice(20, 120).reverse();
    const { prompt, report } = imported({
      prompts,
      prompt_order: [
        {
          character_id: SILLYTAVERN_ORDER_ID,
          order: ordered.map((item, index) => ({
            identifier: item.identifier,
            enabled: index !== 0,
          })),
        },
      ],
      new_chat_prompt: "Begin at midnight.",
    });
    const originals = prompt.blocks
      .filter((block) => block.kind === "custom")
      .filter((block) => block.name.startsWith("Original "));
    expect(originals.map((block) => block.content)).toEqual([
      ...ordered.map((item) => item.content),
      ...prompts.slice(0, 20).map((item) => item.content),
      ...prompts.slice(120, 127).map((item) => item.content),
    ]);
    expect(originals[0]?.enabled).toBe(false);
    expect(originals.slice(1, 100).every((block) => block.enabled)).toBe(true);
    expect(originals.slice(100).every((block) => !block.enabled)).toBe(true);
    expect(report.changed).toContain(
      "27 inactive library prompts were kept as disabled custom blocks at the end.",
    );
    expect(report.skipped).toContain("Prompts left out: Original 127, Original 128, Original 129.");
    expect(prompt.blocks.filter((block) => block.kind === "custom")).toHaveLength(128);
  });

  it("reports invalid placement and unused prompt metadata", () => {
    const file = stPreset();
    const prompts = file.prompts.map((prompt) =>
      prompt.identifier === "main"
        ? { ...prompt, injection_position: 17, future_flag: true }
        : prompt,
    );
    const { report } = imported({ prompts });
    expect(report.changed.join("\n")).toMatch(/unknown placement/);
    expect(report.skipped.join("\n")).toContain("future_flag");
  });

  it("reports a custom prompt's unknown role once, and keeps no order on a block at its place", () => {
    const file = stPreset();
    const prompts = file.prompts.map((prompt) =>
      prompt.identifier === "c3d4"
        ? { ...prompt, name: "Narr", role: "narrator", injection_order: 50 }
        : prompt,
    );
    const { prompt, report } = imported({ prompts });
    const block = prompt.blocks.find((item) => item.kind === "custom" && item.name === "Narr");
    expect(block).toMatchObject({ role: "system", depth: null });
    expect(block).not.toHaveProperty("order");
    expect(report.changed.filter((line) => line.includes("Narr"))).toEqual([
      "Prompt “Narr” had an unknown role; system is used.",
    ]);
  });

  it("maps sampler values and the model the catalog offers", () => {
    const { sampler } = imported();
    expect(samplerPresetSchema.parse(sampler)).toEqual(sampler);
    expect(sampler).toEqual({
      name: "Harbourlight",
      values: {
        model: "kimi-k3",
        maxOutputTokens: 1_200,
        temperature: 0.85,
        topP: 0.95,
        frequencyPenalty: 0.1,
        presencePenalty: 0,
        seed: null,
        reasoning: "max",
      },
    });
  });

  it.each([
    ["auto", "provider-default"],
    ["min", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["max", "max"],
  ])("maps reasoning effort %s to %s", (from, to) => {
    expect(imported({ reasoning_effort: from }).sampler.values.reasoning).toBe(to);
  });

  it("reports what changed and what was left out, by name", () => {
    const { report } = imported({ model: undefined, custom_model: "not-offered" });
    const all = [...report.changed, ...report.skipped].join("\n");
    expect(report.changed.join("\n")).toMatch(/Auxiliary Prompt/);
    expect(report.changed.join("\n")).toMatch(/Enhance Definitions/);
    expect(report.changed.join("\n")).not.toMatch(/Reasoning/);
    for (const name of ["Top K", "Top A", "Min P", "Repetition penalty", "Context size"]) {
      expect(report.skipped.join("\n")).toContain(name);
    }
    expect(report.skipped.join("\n")).toContain("not-offered");
    for (const key of ["stream_openai", "openai_model"]) {
      expect(all).toContain(key);
    }
    expect(all).not.toContain("wi_format");
    expect(report.kept.length).toBeGreaterThan(0);
  });

  it("gives the preset Ephemera's default Author's Note, on, and says so", () => {
    const { prompt, report } = imported();
    expect(prompt.authorsNote).toEqual(DEFAULT_AUTHORS_NOTE);
    expect(report.kept).toContain("Author's Note: Ephemera's default, on; edit it in the preset.");
  });

  it("uses the legacy order, then the prompts' own order, when the global one is absent", () => {
    const legacy = stPreset().prompt_order[1]?.order.filter(
      (entry) => entry.identifier !== "personaDescription",
    );
    const { prompt, report } = imported({
      prompt_order: [{ character_id: 100000, order: legacy }],
    });
    // Persona description, absent from the legacy order, is appended and enabled.
    expect(prompt.blocks.at(-1)).toMatchObject({ id: "personaDescription", enabled: true });
    expect(report.changed).toContain(
      "Persona description was not in the preset's order; added at the end and enabled.",
    );

    const bare = imported({ prompt_order: undefined });
    expect(promptPresetSchema.parse(bare.prompt)).toBeTruthy();
    expect(ids(bare.prompt.blocks)[0]).toBe("main");
  });

  it("keeps the main and post-history role and placement", () => {
    const prompts = stPreset().prompts.map((prompt) =>
      prompt.identifier === "main"
        ? { ...prompt, role: "assistant" }
        : prompt.identifier === "jailbreak"
          ? { ...prompt, injection_position: 1, injection_depth: 2 }
          : prompt,
    );
    const { prompt, report } = imported({ prompts });
    const changed = report.changed.join("\n");
    expect(changed).not.toMatch(/main prompt|post-history/);
    expect(prompt.blocks.find((block) => block.id === "main")).toMatchObject({
      kind: "text",
      role: "assistant",
    });
    expect(prompt.blocks.find((block) => block.id === "postHistory")).toMatchObject({ depth: 2 });
    expect(imported().report.changed.join("\n")).not.toMatch(/main prompt|post-history/);
  });

  it("keeps disabled chat history", () => {
    const order = stPreset().prompt_order[1]?.order.map((entry) =>
      entry.identifier === "chatHistory" ? { ...entry, enabled: false } : entry,
    );
    const { prompt, report } = imported({
      prompt_order: [{ character_id: SILLYTAVERN_ORDER_ID, order }],
    });
    expect(prompt.blocks.find((block) => block.kind === "chatHistory")).toMatchObject({
      enabled: false,
    });
    expect(report.changed.join("\n")).not.toMatch(/Chat history/i);
  });

  it("leaves out sampler values outside Ephemera's ranges", () => {
    const { sampler, report } = imported({ temperature: 3, top_p: "high", openai_max_tokens: 0 });
    expect(sampler.values).toMatchObject({ temperature: null, topP: null, maxOutputTokens: null });
    expect(report.skipped.join("\n")).toMatch(/Temperature/);
  });

  it("keeps a seed and ignores SillyTavern's random seed", () => {
    expect(imported({ seed: 42 }).sampler.values.seed).toBe(42);
    expect(imported({ seed: -1 }).sampler.values.seed).toBeNull();
  });

  it.each([
    ["a character card", { spec: "chara_card_v2", data: { name: "Mara" } }],
    ["a text completion preset", { temp: 0.7, rep_pen: 1.1 }],
    ["an array", []],
    ["prompts that are not a list", { prompts: "main" }],
    ["a prompt without an identifier", { prompts: [{ name: "x", content: "y" }] }],
  ])("refuses %s", (_label, file) => {
    expect(fromSillyTavern(file, "X", options)).toEqual({ ok: false, reason: "not_a_preset" });
  });

  it("refuses a prompt longer than Ephemera allows", () => {
    const prompts = stPreset().prompts.map((prompt) =>
      prompt.identifier === "main" ? { ...prompt, content: "x".repeat(256 * 1024 + 1) } : prompt,
    );
    expect(fromSillyTavern(stPreset({ prompts }), "X", options)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("keeps imported text as text: markup is not interpreted", () => {
    const hostile = '<img src=x onerror="alert(1)"> {{char}}';
    const prompts = stPreset().prompts.map((prompt) =>
      prompt.identifier === "main" ? { ...prompt, content: hostile } : prompt,
    );
    const result = fromSillyTavern(stPreset({ prompts }), "<b>x</b>", options);
    expect(result.ok && result.prompt.blocks[0]).toMatchObject({ content: hostile });
    expect(result.ok && result.prompt.name).toBe("<b>x</b>");
  });
});

describe("hostile keys", () => {
  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "treats %s as an unknown effort or prompt, never as a table entry",
    (key) => {
      const result = fromSillyTavern(
        stPreset({
          reasoning_effort: key,
          prompts: [
            ...stPreset().prompts,
            { identifier: key, name: "Odd", role: "system", content: "x" },
          ],
          prompt_order: [
            {
              character_id: SILLYTAVERN_ORDER_ID,
              order: [
                ...(stPreset().prompt_order[1]?.order ?? []),
                { identifier: key, enabled: true },
              ],
            },
          ],
        }),
        "N",
        options,
      );
      if (!result.ok) throw new Error(result.reason);
      expect(result.sampler.values.reasoning).toBe("provider-default");
      expect(result.report.skipped.join("\n")).toMatch(/Reasoning: outside/);
      expect(
        result.prompt.blocks.some((block) => block.kind === "custom" && block.name === "Odd"),
      ).toBe(true);
    },
  );
});
