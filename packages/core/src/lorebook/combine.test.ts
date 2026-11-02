import { describe, expect, it } from "vitest";
import type { Lorebook, LorebookEntry } from "../card/schema.ts";
import { lorebookReportSchema } from "../prompt/inspect.ts";
import { activateLorebooks } from "./activate.ts";
import { combineLorebooks, entryOrigin, type LorebookSource } from "./combine.ts";
import { LOREBOOK_LINKS, LOREBOOK_RULES } from "./rules.ts";
import { type ActivationInput, activateLorebook, settled } from "./test-support.ts";

const LINKED = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: [],
  content: "Lore.",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const book = (entries: LorebookEntry[], rest: Partial<Lorebook> = {}): Lorebook => ({
  entries,
  ...rest,
});

type Turn = ActivationInput["turns"][number];
const turns: Turn[] = [
  { role: "assistant", content: "The harbor is quiet." },
  { role: "user", content: "Tell me about the bells." },
];

type Shared = Omit<ActivationInput, "book" | "scanDepth" | "budget">;

const request = (budget: number, overrides: Partial<Shared> = {}): Shared & { budget: number } => ({
  budget,
  turns,
  names: { char: "Mara", user: "Aria" },
  macros: (text: string) => text,
  count: (text: string) => text.length,
  blocks: { before: true, after: true, examples: true, authorsNote: true },
  random: () => {
    throw new Error("drew a number for an entry without a trigger chance");
  },
  ...overrides,
});

const source = (id: string | null, entries: LorebookEntry[], rest: Partial<Lorebook> = {}) => ({
  id,
  name: id === null ? "Card" : `Book ${id.slice(-2)}`,
  book: book(entries, rest),
});

function run(
  sources: LorebookSource[],
  overrides: Partial<Shared> & { budget?: number } = {},
  window = 4_000,
) {
  const { books, budget } = combineLorebooks(sources, window);
  const { budget: given, ...rest } = overrides;
  const activation = settled(activateLorebooks({ ...request(given ?? budget, rest), books }));
  expect(lorebookReportSchema.parse(activation.report)).toEqual(activation.report);
  return activation;
}

const statuses = (activation: ReturnType<typeof run>) =>
  activation.report.entries.map((line) => [line.index, line.status]);

describe("one book", () => {
  it("activates exactly as the single-book call does", () => {
    const entries = [
      entry({ keys: ["harbor"], content: "A.", insertionOrder: 30 }),
      entry({ constant: true, content: "B.", insertionOrder: 10 }),
      entry({
        keys: ["bells"],
        content: "C.",
        insertionOrder: 30,
        settings: { placement: "after" },
      }),
      entry({ keys: ["anchor"], content: "D." }),
    ];
    const alone = activateLorebook({
      ...request(1_000),
      book: book(entries),
      scanDepth: 2,
    });
    const combined = run([source(null, entries)], { budget: 1_000 });
    expect(combined.before).toEqual(alone.before);
    expect(combined.after).toEqual(alone.after);
    expect(combined.depth).toEqual(alone.depth);
    expect(combined.state).toEqual(alone.state);
    expect({ ...combined.report, sources: [] }).toEqual({ ...alone.report, sources: [] });
  });

  it("names the book as the only source", () => {
    const activation = run([source(null, [entry(), entry()])]);
    expect(activation.report.sources).toEqual([{ id: null, name: "Card", count: 2 }]);
  });
});

