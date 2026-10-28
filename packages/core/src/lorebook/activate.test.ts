import { describe, expect, it } from "vitest";
import { CPU_BOUND_TEST_TIMEOUT_MS, cpuMs } from "../../test-fixtures/cpu.ts";
import { CARD_LIMITS } from "../card/limits.ts";
import type { Lorebook, LorebookEntry } from "../card/schema.ts";
import { lorebookReportSchema } from "../prompt/inspect.ts";
import { emptyMacroState, MACRO_STATE_LIMITS } from "../prompt/macro-state.ts";
import {
  AggregateMacroLimitError,
  MAX_MACRO_OUTPUT,
  type MacroContext,
  substituteMacros,
} from "../prompt/macros.ts";
import { activateLorebooks } from "./activate.ts";
import { combineLorebooks } from "./combine.ts";
import { LOREBOOK_RULES, LOREBOOK_STATUSES } from "./rules.ts";
import { type ActivationInput, activateLorebook, settled } from "./test-support.ts";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: [],
  content: "Lore.",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const context: MacroContext = {
  char: "Mara",
  user: "Aria",
  description: "d".repeat(200_000),
  personality: "",
  scenario: "",
  persona: "",
  original: "",
  clock: { now: 0, timeZone: "UTC" },
  pickSeed: 0,
  random: () => 0,
};

type Turn = ActivationInput["turns"][number];
const user = (content: string): Turn => ({ role: "user", content });
const char = (content: string): Turn => ({ role: "assistant", content });

function run(entries: LorebookEntry[], overrides: Partial<ActivationInput> = {}) {
  const activation = activateLorebook({
    book: { entries },
    turns: [char("The harbor is quiet."), user("Tell me about the bells.")],
    names: { char: "Mara", user: "Aria" },
    macros: (text, limit, workBudget) =>
      substituteMacros(
        text,
        workBudget === undefined ? context : { ...context, workBudget },
        limit,
      ),
    count: (text) => text.length,
    budget: 1_000,
    scanDepth: 2,
    blocks: { before: true, after: true, examples: true, authorsNote: true },
    // Only an entry with a trigger chance draws; a test that sets none must not reach this.
    random: () => {
      throw new Error("drew a number for an entry without a trigger chance");
    },
    ...overrides,
  });
  expect(lorebookReportSchema.parse(activation.report)).toEqual(activation.report);
  return activation;
}

const statuses = (activation: ReturnType<typeof run>) =>
  activation.report.entries.map((line) => [line.index, line.status]);

describe("what is scanned", () => {
  it("scans supplied display text without evaluating it, including an empty display", () => {
    const entries = [entry({ keys: ["Harbor"] }), entry({ keys: ["Rose"] })];
    expect(
      statuses(
        run(entries, { turns: [{ ...char("{{getvar::place}}"), scanText: ":rose[Harbor]" }] }),
      ),
    ).toEqual([
      [0, "sent"],
      [1, "notMatched"],
    ]);
    expect(statuses(run(entries, { turns: [{ ...char("Harbor"), scanText: "" }] }))).toEqual([
      [0, "notMatched"],
      [1, "notMatched"],
    ]);
    expect(statuses(run(entries, { turns: [char("Harbor")] }))).toEqual([
      [0, "sent"],
      [1, "notMatched"],
    ]);
  });
  it("scans historical user and assistant speakers, falling back only for unnamed turns", () => {
    const entries = ["Alice", "Bob", "Old Captain", "Mara"].map((name) =>
      entry({ keys: [`${name}:`], content: `${name}'s lore.` }),
    );
    const names = { user: "Bob", char: "Mara" };
    const turns: Turn[] = [
      { role: "user", name: "Alice", content: "Hello." },
      { role: "assistant", name: "Old Captain", content: "Welcome." },
    ];
    expect(statuses(run(entries, { names, turns }))).toEqual([
      [0, "sent"],
      [1, "notMatched"],
      [2, "sent"],
      [3, "notMatched"],
    ]);
    expect(statuses(run(entries, { names, turns: [user("Hello."), char("Welcome.")] }))).toEqual([
      [0, "notMatched"],
      [1, "sent"],
      [2, "notMatched"],
      [3, "sent"],
    ]);
    expect(
      statuses(
        run(entries, {
          names,
          turns: [
            { ...user("Hello."), name: "Alice" },
            { ...user("Hi."), name: "Bob" },
          ],
        }),
      ),
    ).toEqual([
      [0, "sent"],
      [1, "sent"],
      [2, "notMatched"],
      [3, "notMatched"],
    ]);
  });

  it("scans the last turns up to the depth", () => {
    const entries = [entry({ keys: ["harbor"] }), entry({ keys: ["bells"] })];
    expect(statuses(run(entries, { scanDepth: 1 }))).toEqual([
      [0, "notMatched"],
      [1, "sent"],
    ]);
    const both = run(entries, { scanDepth: 2 });
    expect(statuses(both)).toEqual([
      [0, "sent"],
      [1, "sent"],
    ]);
    expect(both.report).toMatchObject({ scanDepth: 2, scannedTurns: 2 });
  });

  it("scans nothing at depth 0; constant entries still go in", () => {
    const entries = [entry({ keys: ["bells"] }), entry({ constant: true })];
    const activation = run(entries, { scanDepth: 0 });
    expect(statuses(activation)).toEqual([
      [0, "notMatched"],
      [1, "sent"],
    ]);
    expect(activation.report).toMatchObject({ scannedTurns: 0 });
  });

  it("matches keys against the story, not highlight markup", () => {
    const entries = [
      entry({ keys: ["Rose"] }),
      entry({ keys: ["Mist"] }),
      entry({ keys: ["kisses"] }),
    ];
    const turns = [char(":mist[Rain falls as she :rose[kisses him].]")];
    expect(statuses(run(entries, { turns }))).toEqual([
      [0, "notMatched"],
      [1, "notMatched"],
      [2, "sent"],
    ]);
    expect(statuses(run(entries, { turns: [char(":mist[Rose waits in the mist.]")] }))).toEqual([
      [0, "sent"],
      [1, "sent"],
      [2, "notMatched"],
    ]);
  });

  it("reports fewer scanned turns than the depth in a short chat", () => {
    expect(run([], { scanDepth: 10 }).report.scannedTurns).toBe(2);
  });

  it("fills macros in keys, and reports keys too long after macros", () => {
    const activation = run([entry({ keys: ["{{char}}"] }), entry({ keys: ["{{description}}"] })]);
    expect(activation.report.entries[0]?.reason).toEqual({
      kind: "key",
      key: "{{char}}",
      matched: "Mara",
    });
    expect(activation.report.entries[1]?.status).toBe("notMatched");
    expect(activation.report.keyProblems).toEqual([
      { index: 1, key: "{{description}}", problem: "tooLong" },
    ]);
  });
});

