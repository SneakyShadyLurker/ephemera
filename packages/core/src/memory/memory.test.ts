import { describe, expect, it } from "vitest";
import { generateRequestSchema, MAX_CHAT_TURNS, previewRequestSchema } from "../chat.ts";
import { LOCATION_OPENING, OPENING_RESTRAINT } from "../creator/prompts.ts";
import { DEFAULT_SETTINGS, settingsPatchSchema } from "../settings.ts";
import { estimateTokens } from "../tokens.ts";
import { foldToFit } from "./fold.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import {
  applyMemoryAnswer,
  chapterOutputSchema,
  clampChapterOutput,
  clampMemoryAnswer,
  clampOpeningAnswer,
  emptyNotebook,
  episodePatchRequestSchema,
  type MemoryAnswer,
  memoryAnswerSchema,
  memoryIsOn,
  memoryOutputSchema,
  memoryStateOf,
  memoryStatePatchRequestSchema,
  memoryStateSchema,
  OPENING_REFUSALS,
  openingAnswerSchema,
  openingRefusalSchema,
  openingRequestSchema,
  openingResponseSchema,
  rememberRequestSchema,
  type StoredEpisode,
  storedEpisodeSchema,
} from "./memory.ts";
import {
  CONTINUED_SCENE,
  chapterInstructions,
  chapterMessage,
  memoryRecalledText,
  memoryStoryText,
  NEW_SCENE,
  openingInstructions,
  openingMessage,
  openingRule,
  rememberInstructions,
  rememberMessage,
  summaryWords,
  transcriptLines,
  userNameForms,
  withUserPlaceholder,
} from "./prompt.ts";
import { fitRecall, rankRecall, storyOrder } from "./recall.ts";
import {
  bookStory,
  latestWithin,
  notebookRoom,
  previousEpisodes,
  recapAfter,
  recapBudget,
  reconcileRecap,
  rollupMembers,
  storyBefore,
} from "./recap.ts";
import { chatMemoryStateSchema, MAX_FOLDED_TURNS, RECAP_IDS } from "./state.ts";

const CHARACTER = "00000000-0000-4000-8000-000000000001";
const ATTEMPT = "00000000-0000-4000-8000-000000000002";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const names = { char: "Mara", user: "Aria" };

