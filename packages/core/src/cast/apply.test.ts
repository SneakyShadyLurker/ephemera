import { describe, expect, it } from "vitest";
import { applyCastChanges, registerFromSheet, withSheet } from "./apply.ts";
import { CAST_LIMITS } from "./limits.ts";
import {
  type CastChanges,
  type CastEntry,
  type CastRegister,
  type CastSheetEntry,
  castChangesSchema,
  emptyCastAnchor,
  emptyCastState,
} from "./register.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Ids from 100 up, counting the calls. */
function ids() {
  let next = 100;
  const newId = () => uuid(next++);
  return { newId, calls: () => next - 100 };
}

const entry = (n: number, name: string, overrides: Partial<CastEntry> = {}): CastEntry => ({
  id: uuid(n),
  role: "principal",
  anchor: emptyCastAnchor(name, "female"),
  aka: [],
  state: emptyCastState(true),
  ...overrides,
});

const register = (...entries: CastEntry[]): CastRegister => ({ entries });
const changes = (value: unknown): CastChanges => castChangesSchema.parse(value);

const apply = (
  base: CastRegister,
  value: unknown,
  {
    player = null,
    removed,
    previous,
  }: { player?: string | null; removed?: Set<string>; previous?: CastRegister } = {},
) => {
  const counter = ids();
  const result = applyCastChanges(base, changes(value), {
    player,
    newId: counter.newId,
    ...(removed === undefined ? {} : { removed }),
    ...(previous === undefined ? {} : { previous }),
  });
  return { result, calls: counter.calls() };
};

const names = (value: CastRegister) => value.entries.map((at) => at.anchor.name);

describe("resolving a change to an entry", () => {
  it("matches exactly on the name or an earlier name, ignoring case and marks", () => {
    const base = register(entry(1, "Mara Battin"), entry(2, "Ilse Brandt", { aka: ["Ilse"] }));
    const { result, calls } = apply(base, {
      cast: { "mara battin": { state: { mood: "calm" } }, ÍLSE: { state: { mood: "wry" } } },
    });
    expect(calls).toBe(0);
    expect(result.entries.map((at) => at.state.mood)).toEqual(["calm", "wry"]);
    expect(names(result)).toEqual(["Mara Battin", "Ilse Brandt"]);
  });

  it("keeps the id and position on `was`, takes the new name and remembers the old", () => {
    const base = register(entry(1, "Ilse", { state: { ...emptyCastState(true), mood: "shy" } }));
    const { result, calls } = apply(base, {
      cast: { "Ilse Brandt": { was: "Ilse", anchor: { age: "24" } } },
    });
    expect(calls).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: uuid(1),
      aka: ["Ilse"],
      anchor: { name: "Ilse Brandt", age: "24" },
      state: { mood: "shy", present: true },
    });
  });

  it("drops the oldest earlier name past the limit", () => {
    const aka = ["A", "B", "C", "D"];
    const { result } = apply(register(entry(1, "E", { aka })), {
      cast: { "E Full": { was: "E" } },
    });
    expect(result.entries[0]?.aka).toEqual(["B", "C", "D", "E"]);
  });

  it("falls back to the single entry whose first name matches a one-word name", () => {
    const { result, calls } = apply(register(entry(1, "Mara Battin")), {
      cast: { Mara: { state: { mood: "bright" } } },
    });
    expect(calls).toBe(0);
    expect(result.entries[0]?.state.mood).toBe("bright");
  });

  it("takes a fuller name for the single one-word entry it extends, keeping the old one", () => {
    const { result, calls } = apply(register(entry(1, "Maren")), {
      cast: { "Maren Holt": { state: { mood: "wary" } } },
    });
    expect(calls).toBe(0);
    expect(result.entries[0]).toMatchObject({
      id: uuid(1),
      anchor: { name: "Maren Holt" },
      aka: ["Maren"],
      state: { mood: "wary" },
    });
  });

  it("follows `was` before a first-name guess, in the register and in what it knew before", () => {
    const answer = { cast: { "Maren Holt": { was: "Maren Voss", state: { mood: "sharp" } } } };
    const both = register(entry(1, "Maren"), entry(2, "Maren Voss"));
    const { result } = apply(both, answer);
    expect(result.entries.map((at) => [at.id, at.anchor.name, at.state.mood])).toEqual([
      [uuid(1), "Maren", ""],
      [uuid(2), "Maren Holt", "sharp"],
    ]);
    // The one `was` names is removed: she stays as she was, and the guess takes no one.
    const removed = apply(both, answer, { removed: new Set([uuid(2)]) });
    expect(removed.calls).toBe(0);
    expect(removed.result).toEqual(both);
    // As for what the chat knew before: `was` finds Voss, not the guess Maren.
    const earlier = apply(register(), answer, { previous: both });
    expect(earlier.result.entries.map((at) => [at.id, at.anchor.name])).toEqual([
      [uuid(2), "Maren Holt"],
    ]);
  });

  it("creates a new entry when the first name is ambiguous", () => {
    const { result, calls } = apply(register(entry(1, "Mara Battin"), entry(2, "Mara Voss")), {
      cast: { Mara: {} },
    });
    expect(calls).toBe(1);
    expect(names(result)).toEqual(["Mara Battin", "Mara Voss", "Mara"]);
  });
});