describe("several books", () => {
  it("interleaves their entries by insertion order, later activated first on a tie", () => {
    const card = source(null, [
      entry({ constant: true, content: "card 20", insertionOrder: 20 }),
      entry({ constant: true, content: "card 40", insertionOrder: 40 }),
    ]);
    const linked = source(LINKED, [
      entry({ constant: true, content: "linked 30", insertionOrder: 30 }),
      entry({ constant: true, content: "linked 40", insertionOrder: 40 }),
    ]);
    const activation = run([card, linked]);
    expect(activation.before.map((sent) => sent.content)).toEqual([
      "card 20",
      "linked 30",
      // Equal orders: the later entry of the combined list goes first, as inside one book.
      "linked 40",
      "card 40",
    ]);
    expect(activation.before.map((sent) => sent.index)).toEqual([0, 2, 3, 1]);
  });

  it("gives each entry its own book's scan depth, an entry's own depth still winning", () => {
    const shallow = source(null, [entry({ keys: ["harbor"] })], { scanDepth: 1 });
    const deep = source(LINKED, [
      entry({ keys: ["harbor"] }),
      entry({ keys: ["harbor"], settings: { scanDepth: 1 } }),
    ]);
    const activation = run([shallow, deep]);
    // "harbor" is two turns back: only the deep book's entry without an own depth reads that far.
    expect(statuses(activation)).toEqual([
      [0, "notMatched"],
      [1, "sent"],
      [2, "notMatched"],
    ]);
    expect(activation.report.scanDepth).toBe(1);
    expect(activation.report.entries[1]).toMatchObject({ scanDepth: 2 });
    expect(activation.report.scannedTurns).toBe(1);
  });

  it("scans the deepest depth any book needs", () => {
    const shallow = source(null, [entry({ keys: ["bells"] })], { scanDepth: 1 });
    const deep = source(LINKED, [entry({ keys: ["harbor"] })], { scanDepth: 5 });
    const activation = run([shallow, deep]);
    expect(statuses(activation)).toEqual([
      [0, "sent"],
      [1, "sent"],
    ]);
  });

  describe("chaining", () => {
    const chained = (recursive: boolean, other: boolean) => [
      source(
        null,
        [entry({ keys: ["bells"], content: "The foghorn sounds.", insertionOrder: 10 })],
        recursive ? { recursiveScanning: true } : {},
      ),
      source(
        LINKED,
        [entry({ keys: ["foghorn"], content: "It warns the ferry.", insertionOrder: 20 })],
        other ? { recursiveScanning: true } : {},
      ),
    ];

    it("chains between entries of books that chain", () => {
      const activation = run(chained(true, true));
      expect(statuses(activation)).toEqual([
        [0, "sent"],
        [1, "sent"],
      ]);
      expect(activation.report.entries[1]?.reason).toMatchObject({ kind: "recursed", from: 0 });
      // The pass that activates nothing ends it.
      expect(activation.report.passes).toBe(3);
    });

    it("neither reads the text of a book that does not chain nor reaches its entries", () => {
      // The card's text would match the linked entry, but its book does not chain.
      const fromSilent = run(chained(false, true));
      expect(statuses(fromSilent)).toEqual([
        [0, "sent"],
        [1, "notMatched"],
      ]);
      // The linked entry would be reached, but its book does not chain.
      const intoSilent = run(chained(true, false));
      expect(statuses(intoSilent)).toEqual([
        [0, "sent"],
        [1, "notMatched"],
      ]);
      expect(run(chained(false, false)).report.passes).toBe(1);
    });

    it("runs recursion when any book chains and reaches a chaining book's later entries", () => {
      const silent = source(null, [entry({ keys: ["bells"], content: "The foghorn sounds." })]);
      const loud = source(
        LINKED,
        [
          entry({ keys: ["bells"], content: "A buoy tolls." }),
          entry({ keys: ["buoy"], content: "It marks the shoal." }),
        ],
        { recursiveScanning: true },
      );
      const activation = run([silent, loud]);
      expect(statuses(activation)).toEqual([
        [0, "sent"],
        [1, "sent"],
        [2, "sent"],
      ]);
      expect(activation.report.entries[2]?.reason).toMatchObject({ kind: "recursed", from: 1 });
    });

    it("holds an entry delayed until recursion while no pass reaches it", () => {
      const delayed = entry({
        keys: ["bells"],
        settings: { recursiveOnly: true },
      });
      expect(statuses(run([source(null, [delayed])]))).toEqual([[0, "chainOnly"]]);
      const other = source(LINKED, [entry({ keys: ["harbor"] })], { recursiveScanning: true });
      expect(statuses(run([source(null, [delayed], { recursiveScanning: true }), other]))).toEqual([
        [0, "sent"],
        [1, "sent"],
      ]);
    });
  });

  describe("budget", () => {
    const entries = (size: number) => [entry({ constant: true, content: "x".repeat(size) })];

    it("is the largest allowance of any book", () => {
      const small = source(null, entries(60), { tokenBudget: 100 });
      const large = source(LINKED, entries(150), { tokenBudget: 300 });
      const activation = run([small, large]);
      expect(activation.report.budget).toBe(300);
      // 60 + 150 tokens share the 300 allowance, past the small book's own 100.
      expect(statuses(activation)).toEqual([
        [0, "sent"],
        [1, "sent"],
      ]);
      expect(activation.report.used).toBe(210);
    });

    it("is a quarter of the window for a book that sets none, and never more", () => {
      const sets = source(null, entries(10), { tokenBudget: 50 });
      const none = source(LINKED, entries(10));
      expect(run([sets, none], {}, 400).report.budget).toBe(100);
      const huge = source(LINKED, entries(10), { tokenBudget: 1_000_000 });
      expect(run([sets, huge], {}, 400).report.budget).toBe(100);
    });

    it("cuts the fit across books at the first entry that does not fit", () => {
      const first = source(null, [
        entry({ constant: true, content: "x".repeat(80), insertionOrder: 90 }),
      ]);
      const second = source(LINKED, [
        entry({ constant: true, content: "y".repeat(80), insertionOrder: 50 }),
      ]);
      const activation = run([first, second], {}, 400);
      expect(statuses(activation)).toEqual([
        [0, "sent"],
        [1, "doesNotFit"],
      ]);
    });
  });

  it("takes entries in source order up to the combined bound and reports the rest unscanned", () => {
    const fill = (count: number) => Array.from({ length: count }, () => entry({ enabled: false }));
    const half = LOREBOOK_RULES.combinedEntries / 2;
    const card = source(null, fill(half));
    const linked = source(LINKED, fill(half));
    const extra = source(OTHER, [entry({ keys: ["bells"] }), entry({ constant: true })]);
    const activation = run([card, linked, extra]);
    expect(activation.report.counts.unscanned).toBe(2);
    expect(activation.report.counts.off).toBe(LOREBOOK_RULES.combinedEntries);
    expect(activation.report.entries.filter((line) => line.status === "unscanned")).toMatchObject([
      { index: LOREBOOK_RULES.combinedEntries },
      { index: LOREBOOK_RULES.combinedEntries + 1 },
    ]);
    expect(activation.report.sources.map((s) => s.count)).toEqual([half, half, 2]);
  });
});

