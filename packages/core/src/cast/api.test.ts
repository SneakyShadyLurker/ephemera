import { describe, expect, it } from "vitest";
import { blankCard } from "../card/index.ts";
import { castRefusalSchema, castSheetSchema, castUpdateRequestSchema } from "./api.ts";
import { castFingerprintInput } from "./fingerprint.ts";
import { emptyCastAnchor } from "./register.ts";

const request = {
  model: "glm-5",
  mode: "update",
  sheetFingerprint: null,
  register: { entries: [] },
  turns: [{ role: "assistant", content: "Mara waits." }],
};

describe("the keeper request", () => {
  it("takes a request without a card and defaults nothing it was not sent", () => {
    expect(castUpdateRequestSchema.parse(request)).toEqual(request);
  });

  it("refuses no turns, too many turns, an unknown key and a short fingerprint", () => {
    const turn = request.turns[0];
    for (const bad of [
      { ...request, turns: [] },
      { ...request, turns: Array.from({ length: 13 }, () => turn) },
      { ...request, extra: true },
      { ...request, sheetFingerprint: "abc" },
    ]) {
      expect(castUpdateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the cast sheet", () => {
  it("holds at most eight entries", () => {
    const entry = {
      id: "00000000-0000-4000-8000-000000000001",
      role: "principal",
      anchor: emptyCastAnchor("Mara", "female"),
      aka: [],
    };
    const sheet = (length: number) =>
      castSheetSchema.safeParse({
        characterId: "00000000-0000-4000-8000-000000000009",
        fingerprint: "a".repeat(64),
        entries: Array.from({ length }, () => entry),
        revision: 1,
        updatedAt: 0,
      }).success;
    expect(sheet(8)).toBe(true);
    expect(sheet(9)).toBe(false);
  });

  it("fingerprints the card's described fields and kind, not its greeting", () => {
    const card = { ...blankCard("Mara"), description: "Keeps the light.", tags: ["Scenario"] };
    const input = castFingerprintInput(card);
    expect(JSON.parse(input)).toEqual(["Mara", "Keeps the light.", "", "", "scenario"]);
    const greeted = { ...card, firstMessage: "Hello." };
    expect(castFingerprintInput(greeted)).toBe(input);
  });

  it("fingerprints an untagged card apart from a Subject-tagged one, as the sheet call reads them", () => {
    const card = { ...blankCard("Mara"), description: "Keeps the light." };
    const untagged = castFingerprintInput(card);
    const subject = castFingerprintInput({ ...card, tags: ["Subject"] });
    expect(subject).not.toBe(untagged);
    expect(JSON.parse(untagged).at(-1)).toBeNull();
    expect(castFingerprintInput({ ...card, tags: [] })).toBe(untagged);
  });
});

describe("refusals", () => {
  it("names cast_failed and the shared codes", () => {
    expect(castRefusalSchema.parse({ error: "cast_failed" })).toEqual({ error: "cast_failed" });
    expect(castRefusalSchema.safeParse({ error: "memory_failed" }).success).toBe(false);
  });
});
