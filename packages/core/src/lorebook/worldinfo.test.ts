import { describe, expect, it } from "vitest";
import { normalizeLorebook, upgradeLegacyLorebook } from "../card/import.ts";
import { CARD_LIMITS } from "../card/limits.ts";
import { toLorebookFile } from "../native-files.ts";
import { entrySettings } from "./settings.ts";
import { importWorldInfo } from "./worldinfo.ts";

const foreignEntry = {
  key: ["lamp"],
  keysecondary: ["moon"],
  content: "The lamp is lit.",
  order: 100,
  disable: false,
  position: 4,
  depth: "3",
  role: "1",
  selectiveLogic: "3",
  sticky: "2",
  group: "Night",
  uid: 42,
  delayUntilRecursion: "3",
};
describe("foreign World Info imports", () => {
  it("converts all useful settings, preserves ids and order, and exports only native data", () => {
    const result = importWorldInfo({
      name: "Night",
      scan_depth: 5,
      token_budget: 1000,
      recursive_scanning: true,
      entries: { "42": foreignEntry },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.book).toMatchObject({
      name: "Night",
      scanDepth: 5,
      tokenBudget: 1000,
      recursiveScanning: true,
      entries: [{ id: 42, insertionOrder: 100, secondaryKeys: ["moon"] }],
    });
    const first = result.book.entries[0];
    if (first === undefined) throw new Error("Missing imported entry");
    expect(entrySettings(first)).toMatchObject({
      placement: "depth",
      role: "user",
      depth: 3,
      logic: "andAll",
      sticky: 2,
      poolNames: ["Night"],
      recursiveOnly: true,
    });
    expect(result.book).not.toHaveProperty("extensions");
    expect(importWorldInfo(toLorebookFile(result.book))).toMatchObject({
      ok: true,
      format: "native",
      book: result.book,
    });
  });
  it("uses the same settings conversion for embedded books and World Info", () => {
    const world = importWorldInfo({ entries: [foreignEntry] });
    const saved = upgradeLegacyLorebook({
      entries: [
        {
          keys: ["lamp"],
          secondary_keys: ["moon"],
          content: "The lamp is lit.",
          insertion_order: 100,
          enabled: true,
          id: 42,
          use_regex: false,
          extensions: {
            position: "4",
            depth: 3,
            role: 1,
            selectiveLogic: 3,
            sticky: "2",
            delay_until_recursion: 3,
            group: "Night",
          },
        },
      ],
    });
    expect(world.ok).toBe(true);
    if (world.ok) expect(world.book.entries).toEqual(saved.entries);
  });
  it("disables outlet entries with a report and preserves their complete text", () => {
    const result = importWorldInfo({
      entries: { a: { ...foreignEntry, position: "7", content: "Keep this text." } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.book.entries[0]).toMatchObject({ enabled: false, content: "Keep this text." });
    expect(result.report.changed.join(" ")).toContain("outlet");
  });
  it("reports omitted foreign metadata without interpolating its contents", () => {
    const result = importWorldInfo({
      extensions: { private: "SECRET" },
      entries: [{ ...foreignEntry, automationId: "SECRET", vectorized: true }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.skipped.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.report)).not.toContain("SECRET");
  });
  it("fits keywords and names and preserves meaningful text", () => {
    const result = importWorldInfo({
      entries: [{ ...foreignEntry, key: ["x".repeat(201), "lamp"], name: "n".repeat(201) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.changed).toEqual(
      expect.arrayContaining([
        "Some lorebook keywords were left out to fit the keyword limits.",
        "Some lorebook entry names were shortened to fit the name limit.",
      ]),
    );
  });
  it("owns stable trim explanations for standalone books and World Info without exposing their text", () => {
    const keys = [
      "PRIVATE".repeat(40),
      ...Array.from({ length: CARD_LIMITS.tags + 1 }, (_, i) => `key-${i}`),
    ];
    const name = "PRIVATE".repeat(40);
    const entry = { keys, secondary_keys: keys, name, content: "The lamp is lit." };
    const direct = normalizeLorebook({ entries: [entry, entry] });
    const world = importWorldInfo({
      entries: [
        { key: keys, keysecondary: keys, name, content: entry.content },
        { key: keys, keysecondary: keys, name, content: entry.content },
      ],
    });
    for (const result of [direct, world]) {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.report.changed).toEqual([
        "Some lorebook keywords were left out to fit the keyword limits.",
        "Some lorebook entry names were shortened to fit the name limit.",
      ]);
      expect(result.report.skipped).toEqual([]);
      expect(JSON.stringify(result.report)).not.toContain("PRIVATE");
      expect(result.book.entries).toHaveLength(2);
      for (const fitted of result.book.entries) {
        expect(fitted.keys).toEqual(keys.slice(1, CARD_LIMITS.tags + 1));
        expect(fitted.secondaryKeys).toEqual(fitted.keys);
        expect(fitted.name).toBe(name.slice(0, CARD_LIMITS.shortTextLength));
        expect(fitted.content).toBe(entry.content);
      }
      const native = importWorldInfo(toLorebookFile(result.book));
      expect(native).toMatchObject({ ok: true, report: { changed: [], skipped: [] } });
    }
    expect(
      normalizeLorebook({ entries: [{ keys: ["lamp"], name: "Lamp", content: "Light." }] }),
    ).toMatchObject({
      ok: true,
      report: { changed: [], skipped: [] },
    });
  });
  it.each([null, [], "book", 1, {}, { entries: 3 }])("rejects nonbooks %j", (value) => {
    expect(importWorldInfo(value).ok).toBe(false);
  });
  it("refuses oversized lists, text and hostile extension nesting", () => {
    expect(
      importWorldInfo({ entries: Array(CARD_LIMITS.lorebookEntries + 1).fill(foreignEntry) }),
    ).toMatchObject({ ok: false, error: "too_large" });
    expect(
      importWorldInfo({
        entries: [{ ...foreignEntry, content: "x".repeat(CARD_LIMITS.textLength + 1) }],
      }).ok,
    ).toBe(false);
    let nested: object = {};
    for (let i = 0; i < 100; i++) nested = { child: nested };
    expect(importWorldInfo({ entries: [{ ...foreignEntry, extensions: nested }] }).ok).toBe(false);
  });
  it("drops prototype-named keys without prototype pollution", () => {
    const entry = JSON.parse(
      '{"key":["lamp"],"content":"Text","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    );
    expect(importWorldInfo({ entries: [entry] }).ok).toBe(true);
    expect({}).not.toHaveProperty("polluted");
  });
  it.each([
    { format: "unknown" },
    { version: 1 },
    { format: "ephemera.lorebook", version: 2 },
    { format: "ephemera.lorebook", version: 1, spec: "chara_card_v2" },
  ])("reserves native attempts and never falls back", (markers) => {
    expect(importWorldInfo({ ...markers, entries: [foreignEntry], data: { entries: [] } }).ok).toBe(
      false,
    );
  });
});

describe("foreign decorators at the boundary", () => {
  it("omits unsupported leading directives once and reports them", () => {
    const result = importWorldInfo({
      entries: [
        { ...foreignEntry, content: "@@depth 4\n\n@@activate\nThe lamp glows.\n@@literal" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.book.entries[0]?.content).toBe("The lamp glows.\n@@literal");
    expect(result.report.skipped.join(" ")).toContain("decorators");
  });
});
