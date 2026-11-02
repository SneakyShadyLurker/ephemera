import { describe, expect, it } from "vitest";
import { plainPromptPreset } from "../../test-fixtures/preset.ts";
import { uuid } from "../../test-fixtures/uuid.ts";
import {
  DEFAULT_FORMAT_PROMPT,
  DEFAULT_MAIN_PROMPT,
  DEFAULT_NOTE_PROMPT,
  DEFAULT_NPC_PROMPT,
  DEFAULT_WORLD_PROMPT,
} from "./defaults.ts";
import { withoutHighlights } from "./highlight.ts";
import {
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  defaultSamplerPreset,
  HIGHLIGHT_TONES,
  opensCue,
  PRESET_LIMITS,
  type PromptBlock,
  promptPresetPatchRequestSchema,
  promptPresetSchema,
  SAMPLER_RANGES,
  samplerPresetSchema,
  splitCue,
  THOUGHT_MARK,
} from "./index.ts";

const custom = (
  overrides: Partial<Extract<PromptBlock, { kind: "custom" }>> = {},
): PromptBlock => ({
  kind: "custom",
  id: uuid(),
  name: "Tone",
  role: "system",
  content: "Keep the pace slow.",
  enabled: true,
  depth: null,
  ...overrides,
});

describe("prompt presets", () => {
  it("accepts the built-in default, each built-in block once, chat history included", () => {
    const preset = defaultPromptPreset();
    expect(promptPresetSchema.parse(preset)).toEqual(preset);
    const ids = preset.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("chatHistory");
    expect(ids.indexOf("main")).toBeLessThan(ids.indexOf("chatHistory"));
    expect(ids.indexOf("postHistory")).toBeGreaterThan(ids.indexOf("chatHistory"));
  });

  it("accepts custom blocks with a role and an optional in-chat depth", () => {
    const preset = defaultPromptPreset();
    const blocks = [...preset.blocks, custom(), custom({ role: "user", depth: 0 })];
    expect(promptPresetSchema.safeParse({ ...preset, blocks }).success).toBe(true);
  });

  it("rejects a missing or repeated built-in block", () => {
    const preset = defaultPromptPreset();
    const withoutHistory = preset.blocks.filter((block) => block.id !== "chatHistory");
    expect(promptPresetSchema.safeParse({ ...preset, blocks: withoutHistory }).success).toBe(false);
    const main = preset.blocks.find((block) => block.id === "main");
    expect(
      promptPresetSchema.safeParse({ ...preset, blocks: [...preset.blocks, main] }).success,
    ).toBe(false);
  });

  it("accepts a preset without the cast block, stored before it, but not with it twice", () => {
    const preset = defaultPromptPreset();
    const without = preset.blocks.filter((block) => block.id !== "castAnchors");
    expect(promptPresetSchema.safeParse({ ...preset, blocks: without }).success).toBe(true);
    const cast = preset.blocks.find((block) => block.id === "castAnchors");
    expect(
      promptPresetSchema.safeParse({ ...preset, blocks: [...preset.blocks, cast] }).success,
    ).toBe(false);
  });

  it("rejects repeated custom ids, depths out of range and unknown keys", () => {
    const preset = defaultPromptPreset();
    const block = custom();
    const reject = (blocks: unknown[]) =>
      expect(
        promptPresetSchema.safeParse({ ...preset, blocks: [...preset.blocks, ...blocks] }).success,
      ).toBe(false);
    reject([block, block]);
    reject([custom({ depth: -1 })]);
    reject([custom({ depth: PRESET_LIMITS.maxDepth + 1 })]);
    reject([custom({ depth: 1.5 })]);
    reject([{ ...custom(), extra: true }]);
    reject([custom({ role: "tool" as never })]);
  });

  it("limits custom blocks, names and text", () => {
    // No custom blocks of its own, so the count below is exactly one over the limit.
    const preset = plainPromptPreset();
    const many = Array.from({ length: PRESET_LIMITS.customBlocks + 1 }, () => custom());
    expect(
      promptPresetSchema.safeParse({ ...preset, blocks: [...preset.blocks, ...many] }).success,
    ).toBe(false);
    expect(promptPresetSchema.safeParse({ ...preset, name: " " }).success).toBe(false);
    expect(
      promptPresetSchema.safeParse({
        ...preset,
        blocks: [...preset.blocks, custom({ content: "x".repeat(PRESET_LIMITS.blockText + 1) })],
      }).success,
    ).toBe(false);
  });
});