describe("activation", () => {
  it("activates constant entries without keys and never disabled ones", () => {
    const activation = run([
      entry({ constant: true }),
      entry({ keys: ["bells"], enabled: false }),
      entry({ keys: [] }),
    ]);
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "off"],
      [2, "notMatched"],
    ]);
    expect(activation.report.entries[0]?.reason).toEqual({ kind: "constant" });
  });

  it("leaves out empty macro output and preserves native text literally", () => {
    const activation = run([
      entry({ constant: true, content: "{{// nothing}}  " }),
      entry({ constant: true, content: "@@depth 4\n\n@@activate\nThe bells ring.\n@@x" }),
    ]);
    expect(statuses(activation)).toEqual([
      [0, "empty"],
      [1, "sent"],
    ]);
    expect(activation.before).toEqual([
      { index: 1, content: "@@depth 4\n\n@@activate\nThe bells ring.\n@@x" },
    ]);
  });

  it("measures a key in characters, as the card schema does", () => {
    // Each emoji is one character and two UTF-16 units: at the limit, so a valid key.
    const key = "😀".repeat(CARD_LIMITS.shortTextLength);
    const activation = run([entry({ keys: [key] }), entry({ keys: [`${key}😀`] })], {
      turns: [user(`Look: ${key}😀`)],
    });
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "notMatched"],
    ]);
    expect(activation.report.keyProblems).toEqual([{ index: 1, key: key, problem: "tooLong" }]);
  });

  it("marks a macro bomb too long without failing the others", () => {
    const activation = run([
      entry({ constant: true, content: "{{description}}".repeat(10) }),
      entry({ constant: true, content: "{{char}} rings." }),
    ]);
    expect(statuses(activation)).toEqual([
      [0, "tooLong"],
      [1, "sent"],
    ]);
    expect(activation.before).toEqual([{ index: 1, content: "Mara rings." }]);
  });

  it("reports entries whose block the preset switches off, outside the budget", () => {
    const activation = run(
      [
        entry({ constant: true, settings: { placement: "after" }, content: "x".repeat(900) }),
        entry({ constant: true, content: "y".repeat(900) }),
      ],
      { blocks: { before: true, after: false, examples: true, authorsNote: true } },
    );
    expect(statuses(activation)).toEqual([
      [0, "blockOff"],
      [1, "sent"],
    ]);
    expect(activation.after).toEqual([]);
    expect(activation.report.used).toBe(900);
  });
});

describe("budget and order", () => {
  it("fits higher orders first, constant or not; the first misfit ends the fit", () => {
    const activation = run(
      [
        entry({ keys: ["bells"], insertionOrder: 10, content: "a".repeat(100) }),
        entry({ keys: ["bells"], insertionOrder: 300, content: "b".repeat(300) }),
        entry({ constant: true, insertionOrder: 1, content: "c".repeat(400) }),
        entry({ keys: ["bells"], insertionOrder: 200, content: "d".repeat(400) }),
        entry({ keys: ["bells"], insertionOrder: 200, content: "e".repeat(50) }),
      ],
      { budget: 700 },
    );
    expect(statuses(activation)).toEqual([
      [0, "afterCutoff"],
      [1, "sent"],
      [2, "afterCutoff"],
      [3, "sent"],
      [4, "doesNotFit"],
    ]);
    expect(activation.report.used).toBe(700);
    // Entries after the cutoff are never filled or counted.
    expect(activation.report.entries.map((line) => line.tokens)).toEqual([
      undefined,
      300,
      undefined,
      400,
      50,
    ]);
  });

  it("orders sent entries by insertion order within each placement, ties later first", () => {
    const activation = run([
      entry({ constant: true, insertionOrder: 5, content: "late" }),
      entry({
        constant: true,
        insertionOrder: 1,
        content: "after",
        settings: { placement: "after" },
      }),
      entry({ constant: true, insertionOrder: 1, content: "early" }),
      entry({ constant: true, insertionOrder: 5, content: "tie" }),
    ]);
    expect(activation.before.map((sent) => sent.content)).toEqual(["early", "tie", "late"]);
    expect(activation.after).toEqual([{ index: 1, content: "after" }]);
  });
});

describe("report bounds", () => {
  it("lists at most 200 entries per status and counts all of them", () => {
    const entries = [
      ...Array.from({ length: 250 }, () => entry({ keys: ["nothing"] })),
      ...Array.from({ length: 3 }, () => entry({ enabled: false })),
    ];
    const { report } = run(entries);
    expect(report.entries.filter((line) => line.status === "notMatched")).toHaveLength(200);
    expect(report.entries.filter((line) => line.status === "off")).toHaveLength(3);
    expect(report.counts).toMatchObject({ notMatched: 250, off: 3, sent: 0 });
  });
});

