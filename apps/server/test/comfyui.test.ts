import { deflateSync } from "node:zlib";
import { CREATOR_ART } from "@ephemera/core";
import { encode } from "fast-png";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createAllowlist } from "../src/comfyui/allowlist.ts";
import { createWorkflowCatalog, runWorkflow } from "../src/comfyui/catalog.ts";
import {
  type CleanupTiming,
  type ComfyuiError,
  type ComfyuiEvent,
  type ComfyuiInspection,
  createComfyui,
  type GenerateInput,
  type RecoveryTiming,
} from "../src/comfyui/client.ts";
import {
  describeWorkflow,
  discoverWorkflows,
  fillWorkflow,
  type WorkflowGraph,
} from "../src/comfyui/workflow.ts";
import { createLogger } from "../src/log.ts";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";
import { pngChunks } from "../src/png.ts";
import { type FakeComfyuiOptions, fakeComfyui, fakePng, UPSTREAM_SECRET } from "./fake-comfyui.ts";
import { pngChunk } from "./image-fixtures.ts";
import { serverRun, storeUserWorkflow, TEST_WORKFLOWS, userGraph } from "./test-workflows.ts";

/** A portrait whose IHDR byte at `offset` (8 bit depth, 9 colour type, 12 interlace) is `value`. */
function withHeaderByte(offset: number, value: number): Uint8Array {
  const png = fakePng();
  png[16 + offset] = value;
  return png;
}

/** A portrait with one more chunk after IHDR. */
const withChunk = (type: string, data: Uint8Array) => {
  const png = fakePng();
  return new Uint8Array(
    Buffer.concat([png.subarray(0, 33), pngChunk(type, data), png.subarray(33)]),
  );
};

/** The image data of a portrait `height` rows tall under a header that states the batch's height. */
function claimingBatchHeight(height: number): Uint8Array {
  const png = fakePng(CREATOR_ART.width, height);
  new DataView(png.buffer).setUint32(20, CREATOR_ART.height);
  return png;
}

/** A portrait with one more chunk right before IEND. */
const beforeEnd = (type: string, data: Uint8Array) => {
  const png = fakePng();
  const end = png.byteLength - 12;
  return new Uint8Array(
    Buffer.concat([png.subarray(0, end), pngChunk(type, data), png.subarray(end)]),
  );
};

/** An IHDR body of `width` x `height`, 8-bit RGBA. */
function ihdr(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data.set([8, 6, 0, 0, 0], 8);
  return data;
}

/**
 * What ComfyUI sends (Pillow's encoder): 8-bit RGB, its image data spread
 * over several IDAT chunks.
 */
function comfyuiPng(): Uint8Array {
  const { width, height } = CREATOR_ART;
  const encoded = encode({
    width,
    height,
    channels: 3,
    data: new Uint8Array(width * height * 3).fill(90),
  });
  const chunks = pngChunks(encoded) ?? [];
  const data = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((c) => c.data));
  const pieces = [0, 1, 2, 3].map((n) =>
    data.subarray((n * data.byteLength) / 4, ((n + 1) * data.byteLength) / 4),
  );
  const [header] = chunks;
  return new Uint8Array(
    Buffer.concat([
      encoded.subarray(0, 8),
      header?.bytes ?? new Uint8Array(),
      ...pieces.map((piece) => pngChunk("IDAT", piece)),
      pngChunk("IEND", new Uint8Array()),
    ]),
  );
}

/** Four candidates, the last of them `odd`. */
const withOdd = (odd: Uint8Array) => ({ images: [fakePng(), fakePng(), fakePng(), odd] });

const BASE = "https://comfy.test:8188";
const PROMPT = "A synthetic lighthouse keeper at dusk";
const workflows = TEST_WORKFLOWS;
const template = workflows.get(workflows.defaultWorkflow).graph;