describe("the player", () => {
  const cast = { cast: { "Mara Voss": {}, Mara: {}, "Mara Battin": {} } };

  it("keeps a fuller name beside a one-word persona and drops the persona's name", () => {
    expect(names(apply(register(), cast, { player: "Mara" }).result)).toEqual([
      "Mara Voss",
      "Mara Battin",
    ]);
  });

  it("drops a full persona name and its first name, and keeps another Mara", () => {
    expect(names(apply(register(), cast, { player: "Mara Voss" }).result)).toEqual(["Mara Battin"]);
  });

  it("drops nothing without a player", () => {
    expect(names(apply(register(), { cast: { Mara: {} } }).result)).toEqual(["Mara"]);
  });
});

describe("anchors and state", () => {
  it("never overwrites a set anchor field and fills empty ones", () => {
    const anchor = { ...emptyCastAnchor("Mara Battin", "female"), age: "18", hair: "brown bob" };
    const { result } = apply(register(entry(1, "Mara Battin", { anchor })), {
      cast: {
        "Mara Battin": { gender: "male", anchor: { age: "30", hair: "", eyes: "green" } },
      },
    });
    expect(result.entries[0]?.anchor).toMatchObject({
      gender: "female",
      age: "18",
      hair: "brown bob",
      eyes: "green",
    });
  });

  it("gives a new entry the whole anchor, `other` and `minor` by default, one id each", () => {
    const { result, calls } = apply(register(), {
      cast: {
        "Jonas Reyes": { anchor: { age: "34" }, state: { activity: "polishing a glass" } },
        "Ana Pires": { role: "principal", gender: "female", state: { present: false } },
      },
    });
    expect(calls).toBe(2);
    expect(result.entries[0]).toEqual({
      id: uuid(100),
      role: "minor",
      anchor: { ...emptyCastAnchor("Jonas Reyes", "other"), age: "34" },
      aka: [],
      state: { ...emptyCastState(true), activity: "polishing a glass" },
    });
    expect(result.entries[1]).toMatchObject({
      id: uuid(101),
      role: "principal",
      anchor: { gender: "female" },
      state: { present: false },
    });
  });

  it("marks `absent` names away, makes a named entry present, ignores unknown names", () => {
    const base = register(
      entry(1, "Mara Battin"),
      entry(2, "Ana Pires", { state: emptyCastState(false) }),
    );
    const { result, calls } = apply(base, {
      cast: { "Ana Pires": { state: { outfit: "coat" } } },
      absent: ["Mara Battin", "Nobody"],
    });
    expect(calls).toBe(0);
    expect(result.entries.map((at) => at.state.present)).toEqual([false, true]);
    expect(result.entries[1]?.state.outfit).toBe("coat");
  });

  it("refuses new entries past the cap and still updates known ones", () => {
    const full = register(
      ...Array.from({ length: CAST_LIMITS.entries }, (_, n) => entry(n + 1, `Person ${n}`)),
    );
    const { result, calls } = apply(full, {
      cast: { "Someone New": {}, "Person 0": { state: { mood: "tired" } } },
    });
    expect(calls).toBe(0);
    expect(result.entries).toHaveLength(CAST_LIMITS.entries);
    expect(result.entries[0]?.state.mood).toBe("tired");
  });
});

