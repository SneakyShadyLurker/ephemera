import * as core from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { CAST_LIMITS } from "./limits.ts";
import {
  castAnchorSchema,
  castChangesSchema,
  castSheetAnswerSchema,
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
    expect(clamped?.state?.outfit?.length).toBeLessThanOrEqual(CAST_LIMITS.field);
    expect(clamped?.state?.present).toBe(false);
    expect(castStateSchema.partial().safeParse(clamped?.state).success).toBe(true);
  });

  it("refuses a blank name", () => {
    expect(clampCastCorrection({ anchor: { name: "  " } })).toBeNull();
  });
});

describe("clamping the keeper's answer", () => {
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
    expect(state?.outfit?.length).toBeLessThanOrEqual(CAST_LIMITS.field);
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
