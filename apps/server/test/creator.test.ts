import {
  ART_METAPROMPTS,
  ART_STREAM_TYPE,
  type ArtStreamEvent,
  artMetaprompt,
  artPrompt,
  blankCard,
  CARD_LIMITS,
  CARD_SYSTEM_PROMPTS,
  CREATOR_ART,
  CREATOR_LIMITS,
  type CreatorCardEvent,
  type CreatorImageCardEvent,
  type CreatorKind,
  cardPrompt,
  cardRetryPrompt,
  creatorArtStatusSchema,
  creatorArtWorkflowsSchema,
  creatorCardEventSchema,
  creatorImageCardEventSchema,
  decodeArtFrames,
  imageCardPrompt,
  MEMORY_LIMITS,
  REWORK_LIMITS,
  REWORK_SYSTEM_PROMPT,
  type ReworkCard,
  type ReworkEvent,
  reworkEventSchema,
} from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowGraph } from "../src/comfyui/workflow.ts";
import { ART_TIMEOUT_MS, MAX_REWORK_BODY_BYTES } from "../src/creator.ts";
import { usernameSchema } from "../src/identity.ts";
import { IMAGE_LIMITS, toPortrait } from "../src/images.ts";
import { KEEPALIVE_INTERVAL_MS } from "../src/keepalive.ts";
import { helperInputTokens } from "../src/object-call.ts";
import { type FakeComfyuiOptions, fakeComfyui, fakePng, UPSTREAM_SECRET } from "./fake-comfyui.ts";
import {
  type CatalogEntry,
  catalogEntry,
  type FakeTurn,
  type FakeUpstreamOptions,
  fakeUpstream,
} from "./fake-upstream.ts";
import { integrationHeaders, ownerHeaders, postJson, TEST_USER, testApp } from "./helpers.ts";
import { html, imageMetadata, plainJpeg, plainPng, pngWithNoise } from "./image-fixtures.ts";
import { TEST_WORKFLOWS } from "./test-workflows.ts";
import { muteConsole, until } from "./vitest-helpers.ts";

const COMFY = "https://comfy.test:8188";
const DESCRIPTION = "canary-creator-desc-4b1e a placeholder lighthouse keeper";
const CARD_CANARY = "canary-creator-card-8d2f";
const IMAGE_PROMPT = "canary-creator-image-prompt-c7a0 a keeper on a placeholder pier at dusk";
const SOURCE = "canary-creator-source-19e3 tall, placeholder build";
const UPSTREAM_TEXT = "upstream-error-text-creator-5a7d";
const NOTES = "canary-image-card-notes-2c8e a placeholder baker at golden hour, 85mm";
const CARD_DIRECTION = "canary-image-card-direction-6a1d a retired sea captain, gruff but kind";

const inner = [
  `<backgroundstory>Is 30 and lives in Testtown. ${CARD_CANARY}</backgroundstory>`,
  "<appearance>Tall, placeholder build, grey eyes.</appearance>",
  "<personality>Calm placeholder temperament.</personality>",
  '<vocabulary>Short sentences. "Sample phrase."</vocabulary>',
].join("\n");
const subject = (name: string) => `<${name}>\n${inner}\n</${name}>`;

function answer(description: string): string {
  return [
    "<name>Ada Reed</name>",
    `<description>\n${description}\n</description>`,
    "<firstMessage>Ada looks up.</firstMessage>",
    "<creatorNotes>A placeholder pitch.</creatorNotes>",
  ].join("\n");
}

const SUBJECT_ANSWER = answer(subject("ada_reed"));
const GROUP_ANSWER = answer(`${subject("ada_reed")}\n${subject("bo")}`);
const SCENARIO_DESCRIPTION = [
  "<Roleplay>\nA placeholder premise.\n</Roleplay>",
  "<Setting>A placeholder valley town.</Setting>",
  "<People>Placeholder millers.</People>",
  "<Tone>Quiet placeholder mood.</Tone>",
].join("\n");
const SCENARIO_ANSWER = answer(SCENARIO_DESCRIPTION);

/** The answer in pieces, as a model streams it. */
const pieces = (text: string, size = 40) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );

/** A catalog whose model offers only these efforts. */
const offering = (...efforts: string[]): CatalogEntry[] => [
  {
    ...catalogEntry("fake-model"),
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
  },
];
/** A provider still busy through the AI SDK's retries; it asks for no wait, so they run at once. */
const stillBusy = (status: 429 | 503): FakeUpstreamOptions => ({
  failWith: {
    status,
    body: JSON.stringify({ error: { message: UPSTREAM_TEXT } }),
    headers: { "Retry-After": "0" },
  },
});
/** Each call's cache key, as body `prompt_cache_key` and header `x-session-affinity` agree on it. */
const cacheKeys = (upstream: ReturnType<typeof fakeUpstream>) =>
  upstream.records.map((record) => {
    const key = (record.body as { prompt_cache_key?: unknown }).prompt_cache_key;
    expect(record.affinity).toBe(key);
    return key;
  });

interface Setup {
  upstream?: FakeUpstreamOptions;
  comfy?: FakeComfyuiOptions;
  /** The saved ComfyUI address; empty means none. */
  address?: string;
  requestTimeoutMs?: number;
}

function setup(options: Setup = {}) {
  const upstream = fakeUpstream(options.upstream);
  const comfy = fakeComfyui(options.comfy);
  // One outbound fetch, as in app.ts: ComfyUI's host goes to the fake ComfyUI.
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.origin === COMFY ? comfy.fetch(input, init) : upstream.fetch(input, init);
  };
  const { app, lines, instances } = testApp(
    { fetch, comfyuiSocket: comfy.socket, workflows: TEST_WORKFLOWS },
    options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
  );
  const { stores } = instances.instance(TEST_USER);
  stores.settings.update({ comfyuiBaseUrl: options.address ?? COMFY });
  return { app, lines, upstream, comfy, stores, instances };
}

async function events<T>(response: Response, parse: (value: unknown) => T): Promise<T[]> {
  const text = await response.text();
  expect(text.endsWith("\n")).toBe(true);
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => parse(JSON.parse(line)));
}

const cardEvents = (response: Response): Promise<CreatorCardEvent[]> =>
  events(response, (value) => creatorCardEventSchema.parse(value));
async function artEvents(response: Response): Promise<ArtStreamEvent[]> {
  expect(response.headers.get("Content-Type")).toBe(ART_STREAM_TYPE);
  async function* chunks() {
    yield new Uint8Array(await response.arrayBuffer());
  }
  const all: ArtStreamEvent[] = [];
  for await (const event of decodeArtFrames(chunks())) all.push(event);
  return all;
}

const cardRequest = (kind: CreatorKind = "subject") => ({
  kind,
  description: DESCRIPTION,
  model: "fake-model",
});
const artRequest = {
  kind: "subject",
  model: "fake-model",
  source: SOURCE,
  workflow: "krea2-gonzalomo",
};

const text = (all: CreatorCardEvent[]) =>
  all.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");

