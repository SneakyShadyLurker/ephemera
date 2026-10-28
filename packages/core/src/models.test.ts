import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_RANGE,
  type ContextLimits,
  type ContextWindows,
  contextLimitsSchema,
  contextWindowsSchema,
  DEFAULT_CONTEXT_LIMIT,
  effectiveWindow,
  effortFor,
  modelsFromCatalog,
  offeredEfforts,
} from "./models.ts";

/** A representative CLIProxyAPI catalog for `/v1/models?client_version=` (fields trimmed). */
const catalog = {
  models: [
    {
      slug: "kimi-k3",
      display_name: "Kimi K3",
      context_window: 1_048_576,
      max_context_window: 1_048_576,
      supported_reasoning_levels: [
        { effort: "none", description: "No reasoning" },
        { effort: "low", description: "Fast responses" },
        { effort: "high", description: "Greater depth" },
        { effort: "max", description: "Maximum" },
        { effort: "ultra", description: "Listed, but the chat endpoint refuses it" },
      ],
      base_instructions: "long text the parser ignores",
      visibility: "list",
    },
    {
      slug: "glm-flash-low",
      context_window: 262_144,
      supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
    },
    { slug: "no-window", supported_reasoning_levels: [] },
    { slug: "zero-window", context_window: 0 },
    { slug: "odd-window", context_window: "272000", supported_reasoning_levels: "high" },
  ],
};

describe("model catalog", () => {
  it("reads each model's context window and the reasoning efforts Ephemera can send", () => {
    const models = modelsFromCatalog(catalog);
    expect(models).toEqual([
      { id: "glm-flash-low", contextWindow: 262_144, reasoning: ["low"], images: null },
      {
        id: "kimi-k3",
        contextWindow: 1_048_576,
        reasoning: ["none", "low", "high", "max"],
        images: null,
      },
      { id: "no-window", contextWindow: null, reasoning: [], images: null },
      { id: "odd-window", contextWindow: null, reasoning: null, images: null },
      { id: "zero-window", contextWindow: null, reasoning: null, images: null },
    ]);
  });

  it("leaves out entries the catalog hides", () => {
    const models = modelsFromCatalog({
      models: [
        { slug: "image-model", context_window: 8_192, visibility: "hide" },
        { slug: "odd-visibility", context_window: 8_192, visibility: 3 },
        catalog.models[1],
      ],
    });
    expect(models?.map((model) => model.id)).toEqual(["glm-flash-low", "odd-visibility"]);
  });

  it("reads the standard model list, with nothing reported beyond each id", () => {
    const models = modelsFromCatalog({
      object: "list",
      data: [
        { id: "zeta", object: "model", owned_by: "someone" },
        { id: "alpha", object: "model" },
        { id: "alpha", context_window: 8_192 },
        { object: "model" },
        { id: "x".repeat(201) },
      ],
    });
    expect(models).toEqual([
      { id: "alpha", contextWindow: null, reasoning: null, images: null },
      { id: "zeta", contextWindow: null, reasoning: null, images: null },
    ]);
    expect(modelsFromCatalog({ data: [{ id: "kimi-k3" }] })).toEqual([
      { id: "kimi-k3", contextWindow: null, reasoning: null, images: null },
    ]);
  });

  it("reads the rich fields a standard list entry carries", () => {
    const models = modelsFromCatalog({
      object: "list",
      data: [
        {
          id: "vision",
          context_window: 65_536,
          supported_reasoning_levels: [{ effort: "high" }],
          input_modalities: ["text", "image"],
        },
        { id: "hidden", visibility: "hide" },
      ],
    });
    expect(models).toEqual([
      { id: "vision", contextWindow: 65_536, reasoning: ["high"], images: true },
    ]);
  });

  it("refuses a standard list with more entries than any real one", () => {
    const data = Array.from({ length: 2_001 }, (_, i) => ({ id: `m${i}` }));
    expect(modelsFromCatalog({ object: "list", data })).toBeUndefined();
  });

  it("returns undefined for a response that is not a catalog", () => {
    expect(modelsFromCatalog({ object: "list" })).toBeUndefined();
    expect(modelsFromCatalog({ data: "kimi-k3" })).toBeUndefined();
    expect(modelsFromCatalog({ list: [{ id: "kimi-k3" }] })).toBeUndefined();
    expect(modelsFromCatalog("nope")).toBeUndefined();
  });

  it("skips a malformed entry and keeps the others", () => {
    const models = modelsFromCatalog({
      models: [{ display_name: "no slug" }, { slug: "x".repeat(201) }, catalog.models[1]],
    });
    expect(models?.map((model) => model.id)).toEqual(["glm-flash-low"]);
  });

  it("reads whether a model takes images from its input modalities", () => {
    const models = modelsFromCatalog({
      models: [
        { slug: "vision", input_modalities: ["text", "image"] },
        { slug: "text-only", input_modalities: ["text"] },
        { slug: "silent" },
        { slug: "odd-modalities", input_modalities: "text,image" },
        { slug: "odd-items", input_modalities: ["text", 3] },
      ],
    });
    expect(models?.map(({ id, images }) => [id, images])).toEqual([
      ["odd-items", null],
      ["odd-modalities", null],
      ["silent", null],
      ["text-only", false],
      ["vision", true],
    ]);
  });

  it("keeps one entry per id", () => {
    const twice = { models: [catalog.models[0], { ...catalog.models[0], context_window: 5 }] };
    expect(modelsFromCatalog(twice)).toHaveLength(1);
  });
});

