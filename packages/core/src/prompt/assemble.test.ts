import { describe, expect, it } from "vitest";
import { plainPromptPreset } from "../../test-fixtures/preset.ts";
import { uuid } from "../../test-fixtures/uuid.ts";
import { blankCard, type CharacterCard } from "../card/index.ts";
import { type CastRegister, emptyCastAnchor, emptyCastState } from "../cast/register.ts";
import type { ChatTurn } from "../chat.ts";
import {
  type AuthorsNote,
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  type PromptBlock,
  type PromptPreset,
  promptPresetSchema,
} from "../preset/index.ts";
import { type AssemblyInput, assemblePrompt, flatten, injectionSlot } from "./assemble.ts";
import { fitPrompt } from "./budget.ts";
import { promptSourceSchema } from "./inspect.ts";

const card: CharacterCard = {
  ...blankCard("Mara Voss"),
  description: "{{char}} captains the Kestrel.",
  personality: "Wry, patient.",
  scenario: "A storm night with {{user}}.",
  exampleDialogue:
    "\n\n---\n\n\n{{user}}: Loud?\n{{char}}: Honest.\n\n\n---\n\n\n{{char}}: Second.",
};

const history: ChatTurn[] = [
  { role: "assistant", content: "Welcome aboard." },
  { role: "user", content: "Thanks." },
  { role: "assistant", content: "Sit." },
  { role: "user", content: "What now?" },
];

function input(overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return {
    preset: plainPromptPreset(),
    character: card,
    persona: { name: "Aria", description: "{{user}} keeps receipts." },
    history,
    clock: { now: Date.UTC(2026, 8, 29, 19, 42), timeZone: "UTC" },
    pickSeed: 0,
    random: () => 0,
    ...overrides,
  };
}

const custom = (overrides: Partial<Extract<PromptBlock, { kind: "custom" }>>): PromptBlock => ({
  kind: "custom",
  id: uuid(),
  name: "Custom",
  role: "system",
  content: "x",
  enabled: true,
  depth: null,
  ...overrides,
});

const withBlocks = (blocks: PromptBlock[], preset = plainPromptPreset()): PromptPreset => ({
  ...preset,
  blocks,
});

/** Everything sent, in order, as "role: content", or "role (name): content" for a named speaker. */
const sent = (value: AssemblyInput) =>
  flatten(assemblePrompt(value)).map(({ role, content }) => `${role}: ${content}`);

