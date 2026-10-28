import { describe, expect, it } from "vitest";
import { byName, matches } from "./find.ts";

describe("Find", () => {
  it("finds every word anywhere in the texts, case and accents aside", () => {
    expect(matches("ines", "Inès Laurent")).toBe(true);
    expect(matches("laurent INES", "Inès Laurent")).toBe(true);
    expect(matches("ines mara", "Inès Laurent")).toBe(false);
    expect(matches("ferry mara", "The ferry", "Mara")).toBe(true);
  });

  it("matches everything for an empty query", () => {
    expect(matches("  ", "Anything")).toBe(true);
  });
});

describe("byName", () => {
  it("orders numbers by value and case aside, then exactly", () => {
    expect(["Book 10", "book 2", "Book 2"].sort(byName)).toEqual(["book 2", "Book 2", "Book 10"]);
  });
});
