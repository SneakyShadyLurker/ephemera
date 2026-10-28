import { describe, expect, it } from "vitest";
import {
  castModelOf,
  castReasoningOf,
  DEFAULT_SETTINGS,
  imagePromptModelOf,
  settingsPatchSchema,
  settingsSchema,
} from "./index.ts";

describe("cast settings", () => {
  it.each([
    { castModel: null, castReasoning: null },
    { castModel: "glm-5-air", castReasoning: "low" },
  ] as const)("round-trips %j", (cast) => {
    const settings = { ...DEFAULT_SETTINGS, ...cast };
    expect(settingsSchema.parse(settings)).toEqual(settings);
  });

  it("rejects an empty model and an unknown effort", () => {
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, castModel: "" }).success).toBe(false);
    expect(
      settingsSchema.safeParse({ ...DEFAULT_SETTINGS, castReasoning: "extreme" }).success,
    ).toBe(false);
  });

  it("falls back from the cast model to memory's, then the reply's", () => {
    const base = { castModel: null, memoryModel: null, model: null };
    expect(castModelOf(base)).toBeNull();
    expect(castModelOf({ ...base, model: "reply" })).toBe("reply");
    expect(castModelOf({ ...base, model: "reply", memoryModel: "memory" })).toBe("memory");
    expect(castModelOf({ castModel: "cast", memoryModel: "memory", model: "reply" })).toBe("cast");
  });

  it("falls back from the cast effort to memory's, then the model's own", () => {
    expect(castReasoningOf({ castReasoning: null, memoryReasoning: null })).toBeNull();
    expect(castReasoningOf({ castReasoning: null, memoryReasoning: "low" })).toBe("low");
    expect(castReasoningOf({ castReasoning: "high", memoryReasoning: "low" })).toBe("high");
  });
});

describe("image prompt model", () => {
  it("defaults to none and patches to a model or back to none", () => {
    expect(DEFAULT_SETTINGS.imagePromptModel).toBeNull();
    expect(settingsPatchSchema.parse({ imagePromptModel: "glm-5-air" })).toEqual({
      imagePromptModel: "glm-5-air",
    });
    expect(settingsPatchSchema.parse({ imagePromptModel: null })).toEqual({
      imagePromptModel: null,
    });
    expect(settingsPatchSchema.safeParse({ imagePromptModel: "" }).success).toBe(false);
  });

  it("takes the session's choice, else the setting, else the surface's default", () => {
    expect(imagePromptModelOf(null, null, "card")).toBe("card");
    expect(imagePromptModelOf(null, "setting", "card")).toBe("setting");
    expect(imagePromptModelOf("chosen", "setting", "card")).toBe("chosen");
    expect(imagePromptModelOf(null, null, null)).toBeNull();
  });
});
