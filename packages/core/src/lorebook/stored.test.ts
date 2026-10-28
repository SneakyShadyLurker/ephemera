import { describe, expect, it } from "vitest";
import { CARD_LIMITS } from "../card/limits.ts";
import type { Lorebook, LorebookEntry } from "../card/schema.ts";
import { LOREBOOK_LINKS } from "./rules.ts";
import {
  blankLorebook,
  isLorebookTooLarge,
  lorebookFieldsSchema,
  lorebookLinksSchema,
  lorebookPatchRequestSchema,
  lorebookSummarySchema,
  storedLorebookSchema,
  summarizeLorebook,
} from "./stored.ts";

const ID = "00000000-0000-4000-8000-0000000000a1";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: ["harbor"],
  content: "Lore.",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const chance = (percent: number) => ({ useProbability: true, probability: percent });

describe("summarizing a lorebook", () => {
  it("counts always, keywords and chance as exclusive kinds over enabled entries", () => {
    const book: Lorebook = {
      description: "Events.",

      entries: [
        entry({ constant: true }),
        entry({ constant: true, settings: chance(100) }),
        entry({ constant: true, settings: chance(25) }),
        entry({ constant: true, settings: { useProbability: false, probability: 25 } }),
        entry(),
        entry({ settings: chance(10) }),
        entry({ enabled: false }),
        entry({ enabled: false, constant: true, settings: chance(40) }),
      ],
    };
    expect(summarizeLorebook(book)).toEqual({
      description: "Events.",
      entries: 8,
      enabled: 6,
      always: 3,
      keywords: 2,
      chance: 1,
    });
  });

  it("sums to the enabled entries", () => {
    const {
      enabled,
      always,
      keywords,
      chance: byChance,
    } = summarizeLorebook({
      entries: [entry(), entry({ constant: true }), entry({ constant: true, settings: chance(5) })],
    });
    expect(always + keywords + byChance).toBe(enabled);
  });

  it("summarizes an empty book", () => {
    expect(summarizeLorebook(blankLorebook("Empty"))).toEqual({
      description: "",
      entries: 0,
      enabled: 0,
      always: 0,
      keywords: 0,
      chance: 0,
    });
  });

  it("fits the summary schema", () => {
    const summary = {
      id: ID,
      name: "Harbour",
      ...summarizeLorebook({ entries: [entry()] }),
      updatedAt: 1,
    };
    expect(lorebookSummarySchema.parse(summary)).toEqual(summary);
  });
});

describe("the stored book", () => {
  it("makes a blank book named for the library entry", () => {
    expect(blankLorebook("Harbour")).toEqual({ name: "Harbour", entries: [] });
    const stored = {
      id: ID,
      name: "Harbour",
      book: blankLorebook("Harbour"),
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(storedLorebookSchema.parse(stored)).toEqual(stored);
    expect(storedLorebookSchema.safeParse({ ...stored, id: "harbour" }).success).toBe(false);
  });

  it("trims and bounds the name", () => {
    const book = blankLorebook("x");
    expect(lorebookFieldsSchema.parse({ name: "  Harbour  ", book }).name).toBe("Harbour");
    expect(lorebookFieldsSchema.safeParse({ name: "   ", book }).success).toBe(false);
    expect(
      lorebookFieldsSchema.safeParse({ name: "n".repeat(CARD_LIMITS.nameLength + 1), book })
        .success,
    ).toBe(false);
  });

  it("accepts a partial edit with its revision and refuses one without", () => {
    expect(lorebookPatchRequestSchema.safeParse({ revision: 2, name: "Harbour" }).success).toBe(
      true,
    );
    expect(
      lorebookPatchRequestSchema.safeParse({ revision: 2, book: blankLorebook("x") }).success,
    ).toBe(true);
    expect(lorebookPatchRequestSchema.safeParse({ name: "Harbour" }).success).toBe(false);
    expect(lorebookPatchRequestSchema.safeParse({ revision: 2, id: ID }).success).toBe(false);
  });
});

describe("the size limit", () => {
  const huge = (): Lorebook => ({
    entries: Array.from({ length: 40 }, () =>
      entry({ content: "x".repeat(CARD_LIMITS.textLength) }),
    ),
  });

  it("refuses a book past the card limit as too large, not as invalid", () => {
    const parsed = lorebookFieldsSchema.safeParse({ name: "Harbour", book: huge() });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(isLorebookTooLarge(parsed.error)).toBe(true);
  });

  it("does not call an invalid field too large", () => {
    const parsed = lorebookFieldsSchema.safeParse({
      name: "Harbour",
      book: { entries: [{ ...entry(), content: 3 }] },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(isLorebookTooLarge(parsed.error)).toBe(false);
  });

  it("accepts a book within the limit", () => {
    const book = { ...blankLorebook("Harbour"), entries: [entry()] };
    expect(lorebookFieldsSchema.parse({ name: "Harbour", book }).book).toEqual(book);
  });
});

describe("the links", () => {
  const ids = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );

  it("accepts each character's ordered books up to the link limit", () => {
    const links = [
      { characterId: "mara", lorebookIds: ids(LOREBOOK_LINKS) },
      { characterId: "ash", lorebookIds: [] },
    ];
    expect(lorebookLinksSchema.parse(links)).toEqual(links);
  });

  it("refuses more links than the limit, a repeated book and a non-uuid id", () => {
    expect(
      lorebookLinksSchema.safeParse([{ characterId: "mara", lorebookIds: ids(LOREBOOK_LINKS + 1) }])
        .success,
    ).toBe(false);
    expect(
      lorebookLinksSchema.safeParse([{ characterId: "mara", lorebookIds: [ID, ID] }]).success,
    ).toBe(false);
    expect(
      lorebookLinksSchema.safeParse([{ characterId: "mara", lorebookIds: ["harbour"] }]).success,
    ).toBe(false);
  });
});
