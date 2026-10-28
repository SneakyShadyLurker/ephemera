import { randomUUID } from "node:crypto";
import { blankCard, type CastSheetEntry, emptyCastAnchor } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";

function setup() {
  const stores = createStores(openUserDatabase(undefined).db, createMemoryPortraitFiles());
  const characterId = stores.characters.create(blankCard("Maren"));
  return { stores, sheets: stores.castSheets, characterId };
}

const entry = (name: string): CastSheetEntry => ({
  id: randomUUID(),
  role: "principal",
  anchor: { ...emptyCastAnchor(name, "female"), age: "24" },
  aka: [],
});

const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);

describe("cast sheet store", () => {
  it("returns null for a character without a sheet", () => {
    const { sheets, characterId } = setup();
    expect(sheets.get(characterId)).toBeNull();
  });

  it("upserts the sheet and bumps its revision", () => {
    const { sheets, characterId } = setup();
    const created = sheets.put(characterId, { fingerprint: FIRST, entries: [entry("Ana Pires")] });
    expect(created).toMatchObject({ characterId, fingerprint: FIRST, revision: 0 });
    expect(sheets.get(characterId)).toEqual(created);

    const replaced = sheets.put(characterId, { fingerprint: SECOND, entries: [entry("Mara")] });
    expect(replaced).toMatchObject({ fingerprint: SECOND, revision: 1 });
    expect(replaced.entries.map((at) => at.anchor.name)).toEqual(["Mara"]);
    expect(sheets.get(characterId)).toEqual(replaced);
  });

  it("refuses an entry carrying volatile state", () => {
    const { sheets, characterId } = setup();
    const withState = { ...entry("Ana Pires"), state: { present: true } };
    expect(() =>
      sheets.put(characterId, {
        fingerprint: FIRST,
        entries: [withState as CastSheetEntry],
      }),
    ).toThrow();
    expect(sheets.get(characterId)).toBeNull();
  });

  it("goes with its character", () => {
    const { stores, sheets, characterId } = setup();
    sheets.put(characterId, { fingerprint: FIRST, entries: [entry("Ana Pires")] });
    expect(stores.characters.remove(characterId)).toBe(true);
    expect(sheets.get(characterId)).toBeNull();
  });
});