describe("work bound", () => {
  const words = (seed: number, count: number) =>
    Array.from({ length: count }, (_, i) => `w${seed}x${i}`.padEnd(20, "q")).join(" ");

  it("charges indexed macro work even when the final key is empty", () => {
    const state = emptyMacroState();
    state.local.collection = JSON.stringify({ text: "x".repeat(MACRO_STATE_LIMITS.value - 100) });
    const entries = Array.from({ length: 500 }, () =>
      entry({ keys: ["{{setvarkey::collection::key::value}}"] }),
    );
    const result = run(entries, {
      turns: [],
      scanDepth: 0,
      macros: (text, limit, workBudget) =>
        substituteMacros(
          text,
          { ...context, state, ...(workBudget === undefined ? {} : { workBudget }) },
          limit,
        ),
    });
    expect(result.report.counts.unscanned).toBeGreaterThan(0);
    expect(result.report.counts.notMatched).toBeGreaterThan(0);
    expect(result.report.keyProblems).toEqual([]);
  });

  it(
    "stops a hostile book within the work allowance and reports the rest unscanned",
    () => {
      const entries: Lorebook["entries"] = Array.from({ length: 5_000 }, (_, i) =>
        entry({
          keys: Array.from({ length: 100 }, (_, k) => `k${i}z${k}`.padEnd(20, "v")),
          constant: i === 4_999,
        }),
      );
      const text = words(1, 6_200);
      let filledKeys = 0;
      const { result: activation, ms } = cpuMs(() =>
        run(entries, {
          turns: [char(text.slice(0, 64_000)), user(text.slice(64_000))],
          macros: (text, limit) => {
            if (limit === 2 * CARD_LIMITS.shortTextLength) filledKeys += 1;
            return substituteMacros(text, context, limit);
          },
        }),
      );
      // Every absent key scans both turns. At most one entry's keys are prepared ahead of scanning.
      const maxScannedKeys = Math.floor(LOREBOOK_RULES.scanWork / text.length);
      expect(filledKeys).toBeGreaterThan(0);
      expect(filledKeys).toBeLessThanOrEqual(maxScannedKeys + CARD_LIMITS.tags);
      // The count follows scanWork itself, so the allowance must also stay cheap: about 0.5 s alone.
      expect(ms).toBeLessThan(2_000);
      expect(activation.report.counts.unscanned).toBeGreaterThan(0);
      expect(activation.report.entries.at(-1)?.status).toBe("sent");
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it("never stops a normal book", () => {
    const entries = Array.from({ length: 300 }, (_, i) =>
      entry({ keys: Array.from({ length: 5 }, (_, k) => `key ${i} ${k}`.padEnd(20, "m")) }),
    );
    const text = words(2, 1_000);
    const turns = Array.from({ length: 10 }, (_, i) =>
      user(text.slice(i * 2_000, i * 2_000 + 2_000)),
    );
    const activation = run(entries, { turns, scanDepth: 10 });
    expect(activation.report.counts.unscanned).toBe(0);
    expect(activation.report.counts.notMatched).toBe(300);
  });
});

describe("text work bound", () => {
  it.each([false, true])(
    "never demotes aggregate exhaustion to tooLong (constant: %s)",
    (constant) => {
      expect(() =>
        run([entry({ constant, keys: ["bells"] })], {
          macros: () => {
            throw new AggregateMacroLimitError();
          },
        }),
      ).toThrow(AggregateMacroLimitError);
    },
  );

  it("expands and counts only up to the first entry that doesn't fit", () => {
    let counted = 0;
    let expanded = 0;
    const entries = Array.from({ length: 2_000 }, (_, i) =>
      entry({ constant: true, insertionOrder: i, content: "{{description}}".repeat(4) }),
    );
    const activation = run(entries, {
      budget: 1,
      macros: (text, limit) => {
        expanded += 1;
        return substituteMacros(text, context, limit);
      },
      count: (text) => {
        counted += 1;
        return text.length;
      },
    });
    expect(expanded).toBe(1);
    expect(counted).toBe(1);
    expect(activation.report.counts.doesNotFit).toBe(1);
    expect(activation.report.counts.afterCutoff).toBe(1_999);
  });

  it("stops expanding once the request's text allowance is spent, reporting the rest", () => {
    // Every entry expands past the macro limit and is left out as too long, costing the most.
    const entries = Array.from({ length: 200 }, () =>
      entry({ constant: true, content: "{{description}}".repeat(8) }),
    );
    let expanded = 0;
    const activation = run(entries, {
      macros: (text, limit) => {
        expanded += 1;
        return substituteMacros(text, context, limit);
      },
    });
    // Each failed expansion spends up to MAX_MACRO_OUTPUT of the request's allowance.
    expect(expanded).toBe(Math.ceil(LOREBOOK_RULES.entryText / MAX_MACRO_OUTPUT));
    expect(activation.report.counts.tooLong).toBe(expanded);
    expect(activation.report.counts.unscanned).toBe(entries.length - expanded);
  });
});

describe("secondary keys", () => {
  const turns = [user("The harbor gull keeps watch.")];
  /** One entry keyed "harbor" with the given secondary keys and logic code. */
  const selective = (secondary: string[], logic: number, overrides: Partial<LorebookEntry> = {}) =>
    entry({
      keys: ["harbor"],
      secondaryKeys: secondary,
      selective: true,
      settings: { logic: (["andAny", "notAll", "notAny", "andAll"] as const)[logic] ?? "andAny" },
      ...overrides,
    });
  const ONE = ["gull", "heron"];
  const ALL = ["gull", "watch"];
  const NONE = ["heron", "egret"];

  it.each([
    ["AND ANY", 0, ["sent", "sent", "filtered"]],
    ["AND ALL", 3, ["filtered", "sent", "filtered"]],
    ["NOT ANY", 2, ["filtered", "filtered", "sent"]],
    ["NOT ALL", 1, ["sent", "filtered", "sent"]],
  ])("apply %s over one, all and none present", (_, logic, expected) => {
    const activation = run(
      [ONE, ALL, NONE].map((keys) => selective(keys, logic)),
      { turns },
    );
    expect(activation.report.entries.map((line) => line.status)).toEqual(expected);
  });

  it("report the logic with the keys that decided it: matched for AND, absent for NOT", () => {
    const activation = run(
      [selective(ONE, 0), selective(ALL, 3), selective(NONE, 2), selective(ONE, 1)],
      { turns },
    );
    const primary = { kind: "key", key: "harbor", matched: "harbor" };
    const absent = (key: string) => ({ key, matched: "" });
    expect(activation.report.entries.map((line) => line.reason)).toEqual([
      { ...primary, logic: "andAny", secondary: [{ key: "gull", matched: "gull" }] },
      {
        ...primary,
        logic: "andAll",
        secondary: [
          { key: "gull", matched: "gull" },
          { key: "watch", matched: "watch" },
        ],
      },
      // NOT ANY: every key is absent; NOT ALL: at least one, the first found missing.
      { ...primary, logic: "notAny", secondary: [absent("heron"), absent("egret")] },
      { ...primary, logic: "notAll", secondary: [absent("heron")] },
    ]);
  });

  it("report a refused secondary pattern as absent under NOT logics, and bound the list", () => {
    const refused = "/(?<=x)gull/";
    const many = Array.from({ length: 120 }, (_, index) => `egret${index}`);
    const activation = run(
      [selective([refused], 1), selective(["heron", refused], 2), selective(many, 2)],
      { turns },
    );
    expect(activation.report.entries.map((line) => line.reason)).toMatchObject([
      { logic: "notAll", secondary: [{ key: refused, matched: "" }] },
      {
        logic: "notAny",
        secondary: [
          { key: "heron", matched: "" },
          { key: refused, matched: "" },
        ],
      },
      { logic: "notAny" },
    ]);
    const bounded = activation.report.entries[2]?.reason;
    expect(bounded?.kind === "key" ? bounded.secondary : undefined).toHaveLength(100);
    expect(lorebookReportSchema.safeParse(activation.report).success).toBe(true);
  });

  it("carry no logic when the secondary keys did not apply", () => {
    const activation = run([selective([], 2), selective(["gull"], 2, { selective: false })], {
      turns,
    });
    for (const line of activation.report.entries) {
      expect(line.reason).toEqual({ kind: "key", key: "harbor", matched: "harbor" });
    }
  });

  it("ignore an empty or blank list under every logic", () => {
    const entries = [0, 1, 2, 3].flatMap((logic) => [
      selective([], logic),
      selective(["", " "], logic),
    ]);
    expect(run(entries, { turns }).report.counts).toMatchObject({ sent: 8, filtered: 0 });
  });

  it("are switched off by selective false", () => {
    const activation = run([selective(["gull"], 2, { selective: false })], { turns });
    expect(activation.report.entries[0]).toMatchObject({
      status: "sent",
      reason: { kind: "key", key: "harbor", matched: "harbor" },
    });
  });

  it("match a /pattern/ secondary as a regex", () => {
    const activation = run([selective(["/g[u]ll/"], 0), selective(["/her.n/"], 0)], { turns });
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "filtered"],
    ]);
    expect(activation.report.entries[0]?.reason).toMatchObject({
      secondary: [{ key: "/g[u]ll/", matched: "gull" }],
    });
  });

  it("report a refused secondary pattern and count it as present and not matched", () => {
    const refused = "/(?<=x)gull/";
    const activation = run(
      [
        selective(["gull", refused], 3),
        selective(["gull", refused], 1),
        selective([refused], 0),
        selective([refused], 2),
      ],
      { turns },
    );
    expect(statuses(activation)).toEqual([
      [0, "filtered"],
      [1, "sent"],
      [2, "filtered"],
      [3, "sent"],
    ]);
    expect(activation.report.keyProblems).toEqual(
      [0, 1, 2, 3].map((index) => ({ index, key: refused, problem: "unsupportedPattern" })),
    );
  });

  it("follow the entry's case and whole-word rules and its scan depth", () => {
    const history = [user("A gull."), char("Quiet."), user("The Harbor is liking it.")];
    const activation = run(
      [
        selective(["Gull"], 0, { settings: { logic: "andAny", caseSensitive: true } }),
        selective(["gull"], 0, { settings: { logic: "andAny", scanDepth: 3 } }),
        selective(["king"], 0, { settings: { logic: "andAny", scanDepth: 3 } }),
        selective(["king"], 0, { settings: { logic: "andAny", wholeWords: false } }),
      ],
      { turns: history },
    );
    expect(statuses(activation)).toEqual([
      [0, "notMatched"],
      [1, "sent"],
      [2, "filtered"],
      [3, "sent"],
    ]);
  });
});

