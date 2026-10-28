import {
  ART_STREAM_TYPE,
  type CallAccounting,
  encodeArtFrame,
  type InspectedPrompt,
} from "@ephemera/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn } from "../signin/signin.ts";
import { streamScene } from "./scene-stream.ts";
import { createChatStore, type Reply, shownReply } from "./store.ts";
import { ReplyNote } from "./Turn.tsx";
import { fetchPreview, GenerationError, type ReplyUpdate, streamReply } from "./transport.ts";

vi.mock("./session.ts", async () => {
  const { createChatStore } = await import("./store.ts");
  return {
    chatStore: createChatStore(
      async function* () {},
      () => ({
        model: null,
        samplerPresetId: null,
        promptPresetId: null,
        characterId: null,
        personaId: null,
        reasoning: null,
      }),
      { clock: () => ({ now: 0, timeZone: "UTC" }), fetchPreview: () => new Promise(() => {}) },
    ),
    useChat: vi.fn(),
  };
});

const clock = { now: 0, timeZone: "UTC" };
const request = {
  model: "m",
  clock,
  pickSeed: 0,
  mode: "reply" as const,
  messages: [{ role: "user" as const, content: "hi" }],
};

const prompt: InspectedPrompt = {
  model: "m",
  mode: "reply",
  processing: "none",
  messages: [{ role: "user", content: "hi", tokens: 8, source: { kind: "history", index: 0 } }],
  settings: { temperature: 0.9 },
  reasoningNotOffered: null,
  window: { tokens: 131_072, source: "catalog", model: 131_072, limit: null },
  reserve: 4_096,
  estimate: 8,
  history: { sent: 1, total: 1 },
  examples: { sent: 0, total: 0 },
  trimming: "exact",
  lorebook: null,
  lorebookState: null,
};

