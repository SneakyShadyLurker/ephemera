import type { BrainstormOption } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { MODEL_BUSY } from "@/lib/text";
import { ideasAlert, ideasStatus } from "./brainstorm-notes.ts";
import { BRAINSTORM_EMPTY, type BrainstormSession } from "./brainstorm-slice.ts";

const ideas = (count: number): BrainstormOption[] =>
  Array.from({ length: count }, (_, n) => ({
    pitch: `Idea ${n + 1}`,
    brief: `A placeholder brief ${n + 1}.`,
  }));

const session = (next: Partial<BrainstormSession>): BrainstormSession => ({
  ...BRAINSTORM_EMPTY,
  ...next,
});

describe("the brainstorm's status line", () => {
  it.each([
    [{ status: "idle" }, ""],
    [{ status: "classifying" }, "Reading your request"],
    [{ status: "writing" }, "Writing ideas"],
    [{ status: "writing", thinking: true }, "Thinking"],
    [{ status: "writing", thinking: true, incoming: ideas(1) }, "Writing ideas"],
    [{ status: "waiting" }, "Not sent yet: waiting for you to sign in."],
    [{ status: "complete", options: ideas(10) }, "Ten ideas."],
    [
      { status: "complete", options: ideas(8) },
      "8 ideas instead of ten. New ideas tries for the full ten.",
    ],
    [{ status: "stopped", options: ideas(3), arrived: 3 }, "Stopped. 3 ideas so far."],
    [{ status: "stopped", options: ideas(1), arrived: 1 }, "Stopped. 1 idea so far."],
    // Stopped on a replacement round before anything came: the previous list is back, unnamed.
    [{ status: "stopped", options: ideas(10), arrived: 0 }, "Stopped before any idea arrived."],
    [{ status: "failed", failure: "upstream", options: ideas(10) }, ""],
  ] as const)("%o says %j", (next, text) => {
    expect(ideasStatus(session(next))).toBe(text);
  });
});

describe("the brainstorm's alert", () => {
  it.each([
    ["upstream", "The model stopped before the ideas were done. New ideas to try again."],
    ["timeout", "The model stopped before the ideas were done. New ideas to try again."],
    ["stream", "The model stopped before the ideas were done. New ideas to try again."],
    ["upstream_busy", MODEL_BUSY],
    [
      "cut",
      "The model ran out of room before the ten were done. New ideas to try again, or choose a lower reasoning effort.",
    ],
    [
      "filtered",
      "The provider's filter stopped the ideas. New ideas to try again, or choose another model.",
    ],
    [
      "too_large",
      "The request and the earlier lists are too long for this model's context window. Start over, or choose another model.",
    ],
    ["kind_unclear", "This could be one person, several, or a place to go. Choose above."],
    [
      "unusable",
      "The ideas came back in a form the app cannot read. New ideas to try again, or choose another model.",
    ],
  ] as const)("%s says %j", (failure, text) => {
    expect(ideasAlert(failure)).toBe(text);
  });

  it("says nothing without a failure", () => {
    expect(ideasAlert(null)).toBeNull();
  });
});