const episode = (seq: number, overrides: Partial<StoredEpisode> = {}): StoredEpisode => ({
  id: id(100 + seq),
  characterId: CHARACTER,
  seq,
  kind: "episode",
  title: `Episode ${seq}`,
  summary: `What happened in scene ${seq}.`,
  cues: [],
  pinned: false,
  turns: 6,
  chapterId: null,
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const output = {
  title: "The storm at the pier",
  summary: "Aria met Mara at the pier.",
  cues: ["pier", "brass key"],
  notebook: {
    situation: "They wait out the storm.",
    relationships: ["Mara and Aria: allies since the pier, Mara still guarded."],
    facts: ["The key opens the vault."],
    threads: [],
    cast: [],
  },
  opening: "> Location: The pier, dusk\n\nMara waits under the awning beside {{user}}.",
};

describe("stored opening preservation", () => {
  it("reads a converted opening past 600 while owner edits and model answers retain their bound", () => {
    const opening = `{{user}}${"x".repeat(MEMORY_LIMITS.opening - 6)}`;
    const state = { enabled: true, notebook: emptyNotebook(), opening, revision: 2, updatedAt: 12 };
    expect(memoryStateSchema.parse(state)).toEqual(state);
    expect(memoryStatePatchRequestSchema.safeParse({ opening, revision: 2 }).success).toBe(false);
    expect(memoryOutputSchema.safeParse({ ...output, opening }).success).toBe(false);
    expect(memoryAnswerSchema.safeParse({ ...answer, opening }).success).toBe(false);
    expect(openingAnswerSchema.safeParse({ opening }).success).toBe(false);
    for (const invalid of [
      { opening: 1 },
      { revision: -1 },
      { unknown: true },
      { notebook: { ...emptyNotebook(), facts: ["x".repeat(MEMORY_LIMITS.line + 1)] } },
    ])
      expect(memoryStateSchema.safeParse({ ...state, ...invalid }).success).toBe(false);
  });
});

/** An answer that changes nothing of the notebook but its situation. */
const unchanged = { change: [], drop: [], add: [] };
const answer: MemoryAnswer = {
  title: output.title,
  summary: output.summary,
  cues: output.cues,
  notebook: {
    situation: "They wait out the storm.",
    relationships: unchanged,
    facts: unchanged,
    threads: unchanged,
    cast: { change: [], drop: [], add: [] },
  },
  opening: output.opening,
};

describe("memory schemas", () => {
  it("accepts a memory within its bounds and refuses one past them", () => {
    expect(memoryOutputSchema.safeParse(output).success).toBe(true);
    const tooMany = {
      ...output,
      cues: Array.from({ length: MEMORY_LIMITS.cues + 1 }, (_, i) => `cue ${i}`),
    };
    expect(memoryOutputSchema.safeParse(tooMany).success).toBe(false);
    const longTitle = { ...output, title: "x".repeat(MEMORY_LIMITS.title + 1) };
    expect(memoryOutputSchema.safeParse(longTitle).success).toBe(false);
    const facts = Array.from({ length: MEMORY_LIMITS.facts + 1 }, (_, i) => `fact ${i}`);
    expect(
      memoryOutputSchema.safeParse({ ...output, notebook: { ...output.notebook, facts } }).success,
    ).toBe(false);
    const relationships = Array.from(
      { length: MEMORY_LIMITS.relationships + 1 },
      (_, i) => `pair ${i}`,
    );
    expect(
      memoryOutputSchema.safeParse({ ...output, notebook: { ...output.notebook, relationships } })
        .success,
    ).toBe(false);
    // The notebook always names its relationships, empty or not.
    const { relationships: _, ...withoutRelationships } = output.notebook;
    expect(
      memoryOutputSchema.safeParse({ ...output, notebook: withoutRelationships }).success,
    ).toBe(false);
    expect(memoryOutputSchema.safeParse({ ...output, extra: true }).success).toBe(false);
    const longOpening = { ...output, opening: "x".repeat(MEMORY_LIMITS.opening + 1) };
    expect(memoryOutputSchema.safeParse(longOpening).success).toBe(false);
    expect(memoryOutputSchema.safeParse({ ...output, opening: "" }).success).toBe(true);
  });

  it("keeps the next chat's opening beside the notebook on its row and its patches", () => {
    const state = { enabled: true, notebook: emptyNotebook(), revision: 1, updatedAt: 1 };
    expect(memoryStateSchema.safeParse({ ...state, opening: output.opening }).success).toBe(true);
    // A row always names its opening, empty or not.
    expect(memoryStateSchema.safeParse(state).success).toBe(false);
    // An opening alone, or a patch without one that leaves the stored one.
    expect(memoryStatePatchRequestSchema.parse({ opening: " Hi. ", revision: 1 })).toEqual({
      opening: "Hi.",
      revision: 1,
    });
    expect(
      memoryStatePatchRequestSchema.parse({ notebook: emptyNotebook(), revision: 1 }),
    ).not.toHaveProperty("opening");
    expect(
      memoryStatePatchRequestSchema.safeParse({
        opening: "x".repeat(MEMORY_LIMITS.opening + 1),
        revision: 1,
      }).success,
    ).toBe(false);
  });

  it("checks stored episodes and patches", () => {
    expect(storedEpisodeSchema.safeParse(episode(1)).success).toBe(true);
    expect(storedEpisodeSchema.safeParse({ ...episode(1), kind: "scene" }).success).toBe(false);
    expect(episodePatchRequestSchema.safeParse({ pinned: true, revision: 2 }).success).toBe(true);
    expect(episodePatchRequestSchema.safeParse({ pinned: true }).success).toBe(false);
    expect(
      memoryStatePatchRequestSchema.safeParse({ notebook: emptyNotebook(), revision: 0 }).success,
    ).toBe(true);
  });

  it("asks a remember request for at least one turn, as an ending's last may be", () => {
    const request = {
      characterId: CHARACTER,
      model: "m",
      turns: [
        { role: "assistant", content: "Hello." },
        { role: "user", content: "Hi." },
      ],
      episodes: [],
      held: [],
      attempt: ATTEMPT,
    };
    expect(rememberRequestSchema.safeParse(request).success).toBe(true);
    expect(
      rememberRequestSchema.safeParse({ ...request, turns: request.turns.slice(0, 1) }).success,
    ).toBe(true);
    expect(rememberRequestSchema.safeParse({ ...request, turns: [] }).success).toBe(false);
    expect(rememberRequestSchema.safeParse({ ...request, episodes: ["x"] }).success).toBe(false);
  });

  it("carries folded turns past the live turns' bound", () => {
    const request = {
      model: "m",
      clock: { now: 0, timeZone: "UTC" },
      pickSeed: 0,
      messages: [{ role: "user", content: "Hi." }],
    };
    const folded = MAX_CHAT_TURNS * 3;
    const memoryState = { recap: [], folded, foldedUsers: 0, continued: false };
    expect(generateRequestSchema.parse({ ...request, memoryState }).memoryState).toEqual({
      ...memoryState,
      held: [],
    });
    const past = { ...memoryState, folded: MAX_FOLDED_TURNS + 1 };
    expect(generateRequestSchema.safeParse({ ...request, memoryState: past }).success).toBe(false);
  });

  it("carries the chat's memory state on a generation request", () => {
    const parsed = generateRequestSchema.parse({
      model: "m",
      clock: { now: 0, timeZone: "UTC" },
      pickSeed: 0,
      messages: [{ role: "user", content: "Hi." }],
      memoryState: { recap: [id(1)], foldedUsers: 0, continued: false },
    });
    // No folded turns said and nothing held.
    expect(parsed.memoryState).toEqual({
      recap: [id(1)],
      folded: 0,
      foldedUsers: 0,
      held: [],
      continued: false,
    });
    const folded = { recap: [id(1)], folded: 12, foldedUsers: 5, held: [], continued: true };
    expect(generateRequestSchema.parse({ ...parsed, memoryState: folded }).memoryState).toEqual(
      folded,
    );
  });

  it("carries a bounded folded user count, never greater than folded turns", () => {
    const request = {
      model: "m",
      clock: { now: 0, timeZone: "UTC" },
      pickSeed: 0,
      messages: [{ role: "user", content: "Hi." }],
    };
    for (const schema of [generateRequestSchema, previewRequestSchema]) {
      for (const [folded, foldedUsers] of [
        [0, 0],
        [6, 3],
        [MAX_FOLDED_TURNS, MAX_FOLDED_TURNS],
      ]) {
        expect(
          schema.parse({
            ...request,
            memoryState: { recap: [], folded, foldedUsers, continued: false },
          }).memoryState,
        ).toEqual({ recap: [], folded, foldedUsers, held: [], continued: false });
      }
      for (const foldedUsers of [-1, 1.5, 7, MAX_FOLDED_TURNS + 1, undefined]) {
        expect(
          schema.safeParse({
            ...request,
            memoryState: { recap: [], folded: 6, foldedUsers, continued: false },
          }).success,
        ).toBe(false);
      }
    }
  });

  it("carries held spans on a request, their turns within its messages and their count with the recap within the bound", () => {
    const messages = [
      { role: "user", content: "One." },
      { role: "assistant", content: "Two." },
      { role: "user", content: "Three." },
    ];
    const request = { model: "m", clock: { now: 0, timeZone: "UTC" }, pickSeed: 0, messages };
    const state = { foldedUsers: 0, continued: false };
    const held = [
      { id: id(1), turns: 2 },
      { id: id(2), turns: 1 },
    ];
    for (const schema of [generateRequestSchema, previewRequestSchema]) {
      expect(
        schema.parse({ ...request, memoryState: { ...state, recap: [id(3)], held } }).memoryState
          ?.held,
      ).toEqual(held);
      // More held turns than the request sends.
      const over = [...held, { id: id(4), turns: 1 }];
      expect(
        schema.safeParse({ ...request, memoryState: { ...state, recap: [], held: over } }).success,
      ).toBe(false);
      // A held span covers at least one turn.
      const empty = [{ id: id(1), turns: 0 }];
      expect(
        schema.safeParse({ ...request, memoryState: { ...state, recap: [], held: empty } }).success,
      ).toBe(false);
      // Held and folded memories share the chat's bound.
      const recap = Array.from({ length: RECAP_IDS - 1 }, (_, n) => id(1_000 + n));
      expect(schema.safeParse({ ...request, memoryState: { ...state, recap, held } }).success).toBe(
        false,
      );
      expect(
        schema.safeParse({ ...request, memoryState: { ...state, recap, held: held.slice(0, 1) } })
          .success,
      ).toBe(true);
    }
  });

  it("bounds the memory settings by the limits", () => {
    expect(settingsPatchSchema.safeParse({ memorySpanTokens: 6_000 }).success).toBe(true);
    expect(
      settingsPatchSchema.safeParse({ memorySpanTokens: MEMORY_LIMITS.spanTokens.min - 1 }).success,
    ).toBe(false);
    expect(settingsPatchSchema.safeParse({ memoryKeepTurns: 0 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ memoryReasoning: "high" }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ memoryModel: null }).success).toBe(true);
  });

  it("opens new chats on the memory's opening by default, and a patch without it leaves it", () => {
    expect(DEFAULT_SETTINGS.memoryOpening).toBe(true);
    expect(settingsPatchSchema.parse({ memoryOpening: false })).toEqual({ memoryOpening: false });
    expect(settingsPatchSchema.parse({ memoryKeepTurns: 4 })).not.toHaveProperty("memoryOpening");
    expect(settingsPatchSchema.safeParse({ memoryOpening: "yes" }).success).toBe(false);
  });

  it("says whether the chat's greeting in play is the memory's opening, always", () => {
    const state = { recap: [], foldedUsers: 0 };
    expect(chatMemoryStateSchema.parse({ ...state, continued: true }).continued).toBe(true);
    expect(chatMemoryStateSchema.safeParse(state).success).toBe(false);
    expect(chatMemoryStateSchema.safeParse({ ...state, continued: "yes" }).success).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("counts UTF-8 bytes four to a token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("日本")).toBe(2);
  });
});

describe("memory prompts", () => {
  it("writes one line per turn with the speaker's name and no reasoning", () => {
    const transcript = transcriptLines(
      [
        { role: "assistant", content: "Welcome." },
        { role: "user", content: "  " },
        { role: "user", content: "Thanks.", name: "Ilse" },
        { role: "user", content: "Where to?" },
      ],
      names,
    );
    expect(transcript).toBe("Mara: Welcome.\nIlse: Thanks.\nAria: Where to?");
  });

  it("calls the persona {{user}} wherever its name stands as a word", () => {
    expect(
      withUserPlaceholder("Aria: Where to?\nMara: Aria's ship, Ariadne. ARIA waits.", "Aria"),
    ).toBe("{{user}}: Where to?\nMara: {{user}}'s ship, Ariadne. ARIA waits.");
    expect(withUserPlaceholder("Ask Dr. K (the medic) or Dr. Kay.", " Dr. K (the medic) ")).toBe(
      "Ask {{user}} or Dr. Kay.",
    );
    expect(withUserPlaceholder("Zoë and Zoëlle.", "Zoë")).toBe("{{user}} and Zoëlle.");
    // A combining mark continues the word: a decomposed "José" is not "Jose".
    expect(withUserPlaceholder("Jose and Jose\u0301.", "Jose")).toBe("{{user}} and Jose\u0301.");
    expect(withUserPlaceholder("Nothing to hide.", "  ")).toBe("Nothing to hide.");
    // Someone else's full name stays theirs.
    expect(withUserPlaceholder("Aria met Aria Chen; Aria\nLeft.", "Aria")).toBe(
      "{{user}} met Aria Chen; {{user}}\nLeft.",
    );
    // A placeholder already there stays whole, whatever the persona is called.
    expect(withUserPlaceholder("{{user}} met the user.", "user")).toBe(
      "{{user}} met the {{user}}.",
    );
    expect(withUserPlaceholder("{{ User }} and Aria.", "Aria")).toBe("{{ User }} and {{user}}.");
  });

  it("swaps the whole name and its first word, never a form that would rename the character", () => {
    expect(userNameForms({ char: "Mara Voss", user: "Rowan Ashby" })).toEqual([
      "Rowan Ashby",
      "Rowan",
    ]);
    expect(userNameForms({ char: "Mara Voss", user: "Aria" })).toEqual(["Aria"]);
    expect(userNameForms({ char: "Mara Voss", user: "Mara" })).toEqual([]);
    expect(userNameForms({ char: "Mara", user: "Mara Lund" })).toEqual(["Mara Lund"]);
    expect(userNameForms({ char: "Maraline", user: "Mara" })).toEqual(["Mara"]);
    // A title, an article or an initial is not what the story calls them.
    for (const user of [
      "Dr. Kay",
      "The Stranger",
      "the Stranger",
      "J. Doe",
      "King Arthur",
      "LADY Ash",
    ])
      expect(userNameForms({ char: "Mara", user })).toEqual([user]);
    // The character's name holds the first word in another case: only the whole name.
    expect(userNameForms({ char: "MARA VOSS", user: "Mara Lund" })).toEqual(["Mara Lund"]);
    expect(userNameForms({ char: "Mara", user: " " })).toEqual([]);
  });

  it("orders the message's sections, each in its tag: canon, notebook, earlier memories, the span", () => {
    const message = rememberMessage({
      canon: "Description:\nMara keeps the lighthouse.",
      notebook: output.notebook,
      previous: [episode(1)],
      transcript: "Mara: Welcome.",
    });
    const canon = message.indexOf("Canon (already known; never record it)");
    const notebook = message.indexOf("Notebook (current)");
    const earlier = message.indexOf("Earlier memories (context only)");
    const span = message.indexOf("The span to remember");
    expect(message.startsWith("<canon>\nCanon (already known; never record it)")).toBe(true);
    for (const tag of ["canon", "notebook", "earlier_memories", "span"]) {
      expect(message.indexOf(`<${tag}>`)).toBeLessThan(message.indexOf(`</${tag}>`));
    }
    expect(message).toContain("Mara keeps the lighthouse.");
    expect(notebook).toBeGreaterThan(canon);
    expect(earlier).toBeGreaterThan(notebook);
    expect(span).toBeGreaterThan(earlier);
    expect(message).toContain("They wait out the storm.");
    // Each list numbered, with its count against its bound, so an edit can name a line.
    expect(message).toContain(
      `Relationships (1 of ${MEMORY_LIMITS.relationships}):\n1. Mara and Aria: allies since the pier, Mara still guarded.`,
    );
    expect(message).toContain(`Threads (0 of ${MEMORY_LIMITS.threads}):\n(none)`);
    expect(message).toContain("Episode 1. What happened in scene 1.");
    // The task last, after the span it is about.
    expect(
      message.endsWith("Mara: Welcome.\n</span>\n\nWrite the JSON object for the span above."),
    ).toBe(true);
  });

  it("says when the notebook and the earlier memories are empty", () => {
    const message = rememberMessage({
      canon: null,
      notebook: emptyNotebook(),
      previous: [],
      transcript: "x",
    });
    expect(message).toContain("There is no canon.");
    expect(message).toContain("The notebook is empty.");
    expect(message).toContain("There are no earlier memories.");
  });

  it("describes the object and keeps the principals out of the cues", () => {
    const instructions = rememberInstructions(names, { words: 120 });
    for (const key of [
      '"title"',
      '"summary"',
      '"cues"',
      '"notebook"',
      '"situation"',
      '"relationships"',
      '"facts"',
      '"threads"',
      '"opening"',
    ])
      expect(instructions).toContain(key);
    expect(instructions).toContain("Never use Mara's name or {{user}} as a cue");
    expect(instructions).not.toContain("—");
    // One line per pair, rewritten as it changes; facts never hold them.
    expect(instructions).toContain("both names first, then where they stand now");
    expect(instructions).toContain("never add a second line for a pair");
    expect(instructions).toContain(
      "drop any fact line about where two people stand and carry it into the relationships",
    );
    // Only the changes come back: every line not named stays.
    expect(instructions).toContain("Every line you do not name stays word for word");
    for (const key of ['"change"', '"drop"', '"add"']) expect(instructions).toContain(key);
    // Cues as the story would name them again; summaries open with the in-story time.
    expect(instructions).toContain("one to three words without an article");
    expect(instructions).toContain("never invent one");
    expect(chapterInstructions(names, MEMORY_LIMITS.summary)).toContain("never invent one");
    expect(instructions).toContain("as short as its content allows, one fact per line");
    expect(instructions).toContain("State the in-story time or day when the span gives it.");
    // What the current notebook holds is not restated; what the span established still is.
    expect(instructions).toContain(
      "Do not restate what the current notebook already holds; a fact the span established still belongs in the summary, told as the event it was.",
    );
    expect(chapterInstructions(names, MEMORY_LIMITS.summary)).toContain('"cues"');
    const chapter = chapterMessage({
      canon: "Scenario:\nA storm coast.",
      notebook: output.notebook,
      members: [episode(1), episode(2, { cues: ["pier"] })],
    });
    expect(chapter).toContain("Cues: pier");
    expect(chapter.indexOf("A storm coast.")).toBeLessThan(
      chapter.indexOf("They wait out the storm."),
    );
    expect(chapter.indexOf("They wait out the storm.")).toBeLessThan(chapter.indexOf("Episode 1."));
    expect(chapter.indexOf("<memories>")).toBeLessThan(chapter.indexOf("Episode 1."));
    expect(
      chapter.endsWith(
        "</memories>\n\nWrite the JSON object for the chapter that merges the memories above.",
      ),
    ).toBe(true);
  });

  it("asks for the next chat's opening in the creator's shape, in the present tense", () => {
    const instructions = rememberInstructions(names, { words: 120 });
    expect(instructions).toContain(
      "You read one span of the story and write three things: one memory of that span, how the span changes the notebook of where the story stands, and the opening of the next chat.",
    );
    expect(instructions).toContain("in this chat and in the next ones.");
    expect(instructions).not.toContain("some time later");
    expect(instructions).toContain('- "opening": the first message of the next chat');
    expect(instructions).toContain(LOCATION_OPENING);
    expect(instructions).toContain(OPENING_RESTRAINT);
    expect(instructions).toContain("present tense");
    expect(instructions).toContain(`At most ${MEMORY_LIMITS.opening} characters.`);
    // The opening is asked after the notebook, and the chapter call never asks for one.
    expect(instructions.indexOf('"notebook"')).toBeLessThan(instructions.indexOf('"opening"'));
    expect(chapterInstructions(names, MEMORY_LIMITS.summary)).not.toContain('"opening"');
  });

  it("keeps unrelated memory instructions word for word while adding grounded cast context guidance", async () => {
    const withoutCastContext = (text: string) =>
      text.replace(/\n\nWhen supplied, cast context is[^\n]+/, "");
    const sha256 = async (text: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    expect(await sha256(withoutCastContext(rememberInstructions(names, { words: 120 })))).toBe(
      "d3c6bc46389d0638d5904e5cc07d4ed0b29d2ff5c832e46e2a19dbea1f0a6f3a",
    );
    expect(
      await sha256(withoutCastContext(rememberInstructions(names, { words: 120, room: 3200 }))),
    ).toBe("0dab6b0193a5fc09466202061cc32057c10d65f2ed27413c6fdee9dfcc990efd");
    const instructions = rememberInstructions(names, { words: 120 });
    expect(instructions).toContain(
      "distinctive voices, forms of address, motivations and who-knows-what",
    );
    expect(instructions).toContain("existing facts or relationships lists");
    expect(instructions).toContain("never as extra fields in Cast JSON lines");
    expect(
      rememberInstructions(names, { words: 120 })
        .split("\n")
        .find((line) => line.startsWith('- "opening"')),
    ).toBe(
      `- "opening": the first message of the next chat, which opens on the next day after the span ends: ${LOCATION_OPENING} one short sentence that places the people that day finds together other than {{user}}, each by name: exactly where they are and their current state, what they are doing and how they seem, seen from outside. Let the way the span ends decide the day plausibly: where people went or stayed, how they parted, what they felt and what they agreed to do carry over, and the day itself is left open for anything to happen. Unlike the memory, write it in the present tense, still in the third person, and say where people are even when canon already says it. Name the time as the next day, such as "The next morning"; give a date or an hour only as the story implies it, never an invented one. ${OPENING_RESTRAINT} At most ${MEMORY_LIMITS.opening} characters.`,
    );
  });

  it("speaks of any kind of card and of the model that tells the story", () => {
    for (const instructions of [
      rememberInstructions(names, { words: 120 }),
      chapterInstructions(names, MEMORY_LIMITS.summary),
    ]) {
      expect(instructions).toContain(
        "a long roleplay in which {{user}} plays opposite Mara, a card that may hold one character, several, or a whole scenario and its cast",
      );
      expect(instructions).toContain("the model that tells the story");
      expect(instructions).not.toContain("the model that plays");
      expect(instructions).toContain("the description of {{user}}'s persona");
      // The persona by its placeholder only, so a memory holds whichever persona plays next.
      expect(instructions).toContain(
        "{{user}} is the persona the user plays, called Aria in the message. Write {{user}} exactly so, braces included",
      );
      expect(instructions).toContain("never Aria or another name");
    }
  });

  it("tells both calls never to record canon, and asks nothing of it in the answer", () => {
    for (const instructions of [
      rememberInstructions(names, { words: 120 }),
      chapterInstructions(names, MEMORY_LIMITS.summary),
    ]) {
      expect(instructions).toMatch(/Never record what canon already says/);
      expect(instructions).not.toContain('"canon"');
    }
    expect(rememberInstructions(names, { words: 120 })).toMatch(/word for word/);
    expect(chapterInstructions(names, MEMORY_LIMITS.summary)).toMatch(/already compressed/);
  });

  it("gives a small window's notebook its room, and a large one's none", () => {
    expect(notebookRoom(300_000)).toBeNull();
    const room = notebookRoom(32_000);
    expect(room).toBe(Math.floor(MEMORY_LIMITS.share * MEMORY_LIMITS.notebookShare * 32_000 * 4));
    if (room === null) throw new Error("room");
    expect(rememberInstructions(names, { words: 120, room })).toContain(
      `under about ${room.toLocaleString("en")} characters`,
    );
    expect(rememberInstructions(names, { words: 120 })).not.toContain("under about");
    const message = rememberMessage({
      canon: null,
      notebook: output.notebook,
      previous: [],
      transcript: "x",
      room,
    });
    const size =
      output.notebook.situation.length +
      [...output.notebook.relationships, ...output.notebook.facts].join("").length;
    expect(message).toContain(
      `Notebook (current, about ${size} of ${room.toLocaleString("en")} characters)`,
    );
  });

  it("scales the summary with the span, within its least and most words", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(summaryWords(words(150))).toBe(60);
    expect(summaryWords(words(3_000))).toBe(200);
    expect(summaryWords(words(60_000))).toBe(400);
    expect(rememberInstructions(names, { words: summaryWords(words(3_000)) })).toContain(
      "about 200 words",
    );
  });
});

describe("the opening call", () => {
  it("asks for the opening alone, with the memory call's rule for it", () => {
    const instructions = openingInstructions(names);
    expect(instructions).toContain(
      "You are the archivist of a long roleplay in which {{user}} plays opposite Mara",
    );
    expect(instructions).toContain(
      "You read what is remembered of the story and write one thing: the opening of the next chat.",
    );
    // The one rule, as the memory call words it for its span.
    expect(instructions).toContain(
      `- "opening": ${openingRule({ end: "the story so far", unlike: "the memories" })}`,
    );
    expect(rememberInstructions(names, { words: 120 })).toContain(
      `- "opening": ${openingRule({ end: "the span", unlike: "the memory" })}`,
    );
    expect(instructions).toContain(LOCATION_OPENING);
    expect(instructions).toContain(OPENING_RESTRAINT);
    expect(instructions).toContain("Return one JSON object with exactly this key:");
    // The persona as its placeholder, and canon never recorded, as every memory call is told.
    expect(instructions).toContain("called Aria in the message. Write {{user}} exactly so");
    expect(instructions).toMatch(/Never record what canon already says/);
    for (const key of ['"title"', '"summary"', '"cues"', '"notebook"'])
      expect(instructions).not.toContain(key);
    // Neither the memory call's task nor the chapter call's.
    expect(instructions).not.toContain("one memory of that span");
    expect(instructions).not.toContain("merge them into one chapter");
    expect(instructions).not.toContain("—");
    expect(
      instructions.endsWith(
        "Answer with the JSON object alone, with no text before or after it and no code fence.",
      ),
    ).toBe(true);
  });

  it("gives canon, the notebook and the newest memories in story order, then the task", () => {
    const message = openingMessage({
      canon: "Scenario:\nA storm coast.",
      notebook: output.notebook,
      episodes: [episode(1), episode(2)],
    });
    const at = (text: string) => message.indexOf(text);
    expect(at("A storm coast.")).toBeGreaterThan(-1);
    expect(at("A storm coast.")).toBeLessThan(at("They wait out the storm."));
    expect(at("<notebook>")).toBeLessThan(at("They wait out the storm."));
    expect(at("They wait out the storm.")).toBeLessThan(at("Episode 1."));
    expect(at("<memories>")).toBeLessThan(at("Episode 1."));
    expect(at("Episode 1.")).toBeLessThan(at("Episode 2."));
    // The notebook as the story reads it: no line numbers.
    expect(message).toContain("- The key opens the vault.");
    expect(message).not.toContain("1. The key opens the vault.");
    expect(
      message.endsWith(
        "</memories>\n\nWrite the JSON object with the opening of the next chat, on the day after the story above ends.",
      ),
    ).toBe(true);
    const bare = openingMessage({ canon: null, notebook: output.notebook, episodes: [] });
    expect(bare).toContain("There is no canon.");
    expect(bare).toContain("There are no memories yet.");
  });

  it("takes an opening within its bound, set in the creator's shape, and refuses none", () => {
    const L = MEMORY_LIMITS;
    expect(
      openingAnswerSchema.parse(
        clampOpeningAnswer({ opening: "**Location:** The pier, dusk\nMara waits.", mood: "calm" }),
      ),
    ).toEqual({ opening: "> Location: The pier, dusk\n\nMara waits." });
    // The same format-then-cut as a memory call's opening.
    const head = `> Location: The pier\n\n${"word ".repeat(40)}`;
    const long = `${head}${"x".repeat(L.opening - head.length - 4)} {{user}} waits.`;
    const cut = openingAnswerSchema.parse(clampOpeningAnswer({ opening: long })).opening;
    expect(cut).toBe(
      memoryAnswerSchema.parse(clampMemoryAnswer({ ...answer, opening: long })).opening,
    );
    expect(cut.length).toBeLessThanOrEqual(L.opening);
    // The call is for an opening: none, blank, null or another type is no answer.
    for (const value of [{}, { opening: "  " }, { opening: null }, { opening: 3 }]) {
      expect(openingAnswerSchema.safeParse(clampOpeningAnswer(value)).success).toBe(false);
    }
  });

  it("takes a request of persona, model and effort only, and names its refusals", () => {
    expect(openingRequestSchema.parse({ model: "m" })).toEqual({ model: "m" });
    const full = { personaId: id(9), model: "m", reasoning: "high" };
    expect(openingRequestSchema.parse(full)).toEqual(full);
    expect(openingRequestSchema.safeParse({ model: "" }).success).toBe(false);
    expect(openingRequestSchema.safeParse({ model: "m", personaId: "x" }).success).toBe(false);
    expect(openingRequestSchema.safeParse({ model: "m", turns: [] }).success).toBe(false);
    expect(openingResponseSchema.parse({ opening: "Hi." })).toEqual({ opening: "Hi." });
    expect(OPENING_REFUSALS).toContain("nothing_to_remember");
    expect(openingRefusalSchema.parse({ error: "nothing_to_remember" })).toEqual({
      error: "nothing_to_remember",
    });
    expect(openingRefusalSchema.parse({ error: "request_timeout" }).error).toBe("request_timeout");
    expect(openingRefusalSchema.safeParse({ error: "too_many_memories" }).success).toBe(false);
  });
});

describe("the story block's framing", () => {
  const notebook = { ...emptyNotebook(), situation: "They wait out the storm." };

  it("opens on the day after the last scene while the memory's opening is the greeting in play", () => {
    const text = memoryStoryText(notebook, { recap: [], fresh: true, continued: true });
    expect(text).toBe(
      `The story so far\n${CONTINUED_SCENE}\n\nWhere the last scene ended\nThey wait out the storm.`,
    );
    expect(text).not.toContain(NEW_SCENE);
  });

  it("frames a fresh chat on another greeting as a new scene", () => {
    expect(memoryStoryText(notebook, { recap: [], fresh: true })).toBe(
      `The story so far\n${NEW_SCENE}\n\nWhere the last scene ended\nThey wait out the storm.`,
    );
    expect(memoryStoryText(notebook, { recap: [], fresh: true, continued: false })).toContain(
      NEW_SCENE,
    );
  });

  it("frames neither once the chat has memories of its own", () => {
    const text = memoryStoryText(notebook, { recap: [episode(1)], continued: true });
    expect(text).not.toContain(NEW_SCENE);
    expect(text).not.toContain(CONTINUED_SCENE);
    expect(text).toContain("Where things stand\nThey wait out the storm.");
  });
});

describe("clamping an answer", () => {
  it("brings every overshoot within the bounds the schema checks", () => {
    const L = MEMORY_LIMITS;
    const over = {
      title: `A storm ${"very ".repeat(40)}long`,
      summary: "word ".repeat(1_200),
      cues: [
        "  ",
        ...Array.from({ length: L.cues + 3 }, (_, i) => `cue ${i}`),
        "x".repeat(L.cue + 1),
      ],
      notebook: {
        situation: "Calm. ".repeat(400),
        relationships: {
          change: [
            { line: 1, text: "r ".repeat(200) },
            { line: 2, text: "  " },
          ],
          drop: [],
          add: Array.from({ length: L.relationships + 2 }, (_, i) => `pair ${i}`),
        },
        facts: {
          change: [],
          drop: [],
          add: [...Array.from({ length: L.facts + 1 }, (_, i) => `fact ${i}`), ""],
        },
        // Lists the answer leaves out are empty.
        threads: { add: ["t ".repeat(200)] },
        mood: "tense",
      },
      extra: true,
    };
    expect(memoryAnswerSchema.safeParse(over).success).toBe(false);
    const clamped = memoryAnswerSchema.parse(clampMemoryAnswer(over));
    expect(clamped.title.length).toBeLessThanOrEqual(L.title);
    expect(clamped.title.endsWith("very")).toBe(true);
    expect(clamped.cues).toHaveLength(L.cues);
    expect(clamped.cues[0]).toBe("cue 0");
    expect(clamped.notebook.facts.add).toHaveLength(L.facts);
    expect(clamped.notebook.relationships.add).toHaveLength(L.relationships);
    expect(clamped.notebook.relationships.add[0]).toBe("pair 0");
    // A blank change is no change.
    expect(clamped.notebook.relationships.change).toHaveLength(1);
    expect(clamped.notebook.relationships.change[0]?.text.length).toBeLessThanOrEqual(L.line);
    expect(clamped.notebook.threads).toEqual({
      change: [],
      drop: [],
      add: [expect.any(String)],
    });
    expect(clamped).not.toHaveProperty("extra");
    expect(clamped.notebook).not.toHaveProperty("mood");
  });

  it("cuts a cue with no word break at its bound, and leaves a valid answer as it is", () => {
    const long = clampChapterOutput({ ...output, cues: ["x".repeat(MEMORY_LIMITS.cue + 5)] });
    expect(chapterOutputSchema.parse(long).cues).toEqual(["x".repeat(MEMORY_LIMITS.cue)]);
    expect(clampMemoryAnswer(answer)).toEqual(answer);
  });

  it("sets the opening's Location line, then cuts it at a word break, never inside {{user}}", () => {
    const L = MEMORY_LIMITS;
    const formatted = memoryAnswerSchema.parse(
      clampMemoryAnswer({ ...answer, opening: "**Location:** The pier, dusk\nMara waits." }),
    );
    expect(formatted.opening).toBe("> Location: The pier, dusk\n\nMara waits.");
    const head = `> Location: The pier\n\n${"word ".repeat(40)}`;
    const long = `${head}${"x".repeat(L.opening - head.length - 4)} {{user}} waits.`;
    const cut = memoryAnswerSchema.parse(clampMemoryAnswer({ ...answer, opening: long })).opening;
    expect(cut.length).toBeLessThanOrEqual(L.opening);
    expect(cut).not.toContain("{{");
    expect(cut.endsWith("x")).toBe(true);
    // A missing or blank opening is an empty one, never a failed answer.
    const { opening: _, ...without } = answer;
    expect(memoryAnswerSchema.parse(clampMemoryAnswer(without)).opening).toBe("");
    expect(memoryAnswerSchema.parse(clampMemoryAnswer({ ...answer, opening: "  " })).opening).toBe(
      "",
    );
    expect(memoryAnswerSchema.safeParse(clampMemoryAnswer({ ...answer, opening: 3 })).success).toBe(
      false,
    );
  });

  it("never cuts inside the persona's placeholder", () => {
    const head = "x".repeat(MEMORY_LIMITS.cue - 5);
    const long = clampChapterOutput({ ...output, cues: [`${head}-{{user}}`] });
    expect(chapterOutputSchema.parse(long).cues).toEqual([`${head}-`]);
  });

  it("mends nothing it cannot: a missing key or a value of another type still fails", () => {
    const { notebook: _, ...noNotebook } = answer;
    expect(memoryAnswerSchema.safeParse(clampMemoryAnswer(noNotebook)).success).toBe(false);
    expect(
      memoryAnswerSchema.safeParse(clampMemoryAnswer({ ...answer, cues: "pier" })).success,
    ).toBe(false);
    // A whole notebook where edits belong is no answer.
    expect(
      memoryAnswerSchema.safeParse(clampMemoryAnswer({ ...answer, notebook: output.notebook }))
        .success,
    ).toBe(false);
    expect(clampMemoryAnswer("text")).toBe("text");
  });
});

describe("applying an answer's edits", () => {
  const notebook = {
    situation: "Before.",
    relationships: ["Mara and Aria: wary."],
    facts: ["The key opens the vault.", "The pier is closed.", "Ilse owes Mara."],
    threads: ["Who sent the letter?"],
    cast: [],
  };

  it("keeps every line not named word for word, changes, drops and adds the rest", () => {
    const written = applyMemoryAnswer(notebook, {
      ...answer,
      notebook: {
        situation: "After.",
        relationships: { change: [{ line: 1, text: "Mara and Aria: allies." }], drop: [], add: [] },
        // Line 2 is both changed and dropped: dropped. Line 9 names nothing.
        facts: {
          change: [{ line: 2, text: "The pier reopened." }],
          drop: [2, 9],
          add: ["Ilse owes Mara.", "The vault is empty."],
        },
        threads: { change: [], drop: [1], add: [] },
        cast: { change: [], drop: [], add: [] },
      },
    });
    expect(written.notebook).toEqual({
      situation: "After.",
      relationships: ["Mara and Aria: allies."],
      facts: ["The key opens the vault.", "Ilse owes Mara.", "The vault is empty."],
      threads: [],
      cast: [],
    });
    expect(memoryOutputSchema.parse(written)).toEqual(written);
  });

  it("writes the answer's opening, or none when it gave none", () => {
    expect(applyMemoryAnswer(notebook, answer).opening).toBe(answer.opening);
    const { opening: _, ...without } = answer;
    const written = applyMemoryAnswer(notebook, memoryAnswerSchema.parse(without));
    expect(written.opening).toBe("");
    expect(memoryOutputSchema.parse(written)).toEqual(written);
  });

  it("adds nothing to a full list but what a drop made room for", () => {
    const full = Array.from({ length: MEMORY_LIMITS.facts }, (_, i) => `fact ${i}`);
    const add = (drop: number[]) =>
      applyMemoryAnswer(
        { ...notebook, facts: full },
        { ...answer, notebook: { ...answer.notebook, facts: { change: [], drop, add: ["new"] } } },
      ).notebook.facts;
    expect(add([])).toEqual(full);
    expect(add([1])).toEqual([...full.slice(1), "new"]);
  });
});

describe("rankRecall", () => {
  const turns = (...contents: string[]) => contents.map((content) => ({ content }));

  it("matches cues as whole words and phrases, in any case", () => {
    const key = episode(1, { cues: ["brass key"] });
    const keyring = episode(2, { cues: ["key"] });
    const pier = episode(3, { cues: ["pier"] });
    expect(rankRecall([key, keyring, pier], turns("The Brass Key turns."))).toEqual([keyring, key]);
    expect(rankRecall([key], turns("brass and a key"))).toEqual([]);
  });

  it("reads a plural as its singular and leaves out a cue's articles at its edges", () => {
    const pier = episode(1, { cues: ["pier"] });
    const locket = episode(2, { cues: ["the silver locket"] });
    const lady = episode(3, { cues: ["Lady of the Lake"] });
    expect(rankRecall([pier], turns("They walk the piers."))).toEqual([pier]);
    expect(rankRecall([locket], turns("She touched her silver lockets."))).toEqual([locket]);
    expect(rankRecall([lady], turns("The Lady of the Lake waits."))).toEqual([lady]);
    // A function word inside a cue still has to be there.
    expect(rankRecall([lady], turns("The lady lake waits."))).toEqual([]);
  });

  it("counts a longer cue's last word at half, with a title word making a recall", () => {
    const locket = episode(1, { title: "A gift at dusk", cues: ["silver locket"] });
    // The last word alone is half a cue: not enough.
    expect(rankRecall([locket], turns("Do you still wear the locket?"))).toEqual([]);
    // With a title word, two halves recall it.
    expect(rankRecall([locket], turns("The locket, a gift from you."))).toEqual([locket]);
  });

  it("counts title words at half a cue, two of them making a recall, function words none", () => {
    const cue = episode(1, { cues: ["lantern", "festival"] });
    const title = episode(2, { title: "The lantern festival" });
    const stray = episode(3, { title: "The night they met" });
    expect(rankRecall([title, cue, stray], turns("A lantern burns at the festival."))).toEqual([
      cue,
      title,
    ]);
    // One title word alone is not enough, and "the" never counts.
    expect(rankRecall([title, stray], turns("A lantern burns in the night."))).toEqual([]);
  });

  it("puts a member tied with its chapter before it", () => {
    const outer = episode(12, { kind: "chapter", cues: ["pier"] });
    const chapter = episode(10, { kind: "chapter", cues: ["pier"], chapterId: outer.id });
    const member = episode(2, { cues: ["pier"], chapterId: chapter.id });
    const other = episode(11, { cues: ["pier"] });
    expect(rankRecall([chapter, outer, other, member], turns("At the pier."))).toEqual([
      member,
      chapter,
      outer,
      other,
    ]);
    const stronger = episode(10, { kind: "chapter", cues: ["pier", "storm"] });
    const held = episode(2, { cues: ["pier"], chapterId: stronger.id });
    expect(rankRecall([held, stronger], turns("The storm at the pier."))).toEqual([stronger, held]);
  });

  it("puts pinned episodes first, always, and breaks ties by recency", () => {
    const pinned = episode(1, { pinned: true });
    const older = episode(2, { cues: ["pier"] });
    const newer = episode(3, { cues: ["pier"] });
    expect(rankRecall([older, pinned, newer], turns("At the pier."))).toEqual([
      pinned,
      newer,
      older,
    ]);
  });

  it("scans only the latest turns", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => episode(i, { cues: ["pier"] }));
    expect(rankRecall(candidates, turns("At the pier."))).toHaveLength(6);
    expect(rankRecall(candidates, turns("At the pier.", "a", "b", "c", "d"))).toEqual([]);
  });

  it("reads only the scanned turns' last words, a phrase found wherever it stands in them", () => {
    const bell = episode(1, { cues: ["harbour bell"] });
    const filler = Array.from({ length: MEMORY_LIMITS.recall.words }, () => "wave").join(" ");
    expect(rankRecall([bell], turns(`The harbour bell rang. ${filler}`))).toEqual([]);
    const late = `${filler} ${filler} the harbour harbour bell rang`;
    expect(rankRecall([bell], turns(late))).toEqual([bell]);
  });
});

