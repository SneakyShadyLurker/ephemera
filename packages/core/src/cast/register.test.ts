import * as core from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { repairObject } from "../memory/answer.ts";
import { CAST_LIMITS } from "./limits.ts";
import {
  castAnchorSchema,
  castChangesSchema,
  castSheetAnswerSchema,
  castSheetEntrySchema,
  castStateSchema,
  clampCastChanges,
  clampCastCorrection,
  clampCastSheetAnswer,
  emptyCastAnchor,
  sheetEntriesFromAnswer,
} from "./register.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the cast module", () => {
  it("loads through the package entry with chat.ts beside it", () => {
    expect(core.castRegisterSchema.parse({ entries: [] })).toEqual({ entries: [] });
    expect(typeof core.generateRequestSchema.parse).toBe("function");
  });
});

describe("clamping an owner's correction", () => {
  it("cuts every text to its bound, so the register stays valid", () => {
    const long = "word ".repeat(100);
    const clamped = clampCastCorrection({
      anchor: { name: ` ${"N".repeat(CAST_LIMITS.name + 5)}`, hair: long },
      state: { outfit: long, present: false },
    });
    const anchor = { ...emptyCastAnchor("Ilse", "female"), ...clamped?.anchor };
    expect(castAnchorSchema.safeParse(anchor).success).toBe(true);
    expect(anchor.hair.length).toBeLessThanOrEqual(CAST_LIMITS.field);
    expect(anchor.name).toHaveLength(CAST_LIMITS.name);
    expect(clamped?.state?.outfit?.length).toBeLessThanOrEqual(CAST_LIMITS.longField);
    expect(clamped?.state?.present).toBe(false);
    expect(castStateSchema.partial().safeParse(clamped?.state).success).toBe(true);
  });

  it("refuses a blank name", () => {
    expect(clampCastCorrection({ anchor: { name: "  " } })).toBeNull();
  });
});

