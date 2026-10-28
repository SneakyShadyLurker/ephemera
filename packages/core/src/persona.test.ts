import { describe, expect, it } from "vitest";
import { uuid } from "../test-fixtures/uuid.ts";
import { CARD_LIMITS } from "./card/limits.ts";
import {
  copyName,
  personaFieldsSchema,
  resolvePersona,
  settingsPatchSchema,
  settingsSchema,
} from "./index.ts";

describe("personas", () => {
  it("accepts a name and description within card limits, trimming the name", () => {
    expect(personaFieldsSchema.parse({ name: "  Aria  ", description: "" })).toEqual({
      name: "Aria",
      description: "",
    });
    expect(personaFieldsSchema.safeParse({ name: " ", description: "" }).success).toBe(false);
    expect(
      personaFieldsSchema.safeParse({
        name: "x".repeat(CARD_LIMITS.nameLength + 1),
        description: "",
      }).success,
    ).toBe(false);
    expect(
      personaFieldsSchema.safeParse({
        name: "A",
        description: "x".repeat(CARD_LIMITS.textLength + 1),
      }).success,
    ).toBe(false);
    expect(personaFieldsSchema.safeParse({ name: "A", description: "", avatar: "x" }).success).toBe(
      false,
    );
  });

  it("names a copy within the name limit", () => {
    expect(copyName("Aria")).toBe("Aria (copy)");
    expect(copyName("x".repeat(CARD_LIMITS.nameLength))).toHaveLength(CARD_LIMITS.nameLength);
  });

  it("never cuts a copy's name inside a character", () => {
    const head = "x".repeat(CARD_LIMITS.nameLength - " (copy)".length - 1);
    expect(copyName(`${head}😀😀`)).toBe(`${head}😀 (copy)`);
    expect(copyName(`${head}😀😀`).isWellFormed()).toBe(true);
  });

  it("resolves the persona for a new chat: bound, else default, else current", () => {
    expect(resolvePersona({ bound: "b", defaultPersona: "d", current: "c" })).toBe("b");
    expect(resolvePersona({ bound: null, defaultPersona: "d", current: "c" })).toBe("d");
    expect(resolvePersona({ bound: null, defaultPersona: null, current: "c" })).toBe("c");
    expect(resolvePersona({ bound: null, defaultPersona: null, current: null })).toBeNull();
  });
});

describe("settings", () => {
  const id = uuid();

  it("accepts the settings shape and strict partial patches", () => {
    const settings = {
      theme: "dark",
      palette: "nord",
      model: "m",
      imagePromptModel: null,
      characterId: id,
      personaId: null,
      defaultPersonaId: null,
      promptPresetId: id,
      samplerPresetId: id,
      contextWindows: { "kimi-k3": 32_768 },
      contextLimits: { "kimi-k3": 16_384 },
      promptProcessing: { "qwen3.8-max": "semiStrict" },
      reasoningOpen: false,
      showHiddenReasoning: true,
      preferCharacterPrompt: false,
      preferCharacterInstructions: true,
      comfyuiBaseUrl: "https://comfy.test:8188",
      comfyuiWorkflow: "krea2-gonzalomo",
      memoryOpening: false,
      memoryModel: null,
      memoryReasoning: "low",
      memorySpanTokens: 6_000,
      memoryKeepTurns: 4,
      memoryRecapTokens: 3_000,
      castModel: "glm-5-air",
      castReasoning: null,
    };
    expect(settingsSchema.parse(settings)).toEqual(settings);
    expect(settingsPatchSchema.parse({ theme: "light" })).toEqual({ theme: "light" });
  });

  it.each([
    { theme: "sepia" },
    { palette: "solarized" },
    { palette: "custom-4" },
    { characterId: "not-a-uuid" },
    { model: "" },
    { messages: [{ role: "user", content: "canary" }] },
    { draft: "canary" },
    { promptProcessing: { m: "none" } },
    { promptProcessing: { m: "loose" } },
    { reasoningOpen: "yes" },
    { comfyuiBaseUrl: "ftp://comfy.test" },
    { comfyuiBaseUrl: ["https://user", "placeholder@comfy.test"].join(":") },
    { comfyuiWorkflow: "Custom Workflow" },
    { comfyuiWorkflow: "../krea2-gonzalomo" },
  ])("rejects %j", (patch) => {
    expect(settingsPatchSchema.safeParse(patch).success).toBe(false);
  });
});
