import { type ChildProcess, spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { type AppServer, serverEnv } from "./env.ts";

/*
 * The built app as one e2e app server: the suite's (e2e/support/app-server.ts)
 * or one a spec starts and kills on its own for the restart rows of the
 * retention matrix, whose port, data, temp and home directories and captured
 * output are its own, so the spec asserts its server cells itself.
 */

const root = new URL("../../", import.meta.url).pathname;

/** A start takes well under a second; a server silent this long will not listen. */
const START_TIMEOUT_MS = 30_000;
/** Past the server's own 8 s drain: a process still alive then is killed. */
const STOP_TIMEOUT_MS = 15_000;

/** Spawns the built app as `server`, its stdout and stderr piped. */
export const spawnServer = (server: AppServer): ChildProcess =>
  spawn("bun", ["apps/server/src/index.ts"], {
    cwd: root,
    env: serverEnv(server),
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * Starts the built app as `server`, its output appended to `log`; resolves
 * once it listens. A server that exits first, or stays silent past the start
 * deadline, is killed and fails the start.
 */
export async function startServer(server: AppServer, log: WriteStream): Promise<ChildProcess> {
  const child = spawnServer(server);
  child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
  const deadline = AbortSignal.timeout(START_TIMEOUT_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        log.write(chunk);
        output += chunk.toString("utf8");
        if (output.includes('"event":"listening"')) resolve();
      });
      child.once("exit", (code) => reject(new Error(`server exited before listening (${code})`)));
      child.once("error", reject);
      deadline.addEventListener("abort", () =>
        reject(new Error(`server did not listen within ${START_TIMEOUT_MS} ms`)),
      );
    });
  } catch (error) {
    await stopServer(child, "SIGKILL");
    throw error;
  }
  return child;
}

/** Sends `signal` and waits for the exit; a server that outlives the stop deadline is killed. */
export async function stopServer(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  const escalation = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  try {
    await exited;
  } finally {
    clearTimeout(escalation);
  }
}