describe("phase-aware completion and private recovery", () => {
  function recovering(
    options: FakeComfyuiOptions,
    intercept: (
      url: URL,
      response: Response,
      signal: AbortSignal | null | undefined,
    ) => Response | Promise<Response>,
    failReconnects = false,
    recoveryTiming: Partial<RecoveryTiming> = {},
  ) {
    const fake = fakeComfyui({ mode: "private", ...options });
    let sockets = 0;
    const client = createComfyui({
      fetch: async (input, init) =>
        intercept(new URL(String(input)), await fake.fetch(input, init), init?.signal),
      socket: (url, options) => {
        if (sockets++ > 0 && failReconnects) throw new Error("socket");
        return fake.socket(url, options);
      },
      apiKey: undefined,
      ca: undefined,
      allowedOrigins: [BASE],
      executionTimeoutMs: 600_000,
      timing: QUICK,
      recoveryTiming,
    });
    return { fake, client, sockets: () => sockets };
  }
  it.each(["success", "null"] as const)(
    "accepts %s alone as terminal without executed UI data",
    async (terminal) => {
      const { client, fake } = setup({ terminal });
      const events = await collect(client);
      expect(events.at(-1)?.type).toBe("images");
      expect(events).toContainEqual({ type: "progress", phase: "sending", value: 3, max: 4 });
      expect(
        events.flatMap((event) =>
          event.type === "progress" && event.phase === "running" ? [event.value] : [],
        ),
      ).toEqual([1, 10]);
      expect(events.some((event) => event.type === "progress" && event.phase === "decoding")).toBe(
        true,
      );
      expect(fake.clean()).toBe(true);
      expect(fake.state.sockets[0]?.socket.sent.map((text) => JSON.parse(text))).toContainEqual({
        type: "feature_flags",
        data: { supports_preview_metadata: true },
      });
    },
  );

  it("fails an incomplete native terminal promptly", async () => {
    const { client, fake } = setup({ terminal: "success", images: [fakePng()] });
    expect(await failure(collect(client))).toMatchObject({ reason: "invalid_output" });
    expect(fake.clean()).toBe(true);
  });

  it.each([{ silent: true }, { dropSocket: true }])(
    "recovers ordered PNGs through own completed lease: %j",
    async (options) => {
      const images = [1, 2, 3, 4].map((padding) => fakePng(undefined, undefined, padding));
      const { client, fake } = setup({ mode: "private", ...options, images });
      const events = await collect(client);
      const result = events.at(-1);
      expect(result?.type === "images" && result.pngs.map((png) => png.byteLength)).toEqual(
        images.map((png) => png.byteLength),
      );
      expect(fake.state.prompts.size).toBe(1);
      const [id] = fake.state.prompts.keys();
      expect(fake.state.controls.get(id ?? "")).toEqual({
        previews: false,
        imageOutputs: true,
        executionTimeoutSeconds: 600,
      });
      const graph = fake.state.prompts.get(id ?? "") as WorkflowGraph;
      expect(
        Object.values(graph).find((node) => node.class_type === "AtelierSaveImages")?.inputs,
      ).toEqual({
        images: template[workflows.get(workflows.defaultWorkflow).output]?.inputs.images,
        job_id: id,
      });
      expect(
        fake.state.requests.filter((request) => request.url.includes("/outputs/")),
      ).toHaveLength(4);
      expect(
        fake.state.requests.some((request) => new URL(request.url).pathname.startsWith("/history")),
      ).toBe(false);
      expect(fake.clean()).toBe(true);
    },
  );

  it("fails a completed lease with the wrong image count and releases all assets", async () => {
    const { client, fake } = setup({ mode: "private", images: [fakePng()] });
    expect(await failure(collect(client))).toMatchObject({ reason: "invalid_output" });
    expect(fake.clean()).toBe(true);
  });

  it("aborts polling without submitting twice, and releases the original job", async () => {
    const { client, fake } = setup({ mode: "private", silent: true, hang: true });
    const controller = new AbortController();
    const running = collect(client, { signal: controller.signal });
    while (
      !fake.state.requests.some(
        (request) => request.method === "GET" && /\/jobs\//.test(request.url),
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await failure(running)).toMatchObject({ reason: "aborted" });
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.clean()).toBe(true);
  });

  it.each(["failed", "released", "missing"] as const)(
    "fails promptly on lease state %s and releases it",
    async (state) => {
      const { client, fake } = recovering({ silent: true, hang: true }, (url, response) => {
        if (!/\/jobs\/[^/]+$/.test(url.pathname) || response.headers.get("Content-Type") === null)
          return response;
        return response.json().then((body: unknown) => {
          if (typeof body !== "object" || body === null || !Object.hasOwn(body, "state"))
            return Response.json(body);
          return state === "missing"
            ? new Response(null, { status: 404 })
            : Response.json({ state, outputs: [] });
        });
      });
      expect(await failure(collect(client))).toMatchObject({ reason: "execution" });
      expect(fake.state.prompts.size).toBe(1);
      expect(fake.clean()).toBe(true);
    },
  );

  it("cancels an in-flight output download and releases all PNGs", async () => {
    const downloading = Promise.withResolvers<void>();
    const controller = new AbortController();
    let aborted = false;
    const { client, fake } = recovering({}, (url, response, signal) => {
      if (!url.pathname.includes("/outputs/")) return response;
      void response.body?.cancel();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                stream.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
            downloading.resolve();
          },
        }),
        { headers: { "Content-Type": "image/png" } },
      );
    });
    const running = collect(client, { signal: controller.signal });
    await downloading.promise;
    controller.abort();
    expect(await failure(running)).toMatchObject({ reason: "aborted" });
    expect(aborted).toBe(true);
    expect(fake.clean()).toBe(true);
  });

  it("limits reconnects to three and still downloads the original completed render", async () => {
    let checks = 0;
    const { client, fake, sockets } = recovering(
      { dropSocket: true },
      async (url, response) => {
        if (!/\/jobs\/[^/]+$/.test(url.pathname)) return response;
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          Object.hasOwn(body, "state") &&
          checks++ < 4
        )
          return Response.json({ state: "running", outputs: [] });
        return Response.json(body);
      },
      true,
    );
    expect((await collect(client)).at(-1)?.type).toBe("images");
    expect(sockets()).toBe(4);
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.clean()).toBe(true);
  });

  it("validates downloaded PNG shape as strictly as native socket output", async () => {
    const { client, fake } = setup({ mode: "private", images: [fakePng(12, 18)] });
    expect(await failure(collect(client, { count: 1 }))).toMatchObject({
      reason: "invalid_output",
    });
    expect(fake.clean()).toBe(true);
  });

  it("retries a broken download while keeping the original single submission", async () => {
    let lost = 0;
    const { client, fake } = recovering({}, (url, response) => {
      if (url.pathname.includes("/outputs/") && lost++ < 2) {
        void response.body?.cancel();
        throw new TypeError("connection reset");
      }
      return response;
    });
    expect((await collect(client)).at(-1)?.type).toBe("images");
    expect(fake.state.requests.filter((request) => request.url.includes("/outputs/")).length).toBe(
      6,
    );
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.clean()).toBe(true);
  });

  it.each([
    [503, 1, 2],
    [408, 1, 2],
    [429, 1, 2],
    [503, Infinity, 3],
    [404, Infinity, 1],
    [401, Infinity, 1],
    [403, Infinity, 1],
  ])("bounds output retries for HTTP %s after %s failures", async (status, failures, attempts) => {
    let downloads = 0;
    const { client, fake } = recovering({}, (url, response) => {
      if (!url.pathname.includes("/outputs/")) return response;
      if (downloads++ >= failures) return response;
      void response.body?.cancel();
      return new Response(null, { status });
    });
    const run = collect(client, { count: 1 });
    if (failures === 1) expect((await run).at(-1)?.type).toBe("images");
    else
      expect(await failure(run)).toMatchObject({
        reason: status === 401 || status === 403 ? "unauthorized" : "unreachable",
      });
    expect(downloads).toBe(attempts);
    expect(
      fake.state.requests.filter((request) => new URL(request.url).pathname === "/prompt"),
    ).toHaveLength(1);
    expect(fake.clean()).toBe(true);
  });

  it.each([null, "invalid", { job_status: true, image_outputs: "true" }])(
    "rejects malformed required private capabilities: %j",
    async (capabilities) => {
      const { client, fake } = recovering({}, (url, response) =>
        url.pathname === "/atelier/v1/privacy"
          ? Response.json({ protocol: 2, ready: true, capabilities })
          : response,
      );
      expect(await failure(collect(client))).toMatchObject({ reason: "not_ready" });
      expect(fake.state.released).toHaveLength(0);
      expect(fake.state.controls.size).toBe(0);
      expect(
        fake.state.requests.some((request) =>
          /\/(queue|history|free)(\/|$)/.test(new URL(request.url).pathname),
        ),
      ).toBe(false);
      expect(fake.clean()).toBe(true);
    },
  );

  it("keeps submission, upload and output bodies beyond the status deadline", async () => {
    const timeout = AbortSignal.timeout;
    const deadlines = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => timeout(ms === 8_000 ? 10 : ms));
    const delayed = new Set<string>();
    const { client, fake } = recovering({}, async (url, response, signal) => {
      if (url.pathname === "/prompt" || url.pathname.includes("/inputs/")) {
        delayed.add(url.pathname);
        await new Promise((resolve) => setTimeout(resolve, 25));
        signal?.throwIfAborted();
      }
      if (!url.pathname.includes("/outputs/")) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(stream) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (signal?.aborted) stream.error(signal.reason);
            else {
              stream.enqueue(bytes);
              stream.close();
            }
          },
        }),
        { headers: response.headers },
      );
    });
    try {
      expect(
        (await collect(client, { reference: new Uint8Array(fakePng()), count: 1 })).at(-1)?.type,
      ).toBe("images");
      expect(delayed.size).toBe(2);
      expect(fake.clean()).toBe(true);
    } finally {
      deadlines.mockRestore();
    }
  });

  it.each([
    [8_000, "fetch"],
    [8_000, "body"],
    [60_000, "fetch"],
    [60_000, "body"],
  ] as const)("bounds the %s ms attempt through %s and then gives up", async (deadline, stage) => {
    const timeout = AbortSignal.timeout;
    const deadlines = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => timeout(ms === deadline ? 10 : ms));
    let attempts = 0;
    // Status reads stop at the outage bound, output reads at three tries.
    const { client, fake } = recovering(
      {},
      (url, response, signal) => {
        const target = deadline === 8_000 ? /\/jobs\/[^/]+$/ : /\/outputs\//;
        if (!target.test(url.pathname) || response.headers.get("Content-Type") === null)
          return response;
        // Lease creation has the same path as status, but no state field.
        if (deadline === 8_000 && (!fake.state.prompts.size || !fake.state.leases.size))
          return response;
        attempts++;
        void response.body?.cancel();
        const aborted = new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return stage === "fetch"
          ? aborted
          : new Response(
              new ReadableStream({
                start(stream) {
                  void aborted.catch((error: unknown) => stream.error(error));
                },
              }),
              { headers: response.headers },
            );
      },
      false,
      { statusPollMs: 5, statusOutageMs: 60 },
    );
    try {
      expect(await failure(collect(client, { count: 1 }))).toMatchObject({ reason: "unreachable" });
      if (deadline === 8_000) expect(attempts).toBeGreaterThanOrEqual(2);
      else expect(attempts).toBe(3);
      expect(fake.state.prompts.size).toBe(1);
      expect(fake.clean()).toBe(true);
    } finally {
      deadlines.mockRestore();
    }
  });

  it.each(["valid", "unrelated", "malformed"] as const)(
    "validates native metadata ownership: %s",
    async (metadata) => {
      const { client, fake } = setup({ metadata });
      if (metadata === "valid") expect((await collect(client)).at(-1)?.type).toBe("images");
      else expect(await failure(collect(client))).toMatchObject({ reason: "invalid_output" });
      expect(fake.clean()).toBe(true);
    },
  );

  it.each(["plain"] as const)(
    "accepts a delayed valid POST acknowledgement on a nonrecoverable %s worker",
    async (mode) => {
      const controller = new AbortController();
      let acknowledgementSignal: AbortSignal | null | undefined;
      const { client, fake } = recovering(
        { mode, lateSubmit: 60 },
        (url, response, signal) => {
          if (url.pathname === "/prompt") acknowledgementSignal = signal;
          return response;
        },
        false,
        { acknowledgementMs: 10 },
      );
      expect((await collect(client, { signal: controller.signal })).at(-1)?.type).toBe("images");
      expect(acknowledgementSignal?.aborted).toBe(false);
      expect(
        fake.state.requests.filter((request) => new URL(request.url).pathname === "/prompt"),
      ).toHaveLength(1);
      expect(
        fake.state.requests.some(
          (request) => request.method === "GET" && /\/jobs\//.test(request.url),
        ),
      ).toBe(false);
      expect(fake.clean()).toBe(true);
    },
  );

  it.each([
    "lost",
    "stalled_headers",
    "stalled_body",
    "accepted_500",
    "accepted_408",
    "accepted_429",
  ] as const)(
    "recovers a completed accepted POST with %s acknowledgement without resubmission",
    async (submit) => {
      const { client, fake } = recovering(
        { submit, silent: true },
        (_url, response) => response,
        false,
        { acknowledgementMs: 45, statusPollMs: 5 },
      );
      expect((await collect(client)).at(-1)?.type).toBe("images");
      expect(
        fake.state.requests.filter((request) => new URL(request.url).pathname === "/prompt"),
      ).toHaveLength(1);
      expect(fake.state.prompts.size).toBe(1);
      expect(fake.state.released).toHaveLength(1);
      expect(fake.clean()).toBe(true);
    },
  );

  it("keeps an ambiguous submission leased until delayed admission", async () => {
    const { client, fake } = recovering(
      { lateSubmit: 60, silent: true },
      (_url, response) => response,
      false,
      { acknowledgementMs: 10, statusPollMs: 5 },
    );
    expect((await collect(client)).at(-1)?.type).toBe("images");
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.state.released).toHaveLength(1);
    expect(fake.clean()).toBe(true);
  });

  it.each([
    ["refused", "rejected"],
    ["node_errors", "rejected"],
    ["other_id", "invalid_response"],
    ["malformed", "invalid_response"],
    ["unauthorized", "unauthorized"],
    ["forbidden", "unauthorized"],
  ] as const)("does not reconcile definitive %s acknowledgement", async (submit, reason) => {
    const { client, fake } = recovering({ submit }, (_url, response) => response);
    expect(await failure(collect(client))).toMatchObject({ reason });
    expect(
      fake.state.requests.some(
        (request) => request.method === "GET" && /\/jobs\//.test(request.url),
      ),
    ).toBe(false);
    expect(fake.clean()).toBe(true);
  });

  it.each(["stalled_headers", "stalled_body"] as const)(
    "caller cancellation wins over %s acknowledgement recovery",
    async (submit) => {
      const controller = new AbortController();
      const { client, fake } = recovering(
        { submit, hang: true },
        (_url, response) => response,
        false,
        { acknowledgementMs: 200 },
      );
      const running = collect(client, { signal: controller.signal });
      while (fake.state.prompts.size === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      controller.abort();
      expect(await failure(running)).toMatchObject({ reason: "aborted" });
      expect(
        fake.state.requests.some(
          (request) => request.method === "GET" && /\/jobs\//.test(request.url),
        ),
      ).toBe(false);
      expect(fake.clean()).toBe(true);
    },
  );

  it("retrieves four images concurrently and preserves lease order despite reverse completion", async () => {
    const images = [64, 65, 66, 67].map((padding) =>
      fakePng(CREATOR_ART.width, CREATOR_ART.height, padding),
    );
    let active = 0;
    let peak = 0;
    const finishes: number[] = [];
    const readers: (() => void)[] = [];
    const { client, fake } = recovering({ images }, async (url, response) => {
      if (!url.pathname.includes("/outputs/")) return response;
      const index = active++;
      peak = Math.max(peak, active);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            readers.push(() => {
              finishes.push(index);
              stream.enqueue(bytes);
              stream.close();
            });
            if (readers.length === 4) for (const finish of readers.toReversed()) finish();
          },
        }),
        { headers: response.headers },
      );
    });
    const result = (await collect(client)).at(-1);
    expect(result?.type).toBe("images");
    if (result?.type === "images") expect(result.pngs).toEqual(images);
    expect(peak).toBe(4);
    expect(finishes).toEqual([3, 2, 1, 0]);
    expect(fake.clean()).toBe(true);
  });

  it("aborts sibling output bodies on one invalid image before release", async () => {
    let downloads = 0;
    let canceled = 0;
    const { client, fake } = recovering({}, async (url, response) => {
      if (!url.pathname.includes("/outputs/")) return response;
      await response.body?.cancel();
      if (downloads++ === 0)
        return new Response(new Uint8Array([1]), { headers: response.headers });
      return new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        { headers: response.headers },
      );
    });
    expect(await failure(collect(client))).toMatchObject({ reason: "invalid_output" });
    expect(downloads).toBe(4);
    expect(canceled).toBe(3);
    expect(fake.clean()).toBe(true);
  });

  it("renews before downloading and throughout retrieval beyond the worker's 120-second grace", async () => {
    let now = 0;
    let renewedBeforeOutput = false;
    let finishOutput: (() => void) | undefined;
    const { client, fake } = recovering(
      { now: () => now },
      async (url, response) => {
        if (url.pathname.endsWith("/renew")) {
          if (now === 119_000 && response.ok) finishOutput?.();
          return response;
        }
        if (!url.pathname.includes("/outputs/")) return response;
        renewedBeforeOutput = fake.state.renewed.length > 0;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              // Advance only at body/renewal boundaries, never while PNG validation runs.
              now = 119_000;
              finishOutput = () => {
                now = 150_000;
                fake.reap();
                if (fake.state.leases.size === 0) stream.error(new Error("expired"));
                else {
                  stream.enqueue(bytes);
                  stream.close();
                }
              };
            },
          }),
          { headers: response.headers },
        );
      },
      false,
      { renewalMs: 5, statusPollMs: 5 },
    );
    expect((await collect(client, { count: 1 })).at(-1)?.type).toBe("images");
    expect(renewedBeforeOutput).toBe(true);
    expect(fake.state.renewed[0]?.at).toBe(0);
    expect(fake.state.renewed.some(({ at }) => at === 119_000)).toBe(true);
    expect(now).toBe(150_000);
    expect(fake.state.expired).toHaveLength(0);
    const renewals = fake.state.renewed.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(fake.state.renewed).toHaveLength(renewals);
    expect(fake.clean()).toBe(true);
  });

  it("does not renew past the worker's absolute 600-second terminal cap", async () => {
    let now = 0;
    let canceled = false;
    const { client, fake } = recovering(
      { now: () => now },
      async (url, response) => {
        if (url.pathname.endsWith("/renew")) {
          now += 90_000;
          return response;
        }
        if (!url.pathname.includes("/outputs/")) return response;
        await response.body?.cancel();
        return new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { headers: response.headers },
        );
      },
      false,
      { renewalMs: 5, statusPollMs: 5 },
    );
    expect(await failure(collect(client, { count: 1 }))).toMatchObject({ reason: "execution" });
    expect(now).toBeGreaterThanOrEqual(600_000);
    expect(fake.state.expired).toHaveLength(1);
    expect(canceled).toBe(true);
    expect(
      fake.state.requests.filter(
        (request) => request.method === "POST" && /\/jobs\/[^/]+$/.test(request.url),
      ),
    ).toHaveLength(1);
    expect(fake.clean()).toBe(true);
  });

  it("cannot renew an expired terminal lease", async () => {
    let now = 0;
    const { client, fake } = recovering(
      { now: () => now },
      async (url, response) => {
        if (
          /\/jobs\/[^/]+$/.test(url.pathname) &&
          ((await response.clone().json()) as { state?: string }).state === "completed"
        )
          now = 120_001;
        return response;
      },
      false,
      { statusPollMs: 5 },
    );
    expect(await failure(collect(client))).toMatchObject({
      reason: "execution",
    });
    expect(fake.state.expired).toHaveLength(1);
    expect(fake.state.renewed).toHaveLength(0);
    expect(fake.state.requests.some((request) => request.url.includes("/outputs/"))).toBe(false);
    expect(fake.clean()).toBe(true);
  });

  it("bounds terminal retrieval and cancels all bodies while renewing", async () => {
    let canceled = 0;
    const { client, fake } = recovering(
      {},
      async (url, response) => {
        if (!url.pathname.includes("/outputs/")) return response;
        await response.body?.cancel();
        return new Response(
          new ReadableStream({
            cancel() {
              canceled++;
            },
          }),
          { headers: response.headers },
        );
      },
      false,
      { terminalLimitMs: 80, statusPollMs: 5 },
    );
    expect(await failure(collect(client))).toMatchObject({ reason: "unreachable" });
    expect(canceled).toBe(4);
    expect(fake.state.requests.some((request) => request.url.endsWith("/renew"))).toBe(true);
    expect(fake.clean()).toBe(true);
  });

  it("charges acknowledgement ambiguity against the terminal retrieval budget", async () => {
    const { client, fake } = recovering(
      { submit: "stalled_body", silent: true },
      (_url, response) => response,
      false,
      { acknowledgementMs: 60, terminalLimitMs: 40, statusPollMs: 5 },
    );
    expect(await failure(collect(client))).toMatchObject({ reason: "execution" });
    expect(fake.state.requests.some((request) => request.url.includes("/outputs/"))).toBe(false);
    expect(fake.clean()).toBe(true);
  });

  it.each(["request", "terminal"] as const)(
    "bounds renewed retrieval by the original %s deadline",
    async (limit) => {
      let canceled = false;
      const { client, fake } = recovering(
        {},
        async (url, response) => {
          if (!url.pathname.includes("/outputs/")) return response;
          await response.body?.cancel();
          return new Response(
            new ReadableStream({
              cancel() {
                canceled = true;
              },
            }),
            { headers: response.headers },
          );
        },
        false,
        { renewalMs: 5, statusPollMs: 5, terminalLimitMs: limit === "terminal" ? 60 : 600_000 },
      );
      const signal = limit === "request" ? AbortSignal.timeout(90) : new AbortController().signal;
      expect(await failure(collect(client, { count: 1, signal }))).toMatchObject({
        reason: limit === "request" ? "aborted" : "unreachable",
      });
      expect(canceled).toBe(true);
      const renewals = fake.state.renewed.length;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.state.renewed).toHaveLength(renewals);
      expect(fake.clean()).toBe(true);
    },
  );

  it.each([2, Infinity])(
    "bounds transient initial renewal failures (%s) before any outputs",
    async (failures) => {
      const { client, fake } = recovering(
        { failing: { renew: failures } },
        (_url, response) => response,
        false,
        { statusPollMs: 5 },
      );
      if (failures === 2) expect((await collect(client)).at(-1)?.type).toBe("images");
      else expect(await failure(collect(client))).toMatchObject({ reason: "unreachable" });
      expect(fake.state.requests.filter((request) => request.url.endsWith("/renew"))).toHaveLength(
        3,
      );
      if (failures === Infinity)
        expect(fake.state.requests.some((request) => request.url.includes("/outputs/"))).toBe(
          false,
        );
      expect(fake.clean()).toBe(true);
    },
  );

  it.each(["success", "abort", "failure"] as const)(
    "stops an in-flight renewal body before release on %s",
    async (outcome) => {
      const renewing = Promise.withResolvers<void>();
      const controller = new AbortController();
      let renewals = 0;
      let canceled = false;
      let canceledBeforeRelease = false;
      const { client, fake } = recovering(
        {},
        async (url, response) => {
          if (url.pathname.endsWith("/renew") && ++renewals === 2) {
            await response.body?.cancel();
            return new Response(
              new ReadableStream({
                start() {
                  renewing.resolve();
                },
                cancel() {
                  canceled = true;
                },
              }),
            );
          }
          if (/\/jobs\/[^/]+$/.test(url.pathname) && fake.state.released.length > 0)
            canceledBeforeRelease = canceled;
          if (!url.pathname.includes("/outputs/")) return response;
          const bytes = new Uint8Array(await response.arrayBuffer());
          await renewing.promise;
          if (outcome === "abort") controller.abort();
          return new Response(outcome === "failure" ? new Uint8Array([1]) : bytes, {
            headers: response.headers,
          });
        },
        false,
        { renewalMs: 5, statusPollMs: 5 },
      );
      const run = collect(client, { count: 1, signal: controller.signal });
      if (outcome === "success") expect((await run).at(-1)?.type).toBe("images");
      else
        expect(await failure(run)).toMatchObject({
          reason: outcome === "abort" ? "aborted" : "invalid_output",
        });
      expect(canceledBeforeRelease).toBe(true);
      expect(renewals).toBe(2);
      expect(fake.clean()).toBe(true);
    },
  );

  it.each(["fetch", "body"] as const)(
    "bounds renewal %s stalls at three transient attempts",
    async (stage) => {
      let attempts = 0;
      const { client, fake } = recovering(
        {},
        async (url, response, signal) => {
          if (!url.pathname.endsWith("/renew")) return response;
          attempts++;
          await response.body?.cancel();
          if (stage === "body") return new Response(new ReadableStream());
          return new Promise<Response>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        false,
        { renewalTimeoutMs: 10, statusPollMs: 5 },
      );
      expect(await failure(collect(client))).toMatchObject({ reason: "unreachable" });
      expect(attempts).toBe(3);
      expect(fake.state.requests.some((request) => request.url.includes("/outputs/"))).toBe(false);
      expect(fake.clean()).toBe(true);
    },
  );

  it("keeps the recovery schema PNG-only when a worker offers video handles", async () => {
    const { client, fake } = recovering(
      {},
      async (url, response) => {
        if (!/\/jobs\/[^/]+$/.test(url.pathname)) return response;
        const status = (await response.clone().json()) as { state?: string };
        if (status.state !== "completed") return response;
        return Response.json({
          state: "completed",
          outputs: [{ id: crypto.randomUUID(), bytes: 100, mediaType: "video/mp4" }],
        });
      },
      false,
      { statusPollMs: 5 },
    );
    expect(await failure(collect(client, { count: 1 }))).toMatchObject({
      reason: "invalid_response",
    });
    expect(fake.state.requests.some((request) => request.url.includes("/outputs/"))).toBe(false);
    expect(fake.clean()).toBe(true);
  });

  it.each(["native", "mixed"] as const)(
    "accepts %s progress and deduplicates repeated node snapshots",
    async (progressMode) => {
      const { client, fake } = setup({ progressMode });
      const events = await collect(client);
      for (const value of [1, 10])
        expect(
          events.filter(
            (event) =>
              event.type === "progress" &&
              event.phase === "running" &&
              event.value === value &&
              event.max === 10,
          ),
        ).toHaveLength(1);
      expect(events).toContainEqual({ type: "progress", phase: "decoding", value: 1, max: 1 });
      expect(events).toContainEqual({ type: "progress", phase: "loading", value: 0, max: 1 });
      expect(events.at(-1)?.type).toBe("images");
      expect(JSON.parse(fake.state.sockets[0]?.socket.sent[0] ?? "{}")).toEqual({
        type: "feature_flags",
        data: { supports_preview_metadata: true },
      });
      expect(fake.clean()).toBe(true);
    },
  );

  it("ignores malformed, foreign and unknown native progress without trusting terminal node state", async () => {
    const { client, fake } = setup({
      progressEvents: (id) => {
        const node = { node_id: "7", prompt_id: id, state: "finished", value: 999, max: 999 };
        const event = (prompt_id: string, nodes: unknown) => ({
          type: "progress_state",
          data: { prompt_id, nodes },
        });
        return [
          event("foreign", { "7": node }),
          event(id, { "7": { ...node, prompt_id: "foreign" } }),
          event(id, { "7": { ...node, node_id: "8" } }),
          event(id, { "7": { ...node, value: "999" } }),
          event(id, { unknown: { ...node, node_id: "unknown" } }),
        ];
      },
    });
    const events = await collect(client);
    expect(events.some((event) => event.type === "progress" && event.value === 999)).toBe(false);
    expect(events.at(-1)?.type).toBe("images");
    expect(fake.clean()).toBe(true);
  });

  it("maps fractional native progress to public integers and keeps node completion nonterminal", async () => {
    const { client, fake } = setup({
      progressEvents: (id) => [
        {
          type: "progress_state",
          data: {
            prompt_id: id,
            nodes: {
              "4": { prompt_id: id, node_id: "4", state: "running", value: 0.75, max: 1.5 },
              "9": { prompt_id: id, node_id: "9", state: "finished", value: 4, max: 4 },
            },
          },
        },
      ],
    });
    const events = await collect(client);
    expect(events).toContainEqual({ type: "progress", phase: "loading", value: 500, max: 1_000 });
    expect(events).toContainEqual({ type: "progress", phase: "sending", value: 4, max: 4 });
    expect(events.at(-1)?.type).toBe("images");
    expect(fake.clean()).toBe(true);
  });
});