describe("fitRecall", () => {
  /** The rule as stated: each in rank order while the whole block with it fits. */
  function exactly(ranked: readonly StoredEpisode[], room: number, max: number) {
    const chosen: StoredEpisode[] = [];
    let others = 0;
    for (const candidate of ranked) {
      if (!candidate.pinned && others >= max) break;
      if (memoryRecalledText([...chosen, candidate]).length > room) continue;
      chosen.push(candidate);
      if (!candidate.pinned) others += 1;
    }
    return chosen;
  }

  const ranked = [40, 7, 300, 12, 90, 3, 55, 1].map((size, i) =>
    episode(i + 1, { pinned: i < 3, summary: "z".repeat(size) }),
  );

  it("chooses what the whole block's count chooses, at every edge of the room", () => {
    const length = (text: string) => text.length;
    const edges = new Set<number>();
    for (let kept = 0; kept <= ranked.length; kept += 1) {
      const block = memoryRecalledText(ranked.slice(0, kept)).length;
      for (const room of [block - 1, block, block + 1]) edges.add(room);
    }
    for (const room of edges) {
      for (const max of [0, 2, 4]) {
        expect(fitRecall(ranked, length, room, max)).toEqual(exactly(ranked, room, max));
      }
    }
  });

  it("drops the last chosen while the whole block is over, for a count that does not add up", () => {
    // Joined, the block counts more than its parts: the running total says it fits, the block does not.
    const lumpy = (text: string) => text.length + (text.split("Episode").length - 1) ** 2;
    const room = memoryRecalledText(ranked.slice(0, 4)).length + 4;
    const chosen = fitRecall(ranked, lumpy, room);
    expect(lumpy(memoryRecalledText(chosen))).toBeLessThanOrEqual(room);
    expect(chosen).toEqual(ranked.slice(0, chosen.length));
    expect(chosen.length).toBeGreaterThan(0);
  });

  it("never recalls an episode with a chapter that holds it, through any chapter between", () => {
    const outer = episode(20, { kind: "chapter" });
    const inner = episode(19, { kind: "chapter", chapterId: outer.id });
    const member = episode(3, { chapterId: inner.id });
    const other = episode(4);
    const length = (text: string) => text.length;
    // The chapter between is not ranked (it matched nothing), yet links the member to the outer one.
    expect(
      fitRecall([outer, member, other], length, 10_000, 4, [outer, inner, member, other]),
    ).toEqual([outer, other]);
    expect(
      fitRecall([member, outer, other], length, 10_000, 4, [outer, inner, member, other]),
    ).toEqual([member, other]);
  });

  it("recalls a chapter's member when the chapter itself was not chosen", () => {
    // A chapter in the story block is no candidate: its members stay recallable.
    const chapter = episode(20, { kind: "chapter" });
    const member = episode(3, { chapterId: chapter.id, cues: ["pier"] });
    const length = (text: string) => text.length;
    expect(fitRecall([member], length, 10_000, 4, [member])).toEqual([member]);
    // A chapter too large for the room leaves the member free to go in.
    const big = episode(21, { kind: "chapter", summary: "z".repeat(5_000) });
    const held = episode(5, { chapterId: big.id });
    expect(fitRecall([big, held], length, 1_000)).toEqual([held]);
  });

  it("counts each candidate once, however many are pinned", () => {
    const pins = Array.from({ length: 2_000 }, (_, i) => episode(i, { pinned: true }));
    let calls = 0;
    const counted = (text: string) => {
      calls += 1;
      return estimateTokens(text);
    };
    const chosen = fitRecall(pins, counted, 10_000);
    expect(chosen.length).toBeGreaterThan(100);
    expect(chosen.length).toBeLessThan(pins.length);
    expect(calls).toBeLessThanOrEqual(pins.length + 3);
  });
});

