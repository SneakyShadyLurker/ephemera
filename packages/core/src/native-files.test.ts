import { describe, expect, it } from "vitest";
import {
  blankCard,
  characterCardSchema,
  characterPatchRequestSchema,
  storedCharacterCardSchema,
  upgradeLegacyCharacterCard,
  upgradeLegacyLorebook,
} from "./card/index.ts";
import { CARD_LIMITS } from "./card/limits.ts";
import { emptyCastAnchor, emptyCastState } from "./cast/register.ts";
import { isNativeFileAttempt } from "./file-format.ts";
import { normalizeMacroAliases } from "./imports/aliases.ts";
import { upgradeLegacyPromptPreset } from "./imports/prompt-upgrade.ts";
import {
  lorebookFieldsSchema,
  lorebookPatchRequestSchema,
  storedLorebookSchema,
} from "./lorebook/stored.ts";
import { importWorldInfo } from "./lorebook/worldinfo.ts";
import {
  parseNativeFileText,
  toCharacterFile,
  toLorebookFile,
  toPromptPresetFile,
  toSamplerPresetFile,
} from "./native-files.ts";
import { DEFAULT_MAIN_PROMPT } from "./preset/defaults.ts";
import {
  defaultPromptPreset,
  PRESET_LIMITS,
  type PromptBlock,
  promptPresetPatchRequestSchema,
  promptPresetSchema,
  SOURCE_BLOCKS,
  storedPromptPresetDataSchema,
} from "./preset/prompt.ts";
import { defaultSamplerPreset } from "./preset/sampler.ts";
import { fromSillyTavern, importPresetFile } from "./preset/sillytavern.ts";
import { type AssemblyInput, assemblePrompt, flatten } from "./prompt/assemble.ts";
import { EXAMPLE_SEPARATOR } from "./prompt/examples.ts";

const options = { newId: () => "00000000-0000-4000-8000-000000000001", models: undefined };
const input = (): AssemblyInput => ({
  preset: defaultPromptPreset(),
  character: {
    ...blankCard("Mara"),
    description: "Description.",
    personality: "Patient.",
    scenario: "Rain.",
    exampleDialogue: "Narration.\nPlayer: Hi.\nMara: Hello.",
    lorebook: {
      entries: [
        {
          keys: [],
          constant: true,
          content: "The lamp is lit.",
          enabled: true,
          insertionOrder: 1,
          useRegex: false,
        },
      ],
    },
  },
  persona: { name: "Player", description: "A traveler." },
  history: [{ role: "user", content: "Hi." }],
  clock: { now: 0, timeZone: "UTC" },
  pickSeed: 0,
  random: () => 0,
  cast: {
    entries: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        role: "principal",
        anchor: emptyCastAnchor("Ilse", "female"),
        aka: [],
        state: emptyCastState(true),
      },
    ],
  },
  lorebook: { window: 100_000, count: (text) => text.length },
});

