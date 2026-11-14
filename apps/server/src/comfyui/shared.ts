import { inflate } from "node:zlib";
import { CREATOR_ART, type CreatorErrorCode, type NodeMetaMap } from "@ephemera/core";
import { readBoundedJson } from "../lifetime.ts";
import { pngChunks } from "../png.ts";
import { requiredModels, type Workflow, type WorkflowGraph } from "./workflow.ts";

/*
 * What the ComfyUI client (client.ts) and its lease and retirement modules
 * share at runtime: the content-free failure, bounded reads of an answer,
 * the abortable wait, what an instance lacks for a graph, the private
 * worker's graph and the check of a candidate PNG. It imports nothing from
 * them.
 */

/** Below Bun's 10 s idle timeout, which would otherwise cut the status request first. */
export const STATUS_TIMEOUT_MS = 8_000;
/** Handshake, lease and submit answers, and one text frame. */
export const MAX_SMALL_BYTES = 64 * 1024;

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
  /** The workflow has classes the allowlist no longer admits: nothing is sent. */
  "blocked",
] as const;
export type ComfyuiFailure = (typeof COMFYUI_FAILURES)[number];

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

/** The parsed JSON body, undefined when it is not JSON; throws when it passes `max`. */
export async function readJson(
  response: Response,
  max: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const read = await readBoundedJson(response, max, signal);
  signal?.throwIfAborted();
  if (!read.ok) throw new ComfyuiError("oversized");
  return read.json;
}

export const discard = async (response: Response) => {
  await response.body?.cancel().catch(() => {});
};

/** Fails an error status without reading its body, which may echo the prompt. */
export async function ok(response: Response): Promise<Response> {
  if (response.ok) return response;
  await discard(response);
  throw new ComfyuiError(
    response.status === 401 || response.status === 403 ? "unauthorized" : "unreachable",
  );
}

export const sleep = (ms: number, signal: AbortSignal) =>
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

/**
 * What the instance lacks for a workflow: classes it does not have, that the
 * submission allowlist or the server's allowlist (`blocked`) refuses, or that
 * it reports as output nodes other than the graph's own save node; and the
 * model files its combos do not list.
 */
export function missing(
  workflow: Workflow,
  meta: NodeMetaMap,
  allowedNodes?: readonly string[],
  blocked: readonly string[] = [],
) {
  const classes = new Set(Object.values(workflow.graph).map((node) => node.class_type));
  const output = Object.hasOwn(workflow.graph, workflow.output)
    ? workflow.graph[workflow.output]?.class_type
    : undefined;
  const missingNodes = [...classes].filter((name) => {
    const node = meta.get(name);
    return (
      blocked.includes(name) ||
      node === undefined ||
      (node.outputNode && name !== output) ||
      (allowedNodes !== undefined && !allowedNodes.includes(name))
    );
  });
  // A blocked reason that names no class of the graph (an unreadable graph) is missing too.
  missingNodes.push(...blocked.filter((name) => !classes.has(name)));
  const missingModels = requiredModels(workflow.graph, meta)
    .filter(
      ({ classType, input, file }) => !meta.get(classType)?.inputs[input]?.choices?.includes(file),
    )
    .map((model) => model.file);
  return { missingNodes, missingModels: [...new Set(missingModels)] };
}

/** The graph as the private worker runs it: its LoadImage reads the job's in-memory inputs. */
export function privateGraph(graph: WorkflowGraph, lease?: string): WorkflowGraph {
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

/** Chunks a candidate may carry: no palette, transparency key, ICC profile, compressed text or animation. */
const CANDIDATE_CHUNKS = new Set(["IHDR", "IDAT", "IEND", "tEXt", "pHYs", "sRGB", "gAMA", "cHRM"]);

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
 * otherwise only `CANDIDATE_CHUNKS`, and image data that is one zlib stream
 * inflating to exactly its scanlines.
 * Inflation stops there, so a small file cannot expand to gigabytes in the
 * tab, nor carry data the tab's decoder would keep copying. Read in memory;
 * the pixels are not kept.
 */
export async function portraitShaped(png: Uint8Array): Promise<boolean> {
  const chunks = pngChunks(png);
  const header = chunks?.[0];
  if (chunks === undefined || header?.type !== "IHDR" || header.data.byteLength !== 13) {
    return false;
  }
  // One IHDR only: a second one could describe other pixels than the first.
  const allowed = chunks.every(
    (chunk, index) => (chunk.type === "IHDR") === (index === 0) && CANDIDATE_CHUNKS.has(chunk.type),
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
