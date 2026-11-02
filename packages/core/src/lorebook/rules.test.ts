import { describe, expect, it } from "vitest";
import type { Lorebook, LorebookEntry } from "../card/schema.ts";
import {
  entryTitle,
  insertionOrder,
  LOREBOOK_RULES,
  lorebookBudget,
  lorebookScanDepth,
} from "./rules.ts";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: [],
  content: "",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});
const book = (overrides: Partial<Lorebook> = {}): Lorebook => ({
  entries: [],
  ...overrides,
});

describe("scan depth", () => {
  it("uses the card's depth, truncated and clamped, else 2", () => {
    expect(lorebookScanDepth(book())).toBe(2);
    expect(lorebookScanDepth(book({ scanDepth: 5 }))).toBe(5);
    expect(lorebookScanDepth(book({ scanDepth: 0 }))).toBe(0);
    expect(lorebookScanDepth(book({ scanDepth: 3.9 }))).toBe(3);
    expect(lorebookScanDepth(book({ scanDepth: 50_000 }))).toBe(LOREBOOK_RULES.maxScanDepth);
    expect(lorebookScanDepth(book({ scanDepth: -1 }))).toBe(2);
  });
});

describe("budget", () => {
  it("uses the card's budget up to a quarter of the window, else a quarter", () => {
    expect(lorebookBudget(book(), 8_192)).toBe(2_048);
    expect(lorebookBudget(book({ tokenBudget: 500 }), 8_192)).toBe(500);
    expect(lorebookBudget(book({ tokenBudget: 100_000 }), 8_192)).toBe(2_048);
    expect(lorebookBudget(book({ tokenBudget: 0 }), 8_192)).toBe(2_048);
    expect(lorebookBudget(book({ tokenBudget: -5 }), 8_191)).toBe(2_047);
  });
});

describe("titles", () => {
  it("falls back from the comment to the name, the first key, then the position", () => {
    expect(entryTitle(entry({ comment: "  The bells  ", name: "n" }), 0)).toBe("The bells");
    expect(entryTitle(entry({ comment: " ", name: "Harbor" }), 0)).toBe("Harbor");
    expect(entryTitle(entry({ keys: ["", "  ", "tide"] }), 0)).toBe("tide");
    expect(entryTitle(entry(), 4)).toBe("Entry 5");
    expect(entryTitle(entry({ comment: "x".repeat(1_000) }), 0)).toHaveLength(200);
  });
});

describe("order", () => {
  it("orders ascending by insertion order, ties later book entries first", () => {
    const entries = [300, 100, 200, 100].map((order) => entry({ insertionOrder: order }));
    expect(insertionOrder(entries)).toEqual([3, 1, 2, 0]);
  });
});
