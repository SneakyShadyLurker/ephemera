import {
  blankCard,
  type CharacterMemory,
  emptyMacroState,
  MEMORY_GREETING,
  type MemoryState,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { greetingChoices, memoryOpening } from "./greetings.ts";

/** Synthetic values only. */
const card = {
  ...blankCard("Mira"),
  firstMessage: "Hello, {{user}}.",
  alternateGreetings: ["", "Again, {{user}}."],
};
const subject = {
  character: card,
  persona: { name: "Ash", description: "" },
  prefer: { preferCharacterPrompt: true, preferCharacterInstructions: true },
};
const OPENING = "> Location: The quay, dusk\n\n{{user}} and Mira wait by the boats.";

describe("a new chat's greetings", () => {
  it("open on the memory's opening, then the card's greetings as swipes, each with its key and text", () => {
    const choices = greetingChoices(subject, emptyMacroState(), 1, OPENING);
    expect(choices.map(({ content, key, rawText }) => ({ content, key, rawText }))).toEqual([
      {
        content: "> Location: The quay, dusk\n\nAsh and Mira wait by the boats.",
        key: MEMORY_GREETING,
        rawText: OPENING,
      },
      { content: "Hello, Ash.", key: "card:0", rawText: "Hello, {{user}}." },
      // The blank alternate is skipped; the next keeps its place on the card.
      { content: "Again, Ash.", key: "card:2", rawText: "Again, {{user}}." },
    ]);
  });

  it("are the card's alone without an opening", () => {
    const choices = greetingChoices(subject, emptyMacroState(), 1, null);
    expect(choices.map(({ key, rawText }) => ({ key, rawText }))).toEqual([
      { key: "card:0", rawText: "Hello, {{user}}." },
      { key: "card:2", rawText: "Again, {{user}}." },
    ]);
  });
});

describe("the memory's opening", () => {
  const state = (change: Partial<MemoryState> = {}): MemoryState => ({
    enabled: true,
    notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
    opening: `  ${OPENING}\n`,
    revision: 2,
    updatedAt: 0,
    ...change,
  });
  const loaded = (memory: CharacterMemory) =>
    ({ data: memory, isPending: false, error: null, fetchStatus: "idle" }) as const;

  it("leads, trimmed, with the setting and memory on", () => {
    expect(memoryOpening(loaded({ state: state(), episodes: [] }), true)).toEqual({
      load: "ready",
      opening: OPENING,
    });
  });

  it("is none with the setting off, memory off, or nothing written", () => {
    expect(memoryOpening(loaded({ state: state(), episodes: [] }), false).opening).toBeNull();
    expect(
      memoryOpening(loaded({ state: state({ enabled: false }), episodes: [] }), true).opening,
    ).toBeNull();
    expect(
      memoryOpening(loaded({ state: state({ opening: " " }), episodes: [] }), true).opening,
    ).toBeNull();
    expect(memoryOpening(loaded({ state: null, episodes: [] }), true).opening).toBeNull();
  });

  it("holds the fill while the memory loads, and leaves the card's once its load failed", () => {
    const pending = {
      data: undefined,
      isPending: true,
      error: null,
      fetchStatus: "fetching",
    } as const;
    expect(memoryOpening(pending, true)).toEqual({ load: "loading", opening: null });
    // With the setting off nothing waits for it.
    expect(memoryOpening(pending, false).load).toBe("ready");
    expect(
      memoryOpening(
        { data: undefined, isPending: false, error: new Error("unavailable"), fetchStatus: "idle" },
        true,
      ),
    ).toEqual({ load: "ready", opening: null });
    // A character gone has no memory, whatever was loaded before.
    expect(
      memoryOpening(
        {
          data: { state: state(), episodes: [] },
          isPending: false,
          error: new Error("not_found"),
          fetchStatus: "idle",
        },
        true,
      ),
    ).toEqual({ load: "ready", opening: null });
  });
});