describe("sampler presets", () => {
  it("defaults override nothing that is sent", () => {
    const preset = defaultSamplerPreset();
    expect(samplerPresetSchema.parse(preset)).toEqual(preset);
    const { reasoning, ...sent } = preset.values;
    expect(Object.values(sent).every((value) => value === null)).toBe(true);
    expect(reasoning).toBe("provider-default");
  });

  it("has no context size: the window is the model's own", () => {
    const { values } = defaultSamplerPreset();
    expect(
      samplerPresetSchema.safeParse({ name: "P", values: { ...values, contextSize: 32_768 } })
        .success,
    ).toBe(false);
  });

  it("accepts values inside every range and rejects values outside", () => {
    const { values } = defaultSamplerPreset();
    const accepts = (change: object) =>
      samplerPresetSchema.safeParse({ name: "P", values: { ...values, ...change } }).success;
    for (const [key, range] of Object.entries(SAMPLER_RANGES)) {
      expect(accepts({ [key]: range.min }), `${key} min`).toBe(true);
      expect(accepts({ [key]: range.max }), `${key} max`).toBe(true);
      expect(accepts({ [key]: range.min - 1 }), `${key} below`).toBe(false);
      expect(accepts({ [key]: range.max + 1 }), `${key} above`).toBe(false);
    }
    expect(accepts({ maxOutputTokens: 1.5 })).toBe(false);
    expect(accepts({ seed: 2.5 })).toBe(false);
    expect(accepts({ reasoning: "extreme" })).toBe(false);
    expect(accepts({ model: "" })).toBe(false);
    expect(accepts({ stream: true })).toBe(false);
  });
});

describe("prompt preset reasoning", () => {
  it("defaults to reading nothing out of replies and sending no reasoning back", () => {
    expect(defaultPromptPreset().reasoning).toEqual({
      autoParse: false,
      tag: "think",
      addToPrompts: false,
      maxAdditions: 1,
    });
  });

  it.each([
    ["an empty tag", { tag: "" }],
    ["a tag with markup", { tag: "think><script" }],
    ["no additions", { maxAdditions: 0 }],
    ["an unknown option", { prefix: "<t>" }],
  ])("rejects %s", (_label, change) => {
    const preset = defaultPromptPreset();
    expect(
      promptPresetSchema.safeParse({ ...preset, reasoning: { ...preset.reasoning, ...change } })
        .success,
    ).toBe(false);
  });
});

