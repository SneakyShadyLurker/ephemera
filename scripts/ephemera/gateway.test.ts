import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROXY_KEY_HEADER } from "../../apps/server/src/boundary.ts";
import { USER_HEADER, usernameSchema } from "../../apps/server/src/identity.ts";
import { gatewayHandler } from "./gateway.ts";

const PROXY_KEY = "gateway-test-proxy-key-0123456789abcdef";

/** What the stand-in server saw of each request. */
const seen: { path: string; headers: Headers; body: string }[] = [];
let aborted: () => void;
const abortSeen = new Promise<void>((resolve) => {
  aborted = resolve;
});

let target: Bun.Server<undefined>;
let gateway: Bun.Server<undefined>;
let origin: string;

beforeAll(() => {
  target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/hang") {
        request.signal.addEventListener("abort", () => aborted());
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
          }),
        );
      }
      if (url.pathname === "/redirect") return Response.redirect("https://portal.example/", 302);
      seen.push({
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        body: await request.text(),
      });
      return new Response("answer", { status: 201, headers: { "X-Answer": "yes" } });
    },
  });
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) =>
      gatewayHandler({
        access: {
          user: usernameSchema.parse("owner"),
          port: server.port ?? 0,
          origin: `http://localhost:${server.port}`,
        },
        proxyKey: PROXY_KEY,
        target: `http://127.0.0.1:${target.port}`,
      })(request, server),
  });
  origin = `http://localhost:${gateway.port}`;
});

afterAll(async () => {
  await gateway.stop(true);
  await target.stop(true);
});

describe("local gateway", () => {
  it("signs requests in as its one user with the proxy key, whatever the browser sent", async () => {
    const response = await fetch(`${origin}/api/personas?x=1`, {
      method: "POST",
      headers: {
        [USER_HEADER]: "someone-else",
        [PROXY_KEY_HEADER]: "guessed",
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: '{"name":"Theo"}',
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("X-Answer")).toBe("yes");
    expect(await response.text()).toBe("answer");
    const request = seen.at(-1);
    expect(request?.path).toBe("/api/personas?x=1");
    expect(request?.headers.get(USER_HEADER)).toBe("owner");
    expect(request?.headers.get(PROXY_KEY_HEADER)).toBe(PROXY_KEY);
    expect(request?.headers.get("Origin")).toBe(origin);
    expect(request?.body).toBe('{"name":"Theo"}');
  });

  it("refuses requests addressed to another name, so a rebound page gets no identity", async () => {
    const before = seen.length;
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/settings`, {
      headers: { Host: `attacker.example:${gateway.port}` },
    });
    expect(response.status).toBe(421);
    expect(seen.length).toBe(before);
  });

  it("sends a page opened by IP to its one origin, and refuses writes there", async () => {
    const page = await fetch(`http://127.0.0.1:${gateway.port}/characters?id=1`, {
      redirect: "manual",
    });
    expect(page.status).toBe(308);
    expect(page.headers.get("Location")).toBe(`${origin}/characters?id=1`);
    const write = await fetch(`http://127.0.0.1:${gateway.port}/api/personas`, {
      method: "POST",
      body: "{}",
    });
    expect(write.status).toBe(421);
  });

  it("passes redirects back instead of following them", async () => {
    const response = await fetch(`${origin}/redirect`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://portal.example/");
  });

  it("ends the server's request when the browser goes away", async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/hang`, { signal: controller.signal });
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first");
    controller.abort();
    await abortSeen;
  });
});