describe("the recap rule", () => {
  // e1 and e2 went into c1, which went with e3 into c2; e4 stands alone.
  const c2 = episode(11, { kind: "chapter" });
  const c1 = episode(10, { kind: "chapter", chapterId: c2.id });
  const [e1, e2, e3, e4] = [1, 2, 3, 4].map((seq) =>
    episode(seq, seq === 4 ? {} : { chapterId: seq === 3 ? c2.id : c1.id }),
  );
  if (e1 === undefined || e2 === undefined || e3 === undefined || e4 === undefined) {
    throw new Error("episodes");
  }
  const book = [e1, e2, e3, e4, c1, c2];
  const ids = (episodes: readonly StoredEpisode[]) => episodes.map((stored) => stored.id);

  it("replaces absorbed members by their outermost chapter, in order, once, dropping unknown ids", () => {
    expect(ids(reconcileRecap([id(999), e1.id, e2.id, e3.id, e4.id], book))).toEqual([
      c2.id,
      e4.id,
    ]);
    expect(ids(reconcileRecap([e4.id, c1.id, e4.id], book))).toEqual([e4.id, c2.id]);
  });

  it("puts a member whose chapter is gone back in its own place", () => {
    expect(ids(reconcileRecap([e3.id, e4.id], [e3, e4]))).toEqual([e3.id, e4.id]);
  });

  it("answers the folded recap with a written chapter first and the new episode apart", () => {
    const fresh = episode(12);
    expect(recapAfter([e1.id, e4.id], [...book, fresh], { episode: fresh })).toEqual([
      c2.id,
      e4.id,
    ]);
    const chapter = episode(13, { kind: "chapter" });
    expect(recapAfter([id(998), e4.id], [e4, fresh, chapter], { episode: fresh, chapter })).toEqual(
      [chapter.id, e4.id],
    );
    // A retry that already carries the episode still answers it apart.
    expect(recapAfter([e4.id, fresh.id], [e4, fresh], { episode: fresh })).toEqual([e4.id]);
  });

  it("gives the earlier memories from this chat first, else the book's latest top-level ones", () => {
    expect(ids(previousEpisodes([c2, e4], book))).toEqual([c2.id, e4.id]);
    const many = [1, 2, 3, 4, 5].map((seq) => episode(seq));
    expect(ids(previousEpisodes(many, [...book, ...many]))).toEqual(ids(many.slice(2)));
    // Another chat's latest are no context for this chat's span while it has its own.
    const another = episode(30);
    expect(ids(previousEpisodes([e4], [...book, another]))).toEqual([e4.id]);
    // Without its own, members a chapter holds are left out, in story order.
    expect(ids(previousEpisodes([], [another, ...book]))).toEqual([c2.id, e4.id, another.id]);
  });

  it("takes the latest of the book's story by story order, a later chapter of older scenes not first", () => {
    // e1 to e5 went into a chapter written after e6 to e11.
    const chapter = episode(60, { kind: "chapter" });
    const older = [1, 2, 3, 4, 5].map((seq) => episode(40 + seq, { chapterId: chapter.id }));
    const later = [6, 7, 8, 9, 10, 11].map((seq) => episode(40 + seq));
    const story = [...older, ...later, chapter];
    expect(ids(previousEpisodes([], story))).toEqual(ids(later.slice(-3)));
    expect(ids(bookStory(story))).toEqual(ids([chapter, ...later]));
    // A chat's own memories are never the story before it.
    const own = new Set(later.slice(-2).map((stored) => stored.id));
    expect(ids(bookStory(story, own))).toEqual(ids([chapter, ...later.slice(0, -2)]));
  });

  it("keeps the newest of a story that its estimate fits, in story order", () => {
    const story = [1, 2, 3, 4].map((seq) => episode(seq, { summary: "z".repeat(396) }));
    const each = estimateTokens(`Episode 1. ${"z".repeat(396)}`);
    expect(latestWithin(story, each * 2)).toEqual(story.slice(2));
    expect(latestWithin(story, each * 2 - 1)).toEqual(story.slice(3));
    expect(latestWithin(story, 0)).toEqual([]);
    expect(latestWithin(story, each * 10)).toEqual(story);
  });

  it("tells a chat the newest of the story outside it that fits the story block's share", () => {
    const story = [1, 2, 3, 4].map((seq) => episode(seq, { summary: "z".repeat(396) }));
    const each = estimateTokens(`Episode 1. ${"z".repeat(396)}`);
    const window = Math.ceil((each * 2) / MEMORY_LIMITS.share);
    expect(storyBefore(story, window)).toEqual(story.slice(2));
    const own = new Set([story[3]?.id ?? ""]);
    expect(storyBefore(story, window, own)).toEqual(story.slice(1, 3));
  });

  it("grows the recap budget with the window, floored, capped by the owner's setting", () => {
    const small = recapBudget(32_000, emptyNotebook());
    const large = recapBudget(200_000, emptyNotebook());
    expect(large).toBeGreaterThan(small);
    expect(large).toBe(
      Math.floor(MEMORY_LIMITS.share * 200_000 * (1 - MEMORY_LIMITS.recallReserve)),
    );
    const full = {
      situation: "s".repeat(MEMORY_LIMITS.situation),
      relationships: [],
      facts: Array.from({ length: MEMORY_LIMITS.facts }, () => "f".repeat(MEMORY_LIMITS.line)),
      threads: [],
      cast: [],
    };
    expect(recapBudget(200_000, full)).toBeLessThan(large);
    // Relationships weigh as the other lines do.
    const related = { ...full, relationships: ["r".repeat(MEMORY_LIMITS.line)] };
    expect(recapBudget(200_000, related)).toBeLessThan(recapBudget(200_000, full));
    expect(recapBudget(8_000, full)).toBe(MEMORY_LIMITS.recapTokens.min);
    expect(recapBudget(200_000, emptyNotebook(), 5_000)).toBe(5_000);
    expect(recapBudget(8_000, emptyNotebook(), 5_000)).toBe(MEMORY_LIMITS.recapTokens.min);
  });

  it("rolls up the oldest half, the newest kept, only past the weight or the count", () => {
    const recap = Array.from({ length: MEMORY_LIMITS.recapCount + 1 }, (_, seq) => episode(seq));
    expect(rollupMembers(recap, MEMORY_LIMITS.recapTokens.max)).toEqual(
      recap.slice(0, Math.floor(recap.length / 2)),
    );
    expect(rollupMembers(recap.slice(0, 10), MEMORY_LIMITS.recapTokens.max)).toEqual([]);
    // Past the weight, three episodes merge only the oldest, which is too few.
    expect(rollupMembers(recap.slice(0, 3), 1)).toEqual([]);
    expect(rollupMembers(recap.slice(0, 4), 1)).toEqual(recap.slice(0, 2));
  });
});

