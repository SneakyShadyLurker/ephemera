import { MAX_CHAT_BODY_BYTES } from "@ephemera/core";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { BUILD_HEADER } from "../src/build.ts";
import { internalErrorResponse } from "../src/http.ts";
import { fakeUpstream } from "./fake-upstream.ts";
import { CLOCK, ownerHeaders, PICK_SEED, postJson, testApp } from "./helpers.ts";

const staticStub: MiddlewareHandler = async (c, next) => {
  if (c.req.path === "/assets/app.js") {
    return c.body("console.log(1)", 200, { "Content-Type": "text/javascript" });
  }
  if (c.req.path === "/boom") throw new Error("static failure");
  await next();
};

describe("SPA fallback", () => {
  const shell: MiddlewareHandler = async (c) => c.html("<!doctype html><title>shell</title>");
  const { app } = testApp({
    fetch: fakeUpstream().fetch,
    staticFiles: [staticStub],
    appShell: shell,
  });

  it("serves the app shell for client routes", async () => {
    const response = await app.request("/characters/abc", { headers: ownerHeaders() });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("shell");
  });

  it("answers a missing asset with 404, not the shell", async () => {
    for (const path of ["/assets/transport-old.js", "/favicon.ico"]) {
      const response = await app.request(path, { headers: ownerHeaders() });
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toContain("application/json");
    }
  });
});

/** PRINCIPLES.md 2, plus Trusted Types and the directives `default-src 'none'` implies. */
const EXPECTED_POLICY: Record<string, string> = {
  "default-src": "'none'",
  "script-src": "'self'",
  "style-src": "'self'",
  "img-src": "'self'",
  "font-src": "'self'",
  "connect-src": "'self'",
  "object-src": "'none'",
  "worker-src": "'none'",
  "frame-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'self'",
  "frame-ancestors": "'none'",
  "require-trusted-types-for": "'script'",
  "trusted-types": "'none'",
};

function directives(response: Response): Record<string, string> {
  const header = response.headers.get("Content-Security-Policy") ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name = "", ...values] = part.split(/\s+/);
        return [name, values.join(" ")];
      }),
  );
}

describe("response headers", () => {
  const { app } = testApp({
    fetch: fakeUpstream({ chunks: ["a", "b"] }).fetch,
    staticFiles: [staticStub],
  });

  const cases: [string, () => Response | Promise<Response>, number][] = [
    ["model list", () => app.request("/api/models", { headers: ownerHeaders() }), 200],
    [
      "generation stream",
      () =>
        app.request(
          "/api/chat",
          postJson({
            model: "m",
            clock: CLOCK,
            pickSeed: PICK_SEED,
            messages: [{ role: "user", content: "x" }],
          }),
        ),
      200,
    ],
    ["static file", () => app.request("/assets/app.js", { headers: ownerHeaders() }), 200],
    ["unknown API path", () => app.request("/api/nope", { headers: ownerHeaders() }), 404],
    ["unknown page", () => app.request("/nope", { headers: ownerHeaders() }), 404],
    ["wrong method", () => app.request("/api/models", postJson({})), 405],
    ["boundary rejection", () => app.request("/api/models"), 403],
    [
      "content type rejection",
      () =>
        app.request(
          "/api/chat",
          postJson({}, { headers: ownerHeaders({ "Content-Type": "text/plain" }) }),
        ),
      415,
    ],
    ["invalid body", () => app.request("/api/chat", postJson({ model: "" })), 400],
    [
      "malformed JSON body",
      () =>
        app.request("/api/chat", { method: "POST", headers: ownerHeaders(), body: "{not json" }),
      400,
    ],
    [
      "oversized body",
      () =>
        app.request(
          "/api/chat",
          postJson({
            model: "m",
            clock: CLOCK,
            pickSeed: PICK_SEED,
            messages: [{ role: "user", content: "x".repeat(MAX_CHAT_BODY_BYTES) }],
          }),
        ),
      413,
    ],
    ["handler error", () => app.request("/boom", { headers: ownerHeaders() }), 500],
    ["runtime error fallback", internalErrorResponse, 500],
  ];

  it.each(cases)(
    "sends Cache-Control: no-store, no-transform (no proxy rewrite) on the %s",
    async (_label, send, status) => {
      const response = await send();
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(directives(response)).toEqual(EXPECTED_POLICY);
      await response.body?.cancel();
    },
  );

  it("names no build when the server runs none", async () => {
    const response = await app.request("/api/models", { headers: ownerHeaders() });
    expect(response.headers.has(BUILD_HEADER)).toBe(false);
  });

  it("answers a malformed body as a client error, logged without detail", async () => {
    const { app, lines } = testApp({ fetch: fakeUpstream().fetch });
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: ownerHeaders(),
      body: "{not json",
    });
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(lines.some((line) => line.includes('"event":"unhandled"'))).toBe(false);
  });

  it("names the allowed methods on a 405", async () => {
    const response = await app.request("/api/models", postJson({}));
    expect(response.headers.get("Allow")).toContain("GET");
  });
});

