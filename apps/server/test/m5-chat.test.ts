import {
  blankCard,
  defaultPromptPreset,
  defaultSamplerPreset,
  type InspectedPrompt,
  inspectedPromptSchema,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { plainPromptPreset } from "../../../packages/core/test-fixtures/preset.ts";
import {
  type CatalogEntry,
  catalogEntry,
  type FakeUpstreamOptions,
  fakeUpstream,
} from "./fake-upstream.ts";
import {
  CLOCK,
  ownerHeaders,
  PICK_SEED,
  postJson,
  promptPart,
  responseParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";

const CANARY = "canary-m5-51e2";

function setup(options: FakeUpstreamOptions = {}) {
  const upstream = fakeUpstream({ chunks: ["Aye."], ...options });
  const { app, lines, instances } = testApp({ fetch: upstream.fetch });
  const { stores } = instances.instance(TEST_USER);
  return { app, lines, stores, upstream };
}

function seed(stores: ReturnType<typeof setup>["stores"]) {
  const characterId = stores.characters.create({
    ...blankCard("Mara Voss"),
    description: `{{char}} captains the Kestrel. ${CANARY}-card`,
  });
  const personaId = crypto.randomUUID();
  stores.personas.create({ name: "Aria", description: "{{user}} keeps receipts." }, personaId);
  const [promptPreset] = stores.presets.prompt.list();
  return { characterId, personaId, promptPresetId: promptPreset?.id ?? "" };
}

const turns = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${i} ${"word ".repeat(size)}`,
  })).concat([{ role: "user", content: `latest ${CANARY}-in` }]);

describe("POST /api/chat with prompt assembly", () => {
  it("sends the assembled prompt and streams it first, exactly as sent", async () => {
    const { app, stores, upstream } = setup();
    const ids = seed(stores);
    const response = await app.request(
      "/api/chat",
      postJson({
        model: "fake-model",
        ...ids,
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [{ role: "user", content: `Hello ${CANARY}-in` }],
      }),
    );
    const all = await responseParts(response);
    const firstData = all.findIndex((p) => String(p.type).startsWith("data-"));
    const firstText = all.findIndex((p) => p.type === "text-delta");
    expect(firstData).toBeGreaterThanOrEqual(0);
    expect(firstData).toBeLessThan(firstText);

    const prompt = promptPart(all);
    const sent = upstream.records[0]?.body as { messages: { role: string; content: string }[] };
    expect(prompt.messages.map(({ role, content }) => ({ role, content }))).toEqual(sent.messages);
    expect(sent.messages[0]?.content).toContain("with one adult player, who plays Aria.");
    expect(sent.messages.map((m) => m.content)).toContainEqual(
      expect.stringMatching(/^<persona>\n.*\n\nAria keeps receipts\.\n<\/persona>$/s),
    );
    expect(prompt.messages.at(-1)?.source).toEqual({ kind: "history", index: 0 });
    expect(prompt.window).toEqual({
      tokens: 131_072,
      source: "catalog",
      model: 131_072,
      limit: null,
    });
    expect(prompt.estimate).toBeGreaterThan(0);
  });

  it("reports the model's own count, leaving unreported cache and reasoning counts unknown", async () => {
    const { app } = setup({ usage: { prompt_tokens: 321, completion_tokens: 2 } });
    const all = await responseParts(
      await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          clock: CLOCK,
          pickSeed: PICK_SEED,
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    );
    const finish = all.find((p) => p.type === "finish");
    expect(finish?.messageMetadata).toEqual({ inputTokens: 321, outputTokens: 2 });
  });

  it("uses the built-in default prompt preset, and no character or persona, for unknown ids", async () => {
    const { app, upstream } = setup();
    await (
      await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          promptPresetId: crypto.randomUUID(),
          characterId: crypto.randomUUID(),
          personaId: crypto.randomUUID(),
          clock: CLOCK,
          pickSeed: PICK_SEED,
          messages: [{ role: "user", content: "hi" }],
        }),
      )
    ).text();
    const sent = upstream.records[0]?.body as { messages: { content: string }[] };
    expect(sent.messages[0]?.content).toContain("with one adult player, who plays User.");
  });

  it("trims the oldest turns to fit the model's window", async () => {
    const catalog: CatalogEntry[] = [{ ...catalogEntry("small"), context_window: 4_000 }];
    const { app, stores, upstream } = setup({ catalog });
    const sampler = stores.presets.sampler.create(
      { name: "Short", values: { ...defaultSamplerPreset().values, maxOutputTokens: 500 } },
      crypto.randomUUID(),
    );
    // The plain preset keeps the fixed part small, so the default's own instructions can grow.
    const promptPresetId = stores.presets.prompt.create(plainPromptPreset(), crypto.randomUUID());
    const response = await app.request(
      "/api/chat",
      postJson({
        model: "small",
        promptPresetId,
        samplerPresetId: sampler,
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: turns(40, 150),
      }),
    );
    const prompt = promptPart(await responseParts(response));
    expect(prompt.history.total).toBe(41);
    expect(prompt.history.sent).toBeLessThan(41);
    expect(prompt.reserve).toBe(500);
    expect(prompt.estimate).toBeLessThanOrEqual(4_000 - 500);
    const sent = upstream.records[0]?.body as { messages: { content: string }[] };
    expect(sent.messages.at(-1)?.content).toContain("latest");
    expect(sent.messages.some((m) => m.content.startsWith("turn 0 "))).toBe(false);
  });

  it("refuses a prompt whose fixed part cannot fit, without calling upstream or logging content", async () => {
    const catalog: CatalogEntry[] = [{ ...catalogEntry("tiny"), context_window: 5_000 }];
    const { app, upstream, lines } = setup({ catalog });
    const response = await app.request(
      "/api/chat",
      postJson({
        model: "tiny",
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [{ role: "user", content: `${CANARY} ${"long ".repeat(5_000)}` }],
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "prompt_too_long" });
    expect(upstream.records).toHaveLength(0);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("does not calibrate from a prompt too small to tell", async () => {
    const { app, stores } = setup({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1 } });
    // The default's own instructions are large enough to calibrate from.
    const promptPresetId = stores.presets.prompt.create(plainPromptPreset(), crypto.randomUUID());
    const body = {
      model: "fake-model",
      promptPresetId,
      clock: CLOCK,
      pickSeed: PICK_SEED,
      messages: [{ role: "user", content: "hello there" }],
    };
    const preview = async () =>
      (
        (await (await app.request("/api/chat/preview", postJson(body))).json()) as {
          prompt: InspectedPrompt;
        }
      ).prompt.estimate;
    const before = await preview();
    await (await app.request("/api/chat", postJson(body))).text();
    expect(await preview()).toBe(before);
  });

  it("calibrates later estimates by what the model counted", async () => {
    const { app } = setup({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1 } });
    const body = {
      model: "fake-model",
      clock: CLOCK,
      pickSeed: PICK_SEED,
      messages: [{ role: "user", content: "word ".repeat(1_500) }],
    };
    const before = (await (await app.request("/api/chat/preview", postJson(body))).json()) as {
      prompt: InspectedPrompt;
    };
    await (await app.request("/api/chat", postJson(body))).text();
    const after = (await (await app.request("/api/chat/preview", postJson(body))).json()) as {
      prompt: InspectedPrompt;
    };
    // The ratio is bounded to 2.
    expect(after.prompt.estimate).toBeGreaterThan(before.prompt.estimate * 1.9);
    expect(after.prompt.estimate).toBeLessThanOrEqual(before.prompt.estimate * 2 + 1);
  });

  describe("without a reported context window", () => {
    const missing: CatalogEntry[] = [{ slug: "no-window" }];

    it.each([
      ["the catalog reports none", { catalog: missing }, "no-window"],
      ["the model is not in the catalog", {}, "unlisted"],
      ["the catalog is unreachable", { catalog: undefined, catalogDown: true }, "fake-model"],
    ])("refuses when %s and no window is set", async (_label, options, model) => {
      const { app, upstream, lines } = setup(options as FakeUpstreamOptions);
      const response = await app.request(
        "/api/chat",
        postJson({
          model,
          clock: CLOCK,
          pickSeed: PICK_SEED,
          messages: [{ role: "user", content: `${CANARY}-in` }],
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "context_window_unknown" });
      expect(upstream.records).toHaveLength(0);
      expect(lines.join("\n")).not.toContain(CANARY);
    });

    it("uses the window the owner set, and says so", async () => {
      const { app, stores, upstream } = setup({ catalog: missing });
      stores.settings.update({ contextWindows: { "no-window": 16_384 } });
      const prompt = promptPart(
        await responseParts(
          await app.request(
            "/api/chat",
            postJson({
              model: "no-window",
              clock: CLOCK,
              pickSeed: PICK_SEED,
              messages: [{ role: "user", content: "hi" }],
            }),
          ),
        ),
      );
      expect(prompt.window).toEqual({
        tokens: 16_384,
        source: "owner",
        model: 16_384,
        limit: null,
      });
      expect(upstream.records).toHaveLength(1);
    });

    it("ignores the owner's window when the catalog reports one", async () => {
      const { app, stores } = setup();
      stores.settings.update({ contextWindows: { "fake-model": 2_048 } });
      const response = await app.request(
        "/api/chat/preview",
        postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [] }),
      );
      const { prompt } = (await response.json()) as { prompt: InspectedPrompt };
      expect(prompt.window).toEqual({
        tokens: 131_072,
        source: "catalog",
        model: 131_072,
        limit: null,
      });
    });

    it("fits to the owner's limit, and reserves the reply from it", async () => {
      const { app, stores } = setup();
      stores.settings.update({ contextLimits: { "fake-model": 8_192 } });
      const response = await app.request(
        "/api/chat/preview",
        postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [] }),
      );
      const { prompt } = (await response.json()) as { prompt: InspectedPrompt };
      expect(prompt.window).toEqual({
        tokens: 8_192,
        source: "catalog",
        model: 131_072,
        limit: "owner",
      });
      expect(prompt.reserve).toBe(Math.min(4_096, Math.floor(8_192 / 4)));
    });
  });

  it("sends no reasoning effort the model does not offer, and says so", async () => {
    const catalog: CatalogEntry[] = [
      {
        slug: "low-only",
        context_window: 100_000,
        supported_reasoning_levels: [{ effort: "low" }],
      },
    ];
    const { app, stores, upstream } = setup({ catalog });
    const sampler = stores.presets.sampler.create(
      {
        name: "Deep",
        values: { ...defaultSamplerPreset().values, reasoning: "high", temperature: 0.5 },
      },
      crypto.randomUUID(),
    );
    const prompt = promptPart(
      await responseParts(
        await app.request(
          "/api/chat",
          postJson({
            model: "low-only",
            samplerPresetId: sampler,
            clock: CLOCK,
            pickSeed: PICK_SEED,
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
      ),
    );
    expect(upstream.records[0]?.body).not.toHaveProperty("reasoning_effort");
    expect(upstream.records[0]?.body).toMatchObject({ temperature: 0.5 });
    expect(prompt.settings).toEqual({ temperature: 0.5 });
    expect(prompt.reasoningNotOffered).toBe("high");
  });
});

describe("hostile text", () => {
  it("counts a long unbroken run quickly", async () => {
    const { app } = setup();
    // CPU time excludes time waiting for other processes to be scheduled on a busy machine.
    const started = process.cpuUsage();
    const response = await app.request(
      "/api/chat/preview",
      postJson({
        model: "fake-model",
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [{ role: "user", content: "a".repeat(256 * 1024) }],
      }),
    );
    expect(response.status).toBe(200);
    const cpu = process.cpuUsage(started);
    expect(cpu.user + cpu.system).toBeLessThan(2_000_000);
  });

  it("refuses a card whose macros expand past their bound, without logging it", async () => {
    const { app, stores, upstream, lines } = setup();
    const characterId = stores.characters.create({
      ...blankCard("Echo"),
      description: `${CANARY} ${"d".repeat(200 * 1024)}`,
      systemPrompt: "{{description}}".repeat(400),
    });
    const response = await app.request(
      "/api/chat",
      postJson({
        model: "fake-model",
        characterId,
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "prompt_too_long" });
    expect(upstream.records).toHaveLength(0);
    expect(lines.join("\n")).not.toContain(CANARY);
  });
});

describe("POST /api/chat/preview", () => {
  it("assembles without calling the model, with no-store, draft included", async () => {
    const { app, stores, upstream } = setup();
    const ids = seed(stores);
    const response = await app.request(
      "/api/chat/preview",
      postJson({
        model: "fake-model",
        ...ids,
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [
          { role: "assistant", content: "Welcome." },
          { role: "user", content: `draft ${CANARY}-draft` },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const { prompt } = (await response.json()) as { prompt: InspectedPrompt };
    expect(inspectedPromptSchema.parse(prompt).messages.at(-1)?.content).toContain("draft");
    expect(upstream.records).toHaveLength(0);
  });

  it("previews an empty chat", async () => {
    const { app } = setup();
    const response = await app.request(
      "/api/chat/preview",
      postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [] }),
    );
    const { prompt } = (await response.json()) as { prompt: InspectedPrompt };
    expect(prompt.history).toEqual({ sent: 0, total: 0 });
  });

  it("refuses without a known window, and bad requests without detail", async () => {
    const { app } = setup({ catalog: [{ slug: "no-window" }] });
    const unknown = await app.request(
      "/api/chat/preview",
      postJson({ model: "no-window", clock: CLOCK, pickSeed: PICK_SEED, messages: [] }),
    );
    expect(unknown.status).toBe(409);
    const bad = await app.request("/api/chat/preview", postJson({ model: "x", messages: [] }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_request" });
  });

  it("is owner-only like every route", async () => {
    const { app } = setup();
    const response = await app.request("/api/chat/preview", {
      method: "POST",
      headers: ownerHeaders({ Origin: "https://evil.test" }),
      body: JSON.stringify({
        model: "fake-model",
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [],
      }),
    });
    expect(response.status).toBe(403);
  });
});

it("uses a prompt preset's own blocks", async () => {
  const { app, stores, upstream } = setup();
  const preset = defaultPromptPreset("Terse");
  const id = stores.presets.prompt.create(
    {
      ...preset,
      blocks: preset.blocks.map((block) =>
        block.id === "main" ? { ...block, content: "Be terse, {{char}}." } : block,
      ),
    },
    crypto.randomUUID(),
  );
  await (
    await app.request(
      "/api/chat",
      postJson({
        model: "fake-model",
        promptPresetId: id,
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [{ role: "user", content: "hi" }],
      }),
    )
  ).text();
  const sent = upstream.records[0]?.body as { messages: { content: string }[] } | undefined;
  expect(sent?.messages[0]?.content).toBe("Be terse, Assistant.");
});
