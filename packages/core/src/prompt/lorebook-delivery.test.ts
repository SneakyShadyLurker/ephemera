import { describe, expect, it } from "vitest";
import { blankCard, type LorebookEntry } from "../card/index.ts";
import type { LorebookState } from "../lorebook/timed.ts";
import { defaultPromptPreset } from "../preset/index.ts";
import { type Assembly, type AssemblyInput, assemblePrompt, flatten } from "./assemble.ts";
import { type Counted, fitPrompt } from "./budget.ts";
import { inspectedPromptSchema } from "./inspect.ts";
import { fitProcessed } from "./postprocess.ts";

const CHARACTER = "00000000-0000-4000-8000-000000000001";
const entry = (
  content: string,
  index: number,
  settings: NonNullable<LorebookEntry["settings"]>,
): LorebookEntry => ({
  keys: [],
  enabled: true,
  constant: true,
  useRegex: false,
  insertionOrder: index,
  content,
  settings: { cooldown: 10, ...settings },
});

function input(entries: LorebookEntry[]): AssemblyInput {
  const preset = defaultPromptPreset();
  return {
    preset: {
      ...preset,
      authorsNote: { ...preset.authorsNote, enabled: false },
    },
    character: { ...blankCard("Maren"), lorebook: { entries } },
    persona: { name: "User", description: "" },
    history: [
      { role: "assistant", content: "Hi." },
      { role: "user", content: "Hello." },
    ],
    clock: { now: 0, timeZone: "UTC" },
    pickSeed: 0,
    random: () => 0,
    lorebook: {
      window: 100_000,
      count: (text) => text.length,
      characterId: CHARACTER,
      digest: () => "ab",
    },
  };
}

const count = (message: Counted) => message.content.length;
function fitted(assembly: Assembly, budget = 100_000, historyCap?: number) {
  const result = fitPrompt({
    assembly,
    budget,
    count,
    priming: 0,
    calibration: 1,
    ...(historyCap === undefined ? {} : { historyCap }),
  });
  if (!result.ok) throw new Error("fixture did not fit");
  expect(inspectedPromptSchema.shape.lorebook.parse(result.lorebook)).toEqual(result.lorebook);
  return result;
}

const effects = (state: LorebookState | null) =>
  state?.effects.map(({ index, start }) => [index, start]);

