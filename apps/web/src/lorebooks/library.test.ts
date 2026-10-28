import {
  CARD_LIMITS,
  type Library,
  LOREBOOK_LINKS,
  type LorebookEntry,
  type LorebookSummary,
  summarizeLorebook,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { entriesText } from "../lorebook/marks.tsx";
import {
  booksOf,
  copiedName,
  deleteText,
  libraryRows,
  linkedConsequence,
  linkedText,
  linksFull,
  withLink,
} from "./library.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const summary = (n: number, name: string): LorebookSummary => ({
  id: id(n),
  name,
  description: "",
  entries: 0,
  enabled: 0,
  always: 0,
  keywords: 0,
  chance: 0,
  updatedAt: 0,
});

const characters = [
  { id: "mira", name: "Mira", portrait: null },
  { id: "tom", name: "Tom Harbour", portrait: 3 },
  { id: "ada", name: "Ada", portrait: null },
];

const library: Library = {
  lorebooks: [summary(1, "weather"), summary(2, "Harbour events"), summary(3, "Ánchors")],
  embedded: [
    { characterId: "tom", name: "Tom Harbour", entries: 4 },
    { characterId: "ada", name: "Ada", entries: 0 },
  ],
  links: [
    { characterId: "mira", lorebookIds: [id(1), id(2)] },
    { characterId: "ada", lorebookIds: [id(2)] },
  ],
};

describe("the library's rows", () => {
  it("orders books and cards by name, case and accents aside", () => {
    const rows = libraryRows(library, characters, "");
    expect(rows.books.map((row) => row.book.name)).toEqual([
      "Ánchors",
      "Harbour events",
      "weather",
    ]);
    expect(rows.embedded.map((book) => book.name)).toEqual(["Ada", "Tom Harbour"]);
  });

  it("names each book's linked characters, known ones only, by name", () => {
    const [, harbour] = libraryRows(library, characters.slice(0, 2), "").books;
    expect(harbour?.characters.map((character) => character.name)).toEqual(["Mira"]);
    const [, all] = libraryRows(library, characters, "").books;
    expect(all?.characters.map((character) => character.name)).toEqual(["Ada", "Mira"]);
  });

  it("finds by a book's name or a linked character's name, and cards by their character", () => {
    const byBook = libraryRows(library, characters, "harb");
    expect(byBook.books.map((row) => row.book.name)).toEqual(["Harbour events"]);
    expect(byBook.embedded.map((book) => book.name)).toEqual(["Tom Harbour"]);
    const byCharacter = libraryRows(library, characters, "  MIRA ");
    expect(byCharacter.books.map((row) => row.book.name)).toEqual(["Harbour events", "weather"]);
    expect(byCharacter.embedded).toEqual([]);
    expect(libraryRows(library, characters, "nothing")).toEqual({ books: [], embedded: [] });
  });
});

describe("links", () => {
  it("appends a new link, keeps an existing one in place, and unlinks without reordering", () => {
    const linked = withLink(library.links, "mira", id(3), true);
    expect(booksOf(linked, "mira")).toEqual([id(1), id(2), id(3)]);
    expect(withLink(linked, "mira", id(1), true)).toEqual(linked);
    expect(booksOf(withLink(linked, "mira", id(2), false), "mira")).toEqual([id(1), id(3)]);
    expect(booksOf(withLink(library.links, "tom", id(1), true), "tom")).toEqual([id(1)]);
    expect(
      withLink(library.links, "ada", id(2), false).some((link) => link.characterId === "ada"),
    ).toBe(false);
  });

  it("knows a character at its limit", () => {
    const full = [
      {
        characterId: "mira",
        lorebookIds: Array.from({ length: LOREBOOK_LINKS }, (_, at) => id(at + 10)),
      },
    ];
    expect(linksFull(full, "mira")).toBe(true);
    expect(linksFull(library.links, "mira")).toBe(false);
  });
});

describe("the library's words", () => {
  it("says who a book is linked to and what an edit reaches", () => {
    expect(linkedText(0)).toBe("Not linked");
    expect(linkedText(1)).toBe("Linked to 1 character");
    expect(linkedText(5)).toBe("Linked to 5 characters");
    expect(linkedConsequence(0)).toBe("Not linked to a character yet.");
    expect(linkedConsequence(5)).toBe("Linked to 5 characters. Edits apply to all of them.");
  });

  it("names the characters a deleted book leaves, a bounded list", () => {
    expect(deleteText([])).toBe(
      "The lorebook is removed from Ephemera. Export it first to keep a copy.",
    );
    expect(deleteText(["Mira", "Ada"])).toContain("2 characters lose it: Mira and Ada.");
    expect(deleteText(["A", "B", "C", "D", "E", "F", "G"])).toContain(
      "7 characters lose it: A, B, C, D and 3 more.",
    );
  });

  it("names a card's book copied to the library after its character, within the limit", () => {
    expect(copiedName("Mira")).toBe("Mira's lorebook");
    expect(copiedName("  ")).toBe("A character's lorebook");
    expect(copiedName("x".repeat(500)).length).toBeLessThanOrEqual(CARD_LIMITS.nameLength);
  });

  it("counts entries, and how many are on, from core's summary", () => {
    const entry = (overrides: Partial<LorebookEntry>): LorebookEntry => ({
      keys: [],
      content: "",
      settings: {},
      enabled: true,
      insertionOrder: 100,
      useRegex: false,
      ...overrides,
    });
    const book = {
      settings: {},
      entries: [entry({ constant: true }), entry({ keys: ["a"], enabled: false })],
    };
    expect(entriesText(summarizeLorebook(book))).toBe("2 entries, 1 on");
    expect(entriesText({ entries: 1, enabled: 1 })).toBe("1 entry, all on");
    expect(entriesText({ entries: 0, enabled: 0 })).toBe("No entries");
  });
});
