import {
  type CallAccounting,
  type MemoryState,
  memoryStateOf,
  type RememberRequest,
} from "@ephemera/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAVE_TIMEOUT_MS } from "../sheet/saving.ts";
import {
  forgetMemory,
  memoryOnIn,
  memoryQuery,
  publishMemoryState,
  remember,
  saveMemoryState,
  writeOpening,
} from "./queries.ts";

const REQUEST: RememberRequest = {
  characterId: "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b",
  model: "model-a",
  turns: [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ],
  episodes: [],
  held: [],
  attempt: "6b2f3c4d-5e6f-4a71-8b2c-3d4e5f6a7b8c",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const answering = (response: () => Response | Promise<Response>) =>
  vi.stubGlobal("fetch", async () => response());

describe("a memory call", () => {
  it("delivers a settled failure receipt and leaves preflight timeouts without paid calls", async () => {
    const receipt: CallAccounting = {
      calls: [
        {
          id: crypto.randomUUID(),
          purpose: "memory.remember",
          model: "m",
          status: "aborted",
          usage: {},
        },
      ],
      truncated: false,
    };
    const receive = vi.fn();
    vi.stubGlobal("fetch", async () => {
      return Response.json({ error: "request_timeout", accounting: receipt });
    });
    await remember(REQUEST, new AbortController().signal, receive);
    expect(receive).toHaveBeenCalledWith(receipt);
    receive.mockClear();
    answering(() => Response.json({ error: "request_timeout" }, { status: 408 }));
    await remember(REQUEST, new AbortController().signal, receive);
    expect(receive).toHaveBeenCalledWith({ calls: [], truncated: false });
  });
  it("serializes memory RPCs as JSON without losing their cancellation signals", async () => {
    const requests: Request[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    // Only fetch is stubbed: queries use the real apiFetch and Hono RPC serializer.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(
        typeof input === "string" ? new URL(input, "http://localhost") : input,
        init,
      );
      requests.push(request);
      signals.push(init?.signal);
      if (request.method === "PATCH") return Response.json(memoryStateOf(null));
      if (request.method === "POST") return Response.json({ error: "memory_off" }, { status: 409 });
      return Response.json({ state: null, episodes: [] });
    });
    const client = new QueryClient();
    expect(await client.fetchQuery(memoryQuery(REQUEST.characterId))).toEqual({
      state: null,
      episodes: [],
    });
    const patch = { enabled: false, notebook: memoryStateOf(null).notebook };
    expect(await saveMemoryState(REQUEST.characterId, patch, 3)).toEqual({
      ok: true,
      saved: memoryStateOf(null),
    });
    expect(await forgetMemory(REQUEST.characterId)).toEqual({ state: null, episodes: [] });
    const controller = new AbortController();
    expect(await remember(REQUEST, controller.signal)).toEqual({
      ok: false,
      reason: "memory_off",
      lost: false,
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "PATCH", "DELETE", "POST"]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/api/memory/characters/${REQUEST.characterId}`,
      `/api/memory/characters/${REQUEST.characterId}`,
      `/api/memory/characters/${REQUEST.characterId}`,
      "/api/memory/remember",
    ]);
    for (const request of requests.slice(1)) {
      expect(request.headers.get("Content-Type")).toBe("application/json");
    }
    expect(await requests[1]?.json()).toEqual({ ...patch, revision: 3 });
    expect(await requests[3]?.json()).toEqual(REQUEST);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    // The save and the forget each give up after the save timeout.
    expect(timeout.mock.calls).toEqual([[SAVE_TIMEOUT_MS], [SAVE_TIMEOUT_MS]]);
    expect(signals[1]).toBe(timeout.mock.results[0]?.value);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[2]).toBe(timeout.mock.results[1]?.value);
    expect(signals[3]).toBe(controller.signal);
    controller.abort();
    expect(requests[3]?.signal.aborted).toBe(true);
    client.clear();
  });
  it("lost its answer when the server never answered or a proxy did", async () => {
    answering(() => Promise.reject(new TypeError("offline")));
    expect(await remember(REQUEST, new AbortController().signal)).toEqual({
      ok: false,
      reason: "unreachable",
      lost: true,
    });
    answering(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await remember(REQUEST, new AbortController().signal)).toMatchObject({ lost: true });
  });

  it("was refused when Ephemera said why", async () => {
    for (const [status, error] of [
      [409, "memory_off"],
      [409, "context_window_unknown"],
      [409, "too_many_memories"],
      [422, "prompt_too_long"],
      [502, "memory_failed"],
    ] as const) {
      answering(() => Response.json({ error }, { status }));
      expect(await remember(REQUEST, new AbortController().signal)).toEqual({
        ok: false,
        reason: error,
        lost: false,
      });
    }
    answering(() => Response.json({ error: "request_timeout" }, { status: 408 }));
    expect(await remember(REQUEST, new AbortController().signal)).toMatchObject({
      reason: "timeout",
      lost: false,
    });
  });

  it("reads the answer the model phase sends after its blank lines, a refusal included", async () => {
    const streamed = (value: unknown) => () =>
      new Response(`\n\n\n${JSON.stringify(value)}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    for (const error of ["memory_failed", "memory_off", "too_many_memories"] as const) {
      answering(streamed({ error }));
      expect(await remember(REQUEST, new AbortController().signal)).toEqual({
        ok: false,
        reason: error,
        lost: false,
      });
    }
    answering(streamed({ error: "request_timeout" }));
    expect(await remember(REQUEST, new AbortController().signal)).toEqual({
      ok: false,
      reason: "timeout",
      lost: false,
    });
    const id = "7c3a4d5e-6f7a-4b82-9c3d-4e5f6a7b8c9d";
    const response = {
      episode: {
        id,
        characterId: REQUEST.characterId,
        seq: 0,
        kind: "episode",
        title: "The crossing",
        summary: "They crossed.",
        cues: [],
        pinned: false,
        turns: 2,
        chapterId: null,
        revision: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      notebook: {
        enabled: true,
        notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
        opening: "",
        revision: 1,
        updatedAt: 0,
      },
      recap: [id],
    };
    answering(streamed(response));
    expect(await remember(REQUEST, new AbortController().signal)).toEqual({ ok: true, response });
    // Cut off before the text arrived whole: the answer may be lost.
    answering(() => new Response('\n\n{"episode"', { status: 200 }));
    expect(await remember(REQUEST, new AbortController().signal)).toMatchObject({ lost: true });
  });
});

describe("an opening call", () => {
  const CHARACTER = REQUEST.characterId;
  const call = () => writeOpening(CHARACTER, { model: "model-a" }, new AbortController().signal);
  const streamed = (value: unknown) => () =>
    new Response(`\n\n${JSON.stringify(value)}`, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("reads the opening the model phase sends after its blank lines", async () => {
    let asked = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      asked = input instanceof Request ? input.url : String(input);
      return streamed({ opening: "> Location: The pier\n\n{{user}} waits." })();
    });
    expect(await call()).toEqual({ ok: true, opening: "> Location: The pier\n\n{{user}} waits." });
    expect(asked).toContain(`/api/memory/characters/${CHARACTER}/opening`);
  });

  it("says why, whether the server refused at once or after the call", async () => {
    for (const [status, error] of [
      [409, "memory_off"],
      [409, "nothing_to_remember"],
      [409, "context_window_unknown"],
      [422, "prompt_too_long"],
    ] as const) {
      answering(() => Response.json({ error }, { status }));
      expect(await call()).toEqual({ ok: false, reason: error });
    }
    for (const error of ["memory_failed", "upstream_busy", "memory_off"] as const) {
      answering(streamed({ error }));
      expect(await call()).toEqual({ ok: false, reason: error });
    }
    answering(streamed({ error: "request_timeout" }));
    expect(await call()).toEqual({ ok: false, reason: "timeout" });
    answering(() => Response.json({ error: "invalid_request" }, { status: 400 }));
    expect(await call()).toEqual({ ok: false, reason: "invalid" });
  });

  it("is unreachable when no answer came whole", async () => {
    answering(() => Promise.reject(new TypeError("offline")));
    expect(await call()).toEqual({ ok: false, reason: "unreachable" });
    answering(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await call()).toEqual({ ok: false, reason: "unreachable" });
    answering(() => new Response('\n\n{"open', { status: 200 }));
    expect(await call()).toEqual({ ok: false, reason: "unreachable" });
    answering(streamed({ opening: 3 }));
    expect(await call()).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("a character's memory", () => {
  it("never reads as on for a character that is gone, and is not asked for again", async () => {
    let asked = 0;
    answering(() => {
      asked++;
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    const client = new QueryClient();
    const query = memoryQuery(REQUEST.characterId);
    await expect(client.fetchQuery(query)).rejects.toThrow("not_found");
    expect(asked).toBe(1);
    expect(memoryOnIn(client.getQueryState(query.queryKey))).toBe(false);
  });

  it("reads as on once loaded without a notebook", async () => {
    answering(() => Response.json({ state: null, episodes: [] }));
    const client = new QueryClient();
    const query = memoryQuery(REQUEST.characterId);
    await client.fetchQuery(query);
    expect(memoryOnIn(client.getQueryState(query.queryKey))).toBe(true);
  });

  it("takes a notebook save's answer only over an older row, so a late one keeps a newer opening", async () => {
    // The reload after it never answers: the cache shows what the write left alone.
    answering(() => new Promise<Response>(() => {}));
    const client = new QueryClient();
    const key = memoryQuery(REQUEST.characterId).queryKey;
    const at = (revision: number, opening: string): MemoryState => ({
      ...memoryStateOf(null),
      revision,
      opening,
    });
    client.setQueryData(key, { state: at(1, ""), episodes: [] });
    void publishMemoryState(client, REQUEST.characterId, at(2, "Saved."));
    expect(client.getQueryData(key)?.state).toEqual(at(2, "Saved."));
    // A newer row arrived (another tab's edit or a memory) before this save's answer.
    client.setQueryData(key, { state: at(4, "Newer."), episodes: [] });
    void publishMemoryState(client, REQUEST.characterId, at(3, "Late."));
    expect(client.getQueryData(key)?.state).toEqual(at(4, "Newer."));
  });
});