describe("prompt preset Author's Note", () => {
  const { authorsNote: _note, ...withoutNote } = defaultPromptPreset();

  it("reads as the default note, on, in the chat at depth 1 as the user, when a preset has none", () => {
    const first = promptPresetSchema.parse(withoutNote);
    expect(first.authorsNote).toEqual({
      enabled: true,
      text: DEFAULT_NOTE_PROMPT,
      position: "inChat",
      depth: 1,
      role: "user",
      frequency: 1,
    });
    expect(first.authorsNote).toEqual(DEFAULT_AUTHORS_NOTE);
    const second = promptPresetSchema.parse(withoutNote);
    expect(second.authorsNote).not.toBe(first.authorsNote);
    expect(first.authorsNote).not.toBe(DEFAULT_AUTHORS_NOTE);
  });

  it("is the default preset's note, which reads {{user}} rather than a name", () => {
    expect(defaultPromptPreset().authorsNote).toEqual(DEFAULT_AUTHORS_NOTE);
    expect(DEFAULT_NOTE_PROMPT).toContain("{{user}}");
  });

  it("is not added to a patch that leaves it out", () => {
    const patch = promptPresetPatchRequestSchema.parse({ name: "Renamed", revision: 1 });
    expect(patch).not.toHaveProperty("authorsNote");
    expect(
      promptPresetPatchRequestSchema.parse({
        authorsNote: { ...DEFAULT_AUTHORS_NOTE, enabled: false },
        revision: 1,
      }).authorsNote?.enabled,
    ).toBe(false);
  });

  it.each([
    [
      "no switch",
      (() => {
        const { enabled: _enabled, ...note } = DEFAULT_AUTHORS_NOTE;
        return note;
      })(),
    ],
    ["an unknown key", { ...DEFAULT_AUTHORS_NOTE, extra: true }],
    ["a negative depth", { ...DEFAULT_AUTHORS_NOTE, depth: -1 }],
    ["a fractional frequency", { ...DEFAULT_AUTHORS_NOTE, frequency: 1.5 }],
    ["an unknown role", { ...DEFAULT_AUTHORS_NOTE, role: "narrator" }],
    ["an unknown position", { ...DEFAULT_AUTHORS_NOTE, position: "afterScenario" }],
    ["oversized text", { ...DEFAULT_AUTHORS_NOTE, text: "x".repeat(PRESET_LIMITS.blockText + 1) }],
  ])("rejects %s", (_label, authorsNote) => {
    expect(promptPresetSchema.safeParse({ ...withoutNote, authorsNote }).success).toBe(false);
    expect(promptPresetPatchRequestSchema.safeParse({ authorsNote, revision: 1 }).success).toBe(
      false,
    );
  });
});