describe("a reply read again", () => {
  const previous = register(
    entry(1, "Ilse Brandt"),
    entry(2, "Noor", { state: { ...emptyCastState(true), outfit: "coat" } }),
    entry(3, "Wren"),
  );

  it("keeps the ids its earlier reading gave, lends no state, and a removed one stays removed", () => {
    const { result, calls } = apply(
      register(entry(1, "Ilse Brandt")),
      { cast: { Noor: { state: { mood: "calm" } }, Wren: { state: { mood: "loud" } }, Kai: {} } },
      { previous, removed: new Set([uuid(3)]) },
    );
    expect(calls).toBe(1);
    expect(result.entries.map((at) => at.id)).toEqual([uuid(1), uuid(2), uuid(3), uuid(100)]);
    // Who she is comes from what the chat knew; her state only from the turns read.
    expect(result.entries[1]?.state).toEqual({ ...emptyCastState(true), mood: "calm" });
    expect(result.entries[2]).toMatchObject({ id: uuid(3), anchor: previous.entries[2]?.anchor });
  });

  it("finds an earlier identity by `was` or a fuller name too, and renames it as the register would", () => {
    const { result, calls } = apply(
      register(),
      {
        cast: {
          "Noor Haddad": { state: { mood: "calm" } },
          "Ilse Brandt Moreau": { was: "Ilse Brandt" },
        },
      },
      { previous },
    );
    expect(calls).toBe(0);
    expect(result.entries.map((at) => [at.id, at.anchor.name, at.aka])).toEqual([
      [uuid(2), "Noor Haddad", ["Noor"]],
      [uuid(1), "Ilse Brandt Moreau", ["Ilse Brandt"]],
    ]);
    expect(result.entries[0]?.state).toMatchObject({ outfit: "", mood: "calm" });
  });

  it("gives the id found through what it knew the keeper's name, keeping every earlier one", () => {
    // Known as Maren (once Ilse); the base still has her as Ilse.
    const known = register(entry(1, "Maren", { aka: ["Ilse"] }));
    const { result, calls } = apply(
      register(entry(1, "Ilse")),
      { cast: { Maren: {} } },
      {
        previous: known,
      },
    );
    expect(calls).toBe(0);
    expect(result.entries.map((at) => [at.id, at.anchor.name, at.aka])).toEqual([
      [uuid(1), "Maren", ["Ilse"]],
    ]);
    // A first name only takes the fuller name she has.
    const fuller = apply(
      register(entry(1, "M.")),
      { cast: { Maren: {} } },
      {
        previous: register(entry(1, "Maren Holt", { aka: ["M."] })),
      },
    );
    expect(fuller.result.entries.map((at) => [at.id, at.anchor.name, at.aka])).toEqual([
      [uuid(1), "Maren Holt", ["M."]],
    ]);
  });
});

describe("removed entries", () => {
  it("resolves a re-mention to the removed entry by name and `aka`, adding nothing", () => {
    const base = register(entry(1, "Ilse Brandt", { aka: ["Ilse"] }));
    const { result, calls } = apply(
      base,
      { cast: { Ilse: { state: { mood: "back" } }, "Ilse Brandt": {} }, absent: ["Ilse"] },
      { removed: new Set([uuid(1)]) },
    );
    expect(calls).toBe(0);
    expect(result).toEqual(base);
  });
});

