import { describe, expect, it } from "vitest";
import { plainPromptPreset } from "../../test-fixtures/preset.ts";
import { blankCard } from "../card/index.ts";
import { type Assembly, assemblePrompt } from "./assemble.ts";
import { fitPrompt, historyBlockTokens, type SentMessage } from "./budget.ts";
import { fitProcessed, PROCESSING_PLACEHOLDER, processPrompt } from "./postprocess.ts";

const message = (
  role: SentMessage["role"],
  content: string,
  source: SentMessage["source"],
): SentMessage => ({ role, content, source, tokens: 10 });

const main = message("system", "Main.", { kind: "block", id: "main" });
const persona = message("system", "Persona.", { kind: "block", id: "personaDescription" });
const greeting = message("assistant", "Welcome.", { kind: "history", index: 0 });
const user = message("user", "Hi.", { kind: "history", index: 1 });
const reply = message("assistant", "Sit.", { kind: "history", index: 2 });
const note = message("system", "Stay tense.", { kind: "authorsNote", depth: 1 });
const last = message("user", "Now?", { kind: "history", index: 3 });
const post = message("system", "Be brief.", { kind: "block", id: "postHistory" });

const prompt = [main, persona, greeting, user, reply, note, last, post];
const names = { user: "Aria", char: "Mara" };
const count = () => 5;
const shape = (messages: ReturnType<typeof processPrompt>) =>
  messages.map(({ role, content }) => `${role}: ${content}`);

const historicalNames = { user: "Bob", char: "Mara Voss!" };
const historicalLines = [
  "Alice Vale!: Hello.",
  "Bob: Bob: is part of my prose.",
  "Old Captain?: Welcome.",
  "Bob: No recorded name.",
  "Mara Voss!: An unnamed reply.",
];
const historicalAssembly = (): Assembly => {
  const preset = plainPromptPreset();
  return assemblePrompt({
    preset: {
      ...preset,
      blocks: [{ kind: "chatHistory", id: "chatHistory" }],
    },
    character: blankCard(historicalNames.char),
    persona: { name: historicalNames.user, description: "" },
    history: [
      { role: "user", name: "Alice Vale!", content: "Hello." },
      { role: "user", name: "Bob", content: "Bob: is part of my prose." },
      { role: "assistant", name: "Old Captain?", content: "Welcome." },
      { role: "user", content: "No recorded name." },
      { role: "assistant", content: "An unnamed reply." },
    ],
    clock: { now: 0, timeZone: "UTC" },
    pickSeed: 0,
    random: () => 0,
  });
};

describe("processPrompt", () => {
  it.each([true])(
    "labels assembled historical speakers exactly once under native attribution",
    () => {
      const fitted = fitPrompt({
        assembly: historicalAssembly(),
        budget: 10_000,
        count,
        calibration: 1,
        priming: 0,
      });
      if (!fitted.ok) throw new Error("expected a fit");
      const out = processPrompt(fitted.messages, "single", { names: historicalNames, count });
      expect(out).toHaveLength(1);
      expect(out[0]?.content).toBe(historicalLines.join("\n\n"));
      expect(out[0]).not.toHaveProperty("name");
    },
  );

  it("leaves the prompt as it is by default", () => {
    expect(processPrompt(prompt, "none", { names, count })).toEqual(prompt);
  });

  it("merges consecutive messages of one role with a blank line, keeping their sources", () => {
    const out = processPrompt(prompt, "merge", { names, count });
    expect(shape(out)).toEqual([
      "system: Main.\n\nPersona.",
      "assistant: Welcome.",
      "user: Hi.",
      "assistant: Sit.",
      "system: Stay tense.",
      "user: Now?",
      "system: Be brief.",
    ]);
    expect(out[0]).toMatchObject({
      source: main.source,
      merged: [persona.source],
      tokens: 5,
    });
  });

  it("keeps one leading system message and sends later ones as the user's (semi-strict)", () => {
    expect(shape(processPrompt(prompt, "semiStrict", { names, count }))).toEqual([
      "system: Main.\n\nPersona.",
      "assistant: Welcome.",
      "user: Hi.",
      "assistant: Sit.",
      "user: Stay tense.\n\nNow?\n\nBe brief.",
    ]);
  });

  it("puts a user message first when a reply would open the chat (strict)", () => {
    const out = processPrompt(prompt, "strict", { names, count });
    expect(shape(out).slice(0, 3)).toEqual([
      "system: Main.\n\nPersona.",
      `user: ${PROCESSING_PLACEHOLDER}`,
      "assistant: Welcome.",
    ]);
    expect(out[1]).toMatchObject({ source: { kind: "placeholder" }, tokens: 5 });
    // Without a leading reply, nothing is inserted.
    expect(shape(processPrompt([main, user], "strict", { names, count }))).toEqual([
      "system: Main.",
      "user: Hi.",
    ]);
    // With no chat turn at all (Write for me on an empty chat), one follows the system message.
    expect(shape(processPrompt([main, persona], "strict", { names, count }))).toEqual([
      "system: Main.\n\nPersona.",
      `user: ${PROCESSING_PLACEHOLDER}`,
    ]);
  });

  it("sends everything as one user message, chat turns under their speakers' names", () => {
    const [only, ...rest] = processPrompt(prompt, "single", { names, count });
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ role: "user", tokens: 5, source: main.source });
    expect(only?.content).toBe(
      "Main.\n\nPersona.\n\nMara: Welcome.\n\nAria: Hi.\n\nMara: Sit.\n\nStay tense.\n\nAria: Now?\n\nBe brief.",
    );
    expect(only?.merged).toHaveLength(7);
  });

  it("handles an empty prompt", () => {
    expect(processPrompt([], "strict", { names, count })).toEqual([]);
  });
});