describe("per-entry overrides", () => {
  const history = [user("The lantern is lit."), char("Quiet night."), user("Any news?")];

  it("scan the entry's own depth, else the book's, and report it when it differs", () => {
    const activation = run(
      [
        entry({ keys: ["lantern"], settings: { scanDepth: 3 } }),
        entry({ keys: ["lantern"] }),
        entry({ keys: ["lantern"], settings: { scanDepth: 1 } }),
        entry({ keys: ["lantern"], settings: { scanDepth: 2 } }),
      ],
      { turns: history, scanDepth: 2 },
    );
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "notMatched"],
      [2, "notMatched"],
      [3, "notMatched"],
    ]);
    expect(activation.report.entries.map((line) => line.scanDepth)).toEqual([
      3,
      undefined,
      1,
      undefined,
    ]);
    expect(activation.report).toMatchObject({ scanDepth: 2, scannedTurns: 2 });
  });

  it("match case by the extension, else the top-level field, else not", () => {
    const turns = [user("The Albatross sails.")];
    const activation = run(
      [
        entry({ keys: ["albatross"], settings: { caseSensitive: true } }),
        entry({ keys: ["albatross"], settings: { caseSensitive: false } }),
        entry({ keys: ["albatross"], settings: { caseSensitive: true } }),
        entry({ keys: ["albatross"] }),
      ],
      { turns },
    );
    expect(statuses(activation)).toEqual([
      [0, "notMatched"],
      [1, "sent"],
      [2, "notMatched"],
      [3, "sent"],
    ]);
  });

  it("match whole words unless the entry turns them off; phrases match anywhere in both", () => {
    const turns = [user("I am liking the iron crowns.")];
    const activation = run(
      [
        entry({ keys: ["king"], settings: { wholeWords: false } }),
        entry({ keys: ["king"] }),
        entry({ keys: ["king"], settings: { wholeWords: true } }),
        entry({ keys: ["iron crown"], settings: { wholeWords: true } }),
        entry({ keys: ["iron crown"], settings: { wholeWords: false } }),
      ],
      { turns },
    );
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "notMatched"],
      [2, "notMatched"],
      [3, "sent"],
      [4, "sent"],
    ]);
  });
});

describe("placement", () => {
  /** A constant entry at an extension position code. */
  const at = (content: string, settings: NonNullable<LorebookEntry["settings"]>) =>
    entry({ constant: true, content, settings });

  it("routes each position to its list and reports it", () => {
    const activation = run([
      at("before", { placement: "before" }),
      at("after", { placement: "after" }),
      at("an top", { placement: "anTop" }),
      at("an bottom", { placement: "anBottom" }),
      at("in chat", { placement: "depth", depth: 3, role: "user" }),
      at("examples before", { placement: "examplesTop" }),
      at("examples after", { placement: "examplesBottom" }),
    ]);
    const texts = (list: { content: string }[]) => list.map((sent) => sent.content);
    expect(texts(activation.before)).toEqual(["before"]);
    expect(texts(activation.after)).toEqual(["after"]);
    expect(texts(activation.authorsNote.top)).toEqual(["an top"]);
    expect(texts(activation.authorsNote.bottom)).toEqual(["an bottom"]);
    expect(activation.depth).toEqual([
      { depth: 3, role: "user", entries: [{ index: 4, content: "in chat" }] },
    ]);
    expect(texts(activation.examples.before)).toEqual(["examples before"]);
    expect(texts(activation.examples.after)).toEqual(["examples after"]);
    expect(
      activation.report.entries.map(({ placement, depth, role }) => [placement, depth, role]),
    ).toEqual([
      ["before", undefined, undefined],
      ["after", undefined, undefined],
      ["anTop", undefined, undefined],
      ["anBottom", undefined, undefined],
      ["depth", 3, "user"],
      ["examplesTop", undefined, undefined],
      ["examplesBottom", undefined, undefined],
    ]);
  });

  it("groups depth entries by depth and role, deeper first, each in insertion order", () => {
    const activation = run([
      entry({
        constant: true,
        content: "b",
        insertionOrder: 50,
        settings: { placement: "depth", depth: 3 },
      }),
      entry({
        constant: true,
        content: "a",
        insertionOrder: 10,
        settings: { placement: "depth", depth: 3 },
      }),
      at("assistant", { placement: "depth", depth: 3, role: "assistant" }),
      at("shallow", { placement: "depth", depth: 1, role: "system" }),
    ]);
    expect(activation.depth).toEqual([
      {
        depth: 3,
        role: "system",
        entries: [
          { index: 1, content: "a" },
          { index: 0, content: "b" },
        ],
      },
      { depth: 3, role: "assistant", entries: [{ index: 2, content: "assistant" }] },
      { depth: 1, role: "system", entries: [{ index: 3, content: "shallow" }] },
    ]);
  });

  it("fits every position to the one budget; hosts that are sent keep their entries in it", () => {
    const activation = run(
      [
        entry({
          constant: true,
          insertionOrder: 3,
          content: "x".repeat(600),
          settings: { placement: "depth" },
        }),
        entry({
          constant: true,
          insertionOrder: 2,
          content: "y".repeat(600),
          settings: { placement: "anTop" },
        }),
        at("z", { placement: "before" }),
      ],
      { blocks: { before: false, after: false, examples: true, authorsNote: true } },
    );
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "doesNotFit"],
      [2, "blockOff"],
    ]);
  });
});