describe("prompt assembly", () => {
  it.each([true] as const)(
    "retains original speaker and prefix provenance with names behavior %s",
    () => {
      const preset = plainPromptPreset();
      const assembled = flatten(
        assemblePrompt(
          input({
            preset,
            history: [{ role: "user", name: "Alice Vale!", content: "Aria: a quotation." }],
          }),
        ),
      ).filter((message) => message.source.kind === "history");
      const prefixed = true;
      expect(assembled).toEqual([
        {
          role: "user",
          content: `${prefixed ? "Alice Vale!: " : ""}Aria: a quotation.`,
          historySpeaker: { name: "Alice Vale!", prefixed },
          source: { kind: "history", index: 0 },
        },
      ]);
    },
  );

  it("follows the preset's order with the persona at its block's place", () => {
    expect(sent(input())).toEqual([
      "system: Write Mara Voss's next reply in this roleplay with Aria. Stay in character, move the scene forward, and never write Aria's actions or words.",
      "system: Aria keeps receipts.",
      "system: Mara Voss captains the Kestrel.",
      "system: Wry, patient.",
      "system: A storm night with Aria.",
      "system: Aria: Loud?\nMara Voss: Honest.",
      "system: Mara Voss: Second.",
      "assistant: Welcome aboard.",
      "user: Thanks.",
      "assistant: Sit.",
      "user: What now?",
    ]);
  });

  it("labels each message with where it came from", () => {
    const sources = flatten(assemblePrompt(input())).map((message) => message.source);
    expect(sources.slice(0, 3)).toEqual([
      { kind: "block", id: "main" },
      { kind: "block", id: "personaDescription" },
      { kind: "block", id: "charDescription" },
    ]);
    expect(sources.slice(5, 7)).toEqual([
      { kind: "example", index: 0, line: 0 },
      { kind: "example", index: 1, line: 0 },
    ]);
    expect(sources[7]).toEqual({ kind: "history", index: 0 });
  });

  it("moves the persona with its block and leaves disabled and empty blocks out", () => {
    const preset = plainPromptPreset();
    const blocks = preset.blocks.filter((block) => block.id !== "personaDescription");
    const moved = withBlocks([
      ...blocks.slice(0, -1),
      { kind: "source", id: "personaDescription", enabled: true },
      { kind: "text", id: "postHistory", enabled: false, content: "Hidden." },
    ]);
    const out = sent(input({ preset: moved, character: { ...card, scenario: "" } }));
    expect(out.at(-1)).toBe("system: Aria keeps receipts.");
    expect(out.join("\n")).not.toContain("Hidden.");
    expect(out.join("\n")).not.toContain("storm");
  });

  it("uses 'User' and no persona text without a persona", () => {
    const out = sent(input({ persona: null }));
    expect(out[0]).toContain("roleplay with User.");
    expect(out.join("\n")).not.toContain("receipts");
  });

  it("wraps personality and scenario, and leaves out empty wrappers", () => {
    const preset: PromptPreset = {
      ...plainPromptPreset(),
      blocks: plainPromptPreset().blocks.map((block) =>
        block.kind === "source" && block.id === "charPersonality"
          ? { ...block, template: "[{{char}}'s personality: {{content}}]" }
          : block,
      ),
    };
    const out = sent(input({ preset }));
    expect(out).toContain("system: [Mara Voss's personality: Wry, patient.]");
    expect(out).toContain("system: Aria: Loud?\nMara Voss: Honest.");
    expect(out).not.toContain("system: [Example Chat]");
    expect(out).not.toContain("system: [Start a new Chat]");
  });

  it("wraps the persona around the text it would send bare, and never wraps nothing", () => {
    const persona = (format: string, description = "{{user}} keeps {{incvar::n}} receipts.") =>
      flatten(
        assemblePrompt(
          input({
            preset: {
              ...plainPromptPreset(),
              blocks: plainPromptPreset().blocks.map((block) =>
                block.kind === "source" && block.id === "personaDescription"
                  ? { ...block, template: format.replaceAll("{{persona}}", "{{content}}") }
                  : block,
              ),
            },
            persona: { name: "Aria", description },
          }),
        ),
      ).find(
        (message) => message.source.kind === "block" && message.source.id === "personaDescription",
      );
    const bare = persona("")?.content;
    expect(bare).toMatch(/^Aria keeps \d+ receipts\.$/);
    expect(persona("[{{user}}: {{persona}}]")?.content).toBe(`[Aria: ${bare}]`);
    expect(persona("[{{user}}: {{persona}}]", " ")).toBeUndefined();
  });

  it("labels the persona with the tag the default main prompt names", () => {
    const messages = flatten(assemblePrompt(input({ preset: defaultPromptPreset() })));
    const main = messages.find(
      (message) => message.source.kind === "block" && message.source.id === "main",
    );
    const persona = messages.find(
      (message) => message.source.kind === "block" && message.source.id === "personaDescription",
    );
    expect(main?.content).toContain("Aria belongs to the player and is who <persona> says.");
    expect(persona?.content).toMatch(
      /^<persona>\nAria's persona: .*\n\nAria keeps receipts\.\n<\/persona>$/s,
    );
  });

  it("lets the card's prompts replace the preset's, with {{original}}", () => {
    const preset = plainPromptPreset();
    const blocks = preset.blocks.map((block) =>
      block.id === "postHistory" ? { ...block, content: "Be brief." } : block,
    );
    const out = sent(
      input({
        preset: withBlocks(blocks),
        character: {
          ...card,
          systemPrompt: "You are {{char}}. {{original}}",
          postHistoryInstructions: "{{original}} Stay tense.",
        },
      }),
    );
    expect(out[0]).toMatch(/^system: You are Mara Voss\. Write Mara Voss's next reply/);
    expect(out.at(-1)).toBe("system: Be brief. Stay tense.");
  });

  it("uses the preset's prompts when the settings do not prefer the character's", () => {
    const preset = plainPromptPreset();
    const blocks = preset.blocks.map((block) =>
      block.id === "postHistory" ? { ...block, content: "Be brief." } : block,
    );
    const character = {
      ...card,
      systemPrompt: "You are {{char}}. {{original}}",
      postHistoryInstructions: "{{original}} Stay tense.",
    };
    const at = (preferCharacterPrompt: boolean, preferCharacterInstructions: boolean) => {
      const out = sent(
        input({
          preset: withBlocks(blocks),
          character,
          prefer: { preferCharacterPrompt, preferCharacterInstructions },
        }),
      );
      const main = out[0]?.startsWith("system: You are Mara Voss. Write") ? "card" : out[0];
      return [main, out.at(-1)];
    };
    const presetMain = /^system: Write Mara Voss's next reply/;
    expect(at(true, true)).toEqual(["card", "system: Be brief. Stay tense."]);
    expect(at(false, true)).toEqual([
      expect.stringMatching(presetMain),
      "system: Be brief. Stay tense.",
    ]);
    expect(at(true, false)).toEqual(["card", "system: Be brief."]);
    expect(at(false, false)).toEqual([expect.stringMatching(presetMain), "system: Be brief."]);
  });

  it("uses the card's name for {{char}} even when it has a nickname", () => {
    expect(sent(input({ character: { ...card, nickname: "Captain" } }))[2]).toBe(
      "system: Mara Voss captains the Kestrel.",
    );
  });

  it("places in-chat blocks by depth, the assistant's then the user's then system at one depth", () => {
    const preset = plainPromptPreset();
    const blocks = [
      ...preset.blocks,
      custom({ name: "S0", role: "system", content: "after all", depth: 0 }),
      custom({ name: "S1", role: "system", content: "sys one", depth: 1 }),
      custom({ name: "A1", role: "assistant", content: "asst one", depth: 1 }),
      custom({ name: "U1", role: "user", content: "user one", depth: 1 }),
      custom({ name: "Deep", role: "system", content: "deep", depth: 99 }),
    ];
    const out = sent(input({ preset: withBlocks(blocks) }));
    const chat = out.slice(out.indexOf("system: deep"));
    expect(chat).toEqual([
      "system: deep",
      "assistant: Welcome aboard.",
      "user: Thanks.",
      "assistant: Sit.",
      "assistant: asst one",
      "user: user one",
      "system: sys one",
      "user: What now?",
      "system: after all",
    ]);
  });

  it("sends one message per depth, order and role, lower orders first, with the notes last", () => {
    const preset = plainPromptPreset();
    const blocks = [
      ...preset.blocks,
      custom({ name: "Late", content: "order 200", depth: 1, order: 200 }),
      custom({ name: "Early", content: "order 50", depth: 1, order: 50 }),
      custom({ name: "One", content: "first", depth: 1 }),
      custom({ name: "Two", content: "second", depth: 1 }),
    ];
    const characterNote = {
      depth_prompt: { prompt: "Character's note.", depth: 1, role: "system" },
    };
    const out = sent(
      input({
        preset: withAuthorsNote(note({ text: "Author's note.", depth: 1 }), withBlocks(blocks)),
        character: {
          ...card,
          characterNote: characterNote.depth_prompt as NonNullable<CharacterCard["characterNote"]>,
        },
      }),
    );
    expect(out.slice(-5)).toEqual([
      "assistant: Sit.",
      "system: order 50",
      "system: first\nsecond\nAuthor's note.\nCharacter's note.",
      "system: order 200",
      "user: What now?",
    ]);
  });

  it("sends custom blocks in the running order with their role", () => {
    const preset = plainPromptPreset();
    const blocks = [
      preset.blocks[0] as PromptBlock,
      custom({ name: "Tone", role: "user", content: "Slow, {{user}}." }),
      ...preset.blocks.slice(1),
    ];
    expect(sent(input({ preset: withBlocks(blocks) }))[1]).toBe("user: Slow, Aria.");
  });

  it("works without a character", () => {
    const out = sent(input({ character: null }));
    expect(out[0]).toContain("Write Assistant's next reply");
    expect(out.at(-1)).toBe("user: What now?");
  });

  it("fills time and date from the browser's clock", () => {
    const preset = plainPromptPreset();
    const blocks = preset.blocks.map((block) =>
      block.id === "main" ? { ...block, content: "It is {{time}} on {{date}}." } : block,
    );
    expect(sent(input({ preset: withBlocks(blocks) }))[0]).toBe(
      "system: It is 7:42 PM on September 29, 2026.",
    );
  });
});

/** An enabled in-chat system note at depth 4 unless overridden. */
const note = (overrides: Partial<AuthorsNote> = {}): AuthorsNote => ({
  enabled: true,
  text: "Keep {{char}} guarded.",
  position: "inChat",
  depth: 4,
  role: "system",
  frequency: 1,
  ...overrides,
});

/** The preset with this Author's Note. */
const withAuthorsNote = (authorsNote: AuthorsNote, preset = plainPromptPreset()): PromptPreset => ({
  ...preset,
  authorsNote,
});

describe("generation modes", () => {
  it("ends a continue with the nudge as the last system message, after the partial reply", () => {
    const partial: ChatTurn[] = [...history, { role: "assistant", content: "The storm" }];
    const assembled = flatten(assemblePrompt(input({ history: partial, mode: "continue" })));
    expect(assembled.at(-2)).toMatchObject({ role: "assistant", content: "The storm" });
    expect(assembled.at(-1)).toEqual({
      role: "system",
      content: plainPromptPreset().actions.continue,
      source: { kind: "instruction", id: "continue" },
    });
  });

  it("sends the reply it continues after the post-history instructions, then the nudge", () => {
    const preset = plainPromptPreset();
    const blocks = [
      ...preset.blocks.map((block) =>
        block.id === "postHistory" ? { ...block, content: "Be brief." } : block,
      ),
      custom({ content: "at zero", depth: 0 }),
      custom({ content: "at one", depth: 1 }),
    ];
    const replied: ChatTurn[] = [...history, { role: "assistant", content: "Hold on" }];
    const out = sent(input({ preset: withBlocks(blocks), history: replied, mode: "continue" }));
    // In-chat depths still count the reply being continued .
    expect(out.slice(-6)).toEqual([
      "user: What now?",
      "system: at one",
      "system: at zero",
      "system: Be brief.",
      "assistant: Hold on",
      `system: ${plainPromptPreset().actions.continue}`,
    ]);
  });

  it("ends an impersonation with its prompt, macros filled, and keeps everything else", () => {
    const out = sent(input({ mode: "impersonate", preset: withAuthorsNote(note({ depth: 0 })) }));
    expect(out.at(-1)).toBe(
      `system: ${plainPromptPreset().actions.writeForMe.replaceAll("{{user}}", "Aria").replaceAll("{{char}}", "Mara Voss")}`,
    );
    expect(out.at(-2)).toBe("system: Keep Mara Voss guarded.");
  });

  it("leaves an empty nudge out", () => {
    const preset: PromptPreset = {
      ...plainPromptPreset(),
      actions: { ...plainPromptPreset().actions, continue: "  " },
    };
    const out = sent(input({ preset, mode: "continue" }));
    expect(out.at(-1)).toBe("user: What now?");
  });

  it("adds no instruction to a reply", () => {
    expect(sent(input({ mode: "reply" }))).toEqual(sent(input()));
  });
});

describe("Author's Note", () => {
  it("keeps every-N cadence through folding and unfolding user turns", () => {
    const preset = withAuthorsNote(note({ frequency: 3 }));
    const full: ChatTurn[] = [...history, { role: "user", content: "One more question." }];
    for (let split = 0; split <= full.length; split += 1) {
      const foldedUsers = full.slice(0, split).filter((turn) => turn.role === "user").length;
      const messages = flatten(
        assemblePrompt(input({ preset, history: full.slice(split), foldedUsers })),
      );
      expect(messages.some((message) => message.source.kind === "authorsNote")).toBe(true);
    }
    // Two user turns are not due: an assistant-only fold cannot change that.
    expect(
      flatten(assemblePrompt(input({ preset, history: history.slice(1), foldedUsers: 0 }))).some(
        (message) => message.source.kind === "authorsNote",
      ),
    ).toBe(false);
  });

  it("is the default preset's own: sent as the user right before the last user turn", () => {
    const out = sent(input({ preset: defaultPromptPreset() }));
    expect(out.slice(-2)).toEqual([
      `user: ${DEFAULT_AUTHORS_NOTE.text.replaceAll("{{user}}", "Aria")}`,
      "user: What now?",
    ]);
  });

  it("sends nothing while off, as a note never due", () => {
    const off = sent(input({ preset: withAuthorsNote(note({ enabled: false })) }));
    expect(off).toEqual(sent(input({ preset: withAuthorsNote(note({ frequency: 0 })) })));
    expect(off.join("\n")).not.toContain("Keep Mara Voss guarded.");
  });

  it("fills {{authorsNote}} with its text, whether on or off", () => {
    for (const enabled of [true, false]) {
      const preset = withAuthorsNote(
        note({ enabled, frequency: 0 }),
        withBlocks(
          plainPromptPreset().blocks.map((block) =>
            block.id === "main" ? { ...block, content: "Note: {{authorsNote}}" } : block,
          ),
        ),
      );
      expect(sent(input({ preset }))[0]).toBe("system: Note: Keep {{char}} guarded.");
    }
  });

  it("goes into the chat at its depth with its role, macros filled, labelled", () => {
    const assembled = flatten(
      assemblePrompt(input({ preset: withAuthorsNote(note({ depth: 2, role: "user" })) })),
    );
    const chat = assembled.slice(
      assembled.findIndex((m) => m.source.kind === "history" && m.source.index === 0),
    );
    expect(chat.map((m) => `${m.role}: ${m.content}`)).toEqual([
      "assistant: Welcome aboard.",
      "user: Thanks.",
      "user: Keep Mara Voss guarded.",
      "assistant: Sit.",
      "user: What now?",
    ]);
    expect(chat[2]?.source).toEqual({ kind: "authorsNote", depth: 2 });
  });

  it("joins the preset's in-chat blocks of the same depth and role, after them", () => {
    const blocks = [...plainPromptPreset().blocks, custom({ content: "preset", depth: 1 })];
    const out = sent(input({ preset: withAuthorsNote(note({ depth: 1 }), withBlocks(blocks)) }));
    expect(out.slice(-2)).toEqual(["system: preset\nKeep Mara Voss guarded.", "user: What now?"]);
  });

  it("sits right after the main prompt's place when placed after the main prompt", () => {
    const out = sent(input({ preset: withAuthorsNote(note({ position: "afterMain" })) }));
    expect(out.indexOf("system: Keep Mara Voss guarded.")).toBe(1);
    const noScenario = sent(
      input({
        character: { ...card, scenario: "" },
        preset: withAuthorsNote(note({ position: "afterMain" })),
      }),
    );
    expect(noScenario.indexOf("system: Keep Mara Voss guarded.")).toBe(1);
  });

  it("is sent when the user turns are a multiple of its frequency, never at 0", () => {
    // `history` holds two user turns.
    const has = (frequency: number) =>
      sent(input({ preset: withAuthorsNote(note({ frequency })) })).includes(
        "system: Keep Mara Voss guarded.",
      );
    expect([has(0), has(1), has(2), has(3)]).toEqual([false, true, true, false]);
  });

  it("goes with every request at frequency 1, but a larger one waits for user turns", () => {
    const greetingOnly: ChatTurn[] = [{ role: "assistant", content: "Welcome aboard." }];
    const has = (frequency: number) =>
      sent(
        input({
          history: greetingOnly,
          mode: "impersonate",
          preset: withAuthorsNote(note({ frequency })),
        }),
      ).includes("system: Keep Mara Voss guarded.");
    expect([has(1), has(2)]).toEqual([true, false]);
  });

  it("is left out when empty", () => {
    expect(sent(input({ preset: withAuthorsNote(note({ text: " \n" })) }))).toEqual(sent(input()));
  });
});

describe("Character's Note", () => {
  const withNote = (depth_prompt: unknown) => ({
    ...card,
    characterNote: {
      ...{ role: "system" as const },
      ...(depth_prompt as NonNullable<CharacterCard["characterNote"]>),
    },
  });
  const chatOf = (value: AssemblyInput) => {
    const assembled = flatten(assemblePrompt(value));
    return assembled.slice(
      assembled.findIndex((m) => m.source.kind === "history" && m.source.index === 0),
    );
  };

  it("goes into the chat at its depth with its role, macros filled, labelled", () => {
    const chat = chatOf(
      input({
        character: withNote({ prompt: "{{char}} hides the key.", depth: 2, role: "user" }),
      }),
    );
    expect(chat.map((m) => `${m.role}: ${m.content}`)).toEqual([
      "assistant: Welcome aboard.",
      "user: Thanks.",
      "user: Mara Voss hides the key.",
      "assistant: Sit.",
      "user: What now?",
    ]);
    expect(chat[2]?.source).toEqual({ kind: "characterNote", depth: 2 });
    expect(promptSourceSchema.parse(chat[2]?.source)).toEqual(chat[2]?.source);
  });

  it("places a native note at the start when its depth spans the history", () => {
    const out = sent(input({ character: withNote({ prompt: "Rain.", depth: 4 }) }));
    // Depth 4 in a four-turn chat: before the first turn, as a system message.
    expect(out.indexOf("system: Rain.")).toBe(out.indexOf("assistant: Welcome aboard.") - 1);
  });

  it("goes with every request and every mode", () => {
    const character = withNote({ prompt: "Rain.", depth: 0, role: "system" });
    for (const mode of ["reply", "continue", "impersonate"] as const) {
      expect(sent(input({ character, mode }))).toContain("system: Rain.");
    }
  });

  it("joins the Author's Note and the preset's blocks at the same depth and role, last", () => {
    const blocks = [...plainPromptPreset().blocks, custom({ content: "preset", depth: 1 })];
    const out = sent(
      input({
        preset: withAuthorsNote(note({ depth: 1 }), withBlocks(blocks)),
        character: withNote({ prompt: "Rain.", depth: 1, role: "system" }),
      }),
    );
    expect(out.slice(-2)).toEqual([
      "system: preset\nKeep Mara Voss guarded.\nRain.",
      "user: What now?",
    ]);
  });

  it("keeps the native role order at one depth: the assistant's, the user's, then system", () => {
    const out = sent(
      input({
        character: withNote({ prompt: "Rain.", depth: 1, role: "user" }),
        preset: withAuthorsNote(note({ depth: 1 })),
      }),
    );
    expect(out.slice(-3)).toEqual([
      "user: Rain.",
      "system: Keep Mara Voss guarded.",
      "user: What now?",
    ]);
  });

  it("is left out when blank, or blank once its macros are filled", () => {
    for (const prompt of ["", " \n", "{{// only a comment}}", "{{trim}}"]) {
      expect(sent(input({ character: withNote({ prompt, depth: 1 }) }))).toEqual(sent(input()));
    }
  });
});

describe("lorebook wrapper", () => {
  const book = {
    entries: [
      {
        keys: [],
        constant: true,
        content: "High water at dusk.",

        enabled: true,
        insertionOrder: 10,
        useRegex: false,
      },
      {
        keys: [],
        constant: true,
        content: "The Kestrel lists to port for $&.",

        enabled: true,
        insertionOrder: 20,
        useRegex: false,
      },
    ],
  };
  const withFormat = (lorebook: string) =>
    input({
      preset: {
        ...plainPromptPreset(),
        blocks: plainPromptPreset().blocks.map((block) =>
          block.kind === "source" && block.id.startsWith("lorebook")
            ? { ...block, template: lorebook }
            : block,
        ),
      },
      character: { ...card, lorebook: book },
      lorebook: { window: 100_000, count: (text) => text.length },
    });
  const lore = (value: AssemblyInput) =>
    flatten(assemblePrompt(value)).filter((m) => m.source.kind === "lorebook");
  const joined = "High water at dusk.\nThe Kestrel lists to port for $&.";

  it("sends the entries as they are by default", () => {
    expect(lore(withFormat("{{content}}")).map((m) => m.content)).toEqual([joined]);
  });

  it("wraps each block's joined entries, filling macros in the wrapper only", () => {
    const [message] = lore(withFormat("[{{char}}'s world:\n{{content}}]"));
    expect(message?.content).toBe(`[Mara Voss's world:\n${joined}]`);
    expect(message?.source).toEqual({ kind: "lorebook", position: "before", entries: 2 });
  });

  it("replaces every {{content}}, and sends a wrapper without one as written", () => {
    expect(lore(withFormat("{{content}} / {{content}}"))[0]?.content).toBe(`${joined} / ${joined}`);
    expect(promptPresetSchema.safeParse(withFormat("World notes.").preset).success).toBe(false);
  });

  it("sends the entries alone for an empty wrapper, and nothing without entries", () => {
    expect(lore(withFormat(""))[0]?.content).toBe(joined);
    const empty = input({
      preset: {
        ...plainPromptPreset(),
        blocks: plainPromptPreset().blocks.map((block) =>
          block.kind === "source" && block.id.startsWith("lorebook")
            ? { ...block, template: "[World:\n{{content}}]" }
            : block,
        ),
      },
      character: { ...card, lorebook: { entries: [] } },
      lorebook: { window: 100_000, count: (text) => text.length },
    });
    expect(lore(empty)).toEqual([]);
  });
});

describe("Author's Note entries with an empty note", () => {
  const entry = (content: string, position: number) => ({
    keys: [],
    constant: true,
    content,
    settings: { placement: position === 2 ? ("anTop" as const) : ("anBottom" as const) },
    enabled: true,
    insertionOrder: 10,
    useRegex: false,
  });
  const withEntries = (entries: ReturnType<typeof entry>[], authorsNote: AuthorsNote) =>
    input({
      preset: withAuthorsNote(authorsNote),
      character: { ...card, lorebook: { entries } },
      lorebook: { window: 100_000, count: (text) => text.length },
    });
  const empty = note({ text: "", depth: 1 });
  const top = entry("Above.", 2);
  const bottom = entry("Below.", 3);

  it("sends the top entries, the empty text and the bottom entries joined by line breaks", () => {
    expect(sent(withEntries([top, bottom], empty)).at(-2)).toBe("system: Above.\n\nBelow.");
  });

  it("keeps the empty text as a line with entries on one side only", () => {
    expect(sent(withEntries([top], empty)).at(-2)).toBe("system: Above.\n");
    expect(sent(withEntries([bottom], empty)).at(-2)).toBe("system: \nBelow.");
  });

  it("sends nothing without entries", () => {
    expect(sent(withEntries([], empty))).toEqual(
      sent(withEntries([], { ...empty, enabled: false })),
    );
  });
});

describe("injectionSlot", () => {
  it("counts from the end and stops at the top", () => {
    expect([
      injectionSlot(4, 0),
      injectionSlot(4, 1),
      injectionSlot(4, 4),
      injectionSlot(4, 9),
    ]).toEqual([4, 3, 0, 0]);
  });
});

describe("reasoning sent back", () => {
  const thought: ChatTurn[] = [
    { role: "user", content: "Hi." },
    { role: "assistant", content: "Hello.", reasoning: "First thought." },
    { role: "user", content: "And?" },
    { role: "assistant", content: "Well.", reasoning: "Second thought." },
    { role: "user", content: "Go on." },
  ];
  const withReasoning = (change: Partial<PromptPreset["reasoning"]>): PromptPreset => {
    const preset = plainPromptPreset();
    return { ...preset, reasoning: { ...preset.reasoning, ...change } };
  };

  it("is left out unless the preset adds it", () => {
    expect(sent(input({ history: thought })).join("\n")).not.toContain("thought");
  });

  it("wraps the latest replies' reasoning in the tag, counting from the end", () => {
    const out = sent(input({ history: thought, preset: withReasoning({ addToPrompts: true }) }));
    expect(out).toContain("assistant: <think>Second thought.</think>\nWell.");
    expect(out).toContain("assistant: Hello.");
    const both = sent(
      input({
        history: thought,
        preset: withReasoning({ addToPrompts: true, maxAdditions: 5, tag: "thinking" }),
      }),
    );
    expect(both).toContain("assistant: <thinking>First thought.</thinking>\nHello.");
  });
});

describe("cast register", () => {
  const register: CastRegister = {
    entries: [
      {
        id: uuid(),
        role: "principal",
        anchor: { ...emptyCastAnchor("Ilse Brandt", "female"), age: "29", hair: "red bob" },
        aka: [],
        state: { ...emptyCastState(true), outfit: "grey coat", mood: "wary" },
      },
      {
        id: uuid(),
        role: "minor",
        anchor: { ...emptyCastAnchor("Jonas Reyes", "male"), age: "34" },
        aka: [],
        state: emptyCastState(false),
      },
    ],
  };
  const anchors =
    "<cast>\nEvery NPC's card or initial baseline, the player excepted. Preserve these details unless current durable overrides in Cast now take precedence for changed fields; the current state is in the chat.\nIlse Brandt, 29 years old, red bob\nJonas Reyes, 34 years old\n</cast>";
  const state = "[Cast now:\nIlse Brandt: present, grey coat, wary\nAway: Jonas Reyes]";
  const sources = (value: AssemblyInput) =>
    flatten(assemblePrompt(value)).map((message) => message.source);
  const at = (value: AssemblyInput, id: string) =>
    sources(value).findIndex((source) => source.kind === "block" && source.id === id);
  const withoutCast = (preset = plainPromptPreset()) =>
    withBlocks(preset.blocks.filter((block) => block.id !== "castAnchors"));

  it("sends the anchors after the scenario and the state after the Author's Note, apart", () => {
    const messages = flatten(
      assemblePrompt(input({ preset: defaultPromptPreset(), cast: register })),
    );
    const scenario = messages.findIndex(
      (message) => message.source.kind === "block" && message.source.id === "scenario",
    );
    expect(messages[scenario + 1]).toEqual({
      role: "system",
      content: anchors,
      source: { kind: "block", id: "castAnchors" },
    });
    expect(messages.slice(-3).map((message) => message.source)).toEqual([
      { kind: "authorsNote", depth: 1 },
      { kind: "castState", depth: 1 },
      { kind: "history", index: 3 },
    ]);
    expect(messages.at(-2)).toMatchObject({ role: "user", content: state });
    expect(messages.filter((message) => message.source.kind === "castState")).toHaveLength(1);
    for (const message of messages) expect(promptSourceSchema.parse(message.source)).toBeTruthy();
  });

  it("places the anchors for a preset without the block after the scenario, else the character", () => {
    expect(at(input({ preset: withoutCast(), cast: register }), "castAnchors")).toBe(
      at(input({ preset: withoutCast() }), "scenario") + 1,
    );
    const noScenario = withBlocks(
      withoutCast().blocks.map((block) =>
        block.id === "scenario" ? { ...block, enabled: false } : block,
      ),
    );
    expect(at(input({ preset: noScenario, cast: register }), "castAnchors")).toBe(
      at(input({ preset: noScenario }), "charPersonality") + 1,
    );
  });

  it("keeps the block where a preset puts it, and sends nothing for it switched off", () => {
    const blocks = withoutCast().blocks;
    const moved = withBlocks([
      ...blocks.slice(0, 1),
      { kind: "source", id: "castAnchors", enabled: true },
      ...blocks.slice(1),
    ]);
    expect(at(input({ preset: moved, cast: register }), "castAnchors")).toBe(1);
    const off = withBlocks(
      plainPromptPreset().blocks.map((block) =>
        block.id === "castAnchors" ? { ...block, enabled: false } : block,
      ),
    );
    expect(at(input({ preset: off, cast: register }), "castAnchors")).toBe(-1);
  });

  it("adds nothing for an empty register", () => {
    for (const preset of [defaultPromptPreset(), withoutCast()]) {
      expect(sent(input({ preset, cast: { entries: [] } }))).toEqual(sent(input({ preset })));
    }
  });

  it("puts the state last when the preset sends no history", () => {
    const preset = withBlocks(plainPromptPreset().blocks.filter((b) => b.kind !== "chatHistory"));
    expect(sent(input({ preset, cast: register })).at(-1)).toBe(`user: ${state}`);
  });

  it("keeps the state as a fixed injection when the history is trimmed to its latest turn", () => {
    const assembly = assemblePrompt(input({ cast: register }));
    const fitTo = (budget: number) =>
      fitPrompt({ assembly, budget, count: (m) => m.content.length, priming: 0, calibration: 1 });
    let budget = 0;
    let tightest = fitTo(budget);
    while (!tightest.ok) tightest = fitTo(++budget);
    expect(tightest.history).toEqual({ sent: 1, total: 4 });
    expect(tightest.messages.slice(-2).map((message) => message.source)).toEqual([
      { kind: "castState", depth: 1 },
      { kind: "history", index: 3 },
    ]);
  });
});