describe("fitProcessed", () => {
  it.each([true])("recounts and trims assembled historical labels under native attribution", () => {
    const count = (message: { role: string; content: string; name?: string }) =>
      message.role.length + message.content.length + (message.name?.length ?? 0);
    const priming = 3;
    const options = {
      assembly: historicalAssembly(),
      names: historicalNames,
      mode: "single" as const,
      count,
      priming,
      calibration: 1,
    };
    const full = fitProcessed({ ...options, budget: 10_000 });
    if (!full.ok) throw new Error("expected a fit");
    expect(full.history.sent).toBe(historicalLines.length);
    expect(full.messages[0]?.content).toBe(historicalLines.join("\n\n"));
    expect(full.estimate).toBe(
      priming + full.messages.reduce((sum, message) => sum + count(message), 0),
    );
    const budget = full.estimate - 5;
    const trimmed = fitProcessed({ ...options, budget });
    if (!trimmed.ok) throw new Error("expected a trimmed fit");
    expect(trimmed.history.sent).toBeLessThan(historicalLines.length);
    expect(trimmed.messages[0]?.content).toBe(
      historicalLines.slice(-trimmed.history.sent).join("\n\n"),
    );
    expect(trimmed.estimate).toBeLessThanOrEqual(budget);
    expect(trimmed.estimate).toBe(
      priming + trimmed.messages.reduce((sum, message) => sum + count(message), 0),
    );
    for (const message of trimmed.messages) expect(message.tokens).toBe(count(message));
  });

  // One token per character: the names a single user message adds are counted.
  const chars = (message: { content: string }) => message.content.length;
  const turns = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: "x".repeat(10),
    source: { kind: "history" as const, index },
  }));
  const assembly: Assembly = {
    lorebook: null,
    lorebookState: null,
    segments: [
      { kind: "fixed", message: { role: "system", content: "Main.", source: main.source } },
      { kind: "history", turns, continues: false, injections: [] },
    ],
  };
  const fit = { assembly, count: chars, priming: 0, calibration: 1, names };

  const wireCount = (message: { role: string; content: string; name?: string }) =>
    message.role.length + message.content.length + (message.name?.length ?? 0);

  it.each([true])(
    "advances a repeated five-turn selection at the original budget with native block policy",
    () => {
      const roles = ["user", "user", "assistant", "user", "assistant"] as const;
      const turns = [6, 25, 8, 17, 17].map((length, index) =>
        message(roles[index] ?? "user", "x".repeat(length), { kind: "history", index }),
      );
      const assembly: Assembly = {
        lorebook: null,
        lorebookState: null,
        segments: [{ kind: "history", turns, continues: false, injections: [] }],
        lorebookDelivery: {
          entries: new Map(turns.map((turn, index) => [turn, [index]])),
          finalize: (sent) => ({
            lorebook: null,
            lorebookState: {
              characterId: "00000000-0000-4000-8000-000000000001",
              effects: [...sent].map((index) => ({ index, digest: "a", start: 5 })),
            },
          }),
        },
      };
      const options = {
        assembly,
        count: wireCount,
        priming: 3,
        calibration: 1,
        names: { user: "Player Name", char: "Bot" },
        mode: "single" as const,
      };
      expect(fitPrompt({ ...options, budget: 132 })).toMatchObject({ history: { sent: 5 } });
      expect(fitProcessed({ ...options, budget: 1_000 })).toMatchObject({ estimate: 137 });
      const result = fitProcessed({ ...options, budget: 132 });
      if (!result.ok) throw new Error("expected a fit");
      expect(result.history.sent).toBe(2);
      expect(result.estimate).toBeLessThanOrEqual(132);
      expect(result.lorebookState?.effects.map(({ index }) => index)).toEqual(
        Array.from({ length: result.history.sent }, (_, index) => 5 - result.history.sent + index),
      );
    },
  );

  it.each([true])(
    "keeps fixed content and the latest turn at its exact processed boundary with native block policy",
    () => {
      const input: Assembly = {
        lorebook: null,
        lorebookState: null,
        segments: [
          { kind: "fixed", message: { ...main, content: "s".repeat(100) } },
          {
            kind: "history",
            continues: false,
            injections: [],
            turns: [
              message("user", "x", { kind: "history", index: 0 }),
              message("user", "x".repeat(10), { kind: "history", index: 1 }),
            ],
          },
        ],
      };
      const options = {
        assembly: input,
        count: wireCount,
        priming: 3,
        calibration: 1,
        names: { user: "U".repeat(20), char: "Bot" },
        mode: "single" as const,
      };
      expect(fitProcessed({ ...options, budget: 1_000 })).toMatchObject({ estimate: 166 });
      expect(fitProcessed({ ...options, budget: 141 })).toMatchObject({
        ok: true,
        estimate: 141,
        history: { sent: 1, total: 2 },
        messages: [{ content: `${"s".repeat(100)}\n\n${"U".repeat(20)}: ${"x".repeat(10)}` }],
      });
      expect(fitProcessed({ ...options, budget: 140 })).toMatchObject({ ok: false, estimate: 141 });
    },
  );

  it.each([true])(
    "checks the processed minimum even when its plain selection is over budget with native block policy",
    () => {
      const input: Assembly = {
        lorebook: null,
        lorebookState: null,
        segments: [
          { kind: "fixed", message: { ...main, content: "s".repeat(50) } },
          { kind: "fixed", message: { ...persona, content: "p".repeat(50) } },
          {
            kind: "history",
            continues: false,
            injections: [],
            turns: [message("user", "x".repeat(10), { kind: "history", index: 0 })],
          },
        ],
      };
      const options = {
        assembly: input,
        count: wireCount,
        priming: 3,
        calibration: 1,
        names,
        budget: 125,
      };
      expect(fitPrompt(options)).toMatchObject({ ok: false });
      expect(fitProcessed({ ...options, mode: "merge" })).toMatchObject({
        ok: true,
        estimate: 125,
        history: { sent: 1 },
      });
    },
  );

  it.each([true])(
    "checks Strict's user-opening suffix when the latest assistant alone cannot fit with native block policy",
    () => {
      const input: Assembly = {
        lorebook: null,
        lorebookState: null,
        segments: [
          {
            kind: "history",
            continues: false,
            injections: [],
            turns: [
              message("user", "x".repeat(30), { kind: "history", index: 0 }),
              message("assistant", "y", { kind: "history", index: 1 }),
              message("user", "u", { kind: "history", index: 2 }),
              message("assistant", "a", { kind: "history", index: 3 }),
            ],
          },
        ],
      };
      expect(
        fitProcessed({
          assembly: input,
          budget: 10,
          count: chars,
          priming: 0,
          calibration: 1,
          names,
          mode: "strict",
        }),
      ).toMatchObject({
        ok: true,
        estimate: 2,
        history: { sent: 2, total: 4 },
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: "a" },
        ],
      });
    },
  );

  it.each([true])(
    "drops repeated example selections before history beside fixed content with native block policy",
    () => {
      const line = (index: number) => ({
        ...message("system", "e", { kind: "example", index, line: 1 }),
      });
      const input: Assembly = {
        lorebook: null,
        lorebookState: null,
        segments: [
          { kind: "fixed", message: { ...main, content: "s".repeat(100) } },
          { kind: "examples", blocks: Array.from({ length: 10 }, (_, index) => [line(index)]) },
          {
            kind: "history",
            continues: false,
            injections: [],
            turns: [0, 1, 2].map((index) => ({
              ...message("user", "x", { kind: "history", index }),
              historySpeaker: { name: "U", prefixed: false },
            })),
          },
        ],
      };
      const result = fitProcessed({
        assembly: input,
        budget: 200,
        count: (message) =>
          chars(message) +
          (message.content.length > 100 && message.content.includes("\ne") ? 1000 : 0),
        priming: 0,
        calibration: 1,
        names: { user: "N".repeat(1_000), char: "Bot" },
        mode: "single",
      });
      expect(result).toMatchObject({
        ok: true,
        history: { sent: 3, total: 3 },
        examples: { sent: 0, total: 10 },
      });
    },
  );

  it.each([true])(
    "bounds processing trials and reuses plain counts across a large history with native block policy",
    () => {
      const size = 8_192;
      const budget = 2 * size + 2;
      let plainCalls = 0;
      let processedCalls = 0;
      const processedTexts = new Set<string>();
      const input: Assembly = {
        lorebook: null,
        lorebookState: null,
        segments: [
          { kind: "fixed", message: { ...main, content: "Fixed." } },
          {
            kind: "history",
            continues: false,
            injections: [],
            turns: Array.from({ length: size }, (_, index) =>
              message("user", "x", { kind: "history", index }),
            ),
          },
        ],
      };
      const result = fitProcessed({
        assembly: input,
        budget,
        priming: 0,
        calibration: 1,
        names,
        mode: "single",
        count: (message) => {
          if (message.role === "user" && message.content.startsWith("Fixed.")) {
            processedCalls += 1;
            processedTexts.add(message.content);
            return message.content.split("\n\n").length - 1 > 8 ? budget + 1 : 1;
          }
          plainCalls += 1;
          return 1;
        },
      });
      expect(result).toMatchObject({ ok: true, history: { sent: 8, total: size } });
      // One plain count per distinct message: the fixed one and the turn every turn repeats.
      expect(plainCalls).toBe(2);
      expect(processedCalls).toBe(processedTexts.size);
      expect(processedCalls).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(size + 1)) + 9);
    },
  );

  it.each([true])(
    "counts each distinct message once across the search, passed-through ones included with native block policy",
    () => {
      // Pairs of user turns merge; a merged message costs three times its text, so the
      // processed prompt overflows what the plain fit selected and the search runs.
      const turns = Array.from({ length: 40 }, (_, index) =>
        message(index % 3 === 2 ? "assistant" : "user", `turn ${index}`, {
          kind: "history",
          index,
        }),
      );
      const input: Assembly = {
        lorebook: null,
        lorebookState: null,
        segments: [
          { kind: "fixed", message: { ...main, content: "Main." } },
          { kind: "history", turns, continues: false, injections: [] },
        ],
      };
      const cost = ({ content }: { content: string }) =>
        content.includes("\n\n") ? 3 * content.length : content.length;
      const counted: string[] = [];
      const result = fitProcessed({
        assembly: input,
        budget: 200,
        priming: 0,
        calibration: 1,
        names,
        mode: "merge",
        count: (counting) => {
          counted.push(`${counting.role}/${""}/${counting.content}`);
          return cost(counting);
        },
      });
      // The selections the search made before counts were reused.
      expect(result).toMatchObject({ ok: true, history: { sent: 10 } });
      if (!result.ok) throw new Error("expected a fit");
      expect(result.estimate).toBeLessThanOrEqual(200);
      for (const sent of result.messages) expect(sent.tokens).toBe(cost(sent));
      expect(new Set(counted).size).toBe(counted.length);
    },
  );

  it("trims more history when processing takes the prompt past its budget", () => {
    const budget = 5 + 10 * 10 + 11; // The eleven separate messages' selection padding.
    const plain = fitPrompt({ ...fit, budget });
    expect(plain.ok && plain.history.sent).toBe(10);

    const single = fitProcessed({ ...fit, budget, mode: "single" });
    if (!single.ok) throw new Error("expected a fit");
    expect(single.estimate).toBeLessThanOrEqual(budget);
    // Speaker names and separators cost 8 a turn: six of the ten turns still fit.
    expect(single.history.sent).toBe(6);
    expect(single.messages).toHaveLength(1);
    expect(single.estimate).toBe(single.messages[0]?.tokens);
  });

  it("keeps the original budget's blocks on every retry", () => {
    const budget = 160;
    // A block of 20 boundary tokens: the turns are 4 (user) and 5 (assistant), so
    // after turn 0 only turns 5 and 9 start one.
    expect(historyBlockTokens(budget)).toBe(20);
    // Unprocessed, the whole chat fits; processed, it must be fitted again with less room.
    expect(fitPrompt({ ...fit, budget })).toMatchObject({ history: { sent: 10 } });
    const single = fitProcessed({ ...fit, budget, mode: "single" });
    if (!single.ok) throw new Error("expected a fit");
    // Retried with less room, it still starts at a block start of the original budget.
    expect(single.history.total - single.history.sent).toBe(5);
    expect(single.trimming).toBe("blocks");
    expect(single.estimate).toBeLessThanOrEqual(budget);
  });

  it("steps to an older block start when a retry would keep the same block", () => {
    const longer: Assembly = {
      ...assembly,
      segments: [
        assembly.segments[0] as Assembly["segments"][number],
        {
          kind: "history",
          turns: Array.from({ length: 17 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: "x".repeat(10),
            source: { kind: "history" as const, index },
          })),
          continues: false,
          injections: [],
        },
      ],
    };
    const budget = 184;
    const options = { ...fit, assembly: longer, budget, mode: "single" as const };
    // Per message, it fits; in blocks, a shrunk budget alone keeps choosing one block start.
    expect(fitProcessed(options)).toMatchObject({ ok: true });
    const single = fitProcessed({ ...options });
    if (!single.ok) throw new Error("expected a fit");
    expect(single.estimate).toBeLessThanOrEqual(budget);
    expect(single.trimming).toBe("blocks");
    // It lands on a block start of the original budget: the same turns an unprocessed fit
    // keeps when given just the room for them.
    const start = fitPrompt({
      ...fit,
      assembly: longer,
      budget: 5 + 11 * single.history.sent + 1,
      blockTokens: historyBlockTokens(budget),
    });
    expect(start).toMatchObject({ trimming: "blocks", history: { sent: single.history.sent } });
  });

  it("drops examples before capping history when a block retry needs room", () => {
    const line = (index: number) => ({
      role: "system" as const,
      content: "e".repeat(30),
      source: { kind: "example" as const, index, line: 1 },
    });
    const withExamples: Assembly = {
      ...assembly,
      segments: [
        assembly.segments[0] as Assembly["segments"][number],
        { kind: "examples", blocks: [[line(0)], [line(1)]] },
        assembly.segments[1] as Assembly["segments"][number],
      ],
    };
    const options = { ...fit, assembly: withExamples, budget: 190, mode: "single" as const };
    // Unprocessed, the whole chat and both examples fit; processed, only the examples go.
    expect(fitPrompt(options)).toMatchObject({ history: { sent: 10 }, examples: { sent: 2 } });
    expect(fitProcessed(options)).toMatchObject({ history: { sent: 10 }, examples: { sent: 0 } });
    expect(fitProcessed({ ...options })).toMatchObject({
      history: { sent: 10 },
      examples: { sent: 0 },
    });
  });

  it("never refuses in blocks what per-message trimming sends", () => {
    const short = (index: number, role: "user" | "assistant", content: string) => ({
      role,
      content,
      source: { kind: "history" as const, index },
    });
    const opening: Assembly = {
      lorebook: null,
      lorebookState: null,
      segments: [
        {
          kind: "fixed",
          message: { role: "system", content: "s".repeat(19), source: main.source },
        },
        {
          kind: "history",
          turns: [short(0, "user", "a"), short(1, "user", "b"), short(2, "assistant", "c")],
          continues: false,
          injections: [],
        },
      ],
    };
    const options = { ...fit, assembly: opening, budget: 25, mode: "strict" as const };
    // Blocks of 3 start at turns 0 and 2: the block fit keeps only the reply, before
    // which strict alternation adds the placeholder and its 18 tokens.
    expect(historyBlockTokens(25)).toBe(3);
    expect(fitProcessed(options)).toMatchObject({ estimate: 24, history: { sent: 3 } });
    expect(fitProcessed({ ...options })).toMatchObject({
      ok: true,
      estimate: 24,
      history: { sent: 3 },
      trimming: "blocks",
    });
  });

  it("is the plain fit without processing, and refuses what cannot fit processed", () => {
    expect(fitProcessed({ ...fit, budget: 200, mode: "none" })).toEqual(
      fitPrompt({ ...fit, budget: 200 }),
    );
    // The system block and the latest turn fit only unprocessed.
    expect(fitPrompt({ ...fit, budget: 17 }).ok).toBe(true);
    expect(fitProcessed({ ...fit, budget: 17, mode: "single" })).toMatchObject({
      ok: false,
      reason: "prompt_too_long",
    });
  });
});