/** No log line carries any creation draft. */
function expectContentFree(lines: string[], extra: string[] = []) {
  const log = lines.join("\n");
  const drafts = [
    DESCRIPTION,
    CARD_CANARY,
    IMAGE_PROMPT,
    SOURCE,
    NOTES,
    CARD_DIRECTION,
    UPSTREAM_SECRET,
  ];
  for (const draft of [...drafts, ...extra]) {
    expect(log).not.toContain(draft);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/creator/card", () => {
  it.each([
    ["subject", SUBJECT_ANSWER],
    ["group", GROUP_ANSWER],
    ["scenario", SCENARIO_ANSWER],
  ] as const)("streams a %s card as NDJSON and ends with a valid result", async (kind, written) => {
    const { app, lines, upstream } = setup({ upstream: { chunks: pieces(written) } });
    const response = await app.request("/api/creator/card", postJson(cardRequest(kind)));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const all = await cardEvents(response);

    expect(text(all)).toBe(written);
    expect(all.slice(0, -1).every((event) => event.type === "delta")).toBe(true);
    const last = all.at(-1);
    expect(last).toMatchObject({ type: "result", validation: { ok: true } });
    if (last?.type !== "result") return;
    if (kind !== "scenario") {
      const blocks = kind === "subject" ? ["ada_reed"] : ["ada_reed", "bo"];
      expect(last.tokens.map(({ block, cap }) => ({ block, cap }))).toEqual(
        blocks.map((block) => ({ block, cap: CREATOR_LIMITS.subjectBlockTokens })),
      );
    } else {
      expect(last.tokens).toEqual([
        {
          block: "description",
          tokens: expect.any(Number),
          cap: CREATOR_LIMITS.scenarioDescriptionTokens,
        },
      ]);
    }
    for (const { tokens } of last.tokens) expect(tokens).toBeGreaterThan(0);

    const sent = upstream.records[0]?.body as {
      messages: { role: string; content: string }[];
      max_tokens?: number;
      stream: boolean;
    };
    expect(sent.stream).toBe(true);
    expect(sent.max_tokens).toBe(CREATOR_LIMITS.maxOutputTokens);
    expect(sent.messages).toEqual([
      { role: "system", content: CARD_SYSTEM_PROMPTS[kind] },
      { role: "user", content: DESCRIPTION },
    ]);
    expect(upstream.records).toHaveLength(1);
    expectContentFree(lines);
  });

  it("writes the card for the chosen persona, so {{user}} is known, and logs none of it", async () => {
    const { app, lines, upstream, stores } = setup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const persona = {
      name: "Kai Moss",
      description: "canary-creator-persona-6e2b a placeholder sailor",
    };
    const personaId = crypto.randomUUID();
    stores.personas.create(persona, personaId);
    const response = await app.request(
      "/api/creator/card",
      postJson({ ...cardRequest(), personaId }),
    );
    expect((await cardEvents(response)).at(-1)).toMatchObject({ validation: { ok: true } });
    const sent = upstream.records[0]?.body as { messages: { role: string; content: string }[] };
    expect(sent.messages).toEqual([
      { role: "system", content: CARD_SYSTEM_PROMPTS.subject },
      { role: "user", content: cardPrompt(DESCRIPTION, persona) },
    ]);
    const user = sent.messages.at(-1)?.content ?? "";
    for (const part of [persona.name, persona.description, DESCRIPTION]) {
      expect(user).toContain(part);
    }
    expectContentFree(lines, [persona.description]);
  });

  it("sends the chosen reasoning effort upstream, and none for the model default", async () => {
    const { app, upstream } = setup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    for (const reasoning of ["xhigh", "max", "provider-default"] as const) {
      const response = await app.request(
        "/api/creator/card",
        postJson({ ...cardRequest(), reasoning }),
      );
      expect((await cardEvents(response)).at(-1)).toMatchObject({ validation: { ok: true } });
    }
    await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    const [xhigh, max, unset, absent] = upstream.records.map((record) => record.body);
    expect(xhigh).toMatchObject({ reasoning_effort: "xhigh" });
    expect(max).toMatchObject({ reasoning_effort: "max" });
    expect(unset).not.toHaveProperty("reasoning_effort");
    expect(absent).not.toHaveProperty("reasoning_effort");
  });

  it("asks for no more output than the catalog says the model can write", async () => {
    const { app, upstream } = setup({
      upstream: {
        chunks: [SUBJECT_ANSWER],
        catalog: [{ ...catalogEntry("fake-model"), max_completion_tokens: 32_000 }],
      },
    });
    await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    expect(upstream.records[0]?.body).toMatchObject({ max_tokens: 32_000 });
  });

  it("narrows the effort to what the catalog says the model offers, whatever the tab sent", async () => {
    const { app, upstream } = setup({
      upstream: { chunks: [SUBJECT_ANSWER], catalog: offering("low", "high") },
    });
    for (const reasoning of ["high", "xhigh", "max"] as const) {
      await cardEvents(
        await app.request("/api/creator/card", postJson({ ...cardRequest(), reasoning })),
      );
    }
    const [high, xhigh, max] = upstream.records.map((record) => record.body);
    expect(high).toMatchObject({ reasoning_effort: "high" });
    expect(xhigh).not.toHaveProperty("reasoning_effort");
    expect(max).not.toHaveProperty("reasoning_effort");
  });

  it("sends one cache key for a request's calls, its retry included, and a new one per request", async () => {
    const { app, upstream } = setup({
      upstream: { turns: [{ chunks: ["<name>Ada</name>"] }, { chunks: [SUBJECT_ANSWER] }] },
    });
    await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    const [first, retry, next] = cacheKeys(upstream);
    expect(first).toEqual(expect.any(String));
    expect(retry).toBe(first);
    expect(next).toEqual(expect.any(String));
    expect(next).not.toBe(first);
  });

  it.each([429, 503] as const)(
    "says upstream_busy when the provider answers %i through every retry",
    async (status) => {
      const { app, lines, upstream } = setup({ upstream: stillBusy(status) });
      const response = await app.request("/api/creator/card", postJson(cardRequest()));
      const body = await response.clone().text();
      expect(await cardEvents(response)).toEqual([
        { type: "error", code: "upstream_busy", retryAfterS: 0 },
      ]);
      // The first call and the AI SDK's two retries, then no card retry.
      expect(upstream.records).toHaveLength(3);
      expect(body).not.toContain(UPSTREAM_TEXT);
      expect(lines.some((line) => line.includes(`"status":${status}`))).toBe(true);
      expectContentFree(lines, [UPSTREAM_TEXT]);
    },
  );

  it("refuses a reasoning effort it does not know", async () => {
    const { app, upstream } = setup();
    const response = await app.request(
      "/api/creator/card",
      postJson({ ...cardRequest(), reasoning: "ultra" }),
    );
    expect(response.status).toBe(400);
    expect(upstream.records).toHaveLength(0);
  });

  it("writes without a persona when the chosen one no longer exists", async () => {
    const { app, upstream } = setup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const response = await app.request(
      "/api/creator/card",
      postJson({ ...cardRequest(), personaId: crypto.randomUUID() }),
    );
    expect((await cardEvents(response)).at(-1)).toMatchObject({ validation: { ok: true } });
    const sent = upstream.records[0]?.body as { messages: { role: string; content: string }[] };
    expect(sent.messages.at(-1)).toEqual({ role: "user", content: DESCRIPTION });
  });

  const BROKEN = SUBJECT_ANSWER.replace("<firstMessage>Ada looks up.</firstMessage>\n", "");
  const BROKEN_PROBLEMS = [{ code: "missing", section: "firstMessage" }] as const;

  it("retries an invalid answer once, with the answer and its problems, and keeps a valid second", async () => {
    const { app, lines, upstream } = setup({
      upstream: { turns: [{ chunks: pieces(BROKEN) }, { chunks: pieces(SUBJECT_ANSWER) }] },
    });
    const all = await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    const retry = all.findIndex((event) => event.type === "retry");
    expect(all[retry]).toEqual({ type: "retry", problems: BROKEN_PROBLEMS });
    expect(text(all.slice(0, retry))).toBe(BROKEN);
    expect(text(all.slice(retry + 1))).toBe(SUBJECT_ANSWER);
    expect(all.filter((event) => event.type === "retry")).toHaveLength(1);
    expect(all.at(-1)).toMatchObject({ type: "result", validation: { ok: true } });

    expect(upstream.records).toHaveLength(2);
    const second = upstream.records[1]?.body as {
      messages: { role: string; content: string }[];
      max_tokens?: number;
    };
    expect(second.max_tokens).toBe(CREATOR_LIMITS.maxOutputTokens);
    expect(second.messages).toEqual([
      { role: "system", content: CARD_SYSTEM_PROMPTS.subject },
      { role: "user", content: DESCRIPTION },
      { role: "assistant", content: BROKEN },
      { role: "user", content: cardRetryPrompt([...BROKEN_PROBLEMS]) },
    ]);
    expect(second.messages.at(-1)?.content).toContain("<firstMessage>");
    expect(lines.some((line) => line.includes('"attempt":2'))).toBe(true);
    expectContentFree(lines);
  });

  it("retries only once: a second invalid answer ends with the invalid result", async () => {
    const { app, lines, upstream } = setup({ upstream: { chunks: pieces(BROKEN) } });
    const all = await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    expect(all.filter((event) => event.type === "retry")).toHaveLength(1);
    expect(all.at(-1)).toEqual({
      type: "result",
      validation: { ok: false, problems: BROKEN_PROBLEMS },
      tokens: [],
    });
    expect(upstream.records).toHaveLength(2);
    expectContentFree(lines);
  });

  it("skips the retry when the first answer sent back would not fit a known window", async () => {
    // Room for the request and its answer's reserve: the first answer on top of it is past the window.
    const asked =
      helperInputTokens([CARD_SYSTEM_PROMPTS.subject, DESCRIPTION]) + MEMORY_LIMITS.replyReserve;
    const { app, lines, upstream } = setup({
      upstream: {
        chunks: pieces(BROKEN),
        catalog: [{ ...catalogEntry("fake-model"), context_window: asked + 8 }],
      },
    });
    const all = await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    expect(all.some((event) => event.type === "retry")).toBe(false);
    expect(all.at(-1)).toEqual({
      type: "result",
      validation: { ok: false, problems: BROKEN_PROBLEMS },
      tokens: [],
    });
    expect(upstream.records).toHaveLength(1);
    expectContentFree(lines);
  });

  it.each([
    ["length", "cut"],
    ["content_filter", "filtered"],
  ] as const)(
    "ends an answer finished by %s with %s, unchecked and not retried",
    async (finishReason, code) => {
      const partial = SUBJECT_ANSWER.slice(0, 120);
      const { app, lines, upstream } = setup({
        upstream: { chunks: pieces(partial), finishReason },
      });
      const all = await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
      expect(text(all)).toBe(partial);
      expect(all.at(-1)).toEqual({ type: "error", code });
      expect(all.some((event) => event.type === "retry" || event.type === "result")).toBe(false);
      expect(upstream.records).toHaveLength(1);
      expect(
        lines.some((line) =>
          line.includes(
            `"finishReason":"${finishReason === "length" ? "length" : "content-filter"}"`,
          ),
        ),
      ).toBe(true);
      expectContentFree(lines);
    },
  );

  it("ends at once on an in-stream error, aborting the upstream call", async () => {
    const { app, lines, upstream } = setup({
      upstream: { chunks: ["<name>Ada"], streamError: `${UPSTREAM_TEXT} ${DESCRIPTION}` },
    });
    const started = performance.now();
    const response = await app.request("/api/creator/card", postJson(cardRequest()));
    const body = await response.clone().text();
    const all = await cardEvents(response);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(all).toEqual([
      { type: "delta", text: "<name>Ada" },
      { type: "error", code: "upstream" },
    ]);
    await until(() => upstream.records[0]?.aborted === true);
    expect(upstream.records[0]?.completed).toBe(false);
    expect(upstream.records).toHaveLength(1);
    expect(body).not.toContain(UPSTREAM_TEXT);
    expectContentFree(lines, [UPSTREAM_TEXT]);
  });

  it("says the model is thinking without a word of it, and never parses reasoning as the card", async () => {
    const REASONING = "canary-creator-reasoning-2c8e";
    const { app, lines } = setup({
      upstream: {
        reasoning: [`${REASONING} first`, ` ${REASONING} second`, ` ${REASONING} third`],
        chunks: pieces(SUBJECT_ANSWER),
      },
    });
    const response = await app.request("/api/creator/card", postJson(cardRequest()));
    const body = await response.clone().text();
    const all = await cardEvents(response);
    // Three pieces within a second: one event.
    expect(all.filter((event) => event.type === "thinking")).toEqual([{ type: "thinking" }]);
    expect(all[0]).toEqual({ type: "thinking" });
    expect(text(all)).toBe(SUBJECT_ANSWER);
    expect(all.at(-1)).toMatchObject({ type: "result", validation: { ok: true } });
    expect(body).not.toContain(REASONING);
    expectContentFree(lines, [REASONING]);
  });

  it("reads a leading think block out of the answer, so its tags are not card sections", async () => {
    const THOUGHT = "canary-creator-think-71b4";
    const think = `<think>${THOUGHT} <name>Wrong Name</name> <firstMessage>a</firstMessage></think>\n`;
    const { app, lines, upstream } = setup({
      upstream: { chunks: pieces(`${think}${SUBJECT_ANSWER}`, 13) },
    });
    const response = await app.request("/api/creator/card", postJson(cardRequest()));
    const body = await response.clone().text();
    const all = await cardEvents(response);
    expect(all.some((event) => event.type === "thinking")).toBe(true);
    expect(text(all)).toBe(SUBJECT_ANSWER);
    expect(all.at(-1)).toMatchObject({ type: "result", validation: { ok: true } });
    expect(upstream.records).toHaveLength(1);
    expect(body).not.toContain(THOUGHT);
    expectContentFree(lines, [THOUGHT]);
  });

  it("refuses a description that cannot fit a known window before any upstream call", async () => {
    const { app, lines, upstream } = setup({
      upstream: {
        chunks: [SUBJECT_ANSWER],
        catalog: [{ ...catalogEntry("fake-model"), context_window: 64 }],
      },
    });
    const all = await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    expect(all).toEqual([{ type: "error", code: "too_large" }]);
    expect(upstream.records).toEqual([]);
    expect(lines.some((line) => line.includes('"errorClass":"PromptTooLarge"'))).toBe(true);
    expectContentFree(lines);
  });

  it("writes for a model without a known window", async () => {
    const { app, upstream } = setup({
      upstream: { chunks: [SUBJECT_ANSWER], catalog: [{ slug: "fake-model" }] },
    });
    const all = await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    expect(all.at(-1)).toMatchObject({ type: "result", validation: { ok: true } });
    expect(upstream.records).toHaveLength(1);
  });

  it("turns an upstream error into one content-free error event, once, without retrying", async () => {
    const consoleSpies = muteConsole();
    const { app, lines, upstream } = setup({
      upstream: {
        failWith: {
          status: 400,
          body: JSON.stringify({ error: { message: `bad ${UPSTREAM_TEXT} ${DESCRIPTION}` } }),
        },
      },
    });
    const response = await app.request("/api/creator/card", postJson(cardRequest()));
    const body = await response.clone().text();
    expect(await cardEvents(response)).toEqual([{ type: "error", code: "upstream" }]);
    expect(body).not.toContain(UPSTREAM_TEXT);
    expect(upstream.records).toHaveLength(1);
    expect(lines.some((line) => line.includes('"event":"creator.card.error"'))).toBe(true);
    expect(lines.some((line) => line.includes('"status":400'))).toBe(true);
    expectContentFree(lines, [UPSTREAM_TEXT]);
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(UPSTREAM_TEXT);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(DESCRIPTION);
    }
  });

  it("stops the upstream call when the client disconnects mid-stream", async () => {
    const { app, upstream } = setup({
      upstream: { chunks: Array.from({ length: 50 }, () => "x"), delayMs: 20 },
    });
    const client = new AbortController();
    const response = await app.request(
      "/api/creator/card",
      postJson(cardRequest(), { signal: client.signal }),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    client.abort();
    await until(() => upstream.records[0]?.aborted === true);
    expect(upstream.records[0]?.completed).toBe(false);
  });

  it("ends a card that outlives the request lifetime with a timeout error", async () => {
    const { app, upstream } = setup({
      upstream: { chunks: ["<name>Ada"], hang: true },
      requestTimeoutMs: 150,
    });
    const all = await cardEvents(await app.request("/api/creator/card", postJson(cardRequest())));
    expect(all).toEqual([
      { type: "delta", text: "<name>Ada" },
      { type: "error", code: "timeout" },
    ]);
    expect(upstream.records[0]?.aborted).toBe(true);
  });

  it("writes blank keepalive lines while the model is silent, and the events are unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const silentMs = 2 * KEEPALIVE_INTERVAL_MS + 5_000;
      const { app } = setup({
        upstream: { reasoning: ["thinking"], chunks: [SUBJECT_ANSWER], delayMs: silentMs },
        requestTimeoutMs: 10 * silentMs,
      });
      const response = await app.request("/api/creator/card", postJson(cardRequest()));
      const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
      if (reader === undefined) throw new Error("no body");
      let body = "";
      const reading = (async () => {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          body += chunk.value;
        }
      })();
      await vi.advanceTimersByTimeAsync(3 * silentMs);
      await reading;

      // Two silences of two intervals each, before the reasoning and the answer.
      expect(body.split("\n").filter((line) => line === "").length).toBeGreaterThanOrEqual(4);
      const all = body
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => creatorCardEventSchema.parse(JSON.parse(line)));
      expect(text(all)).toBe(SUBJECT_ANSWER);
      expect(all.at(-1)).toMatchObject({ type: "result", validation: { ok: true } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/creator/art", () => {
  it.each([123_456, 86_400_001])(
    "uses the art deadline when the general timeout is %s ms",
    async (requestTimeoutMs) => {
      const { app, comfy } = setup({
        upstream: { chunks: [IMAGE_PROMPT] },
        comfy: { mode: "private" },
        requestTimeoutMs,
      });
      const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
      expect(all.at(-1)).toEqual({ type: "done" });
      expect([...comfy.state.controls.values()]).toEqual([
        {
          previews: false,
          imageOutputs: true,
          executionTimeoutSeconds: Math.ceil(ART_TIMEOUT_MS / 1_000),
        },
      ]);
      await until(() => comfy.clean());
    },
  );

  it("streams the decoding and sending phases, four images and done", async () => {
    const { app, comfy } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all.some((event) => event.type === "progress" && event.phase === "decoding")).toBe(true);
    expect(all).toContainEqual({ type: "progress", phase: "sending", value: 3, max: 4 });
    expect(all.filter((event) => event.type === "image")).toHaveLength(4);
    expect(all.at(-1)).toEqual({ type: "done" });
    // Plain cleanup polls retirement every second, beyond expect.poll's default deadline.
    await until(() => comfy.clean());
  });
  it("tells a busy worker's place", async () => {
    const comfy = {
      mode: "private",
      admission: { busyResponses: 1, retryAfter: "0", positions: ["2"] },
    } as const;
    const { app } = setup({ upstream: { chunks: [IMAGE_PROMPT] }, comfy });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all).toContainEqual({ type: "progress", phase: "busy", value: 0, max: 1, position: 2 });
    expect(all.at(-1)).toEqual({ type: "done" });
  });

  it("reports a worker busy past the admission wait as comfyui_busy", async () => {
    const timeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 300_000 ? 30 : ms));
    const comfy = {
      mode: "private",
      admission: { busyResponses: Infinity, retryAfter: "0" },
    } as const;
    const { app } = setup({ upstream: { chunks: [IMAGE_PROMPT] }, comfy });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all.at(-1)).toEqual({ type: "error", code: "comfyui_busy" });
  });

  it("writes the image prompt, then streams ComfyUI's progress, four portraits and done", async () => {
    const { app, lines, upstream, comfy } = setup({ upstream: { chunks: [` ${IMAGE_PROMPT}\n`] } });
    const response = await app.request("/api/creator/art", postJson(artRequest));
    expect(response.headers.get("Content-Type")).toBe(ART_STREAM_TYPE);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const all = await artEvents(response);

    expect(all.slice(0, 2)).toEqual([
      { type: "progress", phase: "prompt", value: 0, max: 1 },
      { type: "progress", phase: "prompt", value: 1, max: 1 },
    ]);
    expect(all[2]).toEqual({ type: "progress", phase: "queued", value: 0, max: 1 });
    expect(all).toContainEqual({ type: "progress", phase: "running", value: 10, max: 10 });
    const images = all.filter((event) => event.type === "image");
    expect(images.map((event) => event.index)).toEqual([0, 1, 2, 3]);
    const png = Buffer.from(fakePng()).toString("base64");
    for (const image of images) expect(image.png).toEqual(new Uint8Array(fakePng()));
    expect(all.slice(-5).map((event) => event.type)).toEqual([
      "image",
      "image",
      "image",
      "image",
      "done",
    ]);
    expect(images).toHaveLength(CREATOR_ART.count);

    const sent = upstream.records[0]?.body as {
      messages: { role: string; content: string }[];
      stream?: boolean;
    };
    expect(sent.stream).not.toBe(true);
    expect(sent.messages).toEqual([
      { role: "system", content: ART_METAPROMPTS.krea2.subject },
      { role: "user", content: SOURCE },
    ]);
    const [graph] = [...comfy.state.prompts.values()] as { "4"?: { inputs: { text: string } } }[];
    expect(graph?.["4"]?.inputs.text).toBe(IMAGE_PROMPT);
    expect((sent as { max_tokens?: number }).max_tokens).toBe(CREATOR_LIMITS.maxOutputTokens);
    // Cleanup runs on after the stream ended, on bounds of its own.
    await until(() => comfy.clean());
    expectContentFree(lines, [png]);
  });

  it("writes the image prompt with the owner's direction after the notes, the metaprompt as it is", async () => {
    const DIRECTION = "canary-art-direction-3f9c on a rooftop";
    const { app, lines, upstream, comfy } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
    const all = await artEvents(
      await app.request(
        "/api/creator/art",
        postJson({ ...artRequest, direction: ` ${DIRECTION} ` }),
      ),
    );
    expect(all.at(-1)).toEqual({ type: "done" });
    const sent = upstream.records[0]?.body as { messages: { role: string; content: string }[] };
    expect(sent.messages).toEqual([
      { role: "system", content: ART_METAPROMPTS.krea2.subject },
      { role: "user", content: artPrompt(SOURCE, DIRECTION) },
    ]);
    await until(() => comfy.clean());
    expectContentFree(lines, [DIRECTION]);
  });

  it("rides an explicit look in the user message after the notes, and none for Auto", async () => {
    const DIRECTION = "canary-art-direction-7c1e at dusk";
    const { app, lines, upstream, comfy } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
    for (const body of [
      { ...artRequest, look: "film" },
      artRequest,
      { ...artRequest, look: "film", direction: DIRECTION },
    ]) {
      const all = await artEvents(await app.request("/api/creator/art", postJson(body)));
      expect(all.at(-1)).toEqual({ type: "done" });
    }
    const sent = upstream.records.map(
      (record) => (record.body as { messages: { role: string; content: string }[] }).messages,
    );
    expect(sent[0]).toEqual([
      { role: "system", content: ART_METAPROMPTS.krea2.subject },
      { role: "user", content: artPrompt(SOURCE, null, false, "film") },
    ]);
    expect(sent[1]).toEqual([
      { role: "system", content: ART_METAPROMPTS.krea2.subject },
      { role: "user", content: SOURCE },
    ]);
    const directed = sent[2]?.[1]?.content ?? "";
    expect(directed.indexOf("<look>")).toBeGreaterThan(-1);
    expect(directed.indexOf("<look>")).toBeLessThan(directed.indexOf("<direction>"));
    await until(() => comfy.clean());
    expectContentFree(lines, [SOURCE]);
    expect(lines.join("\n")).not.toContain("look");
  });

  it("drops a look for a Scenario and keeps it for Group", async () => {
    const { app, upstream, comfy } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
    for (const body of [
      { ...artRequest, kind: "scenario", look: "film" },
      { ...artRequest, kind: "group", look: "selfie" },
    ]) {
      const all = await artEvents(await app.request("/api/creator/art", postJson(body)));
      expect(all.at(-1)).toEqual({ type: "done" });
    }
    const users = upstream.records.map(
      (record) =>
        (record.body as { messages: { role: string; content: string }[] }).messages[1]?.content,
    );
    expect(users[0]).toBe(SOURCE);
    expect(users[1]).toBe(artPrompt(SOURCE, null, false, "selfie"));
    await until(() => comfy.clean());
  });

  it("writes a MOSS workflow's image prompt with the MOSS metaprompt, named or saved", async () => {
    for (const named of [true, false]) {
      const { app, upstream, comfy, stores } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
      stores.settings.update({ comfyuiWorkflow: "moss-fixture" });
      const body = named
        ? { ...artRequest, workflow: "moss-fixture" }
        : { ...artRequest, workflow: undefined };
      const all = await artEvents(await app.request("/api/creator/art", postJson(body)));
      expect(all.at(-1)).toEqual({ type: "done" });
      const sent = upstream.records[0]?.body as { messages: { role: string; content: string }[] };
      expect(sent.messages[0]).toEqual({ role: "system", content: ART_METAPROMPTS.moss.subject });
      const [graph] = [...comfy.state.prompts.values()] as {
        "1"?: { inputs: { unet_name: string } };
        "4"?: { inputs: { text: string } };
      }[];
      expect(graph?.["1"]?.inputs.unet_name).toBe("moss-fixture-base.safetensors");
      expect(graph?.["4"]?.inputs.text).toBe(IMAGE_PROMPT);
      await until(() => comfy.clean());
    }
  });

  it.each(
    ["krea2-gonzalomo", "moss-fixture"].flatMap((workflow) =>
      (["subject", "group", "scenario"] as const).flatMap((kind) =>
        ([undefined, "regular", "diptych"] as const).map((composition) => ({
          workflow,
          kind,
          composition,
        })),
      ),
    ),
  )(
    "routes $workflow composition $composition into the outbound system prompt for $kind",
    async ({ workflow, kind, composition }) => {
      const model = workflow === "moss-fixture" ? "moss" : "krea2";
      const { app, upstream, comfy } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
      const all = await artEvents(
        await app.request(
          "/api/creator/art",
          postJson({
            ...artRequest,
            kind,
            workflow,
            ...(composition === undefined ? {} : { composition }),
          }),
        ),
      );
      expect(all.at(-1)).toEqual({ type: "done" });
      const sent = upstream.records[0]?.body as {
        messages: { role: string; content: string }[];
      };
      expect(sent.messages[0]).toEqual({
        role: "system",
        content: artMetaprompt(model, kind, composition),
      });
      await until(() => comfy.clean());
    },
  );

  it("refuses an unknown composition before calling the model", async () => {
    const { app, upstream } = setup();
    const response = await app.request(
      "/api/creator/art",
      postJson({ ...artRequest, composition: "panorama" }),
    );
    expect(response.status).toBe(400);
    expect(upstream.records).toHaveLength(0);
  });

  it("refuses an unknown look before calling the model", async () => {
    const { app, upstream } = setup();
    const response = await app.request(
      "/api/creator/art",
      postJson({ ...artRequest, look: "polaroid" }),
    );
    expect(response.status).toBe(400);
    expect(upstream.records).toHaveLength(0);
  });

  it("refuses a direction past its limit before calling the model", async () => {
    const { app, upstream } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
    const direction = "x".repeat(CREATOR_LIMITS.artDirectionLength + 1);
    const response = await app.request("/api/creator/art", postJson({ ...artRequest, direction }));
    expect(response.status).toBe(400);
    expect(upstream.records).toHaveLength(0);
  });

  it("writes the image prompt at the chosen effort, and none for the model default", async () => {
    const { app, upstream } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
    for (const reasoning of ["xhigh", "max", "provider-default"] as const) {
      const all = await artEvents(
        await app.request("/api/creator/art", postJson({ ...artRequest, reasoning })),
      );
      expect(all.at(-1)).toEqual({ type: "done" });
    }
    const [xhigh, max, unset] = upstream.records.map((record) => record.body);
    expect(xhigh).toMatchObject({ reasoning_effort: "xhigh" });
    expect(max).toMatchObject({ reasoning_effort: "max" });
    expect(unset).not.toHaveProperty("reasoning_effort");
  });

  it("narrows the image prompt's effort to what the model offers, and keys the call", async () => {
    const { app, upstream } = setup({
      upstream: { chunks: [IMAGE_PROMPT], catalog: offering("low") },
    });
    for (const reasoning of ["low", "xhigh"] as const) {
      const all = await artEvents(
        await app.request("/api/creator/art", postJson({ ...artRequest, reasoning })),
      );
      expect(all.at(-1)).toEqual({ type: "done" });
    }
    const [low, xhigh] = upstream.records.map((record) => record.body);
    expect(low).toMatchObject({ reasoning_effort: "low" });
    expect(xhigh).not.toHaveProperty("reasoning_effort");
    const [one, two] = cacheKeys(upstream);
    expect(one).toEqual(expect.any(String));
    expect(two).not.toBe(one);
  });

  it("says upstream_busy when the image prompt's provider stays busy, and never reaches ComfyUI", async () => {
    const { app, comfy, upstream } = setup({ upstream: stillBusy(429) });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all).toEqual([
      { type: "progress", phase: "prompt", value: 0, max: 1 },
      { type: "error", code: "upstream_busy", retryAfterS: 0 },
    ]);
    expect(upstream.records).toHaveLength(3);
    expect(comfy.state.requests).toEqual([]);
  });

  it("reads reasoning written into the answer out of the image prompt", async () => {
    const REASONING = "canary-art-reasoning-7b1d";
    const { app, comfy } = setup({
      upstream: { chunks: [`<think>${REASONING}</think>\n`, IMAGE_PROMPT] },
    });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all.at(-1)).toEqual({ type: "done" });
    const [graph] = [...comfy.state.prompts.values()] as { "4"?: { inputs: { text: string } } }[];
    expect(graph?.["4"]?.inputs.text).toBe(IMAGE_PROMPT);
  });

  it("answers not_configured without any outbound call when no address is saved", async () => {
    const { app, upstream, comfy } = setup({ address: "", upstream: { chunks: [IMAGE_PROMPT] } });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all).toEqual([{ type: "error", code: "not_configured" }]);
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
  });

  it("reports a ComfyUI failure after a successful prompt call, with nothing left behind", async () => {
    const { app, lines, comfy } = setup({
      upstream: { chunks: [IMAGE_PROMPT] },
      comfy: { executionError: true },
    });
    const response = await app.request("/api/creator/art", postJson(artRequest));
    const body = await response.clone().text();
    const all = await artEvents(response);
    expect(all.slice(0, 2).map((event) => event.type)).toEqual(["progress", "progress"]);
    expect(all.at(-1)).toEqual({ type: "error", code: "comfyui" });
    expect(all.some((event) => event.type === "image")).toBe(false);
    expect(body).not.toContain(UPSTREAM_SECRET);
    expect(lines.some((line) => line.includes('"errorClass":"execution"'))).toBe(true);
    await until(() => comfy.clean());
    expectContentFree(lines);
  });

  it("reports an upstream failure of the prompt call and never reaches ComfyUI", async () => {
    const { app, lines, comfy } = setup({
      upstream: {
        failWith: { status: 400, body: JSON.stringify({ error: { message: UPSTREAM_TEXT } }) },
      },
    });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all).toEqual([
      { type: "progress", phase: "prompt", value: 0, max: 1 },
      { type: "error", code: "upstream" },
    ]);
    expect(comfy.state.requests).toEqual([]);
    expectContentFree(lines, [UPSTREAM_TEXT]);
  });

  it("stops the ComfyUI run when the client disconnects, and logs it as ended, not failed", async () => {
    const { app, comfy, lines } = setup({
      upstream: { chunks: [IMAGE_PROMPT] },
      comfy: { hang: true },
    });
    const client = new AbortController();
    const response = await app.request(
      "/api/creator/art",
      postJson(artRequest, { signal: client.signal }),
    );
    const reader = response.body?.getReader();
    await until(() => comfy.state.running !== undefined);
    client.abort();
    // A stalled reader's stream is errored at once by the aborted deadline (keepalive.ts).
    await reader?.cancel().catch(() => {});
    await until(() => comfy.state.interrupted.length === 1 && comfy.clean());
    await until(() => lines.some((line) => line.includes('"event":"creator.art.abort"')));
    expect(lines.filter((line) => line.includes('"level":"error"'))).toEqual([]);
  });
});