describe("native file contracts", () => {
  it("round-trips each independent envelope and keeps preset prose", () => {
    for (const packet of [
      toCharacterFile(blankCard("Mara")),
      toLorebookFile({ entries: [] }),
      toPromptPresetFile(defaultPromptPreset()),
      toSamplerPresetFile(defaultSamplerPreset()),
    ]) {
      expect(parseNativeFileText(JSON.stringify(packet))).toEqual(packet);
      expect(packet).not.toHaveProperty("id");
    }
    expect(defaultPromptPreset().blocks[0]).toMatchObject({ content: DEFAULT_MAIN_PROMPT });
    expect(
      importPresetFile(toPromptPresetFile(defaultPromptPreset()), "Ignored", options),
    ).toMatchObject({ ok: true, format: "prompt" });
    expect(
      importPresetFile(toSamplerPresetFile(defaultSamplerPreset()), "Ignored", options),
    ).toMatchObject({ ok: true, format: "sampler" });
  });
  it.each([null, "", "unknown", "ephemera.character"])(
    "reserves any own format marker %j across imports",
    (format) => {
      const foreign = {
        format,
        prompts: [],
        entries: [],
        name: "Mara",
        description: "x",
        version: 1,
      };
      expect(isNativeFileAttempt(foreign)).toBe(true);
      expect(fromSillyTavern(foreign, "Preset", options).ok).toBe(false);
      expect(importPresetFile(foreign, "Preset", options).ok).toBe(false);
      expect(importWorldInfo(foreign).ok).toBe(false);
    },
  );
  it("distinguishes own markers, recognized foreign specs, unsupported versions and mixed shapes", () => {
    expect(isNativeFileAttempt({ version: 2 })).toBe(true);
    expect(isNativeFileAttempt({ version: 2, spec: "chara_card_v2" })).toBe(false);
    expect(isNativeFileAttempt(Object.create({ format: "bad", version: 2 }))).toBe(false);
    for (const packet of [
      { ...toCharacterFile(blankCard("Mara")), version: 2 },
      { ...toPromptPresetFile(defaultPromptPreset()), prompts: [] },
      { ...toLorebookFile({ entries: [] }), spec: "chara_card_v3" },
      {
        ...toSamplerPresetFile(defaultSamplerPreset()),
        data: { ...defaultSamplerPreset(), id: "forbidden" },
      },
    ])
      expect(() => parseNativeFileText(JSON.stringify(packet))).toThrow();
  });
  it("keeps oversized stored books and presets readable without public file validation", () => {
    const content = "x".repeat(CARD_LIMITS.textLength);
    const book = upgradeLegacyLorebook({
      entries: Array.from({ length: 40 }, (_, id) => ({
        id,
        keys: [],
        content,
        insertion_order: id,
        extensions: {},
      })),
    });
    expect(book.entries[39]?.content).toBe(content);
    expect(() => toLorebookFile(book)).toThrow();
    const preset = legacyPreset();
    preset.blocks.push(...Array.from({ length: 40 }, (_, index) => custom(index, content)));
    const upgraded = upgradeLegacyPromptPreset(preset);
    expect(upgraded.blocks.filter((block) => block.kind === "custom")).toHaveLength(40);
    expect(() => toPromptPresetFile(upgraded)).toThrow();
  });
});

const custom = (index: number, content = `Instruction ${index}`) => ({
  kind: "custom" as const,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: "Custom",
  role: "system" as const,
  depth: null,
  content,
  enabled: true,
});
function legacyPreset() {
  const { actions, ...preset } = defaultPromptPreset();
  return {
    ...preset,
    blocks: preset.blocks.filter((block) => block.kind !== "custom") as PromptBlock[],
    formats: {
      personality: "{{personality}}",
      scenario: "{{scenario}}",
      persona: "{{persona}}",
      lorebook: "{0}",
      newChat: "[Start a new Chat]",
      newExampleChat: "[Example Chat]",
      continueNudge: actions.continue,
      impersonation: actions.writeForMe,
    },
  };
}