/** Cleanup's waits, short enough for a test. */
const QUICK: Partial<CleanupTiming> = { pollMs: 20, retryMs: 10, followUpPollMs: 50 };

function setup(
  options: FakeComfyuiOptions = {},
  transport = { apiKey: "", ca: "" },
  timing: Partial<CleanupTiming> = {},
  recoveryTiming: Partial<RecoveryTiming> = {},
) {
  const fake = fakeComfyui(options);
  const lines: string[] = [];
  const client = createComfyui({
    fetch: fake.fetch,
    socket: fake.socket,
    apiKey: transport.apiKey || undefined,
    ca: transport.ca || undefined,
    allowedOrigins: [BASE, "http://comfy.test:8188"],
    executionTimeoutMs: 600_000,
    log: createLogger((line) => lines.push(line)),
    timing,
    recoveryTiming,
  });
  return { fake, client, lines };
}

/** The run's events; returns or throws once its detached cleanup has ended too. */
async function collect(
  client: ReturnType<typeof setup>["client"],
  input: Partial<GenerateInput> = {},
): Promise<ComfyuiEvent[]> {
  const events: ComfyuiEvent[] = [];
  try {
    for await (const event of client.generate({
      baseUrl: BASE,
      workflow: serverRun("krea2-gonzalomo"),
      prompt: PROMPT,
      seed: 42,
      count: CREATOR_ART.count,
      signal: new AbortController().signal,
      ...input,
    })) {
      events.push(event);
    }
  } finally {
    await client.settled();
  }
  return events;
}

