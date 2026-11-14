import {
  type ArtStreamEvent,
  type ArtSurface,
  CREATOR_ART,
  type NodeMetaMap,
  nodeMetaFrom,
  objectInfoSchema,
  renderSizeOf,
} from "@ephemera/core";
import { z } from "zod";
import type { UpstreamFetch } from "../catalog.ts";
import { timedOut } from "../lifetime.ts";
import type { Logger } from "../log.ts";
import type { RunWorkflow } from "./catalog.ts";
import { createLease, type jobStatusSchema } from "./lease.ts";
import { createRetirement } from "./retirement.ts";
import {
  ComfyuiError,
  type ComfyuiFailure,
  discard,
  MAX_SMALL_BYTES,
  missing,
  ok,
  portraitShaped,
  privateGraph,
  readJson,
  STATUS_TIMEOUT_MS,
  sleep,
} from "./shared.ts";
import { fillWorkflow, type Workflow } from "./workflow.ts";

/*
 * The ComfyUI client for card portraits (PRINCIPLES.md 1 and 2). It sends one
 * image prompt to the address in settings and takes the batch back through
 * leased memory outputs or the native WebSocket; nothing is written anywhere.
 * On a protocol-2 private worker a job
 * lease scopes the run and its release removes it; on a plain ComfyUI the
 * client removes its own prompt from the queue and history after every run
 * and asks the instance to drop its executor cache. A reference image goes
 * only to the private worker, as an in-memory input of the job that its
 * release removes; a plain ComfyUI runs the text graph and never receives it,
 * because its upload route writes to disk. Cleanup runs detached from the
 * run, so a failure is reported at once; `settled` waits for it.
 * Failures carry a reason, never ComfyUI's text.
 */

/** Request-owned waits; tests can shorten them without changing worker retention. */
export interface RecoveryTiming {
  /** How long a run waits in a busy worker's waiting list for its lease. */
  admissionMs: number;
  /** How long a run waits for a worker that is starting up or briefly unreachable. */
  startingMs: number;
  acknowledgementMs: number;
  /** The pause between status reads, and between handshakes while the worker starts. */
  statusPollMs: number;
  /** How long status reads may stay unreachable since the last answered one. */
  statusOutageMs: number;
  renewalMs: number;
  renewalTimeoutMs: number;
  terminalLimitMs: number;
}
const RECOVERY_TIMING: RecoveryTiming = {
  admissionMs: 300_000,
  startingMs: 60_000,
  acknowledgementMs: 8_000,
  statusPollMs: 1_000,
  statusOutageMs: 30_000,
  renewalMs: 30_000,
  renewalTimeoutMs: 4_000,
  terminalLimitMs: 600_000,
};

/** The waits of cleanup; tests shorten them. */
export interface CleanupTiming {
  /** How often plain cleanup asks whether a stopped prompt has left the queue. */
  pollMs: number;
  /** The pause before a failed cleanup request is tried again. */
  retryMs: number;
  /** How often the follow-up checks the queue and the history. */
  followUpPollMs: number;
  /** A prompt still running when the poll gave up: the follow-up waits this long for it to leave. */
  runningLimitMs: number;
  /** A submit without an answer, or a queue that could not be read: the follow-up watches this long. */
  uncertainLimitMs: number;
}

const TIMING: CleanupTiming = {
  pollMs: 1_000,
  retryMs: 250,
  followUpPollMs: 1_000,
  runningLimitMs: 5 * 60_000,
  uncertainLimitMs: 60_000,
};
/** Every node and model of the install; a large one is a few megabytes. */
const MAX_OBJECT_INFO_BYTES = 32 * 1024 * 1024;
/** The whole batch, below four times the per-image cap. */
const MAX_BATCH_BYTES = CREATOR_ART.batchBytes;
/** A binary frame's envelope around its image, and room for the run's text frames. */
const FRAME_SLACK_BYTES = 64 * 1024;

/** The content-free failure (shared.ts), exported here for the client's callers. */
export { ComfyuiError };

/** The part of a WebSocket the client uses; Bun's native WebSocket satisfies it. */
export interface ComfySocket {
  binaryType: string;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
  send?(data: string): void;
}

/** Bun's WebSocket options the client sets: the bearer token and the pinned CA. */
interface ComfySocketOptions {
  headers: Record<string, string>;
  tls?: { ca: string };
}

export type ComfySocketFactory = (url: string, options: ComfySocketOptions) => ComfySocket;

/**
 * Bun's WebSocket takes headers and TLS options; the DOM typings the web app
 * compiles this module with know only protocols.
 */
type BunSocketConstructor = new (url: string, options: ComfySocketOptions) => ComfySocket;
const isSocketConstructor = (value: unknown): value is BunSocketConstructor =>
  typeof value === "function";

const bunSocket: ComfySocketFactory = (url, options) => {
  const Socket: unknown = globalThis.WebSocket;
  if (!isSocketConstructor(Socket)) throw new ComfyuiError("socket");
  return new Socket(url, options);
};