describe("recursion", () => {
  /** A book with `recursiveScanning` on; the chat is "The harbor is quiet." and "Tell me about the bells." */
  const recurse = (entries: LorebookEntry[], overrides: Partial<ActivationInput> = {}) =>
    run(entries, { book: { entries, recursiveScanning: true }, ...overrides });
  const line = (activation: ReturnType<typeof run>, index: number) =>
    activation.report.entries.find((candidate) => candidate.index === index);

  it.each([
    [":mist[She :rose[kisses him].]", false],
    [":mist[Rose :rose[waits here].]", true],
  ])(
    "normalizes recursive primary and secondary scan text while delivering %s intact",
    (content, rose) => {
      const activation = recurse([
        entry({ constant: true, content }),
        entry({ keys: ["Rose"], content: "Primary match." }),
        entry({
          keys: ["bells"],
          secondaryKeys: ["Rose"],
          selective: true,
          settings: { recursiveOnly: true },
          content: "Secondary match.",
        }),
        entry({ keys: ["Mist"], content: "Markup must not match." }),
      ]);
      expect(line(activation, 1)?.status).toBe(rose ? "sent" : "notMatched");
      expect(line(activation, 2)?.status).toBe(rose ? "sent" : "filtered");
      expect(line(activation, 3)?.status).toBe("notMatched");
      expect(
        [...activation.before, ...activation.after].some((entry) => entry.content === content),
      ).toBe(true);
    },
  );

  it("rules out a NOT logic by a forbidden key in recursed text, delayed entries included", () => {
    for (const logic of [2, 1]) {
      const activation = recurse([
        entry({ keys: ["bells"], content: "Something banned." }),
        entry({
          keys: ["bells"],
          secondaryKeys: ["banned"],
          selective: true,
          content: "B.",
          settings: {
            logic: (["andAny", "notAll", "notAny", "andAll"] as const)[logic] ?? "andAny",
            recursiveOnly: true,
          },
        }),
      ]);
      expect(line(activation, 1)?.status).toBe("filtered");
    }
  });

  it("sends an always-on entry delayed until recursion only in a recursive pass", () => {
    const delayed = entry({
      keys: [],
      constant: true,
      content: "Waits.",
      settings: { recursiveOnly: true },
    });
    const opener = entry({ keys: ["bells"], content: "Rings." });
    expect(line(recurse([opener, delayed]), 1)).toMatchObject({ status: "sent", pass: 1 });
    const flat = run([opener, delayed], {
      book: { entries: [opener, delayed] },
    });
    expect(line(flat, 1)?.status).toBe("chainOnly");
    const both = {
      ...delayed,
      settings: { recursiveOnly: true, excludeRecursion: true },
    };
    expect(line(recurse([opener, both]), 1)?.status).toBe("chainOnly");
  });

  it("counts every entry a pass evaluates against the work bound, keyless ones included", () => {
    const entries = [
      ...Array.from({ length: 4_000 }, (_, i) =>
        entry({ keys: [i === 0 ? "bells" : `link${i}`], content: `link${i + 1}` }),
      ),
      ...Array.from({ length: 1_000 }, () => entry({ keys: [], content: "Keyless." })),
    ];
    const { report } = recurse(entries, { budget: 1_000_000 });
    expect(report.counts.unscanned).toBeGreaterThan(0);
  });

  it(
    "charges every visit to an already matched secondary key, so near misses stay bounded",
    () => {
      // A long chain keeps passes coming; each pass revisits every AND ALL entry's matched keys.
      const present = Array.from({ length: 100 }, (_, k) => `s${k}`);
      const entries = [
        ...Array.from({ length: 1_500 }, (_, i) =>
          entry({ keys: [i === 0 ? "bells" : `link${i}`], content: `link${i + 1}` }),
        ),
        ...Array.from({ length: 100 }, () =>
          entry({
            keys: ["harbor"],
            secondaryKeys: [...present, "absent"],
            selective: true,
            settings: { logic: "andAll" },
          }),
        ),
      ];
      const turns = [char(`The harbor: ${present.join(" ")}.`), user("Tell me about the bells.")];
      const { result, ms } = cpuMs(() => recurse(entries, { turns, budget: 1_000_000 }));
      // Well under a second of CPU alone.
      expect(ms).toBeLessThan(5_000);
      const { sent, filtered, unscanned } = result.report.counts;
      expect(unscanned).toBeGreaterThan(0);
      expect(sent).toBeLessThan(1_500);
      expect(sent + filtered + unscanned).toBe(1_600);
      expect(recurse(entries, { turns, budget: 1_000_000 }).report).toEqual(result.report);
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it("follows a chain through entry texts, one pass per link, and says what brought each in", () => {
    const activation = recurse([
      entry({ keys: ["anchor"], content: "The chain is rusted." }),
      entry({ keys: ["bells"], content: "The ferry comes at dusk." }),
      entry({ keys: ["ferry"], content: "It drops its anchor." }),
    ]);
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "sent"],
      [2, "sent"],
    ]);
    expect(activation.report.passes).toBe(4);
    expect(line(activation, 1)).toMatchObject({
      pass: 0,
      reason: { kind: "key", key: "bells", matched: "bells" },
    });
    expect(line(activation, 2)).toMatchObject({
      pass: 1,
      reason: { kind: "recursed", key: "ferry", matched: "ferry", from: 1 },
    });
    expect(line(activation, 0)).toMatchObject({
      pass: 2,
      reason: { kind: "recursed", key: "anchor", matched: "anchor", from: 2 },
    });
  });

  it("scans each entry's text as its own message: a key cannot span two texts", () => {
    const activation = recurse([
      entry({ keys: ["bells"], content: "The old" }),
      entry({ keys: ["harbor"], content: "ferry waits." }),
      entry({ keys: ["old ferry"] }),
    ]);
    expect(line(activation, 2)?.status).toBe("notMatched");
  });

  it("reads secondary keys in recursed text, with the primary in the chat", () => {
    const activation = recurse([
      entry({ keys: ["bells"], content: "The ferry comes." }),
      entry({ keys: ["harbor"], secondaryKeys: ["ferry"], selective: true }),
    ]);
    expect(line(activation, 1)).toMatchObject({
      status: "sent",
      pass: 1,
      reason: {
        kind: "recursed",
        key: "harbor",
        matched: "harbor",
        from: 0,
        secondary: [{ key: "ferry", matched: "ferry" }],
      },
    });
  });

  it("never brings in a non-recursable entry by entry text", () => {
    const activation = recurse([
      entry({ keys: ["bells"], content: "The ferry comes." }),
      entry({ keys: ["ferry"], settings: { excludeRecursion: true } }),
      entry({ keys: ["harbor"], settings: { excludeRecursion: true } }),
    ]);
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "notMatched"],
      [2, "sent"],
    ]);
  });

  it("sends an entry that prevents further recursion, but its text brings in nothing", () => {
    const activation = recurse([
      entry({
        keys: ["bells"],
        content: "The ferry comes.",
        settings: { preventRecursion: true },
      }),
      entry({ keys: ["ferry"] }),
    ]);
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "notMatched"],
    ]);
  });

  it("holds a delayed entry until the first recursive pass, by entry text or by the chat", () => {
    const activation = recurse([
      entry({ keys: ["bells"], content: "The heron is back." }),
      entry({ keys: ["heron"], settings: { recursiveOnly: true } }),
      entry({ keys: ["harbor"], settings: { recursiveOnly: true } }),
    ]);
    expect(line(activation, 1)).toMatchObject({
      status: "sent",
      pass: 1,
      reason: { kind: "recursed", key: "heron", from: 0 },
    });
    // Keyed in the chat: the chat wins the reason. A level above 1 acts as 1.
    expect(line(activation, 2)).toMatchObject({
      status: "sent",
      pass: 1,
      reason: { kind: "key", key: "harbor", matched: "harbor" },
    });
  });

  it("says a delayed entry waits for another entry when no recursive pass runs", () => {
    const activation = recurse([entry({ keys: ["harbor"], settings: { recursiveOnly: true } })]);
    expect(statuses(activation)).toEqual([[0, "chainOnly"]]);
    expect(activation.report.passes).toBe(1);
  });

  it("runs one pass when the book's recursiveScanning is off", () => {
    const entries = [
      entry({ keys: ["bells"], content: "The ferry comes." }),
      entry({ keys: ["ferry"] }),
      entry({ keys: ["harbor"], settings: { recursiveOnly: true } }),
    ];
    for (const recursiveScanning of [undefined, false]) {
      const activation = run(entries, { book: { entries, recursiveScanning } });
      expect(statuses(activation)).toEqual([
        [0, "sent"],
        [1, "notMatched"],
        [2, "chainOnly"],
      ]);
      expect(activation.report.passes).toBe(1);
      expect(line(activation, 0)?.pass).toBe(0);
    }
  });

  it("fits direct matches before recursed ones, whatever their order", () => {
    const activation = recurse(
      [
        entry({ keys: ["bells"], insertionOrder: 50, content: "The ferry." }),
        entry({ keys: ["harbor"], insertionOrder: 10, content: "l".repeat(40) }),
        entry({ keys: ["ferry"], insertionOrder: 90, content: "h".repeat(40) }),
      ],
      { budget: 60 },
    );
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "sent"],
      [2, "doesNotFit"],
    ]);
    expect(activation.report.passes).toBe(2);
    expect(activation.report.used).toBe(50);
  });

  it("stops recursing at the first entry that does not fit", () => {
    const activation = recurse(
      [
        entry({ keys: ["bells"], insertionOrder: 50, content: "The ferry." }),
        entry({ keys: ["harbor"], insertionOrder: 10, content: "l".repeat(40) }),
        entry({ keys: ["harbor"], insertionOrder: 5, content: "Small." }),
        entry({ keys: ["ferry"], content: "Never scanned for." }),
      ],
      { budget: 20 },
    );
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "doesNotFit"],
      [2, "afterCutoff"],
      [3, "notMatched"],
    ]);
    expect(activation.report.passes).toBe(1);
  });

  it("orders sent entries by insertion order, ties later activated first", () => {
    const activation = recurse([
      entry({ keys: ["bells"], content: "LORE-A: the ferry." }),
      entry({ keys: ["ferry"], content: "LORE-B: the anchor." }),
      entry({ keys: ["anchor"], content: "LORE-C." }),
      entry({ keys: ["harbor"], secondaryKeys: ["ferry"], selective: true, content: "LORE-X." }),
    ]);
    expect(activation.before.map((sent) => sent.index)).toEqual([2, 3, 1, 0]);
  });

  it("terminates on a self-keying entry and on two entries naming each other", () => {
    const self = recurse([entry({ keys: ["bells"], content: "The bells ring." })]);
    expect(statuses(self)).toEqual([[0, "sent"]]);
    expect(self.report.passes).toBe(2);
    const pair = recurse([
      entry({ keys: ["bells"], content: "The quay." }),
      entry({ keys: ["quay"], content: "The bells." }),
    ]);
    expect(statuses(pair)).toEqual([
      [0, "sent"],
      [1, "sent"],
    ]);
    expect(pair.report.passes).toBe(3);
  });

  it("reports the entries a recursive pass could not reach before the work ran out", () => {
    const long = "the tide turns ".repeat(8_000);
    const activation = recurse(
      [
        entry({ keys: ["bells"], content: long }),
        ...Array.from({ length: 300 }, () => entry({ keys: ["/zz\\d+q/"] })),
      ],
      { budget: 1_000_000 },
    );
    expect(line(activation, 0)?.status).toBe("sent");
    expect(activation.report.passes).toBe(2);
    // The passes that could still reach them never ran, so none is called not matched.
    expect(activation.report.counts.notMatched).toBe(0);
    expect(activation.report.counts.unscanned).toBe(300);
  });

  it("reports a chain unscanned past the entry-text allowance", () => {
    const filler = "x ".repeat(500_000);
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry({ keys: [i === 0 ? "bells" : `link${i}`], content: `${filler}link${i + 1}` }),
    );
    const { report } = recurse(entries, { budget: 100_000_000 });
    const { sent, notMatched, unscanned } = report.counts;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(8);
    expect(notMatched).toBe(0);
    expect(sent + unscanned).toBe(8);
  });

  it("bounds a 5,000-entry chain by the work meter", () => {
    const entries = Array.from({ length: 5_000 }, (_, i) =>
      entry({ keys: [i === 0 ? "bells" : `link${i}`], content: `link${i + 1}` }),
    );
    const { report } = recurse(entries, { budget: 1_000_000 });
    const { sent, notMatched, unscanned } = report.counts;
    // Each pass brings in the next link until the meter stops the pass it is in; every link
    // not reached is reported unscanned, none as not matched.
    expect(sent).toBeGreaterThan(500);
    expect(notMatched).toBe(0);
    expect(sent + unscanned).toBe(5_000);
    expect(report.passes).toBeGreaterThanOrEqual(sent);
    expect(report.passes).toBeLessThanOrEqual(sent + 1);
    expect(report.entries.at(-1)?.status).toBe("unscanned");
  });
});