describe("offered reasoning efforts", () => {
  it("narrows to the model's reported efforts, after the model default", () => {
    expect(
      offeredEfforts({ id: "a", contextWindow: 1, reasoning: ["low", "high"], images: null }),
    ).toEqual(["provider-default", "low", "high"]);
  });

  it("offers max where the catalog reports it, and never ultra", () => {
    const [kimi] = modelsFromCatalog({ models: [catalog.models[0]] }) ?? [];
    expect(offeredEfforts(kimi)).toEqual(["provider-default", "none", "low", "high", "max"]);
    expect(offeredEfforts(kimi)).not.toContain("ultra");
  });

  it("offers only the model default when the model reports no reasoning", () => {
    expect(offeredEfforts({ id: "a", contextWindow: 1, reasoning: [], images: null })).toEqual([
      "provider-default",
    ]);
  });

  it("offers every effort when support is not reported, or the model is unknown", () => {
    const all = ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(offeredEfforts({ id: "a", contextWindow: 1, reasoning: null, images: null })).toEqual(
      all,
    );
    expect(offeredEfforts(undefined)).toEqual(all);
  });

  it("sends a chosen effort the model offers, and the model default for one it lacks", () => {
    const lowOnly = { id: "a", contextWindow: 1, reasoning: ["low" as const], images: null };
    expect(effortFor(lowOnly, "low")).toBe("low");
    expect(effortFor(lowOnly, "xhigh")).toBe("provider-default");
    expect(effortFor(undefined, "xhigh")).toBe("xhigh");
  });
});