/** The content-free log lines of cleanups that stayed unresolved. */
const unresolved = (lines: string[]) =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "comfyui.cleanup.unresolved")
    .map(({ level, event, errorClass }) => ({ level, event, errorClass }));

async function failure(run: Promise<unknown>): Promise<ComfyuiError> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toMatchObject({ name: "ComfyuiError" });
  expect(String(error)).not.toContain(UPSTREAM_SECRET);
  expect(String(error)).not.toContain(PROMPT);
  return error as ComfyuiError;
}

describe("workflow substitution", () => {
  const values = { prompt: PROMPT, seed: 7, width: 1024, height: 1536, count: 4 };

  it.each([
    'She said "stay" and left',
    "C:\\path\\with\\backslashes \\u0041 \\n",
    "line one\nline two\r\n\ttabbed",
    "{{seed}} {{prompt}} and {{count}}",
    '"}, "9": {"class_type": "SaveImage", "inputs": {}}, "x": {"',
  ])("keeps hostile prompt text exactly and only as the prompt: %j", (prompt) => {
    const filled = fillWorkflow(template, { ...values, prompt });
    const sent = JSON.parse(JSON.stringify(filled)) as WorkflowGraph;
    expect(sent["4"]?.inputs.text).toBe(prompt);
    expect(Object.keys(sent)).toEqual(Object.keys(template));
    expect(sent["7"]?.inputs.seed).toBe(7);
    expect(JSON.stringify(sent).split(JSON.stringify(prompt)).length).toBe(2);
  });

  it("puts numbers in as numbers and leaves the rest of the graph as it was", () => {
    const filled = fillWorkflow(template, values);
    expect(filled["6"]?.inputs).toEqual({ width: 1024, height: 1536, batch_size: 4 });
    expect(filled["7"]?.inputs).toMatchObject({
      seed: 7,
      steps: 8,
      cfg: 1,
      sampler_name: "euler",
    });
    expect(filled["7"]?.inputs.positive).toEqual(["4", 0]);
    expect(JSON.stringify(filled)).not.toMatch(/\{\{\w+\}\}/);
  });

  it("refuses a template missing a placeholder or carrying an unknown one, and bad numbers", () => {
    const without = structuredClone(template);
    if (without["7"]) without["7"].inputs.seed = 1;
    expect(() => fillWorkflow(without, values)).toThrow(/lacks a placeholder/);
    const unknown = structuredClone(template);
    if (unknown["7"]) unknown["7"].inputs.steps = "{{steps}}";
    expect(() => fillWorkflow(unknown, values)).toThrow(/placeholder/);
    const embedded = structuredClone(template);
    if (embedded["4"]) embedded["4"].inputs.text = "portrait, {{prompt}}";
    expect(() => fillWorkflow(embedded, values)).toThrow(/placeholder/);
    for (const seed of [1.5, -1, Number.NaN, 2 ** 60]) {
      expect(() => fillWorkflow(template, { ...values, seed })).toThrow(RangeError);
    }
  });

  it("finds every workflow file, names it, and fills each one", () => {
    expect(workflows.list.workflows).toEqual([
      { id: "krea2-fixture", name: "Krea 2 Fixture", family: "krea2", scope: "server" },
      { id: "krea2-gonzalomo", name: "Krea 2 Gonzalomo", family: "krea2", scope: "server" },
      { id: "moss-fixture", name: "MOSS Fixture", family: "moss", scope: "server" },
    ]);
    for (const { id } of workflows.list.workflows) {
      const filled = fillWorkflow(workflows.get(id).graph, values);
      expect(JSON.stringify(filled)).not.toMatch(/\{\{\w+\}\}/);
    }
    const fallback = workflows.defaultWorkflow;
    expect(workflows.known("krea2-removed")).toBe(fallback);
    expect(workflows.known("moss-fixture")).toBe("moss-fixture");
    expect(workflows.known("moss-fixture-lenovo")).toBe(fallback);
    expect(workflows.requested("krea2-fixture", fallback)).toBe("krea2-fixture");
    expect(workflows.requested(undefined, "krea2-removed")).toBe(fallback);
    expect(workflows.requested("krea2-removed", fallback)).toBeUndefined();
    expect(() => workflows.get("krea2-removed")).toThrow();
  });

  it("gives each Krea 2 workflow a reference graph that fills only with a reference image, and MOSS none", () => {
    const krea = workflows.list.workflows
      .map(({ id }) => id)
      .filter((id) => id.startsWith("krea2-"));
    expect(krea).toEqual(["krea2-fixture", "krea2-gonzalomo"]);
    expect(workflows.referenceOf("moss-fixture")).toBeUndefined();
    for (const id of krea) {
      const reference = workflows.referenceOf(id);
      if (reference === undefined) throw new Error("no reference graph");
      expect(reference.family).toBe("krea2");
      const filled = fillWorkflow(reference.graph, { ...values, referenceImage: "lease:asset" });
      const load = Object.values(filled).filter((node) => node.class_type === "LoadImage");
      expect(load.map((node) => node.inputs.image)).toEqual(["lease:asset"]);
      expect(JSON.stringify(filled)).not.toMatch(/\{\{\w+\}\}/);
      expect(() => fillWorkflow(reference.graph, values)).toThrow(/placeholder/);
    }
    // A text graph has no image input to fill.
    expect(() => fillWorkflow(template, { ...values, referenceImage: "lease:asset" })).toThrow(
      /lacks a placeholder/,
    );
  });

  it("stops discovery at a reference graph without its workflow", () => {
    const reference = workflows.referenceOf(workflows.defaultWorkflow)?.graph;
    const found = discoverWorkflows([
      { file: "krea2-copy.json", source: template },
      { file: "krea2-copy.reference.json", source: reference },
    ]);
    expect([...found.workflows.keys()]).toEqual(["krea2-copy"]);
    expect([...found.references.keys()]).toEqual(["krea2-copy"]);
    expect(() =>
      discoverWorkflows([{ file: "krea2-stray.reference.json", source: reference }]),
    ).toThrow(/reference graph has no workflow/);
    // A reference graph must use its image input; a text graph under its name is refused.
    expect(() =>
      discoverWorkflows([
        { file: "krea2-copy.json", source: template },
        { file: "krea2-copy.reference.json", source: template },
      ]),
    ).toThrow(/not a valid workflow/);
  });

  it("knows the save node and the model files of the default workflow", () => {
    const workflow = workflows.get(workflows.defaultWorkflow);
    expect(workflow.graph[workflow.output]?.class_type).toBe("SaveImageWebsocket");
    expect(workflow.models.map((model) => model.file)).toEqual([
      "gonzalomo_krea2_v4_int8_convrot.safetensors",
      "qwen3vl_4b_bf16.safetensors",
      "qwen_image_vae.safetensors",
    ]);
  });

  it("reads a MOSS graph's save node, sampler and model-only LoRA, in loader order", () => {
    const moss = workflows.get("moss-fixture");
    expect(moss.family).toBe("moss");
    expect(moss.output).toBe("9");
    expect(moss.models.map((model) => model.file)).toEqual([
      "moss-fixture-base.safetensors",
      "fixture-moss-text-encoder.safetensors",
      "fixture-moss-vae.safetensors",
      "moss-fixture-lora.safetensors",
    ]);
  });

  it.each([1, 4])("fills a MOSS graph's %i images with literal prompt text", (count) => {
    const graph = workflows.get("moss-fixture").graph;
    const prompt = 'A "keeper"\nC:\\portraits\\{{seed}}, {{prompt}}, {{count}}';
    const filled = fillWorkflow(graph, { ...values, count, prompt });
    const sent = JSON.parse(JSON.stringify(filled)) as WorkflowGraph;
    expect(sent["4"]?.inputs.text).toBe(prompt);
    expect(sent["5"]).toEqual(graph["5"]);
    expect(sent["6"]?.inputs).toEqual({ width: 1024, height: 1536, batch_size: count });
    expect(sent["7"]?.inputs.seed).toBe(7);
    expect(Object.keys(sent)).toEqual(Object.keys(graph));
    expect(graph["4"]?.inputs.text).toBe("{{prompt}}");
  });

  it("detects model-only LoRA dependencies in a MOSS graph and every reference graph", () => {
    expect(workflows.get("moss-fixture").models).toContainEqual({
      classType: "LoraLoaderModelOnly",
      input: "lora_name",
      file: "moss-fixture-lora.safetensors",
    });
    expect(workflows.referenceOf("krea2-gonzalomo")?.models).toContainEqual({
      classType: "LoraLoaderModelOnly",
      input: "lora_name",
      file: "krea2_reid_rank32.safetensors",
    });
    expect(workflows.referenceOf("krea2-fixture")?.models).toContainEqual({
      classType: "LoraLoaderModelOnly",
      input: "lora_name",
      file: "krea2-fixture-reid.safetensors",
    });
  });
});

