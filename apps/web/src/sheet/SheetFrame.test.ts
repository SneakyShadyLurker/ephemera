import { describe, expect, it } from "vitest";
import type { SaveStatus } from "./autosave.ts";
import { screenSaving, unsavedPart } from "./SheetFrame.tsx";

const part = (status: SaveStatus, unsaved: boolean, noun: string) => ({
  status,
  hasUnsaved: () => unsaved,
  flush: async () => !unsaved,
  creating: false,
  noun,
});

describe("a screen's shared leave prompt", () => {
  it("speaks for the part whose edits are not saved, signed out or saving included", () => {
    const saved = part({ kind: "saved" }, false, "memory");
    const signedOut = part({ kind: "signed-out" }, true, "notebook");
    expect(unsavedPart([saved, signedOut])).toBe(signedOut);
    const saving = part({ kind: "saving" }, true, "notebook");
    expect(unsavedPart([saved, saving])).toBe(saving);
    const conflict = part({ kind: "conflict" }, true, "memory");
    expect(unsavedPart([saved, conflict])).toBe(conflict);
  });

  it("never speaks for a part with nothing unsaved", () => {
    const settled = part({ kind: "unreachable" }, false, "memory");
    expect(unsavedPart([settled, part({ kind: "saved" }, false, "notebook")])).toBeUndefined();
  });
});

describe("a screen's one save state over several autosaves", () => {
  it("says what is not saved before Saving, and Saving before Saved", () => {
    const notebook = part({ kind: "saved" }, false, "notebook");
    const over = part(
      { kind: "invalid", field: "Cues", limit: "a cue holds at most 60 characters" },
      true,
      "memory",
    );
    expect(screenSaving([notebook, over])).toEqual({ status: over.status, noun: "memory" });
    const saving = part({ kind: "saving" }, true, "notebook");
    expect(screenSaving([saving, over])?.status).toBe(over.status);
    expect(screenSaving([notebook, saving])?.status).toEqual({ kind: "saving" });
    expect(screenSaving([notebook])?.status).toEqual({ kind: "saved" });
    expect(screenSaving([])).toBeNull();
  });
});
