import {
  addKeywords,
  entryActivation,
  entrySettings,
  type Lorebook,
  type LorebookEntry,
  newEntry,
  splitKeywords,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import {
  activationChange,
  bookSettings,
  entriesToFix,
  entryKeyProblems,
  findEntries,
  listOrder,
  secondaryKeyProblems,
  withEntry,
  withRestored,
  withSettings,
} from "./book.ts";

const entry = (overrides: Partial<LorebookEntry>): LorebookEntry => ({
  keys: [],
  content: "",
  settings: {},
  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const book = (entries: LorebookEntry[]): Lorebook => ({ entries });

describe("keywords", () => {
  it("split on commas, but not inside a /pattern/", () => {
    expect(splitKeywords("harbour, Solm ,docks")).toEqual(["harbour", "Solm", "docks"]);
    expect(splitKeywords("/a{1,3}b/i, bell")).toEqual(["/a{1,3}b/i", "bell"]);
    expect(splitKeywords("/one, two")).toEqual(["/one, two"]);
    expect(splitKeywords(" , ,")).toEqual([]);
  });

  it("add without repeats, within the card's limits", () => {
    expect(addKeywords(["bell"], ["bell", "Bell", "tide"])).toEqual(["bell", "Bell", "tide"]);
    const many = Array.from({ length: 100 }, (_, i) => `k${i}`);
    expect(addKeywords(many, ["one more"])).toEqual(many);
    expect(addKeywords([], ["x".repeat(300)])[0]).toHaveLength(200);
  });

  it("name the keys that can never match", () => {
    const problems = entryKeyProblems(
      entry({ keys: ["bell", "/(?<=old )chapel/", "/bells?/i", "/x/q"] }),
    );
    expect(problems).toEqual([{ key: "/(?<=old )chapel/", problem: "unsupportedPattern" }]);
  });
});

describe("entries", () => {
  it("a new entry goes before the character, after the highest order, with the next id", () => {
    const created = newEntry([entry({ insertionOrder: 40, id: 3 }), entry({ id: "x" })]);
    expect(created).toMatchObject({
      keys: [],
      content: "",
      enabled: true,
      insertionOrder: 110,
      id: 4,
      useRegex: false,
    });
    expect(entrySettings(created).placement).toBe("before");
    expect(newEntry([])).toMatchObject({ insertionOrder: 100, id: 0 });
  });

  it("change one entry and keep every other field", () => {
    const original = book([entry({ keys: ["a"], secondaryKeys: ["b"] })]);
    const changed = withEntry(original, 0, { content: "New." });
    expect(changed.entries[0]).toEqual({ ...original.entries[0], content: "New." });
    expect(original.entries[0]?.content).toBe("");
  });

  it("changes native settings through core's writer and keeps unrelated settings", () => {
    const original = book([
      entry({ keys: ["a"], settings: { sticky: 2 } }),
      entry({ keys: ["b"] }),
    ]);
    const changed = withSettings(original, 0, {
      placement: "depth",
      depth: 3,
      caseSensitive: null,
    });
    expect(entrySettings(changed.entries[0] as LorebookEntry)).toMatchObject({
      placement: "depth",
      depth: 3,
      sticky: 2,
    });
    expect(changed.entries[1]).toBe(original.entries[1]);
    expect(original.entries[0]?.settings).not.toHaveProperty("placement");
  });

  it("restore a removed entry at its place", () => {
    const without = book([entry({ comment: "A" }), entry({ comment: "C" })]);
    const removed = { entry: entry({ comment: "B" }), index: 1 };
    expect(withRestored(without, removed).entries.map((e) => e.comment)).toEqual(["A", "B", "C"]);
  });
});

describe("the list", () => {
  const entries = [
    entry({ comment: "Harbour", keys: ["Solm"], insertionOrder: 50 }),
    entry({ comment: "Tide", constant: true, insertionOrder: 10 }),
    entry({ comment: "Bell", keys: ["/(?<=a)b/"], settings: { placement: "after" } }),
    entry({
      comment: "Gulls",
      content: "They go quiet before a storm.",
      settings: { placement: "after" },
      insertionOrder: 90,
    }),
  ];

  it("groups by placement in insertion order, leaving out empty groups", () => {
    expect(findEntries(entries, "", false)).toEqual([
      { group: "before", indexes: [1, 0], total: 2 },
      { group: "after", indexes: [3, 2], total: 2 },
    ]);
    expect(findEntries([entries[3] as LorebookEntry], "", false).map((g) => g.group)).toEqual([
      "after",
    ]);
  });

  it("finds by title, keyword, secondary keyword or text, ignoring case", () => {
    const shown = (query: string) =>
      Object.fromEntries(findEntries(entries, query, false).map((g) => [g.group, g.indexes]));
    expect(shown("solm")).toEqual({ before: [0], after: [] });
    expect(shown("STORM")).toEqual({ before: [], after: [3] });
    expect(shown("bell")).toEqual({ before: [], after: [2] });
    const withSecondary = [entry({ comment: "Gull", keys: ["gull"], secondaryKeys: ["Squall"] })];
    expect(findEntries(withSecondary, "squall", false)[0]?.indexes).toEqual([0]);
  });

  it("shows only the entries to fix, secondary keys included", () => {
    expect(listOrder(findEntries(entries, "", true))).toEqual([2]);
    const refused = [...entries, entry({ comment: "Rope", secondaryKeys: ["/(?<=a)b/"] })];
    expect(listOrder(findEntries(refused, "", true))).toEqual([4, 2]);
    expect(entriesToFix(refused)).toBe(2);
    expect(secondaryKeyProblems(refused[4] as LorebookEntry)).toEqual([
      { key: "/(?<=a)b/", problem: "unsupportedPattern" },
    ]);
  });

  it("lists every group in speaking order, chat entries deepest first", () => {
    const at = (
      placement: NonNullable<LorebookEntry["settings"]>["placement"],
      overrides: Partial<LorebookEntry> = {},
    ) => entry({ ...overrides, settings: { placement, ...overrides.settings } });
    const book = [
      at("depth", {
        comment: "Shallow",
        settings: { depth: 1, role: "system" },
        insertionOrder: 10,
      }),
      at("anBottom", { comment: "Below note" }),
      at("anTop", { comment: "Above note", insertionOrder: 900 }),
      at("examplesBottom", { comment: "After examples" }),
      at("examplesTop", { comment: "Before examples", insertionOrder: 999 }),
      at("after", { comment: "After" }),
      at("before", { comment: "Before" }),
      at("depth", {
        comment: "Deep system",
        settings: { depth: 6, role: "system" },
        insertionOrder: 1,
      }),
      at("depth", {
        comment: "Deep user",
        settings: { depth: 6, role: "user" },
        insertionOrder: 50,
      }),
      at("depth", {
        comment: "Deep system late",
        settings: { depth: 6, role: "system" },
        insertionOrder: 5,
      }),
    ];
    const groups = findEntries(book, "", false);
    expect(groups.map((g) => g.group)).toEqual([
      "before",
      "after",
      "examples",
      "authorsNote",
      "chat",
    ]);
    const titles = (id: string) =>
      groups.find((g) => g.group === id)?.indexes.map((i) => book[i]?.comment);
    expect(titles("examples")).toEqual(["Before examples", "After examples"]);
    expect(titles("authorsNote")).toEqual(["Above note", "Below note"]);
    // Deepest first; at one depth the user's message before system, as the assembly sends them.
    expect(titles("chat")).toEqual(["Deep user", "Deep system", "Deep system late", "Shallow"]);
    expect(listOrder(groups)).toHaveLength(book.length);
  });
});

describe("review fixes", () => {
  it("check each pattern once, so a later render of a large book is quick", () => {
    const many = Array.from({ length: 2_000 }, (_, i) =>
      entry({
        comment: `E${i}`,
        keys: Array.from({ length: 10 }, (_, k) => `/(ab){${((i * 10 + k) % 90) + 1}}x${i}/`),
      }),
    );
    findEntries(many, "", true);
    const started = performance.now();
    const again = findEntries(many, "", true);
    expect(performance.now() - started).toBeLessThan(250);
    expect(listOrder(again)).toHaveLength(0);
    expect(entryKeyProblems(entry({ keys: ["/(?<=a)b/"] }))).toEqual([
      { key: "/(?<=a)b/", problem: "unsupportedPattern" },
    ]);
  });

  it("show the settings activation uses: the card's valid values, else the defaults", () => {
    expect(bookSettings({ entries: [] })).toEqual({
      depth: null,
      effectiveDepth: 2,
      budget: null,
      chaining: false,
    });
    expect(bookSettings({ entries: [], scanDepth: -3, tokenBudget: 0 })).toEqual({
      depth: null,
      effectiveDepth: 2,
      budget: null,
      chaining: false,
    });
    expect(
      bookSettings({
        entries: [],
        scanDepth: 4.7,
        tokenBudget: 512.5,
        recursiveScanning: true,
      }),
    ).toEqual({ depth: 4, effectiveDepth: 4, budget: 512, chaining: true });
  });
});

describe("how an entry goes in", () => {
  const change = (from: LorebookEntry, next: "always" | "keywords" | "chance") => {
    const changed = { ...from, ...activationChange(from, next) };
    const { useProbability, probability } = entrySettings(changed);
    return { activation: entryActivation(changed), useProbability, probability };
  };

  it("reads always, on keywords and by chance; a keyword entry keeps its chance", () => {
    expect(entryActivation(entry({ constant: true }))).toBe("always");
    const chance = { useProbability: true, probability: 25 };
    expect(entryActivation(entry({ constant: true, settings: chance }))).toBe("chance");
    expect(entryActivation(entry({ keys: ["gull"], settings: chance }))).toBe("keywords");
    // A default, a 100% chance, is no chance.
    const hundred = { useProbability: true, probability: 100 };
    expect(entryActivation(entry({ constant: true, settings: hundred }))).toBe("always");
  });

  it("starts by chance at 10% unless the card holds 1% to 99%, and keeps the number on leaving", () => {
    expect(change(entry({}), "chance")).toEqual({
      activation: "chance",
      useProbability: true,
      probability: 10,
    });
    const stored = entry({ settings: { useProbability: false, probability: 40 } });
    expect(change(stored, "chance").probability).toBe(40);
    const byChance = entry({
      constant: true,
      settings: { useProbability: true, probability: 40 },
    });
    expect(change(byChance, "always")).toEqual({
      activation: "always",
      useProbability: false,
      probability: 40,
    });
    expect(change(byChance, "keywords")).toEqual({
      activation: "keywords",
      useProbability: false,
      probability: 40,
    });
    const keywordChance = entry({ settings: { useProbability: true, probability: 40 } });
    expect(change(keywordChance, "always").useProbability).toBe(false);
    expect(change(keywordChance, "chance")).toMatchObject({
      activation: "chance",
      probability: 40,
    });
  });
});
