import { describe, expect, it } from "vitest";
import { fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  config,
  formRequest,
  INTEGRATION_KEY,
  integrationHeaders,
  ownerHeaders,
  PICK_SEED,
  TEST_USER,
  testApp,
} from "./helpers.ts";
import { pngWithText } from "./image-fixtures.ts";

const chatBody = JSON.stringify({
  model: "m",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  messages: [{ role: "user", content: "hi" }],
});

function withoutHeader(name: string): Record<string, string> {
  const headers = ownerHeaders();
  delete headers[name];
  return headers;
}

describe("API boundary", () => {
  const { app } = testApp({ fetch: fakeUpstream({ chunks: ["ok"] }).fetch });

  it.each([
    ["no proxy key", withoutHeader("X-Ephemera-Proxy-Key")],
    ["a wrong proxy key", ownerHeaders({ "X-Ephemera-Proxy-Key": "q".repeat(40) })],
    ["a proxy key prefix", ownerHeaders({ "X-Ephemera-Proxy-Key": config.proxyKey.slice(0, 20) })],
    ["no Remote-User", withoutHeader("Remote-User")],
  ])("rejects a safe request with %s", async (_label, headers) => {
    for (const path of ["/api/models", "/", "/assets/app.js"]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
  });

  it.each(["a", "0", "alice", "bob.smith", "e2e-owner", "user_2", "x".repeat(64)])(
    "admits the valid username %j",
    async (username) => {
      const response = await app.request("/api/models", {
        headers: ownerHeaders({ "Remote-User": username }),
      });
      expect(response.status).toBe(200);
    },
  );

  it.each([
    ["uppercase", "Owner"],
    ["empty", ""],
    ["65 characters", "x".repeat(65)],
    ["a leading dot", ".owner"],
    ["a leading dash", "-owner"],
    ["a slash", "a/b"],
    ["dot-dot", ".."],
    ["a space", "own er"],
    ["non-ASCII", "ownér"],
  ])("refuses a Remote-User with %s", async (_label, username) => {
    for (const path of ["/api/models", "/", "/assets/app.js"]) {
      const response = await app.request(path, {
        headers: ownerHeaders({ "Remote-User": username }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
  });

  it("refuses a request bound to another user than Remote-User", async () => {
    for (const path of ["/api/models", "/"]) {
      const response = await app.request(path, {
        headers: ownerHeaders({ "X-Ephemera-User": "someone-else" }),
      });
      expect(response.status).toBe(412);
      expect(await response.json()).toEqual({ error: "identity_mismatch" });
    }
  });

  it("admits a request bound to the same user as Remote-User", async () => {
    const response = await app.request("/api/models", {
      headers: ownerHeaders({ "X-Ephemera-User": TEST_USER }),
    });
    expect(response.status).toBe(200);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses an unbound %s under the proxy key",
    async (method) => {
      const response = await app.request("/api/chat", {
        method,
        headers: withoutHeader("X-Ephemera-User"),
        body: chatBody,
      });
      expect(response.status).toBe(412);
      expect(await response.json()).toEqual({ error: "identity_mismatch" });
    },
  );

  it("admits an unbound safe request, as a navigation or an image makes it", async () => {
    for (const path of ["/api/models", "/api/settings"]) {
      const response = await app.request(path, { headers: withoutHeader("X-Ephemera-User") });
      expect(response.status).toBe(200);
    }
  });

  it.each([
    ["no Origin", withoutHeader("Origin")],
    ["Origin null", ownerHeaders({ Origin: "null" })],
    ["a foreign Origin", ownerHeaders({ Origin: "https://evil.test" })],
    ["a sibling subdomain Origin", ownerHeaders({ Origin: "https://app.ephemera.test" })],
    ["a trailing slash Origin", ownerHeaders({ Origin: `${config.origin}/` })],
    ["an http Origin", ownerHeaders({ Origin: "http://ephemera.test" })],
  ])("rejects an unsafe request with %s", async (_label, headers) => {
    const response = await app.request("/api/chat", { method: "POST", headers, body: chatBody });
    expect(response.status).toBe(403);
  });

  it.each([
    ["no content type", withoutHeader("Content-Type")],
    ["text/plain", ownerHeaders({ "Content-Type": "text/plain" })],
    ["form encoding", ownerHeaders({ "Content-Type": "application/x-www-form-urlencoded" })],
    ["multipart", ownerHeaders({ "Content-Type": "multipart/form-data; boundary=x" })],
    ["a JSON look-alike", ownerHeaders({ "Content-Type": "application/jsonx" })],
  ])("rejects an unsafe request with %s", async (_label, headers) => {
    const response = await app.request("/api/chat", { method: "POST", headers, body: chatBody });
    expect(response.status).toBe(415);
  });

  it.each(["PUT", "PATCH", "DELETE"])("applies the unsafe rules to %s", async (method) => {
    const response = await app.request("/api/chat", {
      method,
      headers: ownerHeaders({ Origin: "https://evil.test" }),
    });
    expect(response.status).toBe(403);
  });

  it("accepts the exact owner, key, origin and a JSON content type with parameters", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: ownerHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      body: chatBody,
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("answers a CORS preflight without CORS headers", async () => {
    const preflight = await app.request("/api/chat", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(403);
    expect(
      [...preflight.headers.keys()].filter((key) => key.startsWith("access-control-")),
    ).toEqual([]);
  });

  it("never sends CORS headers on accepted requests", async () => {
    const response = await app.request("/api/models", {
      headers: ownerHeaders({ Origin: "https://evil.test" }),
    });
    expect(response.status).toBe(200);
    expect([...response.headers.keys()].filter((key) => key.startsWith("access-control-"))).toEqual(
      [],
    );
  });
});

describe("integration key", () => {
  const { app } = testApp({ fetch: fakeUpstream({ chunks: ["ok"] }).fetch });
  const route = "/api/creator/card/from-image";

  const form = () => {
    const body = new FormData();
    body.set("id", "00000000-0000-4000-8000-000000000001");
    // A real image, so the route behind the boundary does not answer 415 itself.
    body.set("file", new File([new Uint8Array(pngWithText({}))], "x.png", { type: "image/png" }));
    return body;
  };

  const withoutIntegration = (name: string) => {
    const headers = integrationHeaders();
    delete headers[name];
    return headers;
  };

  it("passes the boundary on the image card route with a multipart body, unbound", async () => {
    expect(integrationHeaders()).not.toHaveProperty("X-Ephemera-User");
    const response = await app.request(route, {
      method: "POST",
      headers: integrationHeaders(),
      body: form(),
    });
    expect([403, 415]).not.toContain(response.status);
    await response.body?.cancel();
  });

  it.each([
    ["GET", "/api/models"],
    ["GET", "/api/settings"],
    ["GET", "/api/characters"],
    ["POST", "/api/chat"],
  ])("opens nothing else: %s %s is forbidden", async (method, path) => {
    const response = await app.request(path, {
      method,
      headers: integrationHeaders({ "Content-Type": "application/json" }),
      ...(method === "POST" ? { body: chatBody } : {}),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("leaves the SWAG key valid on the image card route", async () => {
    const response = await app.request(route, formRequest("POST", form()));
    expect([403, 415]).not.toContain(response.status);
    await response.body?.cancel();
  });

  it("is refused when no integration key is configured", async () => {
    const { app: closed } = testApp({}, { integrationKey: undefined });
    const response = await closed.request(route, {
      method: "POST",
      headers: integrationHeaders(),
      body: form(),
    });
    expect(response.status).toBe(403);
  });

  it("admits any valid username, whose own instance the route then serves", async () => {
    const response = await app.request(route, {
      method: "POST",
      headers: integrationHeaders({ "Remote-User": "atelier-user" }),
      body: form(),
    });
    expect([403, 412, 415]).not.toContain(response.status);
    await response.body?.cancel();
  });

  it.each([
    ["no Remote-User", withoutIntegration("Remote-User")],
    ["an uppercase Remote-User", integrationHeaders({ "Remote-User": "Owner" })],
    ["a Remote-User with a slash", integrationHeaders({ "Remote-User": "a/b" })],
    ["no Origin", withoutIntegration("Origin")],
    ["a foreign Origin", integrationHeaders({ Origin: "https://evil.test" })],
  ])("keeps the username and Origin rules with %s", async (_label, headers) => {
    const response = await app.request(route, { method: "POST", headers, body: form() });
    expect(response.status).toBe(403);
  });

  it("keeps the bound-user rule", async () => {
    const response = await app.request(route, {
      method: "POST",
      headers: integrationHeaders({ "X-Ephemera-User": "someone-else" }),
      body: form(),
    });
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ error: "identity_mismatch" });
  });

  it("never opens the health probe", async () => {
    const response = await app.request("/api/health", {
      headers: { "X-Ephemera-Proxy-Key": INTEGRATION_KEY },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("keeps the content-type rule", async () => {
    const response = await app.request(route, {
      method: "POST",
      headers: integrationHeaders({ "Content-Type": "text/plain" }),
      body: "x",
    });
    expect(response.status).toBe(415);
  });

  it("opens POST only on the image card path", async () => {
    const response = await app.request(route, {
      method: "PUT",
      headers: integrationHeaders(),
      body: form(),
    });
    expect(response.status).toBe(403);
    expect(INTEGRATION_KEY).not.toBe(config.proxyKey);
  });
});