describe("answers the app can tell from a sign-in redirect", () => {
  // The web app reads a 401 or a redirect as an expired Authelia session (PRINCIPLES.md 2),
  // so no route of Ephemera's may answer either, whatever it is sent.
  it("no route answers 401 or a redirect", async () => {
    const { app } = testApp({ fetch: async () => new Response(null, { status: 502 }) });
    const routes = app.routes.filter((route) => route.method !== "ALL");
    expect(routes.length).toBeGreaterThan(20);
    const id = crypto.randomUUID();
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z]+/g, id).replace("*", "anything");
      for (const headers of [ownerHeaders(), {}]) {
        const unsafe = !["GET", "HEAD", "OPTIONS"].includes(route.method);
        const response = await app.request(path, {
          method: route.method,
          headers,
          ...(unsafe ? { body: "{}" } : {}),
        });
        const status = response.status;
        expect(status === 401 || (status >= 300 && status < 400), `${route.method} ${path}`).toBe(
          false,
        );
      }
    }
  });
});

describe("the renewal page", () => {
  const page: MiddlewareHandler = async (c) =>
    c.html(
      '<!doctype html><title>Signed in again</title><script type="module" src="/assets/renewed.js"></script>',
    );
  const { app } = testApp({ fetch: fakeUpstream().fetch, renewalPage: page });

  it("is served at /auth/renewed to the owner, no-store, under the policy", async () => {
    const response = await app.request("/auth/renewed", { headers: ownerHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });

  it("is behind the boundary like everything else", async () => {
    const response = await app.request("/auth/renewed");
    expect(response.status).toBe(403);
  });
});

describe("build header", () => {
  const { app } = testApp(
    { fetch: fakeUpstream({ chunks: ["a"] }).fetch, staticFiles: [staticStub] },
    { buildRevision: "952d2f7" },
  );

  it.each<[string, () => Response | Promise<Response>, number]>([
    ["model list", () => app.request("/api/models", { headers: ownerHeaders() }), 200],
    [
      "generation stream",
      () =>
        app.request(
          "/api/chat",
          postJson({
            model: "m",
            clock: CLOCK,
            pickSeed: PICK_SEED,
            messages: [{ role: "user", content: "x" }],
          }),
        ),
      200,
    ],
    ["static file", () => app.request("/assets/app.js", { headers: ownerHeaders() }), 200],
    ["boundary rejection", () => app.request("/api/models"), 403],
    ["unknown API path", () => app.request("/api/nope", { headers: ownerHeaders() }), 404],
    ["handler error", () => app.request("/boom", { headers: ownerHeaders() }), 500],
    ["runtime error fallback", () => internalErrorResponse("952d2f7"), 500],
  ])("names the server's build on the %s", async (_label, send, status) => {
    const response = await send();
    expect(response.status).toBe(status);
    expect(response.headers.get(BUILD_HEADER)).toBe("952d2f7");
    await response.body?.cancel();
  });
});