describe("clamping the keeper's answer", () => {
  it.each([
    { value: "late twenties", evidence: "Ilse smiles" },
    { value: "late twenties", basis: "inferred", evidence: "Ilse smiles" },
    { value: "late twenties", basis: "seen", evidence: " " },
    { value: 29, basis: "told", evidence: "Ilse smiles" },
    null,
  ])("drops an unusable discovery without losing the NPC: %j", (age) => {
    const introduce = { evidence: "Ilse smiles" };
    const hair = { value: "black hair", basis: "seen", evidence: "black hair" };
    const parsed = castChangesSchema.parse(
      clampCastChanges({
        cast: {
          Ilse: {
            gender: "female",
            anchor: { age: "29" },
            introduce,
            discovered: { age, hair },
          },
        },
      }),
    );
    expect(parsed.cast.Ilse).toEqual({
      gender: "female",
      anchor: { age: "29" },
      introduce,
      discovered: { hair },
    });
  });

  it.each([
    { value: "short now", evidence: "" },
    { value: " ", evidence: "Mara cut it" },
    { value: "short now" },
    null,
  ])("drops an ungrounded development or continuity cue without losing the NPC: %j", (cue) => {
    const kept = { value: "a limp", evidence: "Mara favours her left leg" };
    const goals = { value: "find the ledger", evidence: "Mara asks about the ledger" };
    const parsed = castChangesSchema.parse(
      clampCastChanges({
        cast: {
          Mara: {
            state: { mood: "calm" },
            developments: { hair: cue, build: kept },
            continuity: { voice: cue, goals },
          },
        },
        absent: ["Ilse"],
      }),
    );
    expect(parsed).toEqual({
      cast: {
        Mara: {
          state: { mood: "calm" },
          developments: { build: kept },
          continuity: { goals },
        },
      },
      absent: ["Ilse"],
    });
  });

  it.each([true, "Ilse smiles", { evidence: " " }, {}])(
    "drops an unusable introduction without losing the NPC: %j",
    (introduce) => {
      const parsed = castChangesSchema.parse(
        clampCastChanges({
          cast: { Ilse: { gender: "female", anchor: { age: "29" }, introduce } },
        }),
      );
      expect(parsed.cast.Ilse).toEqual({ gender: "female", anchor: { age: "29" } });
    },
  );

  it("keeps an answer with one overlong field and one unknown key", () => {
    const long = "word ".repeat(100);
    const answer = {
      cast: { "Mara Battin": { state: { outfit: long, mood: "calm" }, extra: true } },
      absent: [],
      note: "ignored",
    };
    expect(castChangesSchema.safeParse(answer).success).toBe(false);
    const parsed = castChangesSchema.parse(clampCastChanges(answer));
    const state = parsed.cast["Mara Battin"]?.state;
    expect(state?.outfit?.length).toBeLessThanOrEqual(CAST_LIMITS.longField);
    expect(state?.mood).toBe("calm");
    expect(parsed).not.toHaveProperty("note");
  });

  it("drops a blank `was` and blank names, and caps the changes at the register's size", () => {
    const cast = Object.fromEntries(
      Array.from({ length: CAST_LIMITS.entries + 5 }, (_, n) => [`Person ${n}`, {}]),
    );
    const parsed = castChangesSchema.parse(
      clampCastChanges({ cast: { ...cast, "  ": {}, "Person 0": { was: " " } }, absent: [" "] }),
    );
    expect(Object.keys(parsed.cast)).toHaveLength(CAST_LIMITS.entries);
    expect(parsed.cast["Person 0"]).toEqual({});
    expect(parsed.absent).toEqual([]);
  });

  it("clamps introductions and discoveries without letting them into stored sheets", () => {
    const long = "x".repeat(400);
    const parsed = castChangesSchema.parse(
      clampCastChanges({
        cast: {
          Mara: {
            introduce: { evidence: long, unknown: true },
            discovered: {
              age: { value: long, basis: "told", evidence: long, unknown: true },
            },
          },
        },
      }),
    );
    expect(parsed.cast.Mara?.introduce?.evidence).toHaveLength(CAST_LIMITS.field);
    expect(parsed.cast.Mara?.discovered?.age).toMatchObject({ basis: "told" });
    expect(parsed.cast.Mara?.discovered?.age?.value).toHaveLength(CAST_LIMITS.field);
    expect(parsed.cast.Mara?.discovered?.age?.evidence).toHaveLength(CAST_LIMITS.field);
    const [sheet] = sheetEntriesFromAnswer(
      castSheetAnswerSchema.parse({ cast: [{ name: "Mara", gender: "female", anchor: {} }] }),
      () => uuid(1),
    );
    expect(castSheetEntrySchema.safeParse({ ...sheet, introduced: true }).success).toBe(false);
    expect(
      castSheetEntrySchema.safeParse({
        ...sheet,
        discovered: parsed.cast.Mara?.discovered,
      }).success,
    ).toBe(false);
  });
});

describe("an answer a model wrote loosely", () => {
  it("reads one a closing brace short, its absent list inside cast", () => {
    // What a model one brace short writes: `cast` never closes before `absent`.
    const text =
      '{"cast":{"Ilse Brandt":{"state":{"activity":"tending the bar"}},"absent":["Ana Pires"]}';
    expect(repairObject(text, castChangesSchema, clampCastChanges)).toEqual({
      cast: { "Ilse Brandt": { state: { activity: "tending the bar" } } },
      absent: ["Ana Pires"],
    });
  });

  it("refuses one cut off inside its absent list or a later NPC", () => {
    expect(
      repairObject('{"cast":{},"absent":["Ana', castChangesSchema, clampCastChanges),
    ).toBeUndefined();
    expect(
      repairObject(
        '{"cast":{"Mara Battin":{"state":{"mood":"calm"}},"Jonas Reyes":{"state":{"present":fal',
        castChangesSchema,
        clampCastChanges,
      ),
    ).toBeUndefined();
  });

  it("moves an absent list out of cast only when the answer has none of its own", () => {
    expect(clampCastChanges({ cast: { absent: ["Ana Pires"] } })).toEqual({
      cast: {},
      absent: ["Ana Pires"],
    });
    // An NPC's change is an object, so one keyed "absent" stays an entry.
    expect(clampCastChanges({ cast: { absent: { state: { mood: "calm" } } }, absent: [] })).toEqual(
      { cast: { absent: { state: { mood: "calm" } } }, absent: [] },
    );
  });

  it("drops a change that is no object and keeps the others", () => {
    const clamped = clampCastChanges({
      cast: { "Ilse Brandt": { state: { mood: "calm" } }, "Ilse Brandt.note": "seen", Ana: null },
      absent: [],
    });
    expect(castChangesSchema.parse(clamped)).toEqual({
      cast: { "Ilse Brandt": { state: { mood: "calm" } } },
      absent: [],
    });
  });

  it("joins a field written as a list of strings", () => {
    const clamped = clampCastChanges({
      cast: {
        "Ilse Brandt": {
          anchor: { personality: ["dry", "watchful"] },
          state: { mood: ["guarded", 3] },
        },
      },
    });
    expect(clamped).toEqual({
      cast: {
        "Ilse Brandt": {
          anchor: { personality: "dry, watchful" },
          state: { mood: ["guarded", 3] },
        },
      },
    });
    expect(castChangesSchema.safeParse(clamped).success).toBe(false);
  });
});

