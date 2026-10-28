import { describe, expect, it } from "vitest";
import { BOUNDARY_BYTES_PER_TOKEN } from "../tokens.ts";
import { type Assembly, flatten, type PromptMessage } from "./assemble.ts";
import {
  calibrationRatio,
  DEFAULT_REPLY_RESERVE,
  type Fitted,
  fitPrompt,
  HISTORY_BLOCK_SHARE,
  historyBlockTokens,
  promptBudget,
  replyReserve,
} from "./budget.ts";

/** One token per character: budgets in tests read as lengths. */
const count = (message: { content: string }) => message.content.length;

const system = (content: string): PromptMessage => ({
  role: "system",
  content,
  source: { kind: "block", id: "main" },
});
const turn = (index: number, content: string): PromptMessage => ({
  role: index % 2 === 0 ? "assistant" : "user",
  content,
  source: { kind: "history", index },
});

/** An example message: its block's wrapper (line 0) or a named line. */
const example = (content: string, index: number, line: number): PromptMessage => ({
  ...system(content),
  source: { kind: "example", index, line },
});

/** 10 fixed, two 20-token example blocks, six 10-token turns, a 5-token injection at depth 2, 5 after. */
function assembly(): Assembly {
  return {
    lorebook: null,
    lorebookState: null,
    segments: [
      { kind: "fixed", message: system("m".repeat(10)) },
      {
        kind: "examples",
        // Each block is a wrapper and a line; a block goes or stays whole.
        blocks: [
          [example("e".repeat(10), 0, 0), example("E".repeat(10), 0, 1)],
          [example("f".repeat(10), 1, 0), example("F".repeat(10), 1, 1)],
        ],
      },
      {
        kind: "history",
        turns: Array.from({ length: 6 }, (_, i) => turn(i, String(i).repeat(10))),
        continues: false,
        injections: [{ depth: 2, message: { ...system("i".repeat(5)), role: "system" } }],
      },
      { kind: "fixed", message: system("p".repeat(5)) },
    ],
  };
}

const fitBudget = (budget: number, calibration = 1) =>
  fitPrompt({ assembly: assembly(), budget, count, priming: 0, calibration });