/** The fake model's catalog entry with the input kinds it reports. */
const withModalities = (input_modalities: unknown): CatalogEntry[] => [
  { ...catalogEntry("fake-model"), input_modalities },
];

describe("POST /api/creator/art with a reference portrait", () => {
  async function referenceSetup(options: Setup & { stored?: boolean } = {}) {
    const context = setup({
      ...options,
      upstream: {
        chunks: [IMAGE_PROMPT],
        catalog: withModalities(["text", "image"]),
        ...options.upstream,
      },
    });
    const characterId = context.stores.characters.create(blankCard("Ada Reed"));
    const stored = await toPortrait(fakePng(200, 300));
    if (options.stored ?? true) context.stores.characters.setPortrait(characterId, stored);
    return { ...context, characterId, stored };
  }
  const referenceRequest = (characterId: string) => ({ ...artRequest, reference: { characterId } });

  type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
  /** The user message as it went upstream: a string, or parts with the portrait. */
  const userContent = (record: { body: unknown } | undefined): Part[] | string => {
    const sent = record?.body as { messages: { role: string; content: Part[] | string }[] };
    expect(sent.messages[0]).toEqual({ role: "system", content: ART_METAPROMPTS.krea2.subject });
    const user = sent.messages.at(-1);
    expect(user?.role).toBe("user");
    return user?.content ?? [];
  };
  const imageUrl = (parts: Part[] | string): string => {
    if (typeof parts === "string") throw new Error("expected an array of parts");
    return parts[0]?.type === "image_url" ? parts[0].image_url.url : "";
  };

  it("shows the stored portrait's vision copy to a model that reads images, with the reference note", async () => {
    const { app, lines, upstream, comfy, stores, characterId, stored } = await referenceSetup();
    const all = await artEvents(
      await app.request("/api/creator/art", postJson(referenceRequest(characterId))),
    );
    expect(all.at(-1)).toEqual({ type: "done" });
    const parts = userContent(upstream.records[0]);
    expect(parts).toHaveLength(2);
    const url = imageUrl(parts);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    const base64 = url.slice("data:image/jpeg;base64,".length);
    const meta = await imageMetadata(Buffer.from(base64, "base64"));
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(IMAGE_LIMITS.vision.width);
    expect(meta.height).toBeLessThanOrEqual(IMAGE_LIMITS.vision.height);
    expect(parts[1]).toEqual({ type: "text", text: artPrompt(SOURCE, null, true) });
    const kept = (await stores.characters.portrait(characterId, "full"))?.bytes ?? new Uint8Array();
    expect(Buffer.from(kept).equals(stored.png)).toBe(true);
    const end = lines.find((line) => line.includes('"event":"creator.art.end"'));
    expect(JSON.parse(end ?? "{}")).toMatchObject({ reference: true });
    await until(() => comfy.clean());
    expectContentFree(lines, [base64, characterId]);
  });

  it("attaches the portrait when the catalog does not say whether the model reads images", async () => {
    const { app, upstream, characterId } = await referenceSetup({
      upstream: { catalog: [catalogEntry("fake-model")] },
    });
    const all = await artEvents(
      await app.request("/api/creator/art", postJson(referenceRequest(characterId))),
    );
    expect(all.at(-1)).toEqual({ type: "done" });
    expect(imageUrl(userContent(upstream.records[0]))).toMatch(/^data:image\/jpeg;base64,/);
  });

  it.each([
    [
      "the portrait was removed since",
      { stored: false, catalog: withModalities(["text", "image"]) },
    ],
    ["the model reads text only", { stored: true, catalog: withModalities(["text"]) }],
  ])("paints from the notes alone when %s", async (_, { stored, catalog }) => {
    const { app, lines, upstream, characterId } = await referenceSetup({
      stored,
      upstream: { catalog },
    });
    const all = await artEvents(
      await app.request("/api/creator/art", postJson(referenceRequest(characterId))),
    );
    expect(all.at(-1)).toEqual({ type: "done" });
    expect(userContent(upstream.records[0])).toBe(artPrompt(SOURCE, null));
    const end = lines.find((line) => line.includes('"event":"creator.art.end"'));
    expect(JSON.parse(end ?? "{}")).toMatchObject({ reference: false });
  });

  it.each([
    ["an unknown character", async () => crypto.randomUUID()],
    [
      "another user's character",
      async (instances: ReturnType<typeof setup>["instances"]) =>
        instances
          .instance(usernameSchema.parse("someone-else"))
          .stores.characters.create(blankCard("Bo")),
    ],
  ])("answers not_found for %s before any outbound call", async (_, idOf) => {
    const { app, lines, upstream, comfy, instances } = await referenceSetup();
    const characterId = await idOf(instances);
    const all = await artEvents(
      await app.request("/api/creator/art", postJson(referenceRequest(characterId))),
    );
    expect(all).toEqual([{ type: "error", code: "not_found" }]);
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
    const warn = lines.find((line) => line.includes('"errorClass":"CharacterNotFound"'));
    expect(JSON.parse(warn ?? "{}")).toMatchObject({ level: "warn", event: "creator.art.error" });
    expectContentFree(lines, [characterId]);
  });

  it("answers reference when the stored portrait cannot be prepared, logging its class only", async () => {
    const { app, lines, upstream, comfy, stores, characterId, stored } = await referenceSetup();
    // A PNG signature over bytes no decoder reads: the store takes it, the conversion fails.
    const unreadable = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    stores.characters.setPortrait(characterId, { ...stored, png: unreadable });
    const all = await artEvents(
      await app.request("/api/creator/art", postJson(referenceRequest(characterId))),
    );
    expect(all).toEqual([{ type: "error", code: "reference" }]);
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
    const failure = lines.filter((line) => line.includes('"event":"creator.art.error"'));
    expect(failure).toHaveLength(1);
    expect(Object.keys(JSON.parse(failure[0] ?? "{}")).sort()).toEqual(
      ["errorClass", "event", "level", "model", "time"].sort(),
    );
    expectContentFree(lines, [characterId]);
  });

  it("ends as stopped when the client leaves while the portrait is prepared", async () => {
    const { app, lines, upstream, comfy, characterId } = await referenceSetup();
    let release = () => {};
    let asked = false;
    const answer = upstream.fetch;
    // The catalog answers only once the test lets it: the client leaves first.
    vi.spyOn(upstream, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/models")) return answer(input, init);
      asked = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return answer(input, init);
    });
    const client = new AbortController();
    const response = await app.request(
      "/api/creator/art",
      postJson(referenceRequest(characterId), { signal: client.signal }),
    );
    const reader = response.body?.getReader();
    await until(() => asked);
    client.abort();
    await reader?.cancel().catch(() => {});
    await until(() => lines.some((line) => line.includes('"event":"creator.art.abort"')));
    release();
    const abort = lines.find((line) => line.includes('"event":"creator.art.abort"'));
    expect(JSON.parse(abort ?? "{}")).toMatchObject({ reference: false });
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
    expect(lines.filter((line) => line.includes('"level":"error"'))).toEqual([]);
  });
});