describe("the sheet answer", () => {
  it("clamps a malformed answer into at most eight entries with ids and empty missing fields", () => {
    const person = (name: string) => ({ name, gender: "female", anchor: { age: "20" } });
    const answer = {
      cast: [
        { name: "Mara Battin", anchor: { hair: "x".repeat(400) }, mood: "extra key" },
        person("Ana Pires"),
        person("mara battin"),
        ...["B", "C", "D", "E", "F", "G", "H"].map((n) => person(`Person ${n}`)),
      ],
    };
    expect(answer.cast).toHaveLength(10);
    expect(castSheetAnswerSchema.safeParse(answer).success).toBe(false);
    const parsed = castSheetAnswerSchema.parse(clampCastSheetAnswer(answer));
    let next = 0;
    const entries = sheetEntriesFromAnswer(parsed, () => uuid(++next));
    expect(entries).toHaveLength(CAST_LIMITS.sheetEntries);
    expect(next).toBe(CAST_LIMITS.sheetEntries);
    expect(entries.map((at) => at.anchor.name)).toEqual([
      "Mara Battin",
      "Ana Pires",
      "Person B",
      "Person C",
      "Person D",
      "Person E",
      "Person F",
      "Person G",
    ]);
    expect(entries[0]?.anchor.hair.length).toBeLessThanOrEqual(CAST_LIMITS.field);
    expect(entries[0]).toMatchObject({ id: uuid(1), role: "principal", aka: [] });
    expect(entries[0]?.anchor.gender).toBe("other");
    expect(entries[1]?.anchor).toEqual({ ...emptyCastAnchor("Ana Pires", "female"), age: "20" });
  });
});

describe("a gender as a model writes it", () => {
  const sheetGender = (gender: unknown) =>
    castSheetAnswerSchema.parse(
      clampCastSheetAnswer({
        cast: [{ name: "Mara", ...(gender === undefined ? {} : { gender }), anchor: {} }],
      }),
    ).cast[0]?.gender;
  const changeGender = (gender: unknown) =>
    castChangesSchema.parse(
      clampCastChanges({ cast: { Mara: { gender, state: { mood: "calm" } } } }),
    ).cast.Mara;

  it.each([
    ["Female", "female"],
    [" WOMAN ", "female"],
    ["girl", "female"],
    ["f", "female"],
    ["Male", "male"],
    ["man", "male"],
    ["non-binary", "other"],
    ["futanari", "other"],
    ["constructor", "other"],
    [undefined, "other"],
    [3, "other"],
  ])("reads a sheet's %j as %s", (written, read) => {
    expect(sheetGender(written)).toBe(read);
  });

  it("reads a keeper's the same, and drops one it cannot read without losing the change", () => {
    expect(changeGender("Woman")?.gender).toBe("female");
    expect(changeGender("M")?.gender).toBe("male");
    expect(changeGender("Other")?.gender).toBe("other");
    expect(changeGender("unclear")).toEqual({ state: { mood: "calm" } });
    expect(changeGender(null)).toEqual({ state: { mood: "calm" } });
  });
});