interface ComfyuiDeps {
  /** The app's one outbound fetch (app.ts); tests pass a fake. */
  fetch: UpstreamFetch;
  /** Bun's native WebSocket unless a test passes a fake. */
  socket?: ComfySocketFactory;
  /** `COMFYUI_API_KEY`: sent as a bearer token on every request and the WebSocket. */
  apiKey: string | undefined;
  /** `COMFYUI_CA_FILE`'s PEM text: the CA the instance's certificate must chain to. */
  ca: string | undefined;
  /** `COMFYUI_ALLOWED_ORIGINS`: the only origins any request or socket goes to. */
  allowedOrigins: readonly string[];
  /** The art request's deadline, also bounding private worker execution. */
  executionTimeoutMs: number;
  /** Where a cleanup that stays unresolved is reported, by reason code only. */
  log?: Logger;
  /** The process is stopping (index.ts): follow-ups make their last check at once. */
  stopping?: AbortSignal;
  timing?: Partial<CleanupTiming>;
  recoveryTiming?: Partial<RecoveryTiming>;
}

export type ComfyuiStatus =
  | { reachable: false; reason: ComfyuiFailure }
  | {
      reachable: true;
      /** Node classes of the workflow the instance does not have. */
      missingNodes: string[];
      /** Model files the workflow's loaders need that the instance does not list. */
      missingModels: string[];
    };

/**
 * What a live ComfyUI offers, read once: each class's meta and, against that
 * same answer, what a graph lacks. The raw `/object_info` never leaves the client.
 */
export type ComfyuiInspection =
  | { reachable: false; reason: ComfyuiFailure }
  | {
      reachable: true;
      meta: NodeMetaMap;
      missing(workflow: Workflow): { missingNodes: string[]; missingModels: string[] };
    };

export type ComfyuiEvent =
  | Extract<ArtStreamEvent, { type: "progress" }>
  /**
   * The last event: exactly the run's `count` of PNGs of the expected size, in
   * batch order, and whether the reference graph painted them. A one-picture
   * workflow's batch sends one such event per picture instead, each with one PNG.
   */
  | { type: "images"; pngs: Uint8Array[]; referenceGraph: boolean };

export interface GenerateInput {
  baseUrl: string;
  /** The workflow as the route resolved it when it admitted the request (catalog.ts). */
  workflow: RunWorkflow;
  /** The image prompt; a creation draft (PRINCIPLES.md 1). */
  prompt: string;
  seed: number;
  /** How many images the batch paints, at most `CREATOR_ART.count`. */
  count: number;
  /** What the batch is for; it picks the render size of a scaled template. */
  surface: ArtSurface;
  /**
   * A PNG the workflow's reference graph loads as its image input; a creation
   * draft or character data, held in memory only. Used only on Atelier's
   * private worker, and only when the workflow has a reference graph whose
   * nodes the worker has; otherwise the text graph runs without it.
   */
  reference?: Uint8Array<ArrayBuffer>;
  /**
   * The prompt the reference graph runs when it differs from the one the text
   * graph runs; a creation draft like `prompt`, held in memory only.
   */
  referencePrompt?: string;
  /** Ends the run; cleanup still runs, on its own deadline. */
  signal: AbortSignal;
}

const privacySchema = z.object({
  protocol: z.literal(2),
  ready: z.boolean(),
  capabilities: z.object({
    job_status: z.literal(true),
    image_outputs: z.literal(true),
    preview_control: z.literal(true),
    lease_renewal: z.literal(true),
    job_admission: z.literal(true),
    execution_budget: z.literal(true),
    residency_tracking: z.literal(true),
  }),
  worker_build: z.string().regex(/^[a-f0-9]{64}$/),
  allowed_nodes: z.array(z.string().min(1)),
  limits: z.object({
    max_jobs: z.int().positive(),
    max_payload_bytes: z.int().positive(),
    max_image_bytes: z.int().positive(),
    max_images: z.int().positive(),
    pre_submit_seconds: z.int().positive(),
    terminal_idle_seconds: z.int().positive(),
    terminal_max_seconds: z.int().positive(),
    max_execution_seconds: z.int().positive(),
  }),
});
export type WorkerLimits = z.infer<typeof privacySchema>["limits"];
type Privacy = z.infer<typeof privacySchema>;
type Handshake =
  | ({ mode: "plain" } & Partial<Record<keyof Privacy, never>>)
  | ({ mode: "private" } & Privacy);
const leaseSchema = z.object({ protocol: z.literal(2), ready: z.literal(true) });
const submitSchema = z.object({
  prompt_id: z.string().min(1).max(128),
  node_errors: z.record(z.string(), z.unknown()).optional(),
});
const messageSchema = z.object({
  type: z.string(),
  data: z.object({
    prompt_id: z.string().optional(),
    node: z.string().nullable().optional(),
    value: z.int().min(0).optional(),
    max: z.int().min(0).optional(),
  }),
});
/** Native progress snapshots repeat every active/finished node, not just the current one. */
const progressStateSchema = z.object({
  type: z.literal("progress_state"),
  data: z.object({
    prompt_id: z.string(),
    nodes: z.record(
      z.string(),
      z.object({
        prompt_id: z.string(),
        node_id: z.string(),
        state: z.enum(["pending", "running", "finished", "error"]),
        value: z.number().nonnegative(),
        max: z.number().positive(),
      }),
    ),
  }),
});

/** A busy worker's waiting-list place, 1 being next; anything but a positive safe integer is unknown. */
function queuePosition(header: string | null): number | undefined {
  const value = header?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const place = Number(value);
  return Number.isSafeInteger(place) && place > 0 ? place : undefined;
}

/**
 * The size a graph renders at: its family's render size for the surface and
 * the factor back to the portrait size when it scales its result down, else
 * the portrait size.
 */