describe("trigger chance", () => {
  /** A random source returning `values` in turn, then 0, and what it returned. */
  const draws = (...values: number[]) => {
    const drawn: number[] = [];
    const random = () => {
      const value = values[drawn.length] ?? 0;
      drawn.push(value);
      return value;
    };
    return { random, drawn };
  };
  const chance = (probability: number) => ({ useProbability: true, probability });

  it("sends an always-on entry when the roll falls below its chance, else reports it missed", () => {
    const events = [entry({ constant: true, content: "A gull cries.", settings: chance(10) })];
    const hit = run(events, { random: () => 0.05 });
    expect(hit.report.entries[0]).toMatchObject({
      status: "sent",
      reason: { kind: "constant", chance: 10 },
    });
    expect(hit.before).toEqual([{ index: 0, content: "A gull cries." }]);
    const miss = run(events, { random: () => 0.1 });
    expect(miss.report.entries[0]).toMatchObject({
      status: "chanceMissed",
      reason: { kind: "constant", chance: 10 },
    });
    expect(miss.report.entries[0]).not.toHaveProperty("tokens");
    expect(miss.before).toEqual([]);
    expect(miss.report).toMatchObject({ used: 0, counts: { chanceMissed: 1, sent: 0 } });
  });

  it("never sends at 0%, and draws nothing at 100% or with the chance off", () => {
    const never = run([entry({ constant: true, settings: chance(0) })], { random: () => 0 });
    expect(statuses(never)).toEqual([[0, "chanceMissed"]]);
    const always = run([
      entry({ constant: true, settings: chance(100) }),
      entry({ constant: true, settings: { useProbability: false, probability: 10 } }),
      entry({ constant: true, settings: { useProbability: true } }),
    ]);
    expect(statuses(always)).toEqual([
      [0, "sent"],
      [1, "sent"],
      [2, "sent"],
    ]);
    expect(always.report.entries[0]?.reason).toEqual({ kind: "constant" });
  });

  it("rolls a keyword entry only when its keys match", () => {
    const entries = [
      entry({ keys: ["bells"], settings: chance(50) }),
      entry({ keys: ["anchor"], settings: chance(50) }),
    ];
    const hit = draws(0.2);
    expect(run(entries, { random: hit.random }).report.entries).toMatchObject([
      { status: "sent", reason: { kind: "key", key: "bells", matched: "bells", chance: 50 } },
      { status: "notMatched" },
    ]);
    expect(hit.drawn).toHaveLength(1);
    expect(statuses(run(entries, { random: () => 0.7 }))).toEqual([
      [0, "chanceMissed"],
      [1, "notMatched"],
    ]);
  });

  it("keeps an entry held by a sticky effect in without a roll", () => {
    const sticky = entry({ keys: ["anchor"], settings: { ...chance(0), sticky: 3 } });
    const characterId = "00000000-0000-4000-8000-000000000001";
    const activation = run([sticky], {
      turns: [char("The harbor is quiet."), user("Hello."), char("Bells.")],
      timed: {
        state: { characterId, effects: [{ index: 0, digest: "a1", start: 2 }] },
        characterId,
        digest: () => "a1",
      },
    });
    expect(activation.report.entries[0]).toMatchObject({
      status: "sent",
      reason: { kind: "sticky", left: 2, chance: 0 },
    });
  });

  it("starts no timed effect for an entry that lost its roll", () => {
    const characterId = "00000000-0000-4000-8000-000000000001";
    const timed = { state: null, characterId, digest: () => "a1" };
    const sticky = entry({ constant: true, settings: { ...chance(10), sticky: 3, cooldown: 2 } });
    expect(run([sticky], { timed, random: () => 0.5 }).state?.effects).toEqual([]);
    expect(run([sticky], { timed, random: () => 0 }).state?.effects).toEqual([
      { index: 0, digest: "a1", start: 2 },
    ]);
  });

  it("rolls once per request: a lost roll is not retried in a recursive pass and does not recurse", () => {
    const entries = [
      entry({ keys: ["bells"], content: "The bells ring." }),
      entry({ keys: ["bells", "ring"], content: "The lighthouse.", settings: chance(50) }),
      entry({ keys: ["lighthouse"], content: "Its keeper." }),
    ];
    const { random, drawn } = draws(0.9);
    const activation = run(entries, {
      book: { entries, recursiveScanning: true },
      random,
    });
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "chanceMissed"],
      [2, "notMatched"],
    ]);
    expect(drawn).toEqual([0.9]);
    expect(activation.report.passes).toBe(2);
  });
});

