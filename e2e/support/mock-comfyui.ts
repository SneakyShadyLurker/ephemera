/**
 * Mock ComfyUI for e2e tests: the server tests' fake (both modes, with its
 * recorded queue, history and lease state) behind a real HTTP and WebSocket
 * port, in memory only. Each test makes a scope of its own under
 * `/__scopes/<id>` and saves `http://127.0.0.1:<port>/c/<id>` as the address,
 * so serial groups running side by side never share one. A scope's run sends
 * as many portraits as the graph's batch (four, or a scene's one) whose
 * marks follow from the image prompt's mark (e2e/support/creator-fixtures.ts);
 * it can be told to fail or to stall, or to paint ones that differ in their
 * pixels.
 */

import type { ComfySocket } from "../../apps/server/src/comfyui/client.ts";
import { fakeComfyui } from "../../apps/server/test/fake-comfyui.ts";
import { CREATOR_ART } from "../../packages/core/src/creator/limits.ts";
import { baseOf, mark, noisyPortraitPng, portraitPng } from "./creator-fixtures.ts";
import { COMFYUI_PORT } from "./env.ts";

export interface ScopeOptions {
  mode?: "plain" | "private";
  /** The run fails inside ComfyUI after it started. */
  fail?: boolean;
  /** The run samples until it is interrupted or its lease released. */
  stall?: boolean;
  /** Each portrait's top rows are random pixels, so the four differ and each is unique to its run. */
  distinct?: true;
  /** Actual incompressible PNGs above 4MiB, within the image and batch caps. */
  large?: boolean;
  dropSocket?: boolean;
  silent?: boolean;
}

/** What a scope's fake recorded, as counts: nothing of a prompt's text leaves the mock. */
export interface ScopeState {
  /** No queued or running prompt, no history entry, no lease. */
  clean: boolean;
  pending: number;
  running: boolean;
  history: number;
  leases: number;
  released: number;
  interrupted: number;
  /** Job inputs uploaded under a lease, as a reference graph's image: the private worker's only. */
  uploads: number;
  prompts: number;
  /** Submitted graphs holding the `contains` text. */
  containing: number;
}

type Fake = ReturnType<typeof fakeComfyui>;
const scopes = new Map<string, Fake>();

/** The submitted graph's `batch_size`: four for card art, one for a scene picture. */
function batchSize(graph: unknown): number {
  const nodes = typeof graph === "object" && graph !== null ? Object.values(graph) : [];
  for (const node of nodes) {
    const inputs: unknown =
      typeof node === "object" && node !== null ? Reflect.get(node, "inputs") : undefined;
    const size: unknown =
      typeof inputs === "object" && inputs !== null ? Reflect.get(inputs, "batch_size") : undefined;
    if (typeof size === "number") return size;
  }
  return CREATOR_ART.count;
}

/** The graph's batch of portraits marked from the image prompt in it; `distinct`: noisy ones. */
function portraits(graph: unknown, distinct: boolean, large: boolean): Uint8Array[] {
  const base = baseOf(JSON.stringify(graph), "prompt") ?? "unmarked";
  const paint = distinct ? noisyPortraitPng : portraitPng;
  return Array.from({ length: batchSize(graph) }, (_, i) =>
    large
      ? noisyPortraitPng(mark(base, `img${i}`), CREATOR_ART.height)
      : paint(mark(base, `img${i}`)),
  );
}

function scopeState(fake: Fake, contains: string): ScopeState {
  const { state } = fake;
  return {
    clean: fake.clean(),
    pending: state.pending.length,
    running: state.running !== undefined,
    history: state.history.size,
    leases: state.leases.size,
    released: state.released.length,
    interrupted: state.interrupted.length,
    uploads: state.uploads.length,
    prompts: state.prompts.size,
    containing:
      contains === ""
        ? 0
        : [...state.prompts.values()].filter((graph) => JSON.stringify(graph).includes(contains))
            .length,
  };
}

/**
 * One WebSocket between the app and a scope's fake. The fake's socket is
 * made, and registered, before the upgrade is answered, so a prompt the app
 * submits once it is open finds its client; frames it sends before the
 * server side opens wait in `early`.
 */
interface Bridge {
  socket: ComfySocket;
  early: (string | ArrayBuffer)[];
  send?: (frame: string | ArrayBuffer) => void;
  close?: () => void;
}

function bridge(fake: Fake, url: string, authorization: string | null): Bridge {
  const headers: Record<string, string> =
    authorization === null ? {} : { Authorization: authorization };
  const link: Bridge = { socket: fake.socket(url, { headers }), early: [] };
  link.socket.addEventListener("message", ({ data }) => {
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) return;
    if (link.send === undefined) link.early.push(data);
    else link.send(data);
  });
  link.socket.addEventListener("close", () => link.close?.());
  link.socket.addEventListener("error", () => link.close?.());
  return link;
}

Bun.serve({
  hostname: "127.0.0.1",
  port: COMFYUI_PORT,
  idleTimeout: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    const control = /^\/__scopes\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (control !== undefined) {
      if (request.method === "PUT") {
        const options = (await request.json()) as ScopeOptions;
        scopes.set(
          control,
          fakeComfyui({
            mode: options.mode ?? "plain",
            dropSocket: options.dropSocket === true,
            silent: options.silent === true,
            executionError: options.fail === true,
            hang: options.stall === true,
            images: (graph) => portraits(graph, options.distinct === true, options.large === true),
          }),
        );
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        scopes.delete(control);
        return new Response(null, { status: 204 });
      }
      const fake = scopes.get(control);
      if (fake === undefined) return new Response(null, { status: 404 });
      return Response.json(scopeState(fake, url.searchParams.get("contains") ?? ""));
    }
    const [, scope, path] = /^\/c\/([\w-]+)(\/.*)$/.exec(url.pathname) ?? [];
    const fake = scope === undefined ? undefined : scopes.get(scope);
    if (scope === undefined || path === undefined || fake === undefined) {
      return new Response("not found", { status: 404 });
    }
    // The fake sees ComfyUI's own paths, as the client would send them to a real instance.
    const forwarded = `http://comfyui.mock${path}${url.search}`;
    if (path === "/ws") {
      const link = bridge(fake, forwarded, request.headers.get("Authorization"));
      // The fake registers its client on a timer; the app may submit as soon as it is open.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (server.upgrade(request, { data: link })) return;
      link.socket.close();
      return new Response("upgrade failed", { status: 400 });
    }
    const body = request.method === "GET" ? null : await request.arrayBuffer();
    return fake.fetch(
      new Request(forwarded, { method: request.method, headers: request.headers, body }),
    );
  },
  websocket: {
    data: {} as Bridge,
    open(ws) {
      ws.data.send = (frame) => ws.send(frame);
      ws.data.close = () => ws.close();
      for (const frame of ws.data.early.splice(0)) ws.send(frame);
    },
    message() {},
    close(ws) {
      ws.data.socket.close();
    },
  },
});
