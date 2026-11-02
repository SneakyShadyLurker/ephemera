import { describe, expect, it } from "vitest";
import { artFamilySchema, fileFamilyOf } from "./family.ts";

describe("fileFamilyOf", () => {
  it("names krea2 and moss by the first word of a workflow id", () => {
    expect(fileFamilyOf("krea2-x")).toBe("krea2");
    expect(fileFamilyOf("krea2-second")).toBe("krea2");
    expect(fileFamilyOf("moss-x")).toBe("moss");
    expect(fileFamilyOf("moss")).toBe("moss");
  });

  it("makes every other first word a General workflow", () => {
    for (const id of ["flux-x", "flux-dev", "krea2x-realism", "mossy-image", "general-x", ""]) {
      expect(fileFamilyOf(id)).toBe("general");
    }
  });
});

describe("artFamilySchema", () => {
  it("accepts the three families and nothing else", () => {
    expect(artFamilySchema.options).toEqual(["krea2", "moss", "general"]);
    expect(artFamilySchema.safeParse("flux").success).toBe(false);
  });
});