describe("ComfyUI status", () => {
  const status = (client: ReturnType<typeof setup>["client"], baseUrl = BASE) =>
    client.status({
      baseUrl,
      workflow: serverRun("krea2-gonzalomo"),
      signal: new AbortController().signal,
    });

  it("reports a reachable plain instance with everything installed", async () => {
    const { client } = setup();
    expect(await status(client)).toEqual({
      reachable: true,
      missingNodes: [],
      missingModels: [],
    });
  });

  it("reaches Atelier's private worker once it is ready", async () => {
    expect(await status(setup({ mode: "private" }).client)).toMatchObject({ reachable: true });
    expect(await status(setup({ mode: "private", ready: false }).client)).toEqual({
      reachable: false,
      reason: "not_ready",
    });
  });

  it("lists missing node classes and model files, in both combo formats", async () => {
    const { client } = setup({
      missingNodes: ["ModelAttentionBackend"],
      missingModels: ["qwen3vl_4b_bf16.safetensors", "qwen_image_vae.safetensors"],
    });
    expect(await status(client)).toEqual({
      reachable: true,
      missingNodes: ["ModelAttentionBackend"],
      missingModels: ["qwen3vl_4b_bf16.safetensors", "qwen_image_vae.safetensors"],
    });
  });

  it("lists a class the allowlist no longer admits among the missing nodes, though installed", async () => {
    const { client } = setup();
    expect(
      await client.status({
        baseUrl: BASE,
        workflow: { ...serverRun(), blocked: ["ModelAttentionBackend"] },
        signal: new AbortController().signal,
      }),
    ).toEqual({ reachable: true, missingNodes: ["ModelAttentionBackend"], missingModels: [] });
  });

  it("reports an unreachable, unauthorized or redirecting instance as not reachable", async () => {
    expect(await status(setup({ down: true }).client)).toEqual({
      reachable: false,
      reason: "unreachable",
    });
    expect(await status(setup({ token: "right" }).client)).toEqual({
      reachable: false,
      reason: "unauthorized",
    });
    const redirecting = setup({ redirect: true });
    expect(await status(redirecting.client)).toEqual({ reachable: false, reason: "unreachable" });
    expect(redirecting.fake.state.requests).toHaveLength(1);
    expect(await status(setup().client, "file:///etc/hosts")).toMatchObject({ reachable: false });
  });

  it("sends the token and CA on every request, only to the configured origin, never following redirects", async () => {
    const { fake, client } = setup(
      { token: "secret-token" },
      { apiKey: "secret-token", ca: "PEM" },
    );
    expect(await status(client, `${BASE}/`)).toMatchObject({ reachable: true });
    expect(fake.state.requests.map((request) => request.url)).toEqual([
      `${BASE}/atelier/v1/privacy`,
      `${BASE}/object_info`,
    ]);
    for (const request of fake.state.requests) {
      expect(request).toMatchObject({
        authorization: "Bearer secret-token",
        ca: "PEM",
        redirect: "manual",
      });
    }
  });

  it("never sends the token to a plain http address, and says so; still reaches one without a token", async () => {
    const plain = "http://comfy.test:8188";
    const withToken = setup({ token: "secret-token" }, { apiKey: "secret-token", ca: "" });
    expect(await status(withToken.client, plain)).toEqual({
      reachable: false,
      reason: "insecure",
    });
    expect(await failure(collect(withToken.client, { baseUrl: plain }))).toMatchObject({
      reason: "insecure",
    });
    expect(withToken.fake.state.requests).toEqual([]);
    expect(withToken.fake.state.sockets).toEqual([]);

    expect(await status(setup().client, plain)).toMatchObject({ reachable: true });
  });

  it("reads every `_name` combo of any class as a model file, never a sampler choice", async () => {
    const { client } = setup({ missingModels: ["euler"] });
    const graph = {
      ...serverRun().graph,
      "20": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "absent.safetensors" } },
      "21": {
        class_type: "LoadLoraModel",
        inputs: { model: ["20", 0], "loras.0.lora_name": "absent-lora.safetensors" },
      },
    };
    expect(
      await client.status({
        baseUrl: BASE,
        workflow: { ...serverRun(), graph },
        signal: new AbortController().signal,
      }),
    ).toEqual({
      reachable: true,
      missingNodes: [],
      missingModels: ["absent.safetensors", "absent-lora.safetensors"],
    });
  });

  it("reads the file inputs named off the convention, and never VAELoader's pixel_space", async () => {
    const { client } = setup();
    const graph = {
      ...serverRun().graph,
      "20": {
        class_type: "DualCLIPLoader",
        inputs: {
          clip_name1: "absent-clip-l.safetensors",
          clip_name2: "absent-t5.safetensors",
          type: "flux",
        },
      },
      "21": { class_type: "ModelPatchLoader", inputs: { name: "absent-patch.safetensors" } },
      "22": { class_type: "VAELoader", inputs: { vae_name: "pixel_space" } },
      "23": {
        class_type: "LoadLoraModel",
        inputs: {
          model: ["20", 0],
          "loras.0.lora_name": "fixture-lora.safetensors",
          "loras.0.strength": 1,
          "loras.0.enabled": true,
          "loras.1.lora_name": "absent-lora.safetensors",
          "loras.1.strength": 1,
          "loras.1.enabled": true,
        },
      },
    };
    expect(
      await client.status({
        baseUrl: BASE,
        workflow: { ...serverRun(), graph },
        signal: new AbortController().signal,
      }),
    ).toEqual({
      reachable: true,
      missingNodes: [],
      missingModels: [
        "absent-clip-l.safetensors",
        "absent-t5.safetensors",
        "absent-patch.safetensors",
        "absent-lora.safetensors",
      ],
    });
  });

  it("reads a stored graph's class the live ComfyUI reports as an output node as missing", async () => {
    const stores = createStores(openUserDatabase(undefined).db, createMemoryPortraitFiles(), {
      defaultWorkflow: TEST_WORKFLOWS.defaultWorkflow,
    });
    const { id } = storeUserWorkflow(stores.workflows, { graph: userGraph(5) });
    const workflow = runWorkflow(
      createWorkflowCatalog(TEST_WORKFLOWS, stores.workflows, createAllowlist([])),
      id,
    );
    const { client } = setup({ outputNodes: ["ModelAttentionBackend"] });
    expect(
      await client.status({ baseUrl: BASE, workflow, signal: new AbortController().signal }),
    ).toEqual({ reachable: true, missingNodes: ["ModelAttentionBackend"], missingModels: [] });
    // The private worker's own save class is its graph's output, never missing.
    expect(await status(setup({ mode: "private" }).client)).toEqual({
      reachable: true,
      missingNodes: [],
      missingModels: [],
    });
  });
});