describe("pure saved-data upgrades", () => {
  it("upgrades separators only in example-placed embedded and library entries", () => {
    const positions = [undefined, 0, 1, 2, 3, 4, 5, 6, 7];
    const oldBook = {
      entries: positions.map((position) => ({
        keys: [],
        content: "@@depth 4\nPassage.<START><BOT>: Hi <USER>.",
        extensions: position === undefined ? {} : { position },
      })),
    };
    const book = upgradeLegacyLorebook(oldBook);
    const card = upgradeLegacyCharacterCard({ name: "Mara", character_book: oldBook });
    const literal = "Passage.<START>{{char}}: Hi {{user}}.";
    const example = `Passage.${EXAMPLE_SEPARATOR}{{char}}: Hi {{user}}.`;
    expect(book.entries.map((entry) => entry.content)).toEqual([
      literal,
      literal,
      literal,
      literal,
      literal,
      literal,
      example,
      example,
      literal,
    ]);
    expect(card.lorebook).toEqual(book);
    expect(upgradeLegacyLorebook(book)).toEqual(book);
    expect(upgradeLegacyCharacterCard(card)).toEqual(card);
  });

  it("keeps every converted card text field at its former bound readable while public writes and files reject it", () => {
    const oldText = `<BOT>${"x".repeat(CARD_LIMITS.textLength - 5)}`;
    const converted = `{{char}}${"x".repeat(CARD_LIMITS.textLength - 5)}`;
    const fields = [
      ["description", "description"],
      ["personality", "personality"],
      ["scenario", "scenario"],
      ["first_mes", "firstMessage"],
      ["mes_example", "exampleDialogue"],
      ["system_prompt", "systemPrompt"],
      ["post_history_instructions", "postHistoryInstructions"],
    ] as const;
    for (const [oldField, field] of fields) {
      const card = upgradeLegacyCharacterCard({ name: "Mara", [oldField]: oldText });
      expect(card[field]).toBe(converted);
      expect(storedCharacterCardSchema.parse(card)).toEqual(card);
      expect(upgradeLegacyCharacterCard(card)).toEqual(card);
      expect(characterCardSchema.safeParse(card).success).toBe(false);
      expect(
        characterPatchRequestSchema.safeParse({ [field]: converted, revision: 1 }).success,
      ).toBe(false);
      expect(() => toCharacterFile(card)).toThrow();
      expect(() =>
        parseNativeFileText(
          JSON.stringify({ format: "ephemera.character", version: 1, data: card }),
        ),
      ).toThrow();
      expect(characterCardSchema.safeParse({ ...card, [field]: "Reduced" }).success).toBe(true);
    }
    const card = upgradeLegacyCharacterCard({
      name: "Mara",
      alternate_greetings: [oldText],
      extensions: { depth_prompt: { prompt: oldText } },
    });
    expect(card.alternateGreetings).toEqual([converted]);
    expect(card.characterNote?.prompt).toBe(converted);
    expect(
      characterPatchRequestSchema.safeParse({ alternateGreetings: [converted], revision: 1 })
        .success,
    ).toBe(false);
    expect(() => toCharacterFile(card)).toThrow();
  });

  it("preserves widened embedded and library entry content and keywords without widening public books", () => {
    const content = `<BOT>${"x".repeat(CARD_LIMITS.textLength - 5)}`;
    const key = `<BOT>${"k".repeat(CARD_LIMITS.shortTextLength - 5)}`;
    const oldBook = { entries: [{ keys: [key], secondary_keys: [key], content, extensions: {} }] };
    const book = upgradeLegacyLorebook(oldBook);
    expect(book.entries[0]).toMatchObject({
      content: `{{char}}${content.slice(5)}`,
      keys: [`{{char}}${key.slice(5)}`],
      secondaryKeys: [`{{char}}${key.slice(5)}`],
    });
    expect(upgradeLegacyLorebook(book)).toEqual(book);
    expect(
      storedLorebookSchema.parse({
        id: options.newId(),
        name: "Book",
        book,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }).book,
    ).toEqual(book);
    expect(upgradeLegacyCharacterCard({ name: "Mara", character_book: oldBook }).lorebook).toEqual(
      book,
    );
    expect(lorebookFieldsSchema.safeParse({ name: "Book", book }).success).toBe(false);
    expect(lorebookPatchRequestSchema.safeParse({ book, revision: 1 }).success).toBe(false);
    expect(characterPatchRequestSchema.safeParse({ lorebook: book, revision: 1 }).success).toBe(
      false,
    );
    expect(() => toLorebookFile(book)).toThrow();
    expect(() => toCharacterFile({ ...blankCard("Mara"), lorebook: book })).toThrow();
    expect(importWorldInfo({ format: "ephemera.lorebook", version: 1, data: book }).ok).toBe(false);
    expect(importWorldInfo(oldBook).ok).toBe(false);
  });

  it.each(["block", "fixedWrapper", "template", "continue", "writeForMe", "authorsNote"] as const)(
    "preserves converted prompt %s past its former field bound while keeping public bounds",
    (field) => {
      const oldText = `<BOT>${"x".repeat(PRESET_LIMITS.blockText - 5)}`;
      const converted = `{{char}}${oldText.slice(5)}`;
      const preset = legacyPreset();
      if (field === "block") preset.blocks.push(custom(1, oldText));
      if (field === "fixedWrapper") preset.formats.personality = oldText;
      if (field === "template")
        preset.formats.lorebook = `{0}${"x".repeat(PRESET_LIMITS.blockText - 3)}`;
      if (field === "continue") preset.formats.continueNudge = oldText;
      if (field === "writeForMe") preset.formats.impersonation = oldText;
      if (field === "authorsNote") preset.authorsNote.text = oldText;
      const upgraded = upgradeLegacyPromptPreset(preset);
      if (field === "block" || field === "fixedWrapper")
        expect(upgraded.blocks).toContainEqual(
          expect.objectContaining({ kind: "custom", content: converted }),
        );
      if (field === "template")
        expect(upgraded.blocks.find((b) => b.id === "lorebookBefore")).toMatchObject({
          template: `{{content}}${"x".repeat(PRESET_LIMITS.blockText - 3)}`,
        });
      if (field === "continue" || field === "writeForMe")
        expect(upgraded.actions[field]).toBe(converted);
      if (field === "authorsNote") expect(upgraded.authorsNote.text).toBe(converted);
      expect(storedPromptPresetDataSchema.parse(upgraded)).toEqual(upgraded);
      expect(upgradeLegacyPromptPreset(upgraded)).toEqual(upgraded);
      expect(promptPresetSchema.safeParse(upgraded).success).toBe(false);
      expect(
        promptPresetPatchRequestSchema.safeParse({
          blocks: upgraded.blocks,
          actions: upgraded.actions,
          authorsNote: upgraded.authorsNote,
          revision: 1,
        }).success,
      ).toBe(false);
      expect(() => toPromptPresetFile(upgraded)).toThrow();
      expect(() =>
        parseNativeFileText(
          JSON.stringify({ format: "ephemera.prompt-preset", version: 1, data: upgraded }),
        ),
      ).toThrow();
    },
  );
  it("preserves recognized legacy pool names beyond former text editor limits", () => {
    const name = "n".repeat(CARD_LIMITS.textLength + 1);
    const book = upgradeLegacyLorebook({
      entries: [{ keys: [], content: "Rain.", extensions: { group: name } }],
    });
    expect(book.entries[0]?.settings?.poolNames).toEqual([name]);
    expect(upgradeLegacyLorebook(book)).toEqual(book);
  });
  it("omits sources for empty old personality/scenario wrappers while persona and lorebook stay bare", () => {
    const preset = legacyPreset();
    preset.blocks = preset.blocks.map((block) =>
      block.kind === "source" ? { kind: "source", id: block.id, enabled: true } : block,
    );
    preset.formats = {
      ...preset.formats,
      personality: "",
      scenario: "",
      persona: "",
      lorebook: "",
    };
    const report = { kept: [], changed: [] as string[], skipped: [] };
    const upgraded = upgradeLegacyPromptPreset(preset, report);
    const messages = flatten(assemblePrompt({ ...input(), preset: upgraded }));
    expect(messages.some((message) => ["Patient.", "Rain."].includes(message.content))).toBe(false);
    expect(messages.map((message) => message.content)).toEqual(
      expect.arrayContaining(["A traveler.", "The lamp is lit."]),
    );
    for (const id of ["charPersonality", "scenario"])
      expect(upgraded.blocks.find((block) => block.id === id)).toMatchObject({ enabled: false });
    for (const id of ["personaDescription", "lorebookBefore", "lorebookAfter"])
      expect(upgraded.blocks.find((block) => block.id === id)).toEqual({
        kind: "source",
        id,
        enabled: true,
      });
    expect(report.changed).toEqual([
      "The empty personality wrapper disabled its source block.",
      "The empty scenario wrapper disabled its source block.",
    ]);
    const repeatedReport = { kept: [], changed: [], skipped: [] };
    expect(upgradeLegacyPromptPreset(upgraded, repeatedReport)).toEqual(upgraded);
    expect(repeatedReport.changed).toEqual([]);
    const absent = upgradeLegacyPromptPreset({
      ...preset,
      formats: { ...preset.formats, personality: undefined, scenario: undefined },
    });
    for (const id of ["charPersonality", "scenario"])
      expect(absent.blocks.find((block) => block.id === id)).toMatchObject({ enabled: true });
    const native = defaultPromptPreset();
    native.blocks = native.blocks.map((block) =>
      block.kind === "source" ? { ...block, template: "" } : block,
    );
    expect(upgradeLegacyPromptPreset(native)).toEqual(native);
  });
  it.each([100, 121])(
    "preserves all %i old custom blocks plus fixed and scene wrapper instructions",
    (count) => {
      const preset = legacyPreset();
      preset.blocks.push(...Array.from({ length: count }, (_, index) => custom(index)));
      preset.formats = {
        ...preset.formats,
        personality: "Fixed personality instruction.",
        scenario: "Fixed scenario instruction.",
        persona: "Fixed persona instruction.",
        lorebook: "Fixed lore instruction.",
        newChat: "Begin at midnight.",
        newExampleChat: "Follow the style shown below.",
      };
      const report = { kept: [], changed: [] as string[], skipped: [] };
      const upgraded = upgradeLegacyPromptPreset(preset, report);
      const customs = upgraded.blocks.filter((block) => block.kind === "custom");
      expect(customs).toHaveLength(count + 7);
      expect(PRESET_LIMITS.customBlocks).toBe(128);
      for (let index = 0; index < count; index++) expect(customs).toContainEqual(custom(index));
      expect(upgraded.blocks.find((block) => block.id === "charPersonality")).toMatchObject({
        enabled: false,
      });
      expect(report.changed).toHaveLength(7);
      expect(upgradeLegacyPromptPreset(preset)).toEqual(upgraded);
      expect(upgradeLegacyPromptPreset(upgraded)).toEqual(upgraded);
    },
  );
  it("converts placeholders and macro aliases while preserving literal metadata", () => {
    const preset = legacyPreset();
    preset.formats.personality = "[<BOT>: {{personality}}]";
    const upgraded = upgradeLegacyPromptPreset(preset);
    expect(upgraded.blocks.find((block) => block.id === "charPersonality")).toMatchObject({
      template: "[{{char}}: {{content}}]",
    });
    expect(upgraded.blocks.some((block) => block.kind === "custom")).toBe(false);
    const card = upgradeLegacyCharacterCard({
      name: "<BOT>",
      creator_notes: "<BOT>",
      creator: "<USER>",
      description: "<BOT> meets <USER>.",
      first_mes: "{{mesExamplesRaw}}",
    });
    expect(card).toMatchObject({
      name: "<BOT>",
      creatorNotes: "<BOT>",
      creator: "<USER>",
      description: "{{char}} meets {{user}}.",
      firstMessage: "{{exampleDialogue}}",
    });
    expect(upgradeLegacyCharacterCard(card)).toEqual(card);
    expect(characterCardSchema.parse(card)).toEqual(card);
    expect(
      normalizeMacroAliases("<BOT> {{group}} {{charPrompt}} {{mesExamples}} {{hasExtension::x}}"),
    ).toBe("{{char}} {{char}} {{characterSystemPrompt}} {{exampleDialogue}} false");
    expect(normalizeMacroAliases(normalizeMacroAliases("<BOT>"))).toBe("{{char}}");
  });
});

