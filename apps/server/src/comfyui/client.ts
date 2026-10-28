import { inflate } from "node:zlib";
import { type ArtStreamEvent, CREATOR_ART, type CreatorErrorCode } from "@ephemera/core";
import { z } from "zod";
import type { UpstreamFetch } from "../catalog.ts";
import { readBoundedJson, timedOut } from "../lifetime.ts";
import type { Logger } from "../log.ts";
import { pngChunks } from "../png.ts";
import {
  fillWorkflow,
  type Workflow,
  type WorkflowGraph,
  type WorkflowId,
  type WorkflowRegistry,
} from "./workflow.ts";

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

/** Below Bun's 10 s idle timeout, which would otherwise cut the status request first. */
const STATUS_TIMEOUT_MS = 8_000;
const OUTPUT_TIMEOUT_MS = 60_000;
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
/**
 * Lease release, plain cleanup's queue poll and each later cleanup call run
 * on a deadline of this length each, never on the request's signal.
 */
const CLEANUP_TIMEOUT_MS = 4_000;
/** Tries of a lease release, history delete or cache release before it counts as failed. */
const CLEANUP_ATTEMPTS = 3;

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
/** Handshake, lease and submit answers, and one text frame. */
const MAX_SMALL_BYTES = 64 * 1024;
/** Every node and model of the install; a large one is a few megabytes. */
const MAX_OBJECT_INFO_BYTES = 32 * 1024 * 1024;
/** Every queued graph, other clients' included. */
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
/** The whole batch, below four times the per-image cap. */
const MAX_BATCH_BYTES = CREATOR_ART.batchBytes;
/** A binary frame's envelope around its image, and room for the run's text frames. */
const FRAME_SLACK_BYTES = 64 * 1024;

const COMFYUI_FAILURES = [
  /** The address's origin is not in COMFYUI_ALLOWED_ORIGINS: nothing is sent. */
  "not_allowed",
  /** No answer, a refused redirect, or an error status. */
  "unreachable",
  /** The bearer token is missing or wrong. */
  "unauthorized",
  /** A token is configured and the address is plain http: nothing is sent. */
  "insecure",
  /** Atelier's private worker answered but is not ready, or refused the lease. */
  "not_ready",
  /** ComfyUI refused the graph (validation or node errors). */
  "rejected",
  /** The private worker did not take the reference image as a job input. */
  "upload",
  /** The run failed or was interrupted inside ComfyUI. */
  "execution",
  /** The WebSocket failed or closed before the run finished. */
  "socket",
  /** A response, frame or image was larger than its cap. */
  "oversized",
  /** An answer ComfyUI should not give, such as another prompt id. */
  "invalid_response",
  /** Not exactly the run's count of PNGs of 1024 x 1536 in the layout the browser decodes. */
  "invalid_output",
  /** The caller's signal ended the run. */
  "aborted",
] as const;
type ComfyuiFailure = (typeof COMFYUI_FAILURES)[number];

/** A content-free failure: its message and fields name the reason only. */
export class ComfyuiError extends Error {
  override name = "ComfyuiError";
  readonly reason: ComfyuiFailure;
  /** What the art stream reports (packages/core creator schema). */
  readonly code: CreatorErrorCode;
  constructor(reason: ComfyuiFailure, code: CreatorErrorCode = "comfyui") {
    super(`ComfyUI failed: ${reason}`);
    this.reason = reason;
    this.code = code;
  }
}

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
  /** The graphs a run or a status check names by id (index.ts). */
  workflows: Pick<WorkflowRegistry, "get" | "referenceOf">;
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

export type ComfyuiEvent =
  | Extract<ArtStreamEvent, { type: "progress" }>
  /**
   * The last event: exactly the run's `count` of PNGs of the expected size, in
   * batch order, and whether the reference graph painted them.
   */
  | { type: "images"; pngs: Uint8Array[]; referenceGraph: boolean };

