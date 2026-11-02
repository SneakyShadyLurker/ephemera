import { describe, expect, it } from "vitest";
import { applySheetPatch } from "./patch.ts";
import { blankCard, characterPatchSchema } from "./schema.ts";

describe("a native sheet edit", () => {
  it("changes supplied fields and preserves the note and embedded book", () => {
    const card = {
      ...blankCard("Mara"),
      characterNote: { prompt: "Fog.", depth: 2, role: "system" as const },
      lorebook: { entries: [] },
    };
    const edited = applySheetPatch(card, { description: "A lighthouse keeper." });
    expect(edited).toEqual({ ...card, description: "A lighthouse keeper." });
    expect(applySheetPatch(edited, { lorebook: null })).not.toHaveProperty("lorebook");
    expect(card.description).toBe("");
  });
  it("refuses an Author's Note, which belongs to the preset", () => {
    expect(characterPatchSchema.safeParse({ authorsNote: null }).success).toBe(false);
  });
});
