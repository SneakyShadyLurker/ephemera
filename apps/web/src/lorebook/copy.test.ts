import { type EntrySettings, entrySettings, type LorebookEntry } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_HELP,
  chainingAnswer,
  chainingOffNote,
  entryCues,
  entrySource,
  keywordsHelp,
  LOGIC_TEXT,
  matchingAnswer,
  placementAnswer,
  secondaryConsequence,
  timingAnswer,
  timingSentence,
} from "./copy.ts";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: ["lantern"],
  content: "",
  settings: {},
  enabled: true,
  insertionOrder: 40,
  useRegex: false,
  ...overrides,
});

/** The effective settings of an entry whose settings are `settings`. */
const settings = (
  settings: NonNullable<LorebookEntry["settings"]>,
  overrides: Partial<LorebookEntry> = {},
) => entrySettings(entry({ ...overrides, settings }));

const timing = (sticky: number, cooldown: number, delay: number) =>
  ({ sticky, cooldown, delay }) satisfies Pick<EntrySettings, "sticky" | "cooldown" | "delay">;

describe("the keywords' help", () => {
  it("follows whole words, patterns and Always on", () => {
    expect(keywordsHelp(settings({}), false, false)).toBe(
      "Enter or a comma adds one. A single word matches whole words; a phrase matches anywhere in a message. Write /pattern/ for a regular expression.",
    );
    expect(keywordsHelp(settings({ wholeWords: false }), false, false)).toBe(
      "Enter or a comma adds one. A keyword matches anywhere in a message. Write /pattern/ for a regular expression.",
    );
    expect(keywordsHelp(settings({}), false, true)).toContain(
      "The card makes every keyword a regular expression.",
    );
    expect(keywordsHelp(settings({}), true, false)).toBe(ALWAYS_ON_HELP);
  });
});

describe("the secondary condition", () => {
  it("reads as one sentence for each logic", () => {
    const sentence = (logic: keyof typeof LOGIC_TEXT) =>
      `Goes in only if the messages ${LOGIC_TEXT[logic].label} these:`;
    expect(sentence("andAny")).toBe("Goes in only if the messages also have any of these:");
    expect(sentence("andAll")).toBe("Goes in only if the messages also have all of these:");
    expect(sentence("notAny")).toBe("Goes in only if the messages have none of these:");
    expect(sentence("notAll")).toBe("Goes in only if the messages don't have all of these:");
    expect(LOGIC_TEXT.notAll.description).toBe(
      "NOT ALL: goes in unless every one of them is there, so one, some or none will do",
    );
  });

  it("says what a refused pattern does to each condition", () => {
    expect(secondaryConsequence("andAll", 1, 2)).toBe(
      "This pattern never matches, so 'also have all of' can never be met.",
    );
    expect(secondaryConsequence("andAny", 1, 2)).toBe(
      "This pattern never matches; the other words still count.",
    );
    expect(secondaryConsequence("andAny", 2, 2)).toBe(
      "These patterns never match, so 'also have any of' can never be met.",
    );
    expect(secondaryConsequence("notAny", 1, 3)).toBe(
      "This pattern never matches, so it never keeps the entry out.",
    );
    expect(secondaryConsequence("notAll", 1, 3)).toBe(
      "This pattern never matches, so 'don't have all of' is always met.",
    );
  });
});

describe("where it goes", () => {
  it("answers with the place and the order", () => {
    expect(placementAnswer(settings({ placement: "after" }), 40)).toBe(
      "After the character, order 40",
    );
    expect(placementAnswer(settings({}), 100)).toBe("Before the character, order 100");
    expect(placementAnswer(settings({ placement: "anTop" }), 5)).toBe(
      "Above the Author's Note, order 5",
    );
    expect(placementAnswer(settings({ placement: "examplesBottom" }), 5)).toBe(
      "After the example dialogue, order 5",
    );
    expect(placementAnswer(settings({ placement: "depth", depth: 4, role: "system" }), 40)).toBe(
      "In the chat at depth 4 as system, order 40",
    );
    expect(placementAnswer(settings({ placement: "depth", depth: 0, role: "assistant" }), 40)).toBe(
      "In the chat after the last message as assistant, order 40",
    );
  });
});