function sseResponse(chunks: object[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const text = [
  { type: "start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Hel" },
  { type: "text-delta", id: "t", delta: "lo" },
  { type: "text-end", id: "t" },
];

async function updates(): Promise<ReplyUpdate[]> {
  const all: ReplyUpdate[] = [];
  for await (const update of streamReply(request, new AbortController().signal)) all.push(update);
  return all;
}

async function collect(): Promise<string[]> {
  return (await updates()).map((update) => update.text);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamReply", () => {
  it.each([400, 408, 413])(
    "treats a preflight %s response as a refusal rather than a model attempt",
    async (status) => {
      vi.stubGlobal("fetch", async () =>
        Response.json(
          { error: status === 408 ? "request_timeout" : "invalid_request" },
          { status },
        ),
      );
      await expect(updates()).rejects.toMatchObject({ reason: "refused" });
    },
  );
  it("extracts scene accounting before progress reaches the image consumer", async () => {
    const accounting: CallAccounting = {
      calls: [
        {
          id: crypto.randomUUID(),
          purpose: "scene.prompt",
          model: "m",
          status: "completed",
          usage: { outputTokens: 9 },
        },
      ],
      truncated: false,
    };
    vi.stubGlobal("fetch", async () => {
      return new Response(
        encodeArtFrame({ type: "progress", phase: "prompt", value: 1, max: 1, accounting }),
        { headers: { "Content-Type": ART_STREAM_TYPE } },
      );
    });
    const receive = vi.fn();
    const events = await streamScene(
      {
        model: "m",
        characterId: crypto.randomUUID(),
        kind: "subject",
        source: "Synthetic",
        workflow: "krea2-gonzalomo",
      },
      new AbortController().signal,
      receive,
    );
    const parts = [];
    for await (const part of events) parts.push(part);
    expect(receive).toHaveBeenCalledWith(accounting);
    expect(parts).toEqual([{ type: "progress", phase: "prompt", value: 1, max: 1 }]);
  });
  it("reads usage settlement without adding it to reply parts", async () => {
    const accounting: CallAccounting = {
      calls: [
        {
          id: crypto.randomUUID(),
          purpose: "narration",
          model: "m",
          status: "completed",
          usage: { inputTokens: 5 },
        },
      ],
      truncated: false,
    };
    const fetch = vi.fn(async () => {
      return sseResponse([
        ...text,
        { type: "finish" },
        { type: "data-usage", data: accounting, transient: true },
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const received = await updates();
    expect(received.at(-1)).toMatchObject({ text: "Hello", accounting });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["length", "content-filter"] as const)(
    "preserves the SDK finish reason %s",
    async (finishReason) => {
      vi.stubGlobal("fetch", async () => sseResponse([...text, { type: "finish", finishReason }]));
      expect((await updates()).at(-1)).toMatchObject({ text: "Hello", finishReason });
      const store = createChatStore(
        streamReply,
        () => ({
          model: "m",
          samplerPresetId: null,
          promptPresetId: null,
          characterId: null,
          personaId: null,
          reasoning: null,
        }),
        { clock: () => clock, fetchPreview: () => new Promise(() => {}) },
      );
      store.getState().setDraft("Hi");
      await store.getState().send();
      const message = store.getState().messages.at(-1);
      expect(message?.role).toBe("assistant");
      if (message?.role !== "assistant") throw new Error("Missing reply");
      expect(shownReply(message)).toMatchObject({
        text: "Hello",
        status: "complete",
        finishReason,
      });
    },
  );

  it("preserves a reasoning-only output limit ending", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        { type: "start" },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "Thinking" },
        { type: "reasoning-end", id: "r" },
        { type: "finish", finishReason: "length" },
      ]),
    );
    expect((await updates()).at(-1)).toMatchObject({
      text: "",
      reasoning: "Thinking",
      finishReason: "length",
    });
  });
  it("yields growing text and completes on finish", async () => {
    vi.stubGlobal("fetch", async () => sseResponse([...text, { type: "finish" }]));
    expect((await collect()).at(-1)).toBe("Hello");
  });

  it.each([
    [
      "an error chunk, even before finish",
      [...text, { type: "error", errorText: "x" }, { type: "finish" }],
      "stream",
    ],
    ["a stream cut before finish", text, "stream"],
    ["a server abort", [...text, { type: "abort" }], "aborted"],
  ])("fails on %s", async (_label, chunks, reason) => {
    vi.stubGlobal("fetch", async () => sseResponse(chunks));
    await expect(collect()).rejects.toMatchObject({ name: "GenerationError", reason });
  });

  it("fails as signed out when the sign-in redirect answers", async () => {
    vi.stubGlobal("fetch", async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperties(response, {
        type: { value: "opaqueredirect" },
        status: { value: 0 },
        ok: { value: false },
      });
      return response;
    });
    await expect(updates()).rejects.toMatchObject({ reason: "signed_out" });
    signIn.reset();
  });

  it("fails on an HTTP error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(collect()).rejects.toBeInstanceOf(GenerationError);
  });

  it("keeps reasoning apart from the text", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        { type: "start" },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "Weigh " },
        { type: "reasoning-delta", id: "r", delta: "it." },
        { type: "reasoning-end", id: "r" },
        ...text.slice(1),
        { type: "finish" },
      ]),
    );
    const all = await updates();
    expect(all.findLast((update) => update.text === "")?.reasoning).toBe("Weigh it.");
    expect(all.at(-1)).toMatchObject({ text: "Hello", reasoning: "Weigh it." });
  });

  it("carries the exact prompt sent and the model's own count, cached tokens included", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        { type: "start" },
        { type: "data-prompt", data: prompt, transient: true },
        ...text.slice(1),
        { type: "finish", messageMetadata: { inputTokens: 12, cachedTokens: 5 } },
      ]),
    );
    const all = await updates();
    expect(all[0]?.prompt).toEqual(prompt);
    expect(all.at(-1)).toMatchObject({ text: "Hello", prompt, inputTokens: 12, cachedTokens: 5 });
    expect(all.at(-1)).not.toHaveProperty("outputTokens");
    expect(all.at(-1)).not.toHaveProperty("reasoningTokens");
  });

  it("carries what the model wrote and its reasoning share when the provider says", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        ...text,
        {
          type: "finish",
          messageMetadata: {
            inputTokens: 12,
            cachedTokens: 5,
            outputTokens: 820,
            reasoningTokens: 210,
          },
        },
      ]),
    );
    const all = await updates();
    expect(all.at(-1)).toMatchObject({ outputTokens: 820, reasoningTokens: 210 });
  });

  it.each([
    ["upstream_busy", true],
    ["generation_failed", false],
    ["x", false],
  ])("tells a busy provider apart by the error's code (%s)", async (errorText, busy) => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([{ type: "start" }, { type: "error", errorText }]),
    );
    await expect(
      (async () => {
        for await (const _ of streamReply(request, new AbortController().signal)) {
          // Nothing to read before the error.
        }
      })(),
    ).rejects.toMatchObject({ reason: "stream", busy });
  });

  it("yields the prompt sent even when the reply fails before any output", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        { type: "start" },
        { type: "data-prompt", data: prompt, transient: true },
        { type: "error", errorText: "generation_failed" },
      ]),
    );
    const seen: ReplyUpdate[] = [];
    await expect(
      (async () => {
        for await (const update of streamReply(request, new AbortController().signal)) {
          seen.push(update);
        }
      })(),
    ).rejects.toMatchObject({ reason: "stream" });
    expect(seen.at(-1)?.prompt).toEqual(prompt);
  });

  it("fails on a prompt part that is not a prompt", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        { type: "start" },
        { type: "data-prompt", data: { model: 1 } },
        ...text.slice(1),
        { type: "finish" },
      ]),
    );
    await expect(collect()).rejects.toMatchObject({ reason: "stream" });
  });

  it.each([
    [409, "context_window_unknown"],
    [422, "prompt_too_long"],
  ])("names why the server refused (%i)", async (status, error) => {
    vi.stubGlobal("fetch", async () => Response.json({ error }, { status }));
    await expect(collect()).rejects.toMatchObject({ reason: "refused", code: error });
  });
});

