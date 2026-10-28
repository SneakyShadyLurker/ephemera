import type { ReworkCard } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { lineOf } from "./line.ts";
import type { Applied, ReworkState } from "./store.ts";

const CARD: ReworkCard = {
  name: "Ada Reed",
  description: "Ada is 24.",
  personality: "",
  scenario: "",
  firstMessage: "",
  alternateGreetings: [],
  exampleDialogue: "",
  systemPrompt: "",
  postHistoryInstructions: "",
  creatorNotes: "",
  tags: [],
  characterNote: null,
  lorebook: null,
};

const APPLIED: Applied = {
  written: { description: "Ada is 34." },
  previous: { description: "Ada is 24." },
  count: 2,
  counts: { description: 2 },
  converted: [],
  undone: null,
};

/** The fields `lineOf` reads, with a run's defaults. */
const state = (fields: Partial<ReworkState>) =>
  ({
    phase: "review",
    base: CARD,
    changes: [],
    ended: null,
    failure: null,
    applyProblem: null,
    applied: null,
    ...fields,
  }) as ReworkState;

describe("the dock's line", () => {
  const applied = state({ phase: "applied", applied: APPLIED });

  it("after Apply, follows the sheet's save status as the header says it", () => {
    expect(lineOf(applied, null, null, { kind: "saving" })).toEqual({
      text: "Applied 2 changes. Saving",
      announce: "Applied 2 changes.",
      failure: false,
    });
    expect(lineOf(applied, null, null, null).text).toBe("Applied 2 changes.");
    // A save the server refused, and a conflict that was there before Apply, are failures.
    expect(lineOf(applied, null, null, { kind: "invalid", field: "Description" })).toEqual({
      text: "Applied 2 changes. Not saved: Description is over the limit.",
      announce: "Applied 2 changes. Not saved: Description is over the limit.",
      failure: true,
    });
    expect(lineOf(applied, null, null, { kind: "conflict" })).toMatchObject({
      text: "Applied 2 changes. Not saved: changed in another tab.",
      failure: true,
    });
    // Signed out is expected: the renewal saves it.
    expect(lineOf(applied, null, null, { kind: "signed-out" })).toMatchObject({
      text: "Applied 2 changes. Not saved: signed out.",
      failure: false,
    });
    const undone = state({
      phase: "applied",
      applied: { ...APPLIED, undone: { restored: 2, skipped: [], kept: [] } },
    });
    expect(lineOf(undone, null, null, { kind: "unreachable" })).toMatchObject({
      text: "Undo restored 2 changes. Not saved: can't reach Ephemera. Retrying.",
      failure: true,
    });
    const held = state({
      phase: "applied",
      applied: {
        ...APPLIED,
        undone: { restored: 0, skipped: ["Personality"], kept: ["Description"] },
      },
    });
    expect(lineOf(held, null, null, null).text).toBe(
      "Undo restored 0 of 2 changes. Personality was edited since, so Description stayed as applied.",
    );
  });

  it("names the field a selection would break, while the review stays", () => {
    expect(
      lineOf(state({ applyProblem: { field: "Description", kind: "too_long" } }), null, null, null),
    ).toEqual({
      text: "Apply would make Description too long. Restore or reject a change in it.",
      announce: "Apply would make Description too long. Restore or reject a change in it.",
      failure: true,
    });
    expect(
      lineOf(state({ applyProblem: { field: "Name", kind: "empty" } }), null, null, null).text,
    ).toBe("Apply would leave Name empty. Restore or reject a change in it.");
  });

  it("says a refused card is not the model's cut-off, naming the field when it can", () => {
    const refused = { ended: "failed", failure: "invalid_request" } as const;
    expect(lineOf(state({ ...refused, base: { ...CARD, name: " " } }), null, null, null)).toEqual({
      text: "Ephemera can't send this card as it is: Name is empty.",
      announce: "Ephemera can't send this card as it is: Name is empty.",
      failure: true,
    });
    expect(lineOf(state(refused), null, null, null).text).toBe(
      "This card has a field Ephemera can't send as it is.",
    );
    expect(lineOf(state({ ended: "failed", failure: "stream" }), null, null, null).text).toBe(
      "The model stopped before it finished. No changes arrived.",
    );
  });
});