describe("the art's workflow", () => {
  it("paints with the workflow the request names, or the saved one when it names none", async () => {
    for (const [workflow, unet] of [
      ["krea2-fixture", "krea2-fixture-unet.safetensors"],
      [undefined, "gonzalomo_krea2_v4_int8_convrot.safetensors"],
    ] as const) {
      const { app, comfy, stores } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
      stores.settings.update({ comfyuiWorkflow: "krea2-gonzalomo" });
      const sent = await app.request("/api/creator/art", postJson({ ...artRequest, workflow }));
      expect((await artEvents(sent)).at(-1)).toEqual({ type: "done" });
      const graphs = [...comfy.state.prompts.values()] as WorkflowGraph[];
      expect(graphs.map((graph) => graph["1"]?.inputs.unet_name)).toEqual([unet]);
    }
  });

  it("refuses a named workflow without a graph instead of painting another, calling no one", async () => {
    const { app, upstream, comfy } = setup({ upstream: { chunks: [IMAGE_PROMPT] } });
    const body = { ...artRequest, workflow: "krea2-removed" };
    const response = await app.request("/api/creator/art", postJson(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
  });
});

describe("GET /api/creator/art/status", () => {
  const status = async (app: ReturnType<typeof setup>["app"], workflow?: string) => {
    const query = workflow === undefined ? "" : `?workflow=${workflow}`;
    const response = await app.request(`/api/creator/art/status${query}`, {
      headers: ownerHeaders(),
    });
    expect(response.status).toBe(200);
    return creatorArtStatusSchema.parse(await response.json());
  };

  it("is off without a saved address", async () => {
    const { app, comfy } = setup({ address: "" });
    expect(await status(app)).toEqual({ state: "off" });
    expect(comfy.state.requests).toEqual([]);
  });

  it("refuses an address saved before its origin stopped being allowed, sending nothing", async () => {
    const { app, upstream, comfy } = setup({
      address: "https://retired.test:8188",
      upstream: { chunks: [IMAGE_PROMPT] },
    });
    expect(await status(app)).toEqual({ state: "unavailable", reason: "not_allowed" });
    const all = await artEvents(await app.request("/api/creator/art", postJson(artRequest)));
    expect(all).toEqual([{ type: "error", code: "not_allowed" }]);
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
    expect(comfy.state.sockets).toEqual([]);
  });

  it("is ready when the workflow's nodes and models are installed", async () => {
    expect(await status(setup().app)).toEqual({ state: "ready" });
  });

  it("lists missing nodes and models by name", async () => {
    const { app } = setup({
      comfy: {
        missingNodes: ["ModelAttentionBackend"],
        missingModels: ["qwen_image_vae.safetensors"],
      },
    });
    expect(await status(app)).toEqual({
      state: "missing",
      nodes: ["ModelAttentionBackend"],
      models: ["qwen_image_vae.safetensors"],
    });
  });

  it("reports a MOSS workflow ready only when its LoRA is installed, without submitting a prompt", async () => {
    const workflow = "moss-fixture";
    const installed = setup({ comfy: { installedWorkflow: workflow } });
    expect(await status(installed.app, workflow)).toEqual({ state: "ready" });
    const { app, comfy } = setup({
      comfy: {
        installedWorkflow: workflow,
        missingModels: ["moss-fixture-lora.safetensors"],
      },
    });
    expect(await status(app, workflow)).toEqual({
      state: "missing",
      nodes: [],
      models: ["moss-fixture-lora.safetensors"],
    });
    expect(comfy.state.sockets).toEqual([]);
    expect(comfy.state.prompts.size).toBe(0);
  });

  it("checks the workflow named, or the saved one, and refuses one without a graph", async () => {
    const { app, stores, comfy } = setup();
    // The fake holds only the default workflow's model files.
    const other = {
      state: "missing",
      nodes: [],
      models: [
        "krea2-fixture-unet.safetensors",
        "fixture-text-encoder.safetensors",
        "fixture-vae.safetensors",
      ],
    };
    expect(await status(app, "krea2-fixture")).toEqual(other);
    stores.settings.update({ comfyuiWorkflow: "krea2-fixture" });
    expect(await status(app)).toEqual(other);
    const asked = comfy.state.requests.length;
    for (const workflow of ["krea2-removed", "../x"]) {
      const refused = await app.request(`/api/creator/art/status?workflow=${workflow}`, {
        headers: ownerHeaders(),
      });
      expect(refused.status).toBe(400);
    }
    expect(comfy.state.requests).toHaveLength(asked);
    // A saved choice whose file is gone reads, and is checked, as the default.
    stores.settings.update({ comfyuiWorkflow: "krea2-removed" });
    expect(await status(app)).toEqual({ state: "ready" });
    const saved = await app.request("/api/settings", { headers: ownerHeaders() });
    expect(await saved.json()).toMatchObject({
      settings: { comfyuiWorkflow: "krea2-gonzalomo" },
    });
  });

  it("is unavailable with a content-free reason", async () => {
    expect(await status(setup({ comfy: { down: true } }).app)).toEqual({
      state: "unavailable",
      reason: "unreachable",
    });
    expect(await status(setup({ comfy: { token: "needed" } }).app)).toEqual({
      state: "unavailable",
      reason: "unauthorized",
    });
  });

  it("says a token would go over plain http instead of calling ComfyUI unreachable", async () => {
    const comfy = fakeComfyui();
    const withToken = testApp(
      { fetch: comfy.fetch, comfyuiSocket: comfy.socket },
      { comfyuiApiKey: "placeholder-token" },
    );
    withToken.instances
      .instance(TEST_USER)
      .stores.settings.update({ comfyuiBaseUrl: "http://comfy.test:8188" });
    expect(await status(withToken.app)).toEqual({ state: "unavailable", reason: "insecure" });
    expect(comfy.state.requests).toEqual([]);
  });
});

describe("GET /api/creator/art/workflows", () => {
  it("lists every workflow the server has by id and name, calling no one", async () => {
    const { app, comfy } = setup();
    const response = await app.request("/api/creator/art/workflows", { headers: ownerHeaders() });
    expect(response.status).toBe(200);
    const { workflows } = creatorArtWorkflowsSchema.parse(await response.json());
    expect(workflows).toEqual(TEST_WORKFLOWS.list.workflows);
    expect(workflows).toContainEqual({ id: "krea2-fixture", name: "Krea 2 Fixture" });
    expect(workflows).toContainEqual({ id: "krea2-gonzalomo", name: "Krea 2 Gonzalomo" });
    expect(comfy.state.requests).toEqual([]);
  });
});

describe("POST /api/creator/rework", () => {
  const REQUEST = "canary-rework-request-3f9c make her older";
  const FIELD = "canary-rework-field-a71d Ada keeps the lighthouse.";
  const REWORK_ANSWER = [
    "<change>",
    "<field>description</field>",
    "<why>Older.</why>",
    "<find>Ada keeps the lighthouse.</find>",
    "<replace>Ada, now sixty, keeps the lighthouse.</replace>",
    "</change>",
    "<summary>Made her older.</summary>",
  ].join("\n");
  const reworkCard: ReworkCard = {
    name: "Ada Reed",
    description: FIELD,
    personality: "",
    scenario: "",
    firstMessage: "Ada looks up.",
    alternateGreetings: [],
    exampleDialogue: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    creatorNotes: "",
    tags: ["drama"],
    characterNote: null,
    lorebook: null,
  };
  /** A PNG header and a WebP header: what the portrait schema checks. */
  const portrait = {
    png: new Uint8Array(fakePng(20, 30)),
    thumb: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
    width: 20,
    height: 30,
  };
  function reworkSetup(options: Setup & { portrait?: boolean } = {}) {
    const context = setup(options);
    const characterId = context.stores.characters.create(blankCard("Ada Reed"));
    if (options.portrait) context.stores.characters.setPortrait(characterId, portrait);
    return { ...context, characterId };
  }
  const reworkRequest = (characterId: string, extra: Record<string, unknown> = {}) => ({
    characterId,
    model: "fake-model",
    request: REQUEST,
    portrait: false,
    card: reworkCard,
    ...extra,
  });
  const reworkEvents = (response: Response): Promise<ReworkEvent[]> =>
    events(response, (value) => reworkEventSchema.parse(value));
  const reworkText = (all: ReworkEvent[]) =>
    all.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
  const drafts = [REQUEST, FIELD];

  type Part =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: string };
  /*
   * The user message as it went upstream. @ai-sdk/openai-compatible 3.0.57
   * sends a message holding one text part as a plain string, and a message
   * with the portrait as an array of parts.
   */
  const userContent = (record: { body: unknown } | undefined): Part[] | string => {
    const sent = record?.body as { messages: { role: string; content: Part[] | string }[] };
    const user = sent.messages.at(-1);
    expect(user?.role).toBe("user");
    return user?.content ?? [];
  };
  /** The text sent without a portrait: the user content as one string. */
  const textOnly = (record: { body: unknown } | undefined): string => {
    const content = userContent(record);
    if (typeof content !== "string") throw new Error("expected text-only user content");
    return content;
  };

  it("streams the answer and ends with a result; the model gets the system prompt and the card", async () => {
    const { app, lines, upstream, characterId } = reworkSetup({
      upstream: { chunks: pieces(REWORK_ANSWER, 17) },
    });
    const response = await app.request("/api/creator/rework", postJson(reworkRequest(characterId)));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const all = await reworkEvents(response);
    expect(reworkText(all)).toBe(REWORK_ANSWER);
    expect(all.slice(0, -1).every((event) => event.type === "delta")).toBe(true);
    expect(all.at(-1)).toEqual({ type: "result", problems: [] });

    expect(upstream.records).toHaveLength(1);
    const sent = upstream.records[0]?.body as {
      messages: { role: string; content: unknown }[];
      max_tokens?: number;
    };
    expect(sent.max_tokens).toBe(CREATOR_LIMITS.maxOutputTokens);
    expect(sent.messages[0]).toEqual({ role: "system", content: REWORK_SYSTEM_PROMPT });
    const text = textOnly(upstream.records[0]);
    expect(text).toContain(REQUEST);
    expect(text).toContain(FIELD);
    expectContentFree(lines, drafts);
  });

  it("sends the chosen reasoning effort upstream, and none for the model default", async () => {
    const { app, upstream, characterId } = reworkSetup({ upstream: { chunks: [REWORK_ANSWER] } });
    for (const reasoning of ["high", "provider-default"] as const) {
      await reworkEvents(
        await app.request(
          "/api/creator/rework",
          postJson(reworkRequest(characterId, { reasoning })),
        ),
      );
    }
    await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    const [high, unset, absent] = upstream.records.map((record) => record.body);
    expect(high).toMatchObject({ reasoning_effort: "high" });
    expect(unset).not.toHaveProperty("reasoning_effort");
    expect(absent).not.toHaveProperty("reasoning_effort");
  });

  it("narrows the effort to what the model offers, and keys each request's call", async () => {
    const { app, upstream, characterId } = reworkSetup({
      upstream: { chunks: [REWORK_ANSWER], catalog: offering("high") },
    });
    for (const reasoning of ["high", "max"] as const) {
      await reworkEvents(
        await app.request(
          "/api/creator/rework",
          postJson(reworkRequest(characterId, { reasoning })),
        ),
      );
    }
    const [high, max] = upstream.records.map((record) => record.body);
    expect(high).toMatchObject({ reasoning_effort: "high" });
    expect(max).not.toHaveProperty("reasoning_effort");
    const [one, two] = cacheKeys(upstream);
    expect(one).toEqual(expect.any(String));
    expect(two).not.toBe(one);
  });

  it("says upstream_busy when the provider stays busy through the retries", async () => {
    const { app, upstream, characterId } = reworkSetup({ upstream: stillBusy(503) });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    expect(all).toEqual([{ type: "error", code: "upstream_busy", retryAfterS: 0 }]);
    expect(upstream.records).toHaveLength(3);
  });

  it("reports an answer cut off inside a change and without a summary", async () => {
    const cut = REWORK_ANSWER.slice(0, REWORK_ANSWER.indexOf("</change>"));
    const { app, characterId } = reworkSetup({ upstream: { chunks: [cut] } });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    expect(all.at(-1)).toEqual({ type: "result", problems: ["incomplete", "no_summary"] });
  });

  it("ends at once on an in-stream error, aborting the upstream call", async () => {
    const { app, lines, upstream, characterId } = reworkSetup({
      upstream: { chunks: ["<change>"], streamError: `${UPSTREAM_TEXT} ${REQUEST}` },
    });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    expect(all).toEqual([
      { type: "delta", text: "<change>" },
      { type: "error", code: "upstream" },
    ]);
    await until(() => upstream.records[0]?.aborted === true);
    expect(upstream.records[0]?.completed).toBe(false);
    expectContentFree(lines, [UPSTREAM_TEXT, ...drafts]);
  });

  it("logs a run that throws unexpectedly by class, with none of the draft", async () => {
    const { app, lines, upstream, stores, characterId } = reworkSetup();
    vi.spyOn(stores.characters, "exists").mockImplementation(() => {
      throw new Error(`store fault ${REQUEST}`);
    });
    const response = await app.request("/api/creator/rework", postJson(reworkRequest(characterId)));
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(upstream.records).toEqual([]);
    const failure = lines.filter((line) => line.includes('"event":"creator.rework.error"'));
    expect(failure).toHaveLength(1);
    expect(JSON.parse(failure[0] ?? "{}")).toMatchObject({ level: "error", errorClass: "Error" });
    expectContentFree(lines, [...drafts, "store fault"]);
  });

  it("reports an answer the output ceiling cut between two change blocks as incomplete", async () => {
    const between = REWORK_ANSWER.slice(0, REWORK_ANSWER.indexOf("<summary>"));
    const { app, characterId } = reworkSetup({
      upstream: { chunks: [between], finishReason: "length" },
    });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    expect(reworkText(all)).toBe(between);
    expect(all.at(-1)).toEqual({ type: "result", problems: ["incomplete", "no_summary"] });
  });

  /*
   * The route sends AI SDK 7's `{ type: "file", data, mediaType: "image/jpeg" }`;
   * @ai-sdk/openai-compatible 3.0.57 writes it as an `image_url` part holding a
   * base64 data URL (convertToOpenAICompatibleChatMessages).
   */
  it("shows the stored portrait's vision copy to a model that reads images, before the text", async () => {
    const { app, lines, upstream, stores, characterId } = reworkSetup({
      upstream: { chunks: [REWORK_ANSWER], catalog: withModalities(["text", "image"]) },
    });
    // A full-size noise portrait: as a PNG data URL it passes a 4.5 MB request body limit.
    const stored = await toPortrait(pngWithNoise(1024, 1536, 1536));
    stores.characters.setPortrait(characterId, stored);
    const all = await reworkEvents(
      await app.request(
        "/api/creator/rework",
        postJson(reworkRequest(characterId, { portrait: true })),
      ),
    );
    expect(all.at(-1)).toEqual({ type: "result", problems: [] });
    const parts = userContent(upstream.records[0]);
    if (typeof parts === "string") throw new Error("expected an array of parts");
    expect(parts).toHaveLength(2);
    const image = parts[0];
    const url = image?.type === "image_url" && "image_url" in image ? image.image_url.url : "";
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    const base64 = url.slice("data:image/jpeg;base64,".length);
    const sent = Buffer.from(base64, "base64");
    expect(sent.byteLength).toBeLessThan(IMAGE_LIMITS.vision.worstCaseBytes);
    const meta = await imageMetadata(sent);
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 683, 1024]);
    // The stored portrait is unchanged.
    const kept = (await stores.characters.portrait(characterId, "full"))?.bytes ?? new Uint8Array();
    expect(Buffer.from(kept).equals(stored.png)).toBe(true);
    expect(parts[1]).toMatchObject({ type: "text" });
    const text = parts[1] !== undefined && "text" in parts[1] ? parts[1].text : "";
    expect(text).toContain("The portrait is attached.");
    expectContentFree(lines, [...drafts, base64]);
  });

  it.each([
    ["the model reads text only", { catalog: withModalities(["text"]), stored: true, on: true }],
    [
      "no portrait is stored",
      { catalog: withModalities(["text", "image"]), stored: false, on: true },
    ],
    [
      "the owner left it off",
      { catalog: withModalities(["text", "image"]), stored: true, on: false },
    ],
  ])("sends no image part when %s", async (_, { catalog, stored, on }) => {
    const { app, upstream, characterId } = reworkSetup({
      upstream: { chunks: [REWORK_ANSWER], catalog },
      portrait: stored,
    });
    const all = await reworkEvents(
      await app.request(
        "/api/creator/rework",
        postJson(reworkRequest(characterId, { portrait: on })),
      ),
    );
    expect(all.at(-1)).toEqual({ type: "result", problems: [] });
    const text = textOnly(upstream.records[0]);
    expect(text).toContain(REQUEST);
    expect(text).not.toContain("The portrait is attached.");
  });

  it("writes for the chosen persona and logs none of it; a deleted persona leaves it out", async () => {
    const { app, lines, upstream, stores, characterId } = reworkSetup({
      upstream: { chunks: [REWORK_ANSWER] },
    });
    const persona = {
      name: "Kai Moss",
      description: "canary-rework-persona-0c4e a placeholder sailor",
    };
    const personaId = crypto.randomUUID();
    stores.personas.create(persona, personaId);
    await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId, { personaId }))),
    );
    await reworkEvents(
      await app.request(
        "/api/creator/rework",
        postJson(reworkRequest(characterId, { personaId: crypto.randomUUID() })),
      ),
    );
    const textOf = (index: number) => textOnly(upstream.records[index]);
    expect(textOf(0)).toContain(persona.name);
    expect(textOf(0)).toContain(persona.description);
    expect(textOf(1)).not.toContain("<persona>");
    expectContentFree(lines, [...drafts, persona.description]);
  });

  it("refuses a request that cannot fit the window before any upstream call", async () => {
    const { app, lines, upstream, characterId } = reworkSetup({
      upstream: {
        chunks: [REWORK_ANSWER],
        catalog: [{ ...catalogEntry("fake-model"), context_window: 64 }],
      },
    });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    expect(all).toEqual([{ type: "error", code: "too_large" }]);
    expect(upstream.records).toEqual([]);
    expect(lines.some((line) => line.includes('"errorClass":"PromptTooLarge"'))).toBe(true);
    expectContentFree(lines, drafts);
  });

  it("refuses a model without a context window", async () => {
    const { app, lines, upstream, characterId } = reworkSetup({
      upstream: { chunks: [REWORK_ANSWER], catalog: [{ slug: "fake-model" }] },
    });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    expect(all).toEqual([{ type: "error", code: "context_window_unknown" }]);
    expect(upstream.records).toEqual([]);
    expectContentFree(lines, drafts);
  });

  it("answers not_found for a character that is gone", async () => {
    const { app, upstream } = reworkSetup({ upstream: { chunks: [REWORK_ANSWER] } });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(crypto.randomUUID()))),
    );
    expect(all).toEqual([{ type: "error", code: "not_found" }]);
    expect(upstream.records).toEqual([]);
  });

  it("turns an upstream error that echoes the request into one content-free error event", async () => {
    const consoleSpies = muteConsole();
    const { app, lines, upstream, characterId } = reworkSetup({
      upstream: {
        failWith: {
          status: 400,
          body: JSON.stringify({ error: { message: `bad ${UPSTREAM_TEXT} ${REQUEST} ${FIELD}` } }),
        },
      },
    });
    const response = await app.request("/api/creator/rework", postJson(reworkRequest(characterId)));
    const body = await response.clone().text();
    expect(await reworkEvents(response)).toEqual([{ type: "error", code: "upstream" }]);
    for (const draft of [UPSTREAM_TEXT, ...drafts]) expect(body).not.toContain(draft);
    expect(upstream.records).toHaveLength(1);
    expect(lines.some((line) => line.includes('"event":"creator.rework.error"'))).toBe(true);
    expectContentFree(lines, [UPSTREAM_TEXT, ...drafts]);
    for (const spy of consoleSpies) {
      for (const draft of [UPSTREAM_TEXT, ...drafts]) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(draft);
      }
    }
  });

  it("stops the upstream call when the client disconnects mid-stream", async () => {
    const { app, upstream, characterId } = reworkSetup({
      upstream: { chunks: Array.from({ length: 50 }, () => "x"), delayMs: 20 },
    });
    const client = new AbortController();
    const response = await app.request(
      "/api/creator/rework",
      postJson(reworkRequest(characterId), { signal: client.signal }),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    client.abort();
    await until(() => upstream.records[0]?.aborted === true);
    expect(upstream.records[0]?.completed).toBe(false);
  });

  it("ends an answer that outlives the request lifetime with a timeout error", async () => {
    const { app, upstream, characterId } = reworkSetup({
      upstream: { chunks: ["<change>"], hang: true },
      requestTimeoutMs: 150,
    });
    const all = await reworkEvents(
      await app.request("/api/creator/rework", postJson(reworkRequest(characterId))),
    );
    expect(all).toEqual([
      { type: "delta", text: "<change>" },
      { type: "error", code: "timeout" },
    ]);
    expect(upstream.records[0]?.aborted).toBe(true);
  });

  it("writes blank keepalive lines while the model is silent, and the events are unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const silentMs = 2 * KEEPALIVE_INTERVAL_MS + 5_000;
      const { app, characterId } = reworkSetup({
        upstream: { reasoning: ["thinking"], chunks: [REWORK_ANSWER], delayMs: silentMs },
        requestTimeoutMs: 10 * silentMs,
      });
      const response = await app.request(
        "/api/creator/rework",
        postJson(reworkRequest(characterId)),
      );
      const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
      if (reader === undefined) throw new Error("no body");
      let body = "";
      const reading = (async () => {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          body += chunk.value;
        }
      })();
      await vi.advanceTimersByTimeAsync(3 * silentMs);
      await reading;

      expect(body.split("\n").filter((line) => line === "").length).toBeGreaterThanOrEqual(4);
      const all = body
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => reworkEventSchema.parse(JSON.parse(line)));
      expect(reworkText(all)).toBe(REWORK_ANSWER);
      expect(all.at(-1)).toEqual({ type: "result", problems: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["an unknown key", { extra: REQUEST }],
    ["an empty request", { request: "   " }],
    ["a non-UUID character id", { characterId: "ada" }],
  ])("rejects a body with %s without echoing it", async (_, extra) => {
    const { app, lines, upstream, characterId } = reworkSetup();
    const response = await app.request(
      "/api/creator/rework",
      postJson(reworkRequest(characterId, extra)),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(upstream.records).toEqual([]);
    expectContentFree(lines, drafts);
  });

  it("refuses a body over its cap with 413", async () => {
    const { app, upstream, characterId } = reworkSetup();
    const response = await app.request(
      "/api/creator/rework",
      postJson(
        reworkRequest(characterId, {
          card: { ...reworkCard, description: "x".repeat(MAX_REWORK_BODY_BYTES) },
        }),
      ),
    );
    expect(response.status).toBe(413);
    expect(upstream.records).toEqual([]);
  });
});

