import { describe, expect, it } from "vitest";
import { CPU_BOUND_TEST_TIMEOUT_MS, cpuMs } from "../../test-fixtures/cpu.ts";
import { blankCard, type CharacterCard, type LorebookEntry } from "../card/index.ts";
import type { ChatTurn } from "../chat.ts";
import { memoryCanon } from "../memory/canon.ts";
import {
  type AuthorsNote,
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  type PromptPreset,
} from "../preset/index.ts";
import { type AssemblyInput, assemblePrompt, flatten } from "./assemble.ts";
import { inspectedPromptSchema, promptSourceSchema } from "./inspect.ts";
import { emptyMacroState, MACRO_STATE_LIMITS } from "./macro-state.ts";
import { MacroLimitError } from "./macros.ts";

const entry = (overrides: Partial<LorebookEntry>): LorebookEntry => ({
  keys: [],
  content: "",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const card = (entries: LorebookEntry[], book: Partial<CharacterCard["lorebook"]> = {}) => ({
  ...blankCard("Maren Vey"),
  description: "{{char}} keeps the Skerry light.",
  lorebook: { entries, ...book },
});

const history: ChatTurn[] = [
  { role: "assistant", content: "The lamp needs trimming." },
  { role: "user", content: "Is the lantern lit?" },
];

/** The preset with an Author's Note: a system note, on, unless overridden. */
const noted = (note: Partial<AuthorsNote>, preset = defaultPromptPreset()): PromptPreset => ({
  ...preset,
  authorsNote: { ...DEFAULT_AUTHORS_NOTE, role: "system", ...note },
});

function input(character: CharacterCard, overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return {
    // The default preset with its note off, so only the cases that set one have a note.
    preset: noted({ enabled: false }),
    character,
    persona: { name: "Ash", description: "" },
    history,
    clock: { now: Date.UTC(2026, 8, 29, 19, 42), timeZone: "UTC" },
    pickSeed: 0,
    random: () => 0,
    lorebook: { window: 100_000, count: (text) => text.length },
    ...overrides,
  };
}

const sent = (value: AssemblyInput) =>
  flatten(assemblePrompt(value)).map((message) => ({
    content: message.content,
    source: message.source,
  }));

const lantern = entry({ keys: ["lantern"], content: "The Grey Lantern is {{char}}'s oil lamp." });
const tide = entry({ constant: true, content: "High water at dusk.", insertionOrder: 10 });
const bell = entry({
  keys: ["bell"],
  content: "The drowned bell.",
  settings: { placement: "after" },
});

describe("lorebook in the prompt", () => {
  it("uses displayed scan text without extra macro effects or random draws, including memory canon", () => {
    const character = card([entry({ keys: ["Harbor"], content: "Harbor lore." })]);
    const raw: ChatTurn = {
      role: "assistant",
      content: "{{random::unused::unused}} {{getvar::place}} {{incvar::visits}}",
      macroEligible: true,
    };
    const scan: ChatTurn = { ...raw, scanText: "unused :rose[Harbor 1]" };
    const assemble = (turn: ChatTurn) => {
      let draws = 0;
      const result = assemblePrompt(
        input(character, {
          history: [turn, { role: "user", content: "Next" }],
          macroState: { local: { place: "Harbor" }, global: {} },
          random: () => {
            draws++;
            return 0;
          },
        }),
      );
      return { result, draws };
    };
    const legacy = assemble(raw);
    const shown = assemble(scan);
    expect(shown.result.lorebook?.entries[0]?.status).toBe("sent");
    expect(legacy.result.lorebook?.entries[0]?.status).toBe("notMatched");
    expect(shown.result.macroState).toEqual(legacy.result.macroState);
    expect(shown.result.macroState?.local.visits).toBe("1");
    expect(shown.draws).toBe(legacy.draws);
    expect(shown.draws).toBeGreaterThan(0);
    const canon = memoryCanon({
      card: character,
      names: { char: character.name, user: "Ash" },
      linked: [],
      turns: [scan],
      window: 100_000,
      count: (text) => text.length,
    });
    expect(canon).toContain("Harbor lore.");
  });
  it(
    "sends candidates found before key macro exhaustion with a full variable state",
    () => {
      const macroState = emptyMacroState();
      macroState.local.collection = JSON.stringify({ text: "x".repeat(65_000) });
      for (let index = 1; index < MACRO_STATE_LIMITS.variables; index += 1)
        macroState.local[`key${index}`] = "0";
      const delayed = { recursiveOnly: true };
      const seed = entry({
        constant: true,
        content: `${"{{setvarkey::collection::key::value}}".repeat(5)}signal`,
      });
      const entries = [
        seed,
        entry({ keys: ["signal"], content: "Matched candidate.", settings: delayed }),
        entry({ constant: true, content: "Constant candidate.", settings: delayed }),
        ...Array.from({ length: 1_000 }, (_, index) =>
          entry({
            keys: [`{{setvarkey::collection::key::value}}absent${index}`],
            content: "Later candidate.",
            settings: delayed,
          }),
        ),
      ];
      const character = card(entries, { recursiveScanning: true, scanDepth: 0 });
      const { result, ms } = cpuMs(() =>
        assemblePrompt(input(character, { macroState, history: [] })),
      );
      expect(result.lorebook?.counts.sent).toBe(3);
      expect(result.lorebook?.counts.unscanned).toBeGreaterThan(0);
      expect(result.lorebook?.counts.tooLong).toBe(0);
      expect(result.lorebook?.entries.find((line) => line.index === 1)).toMatchObject({
        status: "sent",
        reason: { kind: "recursed", from: 0 },
      });
      expect(result.lorebook?.entries.find((line) => line.index === 2)?.status).toBe("sent");
      expect(result.lorebook?.entries.some((line) => line.status === "unscanned")).toBe(true);
      const delivered = flatten(result)
        .filter((message) => message.source.kind === "lorebook")
        .flatMap((message) => message.content.split("\n"));
      expect(delivered).toEqual(
        expect.arrayContaining(["signal", "Matched candidate.", "Constant candidate."]),
      );
      expect(delivered).not.toContain("Later candidate.");
      expect(macroState.local.collection).not.toContain('"key"');
      expect(ms).toBeLessThan(2_000);
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it(
    "stops a hostile book over a full variable state within a second",
    () => {
      const macroState = emptyMacroState();
      for (let index = 0; index < MACRO_STATE_LIMITS.variables; index += 1)
        macroState.local[`v${index}`] = "x";
      const entries = Array.from({ length: 5_000 }, (_, i) =>
        entry({ keys: Array.from({ length: 100 }, (_, k) => `k${i}z${k}`) }),
      );
      const { result, ms } = cpuMs(() =>
        assemblePrompt(input(card(entries), { macroState, history: [] })),
      );
      expect(result.lorebook?.counts.unscanned).toBeGreaterThan(0);
      expect(ms).toBeLessThan(1_000);
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it(
    "bounds indexed macro work in constant entry bodies before their empty output hides it",
    () => {
      const macroState = emptyMacroState();
      macroState.local.collection = JSON.stringify({ text: "x".repeat(65_000) });
      const content = "{{setvarkey::collection::key::value}}".repeat(100);
      const character = card(
        Array.from({ length: 1_000 }, () => entry({ constant: true, content })),
      );
      const { result, ms } = cpuMs(() => assemblePrompt(input(character, { macroState })));
      expect(result.lorebook?.counts.empty).toBeGreaterThan(0);
      expect(result.lorebook?.counts.empty).toBeLessThan(10);
      expect(result.lorebook?.counts.unscanned).toBeGreaterThan(990);
      expect(result.lorebook?.counts.tooLong).toBe(0);
      expect(macroState.local.collection).not.toContain('"key"');
      expect(ms).toBeLessThan(1_000);
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it(
    "shares the scan budget with nested card fields and keeps caller state isolated",
    () => {
      const macroState = emptyMacroState();
      macroState.local.key0 = "0";
      macroState.local.collection = JSON.stringify({ text: "x".repeat(65_000) });
      const entries = Array.from({ length: 100 }, () =>
        entry({ keys: Array.from({ length: 100 }, () => "{{description}}") }),
      );
      const character = {
        ...card(entries, { scanDepth: 0 }),
        description: "{{setvarkey::collection::key::value}}{{incvar::key0}}",
      };
      const value = input(character, { macroState, history: [] });
      const first = assemblePrompt(value);
      // Only the nested field's work can spend the scan's bound here.
      expect(first.lorebook?.counts.unscanned).toBeGreaterThan(0);
      expect(first.lorebook?.keyProblems).toEqual([]);
      expect(macroState.local.key0).toBe("0");
      const replay = assemblePrompt(value);
      expect(replay.lorebook).toEqual(first.lorebook);
      expect(replay.macroState).toEqual(first.macroState);
      expect(flatten(replay)).toEqual(flatten(first));
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it("activates lore for original history speakers rather than the current persona or character", () => {
    const entries = ["Alice", "Bob", "Old Captain", "Maren Vey"].map((name) =>
      entry({ keys: [`${name}:`], content: `${name}'s lore.` }),
    );
    const assembly = assemblePrompt(
      input(card(entries), {
        persona: { name: "Bob", description: "" },
        history: [
          { role: "user", name: "Alice", content: "Hello." },
          { role: "assistant", name: "Old Captain", content: "Welcome." },
        ],
      }),
    );
    expect(assembly.lorebook?.entries.map(({ status }) => status)).toEqual([
      "sent",
      "notMatched",
      "sent",
      "notMatched",
    ]);
    const lore = flatten(assembly).filter((message) => message.source.kind === "lorebook");
    expect(lore.flatMap(({ content }) => content.split("\n")).sort()).toEqual([
      "Alice's lore.",
      "Old Captain's lore.",
    ]);
  });

  it("fills the before and after blocks around the character, one message each", () => {
    const messages = sent(input(card([lantern, tide, bell])));
    const at = (kind: string) => messages.findIndex((message) => message.source.kind === kind);
    const before = messages.find(
      (m) => m.source.kind === "lorebook" && m.source.position === "before",
    );
    expect(before?.content).toBe("High water at dusk.\nThe Grey Lantern is Maren Vey's oil lamp.");
    expect(before?.source).toEqual({ kind: "lorebook", position: "before", entries: 2 });
    // The bell was not mentioned, so the after block is empty and left out.
    expect(
      messages.some((m) => m.source.kind === "lorebook" && m.source.position === "after"),
    ).toBe(false);
    const description = messages.findIndex(
      (m) => m.source.kind === "block" && m.source.id === "charDescription",
    );
    expect(at("lorebook")).toBeLessThan(description);
    expect(promptSourceSchema.parse(before?.source)).toEqual(before?.source);
  });

  it("rolls an entry's trigger chance with the request's random source", () => {
    const gull = entry({
      constant: true,
      content: "A gull lands on the rail.",
      settings: { useProbability: true, probability: 10 },
    });
    const lucky = assemblePrompt(input(card([gull]), { random: () => 0.05 }));
    expect(lucky.lorebook?.entries[0]).toMatchObject({
      status: "sent",
      reason: { kind: "constant", chance: 10 },
    });
    const unlucky = assemblePrompt(input(card([gull]), { random: () => 0.5 }));
    expect(unlucky.lorebook?.entries[0]?.status).toBe("chanceMissed");
    expect(flatten(unlucky).some((message) => message.source.kind === "lorebook")).toBe(false);
  });

  it("fills every placeholder, but refuses a wrapper that repeats the entries past the bound", () => {
    const preset = defaultPromptPreset();
    const wrapped = (lorebook: string, content: string) =>
      input(card([entry({ constant: true, content })]), {
        preset: {
          ...preset,
          blocks: preset.blocks.map((block) =>
            block.kind === "source" && block.id.startsWith("lorebook")
              ? { ...block, template: lorebook.replaceAll("{0}", "{{content}}") }
              : block,
          ),
        },
      });
    const twice = sent(wrapped("[{0} | {0}]", "Tide")).find((m) => m.source.kind === "lorebook");
    expect(twice?.content).toBe("[Tide | Tide]");
    // 100 copies of 20,000 characters: past the macro output bound, so nothing is built.
    expect(() => assemblePrompt(wrapped("{0}".repeat(100), "x".repeat(20_000)))).toThrow(
      MacroLimitError,
    );
  });

  it("puts after-character entries after the scenario block's place", () => {
    const messages = sent(
      input(card([bell]), { history: [{ role: "user", content: "Did the bell ring?" }] }),
    );
    const kinds = messages.map((m) =>
      m.source.kind === "block"
        ? m.source.id
        : m.source.kind === "lorebook"
          ? "lore"
          : m.source.kind,
    );
    expect(kinds.indexOf("lore")).toBeGreaterThan(kinds.indexOf("charDescription"));
    expect(kinds.indexOf("lore")).toBeLessThan(kinds.indexOf("history"));
    expect(messages[kinds.indexOf("lore")]?.source).toEqual({
      kind: "lorebook",
      position: "after",
      entries: 1,
    });
  });

  it("sends nothing for a block the preset switches off, and reports it", () => {
    const preset: PromptPreset = {
      ...defaultPromptPreset(),
      blocks: defaultPromptPreset().blocks.map((block) =>
        block.id === "lorebookBefore" && block.kind === "source"
          ? { ...block, enabled: false }
          : block,
      ),
    };
    const assembly = assemblePrompt(input(card([lantern]), { preset }));
    expect(flatten(assembly).some((m) => m.source.kind === "lorebook")).toBe(false);
    expect(assembly.lorebook?.entries[0]?.status).toBe("blockOff");
  });

  it("does not scan the Author's Note not by default", () => {
    const quiet: ChatTurn[] = [{ role: "user", content: "Evening." }];
    const preset = noted({ text: "Mention the lantern." });
    const withNote = assemblePrompt(input(card([lantern]), { history: quiet, preset }));
    expect(withNote.lorebook?.counts.sent).toBe(0);
  });

  it("uses the card's scan depth and budget, capped by the window", () => {
    const deep = card([entry({ keys: ["trimming"], content: "Wick lore." })], { scanDepth: 1 });
    expect(assemblePrompt(input(deep)).lorebook?.counts.notMatched).toBe(1);
    const shallow = card([entry({ keys: ["trimming"], content: "Wick lore." })]);
    expect(assemblePrompt(input(shallow)).lorebook?.counts.sent).toBe(1);

    const small = assemblePrompt(
      input(card([lantern], { tokenBudget: 5_000 }), {
        lorebook: { window: 100, count: (text) => text.length },
      }),
    ).lorebook;
    expect(small?.budget).toBe(25);
    expect(small?.entries[0]?.status).toBe("doesNotFit");
  });

  it("is absent without a character, a book or the lorebook input", () => {
    expect(assemblePrompt(input(blankCard("No book"))).lorebook).toBeNull();
    const { lorebook: _unused, ...without } = input(card([lantern]));
    expect(assemblePrompt(without).lorebook).toBeNull();
    expect(assemblePrompt(input(card([lantern]), { character: null })).lorebook).toBeNull();
  });

  it("scans a Continue's partial reply and a draft as the last turn", () => {
    const partial: ChatTurn[] = [
      { role: "user", content: "Go on." },
      { role: "assistant", content: "She lifts the lantern" },
    ];
    const assembly = assemblePrompt(input(card([lantern]), { history: partial, mode: "continue" }));
    expect(assembly.lorebook?.entries[0]?.reason).toEqual({
      kind: "key",
      key: "lantern",
      matched: "lantern",
    });
  });

  it("returns the timed state for the next request, and none without a book", () => {
    const sticky = entry({ keys: ["lantern"], content: "Sticky.", settings: { sticky: 3 } });
    const timed = {
      window: 100_000,
      count: (text: string) => text.length,
      state: null,
      characterId: "00000000-0000-4000-8000-000000000001",
      digest: () => "abc",
    };
    expect(assemblePrompt(input(card([sticky]), { lorebook: timed })).lorebookState).toEqual({
      characterId: timed.characterId,
      effects: [{ index: 0, digest: "abc", start: 2 }],
    });
    expect(
      assemblePrompt(input(blankCard("No book"), { lorebook: timed })).lorebookState,
    ).toBeNull();
  });

  it("round-trips through the inspected prompt schema", () => {
    const assembly = assemblePrompt(input(card([lantern, tide, bell])));
    const parsed = inspectedPromptSchema.shape.lorebook.parse(assembly.lorebook);
    expect(parsed?.counts.sent).toBe(2);
  });
});

describe("lorebook entries in the chat, the Author's Note and the examples", () => {
  const at = (
    content: string,
    settings: NonNullable<LorebookEntry["settings"]>,
    insertionOrder = 100,
  ) => entry({ constant: true, content, settings, insertionOrder });

  it("joins depth entries after the notes of their depth and role, unwrapped", () => {
    const preset = noted({ text: "AUTHORS-NOTE.", depth: 1 });
    const character: CharacterCard = {
      ...card([
        at("LORE-O50.", { placement: "depth", depth: 1, role: "system" }, 50),
        at("LORE-O10.", { placement: "depth", depth: 1, role: "system" }, 10),
        at("LORE-USER.", { placement: "depth", depth: 1, role: "user" }),
      ]),
      characterNote: { prompt: "CHARACTERS-NOTE.", depth: 1, role: "system" },
    };
    const messages = flatten(
      assemblePrompt(
        input(character, {
          preset: {
            ...preset,
            blocks: preset.blocks.map((block) =>
              block.kind === "source" && block.id.startsWith("lorebook")
                ? { ...block, template: "[WI: {{content}}]" }
                : block,
            ),
          },
        }),
      ),
    );
    const last = messages.findIndex((m) => m.content === "Is the lantern lit?");
    expect(messages.slice(last - 2, last).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "LORE-USER." },
      { role: "system", content: "AUTHORS-NOTE.\nCHARACTERS-NOTE.\nLORE-O10.\nLORE-O50." },
    ]);
    const joined = messages[last - 1];
    expect(joined?.merged).toEqual([
      { kind: "characterNote", depth: 1 },
      { kind: "lorebook", position: "depth", depth: 1, role: "system", entries: 2 },
    ]);
    expect(messages[last - 2]?.source).toEqual({
      kind: "lorebook",
      position: "depth",
      depth: 1,
      role: "user",
      entries: 1,
    });
    for (const message of messages) {
      expect(promptSourceSchema.parse(message.source)).toEqual(message.source);
    }
  });

  it("keeps depth entries when the history is trimmed, like every in-chat block", () => {
    const assembly = assemblePrompt(
      input(card([at("LORE-DEEP.", { placement: "depth", depth: 1 })])),
    );
    const kept = flatten(assembly, { examples: 0, turns: 1 });
    expect(kept.some((m) => m.content === "LORE-DEEP.")).toBe(true);
  });

  it("puts Author's Note entries above and below its text, in its one message", () => {
    const messages = sent(
      input(
        card([
          at("LORE-TOP.", { placement: "anTop" }),
          at("LORE-BOTTOM.", { placement: "anBottom" }),
        ]),
        {
          preset: noted({ text: "AUTHORS-NOTE.", depth: 1 }),
        },
      ),
    );
    const note = messages.find((m) => m.source.kind === "authorsNote");
    expect(note?.content).toBe("LORE-TOP.\nAUTHORS-NOTE.\nLORE-BOTTOM.");
    expect(messages.filter((m) => m.content.includes("LORE-"))).toHaveLength(1);
    const merged = flatten(
      assemblePrompt(
        input(
          card([
            at("LORE-TOP.", { placement: "anTop" }),
            at("LORE-BOTTOM.", { placement: "anBottom" }),
          ]),
          {
            preset: noted({ text: "AUTHORS-NOTE.", depth: 1 }),
          },
        ),
      ),
    ).find((m) => m.source.kind === "authorsNote")?.merged;
    expect(merged).toEqual([{ kind: "lorebook", position: "authorsNote", depth: 1, entries: 2 }]);
  });

  it("hosts Author's Note entries around an empty note while it is on", () => {
    const messages = sent(
      input(
        card([
          at("LORE-TOP.", { placement: "anTop" }),
          at("LORE-BOTTOM.", { placement: "anBottom" }),
        ]),
        {
          preset: noted({ text: "", depth: 1 }),
        },
      ),
    );
    const note = messages.find((m) => m.source.kind === "authorsNote");
    expect(note?.content).toBe("LORE-TOP.\n\nLORE-BOTTOM.");
  });

  it("sends no Author's Note entry while the note is off or not due, and reports why outside the budget", () => {
    const book = card([
      at("LORE-TOP.", { placement: "anTop" }),
      at("LORE-BEFORE.", { placement: "before" }),
    ]);
    for (const note of [
      { text: "AUTHORS-NOTE.", enabled: false },
      { text: "AUTHORS-NOTE.", frequency: 0 },
      { text: "AUTHORS-NOTE.", frequency: 2 },
    ]) {
      const assembly = assemblePrompt(input(book, { preset: noted(note) }));
      expect(flatten(assembly).some((m) => m.content.includes("LORE-TOP."))).toBe(false);
      expect(assembly.lorebook?.entries[0]?.status).toBe("noteOff");
      expect(assembly.lorebook?.used).toBe("LORE-BEFORE.".length);
    }
  });

  it("keeps note-dependent lorebook entries eligible when the due user turn is folded", () => {
    const book = card([at("LORE-TOP.", { placement: "anTop" })]);
    const preset = noted({ text: "AUTHORS-NOTE.", frequency: 2 });
    const assembly = assemblePrompt(input(book, { preset, foldedUsers: 1 }));
    expect(
      flatten(assembly).find((message) => message.source.kind === "authorsNote")?.content,
    ).toBe("LORE-TOP.\nAUTHORS-NOTE.");
    expect(assembly.lorebook?.entries[0]?.status).toBe("sent");
    expect(
      assemblePrompt(input(book, { preset, foldedUsers: 2 })).lorebook?.entries[0]?.status,
    ).toBe("noteOff");
  });

  it("makes example-position entries an example block before or after the card's", () => {
    const character: CharacterCard = {
      ...card([
        at("{{user}}: Lore line?\n{{char}}: Lore answer.", { placement: "examplesTop" }),
        at("LORE-AFTER: plain text.", { placement: "examplesBottom" }),
      ]),
      exampleDialogue: "\n\n---\n\n\n{{user}}: Card line?\n{{char}}: Card answer.",
    };
    const messages = flatten(assemblePrompt(input(character)));
    const examples = messages.filter(
      (m) =>
        m.source.kind === "example" ||
        (m.source.kind === "lorebook" && m.source.position === "examples"),
    );
    expect(examples.map(({ content }) => content)).toEqual([
      "Ash: Lore line?\nMaren Vey: Lore answer.",
      "Ash: Card line?\nMaren Vey: Card answer.",
      "LORE-AFTER: plain text.",
    ]);
    expect(examples.every((message) => !("name" in message))).toBe(true);
    expect(examples[0]?.source).toEqual({
      kind: "lorebook",
      position: "examples",
      side: "before",
      index: 0,
      line: 0,
      entries: 1,
    });
    expect(examples[2]?.source).toMatchObject({ position: "examples", side: "after", line: 0 });
  });

  it("drops example-position entries with the example blocks when the window is short", () => {
    const character = card([at("{{user}}: Lore line?", { placement: "examplesTop" })]);
    const assembly = assemblePrompt(input(character));
    const segment = assembly.segments.find((s) => s.kind === "examples");
    expect(segment?.kind === "examples" && segment.blocks.length).toBe(1);
    expect(flatten(assembly, { examples: 0, turns: 2 }).some((m) => "name" in m)).toBe(false);
  });
});

describe("linked lorebooks in the prompt", () => {
  const LINKED = "00000000-0000-4000-8000-0000000000a1";
  const linkedBook = (entries: LorebookEntry[]) => ({
    id: LINKED,
    name: "Harbour events",
    book: { name: "Harbour events", entries },
  });
  const buoy = entry({
    keys: ["lantern"],
    content: "A buoy bobs by the lantern.",
    insertionOrder: 50,
  });

  it("sends a linked book's entries beside the card's, in insertion order", () => {
    const withLinked = input(card([lantern, tide]), {
      lorebook: { window: 100_000, count: (text) => text.length, linked: [linkedBook([buoy])] },
    });
    const before = sent(withLinked).find(
      (m) => m.source.kind === "lorebook" && m.source.position === "before",
    );
    expect(before?.content).toBe(
      "High water at dusk.\nA buoy bobs by the lantern.\nThe Grey Lantern is Maren Vey's oil lamp.",
    );
    expect(before?.source).toEqual({ kind: "lorebook", position: "before", entries: 3 });
  });

  it("names the sources in the report and numbers entries across them", () => {
    const assembly = assemblePrompt(
      input(card([lantern]), {
        lorebook: { window: 100_000, count: (text) => text.length, linked: [linkedBook([buoy])] },
      }),
    );
    expect(assembly.lorebook?.sources).toEqual([
      { id: null, name: "", count: 1 },
      { id: LINKED, name: "Harbour events", count: 1 },
    ]);
    expect(assembly.lorebook?.entries.map((line) => [line.index, line.status])).toEqual([
      [0, "sent"],
      [1, "sent"],
    ]);
    expect(inspectedPromptSchema.shape.lorebook.parse(assembly.lorebook)).toEqual(
      assembly.lorebook,
    );
  });

  it("activates linked books for a character without a book of its own", () => {
    const character = {
      ...blankCard("Maren Vey"),
      description: "{{char}} keeps the Skerry light.",
    };
    const assembly = assemblePrompt(
      input(character, {
        lorebook: { window: 100_000, count: (text) => text.length, linked: [linkedBook([buoy])] },
      }),
    );
    expect(assembly.lorebook?.sources).toEqual([{ id: LINKED, name: "Harbour events", count: 1 }]);
    expect(flatten(assembly).some((m) => m.content.includes("A buoy bobs"))).toBe(true);
  });

  it("carries a linked book's timed effect in the state under its own id", () => {
    const sticky = entry({
      keys: ["lantern"],
      content: "A buoy bobs.",
      settings: { sticky: 4 },
    });
    const assembly = assemblePrompt(
      input(card([]), {
        lorebook: {
          window: 100_000,
          count: (text) => text.length,
          linked: [linkedBook([sticky])],
          characterId: "00000000-0000-4000-8000-000000000001",
          digest: () => "ab",
        },
      }),
    );
    expect(assembly.lorebookState?.effects).toEqual([
      { book: LINKED, index: 0, digest: "ab", start: 2 },
    ]);
  });

  it("reports one source for the card's book alone, as before", () => {
    const assembly = assemblePrompt(input(card([lantern], { name: "Skerry" })));
    expect(assembly.lorebook?.sources).toEqual([{ id: null, name: "Skerry", count: 1 }]);
  });
});
