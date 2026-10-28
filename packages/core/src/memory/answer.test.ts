import { describe, expect, it } from "vitest";
import { CAST_LIMITS } from "../cast/limits.ts";
import { CREATOR_LIMITS } from "../creator/limits.ts";
import { answerRoom, repairObject, unnamedAnswer } from "./answer.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import {
  chapterAnswerSchema,
  chapterOutputSchema,
  clampChapterOutput,
  clampMemoryAnswer,
  memoryAnswerSchema,
  type StoredEpisode,
} from "./memory.ts";
import { chapterCorrection, chapterInstructions } from "./prompt.ts";
import { chapterRoom, fitChapterMembers, memberTurns } from "./recap.ts";

const final = { title: "The harbour", summary: "Mara and Aria left at dawn.", cues: ["harbour"] };
const draft = { title: "Draft", summary: "A first try.", cues: ["try"] };

const member = (seq: number, extra: Partial<StoredEpisode> = {}): StoredEpisode => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  characterId: "00000000-0000-4000-8000-0000000000aa",
  seq,
  kind: "episode",
  turns: 2,
  chapterId: null,
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
  title: `Episode ${seq}`,
  summary: `What {{user}} did in scene ${seq}.`,
  cues: ["pier"],
  pinned: false,
  ...extra,
});

describe("repairObject", () => {
  it("takes the final object after a draft, not the draft", () => {
    const text = `Draft:\n${JSON.stringify(draft)}\nOn reflection, the final answer:\n${JSON.stringify(final)}`;
    expect(repairObject(text, chapterOutputSchema)).toEqual(final);
  });

  it("skips a stray brace in the prose before the object", () => {
    const text = `I keep the {cues short and the summary plain. ${JSON.stringify(final)} Done.`;
    expect(repairObject(text, chapterOutputSchema)).toEqual(final);
  });

  it("reads braces inside strings as text, and a fenced object", () => {
    const braces = { ...final, summary: 'She wrote "{" and "}" on the wall.' };
    const text = `\`\`\`json\n${JSON.stringify(braces)}\n\`\`\``;
    expect(repairObject(text, chapterOutputSchema)).toEqual(braces);
  });

  it("never takes an object nested in one that read as JSON", () => {
    // The outer object fails the schema; its nested one would pass it, but is part of it.
    const text = JSON.stringify({ answer: final });
    expect(repairObject(text, chapterOutputSchema)).toBeUndefined();
  });

  it("keeps the last object that validates when a later one does not", () => {
    const text = `${JSON.stringify(final)}\n${JSON.stringify({ title: "" })}`;
    expect(repairObject(text, chapterOutputSchema)).toEqual(final);
  });

  it("clamps before it validates, and finds nothing in plain prose or an unclosed object", () => {
    const long = { ...final, title: "x ".repeat(MEMORY_LIMITS.title) };
    const repaired = repairObject(JSON.stringify(long), chapterOutputSchema, clampChapterOutput);
    expect(repaired?.title.length).toBeLessThanOrEqual(MEMORY_LIMITS.title);
    expect(repairObject("I cannot.", chapterOutputSchema)).toBeUndefined();
    expect(repairObject(`{"title": "cut short`, chapterOutputSchema)).toBeUndefined();
    expect(repairObject(undefined, chapterOutputSchema)).toBeUndefined();
  });

  it("bounds its scan: thousands of unclosed braces end it instead of costing a pass each", () => {
    const strays = "{".repeat(100_000);
    // Each unclosed brace would scan to the end; the budget stops after a few such passes.
    expect(repairObject(`${strays} ${JSON.stringify(final)}`, chapterOutputSchema)).toBeUndefined();
    // A handful of strays stay well within it.
    expect(repairObject(`{ a { b ${JSON.stringify(final)}`, chapterOutputSchema)).toEqual(final);
  });
});

