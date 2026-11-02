import { MEMORY_REFUSALS, OPENING_REFUSALS } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { failureNote, openingFailureNote } from "./failure.ts";
import type { OpeningWriteFailure } from "./memory.ts";
import type { RememberFailure } from "./queries.ts";

const EVERY: readonly RememberFailure[] = [
  ...MEMORY_REFUSALS,
  "unreachable",
  "signed_out",
  "timeout",
  "too_large",
  "invalid",
];

describe("a failed memory call", () => {
  it("says what failed, in its own words, for every reason", () => {
    const texts = EVERY.map((reason) => failureNote(reason).text);
    expect(new Set(texts).size).toBe(EVERY.length);
  });

  it("says a refusal the server answered with did not write the memory", () => {
    for (const reason of EVERY.filter(
      (other) => other !== "unreachable" && other !== "signed_out",
    )) {
      expect(failureNote(reason).text).toMatch(/^The memory was not written/);
    }
  });

  it("says an answer that never came leaves the outcome unconfirmed, its turns read-only, and Try again recovers it", () => {
    for (const reason of ["unreachable", "signed_out"] as const) {
      const { text, action } = failureNote(reason);
      expect(text).toMatch(/^Could not confirm the memory was written: /);
      expect(text).toMatch(/Those turns stay read-only until confirmed\. Try again recovers it\.$/);
      expect(text).not.toMatch(/not written/);
      expect(action).toBe("retry");
    }
  });

  it("points a failure another call would repeat at what fixes it", () => {
    expect(failureNote("context_window_unknown").action).toBe("window");
    expect(failureNote("prompt_too_long").action).toBe("settings");
    expect(failureNote("too_large").action).toBe("settings");
    expect(failureNote("too_many_memories").action).toBe("memory");
    expect(failureNote("too_many_chat_memories").action).toBe("memory");
  });

  it("offers Try again where another call may succeed", () => {
    for (const reason of [
      "unreachable",
      "signed_out",
      "timeout",
      "memory_failed",
      "upstream_busy",
      "memory_off",
    ] as const) {
      expect(failureNote(reason).action).toBe("retry");
    }
    expect(failureNote("upstream_busy").text).toBe(
      "The memory was not written: the memory model is busy. Try again in a moment.",
    );
    expect(failureNote(null)).toEqual({ text: "The memory was not written.", action: "retry" });
  });

  it("never says memory is off: a refusal still shown came while memory reads on", () => {
    expect(failureNote("memory_off").text).not.toMatch(/off/i);
  });
});

describe("a failed opening call", () => {
  const EVERY_OPENING: readonly OpeningWriteFailure[] = [
    ...OPENING_REFUSALS,
    "unreachable",
    "signed_out",
    "timeout",
    "too_large",
    "invalid",
    "no_model",
    "unsaved",
  ];

  it("says the opening was not written, in its own words for every reason", () => {
    const texts = EVERY_OPENING.map((reason) => openingFailureNote(reason).text);
    expect(new Set(texts).size).toBe(EVERY_OPENING.length);
    for (const text of texts) expect(text).toMatch(/^The opening was not written/);
  });

  it("offers Try again where trying again can help, and Settings where they size the call", () => {
    expect(openingFailureNote("memory_failed").action).toBe("retry");
    expect(openingFailureNote("unreachable").action).toBe("retry");
    expect(openingFailureNote("context_window_unknown").action).toBe("window");
    expect(openingFailureNote("prompt_too_long").action).toBe("settings");
    expect(openingFailureNote("no_model").action).toBe("settings");
    // The notebook's edits could not be saved first: once they are, trying again can help.
    expect(openingFailureNote("unsaved")).toEqual({
      text: "The opening was not written: the notebook's edits must be saved first.",
      action: "retry",
    });
    expect(openingFailureNote("nothing_to_remember").action).toBeNull();
  });
});
