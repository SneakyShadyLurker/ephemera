import { describe, expect, it, vi } from "vitest";
import { createCatalog, type UpstreamFetch } from "../src/catalog.ts";
import { createLogger } from "../src/log.ts";
import { FAKE_WINDOW, fakeUpstream } from "./fake-upstream.ts";
import { CLOCK, config, ownerHeaders, PICK_SEED, postJson, testApp } from "./helpers.ts";

describe("GET /api/models", () => {
  it("lists each listed model's window and reasoning from the catalog, using the server-held key", async () => {
    const upstream = fakeUpstream({
      catalog: [
        {
          slug: "zeta",
          context_window: 262_144,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }],
          visibility: "list",
        },
        { slug: "image-model", context_window: 8_192, visibility: "hide" },
        { slug: "alpha" },
        { slug: "alpha", context_window: 5 },
      ],
    });
    const { app } = testApp({ fetch: upstream.fetch });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(await response.json()).toEqual({
      models: [
        { id: "alpha", contextWindow: null, reasoning: null, images: null },
        { id: "zeta", contextWindow: 262_144, reasoning: ["low", "max"], images: null },
      ],
    });
    expect(upstream.modelRequests[0]?.url).toBe("/v1/models");
    expect(upstream.modelRequests[0]?.authorization).toBe(`Bearer ${config.upstreamApiKey}`);
  });

  it("asks for the catalog, not the plain list", async () => {
    const seen: string[] = [];
    const upstream = fakeUpstream({ models: ["a"] });
    const { app } = testApp({
      fetch: (input, init) => {
        seen.push(String(input));
        return upstream.fetch(input, init);
      },
    });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(await response.json()).toEqual({
      models: [{ id: "a", contextWindow: FAKE_WINDOW, reasoning: expect.any(Array), images: null }],
    });
    expect(seen[0]).toBe(`${config.upstreamBaseUrl}/models?client_version=&detailed=true`);
  });

  it("sends no Authorization header to an upstream that needs no key", async () => {
    const upstream = fakeUpstream({ models: ["a"], catalogQueryMissing: true });
    const { app } = testApp({ fetch: upstream.fetch }, { upstreamApiKey: undefined });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(response.status).toBe(200);
    expect(upstream.modelRequests).toHaveLength(2);
    expect(upstream.modelRequests.map((request) => request.authorization)).toEqual([null, null]);
  });

  it.each([
    [
      "an upstream error",
      async () => new Response("upstream-secret-key-value leaked", { status: 500 }),
    ],
    ["an unreachable upstream", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("answers 502 without detail on %s", async (_label, fetch) => {
    const { app, lines } = testApp({ fetch });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain(config.upstreamApiKey);
    expect(lines.join("\n")).not.toContain("leaked");
  });
});

describe("an upstream without the rich catalog", () => {
  /** The model list requests' URLs, in order. */
  const recording = (fetch: UpstreamFetch) => {
    const seen: string[] = [];
    return {
      seen,
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/models")) seen.push(String(input));
        return fetch(input, init);
      },
    };
  };
  const plain = `${config.upstreamBaseUrl}/models`;
  const rich = `${plain}?client_version=&detailed=true`;
  const modelLogs = (lines: string[]) =>
    lines.map((line) => JSON.parse(line)).filter((line) => line.event === "upstream.models");

  it("lists the plain model list when the catalog query is missing", async () => {
    const upstream = fakeUpstream({ models: ["b", "a"], catalogQueryMissing: true });
    const { seen, fetch } = recording(upstream.fetch);
    const { app, lines } = testApp({ fetch });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(await response.json()).toEqual({
      models: [
        { id: "a", contextWindow: null, reasoning: null, images: null },
        { id: "b", contextWindow: null, reasoning: null, images: null },
      ],
    });
    expect(seen).toEqual([rich, plain]);
    expect(upstream.modelRequests[1]?.authorization).toBe(`Bearer ${config.upstreamApiKey}`);
    expect(modelLogs(lines)).toEqual([expect.objectContaining({ status: 404 })]);
  });

  it("lists the plain model list when the catalog query answers something else", async () => {
    const { seen, fetch } = recording(async (input) =>
      new URL(String(input)).searchParams.has("client_version")
        ? Response.json({ data: "leaked catalog text" })
        : Response.json({ object: "list", data: [{ id: "a", object: "model" }] }),
    );
    const { app, lines } = testApp({ fetch });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(await response.json()).toEqual({
      models: [{ id: "a", contextWindow: null, reasoning: null, images: null }],
    });
    expect(seen).toEqual([rich, plain]);
    expect(modelLogs(lines)).toEqual([
      expect.objectContaining({ errorClass: "InvalidModelCatalog" }),
    ]);
    expect(lines.join("\n")).not.toContain("leaked");
  });

  it("keeps the plain list for generation", async () => {
    const upstream = fakeUpstream({ models: ["a"], catalogQueryMissing: true });
    const catalog = createCatalog(
      config,
      upstream.fetch,
      createLogger(() => {}),
    );
    const signal = new AbortController().signal;
    const expected = [{ id: "a", contextWindow: null, reasoning: null, images: null }];
    expect(await catalog.current(signal)).toEqual(expected);
    expect(await catalog.current(signal)).toEqual(expected);
    expect(upstream.modelRequests).toHaveLength(2);
  });

  it("answers 502 and logs each failure without its body when both requests fail", async () => {
    const { seen, fetch } = recording(async (input) =>
      new URL(String(input)).searchParams.has("client_version")
        ? new Response("leaked rich", { status: 404 })
        : new Response("leaked plain", { status: 503 }),
    );
    const { app, lines } = testApp({ fetch });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    expect(seen).toHaveLength(2);
    expect(modelLogs(lines)).toEqual([
      expect.objectContaining({ status: 404 }),
      expect.objectContaining({ status: 503 }),
    ]);
    expect(lines.join("\n")).not.toContain("leaked");
  });

  it("does not ask again after a server error or an unreachable upstream", async () => {
    for (const answer of [
      async () => new Response("down", { status: 500 }),
      async () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      const { seen, fetch } = recording(answer);
      const { app } = testApp({ fetch });
      expect((await app.request("/api/models", { headers: ownerHeaders() })).status).toBe(502);
      expect(seen).toHaveLength(1);
    }
  });
});

describe("a catalog past its bounds", () => {
  const huge = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode(" ".repeat(1024 * 1024));
        for (let i = 0; i < 12; i++) controller.enqueue(chunk);
        controller.close();
      },
    });

  it("refuses a body over the byte cap, streamed or declared, without buffering it all", async () => {
    let cancelled = false;
    for (const declared of [false, true]) {
      const body = huge();
      const reader = body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() {
          cancelled = true;
        },
      });
      // The plain list the server asks for next is over the cap too.
      const { app } = testApp({
        fetch: async (input) =>
          new Response(
            new URL(String(input)).searchParams.has("client_version") ? stream : huge(),
            {
              headers: declared ? { "Content-Length": String(12 * 1024 * 1024) } : {},
            },
          ),
      });
      const response = await app.request("/api/models", { headers: ownerHeaders() });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "upstream_invalid" });
    }
    expect(cancelled).toBe(true);
  });

  it("refuses a catalog and a plain list with more entries than any real one", async () => {
    const upstream = fakeUpstream({ models: Array.from({ length: 2_001 }, (_, i) => `m${i}`) });
    const { app } = testApp({ fetch: upstream.fetch });
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(response.status).toBe(502);
  });
});

