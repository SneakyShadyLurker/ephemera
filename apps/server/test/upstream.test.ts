import {
  type ArtStreamEvent,
  blankCard,
  CREATOR_LIMITS,
  calibrationRatio,
  callAccountingSchema,
  decodeArtFrames,
  MEMORY_LIMITS,
} from "@ephemera/core";
import { APICallError, generateText, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger } from "../src/log.ts";
import { helperInputTokens, objectCaller, roomFor } from "../src/object-call.ts";
import { countMessage, PRIMING } from "../src/tokens.ts";
import {
  callFailure,
  createUpstream,
  instanceCacheKey,
  upstreamSettings,
} from "../src/upstream.ts";
import { callRecorder, reportedUsage } from "../src/usage.ts";
import { fakeComfyui } from "./fake-comfyui.ts";
import { fakeUpstream } from "./fake-upstream.ts";
import { CLOCK, config, PICK_SEED, postJson, TEST_USER, testApp } from "./helpers.ts";

const SECRET = "canary-upstream-warning-3e9b";

describe("reported provider attempt usage", () => {
  it("settles narration retry failures as unknown-usage attempts", async () => {
    const fake = fakeUpstream({
      failWith: { status: 503, body: SECRET, headers: { "Retry-After": "0" } },
    });
    const { app } = testApp({ fetch: fake.fetch });
    const response = await app.request(
      "/api/chat",
      postJson({
        model: "fake-model",
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [{ role: "user", content: "synthetic" }],
      }),
    );
    const parts = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    const accounting = callAccountingSchema.parse(
      parts.find((part) => part.type === "data-usage")?.data,
    );
    expect(accounting.calls.map(({ status, usage }) => ({ status, usage }))).toEqual(
      Array.from({ length: 3 }, () => ({ status: "failed", usage: {} })),
    );
  });

  it("records an aborted actual provider invocation without inventing usage", async () => {
    const controller = new AbortController();
    const recorder = callRecorder();
    const upstream = createUpstream(config, async () => {
      controller.abort();
      throw new DOMException("synthetic", "AbortError");
    });
    await expect(
      generateText({
        model: upstream.model("fake-model", null, { recorder, purpose: "memory.opening" }),
        prompt: "synthetic",
        abortSignal: controller.signal,
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    expect(recorder.snapshot().calls).toMatchObject([{ status: "aborted", usage: {} }]);
  });
  it("reports scene text work before image failure", async () => {
    const fake = fakeUpstream({ chunks: ["A synthetic image prompt"] });
    // An answered failure: a worker that does not answer would be waited for as it starts up.
    const comfy = fakeComfyui({ redirect: true });
    const { app, instances } = testApp({
      fetch: (input, init) =>
        String(input).startsWith("https://comfy.test")
          ? comfy.fetch(input, init)
          : fake.fetch(input, init),
      comfyuiSocket: comfy.socket,
    });
    const { stores } = instances.instance(TEST_USER);
    stores.settings.update({ comfyuiBaseUrl: "https://comfy.test:8188" });
    const characterId = stores.characters.create(blankCard("Synthetic"));
    const body = {
      model: "fake-model",
      characterId,
      kind: "subject",
      source: "Synthetic scene",
      workflow: "krea2-gonzalomo",
    };
    const response = await app.request("/api/scene", postJson(body));
    async function* chunks() {
      yield new Uint8Array(await response.arrayBuffer());
    }
    const events: ArtStreamEvent[] = [];
    for await (const event of decodeArtFrames(chunks())) events.push(event);
    const accounting = callAccountingSchema.parse(
      events.flatMap((event) => ("accounting" in event ? [event.accounting] : []))[0],
    );
    expect(accounting.calls).toHaveLength(1);
    expect(accounting.calls[0]).toMatchObject({
      purpose: "scene.prompt",
      status: "completed",
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    expect(events.at(-1)?.type).toBe("error");
  });
  it("uses raw numeric presence, retaining zero and rejecting normalized invented zero", () => {
    expect(
      reportedUsage({
        raw: {
          prompt_tokens: 12,
          completion_tokens_details: { reasoning_tokens: 0 },
          prompt_tokens_details: { cached_tokens: null },
          private: SECRET,
        },
      }),
    ).toEqual({ inputTokens: 12, reasoningTokens: 0 });
    expect(reportedUsage({})).toEqual({});
    expect(reportedUsage({ raw: { prompt_tokens: -1, completion_tokens: 2.5 } })).toEqual({});
  });
  it("records each actual SDK retry, leaving failed transport attempts unknown", async () => {
    const fake = fakeUpstream({
      turns: [
        { failWith: { status: 503, body: SECRET, headers: { "Retry-After": "0" } } },
        { chunks: ["answer"] },
      ],
    });
    const upstream = createUpstream(config, fake.fetch);
    const recorder = callRecorder();
    await generateText({
      model: upstream.model("fake-model", null, { recorder, purpose: "cast.update" }),
      prompt: "synthetic",
      ...upstreamSettings({}, undefined),
    });
    const { calls } = recorder.snapshot();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ status: "failed", usage: {} });
    expect(calls[1]).toMatchObject({
      status: "completed",
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });
  it.each(["reply", "continue", "impersonate"] as const)(
    "reports narration attempt receipts for %s",
    async (mode) => {
      const fake = fakeUpstream();
      const { app } = testApp({ fetch: fake.fetch });
      const body = {
        model: "fake-model",
        clock: CLOCK,
        pickSeed: PICK_SEED,
        mode,
        messages: [{ role: mode === "continue" ? "assistant" : "user", content: "synthetic" }],
      };
      const negotiated = await app.request("/api/chat", postJson(body));
      const stream = await negotiated.text();
      const parts = stream
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      const receipt = callAccountingSchema.parse(
        parts.find((part) => part.type === "data-usage")?.data,
      );
      expect(receipt.calls).toHaveLength(1);
      expect(receipt.calls[0]).toMatchObject({
        purpose: "narration",
        status: "completed",
        usage: { inputTokens: 3, outputTokens: 5 },
      });
      expect(receipt.calls[0]?.usage.cachedTokens).toBeUndefined();
    },
  );
});

describe("the session cache extensions", () => {
  const cacheKey = crypto.randomUUID();
  const chat = {
    model: "fake-model",
    clock: CLOCK,
    pickSeed: PICK_SEED,
    messages: [{ role: "user", content: "synthetic" }],
    cacheKey,
  };

  it.each([
    ["on by default", {}],
    ["on", { upstreamSessionCache: true }],
  ])("send the chat's cache key when %s", async (_label, overrides) => {
    const fake = fakeUpstream({ chunks: ["ok"] });
    const { app } = testApp({ fetch: fake.fetch }, overrides);
    await (await app.request("/api/chat", postJson(chat))).text();
    expect(fake.records[0]?.body).toMatchObject({ prompt_cache_key: cacheKey });
    expect(fake.records[0]?.affinity).toBe(cacheKey);
  });

  it("send neither the body field nor the header when off", async () => {
    const fake = fakeUpstream({ chunks: ["ok"] });
    const { app } = testApp({ fetch: fake.fetch }, { upstreamSessionCache: false });
    const response = await app.request("/api/chat", postJson(chat));
    expect(await response.text()).toContain("ok");
    expect(fake.records[0]?.body).not.toHaveProperty("prompt_cache_key");
    expect(fake.records[0]?.affinity).toBeNull();
  });

  it("leave every call's settings without a cache key when off", async () => {
    const fake = fakeUpstream({ chunks: ["ok"] });
    const upstream = createUpstream({ ...config, upstreamSessionCache: false }, fake.fetch);
    await generateText({
      model: upstream.model("fake-model", null),
      prompt: "synthetic",
      ...upstream.settings({ temperature: 0.5 }, cacheKey),
    });
    expect(fake.records[0]?.body).toMatchObject({ temperature: 0.5 });
    expect(fake.records[0]?.body).not.toHaveProperty("prompt_cache_key");
    expect(fake.records[0]?.affinity).toBeNull();
  });
});

describe("helper prompt room", () => {
  const target = { model: "m", window: 100_000, ratio: 1.2, settings: {}, cacheKey: "fixed" };
  it("counts all actual conversation messages plus priming, including repairs", () => {
    const texts = ["instructions", "input", "unusable JSON", "repair"];
    const messages = texts.map((content, index) => ({
      role:
        index === 0 ? ("system" as const) : index % 2 ? ("user" as const) : ("assistant" as const),
      content,
    }));
    const input = PRIMING + messages.reduce((n, message) => n + countMessage(message), 0);
    expect(helperInputTokens(texts)).toBe(input);
    expect(
      roomFor(
        { ...target, window: Math.ceil(input * target.ratio) + MEMORY_LIMITS.replyReserve - 1 },
        texts,
      ),
    ).toBeNull();
    expect(
      roomFor(
        { ...target, window: Math.ceil(input * target.ratio) + MEMORY_LIMITS.replyReserve },
        texts,
      ),
    ).toBe(MEMORY_LIMITS.replyReserve);
    expect(roomFor(target, texts)).toBe(Math.floor(target.window - input * target.ratio));
    expect(roomFor({ ...target, window: 200_000 }, texts)).toBe(CREATOR_LIMITS.maxOutputTokens);
  });
});

describe("helper calibration", () => {
  for (const counters of ["absent", "empty", "stale", "truncated"] as const) {
    it.each([4_096, 0, undefined])(
      `uses current input usage %s with ${counters} recorder counters`,
      async (reported) => {
        const fake = fakeUpstream({
          chunks: ['{"value":"done"}'],
          withoutUsage: reported === undefined,
        });
        const upstream = createUpstream(config, async (input, init) => {
          const response = await fake.fetch(input, init);
          if (reported === undefined) return response;
          // The shared fixture hardcodes usage for non-streamed completions.
          const body = (await response.json()) as Record<string, unknown>;
          return Response.json({
            ...body,
            usage: { prompt_tokens: reported, completion_tokens: 5 },
          });
        });
        const calibration = new Map([["fake-model", 1.3]]);
        const call = {
          model: "fake-model",
          window: 200_000,
          ratio: 1.3,
          settings: {},
          cacheKey: "fixed",
          calibration,
        };
        const recorder = callRecorder();
        // Accounting can have no current slot, or expose an older model's last slot.
        const recorded = {
          ...recorder,
          snapshot: () => ({
            truncated: counters === "truncated",
            calls:
              counters === "stale" || counters === "truncated"
                ? [
                    {
                      id: crypto.randomUUID(),
                      model: "older-model",
                      purpose: "memory.opening" as const,
                      status: "completed" as const,
                      usage: { inputTokens: 1 },
                    },
                  ]
                : [],
          }),
        };
        const instructions = "Return the JSON object requested.";
        const message = "synthetic ".repeat(2_000);
        const estimate = helperInputTokens([instructions, message]);
        expect(estimate).toBeGreaterThanOrEqual(1_024);
        const result = await objectCaller({ log: createLogger(() => {}), upstream })(call, {
          event: "cast.update",
          instructions,
          message,
          room: CREATOR_LIMITS.maxOutputTokens,
          schema: z.object({ value: z.string() }),
          clamp: (value) => value,
          failure: "cast_failed",
          signal: new AbortController().signal,
          ...(counters === "absent" ? {} : { recorder: recorded }),
        });
        expect(result).toMatchObject({ ok: true, value: { value: "done" } });
        expect(calibration.get(call.model)).toBe(
          reported === undefined ? 1.3 : calibrationRatio(reported, estimate),
        );
        expect(fake.records).toHaveLength(1);
      },
    );
  }
});

const apiError = (statusCode: number, responseHeaders: Record<string, string> = {}) =>
  new APICallError({
    message: `bad ${SECRET}`,
    url: "http://upstream.test/v1/chat/completions",
    requestBodyValues: { prompt: SECRET },
    statusCode,
    responseHeaders,
    responseBody: SECRET,
  });

describe("a failed call", () => {
  it("is busy for 429 and 503 after the retries, with the provider's wait in seconds", () => {
    const retried = new RetryError({
      message: SECRET,
      reason: "maxRetriesExceeded",
      errors: [apiError(500), apiError(429, { "retry-after": "7" })],
    });
    expect(callFailure(retried)).toEqual({
      errorClass: "AI_APICallError",
      status: 429,
      busy: true,
      retryAfterS: 7,
    });
    expect(callFailure(apiError(503, { "retry-after-ms": "1500" }))).toMatchObject({
      busy: true,
      retryAfterS: 2,
    });
    const date = new Date(Date.now() + 30_000).toUTCString();
    expect(callFailure(apiError(503, { "retry-after": date })).retryAfterS).toBeGreaterThan(25);
    expect(callFailure(apiError(429, { "retry-after": "soon" }))).toEqual({
      errorClass: "AI_APICallError",
      status: 429,
      busy: true,
    });
  });

  it("is not busy for other statuses or errors, and names nothing of their message", () => {
    expect(callFailure(apiError(500, { "retry-after": "3" }))).toEqual({
      errorClass: "AI_APICallError",
      status: 500,
      busy: false,
    });
    expect(callFailure(new TypeError(SECRET))).toEqual({ errorClass: "TypeError", busy: false });
    expect(JSON.stringify(callFailure(apiError(429)))).not.toContain(SECRET);
  });
});

describe("an instance's cache key", () => {
  it("is stable per scope within an instance and differs across scopes and instances", () => {
    const one = {};
    const two = {};
    const key = instanceCacheKey(one, "character-a");
    expect(instanceCacheKey(one, "character-a")).toBe(key);
    expect(instanceCacheKey(one, "character-b")).not.toBe(key);
    expect(instanceCacheKey(two, "character-a")).not.toBe(key);
    expect(key).not.toContain("character-a");
  });
});

describe("AI SDK warnings", () => {
  it("are logged as operational events: model, type and feature or setting, never details", () => {
    const { lines } = testApp();
    const logger = globalThis.AI_SDK_LOG_WARNINGS;
    if (typeof logger !== "function") throw new Error("no warning logger");
    logger({
      model: "fake-model",
      provider: "cliproxyapi.chat",
      warnings: [
        { type: "unsupported", feature: "topK", details: SECRET },
        { type: "deprecated", setting: "providerOptions key", message: SECRET },
        { type: "other", message: SECRET },
      ],
    });
    const logged = lines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "ai.warning");
    expect(logged.map(({ level, model, errorClass }) => [level, model, errorClass])).toEqual([
      ["warn", "fake-model", "unsupported:topK"],
      ["warn", "fake-model", "deprecated:providerOptions key"],
      ["warn", "fake-model", "other"],
    ]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
