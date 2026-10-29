import { CREATOR_ART } from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import type { UpstreamFetch } from "../src/catalog.ts";
import {
  type CleanupTiming,
  createComfyui,
  type GenerateInput,
  type RecoveryTiming,
} from "../src/comfyui/client.ts";
import { createLogger } from "../src/log.ts";
import { type FakeComfyuiOptions, fakeComfyui, fakePng } from "./fake-comfyui.ts";
import { serverRun } from "./test-workflows.ts";

const BASE = "https://comfy.test:8188";
const INPUT: GenerateInput = {
  baseUrl: BASE,
  workflow: serverRun("krea2-gonzalomo"),
  prompt: "Synthetic keeper 雨",
  seed: 42,
  count: 1,
  signal: new AbortController().signal,
};
const jobPost = (url: string, method: string) => method === "POST" && /\/jobs\/[^/]+$/.test(url);

function setup(
  options: FakeComfyuiOptions = { mode: "private" },
  wrap: (fetch: UpstreamFetch) => UpstreamFetch = (fetch) => fetch,
  recoveryTiming: Partial<RecoveryTiming> = {},
  stopping?: AbortSignal,
  cleanupTiming: Partial<CleanupTiming> = {},
  executionTimeoutMs = 600_000,
) {
  const fake = fakeComfyui(options);
  const logs: string[] = [];
  const client = createComfyui({
    fetch: wrap(fake.fetch),
    socket: fake.socket,
    apiKey: undefined,
    ca: undefined,
    allowedOrigins: [BASE],
    executionTimeoutMs,
    ...(stopping === undefined ? {} : { stopping }),
    log: createLogger((line) => logs.push(line)),
    timing: {
      pollMs: 5,
      retryMs: 5,
      followUpPollMs: 5,
      uncertainLimitMs: 30,
      runningLimitMs: 30,
      ...cleanupTiming,
    },
    recoveryTiming: { statusPollMs: 5, ...recoveryTiming },
  });
  return { fake, client, logs };
}
async function collect(
  client: ReturnType<typeof createComfyui>,
  input: Partial<GenerateInput> = {},
) {
  const events = [];
  try {
    for await (const event of client.generate({ ...INPUT, ...input })) events.push(event);
    return events;
  } finally {
    await client.settled();
  }
}
const status = (client: ReturnType<typeof createComfyui>, signal = INPUT.signal, baseUrl = BASE) =>
  client.status({ baseUrl, workflow: INPUT.workflow, signal });