describe("event pools", () => {
  /** A random source returning `values` in turn, then 0, and what it returned. */
  const draws = (...values: number[]) => {
    const drawn: number[] = [];
    const random = () => {
      const value = values[drawn.length] ?? 0;
      drawn.push(value);
      return value;
    };
    return { random, drawn };
  };
  const member = (
    content: string,
    settings: NonNullable<LorebookEntry["settings"]>,
    overrides: Partial<LorebookEntry> = {},
  ) => entry({ keys: ["bells"], content, settings, ...overrides });
  const characterId = "00000000-0000-4000-8000-000000000001";

  it("draws one member by weight and reports the others with the pool and its holder", () => {
    const entries = [
      member("Rain.", { poolNames: ["Weather"] }),
      member("Fog.", { poolNames: ["Weather"], poolWeight: 300 }),
    ];
    // Weights 100 and 300 of 400: a draw below a quarter picks the first.
    const low = draws(0.2);
    const first = run(entries, { random: low.random });
    expect(low.drawn).toEqual([0.2]);
    expect(first.before).toEqual([{ index: 0, content: "Rain." }]);
    expect(first.report.entries[1]).toMatchObject({
      status: "poolLost",
      pool: { name: "Weather", holder: 0 },
    });
    expect(first.report.entries[1]).not.toHaveProperty("tokens");
    expect(first.report.counts).toMatchObject({ sent: 1, poolLost: 1 });
    const second = run(entries, { random: () => 0.3 });
    expect(statuses(second)).toEqual([
      [0, "poolLost"],
      [1, "sent"],
    ]);
    expect(second.report.entries[0]?.pool).toEqual({ name: "Weather", holder: 1 });
  });

  it("lets a prioritized member win over weight, the highest order first, without a draw", () => {
    const entries = [
      member("A.", { poolNames: ["Weather"], poolPrioritized: true }, { insertionOrder: 50 }),
      member("B.", { poolNames: ["Weather"], poolPrioritized: true }, { insertionOrder: 200 }),
      member("C.", { poolNames: ["Weather"], poolWeight: 10_000 }, { insertionOrder: 300 }),
      member("D.", { poolNames: ["Weather"], poolPrioritized: true }, { insertionOrder: 200 }),
    ];
    expect(statuses(run(entries))).toEqual([
      [0, "poolLost"],
      [1, "sent"],
      [2, "poolLost"],
      [3, "poolLost"],
    ]);
  });

  it("draws nothing for a pool with one member", () => {
    const entries = [
      member("Rain.", { poolNames: ["Weather"] }),
      member("Night.", { poolNames: ["Night"] }),
    ];
    expect(statuses(run(entries))).toEqual([
      [0, "sent"],
      [1, "sent"],
    ]);
  });

  it("keeps a pool for a member held by a sticky effect", () => {
    const entries = [
      member("Rain.", { poolNames: ["Weather"], sticky: 3 }, { keys: ["anchor"] }),
      member("Fog.", { poolNames: ["Weather"] }),
    ];
    const activation = run(entries, {
      turns: [char("The harbor is quiet."), user("Hello."), char("Bells.")],
      timed: {
        state: { characterId, effects: [{ index: 0, digest: "a1", start: 2 }] },
        characterId,
        digest: () => "a1",
      },
    });
    expect(activation.report.entries).toMatchObject([
      { status: "sent", reason: { kind: "sticky" } },
      { status: "poolLost", pool: { name: "Weather", holder: 0 } },
    ]);
  });

  it("drops a member a recursive pass brings in when the first pass settled its pool", () => {
    const entries = [
      member("The lighthouse.", { poolNames: ["Weather"] }),
      member("Its keeper.", { poolNames: ["Weather"] }, { keys: ["lighthouse"] }),
    ];
    const activation = run(entries, {
      book: { entries, recursiveScanning: true },
    });
    expect(activation.report.entries).toMatchObject([
      { status: "sent" },
      { status: "poolLost", pool: { name: "Weather", holder: 0 } },
    ]);
  });

  it("leaves the pool empty when its winner misses its chance; the losers stay out", () => {
    const entries = [
      member("Rain.", { poolNames: ["Weather"], useProbability: true, probability: 50 }),
      member("Fog.", { poolNames: ["Weather"] }),
      member("Mist.", { poolNames: ["Weather"] }, { keys: ["ring"] }),
      entry({ keys: ["bells"], content: "The bells ring." }),
    ];
    // The pool's draw picks the first, whose chance roll then misses.
    const { random, drawn } = draws(0.1, 0.9);
    const activation = run(entries, {
      book: { entries, recursiveScanning: true },
      random,
    });
    // The last entry's text brings the third in on the second pass, too late for the pool.
    expect(statuses(activation)).toEqual([
      [0, "chanceMissed"],
      [1, "poolLost"],
      [2, "poolLost"],
      [3, "sent"],
    ]);
    expect(drawn).toEqual([0.1, 0.9]);
    expect(activation.report.entries[2]).toMatchObject({
      pool: { name: "Weather", holder: 0 },
      reason: { kind: "recursed", from: 3 },
    });
    expect(activation.report.entries[2]).not.toHaveProperty("pass");
  });

  it("resolves overlapping pools in first-appearance order; a loser cannot win another pool", () => {
    const entries = [
      member("A.", { poolNames: ["X", "Y"] }),
      member("B.", { poolNames: ["X"] }),
      member("C.", { poolNames: ["Y"] }),
    ];
    // A wins X, then Y is drawn between A and C, and C wins it.
    const both = draws(0.1, 0.9);
    const first = run(entries, { random: both.random });
    expect(both.drawn).toEqual([0.1, 0.9]);
    expect(first.report.entries).toMatchObject([
      { status: "poolLost", pool: { name: "Y", holder: 2 } },
      { status: "poolLost", pool: { name: "X", holder: 0 } },
      { status: "sent" },
    ]);
    // B wins X; A is out of Y at once, so C has Y alone and nothing more is drawn.
    const one = draws(0.9);
    expect(statuses(run(entries, { random: one.random }))).toEqual([
      [0, "poolLost"],
      [1, "sent"],
      [2, "sent"],
    ]);
    expect(one.drawn).toEqual([0.9]);
  });

  it("starts no timed effect for a member that lost its pool", () => {
    const timed = { state: null, characterId, digest: () => "a1" };
    const entries = [
      member("Rain.", { poolNames: ["Weather"], sticky: 3 }),
      member("Fog.", { poolNames: ["Weather"], sticky: 3 }),
    ];
    expect(run(entries, { timed, random: () => 0.9 }).state?.effects).toEqual([
      { index: 1, digest: "a1", start: 2 },
    ]);
  });

  it("treats the same pool name in two of a character's books as one pool", () => {
    const linked = "00000000-0000-4000-8000-0000000000a1";
    const { books } = combineLorebooks(
      [
        {
          id: null,
          name: "Card",
          book: { entries: [member("Rain.", { poolNames: ["Weather"] })] },
        },
        {
          id: linked,
          name: "World",
          book: { entries: [member("Fog.", { poolNames: ["Weather"] })] },
        },
      ],
      4_000,
    );
    const { random, drawn } = draws(0.9);
    const activation = settled(
      activateLorebooks({
        books,
        turns: [char("The harbor is quiet."), user("Tell me about the bells.")],
        names: { char: "Mara", user: "Aria" },
        macros: (text) => text,
        count: (text) => text.length,
        budget: 1_000,
        blocks: { before: true, after: true, examples: true, authorsNote: true },
        random,
      }),
    );
    expect(drawn).toEqual([0.9]);
    expect(activation.report.entries).toMatchObject([
      { index: 0, status: "poolLost", pool: { name: "Weather", holder: 1 } },
      { index: 1, status: "sent" },
    ]);
  });

  it("draws only trigger chances in a book without pools", () => {
    const entries = [
      entry({ keys: ["bells"], settings: { useProbability: true, probability: 50 } }),
      entry({ keys: ["bells"] }),
      entry({ constant: true, settings: { useProbability: true, probability: 50 } }),
    ];
    const { random, drawn } = draws(0.1, 0.9);
    // The always-on entry is rolled first, then the keyword match, as before pools.
    expect(statuses(run(entries, { random }))).toEqual([
      [0, "chanceMissed"],
      [1, "sent"],
      [2, "sent"],
    ]);
    expect(drawn).toEqual([0.1, 0.9]);
  });
});

