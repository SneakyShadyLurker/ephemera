import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { startReasoningMiddleware } from "../src/reasoning.ts";

/** A non-streamed reply whose text arrives in these pieces. */
const reply = async (pieces: string[]) => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: pieces.map((text) => ({ type: "text" as const, text })),
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  const result = await generateText({
    model: wrapLanguageModel({ model, middleware: startReasoningMiddleware("think") }),
    prompt: "Write",
  });
  return { text: result.text, reasoning: result.reasoningText };
};

describe("Auto-Parse on a non-streamed reply", () => {
  it("reads a leading block out as reasoning, the reply's leading space with it", async () => {
    expect(await reply(["  <think>plan</think>\n A prompt."])).toEqual({
      text: "A prompt.",
      reasoning: "plan",
    });
  });

  it("reads a block split across the reply's pieces as the stream does", async () => {
    expect(await reply(["<think>pl", "an</think>", " A prompt."])).toEqual({
      text: "A prompt.",
      reasoning: "plan",
    });
  });

  it("keeps a reply without a leading block, a later tag included, as text", async () => {
    expect(await reply(["A prompt.", " <think>not reasoning</think>"])).toEqual({
      text: "A prompt. <think>not reasoning</think>",
      reasoning: undefined,
    });
  });

  it("reads an unclosed block as reasoning only", async () => {
    expect(await reply(["<think>never closed"])).toEqual({
      text: "",
      reasoning: "never closed",
    });
  });
});
