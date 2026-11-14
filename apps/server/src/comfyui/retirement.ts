import { z } from "zod";
import type { Logger } from "../log.ts";
import type { CleanupTiming, Unresolved } from "./client.ts";
import { ComfyuiError, discard, ok, readJson, sleep } from "./shared.ts";

/*
 * A plain ComfyUI's retirement (PRINCIPLES.md 1): after every run the client
 * removes its own prompt from the queue and the history and asks the
 * instance to drop its executor cache, with a follow-up for a prompt it
 * could not see leave. Every call runs on its own deadline, never on the
 * request's signal, and holds ids and flags only. The client (client.ts)
 * lends its transport and timing through the host and starts `clean`
 * detached from the run.
 */

/**
 * Lease release, plain cleanup's queue poll and each later cleanup call run
 * on a deadline of this length each, never on the request's signal.
 */
const CLEANUP_TIMEOUT_MS = 4_000;
/** Tries of a lease release, history delete or cache release before it counts as failed. */
const CLEANUP_ATTEMPTS = 3;
/** Every queued graph, other clients' included. */
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const queueSchema = z.object({
  queue_running: z.array(z.array(z.unknown())),
  queue_pending: z.array(z.array(z.unknown())),
});

/** What the client lends the retirement. */
interface RetirementHost {
  timing: CleanupTiming;
  /** The process is stopping: follow-ups make their last check at once. */
  stopping: AbortSignal;
  /** Where a cleanup that stays unresolved is reported, by reason code only. */
  log: Logger | undefined;
  /** One request to the configured instance; redirects are refused, never followed. */
  call: (
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    init?: { method?: "POST" | "DELETE"; body?: unknown },
  ) => Promise<Response>;
  /** A request whose answer only needs to be a success. */
  send: (
    baseUrl: string,
    path: string,
    signal: AbortSignal,
    init: { method: "POST" | "DELETE"; body?: unknown },
  ) => Promise<void>;
}

export function createRetirement(host: RetirementHost) {
  const { timing, stopping, call, send } = host;

  const unresolved = (reason: Unresolved) =>
    host.log?.warn({ event: "comfyui.cleanup.unresolved", errorClass: reason });

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

  return { clean, retried, unresolved };
}
