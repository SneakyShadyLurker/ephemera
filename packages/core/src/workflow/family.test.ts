import { describe, expect, it } from "vitest";
import { CREATOR_ART } from "../creator/limits.ts";
import { ART_FAMILIES } from "../creator/prompts.ts";
import { artFamilySchema, fileFamilyOf, renderSizeOf } from "./family.ts";

describe("fileFamilyOf", () => {
  it("names krea2, moss and h3 by the first word of a workflow id", () => {
    expect(fileFamilyOf("krea2-x")).toBe("krea2");
    expect(fileFamilyOf("krea2-second")).toBe("krea2");
    expect(fileFamilyOf("moss-x")).toBe("moss");
    expect(fileFamilyOf("moss")).toBe("moss");
    expect(fileFamilyOf("h3-image")).toBe("h3");
  });

  it("makes every other first word a General workflow", () => {
    for (const id of [
      "flux-x",
      "flux-dev",
      "krea2x-realism",
      "mossy-image",
      "h3x-image",
      "general-x",
      "",
    ]) {
      expect(fileFamilyOf(id)).toBe("general");
    }
  });
});

describe("artFamilySchema", () => {
  it("accepts the four families and nothing else", () => {
    expect(artFamilySchema.options).toEqual(["krea2", "moss", "h3", "general"]);
    expect(artFamilySchema.safeParse("flux").success).toBe(false);
  });
});

describe("renderSizeOf", () => {
  it("renders H3 at 2:3 with edges a multiple of 32 that scale exactly to the portrait", () => {
    const render = renderSizeOf("h3");
    expect(render.width * 3).toBe(render.height * 2);
    expect(render.width % 32).toBe(0);
    expect(render.height % 32).toBe(0);
    expect(render.width * render.height).toBeGreaterThan(7_500_000);
    // ComfyUI's ImageScaleBy rounds the edge times the factor.
    const scale = CREATOR_ART.width / render.width;
    expect(Math.round(render.width * scale)).toBe(CREATOR_ART.width);
    expect(Math.round(render.height * scale)).toBe(CREATOR_ART.height);
  });

  it("renders every other family at the portrait size", () => {
    for (const family of ART_FAMILIES.filter((f) => f !== "h3")) {
      expect(renderSizeOf(family)).toEqual({
        width: CREATOR_ART.width,
        height: CREATOR_ART.height,
      });
    }
  });
});