describe("effective context window", () => {
  const reported = { id: "a", contextWindow: 262_144, reasoning: null, images: null };
  const missing = { id: "b", contextWindow: null, reasoning: null, images: null };

  const settings = (
    contextWindows: ContextWindows = {},
    contextLimits: ContextLimits = {},
  ): { contextWindows: ContextWindows; contextLimits: ContextLimits } => ({
    contextWindows,
    contextLimits,
  });
  const unlimited = { a: 262_144, b: 262_144, c: 262_144 };

  it("uses the reported window, whatever the owner set", () => {
    expect(effectiveWindow("a", [reported], settings({ a: 8_192 }, unlimited))).toEqual({
      tokens: 262_144,
      source: "catalog",
      model: 262_144,
      limit: null,
    });
  });

  it("uses the owner's window only when none is reported", () => {
    expect(effectiveWindow("b", [missing], settings({ b: 32_768 }))).toEqual({
      tokens: 32_768,
      source: "owner",
      model: 32_768,
      limit: null,
    });
    expect(effectiveWindow("c", [reported], settings({ c: 16_384 }))).toEqual({
      tokens: 16_384,
      source: "owner",
      model: 16_384,
      limit: null,
    });
    expect(effectiveWindow("c", undefined, settings({ c: 16_384 }))).toEqual({
      tokens: 16_384,
      source: "owner",
      model: 16_384,
      limit: null,
    });
  });

  it("caps a larger reported window at the default limit", () => {
    expect(effectiveWindow("a", [reported], settings())).toEqual({
      tokens: DEFAULT_CONTEXT_LIMIT,
      source: "catalog",
      model: 262_144,
      limit: "default",
    });
    expect(DEFAULT_CONTEXT_LIMIT).toBe(131_072);
  });

  it("fits to a stored limit below the window", () => {
    expect(effectiveWindow("a", [reported], settings({}, { a: 16_384 }))).toEqual({
      tokens: 16_384,
      source: "catalog",
      model: 262_144,
      limit: "owner",
    });
  });

  it("clamps a stored limit above the window to the window", () => {
    const small = { id: "a", contextWindow: 65_536, reasoning: null, images: null };
    expect(effectiveWindow("a", [small], settings({}, { a: 200_000 }))).toEqual({
      tokens: 65_536,
      source: "catalog",
      model: 65_536,
      limit: null,
    });
  });

  it("caps the owner's window the same way", () => {
    expect(effectiveWindow("b", [missing], settings({ b: 1_000_000 }))).toEqual({
      tokens: DEFAULT_CONTEXT_LIMIT,
      source: "owner",
      model: 1_000_000,
      limit: "default",
    });
    expect(effectiveWindow("b", [missing], settings({ b: 1_000_000 }, { b: 8_192 }))).toEqual({
      tokens: 8_192,
      source: "owner",
      model: 1_000_000,
      limit: "owner",
    });
  });

  it("says which limit reduced the window: the owner's, the default, or none", () => {
    expect(effectiveWindow("a", [reported], settings())?.limit).toBe("default");
    expect(effectiveWindow("a", [reported], settings({}, { a: 131_072 }))?.limit).toBe("owner");
    // A limit at or above the window reduces nothing.
    expect(effectiveWindow("a", [reported], settings({}, unlimited))?.limit).toBeNull();
    const exact = { id: "a", contextWindow: DEFAULT_CONTEXT_LIMIT, reasoning: null, images: null };
    expect(effectiveWindow("a", [exact], settings())?.limit).toBeNull();
  });

  it("reads only the model's own entries, whatever its id", () => {
    const inherited = { id: "constructor", contextWindow: 262_144, reasoning: null, images: null };
    expect(effectiveWindow("constructor", [inherited], settings())).toEqual({
      tokens: DEFAULT_CONTEXT_LIMIT,
      source: "catalog",
      model: 262_144,
      limit: "default",
    });
    expect(effectiveWindow("constructor", undefined, settings())).toBeNull();
    expect(effectiveWindow("toString", [missing], settings())).toBeNull();
  });

  it("is null when neither exists, whatever the limit: never a guessed budget", () => {
    expect(effectiveWindow("b", [missing], settings())).toBeNull();
    expect(effectiveWindow("b", undefined, settings())).toBeNull();
    expect(effectiveWindow("b", [missing], settings({}, { b: 8_192 }))).toBeNull();
  });
});

describe("owner-set context windows", () => {
  it("accepts windows within range for model ids", () => {
    expect(contextWindowsSchema.parse({ "kimi-k3": 32_768 })).toEqual({ "kimi-k3": 32_768 });
  });

  it("rejects out-of-range, fractional and oversized maps", () => {
    const { min, max } = CONTEXT_WINDOW_RANGE;
    expect(contextWindowsSchema.safeParse({ a: min - 1 }).success).toBe(false);
    expect(contextWindowsSchema.safeParse({ a: max + 1 }).success).toBe(false);
    expect(contextWindowsSchema.safeParse({ a: 4_096.5 }).success).toBe(false);
    expect(contextWindowsSchema.safeParse({ ["x".repeat(201)]: 4_096 }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`m${i}`, 4_096]));
    expect(contextWindowsSchema.safeParse(many).success).toBe(false);
  });

  it("accepts context limits within range for model ids", () => {
    expect(contextLimitsSchema.parse({ "kimi-k3": 16_384 })).toEqual({ "kimi-k3": 16_384 });
  });

  it("rejects out-of-range, fractional and oversized maps of context limits", () => {
    const { min, max } = CONTEXT_WINDOW_RANGE;
    expect(contextLimitsSchema.safeParse({ a: min - 1 }).success).toBe(false);
    expect(contextLimitsSchema.safeParse({ a: max + 1 }).success).toBe(false);
    expect(contextLimitsSchema.safeParse({ a: 4_096.5 }).success).toBe(false);
    expect(contextLimitsSchema.safeParse({ ["x".repeat(201)]: 4_096 }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`m${i}`, 4_096]));
    expect(contextLimitsSchema.safeParse(many).success).toBe(false);
  });
});