describe("ComfyUI inspection", () => {
  const inspect = (client: ReturnType<typeof setup>["client"]) =>
    client.inspect({ baseUrl: BASE, signal: new AbortController().signal });

  it("answers each class's meta and never the raw /object_info", async () => {
    expectTypeOf<keyof Extract<ComfyuiInspection, { reachable: true }>>().toEqualTypeOf<
      "reachable" | "meta" | "missing"
    >();
    const answer = await inspect(setup().client);
    expect(answer.reachable).toBe(true);
    if (!answer.reachable) return;
    expect(answer.meta.get("SaveImageWebsocket")?.outputNode).toBe(true);
    expect(answer.meta.get("SaveImage")?.outputNode).toBe(true);
    expect(answer.meta.get("KSampler")).toMatchObject({
      outputNode: false,
      displayName: "KSampler",
      inputs: {
        model: { kind: "LINK" },
        seed: { kind: "INT", controlAfterGenerate: true },
        steps: { kind: "INT" },
        sampler_name: { kind: "COMBO", choices: ["euler"] },
      },
    });
    expect(answer.meta.get("CLIPLoader")?.inputs.clip_name).toEqual({
      kind: "COMBO",
      choices: ["qwen3vl_4b_bf16.safetensors", "other.safetensors"],
    });
    expect(Object.keys(answer)).toEqual(["reachable", "meta", "missing"]);
  });

  it("lists a graph's missing nodes and model files against the same inventory", async () => {
    const { client, fake } = setup({ missingNodes: ["ModelAttentionBackend"] });
    const answer = await inspect(client);
    if (!answer.reachable) throw new Error("not reachable");
    const graph = {
      ...serverRun().graph,
      "7": {
        class_type: "KSampler",
        inputs: { ...serverRun().graph["7"]?.inputs, sampler_name: "lms" },
      },
      "20": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "fixture-checkpoint.safetensors" },
      },
      "21": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "absent.safetensors" } },
      "22": {
        class_type: "LoadLoraModel",
        inputs: { model: ["20", 0], "loras.0.lora_name": "absent-lora.safetensors" },
      },
    };
    const before = fake.state.requests.length;
    expect(answer.missing(describeWorkflow(graph, "general"))).toEqual({
      missingNodes: ["ModelAttentionBackend"],
      missingModels: ["absent.safetensors", "absent-lora.safetensors"],
    });
    // The answer is read once; `missing` asks nothing more.
    expect(fake.state.requests.length).toBe(before);
  });

  it("answers not reachable within the status deadline", async () => {
    const timeout = AbortSignal.timeout;
    const deadlines = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => timeout(ms === 8_000 ? 20 : ms));
    try {
      expect(await inspect(setup({ down: true }).client)).toEqual({
        reachable: false,
        reason: "unreachable",
      });
      const client = createComfyui({
        fetch: (_input, init) =>
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
        apiKey: undefined,
        ca: undefined,
        allowedOrigins: [BASE],
        executionTimeoutMs: 600_000,
      });
      // As the status check says it: the deadline ended the read.
      expect(await inspect(client)).toEqual({ reachable: false, reason: "aborted" });
    } finally {
      deadlines.mockRestore();
    }
  });
});