describe("field bounds", () => {
  const atLong = "x".repeat(CAST_LIMITS.longField);
  const overLong = "x".repeat(CAST_LIMITS.longField + 1);
  const overShort = "x".repeat(CAST_LIMITS.field + 1);

  it("gives intimate, outfit and disarray the long bound and every other field the short one", () => {
    expect(CAST_LIMITS.longField).toBe(480);
    expect(CAST_LIMITS.field).toBe(240);
    const anchor = emptyCastAnchor("Mara", "female");
    expect(castAnchorSchema.safeParse({ ...anchor, intimate: atLong }).success).toBe(true);
    expect(castAnchorSchema.safeParse({ ...anchor, intimate: overLong }).success).toBe(false);
    expect(castAnchorSchema.safeParse({ ...anchor, hair: overShort }).success).toBe(false);
    const state = castStateSchema.partial();
    expect(state.safeParse({ outfit: atLong, disarray: atLong }).success).toBe(true);
    expect(state.safeParse({ outfit: overLong }).success).toBe(false);
    expect(state.safeParse({ disarray: overLong }).success).toBe(false);
    expect(state.safeParse({ mood: overShort }).success).toBe(false);
  });

  it("keeps a keeper answer's long fields whole up to their bound and cuts past it", () => {
    const answer = (long: string) =>
      castChangesSchema.parse(
        clampCastChanges({
          cast: {
            Mara: {
              anchor: { intimate: long, hair: overShort },
              state: { outfit: long, disarray: long },
              developments: { intimate: { value: long, evidence: long } },
              discovered: { intimate: { value: long, basis: "seen", evidence: long } },
            },
          },
        }),
      ).cast.Mara;
    const kept = answer(atLong);
    expect(kept?.anchor?.intimate).toBe(atLong);
    expect(kept?.state?.outfit).toBe(atLong);
    expect(kept?.state?.disarray).toBe(atLong);
    expect(kept?.developments?.intimate?.value).toBe(atLong);
    expect(kept?.discovered?.intimate?.value).toBe(atLong);
    expect(kept?.developments?.intimate?.evidence.length).toBeLessThanOrEqual(CAST_LIMITS.field);
    expect(kept?.discovered?.intimate?.evidence.length).toBeLessThanOrEqual(CAST_LIMITS.field);
    expect(kept?.anchor?.hair?.length).toBeLessThanOrEqual(CAST_LIMITS.field);
    const cut = answer(overLong);
    for (const value of [
      cut?.anchor?.intimate,
      cut?.state?.outfit,
      cut?.state?.disarray,
      cut?.developments?.intimate?.value,
      cut?.discovered?.intimate?.value,
    ]) {
      expect(value?.length).toBeGreaterThan(CAST_LIMITS.field);
      expect(value?.length).toBeLessThanOrEqual(CAST_LIMITS.longField);
    }
  });

  it("keeps a sheet answer's intimate whole up to its bound and cuts past it", () => {
    const sheet = (intimate: string) =>
      castSheetAnswerSchema.parse(
        clampCastSheetAnswer({
          cast: [{ name: "Mara", gender: "female", anchor: { intimate, hair: overShort } }],
        }),
      ).cast[0]?.anchor;
    expect(sheet(atLong)?.intimate).toBe(atLong);
    expect(sheet(overLong)?.intimate?.length).toBeLessThanOrEqual(CAST_LIMITS.longField);
    expect(sheet(atLong)?.hair?.length).toBeLessThanOrEqual(CAST_LIMITS.field);
  });

  it("keeps an owner's long corrections whole up to their bound and cuts past it", () => {
    const corrected = (long: string) =>
      clampCastCorrection({
        anchor: { intimate: long, hair: overShort },
        state: { outfit: long, disarray: long },
      });
    const kept = corrected(atLong);
    expect(kept?.anchor?.intimate).toBe(atLong);
    expect(kept?.state).toEqual({ outfit: atLong, disarray: atLong });
    expect(kept?.anchor?.hair?.length).toBeLessThanOrEqual(CAST_LIMITS.field);
    const cut = corrected(overLong);
    expect(cut?.anchor?.intimate?.length).toBeLessThanOrEqual(CAST_LIMITS.longField);
    expect(cut?.state?.outfit?.length).toBeLessThanOrEqual(CAST_LIMITS.longField);
    expect(cut?.state?.disarray?.length).toBeLessThanOrEqual(CAST_LIMITS.longField);
  });
});
