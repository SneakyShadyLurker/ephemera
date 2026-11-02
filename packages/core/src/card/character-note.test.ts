import { describe, expect, it } from "vitest";
import { serializeCharacter } from "../native-files.ts";
import { upgradeLegacyCharacterCard } from "./import.ts";
import { CARD_LIMITS } from "./limits.ts";
import { applySheetPatch } from "./patch.ts";
import { blankCard, characterCardSchema, storedCharacterCardSchema } from "./schema.ts";

const convert = (depth_prompt: unknown) =>
  upgradeLegacyCharacterCard({ name: "Mara", extensions: { depth_prompt } });
describe("native character notes and old saved notes", () => {
  it("converts recognized notes without retaining extension data", () => {
    const card = convert({
      prompt: "Keep <BOT>'s lamp.",
      depth: "2",
      role: "user",
      unknown: "discard",
    });
    expect(card.characterNote).toEqual({
      prompt: "Keep {{char}}'s lamp.",
      depth: 2,
      role: "user",
    });
    expect(card).not.toHaveProperty("extensions");
  });
  it.each([-1, 1001, 2.5, "2.5", "", " 2", "-1", "deep", null, true, [2]])(
    "uses the default for invalid foreign depth %j",
    (depth) => {
      expect(convert({ prompt: "x", depth }).characterNote?.depth).toBe(4);
    },
  );
  it.each(["narrator", "", 1, null, "System"])(
    "uses system for invalid foreign role %j",
    (role) => {
      expect(convert({ prompt: "x", role }).characterNote?.role).toBe("system");
    },
  );
  it.each([null, "note", 42, { prompt: 7 }, { depth: 4 }])(
    "omits unrecognized foreign notes %j",
    (value) => {
      expect(convert(value).characterNote).toBeUndefined();
    },
  );
  it("preserves notes beyond the former editor maximum and bounds writes by whole-card bytes", () => {
    const prompt = "x".repeat(CARD_LIMITS.textLength + 1);
    const card = convert({ prompt, depth: 3, role: "assistant" });
    expect(card.characterNote?.prompt).toBe(prompt);
    expect(characterCardSchema.parse(card)).toEqual(card);
    expect(JSON.parse(serializeCharacter(card)).data.characterNote.prompt).toBe(prompt);
    const wider = convert({ prompt: "x".repeat(CARD_LIMITS.cardJsonBytes), depth: 3 });
    expect(storedCharacterCardSchema.parse(wider).characterNote?.prompt.length).toBe(
      CARD_LIMITS.cardJsonBytes,
    );
    expect(characterCardSchema.safeParse(wider).success).toBe(false);
    expect(() => serializeCharacter(wider)).toThrow();
    expect(
      characterCardSchema.safeParse(applySheetPatch(wider, { characterNote: null })).success,
    ).toBe(true);
  });
  it("edits notes directly and removes them with null", () => {
    const card = blankCard("Mara");
    const note = { prompt: "", depth: 1, role: "user" as const };
    expect(applySheetPatch(card, { characterNote: note }).characterNote).toEqual(note);
    expect(
      applySheetPatch({ ...card, characterNote: note }, { characterNote: null }).characterNote,
    ).toBeUndefined();
    expect(card).not.toHaveProperty("characterNote");
  });
});
