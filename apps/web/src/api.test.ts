import {
  ART_STREAM_TYPE,
  type CreatorArtRequest,
  encodeArtFrame,
  type SceneRequest,
} from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiFetch, isSignedOut } from "./api.ts";
import { queryClient } from "./app/query.ts";
import { streamScene } from "./chat/scene-stream.ts";
import { streamArt } from "./creator/stream.ts";
import { IdentityChanged, identity } from "./signin/identity.ts";
import { SignedOut, signIn } from "./signin/signin.ts";

/** A response as the browser reports a cross-origin redirect under `redirect: "manual"`. */
function opaqueRedirect(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  Object.defineProperty(response, "status", { value: 0 });
  Object.defineProperty(response, "ok", { value: false });
  return response;
}

// A 204 carries no body: the Fetch standard refuses one.
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  signIn.reset();
  identity.reset();
  queryClient.clear();
});

/** A page the server named `user` on, as the app shell is; returns the page and its reload. */
function boundPage(user: string) {
  const body = { hidden: false };
  const reload = vi.fn();
  vi.stubGlobal("document", { documentElement: { dataset: { user } }, body });
  vi.stubGlobal("window", { location: { reload } });
  identity.reset();
  return { body, reload };
}

const boundUser = (init: RequestInit | undefined) =>
  new Headers(init?.headers).get("X-Ephemera-User");

describe("signed-out detection", () => {
  it("recognizes the sign-in redirect and a 401", () => {
    expect(isSignedOut(opaqueRedirect())).toBe(true);
    expect(isSignedOut(json(401, { error: "anything" }))).toBe(true);
  });

  it("never mistakes Ephemera's own answers for it", () => {
    for (const status of [200, 204, 400, 403, 404, 405, 409, 413, 415, 422, 500, 502]) {
      expect(isSignedOut(json(status, { error: "x" }))).toBe(false);
    }
  });
});

describe("the fetch owner", () => {
  it("never follows redirects", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(200, {}));
    vi.stubGlobal("fetch", fetch);
    await apiFetch("/api/settings", { method: "GET" });
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("throws SignedOut and signs the tab out on the redirect", async () => {
    vi.stubGlobal("fetch", async () => opaqueRedirect());
    await expect(apiFetch("/api/settings")).rejects.toBeInstanceOf(SignedOut);
    expect(signIn.store.getState().phase).toBe("expired");
  });

  it("passes other failures through untouched", async () => {
    vi.stubGlobal("fetch", async () => json(502, { error: "upstream_unavailable" }));
    const response = await apiFetch("/api/models");
    expect(response.status).toBe(502);
    expect(signIn.store.getState().phase).toBe("active");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(apiFetch("/api/models")).rejects.toBeInstanceOf(TypeError);
    expect(signIn.store.getState().phase).toBe("active");
  });

  it("is what the RPC client sends every request through", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => opaqueRedirect());
    vi.stubGlobal("fetch", fetch);
    await expect(api.settings.$get()).rejects.toBeInstanceOf(SignedOut);
    await expect(
      api.chat.$post({
        json: {
          model: "m",
          mode: "reply",
          clock: { now: 0, timeZone: "UTC" },
          pickSeed: 0,
          messages: [],
        },
      }),
    ).rejects.toBeInstanceOf(SignedOut);
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
  });

  it("a request made while signed out that succeeds renews the tab", async () => {
    vi.stubGlobal("fetch", async () => opaqueRedirect());
    await expect(apiFetch("/api/settings")).rejects.toBeInstanceOf(SignedOut);
    vi.stubGlobal("fetch", async () => json(200, {}));
    await apiFetch("/api/settings");
    await vi.waitFor(() => expect(signIn.store.getState().phase).toBe("renewed"));
  });

  it("only an answer from Ephemera proves the session is back", async () => {
    vi.stubGlobal("fetch", async () => opaqueRedirect());
    await expect(apiFetch("/api/settings")).rejects.toBeInstanceOf(SignedOut);
    // SWAG's own error page while Authelia is down, or a 403 for another user: not Ephemera.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("<html>502</html>", { status: 500, headers: { "Content-Type": "text/html" } }),
    );
    await apiFetch("/api/settings");
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    await apiFetch("/api/settings");
    await Promise.resolve();
    expect(signIn.store.getState().phase).toBe("expired");
    // Ephemera's JSON, even an error, does.
    vi.stubGlobal("fetch", async () => json(404, { error: "not_found" }));
    await apiFetch("/api/characters/x");
    await vi.waitFor(() => expect(signIn.store.getState().phase).toBe("renewed"));
  });
});

