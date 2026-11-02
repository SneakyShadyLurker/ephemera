import { describe, expect, it } from "vitest";
import { averageReplies, eventsSummary, ruleSentence, scopeSummary } from "./rule.ts";

const sentence = (fields: { chance: number; cooldown: number; enabled?: boolean }) => {
  const { lead, average } = ruleSentence({ enabled: true, ...fields });
  return average === null ? lead : `${lead} ${average}`;
};

describe("an event's rule sentence", () => {
  it("turns chance and quiet time into the average, in whole replies from 10 up", () => {
    expect(sentence({ chance: 1, cooldown: 15 })).toBe(
      "1% per reply, then quiet for 15. About once in 115 replies.",
    );
    expect(sentence({ chance: 5, cooldown: 30 })).toBe(
      "5% per reply, then quiet for 30. About once in 50 replies.",
    );
    expect(averageReplies(3, 0)).toBeCloseTo(33.33);
    expect(sentence({ chance: 3, cooldown: 0 })).toBe("3% per reply. About once in 33 replies.");
    expect(sentence({ chance: 0.1, cooldown: 0 })).toBe(
      "0.1% per reply. About once in 1,000 replies.",
    );
  });

  it("keeps one decimal below 10 replies, and says every reply only when it is", () => {
    expect(sentence({ chance: 70, cooldown: 0 })).toBe("70% per reply. About once in 1.4 replies.");
    expect(sentence({ chance: 50, cooldown: 2 })).toBe(
      "50% per reply, then quiet for 2. About once in 4 replies.",
    );
    expect(sentence({ chance: 100, cooldown: 1 })).toBe(
      "100% per reply, then quiet for 1. About once in 2 replies.",
    );
    expect(sentence({ chance: 15, cooldown: 0 })).toBe("15% per reply. About once in 6.7 replies.");
    expect(sentence({ chance: 100, cooldown: 0 })).toBe("100% per reply. Every reply.");
  });

  it("leads with Off for an event that is off, without an average", () => {
    expect(sentence({ chance: 1, cooldown: 15, enabled: false })).toBe(
      "Off. 1% per reply, then quiet for 15.",
    );
  });

  it("says an enabled event at 0% never fires", () => {
    expect(sentence({ chance: 0, cooldown: 15 })).toBe("Never fires at 0%.");
    expect(averageReplies(0, 15)).toBeNull();
  });
});

describe("an event's scope summary", () => {
  const names = new Map([
    ["mira", "Mira"],
    ["voss", "Captain Voss"],
    ["ash", "Ash"],
  ]);

  it("names all characters, or the chosen ones and the tags", () => {
    expect(scopeSummary({ kind: "all" }, names)).toBe("All characters");
    expect(
      scopeSummary({ kind: "selected", characters: ["mira", "voss"], tags: ["seafaring"] }, names),
    ).toBe('Mira, Captain Voss and cards tagged "seafaring"');
    expect(scopeSummary({ kind: "selected", characters: [], tags: ["a", "b", "c"] }, names)).toBe(
      'cards tagged "a", "b" or "c"',
    );
  });

  it("shortens past three with the count of the rest", () => {
    expect(
      scopeSummary(
        { kind: "selected", characters: ["mira", "voss", "ash"], tags: ["a", "b"] },
        names,
      ),
    ).toBe("Mira, Captain Voss and 3 more");
  });

  it("leaves out a deleted character and says when no one is chosen", () => {
    expect(scopeSummary({ kind: "selected", characters: ["gone", "ash"], tags: [] }, names)).toBe(
      "Ash",
    );
    expect(scopeSummary({ kind: "selected", characters: ["gone"], tags: [] }, names)).toBe(
      "Applies to no one yet.",
    );
  });
});

describe("eventsSummary", () => {
  it("counts the events and how many are on", () => {
    expect(eventsSummary([])).toBe("None yet");
    expect(eventsSummary([{ enabled: true }])).toBe("1 event, all on");
    expect(eventsSummary([{ enabled: true }, { enabled: false }, { enabled: true }])).toBe(
      "3 events, 2 on",
    );
    expect(eventsSummary([{ enabled: false }, { enabled: false }])).toBe("2 events, none on");
  });

  it("adds how many events could not be saved", () => {
    expect(eventsSummary([{ enabled: true }, { enabled: false }, { enabled: true }], 1)).toBe(
      "3 events, 2 on. 1 not saved",
    );
    expect(eventsSummary([], 1)).toBe("None yet. 1 not saved");
  });
});