function sized(
  workflow: Pick<Workflow, "family" | "scaled">,
  surface: ArtSurface,
): {
  width: number;
  height: number;
  scale?: number;
} {
  if (!workflow.scaled) return { width: CREATOR_ART.width, height: CREATOR_ART.height };
  const render = renderSizeOf(workflow.family, surface);
  return { ...render, scale: CREATOR_ART.width / render.width };
}

/** The content-free error for anything that ended a run or a status check. */
function failure(error: unknown, signal: AbortSignal): ComfyuiError {
  if (signal.aborted) {
    return new ComfyuiError("aborted", timedOut(signal) ? "timeout" : "comfyui");
  }
  return error instanceof ComfyuiError ? error : new ComfyuiError("unreachable");
}

/** The workflow as the instance runs it: on the private worker, its private graph. */
function asRun<T extends Workflow>(workflow: T, privacy: Handshake): T {
  return privacy.mode === "private"
    ? { ...workflow, graph: privateGraph(workflow.graph, "readiness") }
    : workflow;
}

/** SaveImageWebsocket's frame: event 1 (image) with format 2 (PNG), or event 4 with JSON metadata. */
function framedPng(frame: Uint8Array, promptId: string, output: string): Uint8Array | undefined {
  if (frame.byteLength <= 8) return undefined;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const event = view.getUint32(0);
  if (event === 1 && view.getUint32(4) === 2) return frame.subarray(8);
  if (event !== 4) throw new ComfyuiError("invalid_output");
  const start = 8 + view.getUint32(4);
  if (start >= frame.byteLength || start > MAX_SMALL_BYTES + 8)
    throw new ComfyuiError("invalid_output");
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(8, start)),
    );
  } catch {
    throw new ComfyuiError("invalid_output");
  }
  const parsed = z.object({ prompt_id: z.string(), node_id: z.string() }).safeParse(metadata);
  if (!parsed.success) throw new ComfyuiError("invalid_output");
  return parsed.data.prompt_id === promptId && parsed.data.node_id === output
    ? frame.subarray(start)
    : undefined;
}

type SocketEvent =
  | { kind: "open" }
  | { kind: "tick" }
  | { kind: "closed" }
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array };

const eventBytes = (event: SocketEvent) =>
  event.kind === "text" ? event.text.length : event.kind === "binary" ? event.bytes.byteLength : 0;

/**
 * Buffers socket events from the moment the socket exists, so no early frame
 * is lost. A frame over its cap, or a backlog over the batch's, fails the run
 * as oversized and closes the socket before more is held.
 */
function socketEvents(socket: ComfySocket, signal: AbortSignal, discardBinary: boolean) {
  const events: SocketEvent[] = [];
  let queued = 0;
  let oversized = false;
  let wake: (() => void) | undefined;
  const push = (event: SocketEvent) => {
    if (oversized) return;
    const bytes = eventBytes(event);
    const cap =
      event.kind === "text"
        ? MAX_SMALL_BYTES
        : event.kind === "binary"
          ? CREATOR_ART.imageBytes + FRAME_SLACK_BYTES
          : 0;
    if (bytes > cap || queued + bytes > MAX_BATCH_BYTES + FRAME_SLACK_BYTES) {
      oversized = true;
      events.length = 0;
      queued = 0;
      socket.close();
    } else {
      queued += bytes;
      events.push(event);
    }
    wake?.();
  };
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => push({ kind: "open" }));
  socket.addEventListener("close", () => push({ kind: "closed" }));
  socket.addEventListener("error", () => push({ kind: "closed" }));
  socket.addEventListener("message", ({ data }) => {
    if (typeof data === "string") push({ kind: "text", text: data });
    else if (discardBinary) return;
    else if (data instanceof ArrayBuffer) push({ kind: "binary", bytes: new Uint8Array(data) });
    else if (ArrayBuffer.isView(data)) {
      push({
        kind: "binary",
        bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      });
    }
  });
  return async (waitMs?: number): Promise<SocketEvent> => {
    for (;;) {
      signal.throwIfAborted();
      if (oversized) throw new ComfyuiError("oversized");
      const event = events.shift();
      if (event !== undefined) {
        queued -= eventBytes(event);
        return event;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => wake?.();
      let tick = false;
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener("abort", abort, { once: true });
        if (waitMs !== undefined)
          timer = setTimeout(() => {
            tick = true;
            resolve();
          }, waitMs);
      });
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      wake = undefined;
      signal.throwIfAborted();
      if (tick) return { kind: "tick" };
    }
  };
}

/** Why a cleanup ended unresolved; the log line's only detail. */
export type Unresolved =
  | "lease_release"
  | "queue_delete"
  | "history_delete"
  | "cache_release"
  | "still_queued"
  | "queue_unreadable";