describe("memory on by default", () => {
  it("is on for a character without a notebook row, and off only once turned off", () => {
    expect(memoryIsOn(null)).toBe(true);
    expect(memoryIsOn({ enabled: true })).toBe(true);
    expect(memoryIsOn({ enabled: false })).toBe(false);
  });

  it("reads a character without a notebook row as on, its notebook empty at revision 0", () => {
    expect(memoryStateOf(null)).toEqual({
      enabled: true,
      notebook: emptyNotebook(),
      opening: "",
      revision: 0,
      updatedAt: 0,
    });
    const off = {
      enabled: false,
      notebook: emptyNotebook(),
      opening: "",
      revision: 4,
      updatedAt: 9,
    };
    expect(memoryStateOf(off)).toBe(off);
  });
});

describe("the lazy fold", () => {
  /** Fits a history of `total` turns into `room`, leaving out what does not fit; never fits below `floor` room. */
  const fitter = (total: number, room: number, floor = 0) => {
    const attempts: number[] = [];
    const run = (held: { turns: number }[]) =>
      foldToFit(
        held,
        (spans, turns) => {
          attempts.push(spans);
          return total - turns;
        },
        (left) => (room < floor ? { ok: false } : { ok: true, trimmed: Math.max(0, left - room) }),
      );
    return { attempts, run };
  };
  const spans = (...turns: number[]) => turns.map((count) => ({ turns: count }));

  it("folds nothing while the history fits whole", () => {
    const { attempts, run } = fitter(20, 20);
    expect(run(spans(4, 4, 4))).toEqual({ result: 20, spans: 0, turns: 0 });
    expect(attempts).toEqual([0]);
  });

  it("folds the fewest oldest spans whose turns cover what the fit trimmed", () => {
    const { attempts, run } = fitter(20, 15);
    expect(run(spans(2, 2, 4, 4))).toMatchObject({ spans: 3, turns: 8 });
    expect(attempts).toEqual([0, 3]);
  });

  it("folds every span, then stops, when even that leaves history out or nothing fits", () => {
    const trimmed = fitter(20, 5);
    expect(trimmed.run(spans(2, 3))).toMatchObject({ spans: 2, turns: 5 });
    expect(trimmed.attempts).toEqual([0, 2]);
    // Nothing fits at all: one more span each time, once per span plus one.
    const none = fitter(20, 5, 10);
    expect(none.run(spans(1, 1, 1, 1))).toMatchObject({ spans: 4, turns: 4 });
    expect(none.attempts).toEqual([0, 1, 2, 3, 4]);
  });

  it("folds the spans past the held bound at once, so a request assembles a bounded number of times", () => {
    const past = 3;
    const many = spans(...Array.from({ length: MEMORY_LIMITS.held + past }, () => 1));
    const whole = fitter(200, 200);
    expect(whole.run(many)).toMatchObject({ spans: past, turns: past });
    expect(whole.attempts).toEqual([past]);
    const none = fitter(200, 5, 10);
    expect(none.run(many)).toMatchObject({ spans: many.length, turns: many.length });
    expect(none.attempts).toHaveLength(MEMORY_LIMITS.held + 1);
    expect(none.attempts[0]).toBe(past);
  });
});

describe("storyOrder", () => {
  const ids = (episodes: readonly StoredEpisode[]) => episodes.map((stored) => stored.id);

  it("places a chapter at the earliest scene it holds, through nested chapters", () => {
    const inner = episode(5, { kind: "chapter" });
    const outer = episode(8, { kind: "chapter" });
    const book = [
      episode(1, { chapterId: inner.id }),
      episode(2, { chapterId: inner.id }),
      { ...inner, chapterId: outer.id },
      episode(3, { chapterId: outer.id }),
      episode(6),
      { ...outer },
    ];
    const lone = episode(4, { kind: "chapter" });
    // The outer chapter tells scene 1 on; a chapter whose scenes the book lacks keeps its seq.
    const sixth = episode(6);
    expect(ids(storyOrder([sixth, lone, outer], book))).toEqual([outer.id, lone.id, sixth.id]);
    expect(ids(storyOrder([sixth, { ...inner, chapterId: outer.id }], book))).toEqual([
      inner.id,
      sixth.id,
    ]);
  });
});
