import { describe, expect, it } from "vitest";
import { endNote, problemsNote } from "./notes.ts";

describe("problemsNote", () => {
  it("names what is missing or unfinished, as the card shows it", () => {
    expect(
      problemsNote([
        { code: "missing", section: "firstMessage" },
        { code: "incomplete", section: "creatorNotes" },
      ]),
    ).toBe("The opening is missing and the tagline was left unfinished. Rewrite to try again.");
  });

  it("says counts in words against what belongs", () => {
    expect(problemsNote([{ code: "subject_count", count: 4, min: 2, max: 3 }])).toBe(
      "Four characters were written where at most three fit. Rewrite to try again.",
    );
    expect(problemsNote([{ code: "subject_count", count: 1, min: 2, max: 3 }])).toBe(
      "One character was written where at least two belong. Rewrite to try again.",
    );
    expect(problemsNote([{ code: "subject_count", count: 2, min: 1, max: 1 }])).toBe(
      "Two characters were written where only one fits. Rewrite to try again.",
    );
    expect(problemsNote([{ code: "subject_count", count: 0, min: 1, max: 1 }])).toBe(
      "No characters were written. Rewrite to try again.",
    );
  });

  it("names a character by its title and a scenario's missing parts", () => {
    expect(
      problemsNote([{ code: "block_tags", block: "mara_voss" }, { code: "scenario_blocks" }]),
    ).toBe(
      "Mara Voss is missing a part or has them out of order and the description is not just its Roleplay, Setting, People and Tone, in that order. Rewrite to try again.",
    );
  });

  it("names three problems once each and counts the rest", () => {
    expect(
      problemsNote([
        { code: "missing", section: "name" },
        { code: "incomplete", section: "firstMessage" },
        { code: "incomplete", section: "firstMessage" },
        { code: "too_long", section: "description" },
        { code: "scenario_blocks" },
        { code: "subject_count", count: 0, min: 1, max: 1 },
      ]),
    ).toBe(
      "The name is missing, the opening was left unfinished and the description is longer than a card allows. Two more things are off. Rewrite to try again.",
    );
  });
});

describe("endNote", () => {
  it("says the model ran out of room for a cut card, and suggests a lower effort", () => {
    const note = endNote({ status: "failed", failure: "cut", problems: [] });
    expect(note).toContain("ran out of room");
    expect(note).toContain("lower reasoning effort");
  });

  it("says the provider's filter stopped a filtered card, and suggests another model", () => {
    const note = endNote({ status: "failed", failure: "filtered", problems: [] });
    expect(note).toContain("filter");
    expect(note).toContain("another model");
  });

  it("keeps the general notes for the other endings, and none while writing", () => {
    expect(endNote({ status: "failed", failure: "upstream", problems: [] })).toBe(
      "The model stopped before the card was complete. Rewrite to try again.",
    );
    expect(
      endNote({
        status: "invalid",
        failure: null,
        problems: [{ code: "missing", section: "name" }],
      }),
    ).toBe("The name is missing. Rewrite to try again.");
    expect(endNote({ status: "writing", failure: null, problems: [] })).toBeNull();
    expect(endNote({ status: "complete", failure: null, problems: [] })).toBeNull();
  });
});