describe("allowed origins", () => {
  it("sends nothing, the token included, to an origin the server does not allow", async () => {
    const { fake, client } = setup({ token: "secret-token" }, { apiKey: "secret-token", ca: "" });
    const elsewhere = "https://elsewhere.test:8188";
    expect(client.allows(elsewhere)).toBe(false);
    expect(client.allows(`${BASE}/comfy`)).toBe(true);
    expect(
      await client.status({
        baseUrl: elsewhere,
        workflow: serverRun("krea2-gonzalomo"),
        signal: new AbortController().signal,
      }),
    ).toEqual({ reachable: false, reason: "not_allowed" });
    expect(await failure(collect(client, { baseUrl: elsewhere }))).toMatchObject({
      reason: "not_allowed",
      code: "not_allowed",
    });
    expect(fake.state.requests).toEqual([]);
    expect(fake.state.sockets).toEqual([]);
  });

  it("does not follow a redirect to another origin, in a status check or a run", async () => {
    const { fake, client } = setup({ redirect: true });
    expect(
      await client.status({
        baseUrl: BASE,
        workflow: serverRun("krea2-gonzalomo"),
        signal: new AbortController().signal,
      }),
    ).toEqual({ reachable: false, reason: "unreachable" });
    expect(await failure(collect(client))).toMatchObject({ reason: "unreachable" });
    expect(fake.state.requests.map((request) => request.url)).toEqual([
      `${BASE}/atelier/v1/privacy`,
      `${BASE}/atelier/v1/privacy`,
    ]);
    expect(fake.state.requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(fake.state.sockets).toEqual([]);
  });
});

describe("ComfyUI generation", () => {
  it("refuses a workflow with blocked classes before any request", async () => {
    const { fake, client } = setup();
    expect(
      await failure(collect(client, { workflow: { ...serverRun(), blocked: ["OperatorNode"] } })),
    ).toMatchObject({ reason: "blocked" });
    expect(fake.state.requests).toEqual([]);
    expect(fake.state.sockets).toEqual([]);
  });

  it("streams progress, then exactly four portraits, and leaves nothing in a plain instance", async () => {
    const { fake, client } = setup();
    const events = await collect(client);
    expect(events[0]).toEqual({ type: "progress", phase: "queued", value: 0, max: 1 });
    // Once ComfyUI starts the prompt, the models load before the first step.
    expect(events[1]).toEqual({ type: "progress", phase: "loading", value: 0, max: 1 });
    expect(events[2]).toMatchObject({ type: "progress", phase: "running" });
    expect(events).toContainEqual({ type: "progress", phase: "running", value: 10, max: 10 });
    const last = events.at(-1);
    expect(last?.type).toBe("images");
    if (last?.type !== "images") return;
    expect(last.pngs).toHaveLength(CREATOR_ART.count);
    for (const png of last.pngs) expect(png).toEqual(fakePng());

    const [id, graph] = [...fake.state.prompts][0] ?? [];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((graph as WorkflowGraph)["4"]?.inputs.text).toBe(PROMPT);
    expect((graph as WorkflowGraph)["6"]?.inputs).toEqual({
      width: CREATOR_ART.width,
      height: CREATOR_ART.height,
      batch_size: CREATOR_ART.count,
    });
    // The run's history entry existed and is gone; nothing waits or runs.
    expect(fake.clean()).toBe(true);
    expect(fake.state.interrupted).toEqual([]);
    // The executor cache, which held the run's outputs, is dropped after the history entry.
    expect(fake.state.requests.slice(-2).map((request) => new URL(request.url).pathname)).toEqual([
      "/history",
      "/free",
    ]);
    expect(fake.state.freed).toEqual([{ unload_models: false, free_memory: true }]);
  });

  it("admits ComfyUI's own layout: RGB with its image data over several IDAT chunks", async () => {
    const images = Array.from({ length: CREATOR_ART.count }, comfyuiPng);
    const { client } = setup({ images });
    const last = (await collect(client)).at(-1);
    expect(last).toEqual({ type: "images", pngs: images, referenceGraph: false });
  });

  it("takes a lease on Atelier's private worker, submits under its id and releases it", async () => {
    const { fake, client } = setup(
      { mode: "private", token: "secret-token" },
      { apiKey: "secret-token", ca: "PEM" },
    );
    const events = await collect(client);
    expect(events.at(-1)).toMatchObject({ type: "images" });
    const [id] = [...fake.state.prompts.keys()];
    expect(fake.state.released).toEqual([id]);
    expect(fake.clean()).toBe(true);
    expect(fake.state.sockets[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer secret-token" },
      tls: { ca: "PEM" },
    });
    expect(fake.state.sockets[0]?.url).toMatch(/^wss:\/\/comfy\.test:8188\/ws\?clientId=/);
  });

  const batches: [string, FakeComfyuiOptions, string][] = [
    ["three images", { images: [fakePng(), fakePng(), fakePng()] }, "invalid_output"],
    ["five images", { images: Array.from({ length: 5 }, () => fakePng()) }, "invalid_output"],
    [
      "a wrong size",
      { images: [fakePng(), fakePng(1024, 1024), fakePng(), fakePng()] },
      "invalid_output",
    ],
    [
      "a JPEG",
      {
        images: [
          fakePng(),
          fakePng(),
          fakePng(),
          Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4),
        ],
      },
      "invalid_output",
    ],
    ["a palette image", withOdd(withHeaderByte(9, 3)), "invalid_output"],
    ["16-bit samples", withOdd(withHeaderByte(8, 16)), "invalid_output"],
    ["an interlaced image", withOdd(withHeaderByte(12, 1)), "invalid_output"],
    ["a suggested palette", withOdd(withChunk("PLTE", new Uint8Array(3))), "invalid_output"],
    ["an ICC profile", withOdd(withChunk("iCCP", new Uint8Array(8))), "invalid_output"],
    [
      "image data that inflates past its pixels",
      withOdd(claimingBatchHeight(CREATOR_ART.height * 2)),
      "invalid_output",
    ],
    [
      "image data cut short",
      withOdd(claimingBatchHeight(CREATOR_ART.height / 2)),
      "invalid_output",
    ],
    ["a second header", withOdd(beforeEnd("IHDR", ihdr(2 ** 28, 1))), "invalid_output"],
    [
      "data after the image's zlib stream",
      withOdd(beforeEnd("IDAT", new Uint8Array(480).fill(7))),
      "invalid_output",
    ],
    [
      "a second zlib stream",
      withOdd(beforeEnd("IDAT", deflateSync(Buffer.alloc(16)))),
      "invalid_output",
    ],
    [
      "an image over its cap",
      { images: [fakePng(1024, 1536, CREATOR_ART.imageBytes)] },
      "oversized",
    ],
    [
      "a batch over the aggregate cap",
      { images: Array.from({ length: 4 }, () => fakePng(1024, 1536, 7 * 1024 * 1024)) },
      "oversized",
    ],
    ["node errors", { submit: "node_errors" }, "rejected"],
    ["a refused graph", { submit: "refused" }, "rejected"],
    ["another prompt id", { submit: "other_id" }, "invalid_response"],
    ["an execution error", { executionError: true }, "execution"],
    ["a dropped socket", { dropSocket: true }, "socket"],
    [
      "a frame from another node over the image cap",
      { previews: [CREATOR_ART.imageBytes + 128 * 1024] },
      "oversized",
    ],
    [
      "a backlog of frames from other nodes",
      { previews: Array.from({ length: 30 }, () => 1024 * 1024) },
      "oversized",
    ],
  ];

  it.each(batches)("fails on %s and leaves nothing behind", async (_case, options, reason) => {
    const { fake, client } = setup(options);
    const error = await failure(collect(client));
    expect(error).toMatchObject({ reason, code: "comfyui" });
    expect(fake.clean()).toBe(true);
  });

  it.each(
    batches.filter(
      ([, options]) => options.submit !== "other_id" && !options.dropSocket && !options.previews,
    ),
  )("fails on %s on a private worker and releases the lease", async (_case, options, reason) => {
    const { fake, client } = setup({ ...options, mode: "private" });
    const error = await failure(collect(client));
    const privateReason =
      _case === "five images" || _case === "an image over its cap"
        ? "invalid_response"
        : _case === "a batch over the aggregate cap"
          ? "invalid_output"
          : reason;
    expect(error.reason).toBe(privateReason);
    expect(fake.state.released).toHaveLength(1);
    expect(fake.clean()).toBe(true);
  });

  it("fails without submitting when the instance is down", async () => {
    const down = setup({ down: true }, undefined, undefined, { startingMs: 20 });
    expect(await failure(collect(down.client))).toMatchObject({ reason: "unreachable" });
    expect(down.fake.state.prompts.size).toBe(0);
  });

  it("interrupts only its own running prompt when aborted mid-run, then removes it", async () => {
    const { fake, client } = setup({ hang: true });
    const controller = new AbortController();
    const run = (async () => {
      for await (const event of client.generate({
        baseUrl: BASE,
        workflow: serverRun("krea2-gonzalomo"),
        prompt: PROMPT,
        seed: 1,
        count: CREATOR_ART.count,
        signal: controller.signal,
      })) {
        if (event.type === "progress" && event.phase === "running") controller.abort();
      }
    })();
    expect(await failure(run)).toMatchObject({ reason: "aborted", code: "comfyui" });
    await client.settled();
    const [id] = [...fake.state.prompts.keys()];
    expect(fake.state.interrupted).toEqual([id]);
    expect(fake.clean()).toBe(true);
  });

  it("removes a prompt that is still stopping when the cleanup poll gives up, once it has stopped", async () => {
    const { fake, client } = setup({ hang: true, stopDelay: 5_000 });
    const controller = new AbortController();
    const run = (async () => {
      for await (const event of client.generate({
        baseUrl: BASE,
        workflow: serverRun("krea2-gonzalomo"),
        prompt: PROMPT,
        seed: 1,
        count: CREATOR_ART.count,
        signal: controller.signal,
      })) {
        if (event.type === "progress" && event.phase === "running") controller.abort();
      }
    })();
    expect(await failure(run)).toMatchObject({ reason: "aborted" });
    const [id] = [...fake.state.prompts.keys()];
    // The failure is reported at once; the run outlasts the cleanup poll and stops only later.
    expect(fake.state.running).toBe(id);
    await client.settled();
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.clean()).toBe(true);
  }, 15_000);

  /** A client whose run is aborted as soon as its submit goes out, so the submit gets no answer. */
  function abortedAtSubmit(options: FakeComfyuiOptions, timing: Partial<CleanupTiming> = QUICK) {
    const fake = fakeComfyui(options);
    const controller = new AbortController();
    const client = createComfyui({
      fetch: (input, init) => {
        const answer = fake.fetch(input, init);
        if (String(input).endsWith("/prompt")) controller.abort();
        return answer;
      },
      socket: fake.socket,
      apiKey: undefined,
      ca: undefined,
      allowedOrigins: [BASE],
      executionTimeoutMs: 600_000,
      timing,
    });
    return { fake, client, signal: controller.signal };
  }

  it("removes a prompt ComfyUI queues after its submit was aborted", async () => {
    const { fake, client, signal } = abortedAtSubmit({ lateSubmit: 100 });
    const error = await failure(collect(client, { signal }));
    expect(error).toMatchObject({ reason: "aborted" });
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.clean()).toBe(true);
  });

  it("keeps watching for a prompt ComfyUI admits seconds after its submit was aborted", async () => {
    const { fake, client, signal } = abortedAtSubmit({ lateSubmit: 3_000, hang: true });
    const run = collect(client, { signal });
    expect(await failure(run)).toMatchObject({ reason: "aborted" });
    // The follow-up found it in the queue and removed it, history and cache included.
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.clean()).toBe(true);
  }, 10_000);

  it("gives up on a prompt that never arrives at the follow-up's limit, and logs nothing", async () => {
    const { fake, client, signal } = abortedAtSubmit(
      { lateSubmit: 60_000 },
      { ...QUICK, uncertainLimitMs: 300 },
    );
    const started = performance.now();
    await failure(collect(client, { signal }));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(fake.state.prompts.size).toBe(0);
  });

  it("tries a failed history delete and cache release again", async () => {
    const { fake, client, lines } = setup({ failing: { history: 2, free: 2 } }, undefined, QUICK);
    await collect(client);
    expect(fake.clean()).toBe(true);
    expect(unresolved(lines)).toEqual([]);
  });

  it("logs a cleanup that stays unresolved, by reason only", async () => {
    const { fake, client, lines } = setup(
      { failing: { history: Number.POSITIVE_INFINITY, free: Number.POSITIVE_INFINITY } },
      undefined,
      QUICK,
    );
    await collect(client);
    expect(fake.state.history.size).toBe(1);
    expect(fake.state.cached).toBeDefined();
    expect(unresolved(lines)).toEqual([
      { level: "warn", event: "comfyui.cleanup.unresolved", errorClass: "history_delete" },
      { level: "warn", event: "comfyui.cleanup.unresolved", errorClass: "cache_release" },
    ]);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line))).toEqual(["time", "level", "event", "errorClass"]);
      expect(line).not.toContain(PROMPT);
      expect(line).not.toContain(UPSTREAM_SECRET);
      expect(line).not.toContain(BASE);
    }
  });

  it("treats a queue it cannot read as uncertain, and the follow-up stops and removes the prompt", async () => {
    const { fake, client, lines } = setup(
      { hang: true, failing: { queueRead: 1 } },
      undefined,
      QUICK,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await failure(collect(client, { signal: controller.signal }))).toMatchObject({
      reason: "aborted",
    });
    const [id] = [...fake.state.prompts.keys()];
    expect(fake.state.interrupted).toEqual([id]);
    expect(fake.clean()).toBe(true);
    expect(unresolved(lines)).toEqual([]);
  });

  it("reports a timeout at once, while cleanup still waits for a slow queue", async () => {
    const { fake, client } = setup({ hang: true, slowQueue: 1_500 });
    const started = performance.now();
    const run = (async () => {
      for await (const _event of client.generate({
        baseUrl: BASE,
        workflow: serverRun("krea2-gonzalomo"),
        prompt: PROMPT,
        seed: 1,
        count: CREATOR_ART.count,
        signal: AbortSignal.timeout(100),
      })) {
        // Progress only; the run hangs.
      }
    })();
    expect(await failure(run)).toMatchObject({ reason: "aborted", code: "timeout" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(fake.clean()).toBe(false);
    await client.settled();
    expect(fake.clean()).toBe(true);
  }, 15_000);

  it("on a timeout while queued, removes its prompt and leaves another client's running", async () => {
    const { fake, client } = setup({ busy: true });
    const error = await failure(collect(client, { signal: AbortSignal.timeout(100) }));
    expect(error).toMatchObject({ reason: "aborted", code: "timeout" });
    expect(fake.state.running).toBe("other-client-prompt");
    expect(fake.state.interrupted).toEqual([]);
    expect(fake.clean()).toBe(true);
  });

  it("tries a failed lease release again", async () => {
    const { fake, client, lines } = setup(
      { mode: "private", failing: { release: 2 } },
      undefined,
      QUICK,
    );
    await collect(client);
    expect(fake.state.released).toHaveLength(1);
    expect(fake.clean()).toBe(true);
    expect(unresolved(lines)).toEqual([]);
  });

  it("logs a lease that stays unreleased, by reason only", async () => {
    const { fake, client, lines } = setup(
      { mode: "private", failing: { release: Number.POSITIVE_INFINITY } },
      undefined,
      QUICK,
    );
    await collect(client);
    expect(fake.state.leases.size).toBe(1);
    expect(unresolved(lines)).toEqual([
      { level: "warn", event: "comfyui.cleanup.unresolved", errorClass: "lease_release" },
    ]);
  });

  it("releases the lease when a private run is aborted", async () => {
    const { fake, client } = setup({ mode: "private", hang: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await failure(collect(client, { signal: controller.signal }))).toMatchObject({
      reason: "aborted",
    });
    expect(fake.state.released).toHaveLength(1);
    expect(fake.state.running).toBeUndefined();
    expect(fake.clean()).toBe(true);
  });

  it("paints exactly the run's count", async () => {
    const { fake, client } = setup();
    const last = (await collect(client, { count: 1 })).at(-1);
    expect(last).toEqual({ type: "images", pngs: [fakePng()], referenceGraph: false });
    const [graph] = [...fake.state.prompts.values()];
    expect((graph as WorkflowGraph)["6"]?.inputs.batch_size).toBe(1);
    expect(fake.clean()).toBe(true);
  });

  it("fails a batch of more images than the run's count", async () => {
    const { fake, client } = setup({ images: [fakePng(), fakePng()] });
    expect(await failure(collect(client, { count: 1 }))).toMatchObject({
      reason: "invalid_output",
    });
    expect(fake.clean()).toBe(true);
  });

  describe("with a reference image", () => {
    const IMAGE = new Uint8Array(fakePng(64, 32));
    const sha256 = (bytes: Uint8Array) =>
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const paths = (fake: ReturnType<typeof setup>["fake"]) =>
      fake.state.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    const lines = (all: string[]) => all.map((line) => JSON.parse(line) as Record<string, unknown>);

    it("uploads it under the lease on the private worker and runs the reference graph on it", async () => {
      const { fake, client } = setup({ mode: "private" });
      const events = await collect(client, { count: 1, reference: IMAGE });
      expect(events.at(-1)).toMatchObject({ type: "images", referenceGraph: true });
      const [[id, graph] = []] = [...fake.state.prompts];
      const [upload] = fake.state.uploads;
      expect(upload).toEqual({
        lease: id,
        type: "application/octet-stream",
        bytes: IMAGE.byteLength,
        sha256: sha256(IMAGE),
      });
      const asset = paths(fake)
        .find((path) => path.startsWith("PUT "))
        ?.match(/^PUT \/atelier\/v1\/jobs\/([\w-]+)\/inputs\/([\w-]+)$/);
      expect(asset?.[1]).toBe(id);
      const nodes = Object.values(graph as WorkflowGraph);
      expect(nodes.filter((node) => node.class_type === "LoadImage")).toEqual([]);
      expect(
        nodes.filter((node) => node.class_type === "AtelierLoadImage").map((n) => n.inputs.image),
      ).toEqual([`${id}:${asset?.[2]}`]);
      expect(JSON.stringify(graph)).toContain(PROMPT);
      expect(fake.state.released).toEqual([id]);
      expect(fake.clean()).toBe(true);
    });

    it("never sends it to a plain instance, which runs the text graph", async () => {
      const { fake, client } = setup();
      const events = await collect(client, { count: 1, reference: IMAGE });
      expect(events.at(-1)).toMatchObject({ type: "images", referenceGraph: false });
      expect(paths(fake).some((path) => path.includes("/inputs/"))).toBe(false);
      const [graph] = [...fake.state.prompts.values()];
      expect(graph).toEqual(
        fillWorkflow(template, { prompt: PROMPT, seed: 42, width: 1024, height: 1536, count: 1 }),
      );
      expect(fake.clean()).toBe(true);
    });

    it("runs the text graph when the private worker lacks a reference node, and logs why", async () => {
      const {
        fake,
        client,
        lines: all,
      } = setup({
        mode: "private",
        missingNodes: ["Krea2OstrisEditModelPatch"],
      });
      const events = await collect(client, { count: 1, reference: IMAGE });
      expect(events.at(-1)).toMatchObject({ type: "images", referenceGraph: false });
      expect(fake.state.uploads).toEqual([]);
      expect(paths(fake).filter((path) => path === "GET /object_info")).toHaveLength(1);
      expect(lines(all)).toContainEqual(
        expect.objectContaining({
          event: "comfyui.reference",
          referenceGraph: false,
          errorClass: "missing_nodes",
        }),
      );
      expect(fake.clean()).toBe(true);
    });

    it("fails a reference graph the worker refuses as rejected and releases the lease", async () => {
      const { fake, client } = setup({ mode: "private", submit: "refused" });
      const error = await failure(collect(client, { count: 1, reference: IMAGE }));
      expect(error.reason).toBe("rejected");
      expect(fake.state.uploads).toHaveLength(1);
      expect(fake.state.released).toHaveLength(1);
      expect(fake.clean()).toBe(true);
    });

    it.each([
      ["refused", "upload"],
      ["lost", "upload"],
    ] as const)(
      "ends a run whose upload is %s without a submit, releasing the lease and its input",
      async (upload, reason) => {
        const { fake, client } = setup({ mode: "private", upload });
        const error = await failure(collect(client, { count: 1, reference: IMAGE }));
        expect(error.reason).toBe(reason);
        expect(fake.state.prompts.size).toBe(0);
        expect(fake.state.released).toHaveLength(1);
        expect(fake.state.inputs.size).toBe(0);
        expect(fake.clean()).toBe(true);
      },
    );

    it("releases the lease when the run is aborted during the upload", async () => {
      const { fake, client } = setup({ mode: "private", upload: "hang" });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const run = collect(client, { count: 1, reference: IMAGE, signal: controller.signal });
      expect(await failure(run)).toMatchObject({ reason: "aborted" });
      expect(fake.state.prompts.size).toBe(0);
      expect(fake.state.released).toHaveLength(1);
      expect(fake.clean()).toBe(true);
    });

    it("tries a failed release again until the input is gone", async () => {
      const {
        fake,
        client,
        lines: all,
      } = setup({ mode: "private", failing: { release: 2 } }, undefined, QUICK);
      await collect(client, { count: 1, reference: IMAGE });
      expect(fake.state.uploads).toHaveLength(1);
      expect(fake.state.released).toHaveLength(1);
      expect(fake.state.inputs.size).toBe(0);
      expect(fake.clean()).toBe(true);
      expect(unresolved(all)).toEqual([]);
    });
  });

  it("refuses a private worker that is not ready, before taking a lease or submitting", async () => {
    const { fake, client } = setup({ mode: "private", ready: false }, undefined, undefined, {
      startingMs: 20,
    });
    expect(await failure(collect(client))).toMatchObject({ reason: "not_ready" });
    expect(fake.state.prompts.size).toBe(0);
    expect(fake.clean()).toBe(true);
  });
});