describe("lorebook delivery after assembly and fitting", () => {
  it("starts no effect for example text dropped with history and keeps fitting independent", () => {
    const assembly = assemblePrompt(
      input([entry("User: LORE_SENTINEL", 0, { placement: "examplesTop" })]),
    );
    const report = assembly.lorebook;
    const state = assembly.lorebookState;
    const dropped = fitted(assembly, 100_000, 1);
    expect(dropped.messages.some((message) => message.content.includes("LORE_SENTINEL"))).toBe(
      false,
    );
    expect(dropped.lorebook?.counts).toMatchObject({ sent: 0, doesNotFit: 1 });
    expect(dropped.lorebook?.used).toBe(0);
    expect(effects(dropped.lorebookState)).toEqual([]);
    expect(assembly.lorebook).toBe(report);
    expect(assembly.lorebookState).toBe(state);
    expect(effects(fitted(assembly).lorebookState)).toEqual([[0, 2]]);
    expect(effects(fitted(assembly, 100_000, 1).lorebookState)).toEqual([]);
  });

  it("finalizes partially retained example groups by entry, across multiple START blocks", () => {
    const assembly = assemblePrompt(
      input([
        entry("User: FIRST\n\n\n---\n\n\nUser: SECOND", 0, { placement: "examplesTop" }),
        entry("\n\n---\n\n\nUser: THIRD", 1, { placement: "examplesTop" }),
      ]),
    );
    const base = flatten(assembly, { turns: 2, examples: 0 }).reduce(
      (total, message) => total + count(message),
      0,
    );
    const result = fitted(assembly, base + "User: FIRST".length);
    expect(result.examples.sent).toBe(1);
    expect(result.messages.map(({ content }) => content)).toContain("User: FIRST");
    expect(result.messages.map(({ content }) => content)).not.toContain("User: SECOND");
    expect(result.lorebook?.entries.map(({ status }) => status)).toEqual(["sent", "doesNotFit"]);
    expect(effects(result.lorebookState)).toEqual([[0, 2]]);
    expect(result.lorebook?.used).toBe("User: FIRST\n\n\n---\n\n\nUser: SECOND".length);
  });

  it("credits continuation text merged into an earlier entry's speaker message", () => {
    const assembly = assemblePrompt(
      input([
        entry("User: FIRST", 0, { placement: "examplesTop" }),
        entry("continued from another entry", 1, { placement: "examplesTop" }),
        entry("\n\n---\n\n\nignored narration", 2, { placement: "examplesTop" }),
      ]),
    );
    const result = fitted(assembly);
    expect(result.messages.map(({ content }) => content)).toContain(
      "User: FIRST\ncontinued from another entry",
    );
    expect(result.lorebook?.entries.map(({ status }) => status)).toEqual(["sent", "sent", "sent"]);
    expect(effects(result.lorebookState)).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it.each(["", "[Example wrapper]"])(
    "counts no entry contribution for narration with wrapper %j",
    (wrapper) => {
      const value = input([entry("unlabelled narration", 0, { placement: "examplesTop" })]);
      value.preset.blocks = value.preset.blocks.map((block) =>
        block.kind === "source" && block.id === "dialogueExamples"
          ? { ...block, template: wrapper === "" ? "" : `${wrapper}{{content}}` }
          : block,
      );
      const result = fitted(assemblePrompt(value));
      expect(result.lorebook?.counts).toMatchObject({ sent: 1, empty: 0 });
      expect(effects(result.lorebookState)).toEqual([[0, 2]]);
    },
  );

  it("credits bottom examples independently of card and top examples", () => {
    const value = input([
      entry("User: TOP", 0, { placement: "examplesTop" }),
      entry("User: BOTTOM", 1, { placement: "examplesBottom" }),
    ]);
    if (value.character !== null) value.character.exampleDialogue = "User: CARD";
    const assembly = assemblePrompt(value);
    const base = flatten(assembly, { turns: 2, examples: 0 }).reduce(
      (total, message) => total + count(message),
      0,
    );
    const result = fitted(assembly, base + "User: TOP".length + "User: CARD".length);
    expect(result.examples.sent).toBe(2);
    expect(effects(result.lorebookState)).toEqual([[0, 2]]);
    expect(result.lorebook?.counts).toMatchObject({ sent: 1, doesNotFit: 1 });
  });

  it("does not attribute trimmed speaker prefixes or leading narration to entries", () => {
    const assembly = assemblePrompt(
      input([
        entry("ignored narration\nUser:", 0, { placement: "examplesTop" }),
        entry("only this continuation reaches the model", 1, { placement: "examplesTop" }),
      ]),
    );
    const result = fitted(assembly);
    expect(result.lorebook?.entries.map(({ status }) => status)).toEqual(["sent", "sent"]);
    expect(effects(result.lorebookState)).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it("filters depth and in-chat note hosts while preserving fixed note positions", () => {
    const value = input([
      entry("DEPTH", 0, { placement: "depth" }),
      entry("NOTE_TOP", 1, { placement: "anTop" }),
      entry("NOTE_BOTTOM", 2, { placement: "anBottom" }),
    ]);
    value.preset.blocks = value.preset.blocks.map((block) =>
      block.kind === "chatHistory" ? { ...block, enabled: false } : block,
    );
    value.preset.authorsNote = {
      ...value.preset.authorsNote,
      enabled: true,
      frequency: 1,
      position: "inChat",
      text: "",
    };
    const missing = fitted(assemblePrompt(value));
    expect(missing.lorebook?.counts).toMatchObject({ sent: 0, blockOff: 1, noteOff: 2 });
    expect(effects(missing.lorebookState)).toEqual([]);
    value.preset.authorsNote.position = "afterMain";
    const fixed = fitted(assemblePrompt(value));
    expect(fixed.messages.map(({ content }) => content)).toContain("NOTE_TOP\n\nNOTE_BOTTOM");
    expect(effects(fixed.lorebookState)).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("keeps before, after, depth and note provenance when in-chat messages merge", () => {
    const value = input([
      entry("BEFORE", 0, { placement: "before" }),
      entry("AFTER", 1, { placement: "after" }),
      entry("DEPTH", 2, { placement: "depth", depth: 2 }),
      entry("NOTE", 3, { placement: "anTop" }),
    ]);
    value.preset.authorsNote = {
      ...value.preset.authorsNote,
      enabled: true,
      frequency: 1,
      depth: 2,
      role: "system",
      position: "inChat",
    };
    const result = fitted(assemblePrompt(value), 100_000, 1);
    expect(result.lorebook?.counts.sent).toBe(4);
    expect(effects(result.lorebookState)).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
  });

  it("starts no effect for a disabled lorebook source", () => {
    const value = input([entry("ERASED", 0, { placement: "before" })]);
    value.preset.blocks = value.preset.blocks.map((block) =>
      block.kind === "source" && block.id === "lorebookBefore"
        ? { ...block, enabled: false }
        : block,
    );
    const result = fitted(assemblePrompt(value));
    expect(result.lorebook?.counts).toMatchObject({ sent: 0, blockOff: 1 });
    expect(effects(result.lorebookState)).toEqual([]);
  });

  it.each([0, 4])(
    "preserves prior expired or sticky records when examples are dropped (sticky %i)",
    (sticky) => {
      const value = input([
        entry("User: LORE_SENTINEL", 0, { placement: "examplesTop", sticky, cooldown: 1 }),
      ]);
      const carried: LorebookState = {
        characterId: CHARACTER,
        effects: [{ index: 0, start: 1, digest: "ab" }],
      };
      if (value.lorebook === undefined) throw new Error("fixture has no lorebook identity");
      value.lorebook.state = carried;
      value.history.push(
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Next." },
      );
      const assembly = assemblePrompt(value);
      expect(effects(fitted(assembly, 100_000, 1).lorebookState)).toEqual([[0, 1]]);
      expect(carried.effects[0]?.start).toBe(1);
      expect(effects(fitted(assembly).lorebookState)).toEqual([[0, sticky === 0 ? 4 : 1]]);
    },
  );

  it("finalizes all entries beyond the report's per-status display cap", () => {
    const assembly = assemblePrompt(
      input(
        Array.from({ length: 205 }, (_, index) =>
          entry(`User: EXAMPLE_${index}`, index, { placement: "examplesTop" }),
        ),
      ),
    );
    const result = fitted(assembly, 100_000, 1);
    expect(result.lorebook?.counts).toMatchObject({ sent: 0, doesNotFit: 205 });
    expect(result.lorebook?.entries).toHaveLength(200);
    expect(effects(result.lorebookState)).toEqual([]);
  });

  it("returns the final selection's state after processing retries", () => {
    const value = input([entry(`User: ${"EXAMPLE".repeat(8)}`, 0, { placement: "examplesTop" })]);
    value.history = [
      { role: "assistant", content: "a".repeat(100) },
      { role: "user", content: "Hello." },
    ];
    const assembly = assemblePrompt(value);
    const budget = flatten(assembly).reduce((total, message) => total + count(message), 0);
    expect(fitted(assembly, budget).examples.sent).toBe(1);
    const result = fitProcessed({
      assembly,
      budget,
      count,
      priming: 0,
      calibration: 1,
      mode: "single",
      names: { user: "User", char: "Maren" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lorebook?.counts).toMatchObject({ sent: 0, doesNotFit: 1 });
    expect(effects(result.lorebookState)).toEqual([]);
    expect(result.messages.some(({ content }) => content.includes("EXAMPLE"))).toBe(false);
  });
});