describe("current private admission and independent inventory reads", () => {
  it.each([
    [1, 1],
    [1_000, 1],
    [1_001, 2],
    [86_400_000, 86_400],
  ])("forwards a %s ms execution budget as %s seconds", async (milliseconds, seconds) => {
    const { client, fake } = setup(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      milliseconds,
    );
    expect((await collect(client)).at(-1)?.type).toBe("images");
    expect([...fake.state.controls.values()]).toEqual([
      { previews: false, imageOutputs: true, executionTimeoutSeconds: seconds },
    ]);
    expect(fake.clean()).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 86_400_001])(
    "rejects an invalid or unsupported %s ms budget before leasing or submission",
    async (milliseconds) => {
      const { client, fake } = setup(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        milliseconds,
      );
      await expect(collect(client)).rejects.toMatchObject({ reason: "not_ready" });
      expect(fake.state.requests.filter(({ url, method }) => jobPost(url, method))).toHaveLength(0);
      expect(fake.state.prompts.size).toBe(0);
      expect(fake.state.uploads).toHaveLength(0);
      expect(fake.state.sockets).toHaveLength(0);
    },
  );

  it("uses the fresh worker's execution limit before leasing", async () => {
    const { client, fake } = setup({ mode: "private", limits: { max_execution_seconds: 599 } });
    expect(await status(client)).toEqual({ reachable: false, reason: "not_ready" });
    await expect(collect(client)).rejects.toMatchObject({ reason: "not_ready" });
    expect(fake.state.requests.filter(({ url, method }) => jobPost(url, method))).toHaveLength(0);
    expect(fake.state.prompts.size).toBe(0);
  });

  it.each([undefined, 0, -1, 1.5, "86400"])(
    "rejects missing or malformed execution limit %s before leasing",
    async (limit) => {
      const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
        const response = await fetch(input, init);
        if (!String(input).endsWith("/privacy")) return response;
        const body = (await response.json()) as { limits: Record<string, unknown> };
        if (limit === undefined) delete body.limits.max_execution_seconds;
        else body.limits.max_execution_seconds = limit;
        return Response.json(body);
      });
      expect(await status(client)).toEqual({ reachable: false, reason: "not_ready" });
      await expect(collect(client)).rejects.toMatchObject({ reason: "not_ready" });
      expect(fake.state.requests.every(({ url }) => url.endsWith("/privacy"))).toBe(true);
    },
  );

  it("retries definite busy once, using the same lease identity and one prompt submission", async () => {
    const { client, fake } = setup({
      mode: "private",
      admission: { busyResponses: 1, retryAfter: "0" },
    });
    const events = await collect(client);
    expect(events[0]).toEqual({ type: "progress", phase: "busy", value: 0, max: 1 });
    expect(events.at(-1)?.type).toBe("images");
    const posts = fake.state.requests.filter(({ url, method }) => jobPost(url, method));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.url).toBe(posts[1]?.url);
    expect(fake.state.prompts.size).toBe(1);
    expect(fake.state.released).toHaveLength(1);
    expect(fake.clean()).toBe(true);
  });

  it.each(["caller", "shutdown", "outer", "admission"] as const)(
    "interrupts a long Retry-After wait on %s without a lease or graph",
    async (ending) => {
      const controller = new AbortController();
      const stopping = new AbortController();
      const { client, fake } = setup(
        { mode: "private", admission: { busyResponses: Infinity, retryAfter: "999999999" } },
        undefined,
        { admissionMs: ending === "admission" ? 35 : 60_000 },
        stopping.signal,
      );
      const run = client.generate({
        ...INPUT,
        signal: ending === "outer" ? AbortSignal.timeout(35) : controller.signal,
      });
      expect((await run.next()).value).toEqual({
        type: "progress",
        phase: "busy",
        value: 0,
        max: 1,
      });
      const result = run.next();
      if (ending === "caller") controller.abort();
      if (ending === "shutdown") stopping.abort();
      await expect(result).rejects.toMatchObject({
        reason: ending === "admission" ? "not_ready" : "aborted",
        code: ending === "admission" ? "comfyui_busy" : ending === "outer" ? "timeout" : "comfyui",
      });
      await client.settled();
      expect(fake.state.requests.filter(({ url, method }) => jobPost(url, method))).toHaveLength(1);
      expect(fake.state.released).toHaveLength(0);
      expect(fake.state.prompts.size).toBe(0);
    },
  );

  it("says each new waiting-list place once, and busy without a place when the worker gives none", async () => {
    const { client, fake } = setup({
      mode: "private",
      admission: {
        busyResponses: 6,
        retryAfter: "0",
        positions: ["3", "3", "2", " 1 ", undefined, "0"],
      },
    });
    const events = await collect(client);
    const waiting = events.filter((event) => event.type === "progress" && event.phase === "busy");
    expect(waiting).toEqual([
      { type: "progress", phase: "busy", value: 0, max: 1, position: 3 },
      { type: "progress", phase: "busy", value: 0, max: 1, position: 2 },
      { type: "progress", phase: "busy", value: 0, max: 1, position: 1 },
      { type: "progress", phase: "busy", value: 0, max: 1 },
    ]);
    expect(events.at(-1)?.type).toBe("images");
    const posts = fake.state.requests.filter(({ url, method }) => jobPost(url, method));
    expect(posts).toHaveLength(7);
    expect(new Set(posts.map(({ url }) => url)).size).toBe(1);
    expect(fake.clean()).toBe(true);
  });

  it.each(["-1", "1.5", "2e3", "9007199254740993", "first"])(
    "ignores a waiting-list place of %j",
    async (position) => {
      const { client } = setup({
        mode: "private",
        admission: { busyResponses: 1, retryAfter: "0", positions: [position] },
      });
      expect((await collect(client))[0]).toEqual({
        type: "progress",
        phase: "busy",
        value: 0,
        max: 1,
      });
    },
  );

  it("waits while the worker starts up, then runs once it is ready", async () => {
    const { client, fake } = setup({ mode: "private", startingAnswers: 2 });
    const events = await collect(client);
    expect(events[0]).toEqual({ type: "progress", phase: "starting", value: 0, max: 1 });
    expect(
      events.filter((event) => event.type === "progress" && event.phase === "starting"),
    ).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("images");
    expect(fake.state.requests.filter(({ url }) => url.endsWith("/privacy"))).toHaveLength(3);
    expect(fake.clean()).toBe(true);
  });

  it("waits through a worker that does not answer while it restarts", async () => {
    let refused = 2;
    const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
      if (String(input).endsWith("/privacy") && refused-- > 0)
        throw new TypeError("connection refused");
      return fetch(input, init);
    });
    const events = await collect(client);
    expect(events[0]).toEqual({ type: "progress", phase: "starting", value: 0, max: 1 });
    expect(events.at(-1)?.type).toBe("images");
    expect(fake.clean()).toBe(true);
  });

  it.each([
    ["not ready", { mode: "private", ready: false }, "not_ready"],
    ["down", { down: true }, "unreachable"],
  ] as const)("fails a worker still %s once the start-up wait ends", async (_, options, reason) => {
    let handshakes = 0;
    const { client, fake } = setup(
      options,
      (fetch) => (input, init) => {
        if (String(input).endsWith("/privacy")) handshakes++;
        return fetch(input, init);
      },
      { startingMs: 40 },
    );
    const run = client.generate(INPUT);
    expect((await run.next()).value).toEqual({
      type: "progress",
      phase: "starting",
      value: 0,
      max: 1,
    });
    await expect(run.next()).rejects.toMatchObject({ reason, code: "comfyui" });
    await client.settled();
    expect(handshakes).toBeGreaterThan(1);
    expect(fake.state.prompts.size).toBe(0);
  });

  it("ends a handshake that stalls while the worker starts at the start-up wait", async () => {
    let handshakes = 0;
    const { client, fake } = setup(
      { mode: "private", startingAnswers: 1 },
      (fetch) => (input, init) => {
        // The first handshake answers not ready; every later one never answers.
        if (!String(input).endsWith("/privacy") || handshakes++ === 0) return fetch(input, init);
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
      { startingMs: 40 },
    );
    const run = client.generate(INPUT);
    expect((await run.next()).value).toEqual({
      type: "progress",
      phase: "starting",
      value: 0,
      max: 1,
    });
    await expect(run.next()).rejects.toMatchObject({ reason: "unreachable", code: "comfyui" });
    await client.settled();
    expect(handshakes).toBe(2);
    expect(fake.state.prompts.size).toBe(0);
  });

  it("does not wait out an answered failure of the handshake", async () => {
    const { client, fake } = setup({ mode: "private", token: "secret" });
    const run = client.generate(INPUT);
    await expect(run.next()).rejects.toMatchObject({ reason: "unauthorized" });
    expect(fake.state.requests).toHaveLength(1);
  });

  it("moves to loading from the lease's state when the socket says nothing", async () => {
    const { client, fake } = setup({ mode: "private", silent: true, hang: true });
    const run = client.generate(INPUT);
    expect((await run.next()).value).toEqual({
      type: "progress",
      phase: "queued",
      value: 0,
      max: 1,
    });
    expect((await run.next()).value).toEqual({
      type: "progress",
      phase: "loading",
      value: 0,
      max: 1,
    });
    await run.return(undefined);
    await client.settled();
    expect(fake.clean()).toBe(true);
  });

  /** Status reads of the lease get no answer while `outage` says so. */
  const outage = (down: (reads: number) => boolean) => {
    let reads = 0;
    return {
      reads: () => reads,
      wrap:
        (fetch: UpstreamFetch): UpstreamFetch =>
        (input, init) => {
          if ((init?.method ?? "GET") === "GET" && /\/jobs\/[^/]+$/.test(String(input))) {
            reads++;
            if (down(reads)) return Promise.reject(new TypeError("connection reset"));
          }
          return fetch(input, init);
        },
    };
  };

  it("rides out unreachable status reads shorter than the outage bound", async () => {
    const reads = outage((n) => n <= 6);
    const { client, fake } = setup({ mode: "private", silent: true }, reads.wrap, {
      statusOutageMs: 5_000,
    });
    expect((await collect(client)).at(-1)?.type).toBe("images");
    expect(reads.reads()).toBeGreaterThan(6);
    expect(fake.clean()).toBe(true);
  });

  it("fails once unreachable status reads outlast the outage bound", async () => {
    const reads = outage(() => true);
    const { client, fake } = setup({ mode: "private", silent: true }, reads.wrap, {
      statusOutageMs: 80,
    });
    const started = performance.now();
    await expect(collect(client)).rejects.toMatchObject({ reason: "unreachable" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(80);
    expect(reads.reads()).toBeGreaterThan(3);
    expect(fake.state.released).toHaveLength(1);
  });

  it.each([500, 401, "lost", "invalid_busy"] as const)(
    "does not retry lease creation after %s",
    async (responseKind) => {
      const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
        const response = await fetch(input, init);
        if (!jobPost(String(input), init?.method ?? "GET")) return response;
        await response.body?.cancel();
        if (responseKind === "lost") throw new TypeError("lost accepted response");
        return Response.json(
          { error: "unrecognized" },
          { status: responseKind === "invalid_busy" ? 429 : responseKind },
        );
      });
      await expect(collect(client)).rejects.toMatchObject({ name: "ComfyuiError" });
      expect(fake.state.requests.filter(({ url, method }) => jobPost(url, method))).toHaveLength(1);
      expect(fake.state.prompts.size).toBe(0);
      expect(fake.state.released).toHaveLength(1);
      expect(fake.clean()).toBe(true);
    },
  );

  it("never retries or releases another job after a definitive duplicate identity", async () => {
    const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (!jobPost(String(input), init?.method ?? "GET")) return response;
      await response.body?.cancel();
      return Response.json({ error: "duplicate" }, { status: 409 });
    });
    await expect(collect(client)).rejects.toMatchObject({ reason: "unreachable" });
    expect(fake.state.requests.filter(({ url, method }) => jobPost(url, method))).toHaveLength(1);
    expect(fake.state.released).toHaveLength(0);
    expect(fake.state.prompts.size).toBe(0);
  });

  it.each([
    "job_status",
    "image_outputs",
    "preview_control",
    "lease_renewal",
    "job_admission",
    "execution_budget",
    "residency_tracking",
  ])("rejects a private worker without required %s", async (capability) => {
    const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/privacy")) return response;
      const body = (await response.json()) as { capabilities: Record<string, unknown> };
      delete body.capabilities[capability];
      return Response.json(body);
    });
    expect(await status(client)).toEqual({ reachable: false, reason: "not_ready" });
    await expect(collect(client)).rejects.toMatchObject({ reason: "not_ready" });
    expect(fake.state.requests.every(({ url }) => url.endsWith("/privacy"))).toBe(true);
  });

  it.each(["protocol", "worker_build", "allowed_nodes", "limits"])(
    "fails closed on missing private %s instead of using native mode",
    async (field) => {
      const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
        const response = await fetch(input, init);
        if (!String(input).endsWith("/privacy")) return response;
        const body = (await response.json()) as Record<string, unknown>;
        if (field === "protocol") body.protocol = 1;
        else delete body[field];
        return Response.json(body);
      });
      expect(await status(client)).toEqual({ reachable: false, reason: "not_ready" });
      await expect(collect(client)).rejects.toMatchObject({ reason: "not_ready" });
      expect(fake.state.requests.every(({ url }) => url.endsWith("/privacy"))).toBe(true);
    },
  );

  it("falls back to text when only the reference LoRA is absent and logs no filenames", async () => {
    const { client, fake, logs } = setup({
      mode: "private",
      missingModels: ["krea2_reid_rank32.safetensors"],
    });
    expect(await status(client)).toMatchObject({ reachable: true, missingModels: [] });
    expect((await collect(client, { reference: new Uint8Array(fakePng()) })).at(-1)).toMatchObject({
      referenceGraph: false,
    });
    expect(fake.state.uploads).toHaveLength(0);
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "comfyui.reference", errorClass: "missing_models" }),
    );
    expect(logs.join("")).not.toContain("safetensors");
  });

  it("uses submission allowlists even when object_info advertises a base node", async () => {
    const { client, fake } = setup({ mode: "private", allowedNodes: ["AtelierSaveImages"] });
    expect(await status(client)).toMatchObject({
      reachable: true,
      missingNodes: expect.arrayContaining(["CLIPLoader"]),
    });
    await expect(collect(client)).rejects.toMatchObject({ reason: "not_ready" });
    expect(fake.state.prompts.size).toBe(0);
    expect(fake.state.leases.size).toBe(0);
  });

  it("uses the reference allowlist and falls back to an allowed text graph", async () => {
    const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/privacy")) return response;
      const body = (await response.json()) as { allowed_nodes: string[] };
      body.allowed_nodes = body.allowed_nodes.filter((node) => node !== "AtelierLoadImage");
      return Response.json(body);
    });
    expect((await collect(client, { reference: new Uint8Array(fakePng()) })).at(-1)).toMatchObject({
      referenceGraph: false,
    });
    expect(fake.state.uploads).toHaveLength(0);
  });

  it("refuses an incompatible output count before taking a lease", async () => {
    const { client, fake } = setup({ mode: "private", limits: { max_images: 1 } });
    await expect(collect(client, { count: 4 })).rejects.toMatchObject({ reason: "not_ready" });
    expect(fake.state.leases.size).toBe(0);
    expect(fake.state.requests).toHaveLength(1);
  });

  it("tightens payload byte bounds using serialized UTF-8 without submitting", async () => {
    let bytes = 0;
    const measure = setup({ mode: "private" }, (fetch) => async (input, init) => {
      if (String(input).endsWith("/prompt"))
        bytes = new TextEncoder().encode(String(init?.body)).byteLength;
      return fetch(input, init);
    });
    await collect(measure.client);
    const limited = setup({ mode: "private", limits: { max_payload_bytes: bytes - 1 } });
    await expect(collect(limited.client)).rejects.toMatchObject({ reason: "oversized" });
    expect(limited.fake.state.prompts.size).toBe(0);
    expect(limited.fake.clean()).toBe(true);
  });

  it("cannot widen the project's image count through worker limits", async () => {
    const { client, fake } = setup({ mode: "private", limits: { max_images: 100 } });
    await expect(collect(client, { count: CREATOR_ART.count + 1 })).rejects.toMatchObject({
      name: "ComfyuiError",
    });
    expect(fake.state.prompts.size).toBe(0);
  });

  it("coalesces concurrent inventory within one client and keeps another subscriber alive on abort", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let sharedSignal: AbortSignal | null | undefined;
    const { client, fake } = setup({}, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/object_info")) {
        sharedSignal = init?.signal;
        entered.resolve();
        await release.promise;
      }
      return response;
    });
    const controller = new AbortController();
    const first = status(client, controller.signal);
    await entered.promise;
    const second = status(client, INPUT.signal, `${BASE}/`);
    await vi.waitFor(() =>
      expect(fake.state.requests.filter(({ url }) => url.endsWith("/privacy"))).toHaveLength(2),
    );
    // Let the second handshake's body parsing finish and its inventory subscription attach.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await first).toEqual({ reachable: false, reason: "aborted" });
    expect(sharedSignal?.aborted).toBe(false);
    release.resolve();
    expect(await second).toMatchObject({ reachable: true });
    expect(fake.state.requests.filter(({ url }) => url.endsWith("/object_info"))).toHaveLength(1);
    await status(client);
    expect(fake.state.requests.filter(({ url }) => url.endsWith("/object_info"))).toHaveLength(2);
  });

  it("aborts the underlying inventory body when the last subscriber leaves", async () => {
    const entered = Promise.withResolvers<void>();
    let canceled = false;
    let sharedSignal: AbortSignal | null | undefined;
    const { client } = setup({}, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/object_info")) return response;
      await response.body?.cancel();
      sharedSignal = init?.signal;
      return new Response(
        new ReadableStream({
          start() {
            entered.resolve();
          },
          cancel() {
            canceled = true;
          },
        }),
      );
    });
    const controller = new AbortController();
    const checking = status(client, controller.signal);
    await entered.promise;
    controller.abort();
    expect(await checking).toEqual({ reachable: false, reason: "aborted" });
    expect(sharedSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(canceled).toBe(true));
  });

  it("does not share inventory or readiness across independent credential owners", async () => {
    const files: string[] = [];
    const first = setup({ missingModels: files });
    const second = setup();
    expect(await status(first.client)).toMatchObject({ missingModels: [] });
    files.push("qwen_image_vae.safetensors");
    expect(await status(first.client)).toMatchObject({
      missingModels: ["qwen_image_vae.safetensors"],
    });
    expect(await status(second.client)).toMatchObject({ missingModels: [] });
    expect(
      first.fake.state.requests.filter(({ url }) => url.endsWith("/object_info")),
    ).toHaveLength(2);
    expect(
      second.fake.state.requests.filter(({ url }) => url.endsWith("/object_info")),
    ).toHaveLength(1);
  });

  it("caps a stalled reference inventory body independently of the art request", async () => {
    const nativeTimeout = AbortSignal.timeout;
    const cap = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => nativeTimeout(ms === 8_000 ? 25 : ms));
    let canceled = false;
    const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/object_info")) return response;
      await response.body?.cancel();
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      );
    });
    try {
      await expect(collect(client, { reference: new Uint8Array(fakePng()) })).rejects.toMatchObject(
        { reason: "unreachable" },
      );
      expect(canceled).toBe(true);
      expect(INPUT.signal.aborted).toBe(false);
      expect(fake.state.prompts.size).toBe(0);
    } finally {
      cap.mockRestore();
    }
  });

  it("shares only inventory when two independent requests use the same prompt and portrait", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { client, fake } = setup({ mode: "private" }, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/object_info")) {
        entered.resolve();
        await release.promise;
      }
      return response;
    });
    const input = { reference: new Uint8Array(fakePng()) };
    const first = collect(client, input);
    await entered.promise;
    const second = collect(client, input);
    await vi.waitFor(() =>
      expect(fake.state.requests.filter(({ url }) => url.endsWith("/privacy"))).toHaveLength(2),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    expect(
      (await Promise.all([first, second])).every((events) => events.at(-1)?.type === "images"),
    ).toBe(true);
    expect(fake.state.requests.filter(({ url }) => url.endsWith("/object_info"))).toHaveLength(1);
    expect(fake.state.prompts.size).toBe(2);
    expect(new Set(fake.state.uploads.map(({ lease }) => lease)).size).toBe(2);
    expect(fake.state.released).toHaveLength(2);
    expect(fake.clean()).toBe(true);
  });

  it.each([404, 405, 401, 500] as const)(
    "never falls back from native cancellation HTTP %s",
    async (nativeCancel) => {
      const { client, fake } = setup({ nativeCancel });
      const run = client.generate(INPUT);
      await run.next();
      await run.return();
      await client.settled();
      expect(fake.state.requests.some(({ url }) => /\/api\/jobs\/[^/]+\/cancel$/.test(url))).toBe(
        true,
      );
      expect(
        fake.state.requests.some(
          ({ url, method }) =>
            url.endsWith("/interrupt") || (method === "POST" && url.endsWith("/queue")),
        ),
      ).toBe(false);
    },
  );

  it("uses modern native atomic cancellation without touching another client's job", async () => {
    const { client, fake } = setup({ hang: true });
    const controller = new AbortController();
    const run = client.generate({ ...INPUT, signal: controller.signal });
    for await (const event of run) {
      if (event.type === "progress" && event.phase === "running") {
        controller.abort();
        break;
      }
    }
    await client.settled();
    expect(fake.state.requests.some(({ url }) => /\/api\/jobs\/[^/]+\/cancel$/.test(url))).toBe(
      true,
    );
    expect(fake.state.requests.some(({ url }) => url.endsWith("/interrupt"))).toBe(false);
    expect(fake.clean()).toBe(true);
  });

  it.each([
    { phase: "poll", queueRead: 0, noops: 1 },
    { phase: "followup", queueRead: 1, noops: 2 },
  ])(
    "repeats acknowledged no-op cancellation during $phase until own job leaves, preserving its successor",
    async ({ queueRead, noops }) => {
      const { client, fake } = setup(
        {
          hang: true,
          nativeCancelNoops: noops,
          nativeCancelNoopResult: false,
          failing: { queueRead },
        },
        undefined,
        undefined,
        undefined,
        { uncertainLimitMs: 200, runningLimitMs: 200 },
      );
      const run = client.generate(INPUT);
      for (;;) {
        const event = await run.next();
        if (event.value?.type === "progress" && event.value.phase === "running") break;
        expect(event.done).toBe(false);
      }
      const [own] = fake.state.prompts.keys();
      expect(own).toBeDefined();
      const successor = crypto.randomUUID();
      const post = await fake.fetch(`${BASE}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          prompt: fake.state.prompts.get(own ?? ""),
          client_id: "independent-client",
          prompt_id: successor,
        }),
      });
      expect(post.status).toBe(200);
      await post.body?.cancel();
      expect(fake.state.running).toBe(own);
      expect(fake.state.pending).toEqual([successor]);
      try {
        await run.return();
        await client.settled();
        const cancellations = fake.state.requests.filter(({ url }) =>
          /\/api\/jobs\/[^/]+\/cancel$/.test(url),
        );
        expect(cancellations.length).toBeGreaterThan(noops);
        expect(cancellations.every(({ url }) => url.endsWith(`/jobs/${own}/cancel`))).toBe(true);
        expect(new Set(fake.state.interrupted)).toEqual(new Set([own]));
        await vi.waitFor(() => expect(fake.state.running).toBe(successor));
        expect(fake.state.requests.some(({ url }) => url.endsWith("/interrupt"))).toBe(false);
        expect(fake.state.history.has(own ?? "")).toBe(false);
      } finally {
        // This independent test job belongs to the fixture, not the client's cleanup.
        await fake.fetch(`${BASE}/api/jobs/${successor}/cancel`, { method: "POST" });
      }
    },
  );

  it("repeats cancellation even when the native snapshot reports cancelled true but execution stays active", async () => {
    const { client, fake } = setup({
      hang: true,
      nativeCancelNoops: 1,
      nativeCancelNoopResult: true,
    });
    const run = client.generate(INPUT);
    await run.next();
    await run.return();
    await client.settled();
    expect(
      fake.state.requests.filter(({ url }) => /\/api\/jobs\/[^/]+\/cancel$/.test(url)).length,
    ).toBeGreaterThan(1);
    expect(fake.clean()).toBe(true);
  });

  it("waits for task_done after validated terminal output without canceling a successful native job", async () => {
    const taskDone = Promise.withResolvers<void>();
    const polled = Promise.withResolvers<void>();
    let polls = 0;
    const { client, fake } = setup(
      { beforeTaskDone: () => taskDone.promise },
      (fetch) => async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/queue") && init?.method === "GET" && ++polls === 3)
          polled.resolve();
        return response;
      },
    );
    const result = collect(client, { count: CREATOR_ART.count });
    try {
      await polled.promise;
      expect(fake.state.running).toBe([...fake.state.prompts.keys()][0]);
      expect(fake.state.history.size).toBe(0);
      expect(fake.state.interrupted).toEqual([]);
      expect(fake.state.requests.some(({ url }) => /\/api\/jobs\/[^/]+\/cancel$/.test(url))).toBe(
        false,
      );
      expect(fake.state.freed).toEqual([]);
    } finally {
      taskDone.resolve();
    }
    expect((await result).at(-1)).toMatchObject({
      type: "images",
      pngs: expect.arrayContaining([fakePng()]),
    });
    expect(fake.state.interrupted).toEqual([]);
    expect(fake.clean()).toBe(true);
  });

  it("retries safe follow-up cancellation if validated success never reaches task_done within its bounded poll", async () => {
    const taskDone = Promise.withResolvers<void>();
    const nativeTimeout = AbortSignal.timeout;
    const cap = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => nativeTimeout(ms === 4_000 ? 40 : ms));
    let initialPoll: AbortSignal | null | undefined;
    const pollAbortedAtCancel: boolean[] = [];
    const { client, fake } = setup(
      { beforeTaskDone: () => taskDone.promise, nativeCancelNoops: 1 },
      (fetch) => async (input, init) => {
        if (String(input).endsWith("/queue") && initialPoll === undefined)
          initialPoll = init?.signal;
        const response = await fetch(input, init);
        if (/\/api\/jobs\/[^/]+\/cancel$/.test(String(input))) {
          pollAbortedAtCancel.push(initialPoll?.aborted === true);
          if (pollAbortedAtCancel.length === 2) taskDone.resolve();
        }
        return response;
      },
      undefined,
      undefined,
      { runningLimitMs: 200, uncertainLimitMs: 200 },
    );
    try {
      expect((await collect(client)).at(-1)?.type).toBe("images");
      expect(pollAbortedAtCancel.length).toBeGreaterThanOrEqual(2);
      expect(pollAbortedAtCancel.every(Boolean)).toBe(true);
      expect(fake.clean()).toBe(true);
    } finally {
      taskDone.resolve();
      cap.mockRestore();
    }
  });

  it.each(["failure", "oversize"] as const)(
    "cleans validated success through own history despite permanent queue %s after late native retirement",
    async (queueFailure) => {
      const taskDone = Promise.withResolvers<void>();
      const polled = Promise.withResolvers<void>();
      let polls = 0;
      let observedHistory = false;
      const { client, fake, logs } = setup(
        { beforeTaskDone: () => taskDone.promise },
        (fetch) => async (input, init) => {
          const response = await fetch(input, init);
          const path = new URL(String(input)).pathname;
          if (/^\/history\/[^/]+$/.test(path) && fake.state.history.size > 0)
            observedHistory = true;
          if (path !== "/queue") return response;
          if (++polls === 3) polled.resolve();
          await response.body?.cancel();
          return queueFailure === "failure"
            ? new Response("synthetic upstream error", { status: 500 })
            : new Response("synthetic oversized queue", {
                headers: { "Content-Length": "1073741824" },
              });
        },
      );
      const result = collect(client);
      try {
        await polled.promise;
        expect(fake.state.running).toBe([...fake.state.prompts.keys()][0]);
        expect(fake.state.history.size).toBe(0);
        expect(fake.state.freed).toEqual([]);
        expect(
          fake.state.requests.some(
            ({ method, url }) => method === "POST" && url.endsWith("/history"),
          ),
        ).toBe(false);
        expect(fake.state.interrupted).toEqual([]);
      } finally {
        taskDone.resolve();
      }
      expect((await result).at(-1)?.type).toBe("images");
      expect(observedHistory).toBe(true);
      expect(fake.state.freed).toEqual([{ unload_models: false, free_memory: true }]);
      expect(fake.state.interrupted).toEqual([]);
      expect(fake.clean()).toBe(true);
      expect(logs).toEqual([]);
    },
  );

  it.each(["failure", "oversize", "stalled_body"] as const)(
    "attempts forget independently of queue %s at the observation bound and removes history inserted later",
    async (queueFailure) => {
      const taskDone = Promise.withResolvers<void>();
      const nativeTimeout = AbortSignal.timeout;
      const cap = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => nativeTimeout(ms === 4_000 ? 50 : ms));
      let deletesBeforeHistory = 0;
      let observedHistory = false;
      let queueBodiesCanceled = 0;
      let freeCalls = 0;
      const { client, fake, logs } = setup(
        { beforeTaskDone: () => taskDone.promise },
        (fetch) => async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/history" && init?.method === "POST" && fake.state.history.size === 0)
            deletesBeforeHistory++;
          const response = await fetch(input, init);
          if (/^\/history\/[^/]+$/.test(path) && fake.state.history.size > 0)
            observedHistory = true;
          if (path === "/free" && ++freeCalls === 1) taskDone.resolve();
          if (path !== "/queue") return response;
          await response.body?.cancel();
          if (queueFailure === "stalled_body")
            return new Response(
              new ReadableStream({
                cancel() {
                  queueBodiesCanceled++;
                },
              }),
            );
          return queueFailure === "failure"
            ? new Response("synthetic upstream error", { status: 500 })
            : new Response("synthetic oversized queue", {
                headers: { "Content-Length": "1073741824" },
              });
        },
        undefined,
        undefined,
        { runningLimitMs: 300, uncertainLimitMs: 300 },
      );
      try {
        expect((await collect(client)).at(-1)?.type).toBe("images");
        expect(deletesBeforeHistory).toBeGreaterThan(0);
        expect(observedHistory).toBe(true);
        expect(freeCalls).toBeGreaterThanOrEqual(2);
        expect(fake.state.interrupted).toEqual([]);
        expect(fake.clean()).toBe(true);
        expect(logs).toEqual([]);
        if (queueFailure === "stalled_body") expect(queueBodiesCanceled).toBeGreaterThan(0);
      } finally {
        taskDone.resolve();
        cap.mockRestore();
      }
    },
  );

  it.each([
    { outcome: "abort", queueFailure: "failure" },
    { outcome: "abort", queueFailure: "oversize" },
    { outcome: "abort", queueFailure: "stalled_body" },
    { outcome: "failure", queueFailure: "failure" },
    { outcome: "failure", queueFailure: "oversize" },
    { outcome: "failure", queueFailure: "stalled_body" },
  ] as const)(
    "reaps late $outcome history with unreadable queue ($queueFailure) and releases only the fresh retirement cache",
    async ({ outcome, queueFailure }) => {
      const taskDone = Promise.withResolvers<void>();
      const controller = new AbortController();
      const nativeTimeout = AbortSignal.timeout;
      const cap = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => nativeTimeout(ms === 4_000 ? 50 : ms));
      let observedHistory = false;
      const { client, fake, logs } = setup(
        {
          hang: outcome === "abort",
          executionError: outcome === "failure",
          beforeTaskDone: () => taskDone.promise,
        },
        (fetch) => async (input, init) => {
          const response = await fetch(input, init);
          const path = new URL(String(input)).pathname;
          if (path === "/prompt" && outcome === "abort") controller.abort();
          if (path === "/free") taskDone.resolve();
          if (/^\/history\/[^/]+$/.test(path) && fake.state.history.size > 0)
            observedHistory = true;
          if (path !== "/queue") return response;
          await response.body?.cancel();
          if (queueFailure === "stalled_body") return new Response(new ReadableStream());
          return queueFailure === "failure"
            ? new Response(INPUT.prompt, { status: 500 })
            : new Response(INPUT.prompt, { headers: { "Content-Length": "1073741824" } });
        },
        undefined,
        undefined,
        { runningLimitMs: 300, uncertainLimitMs: 300 },
      );
      try {
        await expect(collect(client, { signal: controller.signal })).rejects.toMatchObject({
          reason: outcome === "abort" ? "aborted" : "execution",
        });
        expect(fake.state.prompts.size).toBe(1);
        expect(observedHistory).toBe(true);
        expect(fake.state.freed).toEqual([
          { unload_models: false, free_memory: true },
          { unload_models: false, free_memory: true },
        ]);
        expect(fake.clean()).toBe(true);
        expect(logs).toEqual([]);
      } finally {
        taskDone.resolve();
        cap.mockRestore();
      }
    },
  );

  it.each([
    { outcome: "success", freeFailures: 0 },
    { outcome: "success", freeFailures: 3 },
    { outcome: "abort", freeFailures: 0 },
    { outcome: "abort", freeFailures: 3 },
    { outcome: "failure", freeFailures: 0 },
    { outcome: "failure", freeFailures: 3 },
  ] as const)(
    "bounds global cache release for $outcome without queue/history readback, retrying $freeFailures failed requests",
    async ({ outcome, freeFailures }) => {
      const taskDone = Promise.withResolvers<void>();
      const controller = new AbortController();
      const nativeTimeout = AbortSignal.timeout;
      const cap = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => nativeTimeout(ms === 4_000 ? 40 : ms));
      const { client, fake, logs } = setup(
        {
          hang: outcome === "abort",
          executionError: outcome === "failure",
          beforeTaskDone: () => taskDone.promise,
          failing: { free: freeFailures },
        },
        (fetch) => async (input, init) => {
          const response = await fetch(input, init);
          const path = new URL(String(input)).pathname;
          if (path === "/prompt" && outcome === "abort") controller.abort();
          if (path === "/free" && response.ok) taskDone.resolve();
          if (path !== "/queue" && !/^\/history\/[^/]+$/.test(path)) return response;
          await response.body?.cancel();
          return new Response(INPUT.prompt, { status: 500 });
        },
        undefined,
        undefined,
        { runningLimitMs: 100, uncertainLimitMs: 100 },
      );
      try {
        const result = collect(client, { signal: controller.signal });
        if (outcome === "success") expect((await result).at(-1)?.type).toBe("images");
        else
          await expect(result).rejects.toMatchObject({
            reason: outcome === "abort" ? "aborted" : "execution",
          });
        expect(fake.state.requests.filter(({ url }) => url.endsWith("/free"))).toHaveLength(
          freeFailures + 1,
        );
        expect(fake.state.freed).toEqual([{ unload_models: false, free_memory: true }]);
        expect(
          fake.state.requests.filter(
            ({ url, method }) => url.endsWith("/history") && method === "POST",
          ).length,
        ).toBeGreaterThan(1);
        expect(fake.clean()).toBe(true);
        expect(logs.map((line) => JSON.parse(line))).toContainEqual(
          expect.objectContaining({
            event: "comfyui.cleanup.unresolved",
            errorClass: "queue_unreadable",
          }),
        );
        expect(logs.join("")).not.toContain(INPUT.prompt);
      } finally {
        taskDone.resolve();
        cap.mockRestore();
      }
    },
  );

  it("spaces default native cancellation retries by a second while preserving no-op acknowledgement recovery", async () => {
    const fake = fakeComfyui({ hang: true, nativeCancelNoops: 1 });
    const canceledAt: number[] = [];
    const client = createComfyui({
      fetch: (input, init) => {
        if (/\/api\/jobs\/[^/]+\/cancel$/.test(String(input))) canceledAt.push(performance.now());
        return fake.fetch(input, init);
      },
      socket: fake.socket,
      apiKey: undefined,
      ca: undefined,
      allowedOrigins: [BASE],
      executionTimeoutMs: 600_000,
    });
    const run = client.generate(INPUT);
    for (;;) {
      const event = await run.next();
      if (event.value?.type === "progress" && event.value.phase === "running") break;
      expect(event.done).toBe(false);
    }
    await run.return();
    await client.settled();
    expect(canceledAt).toHaveLength(2);
    expect((canceledAt[1] ?? 0) - (canceledAt[0] ?? 0)).toBeGreaterThanOrEqual(900);
    expect(fake.clean()).toBe(true);
  });

  it.each([408, 429, 500, 503])(
    "watches the original plain job after HTTP %s precedes native admission without submitting again",
    async (status) => {
      const admit = Promise.withResolvers<void>();
      let submission: Promise<Response> | undefined;
      let attempts = 0;
      let admitted = false;
      let observedEmptyQueue = false;
      const { client, fake, logs } = setup(
        { hang: true },
        (fetch) => async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/prompt" && init?.method === "POST") {
            attempts++;
            const request = new Request(String(input), init);
            submission = admit.promise.then(() => {
              admitted = true;
              return fetch(request);
            });
            return new Response(INPUT.prompt, { status });
          }
          const response = await fetch(input, init);
          if (path === "/queue" && !admitted)
            observedEmptyQueue =
              fake.state.running === undefined && fake.state.pending.length === 0;
          // Admission follows the initial queue-out cleanup, never a wall-clock sleep.
          if (path === "/free") admit.resolve();
          return response;
        },
        undefined,
        undefined,
        { runningLimitMs: 300, uncertainLimitMs: 300 },
      );
      try {
        await expect(collect(client)).rejects.toMatchObject({ reason: "unreachable" });
        await (await submission)?.body?.cancel();
        expect(observedEmptyQueue).toBe(true);
        expect(attempts).toBe(1);
        expect(
          fake.state.requests.filter(({ url }) => new URL(url).pathname === "/prompt"),
        ).toHaveLength(1);
        expect(fake.state.prompts.size).toBe(1);
        const [id] = fake.state.prompts.keys();
        const cancellations = fake.state.requests.filter(({ url }) =>
          /\/api\/jobs\/[^/]+\/cancel$/.test(url),
        );
        expect(cancellations.length).toBeGreaterThan(0);
        expect(cancellations.every(({ url }) => url.endsWith(`/jobs/${id}/cancel`))).toBe(true);
        expect(fake.clean()).toBe(true);
        expect(logs).toEqual([]);
      } finally {
        admit.resolve();
        await (await submission)?.body?.cancel();
        const [id] = fake.state.prompts.keys();
        if (fake.state.running === id && id !== undefined)
          await fake.fetch(`${BASE}/api/jobs/${id}/cancel`, { method: "POST" });
      }
    },
  );
});