describe("art stream RPC requests", () => {
  const artRequest: CreatorArtRequest = {
    kind: "subject",
    model: "art-model",
    source: "A character in a garden",
    direction: "Watercolour",
  };
  const sceneRequest: SceneRequest = {
    kind: "subject",
    model: "scene-model",
    characterId: "11111111-1111-4111-8111-111111111111",
    source: "The character enters a garden",
  };

  it.each([
    {
      name: "streamArt",
      path: "/api/creator/art",
      request: artRequest,
      send: (signal: AbortSignal) => streamArt(artRequest, signal),
    },
    {
      name: "streamScene",
      path: "/api/scene",
      request: sceneRequest,
      send: (signal: AbortSignal) => streamScene(sceneRequest, signal),
    },
  ])(
    "$name preserves JSON, the binary stream, cancellation and identity",
    async ({ path, request, send }) => {
      boundPage("alice");
      const event = { type: "error", code: "comfyui" } as const;
      const fetch = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(encodeArtFrame(event), { headers: { "Content-Type": ART_STREAM_TYPE } }),
      );
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      const events = await send(controller.signal);
      expect(await events.next()).toEqual({ value: event, done: false });
      expect((await events.next()).done).toBe(true);

      expect(fetch).toHaveBeenCalledOnce();
      const [input, init] = fetch.mock.calls[0] ?? [];
      expect(input).toBe(path);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      expect(boundUser(init)).toBe("alice");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBe(controller.signal);
      expect(init?.body).toBe(JSON.stringify(request));
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
    },
  );
});

describe("the tab's user", () => {
  it("binds every request to the page's user, whatever headers or body the caller passed", async () => {
    boundPage("alice");
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(200, {}));
    vi.stubGlobal("fetch", fetch);
    await apiFetch("/api/settings");
    await apiFetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "x" } });
    await apiFetch("/api/characters/import", { method: "POST", body: new FormData() });
    await api.settings.$get();
    expect(fetch.mock.calls.map(([, init]) => boundUser(init))).toEqual([
      "alice",
      "alice",
      "alice",
      "alice",
    ]);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Content-Type")).toBe("x");
  });

  it("sends no binding from a page that named nobody", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(200, {}));
    vi.stubGlobal("fetch", fetch);
    await apiFetch("/api/settings", { headers: { Accept: "application/json" } });
    expect(boundUser(fetch.mock.calls[0]?.[1])).toBeNull();
  });

  it("another user's session drops the cache, hides the page and reloads once; nothing more is sent", async () => {
    const page = boundPage("alice");
    queryClient.setQueryData(["settings"], { theme: "dark" });
    const fetch = vi.fn(async () => json(412, { error: "identity_mismatch" }));
    vi.stubGlobal("fetch", fetch);
    const first = apiFetch("/api/settings");
    const second = apiFetch("/api/characters");
    await expect(first).rejects.toBeInstanceOf(IdentityChanged);
    await expect(second).rejects.toBeInstanceOf(IdentityChanged);
    expect(page.reload).toHaveBeenCalledOnce();
    expect(page.body.hidden).toBe(true);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    await expect(apiFetch("/api/settings")).rejects.toBeInstanceOf(IdentityChanged);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("other refusals never leave the tab", async () => {
    const page = boundPage("alice");
    for (const response of [
      json(412, { error: "other" }),
      json(403, { error: "forbidden" }),
      new Response("<html>412</html>", { status: 412, headers: { "Content-Type": "text/html" } }),
    ]) {
      vi.stubGlobal("fetch", async () => response);
      await apiFetch("/api/settings");
    }
    expect(page.reload).not.toHaveBeenCalled();
    expect(identity.hasChanged()).toBe(false);
    expect(signIn.store.getState().phase).toBe("active");
  });
});

describe("URLs the browser loads itself", () => {
  it("come from the typed client under /api", async () => {
    const { exportUrl } = await import("./characters/queries.ts");
    const { portraitUrl } = await import("./portraits/queries.ts");
    const { presetExportUrl } = await import("./presets/queries.ts");
    const id = "11111111-1111-4111-8111-111111111111";
    expect(exportUrl(id, "png")).toBe(`/api/characters/${id}/export.png`);
    expect(exportUrl(id, "json")).toBe(`/api/characters/${id}/export.json`);
    expect(portraitUrl("personas", id, 7, "full")).toBe(
      `/api/personas/${id}/portrait/image?size=full&v=7`,
    );
    expect(presetExportUrl("prompt", id)).toBe(`/api/presets/prompt/${id}/export`);
    expect(presetExportUrl("sampler", id)).toBe(`/api/presets/sampler/${id}/export`);
  });
});
