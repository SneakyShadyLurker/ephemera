import {
  CAST_ANCHOR_FIELDS,
  CAST_STATE_FIELDS,
  defaultSamplerPreset,
  previewResponseSchema,
} from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainPromptPreset } from "../../../packages/core/test-fixtures/preset.ts";
import { type FakeUpstreamOptions, fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  config,
  ownerHeaders,
  PICK_SEED,
  postJson,
  promptPart,
  streamParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";
import { muteConsole, until } from "./vitest-helpers.ts";

const CANARY = "canary-7f3a9c";
const UPSTREAM_TEXT = "upstream-error-text-91c2";
const request = {
  model: "fake-model",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  messages: [{ role: "user", content: `Say ${CANARY}` }],
};

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/chat", () => {
  it("streams the reply as a UI message stream with usage requested upstream", async () => {
    const upstream = fakeUpstream({ reasoning: ["thinking"], chunks: ["Hel", "lo"] });
    const { app } = testApp({ fetch: upstream.fetch });
    const response = await app.request("/api/chat", postJson(request));
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await readAll(response);
    expect(body).toContain('"delta":"Hel"');
    expect(body).toContain('"delta":"lo"');
    expect(upstream.records[0]?.url).toBe("/v1/chat/completions");
    expect(upstream.records[0]?.body).toMatchObject({
      model: "fake-model",
      stream: true,
      stream_options: { include_usage: true },
    });
    const sent = upstream.records[0]?.body as { messages: unknown[] } | undefined;
    expect(sent?.messages.at(-1)).toEqual({ role: "user", content: `Say ${CANARY}` });
  });

  it("aborts the upstream call when the client disconnects", async () => {
    const upstream = fakeUpstream({ chunks: Array.from({ length: 50 }, () => "x"), delayMs: 20 });
    const { app } = testApp({ fetch: upstream.fetch });
    const client = new AbortController();
    const response = await app.request("/api/chat", postJson(request, { signal: client.signal }));
    const reader = response.body?.getReader();
    await reader?.read();
    client.abort();
    await until(() => upstream.records[0]?.aborted === true);
    expect(upstream.records[0]?.completed).toBe(false);
  });

  it("aborts the upstream call at the request lifetime bound", async () => {
    const upstream = fakeUpstream({ chunks: ["partial"], hang: true });
    const { app } = testApp({ fetch: upstream.fetch }, { requestTimeoutMs: 150 });
    const response = await app.request("/api/chat", postJson(request));
    const body = await readAll(response);
    expect(upstream.records[0]?.aborted).toBe(true);
    expect(body).toContain('"type":"abort"');
  });

  it("lifts the runtime idle timeout for the stream", async () => {
    const onStreamingRequest = vi.fn();
    const { app } = testApp({ fetch: fakeUpstream({ chunks: ["a"] }).fetch, onStreamingRequest });
    await readAll(await app.request("/api/chat", postJson(request)));
    expect(onStreamingRequest).toHaveBeenCalledOnce();
  });

  it("keeps upstream error text out of the response, the log and the console", async () => {
    const consoleSpies = muteConsole();
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const upstream = fakeUpstream({
      failWith: {
        status: 400,
        body: JSON.stringify({ error: { message: `bad prompt ${UPSTREAM_TEXT}` } }),
      },
    });
    const { app, lines } = testApp({ fetch: upstream.fetch });
    const body = await readAll(await app.request("/api/chat", postJson(request)));

    expect(body).toContain("generation_failed");
    // The prompt part carries the owner's own message; upstream error text never appears.
    expect(body).not.toContain(UPSTREAM_TEXT);
    expect(lines.some((line) => line.includes('"event":"generation.error"'))).toBe(true);
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain(UPSTREAM_TEXT);
    for (const spy of [...consoleSpies, warningSpy]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(UPSTREAM_TEXT);
    }
  });

  it("does not retry a call the provider refused", async () => {
    const upstream = fakeUpstream({ failWith: { status: 400, body: "{}" } });
    const { app } = testApp({ fetch: upstream.fetch });
    expect(await readAll(await app.request("/api/chat", postJson(request)))).toContain(
      "generation_failed",
    );
    expect(upstream.records).toHaveLength(1);
  });

  it("retries a busy provider after its Retry-After and streams the reply", async () => {
    const busy = { status: 429, body: "{}", headers: { "Retry-After": "0" } };
    const upstream = fakeUpstream({ turns: [{ failWith: busy }, { chunks: ["Hel", "lo"] }] });
    const { app } = testApp({ fetch: upstream.fetch });
    const body = await readAll(await app.request("/api/chat", postJson(request)));
    expect(body).toContain('"delta":"lo"');
    expect(body).not.toContain('"type":"error"');
    expect(upstream.records).toHaveLength(2);
  });

  it.each([429, 503])(
    "says upstream_busy when the provider answers %i through every retry, logging status only",
    async (status) => {
      const upstream = fakeUpstream({
        failWith: {
          status,
          body: JSON.stringify({ error: { message: UPSTREAM_TEXT } }),
          headers: { "Retry-After": "0" },
        },
      });
      const { app, lines } = testApp({ fetch: upstream.fetch });
      const body = await readAll(await app.request("/api/chat", postJson(request)));
      expect(body).toContain('"errorText":"upstream_busy"');
      expect(body).not.toContain("generation_failed");
      expect(body).not.toContain(UPSTREAM_TEXT);
      // The first call and two retries.
      expect(upstream.records).toHaveLength(3);
      const error = lines
        .map((line) => JSON.parse(line))
        .find((line) => line.event === "generation.error");
      expect(error).toMatchObject({ level: "error", status, errorClass: "AI_APICallError" });
      expect(lines.join("\n")).not.toContain(UPSTREAM_TEXT);
    },
  );

  it("ends a retry's wait at the request lifetime bound", async () => {
    const upstream = fakeUpstream({
      failWith: { status: 429, body: "{}", headers: { "Retry-After": "30" } },
    });
    const { app } = testApp({ fetch: upstream.fetch }, { requestTimeoutMs: 150 });
    const started = Date.now();
    const body = await readAll(await app.request("/api/chat", postJson(request)));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(body).toContain('"type":"abort"');
    expect(upstream.records).toHaveLength(1);
  });

  it("rejects an invalid request without echoing it", async () => {
    const { app, lines } = testApp({ fetch: fakeUpstream().fetch });
    const response = await app.request(
      "/api/chat",
      postJson({
        model: "m",
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages: [{ role: "system", content: CANARY }],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("logs operational fields only", async () => {
    const { app, lines } = testApp({ fetch: fakeUpstream({ chunks: [CANARY] }).fetch });
    await readAll(await app.request("/api/chat", postJson(request)));
    await until(() => lines.some((line) => line.includes("generation.end")));
    for (const line of lines) {
      expect(line).not.toContain(CANARY);
      expect(Object.keys(JSON.parse(line))).toSatisfy((keys: string[]) =>
        keys.every((key) =>
          [
            "time",
            "level",
            "event",
            "route",
            "method",
            "status",
            "durationMs",
            "model",
            "errorClass",
            "finishReason",
          ].includes(key),
        ),
      );
    }
    expect(lines.join("\n")).not.toContain(config.upstreamApiKey);
    expect(lines.some((line) => line.includes('"route":"/api/chat"'))).toBe(true);
  });

  it("does not accept a request for an invalid username even with a valid body", async () => {
    const { app } = testApp({ fetch: fakeUpstream().fetch });
    const response = await app.request(
      "/api/chat",
      postJson(request, { headers: ownerHeaders({ "Remote-User": "Intruder" }) }),
    );
    expect(response.status).toBe(403);
  });
});

describe("the chat's cache affinity id", () => {
  const cacheKey = crypto.randomUUID();

  it("reaches the upstream as body prompt_cache_key and header x-session-affinity", async () => {
    const upstream = fakeUpstream({ chunks: ["Aye."] });
    const { app } = testApp({ fetch: upstream.fetch });
    await readAll(await app.request("/api/chat", postJson({ ...request, cacheKey })));
    expect(upstream.records[0]?.body).toMatchObject({ prompt_cache_key: cacheKey });
    expect(upstream.records[0]?.affinity).toBe(cacheKey);
  });

  it("goes with the provider's own reasoning effort, not instead of it", async () => {
    const upstream = fakeUpstream({ chunks: ["Aye."] });
    const { app, instances } = testApp({ fetch: upstream.fetch });
    const samplerPresetId = instances
      .instance(TEST_USER)
      .stores.presets.sampler.create(
        { name: "Deep", values: { ...defaultSamplerPreset().values, reasoning: "max" } },
        crypto.randomUUID(),
      );
    await readAll(
      await app.request("/api/chat", postJson({ ...request, samplerPresetId, cacheKey })),
    );
    expect(upstream.records[0]?.body).toMatchObject({
      reasoning_effort: "max",
      prompt_cache_key: cacheKey,
    });
    expect(upstream.records[0]?.affinity).toBe(cacheKey);
  });

  it("is not invented for a request without one", async () => {
    const upstream = fakeUpstream({ chunks: ["Aye."] });
    const { app } = testApp({ fetch: upstream.fetch });
    await readAll(await app.request("/api/chat", postJson(request)));
    expect(upstream.records[0]?.body).not.toHaveProperty("prompt_cache_key");
    expect(upstream.records[0]?.affinity).toBeNull();
  });

  it("is refused on a preview, which sends nothing upstream", async () => {
    const upstream = fakeUpstream();
    const { app } = testApp({ fetch: upstream.fetch });
    const accepted = await app.request("/api/chat/preview", postJson(request));
    expect(accepted.status).toBe(200);
    const keyed = await app.request("/api/chat/preview", postJson({ ...request, cacheKey }));
    expect(keyed.status).toBe(400);
    expect(upstream.records).toEqual([]);
    expect(JSON.stringify(upstream.modelRequests)).not.toContain(cacheKey);
  });

  it("never reaches the log", async () => {
    const upstream = fakeUpstream({ chunks: ["Aye."] });
    const { app, lines } = testApp({ fetch: upstream.fetch });
    await readAll(await app.request("/api/chat", postJson({ ...request, cacheKey })));
    await until(() => lines.some((line) => line.includes("generation.end")));
    expect(upstream.records[0]?.affinity).toBe(cacheKey);
    expect(lines.join("\n")).not.toContain(cacheKey);
  });
});

describe("the model's usage", () => {
  /** The finish part's metadata, and the log lines, for a reply with `usage`. */
  async function finished(usage: NonNullable<FakeUpstreamOptions["usage"]>) {
    const { app, lines } = testApp({ fetch: fakeUpstream({ chunks: ["Aye."], usage }).fetch });
    const text = await readAll(await app.request("/api/chat", postJson(request)));
    await until(() => lines.some((line) => line.includes("generation.end")));
    const finish = streamParts(text).find((part) => part.type === "finish");
    return { metadata: finish?.messageMetadata, lines };
  }

  it("reach the inspector with the model's count, and never the log", async () => {
    const { metadata, lines } = await finished({
      prompt_tokens: 40,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 7 },
    });
    expect(metadata).toMatchObject({ inputTokens: 40, cachedTokens: 7 });
    expect(lines.join("\n")).not.toContain("cachedTokens");
  });

  it("leave the cache figure unknown when the provider reports none", async () => {
    const { metadata } = await finished({ prompt_tokens: 40, completion_tokens: 2 });
    expect(metadata).toEqual({ inputTokens: 40, outputTokens: 2 });
  });

  it("carry what the model wrote and its reasoning share", async () => {
    const { metadata, lines } = await finished({
      prompt_tokens: 12_345,
      completion_tokens: 820,
      prompt_tokens_details: { cached_tokens: 9_800 },
      completion_tokens_details: { reasoning_tokens: 210 },
    });
    expect(metadata).toEqual({
      inputTokens: 12_345,
      cachedTokens: 9_800,
      outputTokens: 820,
      reasoningTokens: 210,
    });
    expect(lines.join("\n")).not.toContain("reasoningTokens");
  });
});

describe("the chat's cast register", () => {
  const cast = {
    entries: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        role: "minor",
        anchor: {
          ...Object.fromEntries(CAST_ANCHOR_FIELDS.map((field) => [field, ""])),
          name: `Ilse ${CANARY}`,
          gender: "female",
          age: "29",
        },
        aka: [],
        state: {
          ...Object.fromEntries(CAST_STATE_FIELDS.map((field) => [field, ""])),
          present: true,
          mood: "wary",
        },
      },
    ],
  };

  it("goes upstream as the anchors block and the state before the latest turn, never logged", async () => {
    const upstream = fakeUpstream({ chunks: ["Aye."] });
    const { app, lines } = testApp({ fetch: upstream.fetch });
    await readAll(await app.request("/api/chat", postJson({ ...request, cast })));
    await until(() => lines.some((line) => line.includes("generation.end")));
    const body = upstream.records[0]?.body as
      | { messages: { role: string; content: string }[] }
      | undefined;
    const sent = body?.messages ?? [];
    expect(sent.filter((message) => message.content.startsWith("<cast>\n"))).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining(`Ilse ${CANARY}, 29`),
      }),
    ]);
    expect(sent.at(-2)).toEqual({
      role: "user",
      content: `[Cast now:\nIlse ${CANARY}: present, wary]`,
    });
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("is labelled in the preview, and a malformed one is refused without an echo", async () => {
    const { app } = testApp({ fetch: fakeUpstream().fetch });
    const preview = await app.request("/api/chat/preview", postJson({ ...request, cast }));
    const sources = previewResponseSchema
      .parse(await preview.json())
      .prompt.messages.map((message) => message.source);
    expect(sources).toContainEqual({ kind: "block", id: "castAnchors" });
    expect(sources.at(-2)).toEqual({ kind: "castState", depth: 1 });
    const malformed = { entries: [{ ...cast.entries[0], id: CANARY }] };
    const refused = await app.request("/api/chat", postJson({ ...request, cast: malformed }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(CANARY);
  });
});

describe("history trimming", () => {
  /** A chat of `count` turns of about ten tokens each; an odd count ends on the user's. */
  const chat = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i} ${"word ".repeat(8)}`,
    }));

  /** How the prompt sent for `messages` was trimmed, and its first included message. */
  async function trimmed(messages: ReturnType<typeof chat>) {
    const { app, instances } = testApp({ fetch: fakeUpstream({ chunks: ["Aye."] }).fetch });
    const { stores } = instances.instance(TEST_USER);
    // A 1,024-token context overflows quickly, and the plain preset's prompt never calibrates.
    stores.settings.update({ contextLimits: { "fake-model": 1_024 } });
    const promptPresetId = stores.presets.prompt.create(plainPromptPreset(), crypto.randomUUID());
    const body = postJson({ ...request, promptPresetId, messages });
    const text = await readAll(await app.request("/api/chat", body));
    const prompt = promptPart(streamParts(text));
    return { first: prompt.firstIncludedMessageId, trimming: prompt.trimming };
  }

  // The next request adds the reply and the user's next turn.
  it("keeps the retained start in place when the chat grows by a turn, by default", async () => {
    const before = await trimmed(chat(81));
    const after = await trimmed(chat(83));
    expect(before.trimming).toBe("blocks");
    expect(before.first).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });

  it("refuses the retired trimming setting", async () => {
    const { app } = testApp();
    const response = await app.request("/api/settings", {
      ...postJson({ trimInBlocks: false }),
      method: "PATCH",
    });
    expect(response.status).toBe(400);
  });
});