describe("the catalog for generation", () => {
  it("keeps using the last good catalog while the upstream cannot answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let down = false;
      const upstream = fakeUpstream({ chunks: ["ok"] });
      const { app } = testApp({
        fetch: (input, init) =>
          down && String(input).includes("/models")
            ? Promise.resolve(new Response("down", { status: 503 }))
            : upstream.fetch(input, init),
      });
      const body = { model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [] };
      expect((await app.request("/api/chat/preview", postJson(body))).status).toBe(200);
      down = true;
      vi.setSystemTime(Date.now() + 120_000);
      expect((await app.request("/api/chat/preview", postJson(body))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["refuses its query", async () => new Response("leaked", { status: 404 })],
    ["answers something else", async () => Response.json({ data: "leaked catalog text" })],
  ])(
    "keeps a served catalog's windows and reasoning when the upstream later %s, without the plain list",
    async (_label, failing) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        let down = false;
        const seen: string[] = [];
        const upstream = fakeUpstream({ models: ["a"] });
        const catalog = createCatalog(
          config,
          (input, init) => {
            seen.push(String(input));
            return down ? failing() : upstream.fetch(input, init);
          },
          createLogger(() => {}),
        );
        const signal = new AbortController().signal;
        const served = await catalog.current(signal);
        expect(served).toEqual([
          { id: "a", contextWindow: FAKE_WINDOW, reasoning: expect.any(Array), images: null },
        ]);
        down = true;
        seen.length = 0;
        vi.setSystemTime(Date.now() + 120_000);
        expect(await catalog.current(signal)).toEqual(served);
        expect(seen).toEqual([`${config.upstreamBaseUrl}/models?client_version=&detailed=true`]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("shares one catalog request among requests that arrive together", async () => {
    let requests = 0;
    const upstream = fakeUpstream({ chunks: ["ok"] });
    const { app } = testApp({
      fetch: (input, init) => {
        if (String(input).includes("/models")) requests += 1;
        return upstream.fetch(input, init);
      },
    });
    const body = { model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [] };
    const responses = await Promise.all(
      [1, 2, 3].map(() => app.request("/api/chat/preview", postJson(body))),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(requests).toBe(1);
  });
});

describe("a request the client gave up on", () => {
  it("is not logged as the upstream failing", async () => {
    const { app, lines } = testApp({
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    const controller = new AbortController();
    const pending = app.request("/api/models", {
      headers: ownerHeaders(),
      signal: controller.signal,
    });
    controller.abort();
    await pending;
    expect(lines.some((line) => line.includes("upstream.models"))).toBe(false);
  });

  it("stops waiting for a slow catalog as soon as its request ends", async () => {
    const { app } = testApp({
      fetch: (input) =>
        String(input).includes("/models") ? new Promise<Response>(() => {}) : fetch(input),
    });
    const controller = new AbortController();
    const body = { model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [] };
    const started = performance.now();
    const pending = app.request("/api/chat/preview", {
      ...postJson(body),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    expect((await pending).status).toBe(408);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