describe("report schema", () => {
  const line = {
    index: 0,
    title: "Gull",
    placement: "depth",
    depth: 4,
    role: "user",
    status: "sent",
    reason: { kind: "key", key: "harbor", matched: "harbor", secondary: [] },
  };
  const reportWith = (entry: unknown) => ({
    scanDepth: 2,
    passes: 2,
    scannedTurns: 2,
    budget: 10,
    used: 1,
    sources: [{ id: null, name: "", count: 1 }],
    entries: [entry],
    counts: Object.fromEntries(LOREBOOK_STATUSES.map((status) => [status, 0])),
    keyProblems: [],
  });

  it("accepts the new fields and statuses and refuses anything else", () => {
    expect(lorebookReportSchema.safeParse(reportWith(line)).success).toBe(true);
    const recursed = { ...line, pass: 1, reason: { ...line.reason, kind: "recursed", from: 3 } };
    expect(lorebookReportSchema.safeParse(reportWith(recursed)).success).toBe(true);
    const { from: _from, ...noSource } = recursed.reason;
    expect(
      lorebookReportSchema.safeParse(reportWith({ ...recursed, reason: noSource })).success,
    ).toBe(false);
    for (const status of ["filtered", "chainOnly"]) {
      expect(lorebookReportSchema.safeParse(reportWith({ ...line, status })).success).toBe(true);
    }
    expect(lorebookReportSchema.safeParse(reportWith({ ...line, placement: "side" })).success).toBe(
      false,
    );
    expect(
      lorebookReportSchema.safeParse(reportWith({ ...line, position: "before" })).success,
    ).toBe(false);
    for (const logic of ["andAny", "andAll", "notAny", "notAll"]) {
      expect(
        lorebookReportSchema.safeParse(reportWith({ ...line, reason: { ...line.reason, logic } }))
          .success,
      ).toBe(true);
    }
    expect(
      lorebookReportSchema.safeParse(
        reportWith({ ...line, reason: { ...line.reason, logic: "orAny" } }),
      ).success,
    ).toBe(false);
    const many = Array.from({ length: 101 }, () => ({ key: "k", matched: "k" }));
    expect(
      lorebookReportSchema.safeParse(
        reportWith({ ...line, reason: { ...line.reason, secondary: many } }),
      ).success,
    ).toBe(false);
  });
});