describe("source templates and native actions", () => {
  it.each(SOURCE_BLOCKS)("validates every source's optional template: %s", (id) => {
    const preset = defaultPromptPreset();
    const withTemplate = (template: string) => ({
      ...preset,
      blocks: preset.blocks.map((block) =>
        block.kind === "source" && block.id === id ? { ...block, template } : block,
      ),
    });
    expect(promptPresetSchema.safeParse(withTemplate("")).success).toBe(true);
    expect(promptPresetSchema.safeParse(withTemplate("[{{content}}]")).success).toBe(true);
    expect(promptPresetSchema.safeParse(withTemplate("[{{description}}]")).success).toBe(false);
  });
  it("wraps examples, cast and lorebook data and emits no wrapper for empty sources", () => {
    const value = input();
    value.preset.blocks = value.preset.blocks.map((block) =>
      block.kind === "source" ? { ...block, template: "SOURCE[{{content}}]" } : block,
    );
    const messages = flatten(assemblePrompt(value));
    expect(messages.find((message) => message.source.kind === "example")?.content).toBe(
      "SOURCE[Narration.\nPlayer: Hi.\nMara: Hello.]",
    );
    expect(messages.find((message) => message.source.kind === "lorebook")?.content).toBe(
      "SOURCE[The lamp is lit.]",
    );
    expect(
      messages.find(
        (message) => message.source.kind === "block" && message.source.id === "castAnchors",
      )?.content,
    ).toMatch(/^SOURCE\[/);
    const empty = flatten(
      assemblePrompt({
        ...value,
        character: blankCard("Mara"),
        cast: { entries: [] },
        persona: null,
      }),
    );
    expect(empty.some((message) => message.content.includes("SOURCE["))).toBe(false);
  });
  it.each(["continue", "impersonate"] as const)(
    "sends no extra instruction for an empty %s action",
    (mode) => {
      const value = input();
      value.preset.actions = { continue: "", writeForMe: "" };
      value.history.push({ role: "assistant", content: "The storm" });
      const messages = flatten(assemblePrompt({ ...value, mode }));
      expect(messages.some((message) => message.source.kind === "instruction")).toBe(false);
      expect(messages.filter((message) => message.source.kind === "history").at(-1)?.content).toBe(
        "The storm",
      );
      expect(messages.every((message) => !("name" in message))).toBe(true);
    },
  );
});

describe("public native write boundaries", () => {
  it("keeps stored card and book shapes and collection bounds strict", () => {
    for (const invalid of [
      { description: 42 },
      { name: "" },
      { nickname: "x".repeat(CARD_LIMITS.shortTextLength + 1) },
      { alternateGreetings: Array(CARD_LIMITS.alternateGreetings + 1).fill("") },
      { characterNote: { prompt: "Text", depth: PRESET_LIMITS.maxDepth + 1, role: "user" } },
      { lorebook: { entries: Array(CARD_LIMITS.lorebookEntries + 1).fill({}) } },
      { unknown: true },
    ])
      expect(
        storedCharacterCardSchema.safeParse({ ...blankCard("Mara"), ...invalid }).success,
      ).toBe(false);
    const stored = { id: options.newId(), name: "Book", revision: 1, createdAt: 1, updatedAt: 1 };
    const entry = { keys: [], content: "Text", enabled: true, insertionOrder: 1, useRegex: false };
    for (const invalid of [
      { content: 42 },
      { keys: Array(CARD_LIMITS.tags + 1).fill("key") },
      { secondaryKeys: Array(CARD_LIMITS.tags + 1).fill("key") },
      { settings: { probability: 101 } },
      { settings: { role: "unknown" } },
      { unknown: true },
    ])
      expect(
        storedLorebookSchema.safeParse({ ...stored, book: { entries: [{ ...entry, ...invalid }] } })
          .success,
      ).toBe(false);
  });
  it("keeps stored prompt placement, identities, template syntax and work bounds strict", () => {
    const preset = defaultPromptPreset();
    for (const invalid of [
      { content: 42 },
      { id: "unknown" },
      { role: "unknown" },
      { depth: PRESET_LIMITS.maxDepth + 1 },
      { order: PRESET_LIMITS.maxOrder + 1 },
      { triggers: ["unknown"] },
      { unknown: true },
    ])
      expect(
        storedPromptPresetDataSchema.safeParse({
          ...preset,
          blocks: preset.blocks.map((block) =>
            block.id === "main" ? { ...block, ...invalid } : block,
          ),
        }).success,
      ).toBe(false);
    expect(
      storedPromptPresetDataSchema.safeParse({
        ...preset,
        blocks: preset.blocks.filter((block) => block.id !== "main"),
      }).success,
    ).toBe(false);
    expect(
      storedPromptPresetDataSchema.safeParse({
        ...preset,
        blocks: [
          ...preset.blocks,
          ...Array.from({ length: PRESET_LIMITS.customBlocks }, (_, i) => custom(i)),
        ],
      }).success,
    ).toBe(false);
    expect(
      storedPromptPresetDataSchema.safeParse({
        ...preset,
        blocks: preset.blocks.map((block) =>
          block.kind === "source" ? { ...block, template: "Missing placeholder" } : block,
        ),
      }).success,
    ).toBe(false);
  });
  it("counts the native envelope and UTF-8 at the exact whole-card limit", () => {
    const card = {
      ...blankCard("Mara"),
      characterNote: { prompt: "", depth: 1, role: "system" as const },
    };
    const packet = { format: "ephemera.character", version: 1, data: card };
    const size = (text: string) => new TextEncoder().encode(text).byteLength;
    const room = CARD_LIMITS.cardJsonBytes - size(JSON.stringify(packet));
    card.characterNote.prompt = "語".repeat(Math.floor(room / 3)) + "x".repeat(room % 3);
    expect(size(JSON.stringify(packet))).toBe(CARD_LIMITS.cardJsonBytes);
    expect(parseNativeFileText(JSON.stringify(toCharacterFile(card)))).toEqual(packet);
    card.characterNote.prompt += "x";
    expect(() => toCharacterFile(card)).toThrow();
  });
  it("enforces meaningful field bounds including Unicode and array capacity", () => {
    const card = blankCard("Mara");
    for (const key of [
      "description",
      "personality",
      "scenario",
      "firstMessage",
      "exampleDialogue",
      "systemPrompt",
      "postHistoryInstructions",
      "creatorNotes",
    ] as const) {
      expect(
        characterCardSchema.safeParse({ ...card, [key]: "語".repeat(CARD_LIMITS.textLength) })
          .success,
      ).toBe(true);
      expect(
        characterCardSchema.safeParse({ ...card, [key]: "x".repeat(CARD_LIMITS.textLength + 1) })
          .success,
      ).toBe(false);
    }
    expect(
      characterCardSchema.safeParse({
        ...card,
        alternateGreetings: Array(CARD_LIMITS.alternateGreetings + 1).fill(""),
      }).success,
    ).toBe(false);
    expect(
      characterCardSchema.safeParse({ ...card, tags: ["x".repeat(CARD_LIMITS.tagLength + 1)] })
        .success,
    ).toBe(false);
  });
});