describe("partial reply footer", () => {
  const reply: Reply = {
    id: "r",
    text: "Story",
    reasoning: "",
    thoughtMs: null,
    status: "complete",
  };
  const render = (change: Partial<Reply>, last = true) =>
    renderToStaticMarkup(createElement(ReplyNote, { reply: { ...reply, ...change }, last }));

  it.each([
    [
      { finishReason: "length" },
      true,
      "Cut off at the output limit. Continue writes on from here.",
      "text-reed",
    ],
    [{ finishReason: "length" }, false, "Cut off at the output limit.", "text-reed"],
    [
      { finishReason: "length", text: "", reasoning: "Thinking" },
      true,
      "The output limit ran out while the model was reasoning, before any reply.",
      "text-reed",
    ],
    [
      { finishReason: "length", text: "", hiddenMs: 500 },
      true,
      "The output limit ran out while the model was reasoning, before any reply.",
      "text-reed",
    ],
    [
      { finishReason: "length", text: "" },
      true,
      "The output limit ran out before any reply.",
      "text-reed",
    ],
    [
      { finishReason: "content-filter" },
      true,
      "Stopped by the provider's content filter.",
      "text-ember",
    ],
    [
      { finishReason: "content-filter", text: "" },
      true,
      "The provider's content filter blocked this reply.",
      "text-ember",
    ],
  ] satisfies [Partial<Reply>, boolean, string, string][])(
    "renders %j",
    (change, last, text, tone) => {
      const out = render(change, last);
      expect(out).toBe(
        `<p class="mt-2 font-sans text-meta ${tone}">${text.replaceAll("'", "&#x27;")}</p>`,
      );
    },
  );

  it("keeps failure, refusal and busy notices ahead of partial endings", () => {
    for (const failed of ["continue", "replace"] as const) {
      const out = render({ finishReason: "length", failed });
      expect(out).toContain(
        `${failed === "continue" ? "Continue" : "Replace"} failed; the reply is as it was.`,
      );
      expect(out).not.toContain("output limit");
    }
    expect(render({ finishReason: "length", refusal: "prompt_too_long" })).toContain("Not sent:");
    expect(render({ finishReason: "content-filter", busy: true, status: "failed" })).not.toContain(
      "content filter",
    );
    expect(render({ finishReason: "length", status: "streaming" })).toBe("");
    expect(render({})).toBe("");
  });
});

describe("fetchPreview", () => {
  it("returns the previewed prompt", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ prompt }));
    const { mode: _mode, ...preview } = request;
    expect(await fetchPreview({ ...preview, messages: [] }, new AbortController().signal)).toEqual({
      ok: true,
      prompt,
    });
  });

  it.each([
    [409, "context_window_unknown"],
    [422, "prompt_too_long"],
    [502, "unavailable"],
  ])("returns why a preview failed (%i)", async (status, error) => {
    vi.stubGlobal("fetch", async () => Response.json({ error }, { status }));
    const { mode: _mode, ...preview } = request;
    expect(await fetchPreview(preview, new AbortController().signal)).toEqual({
      ok: false,
      error: error === "unavailable" ? "unavailable" : error,
    });
  });
});
