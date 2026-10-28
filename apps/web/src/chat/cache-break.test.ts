import type { InspectedPrompt } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { cacheBreak } from "./cache-break.ts";

type Message = InspectedPrompt["messages"][number];

const main: Message = {
  role: "system",
  content: "Write the next reply.",
  tokens: 10,
  source: { kind: "block", id: "main" },
};
const lorebook = (content: string): Message => ({
  role: "system",
  content,
  tokens: 20,
  source: { kind: "lorebook", position: "before", entries: 2 },
});
const turn = (index: number, content: string, tokens = 5): Message => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content,
  tokens,
  source: { kind: "history", index },
});
const prompt = (...messages: Message[]) => ({ model: "model-a", messages });

describe("cacheBreak", () => {
  it("finds no break when the next prompt only adds turns after everything sent", () => {
    const sent = prompt(main, lorebook("The harbour."), turn(0, "Hello"));
    const next = prompt(...sent.messages, turn(1, "Hi"), turn(2, "Again"));
    expect(cacheBreak(sent, next)).toEqual({ shared: { messages: 3, tokens: 35 }, at: null });
  });

  it("breaks at a changed lorebook block before the chat, counting what came before it", () => {
    const sent = prompt(main, lorebook("The harbour."), turn(0, "Hello"));
    const next = prompt(main, lorebook("A storm."), turn(0, "Hello"), turn(1, "Hi"));
    expect(cacheBreak(sent, next)).toEqual({ shared: { messages: 1, tokens: 10 }, at: 1 });
  });

  it("counts the shared start of the differing message, prorated by its characters", () => {
    // "The harbour, at d": 17 of the 20 characters match, so 17 of its 20 tokens.
    const sent = prompt(main, lorebook("The harbour, at dusk"));
    const next = prompt(main, lorebook("The harbour, at dawn"));
    const result = cacheBreak(sent, next);
    expect(result?.at).toBe(1);
    expect(result?.shared).toEqual({ messages: 1, tokens: 10 + 17 });
  });

  it("treats changed native speaker attribution as a difference in content", () => {
    const line = (name: string): Message => ({
      role: "user",
      content: `${name}: Hello`,
      tokens: 4,
      source: { kind: "example", index: 0, line: 0 },
    });
    const sent = prompt(main, line("Aria"), turn(0, "Hi"));
    const next = prompt(main, line("Maren"), turn(0, "Hi"));
    expect(cacheBreak(sent, next)).toEqual({ shared: { messages: 1, tokens: 10 }, at: 1 });
  });

  it("breaks at the end of a next prompt that stops before the last one did", () => {
    const sent = prompt(main, turn(0, "Hello"), turn(1, "Hi"), turn(2, "Again"));
    const next = prompt(main, turn(0, "Hello"));
    expect(cacheBreak(sent, next)).toEqual({ shared: { messages: 2, tokens: 15 }, at: 2 });
  });

  it("compares nothing across models, which share no cache", () => {
    const sent = prompt(main, turn(0, "Hello"));
    expect(cacheBreak(sent, { ...sent, model: "model-b" })).toBeNull();
  });
});