export interface GenerateInput {
  baseUrl: string;
  workflow: WorkflowId;
  /** The image prompt; a creation draft (PRINCIPLES.md 1). */
  prompt: string;
  seed: number;
  /** How many images the batch paints, at most `CREATOR_ART.count`. */
  count: number;
  /**
   * A PNG the workflow's reference graph loads as its image input; a creation
   * draft or character data, held in memory only. Used only on Atelier's
   * private worker, and only when the workflow has a reference graph whose
   * nodes the worker has; otherwise the text graph runs without it.
   */
  reference?: Uint8Array<ArrayBuffer>;
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
type WorkerLimits = z.infer<typeof privacySchema>["limits"];
type Privacy = z.infer<typeof privacySchema>;
type Handshake =
  | ({ mode: "plain" } & Partial<Record<keyof Privacy, never>>)
  | ({ mode: "private" } & Privacy);
const jobStatusSchema = z.strictObject({
  state: z.enum(["leased", "queued", "running", "completed", "failed", "released"]),
  outputs: z
    .array(
      z.strictObject({
        id: z.uuid(),
        bytes: z.int().min(1).max(CREATOR_ART.imageBytes),
        mediaType: z.literal("image/png"),
      }),
    )
    .max(CREATOR_ART.count),
});
const leaseSchema = z.object({ protocol: z.literal(2), ready: z.literal(true) });
const submitSchema = z.object({
  prompt_id: z.string().min(1).max(128),
  node_errors: z.record(z.string(), z.unknown()).optional(),
});
const queueSchema = z.object({
  queue_running: z.array(z.array(z.unknown())),
  queue_pending: z.array(z.array(z.unknown())),
});
const objectInfoSchema = z.record(
  z.string(),
  z.object({
    input: z
      .object({
        required: z.record(z.string(), z.unknown()).optional(),
        optional: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
);
type ObjectInfo = z.infer<typeof objectInfoSchema>;
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

/** The parsed JSON body, undefined when it is not JSON; throws when it passes `max`. */
async function readJson(response: Response, max: number, signal?: AbortSignal): Promise<unknown> {
  const read = await readBoundedJson(response, max, signal);
  signal?.throwIfAborted();
  if (!read.ok) throw new ComfyuiError("oversized");
  return read.json;
}

const discard = async (response: Response) => {
  await response.body?.cancel().catch(() => {});
};

/** Fails an error status without reading its body, which may echo the prompt. */
async function ok(response: Response): Promise<Response> {
  if (response.ok) return response;
  await discard(response);
  throw new ComfyuiError(
    response.status === 401 || response.status === 403 ? "unauthorized" : "unreachable",
  );
}

/** A busy worker's waiting-list place, 1 being next; anything but a positive safe integer is unknown. */
function queuePosition(header: string | null): number | undefined {
  const value = header?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const place = Number(value);
  return Number.isSafeInteger(place) && place > 0 ? place : undefined;
}

/** The content-free error for anything that ended a run or a status check. */
function failure(error: unknown, signal: AbortSignal): ComfyuiError {
  if (signal.aborted) {
    return new ComfyuiError("aborted", timedOut(signal) ? "timeout" : "comfyui");
  }
  return error instanceof ComfyuiError ? error : new ComfyuiError("unreachable");
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

/** The choices of a combo input in either `/object_info` format. */
function choices(spec: unknown): unknown[] | undefined {
  if (!Array.isArray(spec)) return undefined;
  const [kind, config] = spec;
  if (Array.isArray(kind)) return kind;
  if (kind !== "COMBO" || typeof config !== "object" || config === null) return undefined;
  const options: unknown = Reflect.get(config, "options");
  return Array.isArray(options) ? options : undefined;
}

function missing(workflow: Workflow, info: ObjectInfo, allowedNodes?: readonly string[]) {
  const classes = new Set(Object.values(workflow.graph).map((node) => node.class_type));
  const missingNodes = [...classes].filter(
    (name) =>
      info[name] === undefined || (allowedNodes !== undefined && !allowedNodes.includes(name)),
  );
  const missingModels = workflow.models
    .filter(({ classType, input, file }) => {
      const node = info[classType];
      if (node === undefined) return false;
      const listed = choices(node.input?.required?.[input] ?? node.input?.optional?.[input]);
      return !listed?.includes(file);
    })
    .map((model) => model.file);
  return { missingNodes, missingModels: [...new Set(missingModels)] };
}

/** The graph as the private worker runs it: its LoadImage reads the job's in-memory inputs. */
function privateGraph(graph: WorkflowGraph, lease?: string): WorkflowGraph {
  return Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [
      id,
      node.class_type === "LoadImage"
        ? { ...node, class_type: "AtelierLoadImage" }
        : node.class_type === "SaveImageWebsocket" && lease !== undefined
          ? {
              class_type: "AtelierSaveImages",
              inputs: { images: node.inputs.images, job_id: lease },
            }
          : node,
    ]),
  );
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

/** Chunks a candidate may carry: no palette, transparency key, ICC profile, compressed text or animation. */
const PORTRAIT_CHUNKS = new Set(["IHDR", "IDAT", "IEND", "tEXt", "pHYs", "sRGB", "gAMA", "cHRM"]);

/**
 * Inflates `data` to at most `limit` bytes, with how much of it the zlib
 * stream used: Node stops at the stream's end and ignores anything after it.
 */
function inflateBounded(data: Buffer, limit: number): Promise<{ output: number; used: number }> {
  return new Promise((resolve, reject) => {
    inflate(data, { maxOutputLength: limit, info: true }, (error, result) => {
      if (error) return reject(error);
      // With `info`, Node answers the buffer and its engine; the type names only the buffer.
      const { buffer, engine } = result as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      resolve({ output: buffer.byteLength, used: engine.bytesWritten });
    });
  });
}

/**
 * A candidate in the one layout the browser decodes (apps/web creator/art.ts):
 * the batch's size, 8-bit RGB or RGBA, not interlaced, one IHDR and
 * otherwise only `PORTRAIT_CHUNKS`, and image data that is one zlib stream
 * inflating to exactly its scanlines.
 * Inflation stops there, so a small file cannot expand to gigabytes in the
 * tab, nor carry data the tab's decoder would keep copying. Read in memory;
 * the pixels are not kept.
 */
async function portraitShaped(png: Uint8Array): Promise<boolean> {
  const chunks = pngChunks(png);
  const header = chunks?.[0];
  if (chunks === undefined || header?.type !== "IHDR" || header.data.byteLength !== 13) {
    return false;
  }
  // One IHDR only: a second one could describe other pixels than the first.
  const allowed = chunks.every(
    (chunk, index) => (chunk.type === "IHDR") === (index === 0) && PORTRAIT_CHUNKS.has(chunk.type),
  );
  if (!allowed) return false;
  const view = new DataView(header.data.buffer, header.data.byteOffset, 13);
  const [depth, colourType, compression, filter, interlace] = header.data.subarray(8);
  const channels = colourType === 2 ? 3 : colourType === 6 ? 4 : 0;
  if (
    view.getUint32(0) !== CREATOR_ART.width ||
    view.getUint32(4) !== CREATOR_ART.height ||
    depth !== 8 ||
    channels === 0 ||
    compression !== 0 ||
    filter !== 0 ||
    interlace !== 0
  ) {
    return false;
  }
  const scanlines = CREATOR_ART.height * (1 + CREATOR_ART.width * channels);
  const data = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((c) => c.data));
  try {
    const { output, used } = await inflateBounded(data, scanlines);
    return output === scanlines && used === data.byteLength;
  } catch {
    return false;
  }
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
type Unresolved =
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
    { controller: AbortController; promise: Promise<ObjectInfo>; subscribers: number }
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

  async function inventory(baseUrl: string, signal: AbortSignal): Promise<ObjectInfo> {
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
          return info.data;
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
    return new Promise<ObjectInfo>((resolve, reject) => {
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

  async function status(input: {
    baseUrl: string;
    workflow: WorkflowId;
    signal: AbortSignal;
  }): Promise<ComfyuiStatus> {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
    try {
      // Atelier's private worker must answer ready; a plain instance has no handshake.
      const privacy = await handshake(input.baseUrl, signal);
      const workflow = deps.workflows.get(input.workflow);
      return {
        reachable: true,
        ...missing(
          privacy.mode === "private"
            ? { ...workflow, graph: privateGraph(workflow.graph, "readiness") }
            : workflow,
          await inventory(input.baseUrl, signal),
          privacy.allowed_nodes,
        ),
      };
    } catch (error) {
      return { reachable: false, reason: failure(error, signal).reason };
    }
  }

  /**
   * The workflow's reference graph when the private worker has every node
   * class and model it needs, read from one `/object_info` answer and the
   * submission allowlist; otherwise the text graph runs. Logs name reasons only.
   */
  async function usableReference(
    baseUrl: string,
    id: WorkflowId,
    signal: AbortSignal,
    allowedNodes: string[] | undefined,
  ): Promise<Workflow | undefined> {
    const reference = deps.workflows.referenceOf(id);
    if (reference === undefined) return undefined;
    const { missingNodes, missingModels } = missing(
      { ...reference, graph: privateGraph(reference.graph, "readiness") },
      await inventory(baseUrl, signal),
      allowedNodes,
    );
    if (missingNodes.length === 0 && missingModels.length === 0) return reference;
    deps.log?.warn({
      event: "comfyui.reference",
      referenceGraph: false,
      errorClass: missingNodes.length > 0 ? "missing_nodes" : "missing_models",
    });
    return undefined;
  }

  /**
   * Puts the image into the leased job as an in-memory input, under a fresh
   * asset id; the lease's release removes it with the job. Answers the
   * reference the graph's image input names.
   */
  async function upload(
    baseUrl: string,
    lease: string,
    image: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ) {
    const asset = crypto.randomUUID();
    try {
      const path = `/atelier/v1/jobs/${lease}/inputs/${asset}`;
      await discard(await ok(await call(baseUrl, path, signal, { method: "PUT", bytes: image })));
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ComfyuiError("upload");
    }
    return `${lease}:${asset}`;
  }

  /** Sanitized, lease-scoped authority. Native history is never requested in private mode. */
  async function jobStatus(baseUrl: string, lease: string, signal: AbortSignal) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
    const response = await call(baseUrl, `/atelier/v1/jobs/${lease}`, signal);
    if (response.status === 404) {
      await discard(response);
      throw new ComfyuiError("execution");
    }
    const parsed = jobStatusSchema.safeParse(
      await readJson(await ok(response), MAX_SMALL_BYTES, signal),
    );
    if (!parsed.success) throw new ComfyuiError("invalid_response");
    if (parsed.data.state === "failed" || parsed.data.state === "released")
      throw new ComfyuiError("execution");
    return parsed.data;
  }

  /** Download only this completed lease's ordered assets, each bounded before and during reading. */
  async function download(
    baseUrl: string,
    lease: string,
    output: z.infer<typeof jobStatusSchema>["outputs"][number],
    signal: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(OUTPUT_TIMEOUT_MS)]);
      let retryableStatus = false;
      try {
        const response = await call(
          baseUrl,
          `/atelier/v1/jobs/${lease}/outputs/${output.id}`,
          attemptSignal,
        );
        retryableStatus =
          response.status === 408 ||
          response.status === 429 ||
          (response.status >= 500 && response.status <= 599);
        await ok(response);
        if (
          response.headers.get("Content-Type")?.split(";")[0]?.trim() !== "image/png" ||
          response.body === null
        ) {
          await discard(response);
          throw new ComfyuiError("invalid_output");
        }
        const png = new Uint8Array(output.bytes);
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        attemptSignal.addEventListener("abort", cancel, { once: true });
        if (attemptSignal.aborted) cancel();
        let offset = 0;
        try {
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            attemptSignal.throwIfAborted();
            if (offset + chunk.value.byteLength > png.byteLength)
              throw new ComfyuiError("oversized");
            png.set(chunk.value, offset);
            offset += chunk.value.byteLength;
          }
          attemptSignal.throwIfAborted();
        } finally {
          attemptSignal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => {});
        }
        if (offset !== png.byteLength || !(await portraitShaped(png)))
          throw new ComfyuiError("invalid_output");
        return png;
      } catch (error) {
        if (signal.aborted || (error instanceof ComfyuiError && !retryableStatus) || attempt === 2)
          throw error;
        await sleep(timing.retryMs, signal);
      }
    }
  }

  /** Renewal never creates a lease. A missing lease is terminal, not a reason to retry. */
  async function renew(baseUrl: string, lease: string, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(recoveryTiming.renewalTimeoutMs),
      ]);
      let transient = false;
      try {
        const response = await call(baseUrl, `/atelier/v1/jobs/${lease}/renew`, attemptSignal, {
          method: "POST",
        });
        transient = response.status === 408 || response.status === 429 || response.status >= 500;
        if (response.status === 404) {
          await discard(response);
          throw new ComfyuiError("execution");
        }
        const answer = z
          .strictObject({ ok: z.literal(true) })
          .safeParse(await readJson(await ok(response), MAX_SMALL_BYTES, attemptSignal));
        if (!answer.success) throw new ComfyuiError("invalid_response");
        return;
      } catch (error) {
        if (signal.aborted || (error instanceof ComfyuiError && !transient) || attempt === 2)
          throw error;
        await sleep(timing.retryMs, signal);
      }
    }
  }

  /** Owns all output work, including renewal, until every reader/request has stopped. */
  async function retrieve(
    baseUrl: string,
    lease: string,
    outputs: z.infer<typeof jobStatusSchema>["outputs"],
    signal: AbortSignal,
    earliestCompletion: number,
    limits: WorkerLimits | undefined,
  ) {
    if (limits === undefined) throw new ComfyuiError("not_ready");
    const budget =
      Math.min(recoveryTiming.terminalLimitMs, limits.terminal_max_seconds * 1_000) -
      (performance.now() - earliestCompletion);
    if (budget <= 0) throw new ComfyuiError("execution");
    const owned = new AbortController();
    const retrievalSignal = AbortSignal.any([
      signal,
      owned.signal,
      AbortSignal.timeout(Math.ceil(budget)),
    ]);
    let renewal: Promise<void> | undefined;
    try {
      await renew(baseUrl, lease, retrievalSignal);
      renewal = (async () => {
        for (;;) {
          await sleep(
            Math.min(recoveryTiming.renewalMs, limits.terminal_idle_seconds * 500),
            retrievalSignal,
          );
          await renew(baseUrl, lease, retrievalSignal);
        }
      })().catch((error: unknown) => {
        if (!retrievalSignal.aborted) owned.abort(error);
      });
      const pngs: Uint8Array[] = new Array(outputs.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(4, outputs.length) }, async () => {
        try {
          for (;;) {
            retrievalSignal.throwIfAborted();
            const index = cursor++;
            const output = outputs[index];
            if (output === undefined) return;
            pngs[index] = await download(baseUrl, lease, output, retrievalSignal);
          }
        } catch (error) {
          owned.abort(error);
          throw error;
        }
      });
      await Promise.allSettled(workers);
      retrievalSignal.throwIfAborted();
      return pngs;
    } finally {
      owned.abort();
      await renewal;
    }
  }

  /** Runs cleanup apart from the run that needs it; a failure inside it is already handled. */
  function detach(work: () => Promise<void>) {
    const running: Promise<void> = work()
      .catch(() => {})
      .then(() => {
        pending.delete(running);
      });
    pending.add(running);
  }

  /** Every run and every cleanup started so far has ended, follow-ups included. */
  async function settled() {
    while (pending.size > 0) await Promise.all(pending);
  }

  const unresolved = (reason: Unresolved) =>
    deps.log?.warn({ event: "comfyui.cleanup.unresolved", errorClass: reason });

  /** One cleanup request, tried up to `CLEANUP_ATTEMPTS` times on a deadline each; false when all failed. */
  async function retried(request: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await request(AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
        return true;
      } catch {
        if (attempt === CLEANUP_ATTEMPTS) return false;
      }
      await new Promise((resolve) => setTimeout(resolve, timing.retryMs));
    }
  }

  /**
   * Releases a lease, which removes or interrupts its job without waiting
   * for ownership silence or its execution budget. An unconfirmed release
   * is tried again and an exhausted retry is logged.
   */
  async function release(baseUrl: string, id: string) {
    const released = await retried((signal) =>
      send(baseUrl, `/atelier/v1/jobs/${id}`, signal, { method: "DELETE" }),
    );
    if (!released) unresolved("lease_release");
  }

  /** Where a prompt stands in a plain instance's queue. */
  async function placed(
    baseUrl: string,
    id: string,
    signal: AbortSignal,
  ): Promise<"pending" | "running" | "out"> {
    const response = await ok(await call(baseUrl, "/queue", signal));
    const queue = queueSchema.safeParse(await readJson(response, MAX_QUEUE_BYTES, signal));
    if (!queue.success) throw new ComfyuiError("invalid_response");
    const has = (items: unknown[][]) => items.some((item) => item[1] === id);
    if (has(queue.data.queue_pending)) return "pending";
    return has(queue.data.queue_running) ? "running" : "out";
  }

  /** Whether a plain instance's history holds the prompt; its entry is never read further. */
  async function inHistory(baseUrl: string, id: string, signal: AbortSignal): Promise<boolean> {
    const response = await ok(await call(baseUrl, `/history/${id}`, signal));
    const entries = await readJson(response, MAX_QUEUE_BYTES, signal);
    return typeof entries === "object" && entries !== null && Object.hasOwn(entries, id);
  }

  /** Atomic own-job cancellation never falls back to a global interrupt. */
  async function cancel(baseUrl: string, id: string, signal: AbortSignal) {
    const response = await call(baseUrl, `/api/jobs/${encodeURIComponent(id)}/cancel`, signal, {
      method: "POST",
    });
    await discard(await ok(response));
  }

  /** One successful cache release per observation phase, shared by cleanup and follow-up. */
  interface CacheCleanup {
    released: boolean;
    releasedAfterRetirement: boolean;
  }

  /** Scoped history deletion may repeat; instance-wide eviction needs failure or fresh retirement evidence. */
  async function forget(baseUrl: string, id: string, cache: CacheCleanup, retired: boolean) {
    const deleted = await retried((signal) =>
      send(baseUrl, "/history", signal, { method: "POST", body: { delete: [id] } }),
    );
    if (!deleted) unresolved("history_delete");
    if (cache.released && (!retired || cache.releasedAfterRetirement)) return;
    const freed = await retried((signal) =>
      send(baseUrl, "/free", signal, {
        method: "POST",
        body: { unload_models: false, free_memory: true },
      }),
    );
    if (!freed) unresolved("cache_release");
    else {
      cache.released = true;
      cache.releasedAfterRetirement = retired;
    }
  }

  /** Waits `ms`; true when the follow-up's limit passed or the process is stopping, for a last check. */
  const pause = (ms: number, limit: AbortSignal) =>
    sleep(ms, AbortSignal.any([limit, stopping])).then(
      () => false,
      () => true,
    );

  /**
   * A prompt cleanup could not settle, tied to no request: one still running
   * when the poll gave up (such as a batch that finishes its current node
   * before it stops), one whose submit got no answer, which ComfyUI may still
   * admit, or one behind a queue that could not be read. It checks the queue
   * at its interval, repeating scoped cancellation while the id is pending
   * or running; once it has left the queue, its history entry and the
   * cache go. Every outcome behind an unreadable queue still gets scoped
   * history deletion. Cache release repeats only after failure or observed
   * later retirement. A prompt that may arrive late is
   * also looked for in the history. It stops at its limit, or after one last check when the process
   * stops, and logs a prompt it could not see leave.
   */
  async function followUp(
    baseUrl: string,
    id: string,
    {
      late,
      limitMs,
      cache,
      cancelUnknown,
    }: {
      late: boolean;
      limitMs: number;
      cache: CacheCleanup;
      cancelUnknown: boolean;
    },
  ) {
    const limit = AbortSignal.timeout(limitMs);
    let seen = false;
    let last: "pending" | "running" | "out" | "unknown" = "unknown";
    for (let final = false; !final; ) {
      final = await pause(timing.followUpPollMs, limit);
      // Own history is inserted atomically with retirement; a global queue read need not work.
      if (
        await inHistory(baseUrl, id, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(() => false)
      ) {
        await forget(baseUrl, id, cache, true);
        return;
      }
      const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
      last = await placed(baseUrl, id, signal).catch(() => "unknown" as const);
      if (last === "pending" || last === "running") seen = true;
      if (last === "pending" || last === "running") {
        // A successful cancel can miss native execution's handoff. Only leaving the queue settles it.
        await cancel(baseUrl, id, signal).catch(() => {});
      } else if (last === "out") {
        if (!late || seen || (await inHistory(baseUrl, id, signal).catch(() => false))) {
          await forget(baseUrl, id, cache, true);
          return;
        }
      } else {
        // Retirement may have happened during a failed/stalled queue read. Check with a fresh deadline.
        const retired = await inHistory(baseUrl, id, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(
          () => false,
        );
        if (!retired && cancelUnknown)
          await cancel(baseUrl, id, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(() => {});
        await forget(baseUrl, id, cache, retired);
        if (retired) return;
      }
    }
    if (last === "pending" || last === "running") unresolved("still_queued");
    else if (last === "unknown") unresolved("queue_unreadable");
  }

  /**
   * Plain ComfyUI: validated success first gets a bounded wait for native
   * task_done. Failed or aborted runs repeat atomic cancellation of their
   * own id while the job remains pending or running. Cleanup prefers observed
   * retirement before deleting history and dropping the cache, but an unreadable
   * queue cannot suppress those attempts past the bounded wait. ComfyUI moves a
   * finished prompt from the queue to its history in one step, so a prompt
   * in neither stays out. A submit without an answer may still be admitted
   * later, and a queue that cannot be read says nothing; both, and a prompt
   * still running when the poll's deadline passes, are left to a follow-up.
   */
  async function clean(baseUrl: string, id: string, answered: boolean, completed: boolean) {
    const poll = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    const cache: CacheCleanup = { released: false, releasedAfterRetirement: false };
    let retired = false;
    let seen = false;
    let running = false;
    try {
      for (;;) {
        if (await inHistory(baseUrl, id, poll).catch(() => false)) {
          retired = true;
          break;
        }
        const where = await placed(baseUrl, id, poll).catch((error: unknown) => {
          if (completed && !poll.aborted) return "unknown" as const;
          throw error;
        });
        if (where === "unknown") {
          await sleep(timing.pollMs, poll);
          continue;
        }
        running = where === "running";
        if (where === "pending" || where === "running") {
          seen = true;
          if (!completed) await cancel(baseUrl, id, poll);
          await sleep(timing.pollMs, poll);
        } else {
          retired = answered || seen;
          break;
        }
      }
    } catch {
      // The queue could not be read or the poll gave up: remove the prompt by its id where that cannot touch another.
      if (!completed && !(await retried((signal) => cancel(baseUrl, id, signal))))
        unresolved("queue_delete");
    }
    // A stalled queue must not suppress retention cleanup. History may already prove native retirement.
    if (!retired)
      retired = await inHistory(baseUrl, id, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(
        () => false,
      );
    await forget(baseUrl, id, cache, retired);
    if (retired) return;
    await followUp(baseUrl, id, {
      late: !answered && !seen,
      cache,
      cancelUnknown: !completed,
      limitMs: running && answered ? timing.runningLimitMs : timing.uncertainLimitMs,
    });
  }

  /**
   * One batch: progress while ComfyUI works, then exactly `count` PNGs, or a
   * ComfyuiError. The WebSocket opens before the prompt is submitted under a
   * client-chosen id (the lease id on a private worker), so cleanup never
   * depends on the submit answer. With a reference image, the private worker
   * runs the workflow's reference graph on it, uploaded under the lease.
   */
  async function* generate(input: GenerateInput): AsyncGenerator<ComfyuiEvent, void, undefined> {
    const { baseUrl } = input;
    const signal = AbortSignal.any([input.signal, stopping]);
    const workflow = deps.workflows.get(input.workflow);
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
        width: CREATOR_ART.width,
        height: CREATOR_ART.height,
        count: input.count,
      };
      let graph = fillWorkflow(workflow.graph, values);
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
        graph = privateGraph(fillWorkflow(reference.graph, { ...values, referenceImage }));
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
      if (mode === "private" && leaseMayExist) detach(() => release(baseUrl, promptId));
      else if (submitted.length > 0) {
        const ids = [...submitted];
        const normalCompletion = completed && !signal.aborted;
        detach(async () => {
          for (const id of ids) await clean(baseUrl, id, answered, normalCompletion);
        });
      }
      pending.delete(running);
      ran();
    }
  }

  return { allows, status, generate, settled };
}

export type Comfyui = ReturnType<typeof createComfyui>;
