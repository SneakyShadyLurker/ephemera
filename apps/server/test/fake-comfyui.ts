/**
 * An in-memory fake ComfyUI for tests: the HTTP API as an injectable fetch,
 * the WebSocket as an injectable factory, and either a plain instance or
 * Atelier's private worker. It records its queue, history, executor cache,
 * leases and the job inputs uploaded under them (by size only), so tests can
 * assert what a run left behind.
 */
import { CREATOR_ART } from "@ephemera/core";
import { encode } from "fast-png";
import type { ComfySocket, ComfySocketFactory } from "../src/comfyui/client.ts";
import type { ServerWorkflows } from "../src/comfyui/workflow.ts";
import { pngChunk } from "./image-fixtures.ts";
import { TEST_WORKFLOWS } from "./test-workflows.ts";

const plain = new Map<string, Uint8Array>();

/**
 * A flat RGBA PNG of the given size, the layout the client admits, whose
 * `tEXt` chunk right after IHDR carries `padding` bytes. Encoded once per size.
 */
export function fakePng(
  width: number = CREATOR_ART.width,
  height: number = CREATOR_ART.height,
  padding = 64,
): Uint8Array {
  const key = `${width}x${height}`;
  let base = plain.get(key);
  if (base === undefined) {
    base = encode({
      width,
      height,
      channels: 4,
      data: new Uint8Array(width * height * 4).fill(180),
    });
    plain.set(key, base);
  }
  const text = pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), Buffer.alloc(padding)]));
  return new Uint8Array(Buffer.concat([base.subarray(0, 33), text, base.subarray(33)]));
}

export interface FakeComfyuiOptions {
  /**
   * The first `busyResponses` lease POSTs answer busy; the nth carries
   * `positions[n]` as its waiting-list place, none where that is undefined.
   */
  admission?: {
    busyResponses: number;
    retryAfter?: string;
    positions?: readonly (string | undefined)[];
  };
  /** The handshake answers not ready this many times before it answers `ready`. */
  startingAnswers?: number;
  allowedNodes?: string[];
  limits?: Record<string, number>;
  /** Scoped native cancellation, or a deliberate compatibility/error response. */
  nativeCancel?: true | 404 | 405 | 401 | 500;
  /** Native snapshot/handoff races may acknowledge cancellation without stopping the job. */
  nativeCancelNoops?: number;
  nativeCancelNoopResult?: boolean;
  /** Holds the existing terminal-before-task_done boundary under a test-owned gate. */
  beforeTaskDone?: (promptId: string) => Promise<void>;
  /** Terminal retention uses worker time; tests advance it without minute-long sleeps. */
  now?: () => number;
  /** Native snapshots alone, or alongside legacy progress. */
  progressMode?: "native" | "mixed";
  progressEvents?: (promptId: string) => unknown[];
  /** A healthy socket with no job events: polling must still find completion. */
  silent?: boolean;
  terminal?: "success" | "null";
  /** Metadata on final legacy PNG frames, or deliberately malformed/unrelated metadata. */
  metadata?: "valid" | "unrelated" | "malformed";
  /** Atelier's private worker: answers the handshake, requires a lease, has no queue or history API. */
  mode?: "plain" | "private";
  /** The private worker's handshake answers ready (default) or not. */
  ready?: boolean;
  /** Every request and the WebSocket need this bearer token. */
  token?: string;
  /** Every fetch rejects, as when nothing listens. */
  down?: boolean;
  /** Every request answers with a redirect to another origin. */
  redirect?: boolean;
  /** The workflow whose nodes and model files are installed; the default when absent. */
  installedWorkflow?: string;
  /** Where `installedWorkflow` is found; the public graphs and the test fixtures by default. */
  workflows?: ServerWorkflows;
  /** Node classes and model files `/object_info` leaves out. */
  missingNodes?: string[];
  missingModels?: string[];
  /** Classes `/object_info` reports as output nodes besides the save classes. */
  outputNodes?: string[];
  /**
   * What the save node sends, as whole PNGs; by default as many valid
   * portraits as the submitted graph's `batch_size`.
   * A function receives the submitted graph, so each run can send its own.
   */
  images?: Uint8Array[] | ((graph: unknown) => Uint8Array[]);
  /** `/prompt` refuses the graph (400 with node errors), or accepts it with node errors. */
  submit?:
    | "refused"
    | "node_errors"
    | "other_id"
    | "unauthorized"
    | "forbidden"
    | "malformed"
    | "lost"
    | "accepted_500"
    | "accepted_408"
    | "accepted_429"
    | "stalled_headers"
    | "stalled_body";
  /** The run fails inside ComfyUI, after the sampler started. */
  executionError?: boolean;
  /** The server closes the WebSocket mid-run; the run itself goes on. */
  dropSocket?: boolean;
  /** The run samples until it is interrupted or released. */
  hang?: boolean;
  /** How long an interrupted run takes to stop, as a batch finishing its current node; 0 by default. */
  stopDelay?: number;
  /**
   * `/prompt` queues the graph this many milliseconds after the request,
   * whether or not its caller still waits: as long after the caller gave up
   * as the delay says, as a busy instance admits a prompt late.
   */
  lateSubmit?: number;
  /** These cleanup requests answer 500 this many times before they succeed (Infinity: always). */
  failing?: Partial<Record<"queueRead" | "history" | "free" | "release" | "renew", number>>;
  /**
   * A job input upload answers 500 (`refused`), never answers until its
   * caller gives up (`hang`), or is stored and then its answer is lost
   * (`lost`), as a connection that drops after the worker took the bytes.
   */
  upload?: "refused" | "hang" | "lost";
  /** Reading the queue takes this many milliseconds. */
  slowQueue?: number;
  /** Binary frames of these sizes from the sampler node, as a preview method sends them. */
  previews?: number[];
  /** Another client's prompt runs first and does not finish, so a new one waits in the queue. */
  busy?: boolean;
}