export function createComfyui(deps: ComfyuiDeps) {
  const executionTimeoutSeconds = Math.ceil(deps.executionTimeoutMs / 1_000);
  const timing = { ...TIMING, ...deps.timing };
  const recoveryTiming = { ...RECOVERY_TIMING, ...deps.recoveryTiming };
  const stopping = deps.stopping ?? new AbortController().signal;
  /** Runs in progress, and cleanup still running after its run ended. */
  const pending = new Set<Promise<void>>();
  const openSocket = deps.socket ?? bunSocket;
  const authorization = deps.apiKey === undefined ? {} : { Authorization: `Bearer ${deps.apiKey}` };
  const tls = deps.ca === undefined ? {} : { tls: { ca: deps.ca } };
  const allowedOrigins = new Set(deps.allowedOrigins);
  // Only simultaneous inventory reads share work, within this credential owner.
  const inventories = new Map<
    string,
    { controller: AbortController; promise: Promise<NodeMetaMap>; subscribers: number }
  >();

  /** Whether an address may be called at all: its origin is one the server's environment allows. */
  function allows(baseUrl: string): boolean {
    return URL.canParse(baseUrl) && allowedOrigins.has(new URL(baseUrl).origin);
  }

  /**
   * The checks before anything leaves for an address, the bearer token
   * included: an allowed origin, http or https, and no token in clear text.
   */
  function checked(baseUrl: string): URL {
    if (!allows(baseUrl)) throw new ComfyuiError("not_allowed", "not_allowed");
    const base = new URL(baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new ComfyuiError("unreachable");
    }
    // The bearer token never travels in clear text; the WebSocket follows these requests.
    if (deps.apiKey !== undefined && base.protocol !== "https:") {
      throw new ComfyuiError("insecure");
    }
    return base;
  }

  /** One request to the configured instance; redirects are refused, never followed. */
  async function call(
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    init:
      | { method?: "POST" | "DELETE"; body?: unknown }
      | { method: "PUT"; bytes: Uint8Array<ArrayBuffer> } = {},
  ): Promise<Response> {
    const base = checked(baseUrl);
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
    if (url.origin !== base.origin) throw new ComfyuiError("unreachable");
    // A JSON body, raw bytes, or none.
    const payload =
      "bytes" in init
        ? { type: "application/octet-stream", body: init.bytes }
        : init.body === undefined
          ? undefined
          : { type: "application/json", body: JSON.stringify(init.body) };
    const request: RequestInit & { tls?: { ca: string } } = {
      method: init.method ?? "GET",
      headers: {
        ...authorization,
        ...(payload === undefined ? {} : { "Content-Type": payload.type }),
      },
      ...(payload === undefined ? {} : { body: payload.body }),
      redirect: "manual",
      signal,
      ...tls,
    };
    const response = await deps.fetch(url, request);
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new ComfyuiError("unreachable");
    }
    return response;
  }

  /** A request whose answer only needs to be a success. */
  async function send(
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    init: { method: "POST" | "DELETE"; body?: unknown },
  ) {
    await discard(await ok(await call(baseUrl, path, signal, init)));
  }

  /**
   * Only a missing private endpoint selects native mode; invalid private
   * handshakes fail closed. A valid private answer that is not ready yet is
   * `starting`.
   */
  async function privacyAnswer(
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<Handshake | "starting"> {
    const response = await call(baseUrl, "/atelier/v1/privacy", signal);
    if (response.status === 404) {
      await discard(response);
      return { mode: "plain" as const };
    }
    const answer = privacySchema.safeParse(
      await readJson(await ok(response), MAX_SMALL_BYTES, signal),
    );
    if (!answer.success) throw new ComfyuiError("not_ready");
    if (
      !Number.isFinite(deps.executionTimeoutMs) ||
      deps.executionTimeoutMs <= 0 ||
      !Number.isSafeInteger(executionTimeoutSeconds) ||
      executionTimeoutSeconds > answer.data.limits.max_execution_seconds
    )
      throw new ComfyuiError("not_ready");
    if (!answer.data.ready) return "starting";
    return { mode: "private" as const, ...answer.data };
  }

  async function handshake(baseUrl: string, signal: AbortSignal): Promise<Handshake> {
    const answer = await privacyAnswer(baseUrl, signal);
    if (answer === "starting") throw new ComfyuiError("not_ready");
    return answer;
  }

  /**
   * A run's handshake. While the worker starts, answering not ready or not
   * answering at all, it is asked again each status poll for up to
   * `startingMs`, said once as `starting`; after that the last failure stands.
   */
  async function* startedHandshake(
    baseUrl: string,
    signal: AbortSignal,
  ): AsyncGenerator<ComfyuiEvent, Handshake, undefined> {
    const starting = AbortSignal.any([signal, AbortSignal.timeout(recoveryTiming.startingMs)]);
    let announced = false;
    for (;;) {
      let last: ComfyuiError;
      try {
        // Each attempt ends with the start-up wait or its own deadline, so a stalled one cannot outlast either.
        const attempt = AbortSignal.any([starting, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
        const answer = await privacyAnswer(baseUrl, attempt);
        if (answer !== "starting") return answer;
        last = new ComfyuiError("not_ready");
      } catch (error) {
        // Only a request that got no answer, in time or at all, is retried; every answered failure stands.
        if (signal.aborted || error instanceof ComfyuiError) throw error;
        last = new ComfyuiError("unreachable");
      }
      if (starting.aborted) throw last;
      if (!announced) {
        announced = true;
        yield { type: "progress", phase: "starting", value: 0, max: 1 };
      }
      try {
        await sleep(recoveryTiming.statusPollMs, starting);
      } catch (error) {
        if (signal.aborted) throw error;
        throw last;
      }
    }
  }

  async function inventory(baseUrl: string, signal: AbortSignal): Promise<NodeMetaMap> {
    signal.throwIfAborted();
    const key = checked(baseUrl).href.replace(/\/+$/, "");
    let entry = inventories.get(key);
    if (entry === undefined) {
      const controller = new AbortController();
      const readSignal = AbortSignal.any([
        controller.signal,
        stopping,
        AbortSignal.timeout(STATUS_TIMEOUT_MS),
      ]);
      const owned = {
        controller,
        subscribers: 0,
        promise: (async () => {
          const response = await ok(await call(baseUrl, "/object_info", readSignal));
          const info = objectInfoSchema.safeParse(
            await readJson(response, MAX_OBJECT_INFO_BYTES, readSignal),
          );
          if (!info.success) throw new ComfyuiError("invalid_response");
          return nodeMetaFrom(info.data);
        })().finally(() => {
          if (inventories.get(key) === owned) inventories.delete(key);
        }),
      };
      inventories.set(key, owned);
      entry = owned;
    }
    const shared = entry;
    shared.subscribers++;
    let abort = () => {};
    return new Promise<NodeMetaMap>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      shared.promise.then(resolve, reject);
    }).finally(() => {
      // Each subscriber owns only its wait. The last departure cancels the read.
      signal.removeEventListener("abort", abort);
      if (--shared.subscribers === 0) {
        if (inventories.get(key) === shared) inventories.delete(key);
        shared.controller.abort();
      }
    });
  }

  /** The workflow's readiness; classes the allowlist no longer admits count as missing nodes. */
  async function status(input: {
    baseUrl: string;
    workflow: RunWorkflow;
    signal: AbortSignal;
  }): Promise<ComfyuiStatus> {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
    try {
      // Atelier's private worker must answer ready; a plain instance has no handshake.
      const privacy = await handshake(input.baseUrl, signal);
      const { workflow } = input;
      return {
        reachable: true,
        ...missing(
          asRun(workflow, privacy),
          await inventory(input.baseUrl, signal),
          privacy.allowed_nodes,
          workflow.blocked,
        ),
      };
    } catch (error) {
      return { reachable: false, reason: failure(error, signal).reason };
    }
  }

  /**
   * The instance's node meta and a `missing` that answers any graph against
   * that one `/object_info` answer, within the status deadline. The server's
   * allowlist is the caller's to apply.
   */
  async function inspect(input: {
    baseUrl: string;
    signal: AbortSignal;
  }): Promise<ComfyuiInspection> {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
    try {
      const privacy = await handshake(input.baseUrl, signal);
      const meta = await inventory(input.baseUrl, signal);
      return {
        reachable: true,
        meta,
        missing: (workflow) => missing(asRun(workflow, privacy), meta, privacy.allowed_nodes),
      };
    } catch (error) {
      return { reachable: false, reason: failure(error, signal).reason };
    }
  }

  /**
   * Runs cleanup apart from the run that needs it; a failure inside it is
   * already handled. The promise settles when the cleanup has ended and never
   * rejects, for a caller that must not start before it.
   */
  function detach(work: () => Promise<void>): Promise<void> {
    const running: Promise<void> = work()
      .catch(() => {})
      .then(() => {
        pending.delete(running);
      });
    pending.add(running);
    return running;
  }

  /** Every run and every cleanup started so far has ended, follow-ups included. */
  async function settled() {
    while (pending.size > 0) await Promise.all(pending);
  }

  const { clean, retried, unresolved } = createRetirement({
    timing,
    stopping,
    log: deps.log,
    call,
    send,
  });
  const { usableReference, upload, jobStatus, retrieve, release } = createLease({
    timing,
    recoveryTiming,
    log: deps.log,
    call,
    send,
    inventory,
    retried,
    unresolved,
  });

  /**
   * One batch: progress while ComfyUI works, then exactly `count` PNGs, or a
   * ComfyuiError. A workflow whose text graph paints one picture per run
   * paints a batch above one as that many jobs in turn, each with its own
   * seed: run i takes the chosen seed plus i, its progress names its picture,
   * and its one PNG is passed on as soon as it is in. On a private worker the
   * next job asks for its lease only once the last one's release has ended,
   * since the worker holds one job at a time and would call the batch's own
   * next picture busy. A stop between two runs submits no further job.
   */
  async function* generate(input: GenerateInput): AsyncGenerator<ComfyuiEvent, void, undefined> {
    if (!input.workflow.single || input.count === 1) {
      yield* job(input);
      return;
    }
    const signal = AbortSignal.any([input.signal, stopping]);
    let size = 0;
    for (let index = 0; index < input.count; index++) {
      if (signal.aborted) throw failure(signal.reason, signal);
      const picture = { number: index + 1, of: input.count };
      let released: Promise<void> | undefined;
      for await (const event of job(
        { ...input, count: 1, seed: (input.seed + index) % 2 ** 32 },
        (cleanup) => {
          released = cleanup;
        },
      )) {
        if (event.type === "progress") {
          yield { ...event, picture };
          continue;
        }
        size += event.pngs.reduce((total, png) => total + png.byteLength, 0);
        if (size > MAX_BATCH_BYTES) throw new ComfyuiError("oversized");
        yield event;
      }
      await released;
    }
  }

  /**
   * One job: progress while ComfyUI works, then exactly `count` PNGs, or a
   * ComfyuiError. The WebSocket opens before the prompt is submitted under a
   * client-chosen id (the lease id on a private worker), so cleanup never
   * depends on the submit answer. With a reference image, the private worker
   * runs the workflow's reference graph on it, uploaded under the lease.
   * `released` receives the lease release of a private worker's job when one
   * is started; a plain instance's cleanup is not handed out, since no later
   * job waits for it.
   */
  async function* job(
    input: GenerateInput,
    released?: (cleanup: Promise<void>) => void,
  ): AsyncGenerator<ComfyuiEvent, void, undefined> {
    const { baseUrl } = input;
    const signal = AbortSignal.any([input.signal, stopping]);
    const { workflow } = input;
    // The routes refuse a blocked workflow already; the run boundary holds the rule too.
    if (workflow.blocked.length > 0) throw new ComfyuiError("blocked");
    /** The save node of the graph that runs, and whether it is the reference graph. */
    let output = workflow.output;
    let referenceGraph = false;
    const promptId = crypto.randomUUID();
    const clientId = crypto.randomUUID();
    let mode: "private" | "plain" | undefined;
    let leaseMayExist = false;
    /** Prompt identities to remove from a plain instance, including a mismatched acknowledgement. */
    const submitted: string[] = [];
    /** The submit answered definitively; an ambiguous outcome may still queue the prompt later. */
    let answered = false;
    let completed = false;
    let socket: ComfySocket | undefined;
    // A run counts as pending until its cleanup is detached, so a stop waits for that cleanup too.
    const { promise: running, resolve: ran } = Promise.withResolvers<void>();
    pending.add(running);
    try {
      const values = {
        prompt: input.prompt,
        seed: input.seed,
        count: input.count,
      };
      let graph = fillWorkflow(workflow.graph, {
        ...values,
        ...sized(workflow, input.surface),
      });
      const privacy = yield* startedHandshake(baseUrl, signal);
      mode = privacy.mode;
      const recoverable = privacy.mode === "private";
      if (
        input.count > Math.min(CREATOR_ART.count, privacy.limits?.max_images ?? CREATOR_ART.count)
      )
        throw new ComfyuiError("not_ready");
      // The reference graph runs only on the private worker; a plain ComfyUI never receives the image.
      const reference =
        mode === "private" && input.reference !== undefined
          ? await usableReference(baseUrl, input.workflow, signal, privacy.allowed_nodes)
          : undefined;
      const candidate = privateGraph(reference?.graph ?? graph, recoverable ? promptId : undefined);
      if (
        privacy.allowed_nodes !== undefined &&
        Object.values(candidate).some((node) => !privacy.allowed_nodes?.includes(node.class_type))
      )
        throw new ComfyuiError("not_ready");
      if (mode === "private") {
        const admission = AbortSignal.any([
          signal,
          AbortSignal.timeout(recoveryTiming.admissionMs),
        ]);
        let waiting = false;
        /** The waiting-list place last said; undefined when the worker does not say it. */
        let position: number | undefined;
        try {
          for (;;) {
            admission.throwIfAborted();
            // An unanswered POST might have created a lease. Only definite busy permits another POST.
            leaseMayExist = true;
            const response = await call(baseUrl, `/atelier/v1/jobs/${promptId}`, admission, {
              method: "POST",
              body: { previews: false, imageOutputs: true, executionTimeoutSeconds },
            });
            if (response.status === 409) leaseMayExist = false;
            if (response.status === 429) {
              const retryAfter = response.headers.get("Retry-After");
              const busy = z
                .strictObject({ error: z.literal("worker_busy") })
                .safeParse(await readJson(response, MAX_SMALL_BYTES, admission));
              if (!busy.success) throw new ComfyuiError("not_ready");
              leaseMayExist = false;
              const place = queuePosition(response.headers.get("Atelier-Queue-Position"));
              if (!waiting || place !== position)
                yield {
                  type: "progress",
                  phase: "busy",
                  value: 0,
                  max: 1,
                  ...(place === undefined ? {} : { position: place }),
                };
              waiting = true;
              position = place;
              // Numeric seconds only; malformed/date values use one second, all waits are bounded.
              const seconds =
                retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim())
                  ? Number(retryAfter)
                  : 1;
              await sleep(Math.max(100, Math.min(5_000, seconds * 1_000)), admission);
              continue;
            }
            const lease = leaseSchema.safeParse(
              await readJson(await ok(response), MAX_SMALL_BYTES, admission),
            );
            if (!lease.success) throw new ComfyuiError("not_ready");
            break;
          }
        } catch (error) {
          // Busy throughout: the worker stayed occupied with other jobs. A first POST that never answered keeps the deadline's code.
          if (!signal.aborted && admission.aborted)
            throw new ComfyuiError("not_ready", waiting ? "comfyui_busy" : "timeout");
          throw error;
        }
      }
      if (reference !== undefined && input.reference !== undefined) {
        if (
          input.reference.byteLength >
          Math.min(
            CREATOR_ART.imageBytes,
            privacy.limits?.max_image_bytes ?? CREATOR_ART.imageBytes,
          )
        )
          throw new ComfyuiError("oversized");
        const referenceImage = await upload(baseUrl, promptId, input.reference, signal);
        graph = privateGraph(
          fillWorkflow(reference.graph, {
            ...values,
            prompt: input.referencePrompt ?? input.prompt,
            ...sized(reference, input.surface),
            referenceImage,
          }),
        );
        output = reference.output;
        referenceGraph = true;
      }
      if (recoverable) graph = privateGraph(graph, promptId);
      const submission = { prompt: graph, client_id: clientId, prompt_id: promptId };
      if (
        privacy.limits?.max_payload_bytes !== undefined &&
        new TextEncoder().encode(JSON.stringify(submission)).byteLength >
          privacy.limits.max_payload_bytes
      )
        throw new ComfyuiError("oversized");

      checked(baseUrl);
      const ws = new URL(`${baseUrl.replace(/\/+$/, "")}/ws`);
      ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
      ws.searchParams.set("clientId", clientId);
      let next: ReturnType<typeof socketEvents> | undefined;
      const connect = async () => {
        signal.throwIfAborted();
        socket?.close();
        next = undefined;
        try {
          socket = openSocket(ws.href, { headers: authorization, ...tls });
          next = socketEvents(socket, signal, recoverable);
          if ((await next(STATUS_TIMEOUT_MS)).kind !== "open") throw new ComfyuiError("socket");
          socket.send?.(
            JSON.stringify({ type: "feature_flags", data: { supports_preview_metadata: true } }),
          );
        } catch (error) {
          socket?.close();
          next = undefined;
          throw error;
        }
      };
      try {
        await connect();
      } catch (error) {
        if (!recoverable || signal.aborted) throw error;
      }

      submitted.push(promptId);
      // Completion may precede a lost acknowledgement. Never assume a fresh TTL on first observation.
      let earliestCompletion = performance.now();
      let ambiguous = false;
      const acknowledgement = recoverable
        ? AbortSignal.any([signal, AbortSignal.timeout(recoveryTiming.acknowledgementMs)])
        : signal;
      let transientStatus = false;
      try {
        const response = await call(baseUrl, "/prompt", acknowledgement, {
          method: "POST",
          body: submission,
        });
        transientStatus =
          response.status === 408 || response.status === 429 || response.status >= 500;
        answered = !transientStatus;
        // Definitive rejections and malformed acknowledgements never enter recovery.
        if (response.status === 400) {
          await discard(response);
          throw new ComfyuiError("rejected");
        }
        await ok(response);
        const answer = submitSchema.safeParse(
          await readJson(response, MAX_SMALL_BYTES, acknowledgement),
        );
        if (!answer.success) throw new ComfyuiError("invalid_response");
        if (answer.data.prompt_id !== promptId) {
          submitted.push(answer.data.prompt_id);
          throw new ComfyuiError("invalid_response");
        }
        if (Object.keys(answer.data.node_errors ?? {}).length > 0) {
          throw new ComfyuiError("rejected");
        }
      } catch (error) {
        if (!recoverable || signal.aborted || (error instanceof ComfyuiError && !transientStatus))
          throw error;
        // The original POST may still be admitted. Poll its existing lease, never POST again.
        ambiguous = true;
      }
      yield { type: "progress", phase: "queued", value: 0, max: 1 };

      const pngs: Uint8Array[] = [];
      let size = 0;
      let node: string | undefined;
      const progressValues = new Map<string, number>();
      /** Starts as the queued word said above, so a status read does not repeat it. */
      let lastProgress: Extract<ComfyuiEvent, { type: "progress" }> | undefined = {
        type: "progress",
        phase: "queued",
        value: 0,
        max: 1,
      };
      const report = (
        phase: Extract<ComfyuiEvent, { type: "progress" }>["phase"],
        value: number,
        max: number,
      ) => {
        if (
          lastProgress?.phase === phase &&
          lastProgress.value === value &&
          lastProgress.max === max
        )
          return undefined;
        lastProgress = { type: "progress", phase, value, max };
        return lastProgress;
      };
      const phaseFor = (id: string) => {
        const classType = graph[id]?.class_type;
        if (classType === undefined) return undefined;
        return id === output
          ? ("sending" as const)
          : classType.includes("VAEDecode")
            ? ("decoding" as const)
            : classType.includes("Sampler")
              ? ("running" as const)
              : ("loading" as const);
      };
      const progress = (id: string, value: number, max: number): ComfyuiEvent | undefined => {
        const phase = phaseFor(id);
        const key = `${id}:${max}`;
        if (
          phase === undefined ||
          max <= 0 ||
          value > max ||
          value <= (progressValues.get(key) ?? -1)
        )
          return undefined;
        // A node that only hands the picture on once sampling began, such as a resize before the save, is not ComfyUI getting ready again.
        if (
          phase === "loading" &&
          lastProgress !== undefined &&
          lastProgress.phase !== "queued" &&
          lastProgress.phase !== "loading"
        )
          return undefined;
        progressValues.set(key, value);
        return report(phase, value, max);
      };
      /** The prompt left the queue: ComfyUI loads what the sampler needs before its first step. */
      let started = false;
      let reconnects = 0;
      let lastStatus = performance.now();
      let reconcile = ambiguous;
      /** When a status read last answered; unreachable reads fail the run once they outlast `statusOutageMs`. */
      let lastAnswered = performance.now();
      let terminal = false;
      for (;;) {
        signal.throwIfAborted();
        if (
          recoverable &&
          (reconcile || performance.now() - lastStatus >= recoveryTiming.statusPollMs)
        ) {
          reconcile = false;
          lastStatus = performance.now();
          let status: z.infer<typeof jobStatusSchema>;
          try {
            status = await jobStatus(baseUrl, promptId, signal);
            lastAnswered = performance.now();
          } catch (error) {
            // This bounded outage wait stays below the worker's ownership-silence window.
            if (
              signal.aborted ||
              (error instanceof ComfyuiError && error.reason !== "unreachable") ||
              performance.now() - lastAnswered >= recoveryTiming.statusOutageMs
            )
              throw error;
            await sleep(recoveryTiming.statusPollMs, signal);
            continue;
          }
          if (status.state === "completed") {
            if (
              status.outputs.length !== input.count ||
              status.outputs.some(
                (image) =>
                  image.bytes > (privacy.limits?.max_image_bytes ?? CREATOR_ART.imageBytes),
              ) ||
              new Set(status.outputs.map((image) => image.id)).size !== input.count ||
              status.outputs.reduce((total, image) => total + image.bytes, 0) > MAX_BATCH_BYTES
            )
              throw new ComfyuiError("invalid_output");
            const sending = progress(output, 0, input.count);
            if (sending !== undefined) yield sending;
            pngs.push(
              ...(await retrieve(
                baseUrl,
                promptId,
                status.outputs,
                signal,
                earliestCompletion,
                privacy.limits,
              )),
            );
            break;
          }
          earliestCompletion = lastStatus;
          // The socket may be gone or unregistered after a reconnect; the lease's state still moves progress.
          if (status.state === "queued" && !started) {
            const queued = report("queued", 0, 1);
            if (queued !== undefined) yield queued;
          } else if (status.state === "running" && !started) {
            started = true;
            // Never behind the socket's own word, should it have sent steps first.
            if (lastProgress?.phase === "queued") {
              const loading = report("loading", 0, 1);
              if (loading !== undefined) yield loading;
            }
          }
          if (next === undefined && reconnects < 3) {
            reconnects++;
            try {
              await connect();
            } catch (error) {
              if (signal.aborted) throw error;
            }
          }
        }
        let event: SocketEvent;
        if (next === undefined) {
          await sleep(recoveryTiming.statusPollMs, signal);
          event = { kind: "tick" };
        } else event = await next(recoverable ? recoveryTiming.statusPollMs : undefined);
        if (event.kind === "tick") continue;
        if (event.kind === "closed") {
          if (!recoverable) throw new ComfyuiError("socket");
          socket?.close();
          next = undefined;
          node = undefined;
          reconcile = true;
          continue;
        }
        if (event.kind === "binary") {
          // The memory sink's lease outputs are authoritative. Previews never become final images.
          if (recoverable) continue;
          if (node !== output) continue;
          const png = framedPng(event.bytes, promptId, output);
          if (png === undefined) continue;
          size += png.byteLength;
          if (png.byteLength > CREATOR_ART.imageBytes || size > MAX_BATCH_BYTES) {
            throw new ComfyuiError("oversized");
          }
          if (pngs.length === input.count || !(await portraitShaped(png))) {
            throw new ComfyuiError("invalid_output");
          }
          pngs.push(png);
          continue;
        }
        if (event.kind !== "text") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.text);
        } catch {
          continue;
        }
        const snapshot = progressStateSchema.safeParse(parsed);
        if (snapshot.success) {
          if (snapshot.data.data.prompt_id !== promptId) continue;
          for (const [id, state] of Object.entries(snapshot.data.data.nodes)) {
            if (
              state.prompt_id !== promptId ||
              state.node_id !== id ||
              (state.state !== "running" && state.state !== "finished")
            )
              continue;
            // Public progress uses integers; native progress may use fractional units.
            const integral = Number.isSafeInteger(state.value) && Number.isSafeInteger(state.max);
            const event = progress(
              id,
              integral ? state.value : Math.floor((state.value / state.max) * 1_000),
              integral ? state.max : 1_000,
            );
            if (event !== undefined) yield event;
          }
          continue;
        }
        const message = messageSchema.safeParse(parsed);
        if (!message.success || message.data.data.prompt_id !== promptId) continue;
        const { type, data } = message.data;
        const executionFailed = type === "execution_error" || type === "execution_interrupted";
        if (
          executionFailed ||
          type === "execution_success" ||
          (type === "executing" && data.node === null)
        ) {
          if (recoverable) {
            if (!terminal) {
              terminal = true;
              reconcile = true;
            }
            continue;
          }
          if (executionFailed) throw new ComfyuiError("execution");
          break;
        }
        if (!started && (type === "execution_start" || type === "executing")) {
          started = true;
          const loading = report("loading", 0, 1);
          if (loading !== undefined) yield loading;
        }
        if (type === "progress" && data.value !== undefined && data.max !== undefined) {
          const progressNode = data.node ?? node;
          if (data.node !== undefined && node !== undefined && data.node !== node) continue;
          if (progressNode === undefined) continue;
          const event = progress(progressNode, data.value, data.max);
          if (event !== undefined) yield event;
        } else if (type === "executing" && typeof data.node === "string") {
          if (node === data.node) continue;
          node = data.node;
          const phase = phaseFor(node);
          if (phase === "sending" || phase === "decoding") {
            const event = progress(node, 0, input.count);
            if (event !== undefined) yield event;
          }
        }
      }
      signal.throwIfAborted();
      if (pngs.length !== input.count) throw new ComfyuiError("invalid_output");
      completed = true;
      yield { type: "images", pngs, referenceGraph };
    } catch (error) {
      completed = false;
      throw failure(error, signal);
    } finally {
      socket?.close();
      // Cleanup holds ids and flags only, never the prompt or the batch.
      if (mode === "private" && leaseMayExist) {
        // Started apart from the optional call, which would skip its argument without a caller.
        const releasing = detach(() => release(baseUrl, promptId));
        released?.(releasing);
      } else if (submitted.length > 0) {
        const ids = [...submitted];
        const normalCompletion = completed && !signal.aborted;
        // No later job waits for a plain instance's cleanup, which can take long.
        void detach(async () => {
          for (const id of ids) await clean(baseUrl, id, answered, normalCompletion);
        });
      }
      pending.delete(running);
      ran();
    }
  }

  return { allows, status, inspect, generate, settled };
}

export type Comfyui = ReturnType<typeof createComfyui>;
