import type { CharacterSummary } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { fold } from "@/lib/find";
import { filterCharacters, repeatedNames, tagCounts } from "./filter.ts";

const summary = (name: string, extra: Partial<CharacterSummary> = {}): CharacterSummary => ({
  id: name,
  name,
  nickname: "",
  creator: "",
  tags: [],
  portrait: null,
  updatedAt: 0,
  ...extra,
});

const cast = [
  summary("Seraphina", { tags: ["fantasy", "healer"], creator: "Linden", updatedAt: 3 }),
  summary("Inès Laurent", { tags: ["drama"], updatedAt: 5 }),
  summary("Dungeon Master", { tags: ["fantasy", "game"], nickname: "DM", updatedAt: 1 }),
  summary("kestrel-7", { tags: ["sci-fi"], updatedAt: 4 }),
];

const names = (list: CharacterSummary[]) => list.map((c) => c.name);

describe("gallery filter", () => {
  it("orders by most recent edit, or by name", () => {
    expect(names(filterCharacters(cast, { query: "", tags: [], order: "recent" }))).toEqual([
      "Inès Laurent",
      "kestrel-7",
      "Seraphina",
      "Dungeon Master",
    ]);
    expect(names(filterCharacters(cast, { query: "", tags: [], order: "name" }))).toEqual([
      "Dungeon Master",
      "Inès Laurent",
      "kestrel-7",
      "Seraphina",
    ]);
  });

  it("searches name, nickname, creator and tags, ignoring case and accents", () => {
    const find = (query: string) =>
      names(filterCharacters(cast, { query, tags: [], order: "name" }));
    expect(find("ines")).toEqual(["Inès Laurent"]);
    expect(find("LINDEN")).toEqual(["Seraphina"]);
    expect(find("dm")).toEqual(["Dungeon Master"]);
    expect(find("fantasy game")).toEqual(["Dungeon Master"]);
    expect(find("nobody")).toEqual([]);
  });

  it("keeps characters carrying every checked tag", () => {
    const tagged = (tags: string[]) =>
      names(filterCharacters(cast, { query: "", tags, order: "name" }));
    expect(tagged(["fantasy"])).toEqual(["Dungeon Master", "Seraphina"]);
    expect(tagged(["fantasy", "healer"])).toEqual(["Seraphina"]);
    expect(tagged(["fantasy", "drama"])).toEqual([]);
    expect(tagged(["Fantasy", "HEALER"])).toEqual(["Seraphina"]);
  });

  it("counts tags, most used first", () => {
    expect(tagCounts(cast).slice(0, 2)).toEqual([
      ["fantasy", 2],
      ["drama", 1],
    ]);
  });

  it("counts tags differing only in case as one, in their most used spelling", () => {
    const counts = tagCounts([
      ...cast,
      summary("Mara", { tags: ["Fantasy", "FANTASY"] }),
      summary("Wren", { tags: ["Drama"] }),
    ]);
    expect(counts.slice(0, 2)).toEqual([
      ["fantasy", 3],
      ["drama", 2],
    ]);
  });

  it("finds repeated names, so captions can show the creator", () => {
    const repeated = repeatedNames([...cast, summary("seraphina", { creator: "Other" })]);
    expect(repeated.has(fold("Seraphina"))).toBe(true);
    expect(repeated.has(fold("Inès Laurent"))).toBe(false);
  });
});