export interface FakeRequest {
  method: string;
  url: string;
  authorization: string | null;
  ca: string | undefined;
  redirect: RequestInit["redirect"];
}

/** Text the fake puts in error bodies and frames; it must never surface. */
export const UPSTREAM_SECRET = "upstream-secret-text";

class FakeSocket implements ComfySocket {
  binaryType = "blob";
  closed = false;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    if (this.closed) return;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  serverSend(message: unknown) {
    this.emit(
      "message",
      message instanceof Uint8Array ? message.slice().buffer : JSON.stringify(message),
    );
  }
  close() {
    this.closed = true;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The required inputs of an `/object_info` entry the fake built, to add to. */
const requiredOf = (entry: unknown): Record<string, unknown> => {
  const required: unknown = isRecord(entry) && isRecord(entry.input) ? entry.input.required : {};
  return isRecord(required) ? required : {};
};

/** A combo's choices in either format the fake writes. */
const comboOf = (spec: unknown): string[] => {
  if (!Array.isArray(spec)) return [];
  const [kind, config] = spec;
  const choices: unknown = kind === "COMBO" && isRecord(config) ? config.options : kind;
  return Array.isArray(choices) ? choices.filter((file) => typeof file === "string") : [];
};

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeComfyui(options: FakeComfyuiOptions = {}) {
  const mode = options.mode ?? "plain";
  // Another workflow misses its own files unless the fake explicitly installs it.
  const workflows = options.workflows ?? TEST_WORKFLOWS;
  const workflowId = options.installedWorkflow ?? workflows.defaultWorkflow;
  const workflow = workflows.get(workflowId);
  const state = {
    pending: [] as string[],
    running: undefined as string | undefined,
    history: new Map<string, unknown>(),
    /** The prompt whose outputs the executor cache holds; `/free` drops it. */
    cached: undefined as string | undefined,
    /** Bodies `/free` received. */
    freed: [] as unknown[],
    /** Leases taken and not yet released. */
    leases: new Set<string>(),
    controls: new Map<string, unknown>(),
    outcomes: new Map<string, "leased" | "queued" | "running" | "completed" | "failed">(),
    outputs: new Map<string, { id: string; png: Uint8Array }[]>(),
    released: [] as string[],
    terminal: new Map<string, { at: number; expires: number }>(),
    renewed: [] as { lease: string; at: number }[],
    expired: [] as string[],
    /** Job inputs held, by lease id: the byte length of each, never the bytes. */
    inputs: new Map<string, number[]>(),
    /** Every upload the worker took: its lease, content type, byte length and SHA-256, never the bytes. */
    uploads: [] as { lease: string; type: string | null; bytes: number; sha256: string }[],
    interrupted: [] as string[],
    /** Graphs as submitted, by prompt id. */
    prompts: new Map<string, unknown>(),
    requests: [] as FakeRequest[],
    sockets: [] as { url: string; options: Bun.WebSocketOptions; socket: FakeSocket }[],
  };
  const clients = new Map<string, FakeSocket>();
  const stops = new Map<string, () => void>();
  let freeMemoryRequested = false;
  const now = options.now ?? Date.now;
  const reap = () => {
    for (const [id, terminal] of state.terminal) {
      if (now() < terminal.expires) continue;
      state.leases.delete(id);
      state.inputs.delete(id);
      state.outputs.delete(id);
      state.outcomes.delete(id);
      state.terminal.delete(id);
      state.expired.push(id);
    }
  };

  if (options.busy) state.running = "other-client-prompt";

  const failures = { ...options.failing };
  /** Whether this request is one of those told to fail. */
  const fails = (what: keyof typeof failures) => {
    const left = failures[what] ?? 0;
    if (left <= 0) return false;
    failures[what] = left - 1;
    return true;
  };
  const failed = () => new Response(UPSTREAM_SECRET, { status: 500 });

  /** Runs the queue head: frames to its client, then history, as ComfyUI's worker does. */
  async function run(id: string, clientId: string) {
    while (state.running !== undefined || state.pending[0] !== id) {
      if (!state.pending.includes(id)) return;
      await tick(5);
    }
    state.pending.shift();
    state.running = id;
    state.outcomes.set(id, "running");
    const socket = clients.get(clientId);
    const send = (message: unknown) => {
      if (!options.silent) socket?.serverSend(message);
    };
    let stopped = false;
    const halted = new Promise<void>((resolve) => {
      stops.set(id, () => {
        stopped = true;
        resolve();
      });
    });
    const graph = state.prompts.get(id);
    const nodes = Object.entries(
      (graph ?? {}) as Record<string, { class_type?: unknown; inputs?: Record<string, unknown> }>,
    );
    const output =
      nodes.find(
        ([, node]) =>
          node.class_type === "SaveImageWebsocket" || node.class_type === "AtelierSaveImages",
      )?.[0] ?? workflow.output;
    const sampler =
      nodes.find(([, node]) => String(node.class_type).includes("Sampler"))?.[0] ?? "7";
    const decode = nodes.find(([, node]) => String(node.class_type).includes("VAEDecode"))?.[0];
    const snapshots: Record<string, unknown> = {};
    const progress = (node: string, value: number, max: number) => {
      if (options.progressMode !== "native")
        send({ type: "progress", data: { value, max, prompt_id: id, node } });
      if (options.progressMode !== undefined) {
        snapshots[node] = {
          node_id: node,
          prompt_id: id,
          state: value === max ? "finished" : "running",
          value,
          max,
        };
        send({ type: "progress_state", data: { prompt_id: id, nodes: snapshots } });
      }
    };
    const batch = nodes
      .map(([, node]) => node.inputs?.batch_size)
      .find((size) => typeof size === "number");
    send({ type: "execution_start", data: { prompt_id: id } });
    for (const event of options.progressEvents?.(id) ?? []) send(event);
    send({ type: "execution_success", data: { prompt_id: "unrelated-prompt" } });
    send({ type: "executing", data: { node: sampler, prompt_id: id } });
    if (options.progressMode !== undefined) progress(nodes[0]?.[0] ?? "1", 0, 1);
    progress(sampler, 1, 10);
    for (const size of options.previews ?? []) send(new Uint8Array(size));
    if (options.hang) await halted;
    if (stopped) await tick(options.stopDelay ?? 0);
    if (options.dropSocket) socket?.emit("close");
    if (stopped) {
      send({ type: "execution_interrupted", data: { prompt_id: id, node_id: "7" } });
    } else if (options.executionError) {
      send({
        type: "execution_error",
        data: { prompt_id: id, node_id: "7", exception_message: UPSTREAM_SECRET },
      });
    } else {
      progress(sampler, 10, 10);
      if (decode !== undefined) send({ type: "executing", data: { node: decode, prompt_id: id } });
      if (decode !== undefined && options.progressMode !== undefined) progress(decode, 1, 1);
      send({ type: "executing", data: { node: output, prompt_id: id } });
      const images = typeof options.images === "function" ? options.images(graph) : options.images;
      const outputs = (
        images ?? Array.from({ length: batch ?? CREATOR_ART.count }, () => fakePng())
      ).map((png) => ({ id: crypto.randomUUID(), png }));
      if (mode === "private" && state.leases.has(id)) state.outputs.set(id, outputs);
      for (const [index, { png }] of outputs.entries()) {
        progress(output, index, outputs.length);
        if (mode === "private") continue;
        const metadata =
          options.metadata === undefined
            ? undefined
            : new TextEncoder().encode(
                options.metadata === "malformed"
                  ? "{"
                  : JSON.stringify({
                      prompt_id: options.metadata === "unrelated" ? "other" : id,
                      node_id: output,
                    }),
              );
        const frame = new Uint8Array(8 + (metadata?.byteLength ?? 0) + png.byteLength);
        const view = new DataView(frame.buffer);
        view.setUint32(0, metadata === undefined ? 1 : 4);
        view.setUint32(4, metadata?.byteLength ?? 2);
        if (metadata !== undefined) frame.set(metadata, 8);
        frame.set(png, 8 + (metadata?.byteLength ?? 0));
        send(frame);
      }
      if (options.terminal !== "null") send({ type: "execution_success", data: { prompt_id: id } });
    }
    if (options.terminal !== "success")
      send({ type: "executing", data: { node: null, prompt_id: id } });
    // ComfyUI's worker records history after the last frame, under the queue's lock.
    await options.beforeTaskDone?.(id);
    await tick(20);
    stops.delete(id);
    if (state.running !== id) return;
    state.running = undefined;
    if (state.leases.has(id)) {
      state.outcomes.set(id, options.executionError || stopped ? "failed" : "completed");
      state.terminal.set(id, { at: now(), expires: now() + 120_000 });
    }
    // Atelier's reaper drops history; a plain instance keeps it.
    if (mode === "plain") {
      state.history.set(id, { prompt: state.prompts.get(id), status: {} });
      state.cached = id;
      // Native /free sets a queue flag which the worker consumes after task_done, before its next job.
      if (freeMemoryRequested) {
        state.cached = undefined;
        freeMemoryRequested = false;
      }
    }
  }

  function stop(id: string) {
    if (state.running !== id) return;
    state.interrupted.push(id);
    stops.get(id)?.();
  }

  /** The private worker also has the reference graph's nodes, its LoadImage as Atelier's in-memory one. */
  const reference = workflows.referenceOf(workflowId);
  const referenceNodes =
    mode === "private" && reference !== undefined
      ? Object.values(reference.graph).map((node) => ({
          ...node,
          class_type: node.class_type === "LoadImage" ? "AtelierLoadImage" : node.class_type,
        }))
      : [];
  let busyResponses = options.admission?.busyResponses ?? 0;
  let busyAnswered = 0;
  let startingAnswers = options.startingAnswers ?? 0;
  let cancelNoops = options.nativeCancelNoops ?? 0;

  /**
   * `/object_info` for the installed graphs' classes plus a checkpoint, a
   * LoRA stack, a dual CLIP, a model patch and a VAE loader and the save
   * classes ComfyUI ships: a string input becomes a
   * combo of the graph's value (a file input also lists another file), a
   * placeholder its widget type, a link a socket type, as ComfyUI answers.
   */
  function objectInfo() {
    const info: Record<string, unknown> = {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [["fixture-checkpoint.safetensors"], {}] } },
        output: ["MODEL", "CLIP", "VAE"],
      },
      LoadLoraModel: {
        input: {
          required: {
            model: ["MODEL"],
            loras: [
              "COMFY_DYNAMICGROUP_V3",
              {
                template: {
                  required: {
                    lora_name: [["fixture-lora.safetensors"], {}],
                    strength: ["FLOAT", { default: 1 }],
                    enabled: ["BOOLEAN", { default: true }],
                  },
                },
                min: 1,
                max: 20,
                group_name: "LoRA",
              },
            ],
          },
        },
        output: ["MODEL"],
      },
      DualCLIPLoader: {
        input: {
          required: {
            clip_name1: [["installed-clip-l.safetensors"], {}],
            clip_name2: [["installed-clip-l.safetensors"], {}],
            type: [["flux", "sdxl"], {}],
          },
        },
        output: ["CLIP"],
      },
      ModelPatchLoader: {
        input: { required: { name: [["installed-patch.safetensors"], {}] } },
        output: ["MODEL_PATCH"],
      },
      VAELoader: {
        input: { required: { vae_name: [["installed-vae.safetensors", "pixel_space"], {}] } },
        output: ["VAE"],
      },
      SaveImage: {
        input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", {}] } },
        output: [],
        output_node: true,
      },
      PreviewImage: { input: { required: { images: ["IMAGE"] } }, output: [], output_node: true },
    };
    const nodes = [...referenceNodes, ...Object.values(workflow.graph)];
    if (mode === "private") nodes.push({ class_type: "AtelierSaveImages", inputs: {} });
    for (const node of nodes) {
      const required = requiredOf(info[node.class_type]);
      for (const [name, value] of Object.entries(node.inputs)) {
        const placeholder =
          typeof value === "string" ? /^\{\{(\w+)\}\}$/.exec(value)?.[1] : undefined;
        if (placeholder === "prompt" || name === "text") {
          required[name] = ["STRING", { multiline: true }];
        } else if (placeholder !== undefined) {
          required[name] =
            placeholder === "seed" ? ["INT", { control_after_generate: true }] : ["INT", {}];
        } else if (typeof value === "string") {
          const listed = comboOf(required[name]);
          const files = [
            ...new Set([
              ...listed,
              value,
              // A loader also lists another file; a sampler lists its value only.
              ...(/_(name|path)$/.test(name) && name !== "sampler_name"
                ? ["other.safetensors"]
                : []),
            ]),
          ].filter((file) => !options.missingModels?.includes(file));
          // Both formats ComfyUI uses for a combo input.
          required[name] =
            node.class_type === "CLIPLoader" ? ["COMBO", { options: files }] : [files, {}];
        } else if (typeof value === "number") {
          required[name] = [Number.isInteger(value) ? "INT" : "FLOAT", {}];
        } else if (typeof value === "boolean") {
          required[name] = ["BOOLEAN", {}];
        } else {
          required[name] = ["ANY"];
        }
      }
      info[node.class_type] = {
        input: { required },
        output: [],
        output_node:
          node.class_type === "SaveImageWebsocket" || node.class_type === "AtelierSaveImages",
      };
    }
    for (const [name, entry] of Object.entries(info)) {
      if (options.missingNodes?.includes(name)) delete info[name];
      else
        info[name] = {
          ...(entry as object),
          name,
          display_name: name,
          ...(options.outputNodes?.includes(name) ? { output_node: true } : {}),
        };
    }
    return info;
  }

  async function handle(request: Request, url: URL): Promise<Response> {
    reap();
    const path = url.pathname;
    const body = async () => (await request.json()) as Record<string, unknown>;
    if (path === "/atelier/v1/privacy" && mode === "private") {
      return Response.json({
        protocol: 2,
        ready: startingAnswers-- > 0 ? false : (options.ready ?? true),
        worker_build: "a".repeat(64),
        allowed_nodes: options.allowedNodes ?? Object.keys(objectInfo()).sort(),
        limits: {
          max_jobs: 8,
          max_payload_bytes: 4 * 1024 * 1024,
          max_image_bytes: CREATOR_ART.imageBytes,
          max_images: CREATOR_ART.count,
          pre_submit_seconds: 120,
          terminal_idle_seconds: 120,
          terminal_max_seconds: 600,
          max_execution_seconds: 86_400,
          ...options.limits,
        },
        capabilities: {
          job_status: true,
          image_outputs: true,
          preview_control: true,
          lease_renewal: true,
          job_admission: true,
          execution_budget: true,
          residency_tracking: true,
        },
      });
    }
    const job = /^\/atelier\/v1\/jobs\/([\w-]+)$/.exec(path)?.[1];
    if (job !== undefined && mode === "private") {
      if (request.method === "POST") {
        const controls = await body();
        const executionTimeoutSeconds = controls.executionTimeoutSeconds;
        if (
          typeof executionTimeoutSeconds !== "number" ||
          !Number.isInteger(executionTimeoutSeconds) ||
          executionTimeoutSeconds < 1 ||
          executionTimeoutSeconds > (options.limits?.max_execution_seconds ?? 86_400)
        )
          return Response.json({ error: "invalid_controls" }, { status: 400 });
        if (state.leases.has(job)) return Response.json({ error: "duplicate" }, { status: 409 });
        if (busyResponses-- > 0) {
          const position = options.admission?.positions?.[busyAnswered++];
          return Response.json(
            { error: "worker_busy" },
            {
              status: 429,
              headers: {
                "Retry-After": options.admission?.retryAfter ?? "1",
                "Cache-Control": "no-store",
                ...(position === undefined ? {} : { "Atelier-Queue-Position": position }),
              },
            },
          );
        }
        state.leases.add(job);
        state.controls.set(job, controls);
        state.outcomes.set(job, "leased");
        return Response.json({ ok: true, protocol: 2, ready: true });
      }
      if (request.method === "GET") {
        if (!state.leases.has(job)) return new Response(null, { status: 404 });
        return Response.json({
          state: state.outcomes.get(job) ?? "leased",
          outputs: (state.outputs.get(job) ?? []).map(({ id, png }) => ({
            id,
            bytes: png.byteLength,
            mediaType: "image/png",
          })),
        });
      }
      if (request.method === "DELETE") {
        if (fails("release")) return failed();
        state.leases.delete(job);
        state.inputs.delete(job);
        state.outputs.delete(job);
        state.outcomes.delete(job);
        state.terminal.delete(job);
        state.released.push(job);
        state.pending = state.pending.filter((id) => id !== job);
        // The worker's scoped cancellation: the job is no longer active once released.
        stop(job);
        if (state.running === job) state.running = undefined;
        return Response.json({ ok: true });
      }
    }
    const renewal = /^\/atelier\/v1\/jobs\/([\w-]+)\/renew$/.exec(path)?.[1];
    if (renewal !== undefined && request.method === "POST" && mode === "private") {
      if (!state.leases.has(renewal)) return new Response(null, { status: 404 });
      if (fails("renew")) return failed();
      const terminal = state.terminal.get(renewal);
      if (terminal !== undefined)
        terminal.expires = Math.min(now() + 120_000, terminal.at + 600_000);
      state.renewed.push({ lease: renewal, at: now() });
      return Response.json({ ok: true });
    }
    const output = /^\/atelier\/v1\/jobs\/([\w-]+)\/outputs\/([\w-]+)$/.exec(path);
    if (output !== null && request.method === "GET" && mode === "private") {
      const image = state.leases.has(output[1] ?? "")
        ? state.outputs.get(output[1] ?? "")?.find((image) => image.id === output[2])
        : undefined;
      return image === undefined
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array(image.png), {
            headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
          });
    }
    const input = /^\/atelier\/v1\/jobs\/([\w-]+)\/inputs\/([\w-]+)$/.exec(path);
    if (input !== null && mode === "private" && request.method === "PUT") {
      const lease = input[1] ?? "";
      if (!state.leases.has(lease)) return new Response(UPSTREAM_SECRET, { status: 404 });
      if (options.upload === "refused") return failed();
      if (options.upload === "hang") return new Promise<Response>(() => {});
      const body = new Uint8Array(await request.arrayBuffer());
      const bytes = body.byteLength;
      const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      state.uploads.push({ lease, type: request.headers.get("Content-Type"), bytes, sha256 });
      state.inputs.set(lease, [...(state.inputs.get(lease) ?? []), bytes]);
      if (options.upload === "lost") throw new TypeError("connection reset");
      return Response.json({ ok: true });
    }
    if (path === "/object_info" && request.method === "GET") return Response.json(objectInfo());
    if (path === "/prompt" && request.method === "POST") {
      const { prompt, client_id, prompt_id } = await body();
      if (typeof prompt_id !== "string" || typeof client_id !== "string") {
        return new Response(null, { status: 400 });
      }
      if (mode === "private" && !state.leases.has(prompt_id)) {
        return Response.json({ error: "workflow rejected" }, { status: 400 });
      }
      if (options.submit === "refused") {
        return Response.json(
          { error: { message: UPSTREAM_SECRET }, node_errors: { "4": UPSTREAM_SECRET } },
          { status: 400 },
        );
      }
      if (options.submit === "unauthorized" || options.submit === "forbidden")
        return new Response(null, { status: options.submit === "unauthorized" ? 401 : 403 });
      if (options.lateSubmit !== undefined) await tick(options.lateSubmit);
      if (mode === "private" && !state.leases.has(prompt_id))
        return new Response(null, { status: 400 });
      // Plain older servers may ignore the chosen id. A private job still belongs to its lease,
      // even when a deliberately corrupt acknowledgement names an unrelated identity.
      const id =
        options.submit === "other_id" && mode === "plain" ? crypto.randomUUID() : prompt_id;
      state.prompts.set(id, prompt);
      state.pending.push(id);
      state.outcomes.set(id, "queued");
      void run(id, client_id);
      if (options.submit === "lost") throw new TypeError("connection reset");
      if (options.submit?.startsWith("accepted_"))
        return new Response(UPSTREAM_SECRET, { status: Number(options.submit.slice(9)) });
      if (options.submit === "stalled_headers") return new Promise<Response>(() => {});
      if (options.submit === "stalled_body") return new Response(new ReadableStream());
      if (options.submit === "malformed") return Response.json({ unexpected: true });
      const nodeErrors = options.submit === "node_errors" ? { "4": UPSTREAM_SECRET } : {};
      return Response.json({
        prompt_id: options.submit === "other_id" && mode === "private" ? crypto.randomUUID() : id,
        number: 1,
        node_errors: nodeErrors,
      });
    }
    const canceledJob = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(path)?.[1];
    if (mode === "plain" && canceledJob !== undefined && request.method === "POST") {
      if (options.nativeCancel !== undefined && options.nativeCancel !== true)
        return new Response(UPSTREAM_SECRET, { status: options.nativeCancel });
      if (cancelNoops-- > 0)
        return Response.json({ cancelled: options.nativeCancelNoopResult ?? false });
      state.pending = state.pending.filter((id) => id !== canceledJob);
      stop(canceledJob);
      return Response.json({ cancelled: true });
    }
    if (mode === "plain" && path === "/queue") {
      if (request.method === "POST") {
        const ids = (await body()).delete;
        if (Array.isArray(ids)) state.pending = state.pending.filter((id) => !ids.includes(id));
        return new Response(null, { status: 200 });
      }
      if (options.slowQueue !== undefined) await tick(options.slowQueue);
      if (fails("queueRead")) return failed();
      const item = (id: string) => [0, id, {}, {}, []];
      return Response.json({
        queue_running: state.running === undefined ? [] : [item(state.running)],
        queue_pending: state.pending.map(item),
      });
    }
    if (mode === "plain" && path === "/interrupt" && request.method === "POST") {
      const id = (await body()).prompt_id;
      if (typeof id === "string") stop(id);
      return new Response(null, { status: 200 });
    }
    if (mode === "plain" && path === "/free" && request.method === "POST") {
      if (fails("free")) return failed();
      const flags = await body();
      state.freed.push(flags);
      if (flags.free_memory === true) {
        freeMemoryRequested = state.running !== undefined;
        if (!freeMemoryRequested) state.cached = undefined;
      }
      return new Response(null, { status: 200 });
    }
    const entry = /^\/history\/([\w-]+)$/.exec(path)?.[1];
    if (mode === "plain" && entry !== undefined && request.method === "GET") {
      const found = state.history.get(entry);
      return Response.json(found === undefined ? {} : { [entry]: found });
    }
    if (mode === "plain" && path === "/history" && request.method === "POST") {
      if (fails("history")) return failed();
      const ids = (await body()).delete;
      if (Array.isArray(ids)) for (const id of ids) state.history.delete(String(id));
      return new Response(null, { status: 200 });
    }
    return new Response(UPSTREAM_SECRET, { status: 404 });
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (options.down) throw new TypeError("Unable to connect");
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const bunInit: BunFetchRequestInit | undefined = init;
    state.requests.push({
      method: request.method,
      url: url.href,
      authorization: request.headers.get("Authorization"),
      ca: typeof bunInit?.tls?.ca === "string" ? bunInit.tls.ca : undefined,
      redirect: init?.redirect,
    });
    if (options.redirect) {
      return new Response(null, { status: 302, headers: { Location: "http://elsewhere.test/" } });
    }
    if (options.token && request.headers.get("Authorization") !== `Bearer ${options.token}`) {
      return new Response(null, { status: 401 });
    }
    // ComfyUI goes on with a request whose caller stopped waiting; the caller sees the abort.
    const signal = init?.signal;
    if (signal === undefined || signal === null) return handle(request, url);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      handle(request, url).then(resolve, reject);
    });
  };

  const socket: ComfySocketFactory = (url, socketOptions) => {
    const fake = new FakeSocket();
    state.sockets.push({ url, options: socketOptions, socket: fake });
    const headers = socketOptions.headers ?? {};
    const authorized = !options.token || headers.Authorization === `Bearer ${options.token}`;
    const clientId = new URL(url).searchParams.get("clientId") ?? "";
    setTimeout(() => {
      if (options.down || !authorized) {
        fake.emit("error");
        fake.emit("close");
        return;
      }
      clients.set(clientId, fake);
      fake.emit("open");
      fake.serverSend({
        type: "status",
        data: { status: { exec_info: { queue_remaining: 0 } }, sid: clientId },
      });
    }, 0);
    return fake;
  };

  /** Nothing of a run is left: no queued or running prompt, no history entry, no cache, no lease or job input. */
  const clean = () =>
    state.pending.length === 0 &&
    (state.running === undefined || state.running === "other-client-prompt") &&
    state.history.size === 0 &&
    state.cached === undefined &&
    state.leases.size === 0 &&
    state.inputs.size === 0 &&
    state.outputs.size === 0;

  return { fetch, socket, state, clean, reap };
}