describe("budget", () => {
  it("is the window minus the reply reserve, with no margin", () => {
    expect(promptBudget(100_000, 4_000)).toBe(96_000);
    expect(promptBudget(1_000, 2_000)).toBe(0);
  });

  it("reserves the reply length, or a default when it is left to the model", () => {
    expect(replyReserve(800, 100_000)).toBe(800);
    expect(replyReserve(null, 100_000)).toBe(DEFAULT_REPLY_RESERVE);
    // The default never takes more than a quarter of a small window.
    expect(replyReserve(null, 4_096)).toBe(1_024);
  });

  it("sends everything when it fits", () => {
    const result = fitBudget(1_000);
    expect(result.ok && result.estimate).toBe(10 + 40 + 60 + 5 + 5);
    expect(result.ok && result.history).toEqual({ sent: 6, total: 6 });
    expect(result.ok && result.examples).toEqual({ sent: 2, total: 2 });
  });

  it("fits the exact message costs and global reply priming without selection padding", () => {
    const primed = (budget: number) =>
      fitPrompt({ assembly: assembly(), budget, count, priming: 3, calibration: 1 });
    // 120 text tokens, thirteen messages, one three-token reply primer.
    const all = 120 + 3;
    expect(primed(all)).toMatchObject({
      estimate: 123,
      priming: 3,
      examples: { sent: 2, total: 2 },
    });
    // One token short drops the last whole example block, including both messages.
    expect(primed(all - 1)).toMatchObject({ examples: { sent: 1, total: 2 }, estimate: 103 });
    expect(
      fitPrompt({ assembly: assembly(), budget: all * 2, count, priming: 3, calibration: 2 }),
    ).toMatchObject({ estimate: 246, priming: 6, examples: { sent: 2, total: 2 } });
    expect(
      fitPrompt({ assembly: assembly(), budget: all * 2 - 1, count, priming: 3, calibration: 2 }),
    ).toMatchObject({ examples: { sent: 1, total: 2 }, estimate: 206 });
  });

  it("drops example blocks, last first, before any chat message", () => {
    const result = fitBudget(10 + 60 + 5 + 5 + 20 + 11);
    expect(result.ok && result.examples).toEqual({ sent: 1, total: 2 });
    expect(result.ok && result.history).toEqual({ sent: 6, total: 6 });
  });

  it("caps example selection without shrinking the budget or trimming history", () => {
    for (const examplesCap of [0, 1, 2, 3]) {
      expect(
        fitPrompt({
          assembly: assembly(),
          budget: 1_000,
          count,
          priming: 0,
          calibration: 1,
          examplesCap,
        }),
      ).toMatchObject({
        history: { sent: 6, total: 6 },
        examples: { sent: Math.min(examplesCap, 2), total: 2 },
      });
    }
  });

  it("keeps no examples once the history had to be trimmed", () => {
    // Three-token examples: room for five of six turns and an example, yet the example goes.
    const small = assembly();
    small.segments[1] = {
      kind: "examples",
      blocks: [[example("eee", 0, 1)]],
    };
    const result = fitPrompt({
      assembly: small,
      budget: 10 + 5 + 5 + 50 + 5,
      count,
      priming: 0,
      calibration: 1,
    });
    expect(result.ok && result.history).toEqual({ sent: 4, total: 6 });
    expect(result.ok && result.examples).toEqual({ sent: 0, total: 1 });
  });

  it("then drops the oldest turns, keeping in-chat blocks and the latest turn", () => {
    const result = fitBudget(10 + 5 + 5 + 30 + 6);
    if (!result.ok) throw new Error("expected a fit");
    expect(result.examples).toEqual({ sent: 0, total: 2 });
    expect(result.history).toEqual({ sent: 3, total: 6 });
    expect(result.messages.map((message) => message.content[0])).toEqual([
      "m",
      "3",
      "i",
      "4",
      "5",
      "p",
    ]);
  });

  it("refuses when the fixed blocks and the latest turn alone do not fit", () => {
    expect(fitBudget(10 + 5 + 5 + 10 - 1)).toEqual({
      ok: false,
      reason: "prompt_too_long",
      estimate: 30,
    });
  });

  it("scales estimates by the calibration from the model's own count", () => {
    const result = fitBudget(1_000, 2);
    expect(result.ok && result.estimate).toBe(240);
    expect(result.ok && result.messages[0]?.tokens).toBe(20);
    const tighter = fitBudget(120, 2);
    expect(tighter.ok && tighter.history.sent).toBeLessThan(6);
  });

  it("bounds the calibration ratio", () => {
    expect(calibrationRatio(150, 100)).toBe(1.5);
    expect(calibrationRatio(1_000, 100)).toBe(2);
    expect(calibrationRatio(10, 100)).toBe(0.5);
    expect(calibrationRatio(100, 0)).toBe(1);
  });

  it("matches exact candidate costs around Continue, example boundaries and several history positions", () => {
    const input = assembly();
    input.segments.unshift({ kind: "fixed", message: system("leading") });
    const history = input.segments.find((segment) => segment.kind === "history");
    if (history?.kind !== "history") throw new Error("missing history");
    history.continues = true;
    history.injections.push({ depth: 0, message: system("last injection") });
    input.segments.push({
      kind: "fixed",
      message: { ...system("nudge"), source: { kind: "instruction", id: "continue" } },
    });
    for (const budget of [45, 60, 90, 125, 200]) {
      const result = fitPrompt({ assembly: input, budget, count, priming: 0, calibration: 1 });
      if (!result.ok) continue;
      const exact = flatten(input, { turns: result.history.sent, examples: result.examples.sent });
      expect(result.estimate).toBe(exact.reduce((total, message) => total + count(message), 0));
      expect(result.estimate).toBeLessThanOrEqual(budget);
      expect(result.messages.map(({ content }) => content)).toEqual(
        exact.map(({ content }) => content),
      );
    }
  });
});

/** A user turn of `size` tokens by the boundary estimate, its role included. */
const sized = (index: number, size: number): PromptMessage => ({
  role: "user",
  content: "x".repeat(size * BOUNDARY_BYTES_PER_TOKEN - "user".length),
  source: { kind: "history", index },
});

/** A 10-token fixed block, then a history of turns of the given boundary sizes. */
const chatOf = (sizes: number[], fixed = 10): Assembly => ({
  lorebook: null,
  lorebookState: null,
  segments: [
    { kind: "fixed", message: system("m".repeat(fixed)) },
    {
      kind: "history",
      turns: sizes.map((size, index) => sized(index, size)),
      continues: false,
      injections: [],
    },
  ],
});