describe("the cast sheet", () => {
  const sheetEntry = (n: number, name: string, fields: Partial<CastEntry["anchor"]> = {}) =>
    ({
      id: uuid(n),
      role: "principal",
      anchor: { ...emptyCastAnchor(name, "female"), ...fields },
      aka: [],
    }) satisfies CastSheetEntry;

  it("seeds a register with every entry away, in sheet order", () => {
    const sheet = { entries: [sheetEntry(1, "Mara Battin"), sheetEntry(2, "Ana Pires")] };
    const seeded = registerFromSheet(sheet);
    expect(seeded.entries.map((at) => [at.id, at.state])).toEqual([
      [uuid(1), emptyCastState(false)],
      [uuid(2), emptyCastState(false)],
    ]);
  });

  it("overlays by id, else by name, adds unmatched entries away, and is idempotent", () => {
    const base = register(
      entry(1, "Mara B.", { anchor: { ...emptyCastAnchor("Mara B.", "other"), age: "19" } }),
      entry(7, "Ana Pires", { anchor: { ...emptyCastAnchor("Ana Pires", "female"), eyes: "" } }),
    );
    const sheet = {
      entries: [
        sheetEntry(1, "Mara Battin", { age: "18", hair: "" }),
        sheetEntry(2, "ana pires", { eyes: "grey" }),
        sheetEntry(3, "Lena Holt"),
      ],
    };
    const once = withSheet(sheet, base);
    expect(once.entries.map((at) => [at.id, at.anchor.name, at.state.present])).toEqual([
      [uuid(1), "Mara B.", true],
      [uuid(7), "Ana Pires", true],
      [uuid(3), "Lena Holt", false],
    ]);
    expect(once.entries[0]?.anchor).toMatchObject({ gender: "female", age: "18", hair: "" });
    expect(once.entries[1]?.anchor.eyes).toBe("grey");
    expect(withSheet(sheet, once)).toEqual(once);
  });

  it("resolves a sheet name as the keeper's: a fuller name finds the single one-word entry", () => {
    const base = register(entry(1, "Maren"));
    const overlaid = withSheet({ entries: [sheetEntry(2, "Maren Holt", { hair: "ash" })] }, base);
    expect(overlaid.entries).toHaveLength(1);
    expect(overlaid.entries[0]).toMatchObject({
      id: uuid(1),
      anchor: { name: "Maren", hair: "ash" },
    });
    // As for the keeper, an ambiguous first name matches nobody.
    const twice = register(entry(1, "Maren Holt"), entry(3, "Maren Voss"));
    expect(withSheet({ entries: [sheetEntry(2, "Maren")] }, twice).entries).toHaveLength(3);
  });

  it("gives a first-name match to no sheet entry when two claim it, and lets an exact one win", () => {
    const base = register(
      entry(1, "Maren", { anchor: { ...emptyCastAnchor("Maren", "female"), hair: "red" } }),
    );
    const two = {
      entries: [
        sheetEntry(2, "Maren Holt", { hair: "ash" }),
        sheetEntry(3, "Maren Voss", { hair: "black" }),
      ],
    };
    const overlaid = withSheet(two, base);
    expect(overlaid.entries.map((at) => [at.id, at.anchor.name, at.anchor.hair])).toEqual([
      [uuid(1), "Maren", "red"],
      [uuid(2), "Maren Holt", "ash"],
      [uuid(3), "Maren Voss", "black"],
    ]);
    expect(withSheet(two, overlaid)).toEqual(overlaid);
    const exact = {
      entries: [
        sheetEntry(2, "Maren Holt", { hair: "ash" }),
        sheetEntry(3, "maren", { hair: "black" }),
      ],
    };
    expect(withSheet(exact, base).entries.map((at) => [at.id, at.anchor.hair])).toEqual([
      [uuid(1), "black"],
      [uuid(2), "ash"],
    ]);
  });

  it("counts the sheet's own new people: a first name that fits one of them overwrites no one", () => {
    const holt = entry(1, "Maren Holt", {
      anchor: { ...emptyCastAnchor("Maren Holt", "female"), hair: "red" },
    });
    const sheet = {
      entries: [
        sheetEntry(2, "Maren Voss", { hair: "black" }),
        sheetEntry(3, "Maren", { hair: "ash" }),
      ],
    };
    const overlaid = withSheet(sheet, register(holt));
    expect(overlaid.entries.map((at) => [at.id, at.anchor.name, at.anchor.hair])).toEqual([
      [uuid(1), "Maren Holt", "red"],
      [uuid(2), "Maren Voss", "black"],
      [uuid(3), "Maren", "ash"],
    ]);
  });

  const red = (n: number, name: string, aka: string[] = []) =>
    entry(n, name, { aka, anchor: { ...emptyCastAnchor(name, "female"), hair: "red" } });
  it.each([
    ["two fuller names over one first name", [red(1, "Maren")], ["Maren Holt", "Maren Voss"]],
    ["a first name beside a fuller one", [red(1, "Maren Holt")], ["Maren Voss", "Maren"]],
    ["an exact match beside a first-name claim", [red(1, "Maren")], ["Maren Holt", "maren"]],
    ["an earlier name", [red(1, "Ilse Brandt", ["Ilse"])], ["Ilse", "Ana Pires"]],
    ["a single first-name match", [red(1, "Maren"), red(4, "Ana")], ["Maren Holt", "Lena"]],
    ["nobody in the register", [], ["Maren Holt", "Maren"]],
  ])("is idempotent: %s", (_label, entries, names) => {
    const sheet = { entries: names.map((name, at) => sheetEntry(at + 10, name, { eyes: "grey" })) };
    const once = withSheet(sheet, register(...entries));
    expect(withSheet(sheet, once)).toEqual(once);
  });

  it("adds no entry past the register's capacity", () => {
    const full = register(
      ...Array.from({ length: CAST_LIMITS.entries }, (_, n) => entry(n + 10, `Person ${n}`)),
    );
    const overlaid = withSheet({ entries: [sheetEntry(2, "Lena Holt")] }, full);
    expect(overlaid.entries).toHaveLength(CAST_LIMITS.entries);
  });
});