describe("unnamedAnswer", () => {
  for (const bound of ["line", "field"] as const) {
    it(`drops only cast edits expanded past the ${bound} bound without restoring persona names`, () => {
      const anchor =
        bound === "field"
          ? {
              name: "Ilse",
              gender: "female",
              relationship: `Al ${"x".repeat(CAST_LIMITS.field - 3)}`,
            }
          : {
              name: "Ilse",
              gender: "female",
              ...Object.fromEntries(
                ["age", "hair", "eyes", "skin", "face"].map((field) => [
                  field,
                  `Al ${"x".repeat(217)}`,
                ]),
              ),
            };
      const line = JSON.stringify(anchor);
      expect(line.length).toBeLessThanOrEqual(MEMORY_LIMITS.castLine);
      const answer = memoryAnswerSchema.parse({
        title: "Al arrives",
        summary: "Al meets Ilse",
        cues: ["Al"],
        notebook: {
          situation: "Al waits",
          relationships: {},
          facts: { add: ["Al trusts Ilse"] },
          threads: {},
          cast: {
            add: [line, JSON.stringify({ name: "Wren", gender: "female", relationship: "Met Al" })],
            change: [{ line: 1, text: line }],
          },
        },
        opening: "Al returns",
      });
      const result = unnamedAnswer(answer, ["Al"], memoryAnswerSchema, clampMemoryAnswer);
      expect(result.notebook.cast).toEqual({
        change: [],
        drop: [],
        add: [JSON.stringify({ name: "Wren", gender: "female", relationship: "Met {{user}}" })],
      });
      expect(result).toMatchObject({
        title: "{{user}} arrives",
        summary: "{{user}} meets Ilse",
        cues: ["{{user}}"],
        notebook: { situation: "{{user}} waits", facts: { add: ["{{user}} trusts Ilse"] } },
        opening: "{{user}} returns",
      });
      expect(memoryAnswerSchema.safeParse(result).success).toBe(true);
    });
  }

  it("writes the persona's name forms as {{user}} in every string, clamped again", () => {
    const answer = { ...final, summary: "Aria Lund met Mara. Aria smiled.", cues: ["Aria's boat"] };
    expect(
      unnamedAnswer(answer, ["Aria Lund", "Aria"], chapterOutputSchema, clampChapterOutput),
    ).toEqual({
      ...final,
      summary: "{{user}} met Mara. {{user}} smiled.",
      cues: ["{{user}}'s boat"],
    });
    expect(unnamedAnswer(answer, [], chapterOutputSchema, clampChapterOutput)).toBe(answer);
  });

  it("writes the persona's name as {{user}} in the next chat's opening too", () => {
    const answer = memoryAnswerSchema.parse({
      ...final,
      notebook: {
        situation: "Aria waits at the pier.",
        relationships: {},
        facts: {},
        threads: {},
      },
      opening: "> Location: The pier, dawn\n\nMara stands beside Aria Lund at the rail.",
    });
    const unnamed = unnamedAnswer(
      answer,
      ["Aria Lund", "Aria"],
      memoryAnswerSchema,
      clampMemoryAnswer,
    );
    expect(unnamed.opening).toBe(
      "> Location: The pier, dawn\n\nMara stands beside {{user}} at the rail.",
    );
    expect(unnamed.notebook.situation).toBe("{{user}} waits at the pier.");
  });
});

describe("answerRoom", () => {
  it("gives the window less the input, at most the creator's output", () => {
    const window = MEMORY_LIMITS.replyReserve + 100;
    expect(answerRoom(window, 100)).toBe(MEMORY_LIMITS.replyReserve);
    expect(answerRoom(window, 99.5)).toBe(MEMORY_LIMITS.replyReserve);
    expect(answerRoom(10_000_000, 1)).toBe(CREATOR_LIMITS.maxOutputTokens);
  });

  it("is null when the input leaves less than the reply's reserve", () => {
    expect(answerRoom(MEMORY_LIMITS.replyReserve + 10, 11)).toBeNull();
  });
});

describe("chapter roll-up", () => {
  it("fills the persona's name into the members the canon is matched against", () => {
    expect(memberTurns([member(1)], "Aria")).toEqual([
      { role: "assistant", content: "Episode 1\nWhat Aria did in scene 1.\npier" },
    ]);
  });

  it("halves the members until the input leaves room, two at least", () => {
    const members = [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => member(seq));
    // Room only for an input of three members or fewer.
    const fitted = fitChapterMembers(
      members,
      (merged) => merged.length,
      (size) => (size <= 3 ? 100 : null),
    );
    expect(fitted?.members.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(fitted?.room).toBe(100);
    expect(
      fitChapterMembers(
        members,
        (merged) => merged.length,
        () => 5,
      )?.members,
    ).toHaveLength(8);
    expect(
      fitChapterMembers(
        members,
        (merged) => merged.length,
        () => null,
      ),
    ).toBeNull();
  });

  it("sizes a chapter's summary by the recap it lives in, within an episode's and the largest", () => {
    expect(chapterRoom(MEMORY_LIMITS.recapTokens.min)).toBe(MEMORY_LIMITS.summary);
    expect(chapterRoom(MEMORY_LIMITS.recapTokens.max)).toBe(MEMORY_LIMITS.chapterSummary);
    expect(chapterRoom(1_000_000)).toBe(MEMORY_LIMITS.chapterSummary);
    // Open tabs validate stored summaries at an episode's bound, so a chapter's stays within it.
    expect(MEMORY_LIMITS.chapterSummary).toBe(MEMORY_LIMITS.summary);
  });

  it("tells the chapter call its room, and asks a summary past it to compress, not cut", () => {
    const names = { char: "Mara", user: "Aria" };
    expect(chapterInstructions(names, 3_000)).toContain("at most 3,000 characters");
    const long = "word ".repeat(2_400);
    const answer = chapterAnswerSchema.parse(
      clampChapterOutput({ ...final, summary: long }, Number.POSITIVE_INFINITY),
    );
    // Nothing of the answer was cut before the correction is asked for.
    expect(answer.summary).toBe(long.trim());
    expect(chapterCorrection(answer.summary, 3_000)).toContain(
      "That summary has 11,999 characters, past its bound of 3,000.",
    );
    expect(chapterCorrection(answer.summary, 3_000)).toContain("compressed to at most 3,000");
    expect(chapterCorrection(final.summary, 3_000)).toBeNull();
    // The bound holds when the correction still overshoots, cut at a word break.
    const cut = chapterOutputSchema.parse(clampChapterOutput(answer, 3_000));
    expect(cut.summary.length).toBeLessThanOrEqual(3_000);
    expect(cut.summary.endsWith("word")).toBe(true);
  });
});
