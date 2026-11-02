import { describe, expect, it } from "vitest";
import { SECTIONS, sectionSchema, shownSection } from "./sections.ts";

describe("Settings categories", () => {
  it("parse their own ids and nothing else", () => {
    for (const section of SECTIONS) expect(sectionSchema.parse(section)).toBe(section);
    expect(sectionSchema.safeParse("portraits").success).toBe(false);
    expect(sectionSchema.optional().catch(undefined).parse("models")).toBeUndefined();
  });

  it("open Model setup while a window link is followed, whatever was asked", () => {
    expect(shownSection({ section: "memory", window: "some-model" }, false)).toBe("setup");
    expect(shownSection({ window: "some-model" }, true)).toBe("setup");
  });

  it("open the category asked for, else Appearance, or the phone's list", () => {
    expect(shownSection({ section: "pictures" }, true)).toBe("pictures");
    expect(shownSection({}, false)).toBe("appearance");
    expect(shownSection({}, true)).toBeNull();
  });
});