describe("combining", () => {
  it("leaves out a book listed twice and books past the link limit", () => {
    const ids = Array.from(
      { length: LOREBOOK_LINKS + 2 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const sources = [
      source(null, []),
      ...ids.map((id) => source(id, [entry()])),
      source(ids[0] ?? null, []),
    ];
    const { books } = combineLorebooks(sources, 1_000);
    expect(books.sources).toHaveLength(LOREBOOK_LINKS + 1);
    expect(books.sources.map((s) => s.id)).toEqual([null, ...ids.slice(0, LOREBOOK_LINKS)]);
  });

  it("shares the first book's scan depth, with the default for no book", () => {
    expect(combineLorebooks([], 1_000).books.scanDepth).toBe(LOREBOOK_RULES.defaultScanDepth);
    expect(combineLorebooks([source(null, [], { scanDepth: 7 })], 1_000).books.scanDepth).toBe(7);
  });

  it("locates a combined index in its source", () => {
    const sources = [{ count: 2 }, { count: 0 }, { count: 3 }];
    expect(entryOrigin(sources, 0)).toEqual({ source: 0, index: 0 });
    expect(entryOrigin(sources, 1)).toEqual({ source: 0, index: 1 });
    expect(entryOrigin(sources, 2)).toEqual({ source: 2, index: 0 });
    expect(entryOrigin(sources, 4)).toEqual({ source: 2, index: 2 });
    expect(entryOrigin(sources, 5)).toBeNull();
    expect(entryOrigin(sources, -1)).toBeNull();
  });
});