describe("default prompt preset highlights", () => {
  it("name only highlight tones the chat renders", () => {
    const text = defaultPromptPreset()
      .blocks.map((block) => ("content" in block ? block.content : ""))
      .join("\n");
    const names = [...text.matchAll(/:([a-z]+)\[/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect([...HIGHLIGHT_TONES, THOUGHT_MARK]).toContain(name);
  });

  it("writes the scene so every prefixed line opens with a cue and narration is unmarked", () => {
    const scene =
      DEFAULT_FORMAT_PROMPT.split("\n\nHighlights:")[0]?.split("in this shape:\n")[1] ?? "";
    const lines = scene.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(4);
    const [narration, ...prefixed] = lines;
    expect(splitCue(narration ?? "")).toBeNull();
    for (const line of prefixed) expect(splitCue(line)).toMatchObject({ cue: "Kate (25)" });
    expect(DEFAULT_FORMAT_PROMPT).not.toContain(":mist[");
  });

  it("leave the cast to the register: no present block, sexual actions still marked", () => {
    expect(DEFAULT_FORMAT_PROMPT).not.toContain("present:");
    expect(DEFAULT_FORMAT_PROMPT).not.toContain("Intimate body");
    expect(DEFAULT_FORMAT_PROMPT).toContain(
      "- :rose[...] marks every sexual action, in action lines and narration",
    );
    expect(DEFAULT_NPC_PROMPT).toContain(
      "The cast register is every NPC's record: <cast> holds their fixed details and the Cast now line their current state.",
    );
    expect(DEFAULT_NPC_PROMPT).not.toContain("present block");
  });

  it("show a dressed body through its clothes, which may mislead until undressing", () => {
    expect(DEFAULT_MAIN_PROMPT).toContain("a dressed body shows only what its clothes let through");
    expect(DEFAULT_WORLD_PROMPT).toContain("Dressed, a body is what its outfit makes of it.");
    expect(DEFAULT_WORLD_PROMPT).toContain("Clothes can lie");
    expect(DEFAULT_WORLD_PROMPT).toContain("let undressing confirm or overturn the guess");
    expect(DEFAULT_WORLD_PROMPT).toContain("unless a bra, binder or tight top holds them");
    expect(DEFAULT_NPC_PROMPT).toContain(
      "how they dress their figure (what they hide, flatter or fake)",
    );
  });
});

describe("default prompt preset scenarios", () => {
  it("has the game master invent a Scenario's people, from Setting on a card saved before People", () => {
    expect(DEFAULT_MAIN_PROMPT).toContain(
      "Invent everyone else as play needs them, from <People>, or from <Setting> on a card without it.",
    );
    expect(DEFAULT_MAIN_PROMPT).not.toContain("forces in motion and cast");
    expect(DEFAULT_NPC_PROMPT).not.toContain("scenario cast");
  });
});

describe("default prompt preset reading the player", () => {
  it("takes {{user}}'s quotes as speech and asterisked text as actions, in Main and the note", () => {
    expect(DEFAULT_MAIN_PROMPT).toContain(
      `In the player's messages, "quoted" text is what {{user}} says aloud and *asterisked* text is what {{user}} does.`,
    );
    expect(DEFAULT_MAIN_PROMPT).toContain(
      "never quote, echo or answer an action's wording as if {{user}} had said it",
    );
    expect(DEFAULT_MAIN_PROMPT).toContain(
      "Speech an action only reports (*asks her name*) is heard for its gist, never word for word.",
    );
    expect(DEFAULT_NOTE_PROMPT).toContain(
      "{{user}}'s *actions* are done, not said: no NPC quotes or answers their wording as speech.",
    );
  });
});

describe("scene line cues", () => {
  it.each([
    ['Kate (25): "Hi"', "Kate", "25", '"Hi"'],
    ["Мила (18): *краснеет*", "Мила", "18", "*краснеет*"],
    ["Mara Battin (18): :thought[oh no]", "Mara Battin", "18", ":thought[oh no]"],
    ["Seo-yeon O\u2019Neil Jr. (31):  hi", "Seo-yeon O\u2019Neil Jr.", "31", "hi"],
  ])("splits %j", (line, name, age, rest) => {
    expect(splitCue(line)).toMatchObject({ cue: `${name} (${age})`, name, age, rest });
  });

  it("keeps the colon and its spaces apart from the cue", () => {
    expect(splitCue("Kate (25):  hi")?.separator).toBe(":  ");
  });

  it.each([
    "Kate",
    "Kate ",
    "Mary Ann",
    "Kate (",
    "Kate (2",
    "Kate (25)",
    "Kate (25):",
    "Kate (25): ",
  ])("takes %j for a cue still arriving", (line) => {
    expect(opensCue(line)).toBe(true);
  });

  it.each(["", "The knock comes softly", 'Kate (25): "H', "Note: the", "12:30", "Kate (25) x"])(
    "takes %j for no cue still arriving",
    (line) => {
      expect(opensCue(line)).toBe(false);
    },
  );

  it.each(["Note: something", 'She said: "hi"', "12:30 came", "Kate (25): ", "Kate (25):"])(
    "finds no cue in %j",
    (line) => {
      expect(splitCue(line)).toBeNull();
    },
  );
});

describe("text without highlights", () => {
  it.each([
    [":mist[Rain falls as she :rose[kisses him].]", "Rain falls as she kisses him."],
    [":mist[The sign reads [Closed] today.]", "The sign reads [Closed] today."],
    ["She grins :D and :gold[waves]", "She grins :D and :gold[waves]"],
    [":rose[still streaming", "still streaming"],
    ["\\:rose[escaped]", "\\:rose[escaped]"],
    ["`:rose[code]` and ::rose[after a colon]", "`:rose[code]` and ::rose[after a colon]"],
    [':sage[shy]{title="Rose"} and :rose[kind]', "shy and kind"],
    ["Kate (25): :thought[oh :rose[wow]]", "Kate (25): oh wow"],
    [":thought[still thinking", "still thinking"],
  ])("reads %j as %j", (text, plain) => {
    expect(withoutHighlights(text)).toBe(plain);
  });
});
