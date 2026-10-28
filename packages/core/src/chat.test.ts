import { describe, expect, it } from "vitest";
import { generateRequestSchema, joinContinuation, previewRequestSchema } from "./chat.ts";

const clock = { now: Date.UTC(2026, 8, 29, 19, 42), timeZone: "Europe/Berlin" };
const pickSeed = 2_654_435_769;
const ids = {
  promptPresetId: "00000000-0000-4000-8000-000000000001",
  samplerPresetId: "00000000-0000-4000-8000-000000000002",
  characterId: "00000000-0000-4000-8000-000000000003",
  personaId: "00000000-0000-4000-8000-000000000004",
};

describe("generateRequestSchema", () => {
  it("accepts marked raw assistant history and rejects marked user text", () => {
    const request = {
      model: "m",
      clock,
      pickSeed,
      messages: [
        { role: "assistant", content: "{{setvar::value::saved}}", macroEligible: true },
        { role: "user", content: "Next" },
      ],
    };
    expect(generateRequestSchema.safeParse(request).success).toBe(true);
    expect(
      generateRequestSchema.safeParse({
        ...request,
        messages: [{ role: "user", content: "{{incvar::value}}", macroEligible: true }],
      }).success,
    ).toBe(false);
  });
  it("accepts a conversation that ends with the user's turn, with the selection and clock", () => {
    const request = {
      model: "some-model",
      ...ids,
      clock,
      pickSeed,
      mode: "reply",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
      ],
    };
    expect(generateRequestSchema.parse(request)).toEqual(request);
    const {
      promptPresetId: _p,
      characterId: _c,
      personaId: _q,
      samplerPresetId: _s,
      ...bare
    } = request;
    expect(generateRequestSchema.parse(bare)).toEqual(bare);
  });

  const user = [{ role: "user", content: "x" }];
  it.each([
    ["no turns", { model: "m", clock, pickSeed, mode: "reply", messages: [] }],
    [
      "an assistant last turn",
      {
        model: "m",
        clock,
        pickSeed,
        mode: "reply",
        messages: [{ role: "assistant", content: "x" }],
      },
    ],
    [
      "a system turn",
      { model: "m", clock, pickSeed, mode: "reply", messages: [{ role: "system", content: "x" }] },
    ],
    ["an empty model id", { model: "", clock, pickSeed, mode: "reply", messages: user }],
    ["no clock", { model: "m", pickSeed, mode: "reply", messages: user }],
    [
      "an unknown time zone",
      {
        model: "m",
        clock: { ...clock, timeZone: "Mars/Olympus" },
        pickSeed,
        mode: "reply",
        messages: user,
      },
    ],
    [
      "a fractional clock",
      { model: "m", clock: { ...clock, now: 1.5 }, pickSeed, mode: "reply", messages: user },
    ],
    [
      "a malformed id",
      { model: "m", clock, pickSeed, mode: "reply", characterId: "mara", messages: user },
    ],
    ["unknown fields", { model: "m", clock, pickSeed, mode: "reply", messages: user, extra: 1 }],
  ])("rejects %s", (_label, request) => {
    expect(generateRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("literal prefixes in generated assistant history", () => {
  const turn = { role: "assistant", content: "Edited raw", macroEligible: true };
  const request = (change: Record<string, unknown>) => ({
    model: "m",
    clock,
    pickSeed,
    messages: [
      { ...turn, ...change },
      { role: "user", content: "Next" },
    ],
  });

  it.each([0, 7, turn.content.length])("accepts the bounded prefix length %s", (length) => {
    const value = request({ macroPrefixLength: length });
    expect(generateRequestSchema.parse(value).messages[0]?.macroPrefixLength).toBe(length);
    expect(previewRequestSchema.parse(value).messages[0]?.macroPrefixLength).toBe(length);
  });

  it.each([
    { macroPrefixLength: -1 },
    { macroPrefixLength: 1.5 },
    { macroPrefixLength: turn.content.length + 1 },
    { macroPrefixLength: "7" },
    { macroPrefixLength: null },
    { macroPrefixLength: Number.NaN },
    { macroPrefixLength: Number.POSITIVE_INFINITY },
    { macroPrefixLength: 0, macroEligible: false },
    { macroPrefixLength: 0, macroEligible: undefined },
    { macroPrefixLength: 0, role: "user" },
  ])("rejects invalid prefix metadata %j", (change) => {
    expect(generateRequestSchema.safeParse(request(change)).success).toBe(false);
    expect(previewRequestSchema.safeParse(request(change)).success).toBe(false);
  });

  it("preserves the existing all-eligible DTO when no prefix is supplied", () => {
    expect(generateRequestSchema.parse(request({})).messages[0]).toEqual(turn);
  });
});

describe("previewRequestSchema", () => {
  it("accepts an empty chat or one that ends with a reply, as a preview may", () => {
    expect(
      previewRequestSchema.safeParse({ model: "m", clock, pickSeed, messages: [] }).success,
    ).toBe(true);
    expect(
      previewRequestSchema.safeParse({
        model: "m",
        clock,
        pickSeed,
        messages: [{ role: "assistant", content: "hi" }],
      }).success,
    ).toBe(true);
    expect(previewRequestSchema.safeParse({ model: "m", messages: [] }).success).toBe(false);
  });
});

describe("pick seed", () => {
  const request = (seed: unknown) => ({
    model: "m",
    clock,
    ...(seed === undefined ? {} : { pickSeed: seed }),
    messages: [{ role: "user", content: "x" }],
  });

  it.each([0, 1, 2 ** 32 - 1])("accepts the uint32 %s on generations and previews", (seed) => {
    expect(generateRequestSchema.parse(request(seed)).pickSeed).toBe(seed);
    expect(previewRequestSchema.parse(request(seed)).pickSeed).toBe(seed);
  });

  it.each([-1, 2 ** 32, 1.5, "7", null, Number.NaN])("refuses %s: a seed is a uint32", (seed) => {
    expect(generateRequestSchema.safeParse(request(seed)).success).toBe(false);
    expect(previewRequestSchema.safeParse(request(seed)).success).toBe(false);
  });

  it("refuses none: every request carries its chat's seed", () => {
    expect(generateRequestSchema.safeParse(request(undefined)).success).toBe(false);
    expect(previewRequestSchema.safeParse(request(undefined)).success).toBe(false);
  });
});

describe("generation modes", () => {
  const turns = (...roles: ("user" | "assistant")[]) =>
    roles.map((role) => ({ role, content: `${role} text` }));
  const request = (mode: string, messages: unknown[]) => ({
    model: "m",
    clock,
    pickSeed,
    mode,
    messages,
  });

  it.each([
    ["a reply after the user's turn", "reply", turns("user"), true],
    ["a reply after a reply", "reply", turns("user", "assistant"), false],
    ["a continue of the last reply", "continue", turns("user", "assistant"), true],
    ["a continue after the user's turn", "continue", turns("user"), false],
    ["a continue of an empty reply", "continue", [{ role: "assistant", content: "" }], false],
    ["an impersonation after a reply", "impersonate", turns("assistant"), true],
    ["an impersonation of an empty chat", "impersonate", [], true],
    ["an unknown mode", "swipe", turns("user"), false],
  ])("%s: %s", (_label, mode, messages, ok) => {
    expect(generateRequestSchema.safeParse(request(mode, messages)).success).toBe(ok);
  });

  it("is a reply unless it says otherwise", () => {
    expect(
      generateRequestSchema.parse({ model: "m", clock, pickSeed, messages: turns("user") }).mode,
    ).toBe("reply");
  });
});

describe("joinContinuation", () => {
  it("joins with a space unless either side already has whitespace", () => {
    expect(joinContinuation("She waits", "for the tide.")).toBe("She waits for the tide.");
    expect(joinContinuation("She waits", "Then rain.")).toBe("She waits Then rain.");
    expect(joinContinuation("She waits", " for it.")).toBe("She waits for it.");
    expect(joinContinuation("She waits\n", "Later.")).toBe("She waits\nLater.");
    expect(joinContinuation("She waits", "...")).toBe("She waits...");
    expect(joinContinuation("She waits", "")).toBe("She waits");
    expect(joinContinuation("She waits", "She waits for rain.")).toBe("She waits for rain.");
    expect(joinContinuation("She waits", "She waits")).toBe("She waits");
  });

  it("buffers successive chunks that still match the original reply", () => {
    for (const chunk of ["", "S", "She", "She wai", "She waits"]) {
      expect(joinContinuation("She waits", chunk, { streaming: true })).toBe("She waits");
    }
  });

  it("reveals the whole continuation once a matching prefix diverges", () => {
    expect(joinContinuation("She waits", "She wa", { streaming: true })).toBe("She waits");
    expect(joinContinuation("She waits", "She waves")).toBe("She waits She waves");
    expect(joinContinuation("She waits", "She waves.")).toBe("She waits She waves.");
  });

  it("keeps a completed short prefix but removes a full echo", () => {
    expect(joinContinuation("She waits", "She", { streaming: true })).toBe("She waits");
    expect(joinContinuation("She waits", "She")).toBe("She waits She");
    expect(joinContinuation("She waits", "She waits")).toBe("She waits");
  });

  it("strips a completed echo and joins only its suffix", () => {
    expect(joinContinuation("She waits", "She waits for rain.")).toBe("She waits for rain.");
    expect(joinContinuation("She waits", "She waits...")).toBe("She waits...");
    expect(joinContinuation("She waits\n", "She waitsThen rain.")).toBe("She waits\nThen rain.");
  });

  it.each([
    ["She waits ", "She waits again.", "She waits again."],
    ["She waits \t", "She waits \tagain.", "She waits \tagain."],
    ["She waits\n", "She waits\nLater.", "She waits\nLater."],
    ["She waits\n\n", "She waits\n\nLater.", "She waits\n\nLater."],
    ["She waits\n", "She waits \tagain.", "She waits\nagain."],
    ["She waits ", "She waits\n\nLater.", "She waits \n\nLater."],
    ["She waits\n", "She waits \t\n\nLater.", "She waits\n\n\nLater."],
  ])("preserves the original seam in %j plus echo %j", (original, output, expected) => {
    expect(joinContinuation(original, output, { streaming: true })).toBe(expected);
    expect(joinContinuation(original, output)).toBe(expected);
  });

  it("buffers an echo through all of the original trailing whitespace", () => {
    const original = "She waits \t\n\n";
    for (const output of ["She", "She waits", "She waits ", "She waits \t\n", original]) {
      expect(joinContinuation(original, output, { streaming: true })).toBe(original);
    }
    expect(joinContinuation(original, "She")).toBe(`${original}She`);
  });

  it("preserves unechoed and already extracted whitespace", () => {
    for (const original of ["She waits ", "She waits\n"]) {
      for (const suffix of [" again.", "\n\nLater."]) {
        expect(joinContinuation(original, suffix)).toBe(original + suffix);
        expect(joinContinuation(original, suffix, { echo: false })).toBe(original + suffix);
      }
    }
  });

  it("keeps an extracted or filled suffix even when it matches the original again", () => {
    const original = "She waits ";
    for (const suffix of ["She", "She waits", "She waits again."]) {
      const joined = joinContinuation(original, `She waits${suffix}`);
      expect(joined).toBe(original + suffix);
      expect(joinContinuation(original, joined.slice(original.length), { echo: false })).toBe(
        joined,
      );
    }
  });
});

describe("the lorebook's timed state in a request", () => {
  const base = { model: "m", clock, pickSeed, messages: [{ role: "user", content: "x" }] };
  const state = {
    characterId: ids.characterId,
    effects: [{ index: 0, digest: "a1b2", start: 2 }],
  };

  it("travels with generations and previews", () => {
    expect(generateRequestSchema.parse({ ...base, lorebookState: state }).lorebookState).toEqual(
      state,
    );
    expect(previewRequestSchema.parse({ ...base, lorebookState: state }).lorebookState).toEqual(
      state,
    );
  });

  it("is refused when malformed or unbounded", () => {
    const start = { ...state, effects: [{ index: 0, digest: "a1b2", start: 10_001 }] };
    expect(generateRequestSchema.safeParse({ ...base, lorebookState: start }).success).toBe(false);
    const extra = { ...state, note: "text" };
    expect(previewRequestSchema.safeParse({ ...base, lorebookState: extra }).success).toBe(false);
  });
});

describe("request macro state and generation type", () => {
  const base = {
    model: "m",
    clock,
    pickSeed,
    messages: [{ role: "user", content: "x", name: "Mira" }],
  };
  it("accepts bounded memory state and runtime inputs on generations and previews", () => {
    const request = {
      ...base,
      macroState: { local: { tone: "quiet" }, global: { counter: "2" } },
      macroRuntime: { firstIncludedMessageId: 0, isMobile: false },
      generationType: "swipe",
    };
    expect(generateRequestSchema.parse(request).macroState).toEqual(request.macroState);
    expect(previewRequestSchema.parse(request).generationType).toBe("swipe");
  });
  it("rejects mismatched types, unknown fields and excessive state", () => {
    expect(generateRequestSchema.safeParse({ ...base, generationType: "continue" }).success).toBe(
      false,
    );
    expect(
      generateRequestSchema.safeParse({ ...base, mode: "impersonate", generationType: "normal" })
        .success,
    ).toBe(false);
    expect(previewRequestSchema.safeParse({ ...base, generationType: "impersonate" }).success).toBe(
      false,
    );
    expect(
      generateRequestSchema.safeParse({ ...base, macroRuntime: { secret: "x" } }).success,
    ).toBe(false);
    expect(
      generateRequestSchema.safeParse({
        ...base,
        macroState: { local: { huge: "x".repeat(65_537) }, global: {} },
      }).success,
    ).toBe(false);
  });
});