describe("creator request validation", () => {
  it.each([
    ["/api/creator/card", { kind: "villain", description: DESCRIPTION, model: "m" }],
    ["/api/creator/card", { kind: "subject", description: "   ", model: "m" }],
    [
      "/api/creator/card",
      {
        kind: "subject",
        description: "x".repeat(CREATOR_LIMITS.descriptionLength + 1),
        model: "m",
      },
    ],
    ["/api/creator/card", { ...cardRequest(), extra: DESCRIPTION }],
    ["/api/creator/art", { kind: "subject", model: "m", source: "" }],
    ["/api/creator/art", { kind: "subject", source: SOURCE }],
    ["/api/creator/art", { ...artRequest, workflow: "Krea 2" }],
  ])("rejects an invalid body for %s without echoing it", async (path, body) => {
    const { app, lines, upstream, comfy } = setup();
    const response = await app.request(path, postJson(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
    expectContentFree(lines);
  });

  it("applies the owner, origin and content-type guards", async () => {
    const { app, upstream } = setup();
    const body = JSON.stringify(cardRequest());
    const foreign = await app.request("/api/creator/card", {
      method: "POST",
      headers: ownerHeaders({ Origin: "https://elsewhere.test" }),
      body,
    });
    expect(foreign.status).toBe(403);
    const plain = await app.request("/api/creator/card", {
      method: "POST",
      headers: ownerHeaders({ "Content-Type": "text/plain" }),
      body,
    });
    expect(plain.status).toBe(415);
    const anonymous = await app.request("/api/creator/art/status");
    expect(anonymous.status).toBe(403);
    expect(upstream.records).toEqual([]);
  });
});

describe("POST /api/creator/card/from-image", () => {
  const ROUTE = "/api/creator/card/from-image";
  /** Valid to the validator, unusable for an automatic keep. */
  const NO_NOTES = SUBJECT_ANSWER.replace(
    "<creatorNotes>A placeholder pitch.</creatorNotes>",
    "<creatorNotes></creatorNotes>",
  );
  /** Invalid: the opening is gone. */
  const NO_OPENING = SUBJECT_ANSWER.replace("<firstMessage>Ada looks up.</firstMessage>\n", "");

  function imageSetup(options: Setup & { model?: string | null } = {}) {
    const context = setup(options);
    const model = options.model === undefined ? "fake-model" : options.model;
    context.stores.settings.update({ model });
    return context;
  }

  async function form(
    fields: {
      id?: string;
      kind?: string;
      notes?: string;
      direction?: string;
      file?: Uint8Array | Buffer;
    } = {},
  ): Promise<FormData> {
    const body = new FormData();
    body.set("id", fields.id ?? crypto.randomUUID());
    if (fields.kind !== undefined) body.set("kind", fields.kind);
    if (fields.notes !== undefined) body.set("notes", fields.notes);
    if (fields.direction !== undefined) body.set("direction", fields.direction);
    const bytes = fields.file ?? (await plainPng());
    body.set("file", new File([new Uint8Array(bytes)], "tile.png", { type: "image/png" }));
    return body;
  }

  const send = (body: RequestInit["body"], init: RequestInit = {}): RequestInit => ({
    method: "POST",
    headers: integrationHeaders(),
    body,
    ...init,
  });

  const imageEvents = (response: Response): Promise<CreatorImageCardEvent[]> =>
    events(response, (value) => creatorImageCardEventSchema.parse(value));

  const phases = (all: CreatorImageCardEvent[]) =>
    all.flatMap((event) => (event.type === "status" ? [event.phase] : []));

  type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
  const sentBody = (record: { body: unknown } | undefined) =>
    record?.body as {
      model: string;
      max_tokens?: number;
      messages: { role: string; content: string | Part[] }[];
    } & Record<string, unknown>;

  it("writes, saves and names the kept character, with the portrait re-encoded", async () => {
    const { app, lines, upstream, stores } = imageSetup({
      upstream: { chunks: pieces(SUBJECT_ANSWER) },
    });
    const id = crypto.randomUUID();
    const response = await app.request(
      ROUTE,
      send(await form({ id, notes: NOTES, file: await plainJpeg(2048, 3072) })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const all = await imageEvents(response);
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "status", phase: "saving" },
      { type: "result", id, name: "Ada Reed" },
    ]);
    expect(stores.characters.list().map((character) => character.id)).toEqual([id]);
    expect(stores.characters.get(id)?.card).toMatchObject({
      firstMessage: "Ada looks up.",
      alternateGreetings: [],
      scenario: "",
      tags: ["Subject"],
    });
    const stored = await stores.characters.portrait(id, "full");
    expect(stored).toBeDefined();
    const meta = await imageMetadata(stored?.bytes ?? new Uint8Array());
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1024, 1536]);
    expect(upstream.records).toHaveLength(1);
    expectContentFree(lines);
  });

  it("sends the saved model, the Subject prompt, the image and the notes, and no effort", async () => {
    const { app, lines, upstream } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    await imageEvents(await app.request(ROUTE, send(await form({ notes: `  ${NOTES}  ` }))));
    const sent = sentBody(upstream.records[0]);
    expect(sent.model).toBe("fake-model");
    expect(sent.max_tokens).toBe(CREATOR_LIMITS.maxOutputTokens);
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(sent.messages[0]).toEqual({ role: "system", content: CARD_SYSTEM_PROMPTS.subject });
    const parts = sent.messages[1]?.content;
    if (typeof parts === "string" || parts === undefined) throw new Error("expected parts");
    expect(parts.map((part) => part.type)).toEqual(["image_url", "text"]);
    const [image, text] = parts;
    expect(image?.type === "image_url" && image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(text?.type === "text" && text.text).toBe(imageCardPrompt("subject", NOTES, null));
    expectContentFree(lines);
  });

  it.each([
    ["group", GROUP_ANSWER, "Multiple Subjects"],
    ["scenario", SCENARIO_ANSWER, "Scenario"],
  ] as const)(
    "writes a %s card with its kind's prompt and saves it with its tag",
    async (kind, text, tag) => {
      const { app, lines, upstream, stores } = imageSetup({ upstream: { chunks: [text] } });
      const id = crypto.randomUUID();
      const all = await imageEvents(
        await app.request(ROUTE, send(await form({ id, kind, notes: NOTES }))),
      );
      expect(all.at(-1)).toEqual({ type: "result", id, name: "Ada Reed" });
      const sent = sentBody(upstream.records[0]);
      expect(sent.messages[0]).toEqual({ role: "system", content: CARD_SYSTEM_PROMPTS[kind] });
      const parts = sent.messages[1]?.content;
      if (typeof parts === "string" || parts === undefined) throw new Error("expected parts");
      expect(parts[1]).toEqual({ type: "text", text: imageCardPrompt(kind, NOTES, null) });
      expect(stores.characters.get(id)?.card.tags).toEqual([tag]);
      expectContentFree(lines);
    },
  );

  it("refuses an unknown kind before any image or model work", async () => {
    const { app, upstream, stores } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const response = await app.request(ROUTE, send(await form({ kind: "villain" })));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(upstream.records).toEqual([]);
    expect(stores.characters.list()).toEqual([]);
  });

  /** The text part of the first call's user turn. */
  const sentText = (record: { body: unknown } | undefined) => {
    const parts = sentBody(record).messages[1]?.content;
    if (typeof parts === "string" || parts === undefined) throw new Error("expected parts");
    const text = parts.find((part) => part.type === "text");
    return text?.type === "text" ? text.text : undefined;
  };

  it("sends the owner's direction, trimmed, after the notes", async () => {
    const { app, lines, upstream } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const all = await imageEvents(
      await app.request(
        ROUTE,
        send(await form({ notes: NOTES, direction: `  ${CARD_DIRECTION} \n` })),
      ),
    );
    expect(all.at(-1)).toMatchObject({ type: "result" });
    expect(sentText(upstream.records[0])).toBe(imageCardPrompt("subject", NOTES, CARD_DIRECTION));
    expectContentFree(lines);
  });

  it("ignores a blank direction and sends the notes alone", async () => {
    const { app, upstream } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    await imageEvents(
      await app.request(ROUTE, send(await form({ notes: NOTES, direction: " \n " }))),
    );
    expect(sentText(upstream.records[0])).toBe(imageCardPrompt("subject", NOTES, null));
  });

  it.each([
    ["notes", CREATOR_LIMITS.descriptionLength],
    ["direction", CREATOR_LIMITS.imageCardDirectionLength],
  ] as const)(
    "refuses %s over the bound before any model work, and takes them at it",
    async (field, bound) => {
      const { app, lines, upstream, stores } = imageSetup({
        upstream: { chunks: [SUBJECT_ANSWER] },
      });
      const longest = `${CARD_DIRECTION} ${"x".repeat(bound)}`.slice(0, bound);
      const fields = (value: string) =>
        field === "notes" ? { notes: value } : { direction: value };
      const over = await app.request(ROUTE, send(await form(fields(`${longest}x`))));
      expect(over.status).toBe(400);
      expect(await over.json()).toEqual({ error: "invalid_request" });
      expect(upstream.records).toEqual([]);
      expect(stores.characters.list()).toEqual([]);
      const at = await imageEvents(await app.request(ROUTE, send(await form(fields(longest)))));
      expect(at.at(-1)).toMatchObject({ type: "result" });
      expect(upstream.records).toHaveLength(1);
      expectContentFree(lines);
    },
  );

  it("sends the model a small JPEG of a full-size noise image and stores the PNG portrait", async () => {
    const { app, upstream, stores } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const id = crypto.randomUUID();
    const all = await imageEvents(
      await app.request(ROUTE, send(await form({ id, file: pngWithNoise(1024, 1536, 1536) }))),
    );
    expect(all.at(-1)).toMatchObject({ type: "result", id });
    const parts = sentBody(upstream.records[0]).messages[1]?.content;
    if (typeof parts === "string" || parts === undefined) throw new Error("expected parts");
    const image = parts[0];
    const url = image?.type === "image_url" ? image.image_url.url : "";
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    const sent = Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64");
    // A 1024 x 1536 PNG of this noise is about 5.4 MB, past a 4.5 MB upstream request body limit.
    expect(sent.byteLength).toBeLessThan(IMAGE_LIMITS.vision.worstCaseBytes);
    const meta = await imageMetadata(sent);
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 683, 1024]);
    const stored = await imageMetadata(
      (await stores.characters.portrait(id, "full"))?.bytes ?? new Uint8Array(),
    );
    expect([stored.format, stored.width, stored.height]).toEqual(["png", 1024, 1536]);
  });

  it("refuses without a saved model, before any model call", async () => {
    const { app, upstream, stores } = imageSetup({ model: null });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([{ type: "error", code: "no_model" }]);
    expect(upstream.records).toEqual([]);
    expect(stores.characters.list()).toEqual([]);
  });

  it("refuses a model the catalog says reads text only", async () => {
    const { app, upstream } = imageSetup({
      upstream: { chunks: [SUBJECT_ANSWER], catalog: withModalities(["text"]) },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([{ type: "error", code: "text_only_model" }]);
    expect(upstream.records).toEqual([]);
  });

  it("refuses a model without a context window", async () => {
    const { app, upstream } = imageSetup({
      upstream: { chunks: [SUBJECT_ANSWER], catalog: [{ slug: "fake-model" }] },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([{ type: "error", code: "context_window_unknown" }]);
    expect(upstream.records).toEqual([]);
  });

  it("refuses a card that cannot fit the window", async () => {
    const { app, lines, upstream } = imageSetup({
      upstream: {
        chunks: [SUBJECT_ANSWER],
        catalog: [{ ...catalogEntry("fake-model"), context_window: 2_048 }],
      },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form({ notes: NOTES }))));
    expect(all).toEqual([{ type: "error", code: "too_large" }]);
    expect(upstream.records).toEqual([]);
    expect(lines.some((line) => line.includes('"event":"creator.image_card.error"'))).toBe(true);
    expectContentFree(lines);
  });

  /** A call's turns after the system prompt and the image turn, which it checks. */
  const retryTurns = (record: { body: unknown } | undefined) => {
    const [system, user, ...rest] = sentBody(record).messages;
    expect(system).toEqual({ role: "system", content: CARD_SYSTEM_PROMPTS.subject });
    expect(user?.role).toBe("user");
    const parts = user?.content;
    if (typeof parts === "string" || parts === undefined) throw new Error("expected parts");
    expect(parts.map((part) => part.type)).toEqual(["image_url", "text"]);
    return rest;
  };

  it("rewrites once after an answer missing sections, with the answer and its problems, then keeps the card", async () => {
    const { app, lines, upstream, stores } = imageSetup({
      upstream: { turns: [{ chunks: [NO_OPENING] }, { chunks: [SUBJECT_ANSWER] }] },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(phases(all)).toEqual(["writing", "rewriting", "saving"]);
    expect(all.at(-1)).toMatchObject({ type: "result", name: "Ada Reed" });
    expect(upstream.records).toHaveLength(2);
    // The retry is core's, as the card route sends it: the rejected answer, then what it lacks.
    expect(retryTurns(upstream.records[1])).toEqual([
      { role: "assistant", content: NO_OPENING },
      { role: "user", content: cardRetryPrompt([{ code: "missing", section: "firstMessage" }]) },
    ]);
    expect(lines.some((line) => line.includes('"attempt":2'))).toBe(true);
    expect(stores.characters.list()).toHaveLength(1);
    expectContentFree(lines);
  });

  it("gives up with invalid_card after two answers missing sections", async () => {
    const { app, upstream, stores } = imageSetup({ upstream: { chunks: [NO_OPENING] } });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "status", phase: "rewriting" },
      { type: "error", code: "invalid_card" },
    ]);
    expect(upstream.records).toHaveLength(2);
    expect(stores.characters.list()).toEqual([]);
  });

  it.each<[string, FakeTurn, "upstream" | "invalid_card"]>([
    [
      "fails",
      { failWith: { status: 400, body: JSON.stringify({ error: { message: UPSTREAM_TEXT } }) } },
      "upstream",
    ],
    ["is cut", { chunks: [SUBJECT_ANSWER], finishReason: "length" }, "invalid_card"],
    ["is filtered", { chunks: [SUBJECT_ANSWER], finishReason: "content_filter" }, "upstream"],
    [
      "errors in stream",
      { chunks: [SUBJECT_ANSWER.slice(0, 40)], streamError: UPSTREAM_TEXT },
      "upstream",
    ],
  ])(
    "ends the rewrite that %s with %s, keeps nothing and frees the slot",
    async (_, second, code) => {
      const { app, lines, upstream, stores } = imageSetup({
        upstream: { turns: [{ chunks: [NO_OPENING] }, second] },
      });
      const all = await imageEvents(await app.request(ROUTE, send(await form({ notes: NOTES }))));
      expect(all).toEqual([
        { type: "status", phase: "writing" },
        { type: "status", phase: "rewriting" },
        { type: "error", code },
      ]);
      expect(upstream.records).toHaveLength(2);
      expect(stores.characters.list()).toEqual([]);
      expectContentFree(lines, [UPSTREAM_TEXT]);
      // Both slots are free again: two more requests are admitted at once.
      const again = await Promise.all([
        app.request(ROUTE, send(await form())),
        app.request(ROUTE, send(await form())),
      ]);
      expect(again.map((response) => response.status)).toEqual([200, 200]);
      await Promise.all(again.map((response) => response.text()));
    },
  );

  it("asks again from the start after an empty answer, sending no empty assistant turn", async () => {
    const { app, upstream, stores } = imageSetup({
      upstream: {
        turns: [{ chunks: ["<think>still weighing the portrait"] }, { chunks: [SUBJECT_ANSWER] }],
      },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(phases(all)).toEqual(["writing", "rewriting", "saving"]);
    expect(all.at(-1)).toMatchObject({ type: "result", name: "Ada Reed" });
    expect(upstream.records).toHaveLength(2);
    expect(retryTurns(upstream.records[1])).toEqual([]);
    expect(stores.characters.list()).toHaveLength(1);
  });

  it("treats a valid answer with empty creator notes as unusable, and names them in the retry", async () => {
    const { app, upstream, stores } = imageSetup({ upstream: { chunks: [NO_NOTES] } });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(phases(all)).toEqual(["writing", "rewriting"]);
    expect(all.at(-1)).toEqual({ type: "error", code: "invalid_card" });
    expect(upstream.records).toHaveLength(2);
    expect(retryTurns(upstream.records[1])).toEqual([
      { role: "assistant", content: NO_NOTES },
      { role: "user", content: cardRetryPrompt([], ["creatorNotes"]) },
    ]);
    expect(stores.characters.list()).toEqual([]);
  });

  it("skips the rewrite when the first answer sent back would not fit the window", async () => {
    // Room for the request and its answer's reserve: the first answer on top of it is past the window.
    const asked =
      helperInputTokens([CARD_SYSTEM_PROMPTS.subject, imageCardPrompt("subject", null, null)]) +
      REWORK_LIMITS.portraitTokens +
      MEMORY_LIMITS.replyReserve;
    const { app, lines, upstream, stores } = imageSetup({
      upstream: {
        chunks: [NO_OPENING],
        catalog: [{ ...catalogEntry("fake-model"), context_window: asked + 8 }],
      },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "error", code: "invalid_card" },
    ]);
    expect(upstream.records).toHaveLength(1);
    expect(stores.characters.list()).toEqual([]);
    expectContentFree(lines);
  });

  it("ends an answer the output ceiling cut as invalid_card, however complete it reads, without a rewrite", async () => {
    const { app, lines, upstream, stores } = imageSetup({
      upstream: { chunks: [SUBJECT_ANSWER], finishReason: "length" },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "error", code: "invalid_card" },
    ]);
    expect(upstream.records).toHaveLength(1);
    expect(stores.characters.list()).toEqual([]);
    expect(lines.some((line) => line.includes('"errorClass":"AnswerCut"'))).toBe(true);
    expect(lines.some((line) => line.includes('"finishReason":"length"'))).toBe(true);
    expectContentFree(lines);
  });

  it("ends a refusal by the content filter as upstream, without a second attempt", async () => {
    const { app, lines, upstream, stores } = imageSetup({
      upstream: { chunks: [SUBJECT_ANSWER], finishReason: "content_filter" },
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "error", code: "upstream" },
    ]);
    expect(upstream.records).toHaveLength(1);
    expect(stores.characters.list()).toEqual([]);
    expect(lines.some((line) => line.includes('"errorClass":"ContentFiltered"'))).toBe(true);
    expectContentFree(lines);
  });

  it("ends a failed save with one save_failed error, keeps nothing and frees the slot", async () => {
    const { app, lines, stores } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const create = vi.spyOn(stores.characters, "create").mockImplementation(() => {
      throw new Error(`disk full ${CARD_CANARY} ${NOTES} ${CARD_DIRECTION}`);
    });
    const id = crypto.randomUUID();
    const all = await imageEvents(
      await app.request(ROUTE, send(await form({ id, direction: CARD_DIRECTION }))),
    );
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "status", phase: "saving" },
      { type: "error", code: "save_failed" },
    ]);
    expect(stores.characters.list()).toEqual([]);
    const failure = lines.filter((line) => line.includes('"event":"creator.image_card.error"'));
    expect(failure).toHaveLength(1);
    expect(JSON.parse(failure[0] ?? "{}")).toMatchObject({ errorClass: "Error" });
    expectContentFree(lines, ["disk full"]);

    // Both slots are free again: two requests at once are admitted and run.
    create.mockRestore();
    const [first, second] = await Promise.all([
      app.request(ROUTE, send(await form())),
      app.request(ROUTE, send(await form())),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await imageEvents(first)).at(-1)).toMatchObject({ type: "result" });
    expect((await imageEvents(second)).at(-1)).toMatchObject({ type: "result" });
  });

  it("turns an upstream error into one content-free error, without a second attempt", async () => {
    const consoleSpies = muteConsole();
    const { app, lines, upstream, stores } = imageSetup({
      upstream: {
        failWith: {
          status: 400,
          body: JSON.stringify({
            error: { message: `bad ${UPSTREAM_TEXT} ${NOTES} ${CARD_DIRECTION}` },
          }),
        },
      },
    });
    const response = await app.request(
      ROUTE,
      send(await form({ notes: NOTES, direction: CARD_DIRECTION })),
    );
    const body = await response.clone().text();
    expect(await imageEvents(response)).toEqual([
      { type: "status", phase: "writing" },
      { type: "error", code: "upstream" },
    ]);
    expect(body).not.toContain(UPSTREAM_TEXT);
    expect(body).not.toContain(CARD_DIRECTION);
    expect(upstream.records).toHaveLength(1);
    expect(stores.characters.list()).toEqual([]);
    expect(lines.some((line) => line.includes('"status":400'))).toBe(true);
    expectContentFree(lines, [UPSTREAM_TEXT]);
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(UPSTREAM_TEXT);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(NOTES);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CARD_DIRECTION);
    }
  });

  it("says upstream_busy when the provider stays busy, keeping nothing", async () => {
    const { app, upstream, stores } = imageSetup({ upstream: stillBusy(429) });
    const all = await imageEvents(await app.request(ROUTE, send(await form({ notes: NOTES }))));
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "error", code: "upstream_busy", retryAfterS: 0 },
    ]);
    expect(upstream.records).toHaveLength(3);
    expect(stores.characters.list()).toEqual([]);
  });

  it("sends one cache key for both writes of a request", async () => {
    const { app, upstream } = imageSetup({
      upstream: { turns: [{ chunks: [NO_OPENING] }, { chunks: [SUBJECT_ANSWER] }] },
    });
    await imageEvents(await app.request(ROUTE, send(await form())));
    const [first, rewrite] = cacheKeys(upstream);
    expect(first).toEqual(expect.any(String));
    expect(rewrite).toBe(first);
  });

  it("ends a card that outlives the request lifetime with a timeout, after one call", async () => {
    const { app, upstream, stores } = imageSetup({
      upstream: { chunks: ["<name>Ada"], hang: true },
      requestTimeoutMs: 300,
    });
    const all = await imageEvents(await app.request(ROUTE, send(await form())));
    expect(all).toEqual([
      { type: "status", phase: "writing" },
      { type: "error", code: "timeout" },
    ]);
    expect(upstream.records).toHaveLength(1);
    expect(upstream.records[0]?.aborted).toBe(true);
    expect(stores.characters.list()).toEqual([]);
  });

  it("stops the model call when the client goes away first, and keeps nothing", async () => {
    const { app, upstream, stores } = imageSetup({ upstream: { hang: true } });
    const response = await app.request(ROUTE, send(await form()));
    const reader = response.body?.getReader();
    await reader?.read();
    await until(() => upstream.records.length === 1);
    await reader?.cancel();
    await until(() => upstream.records[0]?.aborted === true);
    expect(upstream.records[0]?.completed).toBe(false);
    expect(stores.characters.list()).toEqual([]);
  });

  it("keeps a character whose result the client left before reading", async () => {
    const { app, stores } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const id = crypto.randomUUID();
    const response = await app.request(ROUTE, send(await form({ id })));
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"saving"')) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    await reader?.cancel();
    expect(seen).not.toContain('"result"');
    expect(stores.characters.get(id)?.card.name).toBe("Ada Reed");
  });

  it("refuses a JSON body, a file that is not an image and a body over the cap", async () => {
    const { app, lines, upstream } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const json = await app.request(
      ROUTE,
      send(JSON.stringify({ id: crypto.randomUUID(), notes: NOTES }), {
        headers: integrationHeaders({ "Content-Type": "application/json" }),
      }),
    );
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ error: "invalid_request" });
    const page = await app.request(ROUTE, send(await form({ file: html })));
    expect(page.status).toBe(415);
    expect(await page.json()).toEqual({ error: "unsupported_media_type" });
    const huge = await app.request(
      ROUTE,
      send(await form({ file: new Uint8Array(CARD_LIMITS.uploadBytes + 128 * 1024) })),
    );
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: "payload_too_large" });
    expect(upstream.records).toEqual([]);
    expectContentFree(lines);
  });

  it("answers busy before reading a third request's body, and admits again once one ends", async () => {
    const { app, upstream } = imageSetup({ upstream: { hang: true } });
    const first = await app.request(ROUTE, send(await form()));
    const second = await app.request(ROUTE, send(await form()));
    await until(() => upstream.records.length === 2);

    let pulled = false;
    const unread = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const busy = await app.request(
      ROUTE,
      send(unread, {
        headers: integrationHeaders({ "Content-Type": "multipart/form-data; boundary=x" }),
        duplex: "half",
      } as RequestInit),
    );
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("10");
    expect(await busy.json()).toEqual({ error: "busy" });
    expect(pulled).toBe(false);

    await first.body?.cancel();
    await until(() => upstream.records[0]?.aborted === true);
    let admitted: Response | undefined;
    // Polls until the released slot admits a request (the run ends just after the abort).
    for (let i = 0; i < 100 && admitted === undefined; i++) {
      const next = await app.request(ROUTE, send(await form()));
      if (next.status === 429) await new Promise((resolve) => setTimeout(resolve, 10));
      else admitted = next;
    }
    expect(admitted?.status).toBe(200);
    await admitted?.body?.cancel();
    await second.body?.cancel();
  });

  it("answers a replayed id with the kept character, without calling the model again", async () => {
    const { app, upstream, stores } = imageSetup({
      upstream: {
        turns: [
          { chunks: [SUBJECT_ANSWER] },
          { failWith: { status: 500, body: JSON.stringify({ error: { message: "down" } }) } },
        ],
      },
    });
    const id = crypto.randomUUID();
    await imageEvents(await app.request(ROUTE, send(await form({ id }))));
    expect(upstream.records).toHaveLength(1);
    const version = (await stores.characters.portrait(id, "full"))?.version;
    const replay = await imageEvents(await app.request(ROUTE, send(await form({ id }))));
    expect(replay).toEqual([{ type: "result", id, name: "Ada Reed" }]);
    expect(upstream.records).toHaveLength(1);
    expect(stores.characters.list()).toHaveLength(1);
    expect((await stores.characters.portrait(id, "full"))?.version).toBe(version);
  });

  it("keeps the card in the requester's own instance; another user's retry by its id finds nothing", async () => {
    const { app, upstream, stores, instances } = imageSetup({
      upstream: { chunks: [SUBJECT_ANSWER] },
    });
    const id = crypto.randomUUID();
    const kept = await imageEvents(await app.request(ROUTE, send(await form({ id }))));
    expect(kept.at(-1)).toEqual({ type: "result", id, name: "Ada Reed" });
    const other = usernameSchema.parse("other-user");
    const otherStores = instances.instance(other).stores;
    expect(otherStores.characters.get(id)).toBeUndefined();
    expect(otherStores.characters.list()).toEqual([]);

    // The other user has no saved model: the retry is a new request in their instance, refused before any model call.
    const retry = await imageEvents(
      await app.request(
        ROUTE,
        send(await form({ id }), { headers: integrationHeaders({ "Remote-User": other }) }),
      ),
    );
    expect(retry).toEqual([{ type: "error", code: "no_model" }]);
    expect(upstream.records).toHaveLength(1);
    expect(otherStores.characters.list()).toEqual([]);
    expect(stores.characters.list().map((character) => character.id)).toEqual([id]);
  });

  it("names the one stored character when two first requests share an id", async () => {
    const { app, upstream, stores } = imageSetup({
      upstream: {
        turns: [
          { chunks: pieces(SUBJECT_ANSWER) },
          {
            chunks: pieces(SUBJECT_ANSWER.replace("<name>Ada Reed</name>", "<name>Bo Lind</name>")),
          },
        ],
      },
    });
    const id = crypto.randomUUID();
    const [first, second] = await Promise.all([
      app.request(ROUTE, send(await form({ id }))),
      app.request(ROUTE, send(await form({ id }))),
    ]);
    const results = [(await imageEvents(first)).at(-1), (await imageEvents(second)).at(-1)];
    // Both passed the replay check before either saved; the read-back names the one that exists.
    expect(upstream.records).toHaveLength(2);
    const name = stores.characters.get(id)?.card.name;
    expect(results).toEqual([
      { type: "result", id, name },
      { type: "result", id, name },
    ]);
    expect(stores.characters.list()).toHaveLength(1);
  });

  it("ends an unexpected failure with one internal error, logged by class, and frees the slot", async () => {
    const { app, lines, upstream, stores } = imageSetup({ upstream: { chunks: [SUBJECT_ANSWER] } });
    const get = vi.spyOn(stores.settings, "get").mockImplementation(() => {
      throw new Error(`disk fault ${NOTES} ${CARD_DIRECTION}`);
    });
    const all = await imageEvents(
      await app.request(ROUTE, send(await form({ notes: NOTES, direction: CARD_DIRECTION }))),
    );
    expect(all).toEqual([{ type: "error", code: "internal" }]);
    expect(upstream.records).toEqual([]);
    expect(stores.characters.list()).toEqual([]);
    const failure = lines.filter((line) => line.includes('"event":"creator.image_card.error"'));
    expect(failure).toHaveLength(1);
    expect(JSON.parse(failure[0] ?? "{}")).toMatchObject({ errorClass: "Error" });
    expectContentFree(lines, ["disk fault"]);

    get.mockRestore();
    const [first, second] = await Promise.all([
      app.request(ROUTE, send(await form())),
      app.request(ROUTE, send(await form())),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await imageEvents(first)).at(-1)).toMatchObject({ type: "result" });
    expect((await imageEvents(second)).at(-1)).toMatchObject({ type: "result" });
  });
});