describe("when it goes in", () => {
  it("builds the sentence delay first, never promising the entry is sent", () => {
    expect(timingSentence(timing(0, 0, 0))).toBe("No timing limits.");
    expect(timingSentence(timing(3, 2, 4))).toBe(
      "Can't go in before the chat has 4 messages. Once in, it stays in for 3 more messages, then can't come back for 2.",
    );
    expect(timingSentence(timing(0, 2, 0))).toBe("Once in, it can't come back for 2 messages.");
    expect(timingSentence(timing(1, 0, 0))).toBe("Once in, it stays in for 1 more message.");
    expect(timingSentence(timing(0, 1, 1))).toBe(
      "Can't go in before the chat has 1 message. Once in, it can't come back for 1 message.",
    );
    expect(timingSentence(timing(4, 0, 2))).toBe(
      "Can't go in before the chat has 2 messages. Once in, it stays in for 4 more messages.",
    );
  });

  it("answers with the strongest restriction first", () => {
    expect(timingAnswer(timing(0, 0, 0))).toBe("No timing limits");
    expect(timingAnswer(timing(3, 2, 4))).toBe(
      "Not before 4 messages, stays in for 3 more, then rests for 2",
    );
    expect(timingAnswer(timing(0, 2, 0))).toBe("Rests for 2 messages after going in");
    expect(timingAnswer(timing(5, 0, 0))).toBe("Stays in for 5 more");
    expect(timingAnswer(timing(5, 0, 0), 25)).toBe(
      "25% chance when it matches, stays in for 5 more",
    );
  });
});

describe("what brings it in", () => {
  it("reads native recursion flags as one choice", () => {
    expect(entrySource(settings({}))).toBe("keywordsOrEntry");
    expect(entrySource(settings({ excludeRecursion: true }))).toBe("keywordsOnly");
    expect(entrySource(settings({ recursiveOnly: true }))).toBe("entryOnly");
    expect(entrySource(settings({ recursiveOnly: true }))).toBe("entryOnly");
    expect(entrySource(settings({ excludeRecursion: true, recursiveOnly: true }))).toBe(null);
  });

  it("answers for the book first, then the entry", () => {
    expect(chainingAnswer(settings({}), false)).toBe("The book doesn't chain entries");
    expect(chainingAnswer(settings({}), true)).toBe(
      "Its keywords or another entry, and its text can bring in others",
    );
    expect(chainingAnswer(settings({ excludeRecursion: true, preventRecursion: true }), true)).toBe(
      "Its keywords only, and its text brings in no other entry",
    );
    expect(chainingAnswer(settings({ recursiveOnly: true }), true)).toBe(
      "Another entry only, and its text can bring in others",
    );
    expect(chainingAnswer(settings({ excludeRecursion: true, recursiveOnly: true }), true)).toBe(
      "Never goes in: its settings rule each other out",
    );
  });

  it("says an entry that only another entry brings in stays out while the book doesn't chain", () => {
    const entryOnly = settings({ recursiveOnly: true });
    expect(chainingAnswer(entryOnly, false)).toBe(
      "Never goes in while the book doesn't chain entries",
    );
    expect(chainingOffNote(entryOnly)).toBe(
      "The book doesn't chain entries, so this entry stays out until it does or you choose another way in.",
    );
    expect(chainingOffNote(settings({}))).toBe(
      "The book doesn't chain entries, so these have no effect here.",
    );
  });
});

describe("what it matches", () => {
  it("names the entry's own settings first", () => {
    expect(matchingAnswer(settings({}), 4)).toBe("Book's 4 messages, any case, whole words");
    expect(matchingAnswer(settings({ wholeWords: false }), 4)).toBe(
      "Inside words too, book's 4 messages, any case",
    );
    expect(matchingAnswer(settings({ scanDepth: 1, caseSensitive: true }), 4)).toBe(
      "Last 1 message, matching case, whole words",
    );
    // An explicit default stays explicit, and is named first like any override.
    expect(matchingAnswer(settings({ wholeWords: true }), 2)).toBe(
      "Whole words, book's 2 messages, any case",
    );
    // An explicit case setting is named first.
    expect(matchingAnswer(settings({ caseSensitive: true }), 2)).toBe(
      "Matching case, book's 2 messages, whole words",
    );
  });
});

describe("list cues", () => {
  const cues = (overrides: Partial<LorebookEntry>) => {
    const item = entry(overrides);
    return entryCues(item, entrySettings(item)).map((cue) =>
      cue.ink ? `[${cue.text}]` : cue.text,
    );
  };

  it("put the consequential first, before the keywords", () => {
    expect(cues({})).toEqual([]);
    expect(cues({ settings: { placement: "depth", depth: 4, role: "system", sticky: 2 } })).toEqual(
      ["Depth 4", "system", "timing set"],
    );
    expect(cues({ enabled: false })).toEqual(["[Off]"]);
    expect(cues({ settings: { recursiveOnly: true, delay: 2 } })).toEqual([
      "chained only",
      "timing set",
    ]);
    expect(cues({ settings: { excludeRecursion: true, recursiveOnly: true } })).toEqual([
      "[never goes in]",
    ]);
    expect(cues({ settings: { useProbability: true, probability: 10, sticky: 1 } })).toEqual([
      "timing set",
      "10% chance",
    ]);
    // An always-on entry's chance is shown beside "By chance", not as a cue.
    expect(cues({ constant: true, settings: { useProbability: true, probability: 10 } })).toEqual(
      [],
    );
    expect(cues({ settings: { placement: "anTop" } })).toEqual(["Above"]);
    expect(cues({ settings: { placement: "examplesBottom" } })).toEqual(["After"]);
  });
});
