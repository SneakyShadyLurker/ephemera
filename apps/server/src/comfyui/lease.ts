import { CREATOR_ART, type NodeMetaMap } from "@ephemera/core";
import { z } from "zod";
import type { Logger } from "../log.ts";
import type { RunWorkflow } from "./catalog.ts";
import type { CleanupTiming, RecoveryTiming, Unresolved, WorkerLimits } from "./client.ts";
import {
  ComfyuiError,
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
import type { Workflow } from "./workflow.ts";

/*
 * The private worker's lease protocol (PRINCIPLES.md 1): whether the
 * reference graph can run, the reference image as an in-memory job input,
 * the lease-scoped status, the memory outputs with the lease renewed while
 * they are read, and the release that removes the job with its inputs and
 * outputs. The client (client.ts) admits the lease and submits under it; it
 * lends its transport, its inventory read and its timing through the host.
 */

const OUTPUT_TIMEOUT_MS = 60_000;
export const jobStatusSchema = z.strictObject({
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

/** What the client lends the lease protocol, the retirement's retry and report included. */
interface LeaseHost {
  timing: CleanupTiming;
  recoveryTiming: RecoveryTiming;
  /** Where a reference graph that cannot run is reported, by reason only. */
  log: Logger | undefined;
  /** One request to the configured instance; redirects are refused, never followed. */
  call: (
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    init?:
      | { method?: "POST" | "DELETE"; body?: unknown }
      | { method: "PUT"; bytes: Uint8Array<ArrayBuffer> },
  ) => Promise<Response>;
  /** A request whose answer only needs to be a success. */
  send: (
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    init: { method: "POST" | "DELETE"; body?: unknown },
  ) => Promise<void>;
  /** The instance's node meta, from an `/object_info` read simultaneous callers share. */
  inventory: (baseUrl: string, signal: AbortSignal) => Promise<NodeMetaMap>;
  /** One cleanup request with its tries (retirement.ts); false when all failed. */
  retried: (request: (signal: AbortSignal) => Promise<void>) => Promise<boolean>;
  /** Reports a cleanup that ended unresolved (retirement.ts). */
  unresolved: (reason: Unresolved) => void;
}

export function createLease(host: LeaseHost) {
  const { timing, recoveryTiming, call, send, inventory, retried, unresolved } = host;

  /**
   * The workflow's reference graph when the private worker has every node
   * class and model it needs, read from one `/object_info` answer and the
   * submission allowlist; otherwise the text graph runs. Logs name reasons only.
   */
  async function usableReference(
    baseUrl: string,
    workflow: RunWorkflow,
    signal: AbortSignal,
    allowedNodes: string[] | undefined,
  ): Promise<Workflow | undefined> {
    const { reference } = workflow;
    if (reference === undefined) return undefined;
    const { missingNodes, missingModels } = missing(
      { ...reference, graph: privateGraph(reference.graph, "readiness") },
      await inventory(baseUrl, signal),
      allowedNodes,
    );
    if (missingNodes.length === 0 && missingModels.length === 0) return reference;
    host.log?.warn({
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

  return { usableReference, upload, jobStatus, retrieve, release };
}