/** The index of the first turn sent; null when refused. */
const firstSent = (fitted: Fitted) =>
  fitted.ok ? fitted.history.total - fitted.history.sent : null;

/** Fits in blocks of 25 boundary tokens. */
const inBlocks = (input: Assembly, budget: number, calibration = 1, blockTokens = 25) =>
  fitPrompt({ assembly: input, budget, count, priming: 0, calibration, blockTokens });

/** The first turns sent across the given budgets. */
const firstsAcross = (fitAt: (budget: number) => Fitted, budgets: number[]) =>
  new Set(budgets.map((budget) => firstSent(fitAt(budget))).filter((first) => first !== null));

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** Six 10-token turns: with 25-token blocks they start at turns 0, 3 and 5. */
const SIX = [10, 10, 10, 10, 10, 10];
/** The fixed block and one turn, each with its selection padding (one token per character). */
const ONE_TURN = 10 + 36;
const ALL_SIX = 10 + 6 * 36;

describe("block trimming", () => {
  it("sizes a block as a share of the budget", () => {
    expect(HISTORY_BLOCK_SHARE).toBe(1 / 8);
    expect(historyBlockTokens(128_000)).toBe(16_000);
    expect(historyBlockTokens(3)).toBe(1);
  });

  it("uses block history policy by default", () => {
    for (const budget of range(ONE_TURN, ALL_SIX)) {
      expect(
        fitPrompt({ assembly: chatOf(SIX), budget, count, priming: 0, calibration: 1 }),
      ).toEqual(inBlocks(chatOf(SIX), budget, 1, historyBlockTokens(budget)));
    }
  });

  it("starts a block where the turns before it cross a multiple of the block size", () => {
    const even = (budget: number) => inBlocks(chatOf(SIX), budget);
    expect(firstsAcross(even, range(ONE_TURN, ALL_SIX))).toEqual(new Set([0, 3, 5]));
    // Room for four turns keeps the three of the newest whole blocks.
    expect(even(10 + 4 * 36)).toMatchObject({ trimming: "blocks", history: { sent: 3 } });
    // A long first turn fills a block alone: before turns 1, 2, 3, 4, 5 lie 30, 35, 40, 60, 70.
    const uneven = (budget: number) => inBlocks(chatOf([30, 5, 5, 20, 10, 10]), budget);
    expect(firstsAcross(uneven, range(11 + 2 * 36, 1_000))).toEqual(new Set([0, 1, 4]));
    // Below the newest block's two turns the start falls back to the newest turn alone.
    expect(uneven(ONE_TURN)).toMatchObject({ trimming: "blocks-fallback", history: { sent: 1 } });
  });

  it("places the boundaries of a CJK chat by its UTF-8 bytes", () => {
    // Twelve three-byte characters and the role: 40 bytes, a 10-token turn by the estimate
    // (16 characters would make it 4), so with 25-token blocks they start at turns 0, 3 and 5.
    const cjk = chatOf(SIX);
    cjk.segments[1] = {
      kind: "history",
      turns: SIX.map((_, index) => ({
        role: "user",
        content: "語".repeat(12),
        source: { kind: "history", index },
      })),
      continues: false,
      injections: [],
    };
    // Each turn costs its twelve characters and its selection padding.
    const fitted = (budget: number) => inBlocks(cjk, budget);
    expect(firstsAcross(fitted, range(10 + 12, 11 + 6 * 12))).toEqual(new Set([0, 3, 5]));
    expect(fitted(11 + 4 * 12)).toMatchObject({ trimming: "blocks", history: { sent: 3 } });
  });

  it("keeps the retained start while the chat grows, moving it only to a later block start", () => {
    const sizes = Array.from({ length: 40 }, (_, index) => ((index * 7) % 13) + 3);
    const starts = new Set([0]);
    let before = 0;
    for (const [index, size] of sizes.entries()) {
      if (Math.floor((before + size) / 25) > Math.floor(before / 25)) starts.add(index + 1);
      before += size;
    }
    const cost = (from: number, to: number) =>
      11 + sizes.slice(from, to).reduce((total, size) => total + size * 4 - 4, 0);
    const budget = 400;
    let previous = 0;
    for (let length = 1; length <= sizes.length; length += 1) {
      const first = firstSent(inBlocks(chatOf(sizes.slice(0, length)), budget));
      if (first === null) throw new Error("expected a fit");
      expect(starts.has(first)).toBe(true);
      expect(first).toBeGreaterThanOrEqual(previous);
      // It moves only once the retained turns no longer fit with the new one.
      if (first !== previous) expect(cost(previous, length)).toBeGreaterThan(budget);
      previous = first;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it("can skip several block starts when one appended turn is large", () => {
    // Ten 10-token turns start blocks at 0, 3, 5 and 8, and all fit.
    const ten = Array.from({ length: 10 }, () => 10);
    expect(firstSent(inBlocks(chatOf(ten), 400))).toBe(0);
    expect(firstSent(inBlocks(chatOf([...ten, 60]), 400))).toBe(8);
  });

  it("moves no boundary when a fixed block grows", () => {
    for (const budget of range(ONE_TURN + 30, ALL_SIX)) {
      const small = firstSent(inBlocks(chatOf(SIX), budget));
      const large = firstSent(inBlocks(chatOf(SIX, 40), budget));
      if (small === null || large === null) throw new Error("expected a fit");
      // The start stays, or jumps to a later block start.
      expect([0, 3, 5]).toContain(large);
      expect(large).toBeGreaterThanOrEqual(small);
    }
  });

  it("moves no boundary when the calibration changes", () => {
    const calibrated = (budget: number) => inBlocks(chatOf(SIX), budget, 1.5);
    expect(firstsAcross(calibrated, range(1, 2 * ALL_SIX))).toEqual(new Set([0, 3, 5]));
    expect(calibrated(1.5 * ALL_SIX)).toMatchObject({ trimming: "blocks", history: { sent: 6 } });
    // Calibrated costs still decide what fits: room for four calibrated turns keeps three.
    expect(calibrated(1.5 * (11 + 4 * 36))).toMatchObject({ history: { sent: 3 } });
  });

  it("keeps the newest turn when it is alone in its block", () => {
    const fitted = inBlocks(chatOf(SIX), ONE_TURN);
    expect(fitted).toMatchObject({ trimming: "blocks", history: { sent: 1, total: 6 } });
    if (!fitted.ok) throw new Error("expected a fit");
    expect(fitted.messages.at(-1)?.source).toEqual({ kind: "history", index: 5 });
  });

  it("trims per message within a block larger than the room for history", () => {
    // One 100-token block holds the whole chat: no block start but turn 0 exists.
    const budget = 11 + 3 * 36;
    const fallback = inBlocks(chatOf(SIX), budget, 1, 100);
    const exact = fitPrompt({ assembly: chatOf(SIX), budget, count, priming: 0, calibration: 1 });
    expect(fallback).toEqual({ ...exact, trimming: "blocks-fallback" });
    expect(fallback).toMatchObject({ history: { sent: 3 } });
  });

  it("refuses as before when the fixed blocks and the latest turn do not fit", () => {
    expect(inBlocks(chatOf(SIX), ONE_TURN - 1)).toEqual(
      fitPrompt({ assembly: chatOf(SIX), budget: ONE_TURN - 1, count, priming: 0, calibration: 1 }),
    );
    expect(inBlocks(chatOf(SIX), ONE_TURN - 1)).toMatchObject({ ok: false });
  });

  it("adds examples only when the whole history fits", () => {
    const withExamples = (): Assembly => {
      const input = chatOf(SIX);
      input.segments.splice(1, 0, { kind: "examples", blocks: [[example("eee", 0, 1)]] });
      return input;
    };
    expect(inBlocks(withExamples(), ALL_SIX + 4)).toMatchObject({
      history: { sent: 6 },
      examples: { sent: 1, total: 1 },
    });
    // Room for five turns and the example: block trimming keeps three, and still no example.
    expect(inBlocks(withExamples(), 11 + 5 * 36 + 4)).toMatchObject({
      history: { sent: 3 },
      examples: { sent: 0, total: 1 },
    });
  });

  it("is the per-message fit when there is no history", () => {
    const input = (): Assembly => {
      const empty = chatOf([]);
      empty.segments.splice(1, 0, {
        kind: "examples",
        blocks: [[example("eee", 0, 1)], [example("fff", 1, 1)]],
      });
      return empty;
    };
    for (const budget of [5, 11, 15, 19, 100]) {
      expect(inBlocks(input(), budget)).toEqual(
        fitPrompt({ assembly: input(), budget, count, priming: 0, calibration: 1 }),
      );
    }
    expect(inBlocks(input(), 15)).toMatchObject({ trimming: "exact", examples: { sent: 1 } });
  });
});
