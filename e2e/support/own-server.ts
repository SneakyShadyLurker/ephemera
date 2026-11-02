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

/** Spawns the built app as `server`, its stdout and stderr piped. */
export const spawnServer = (server: AppServer): ChildProcess =>
  spawn("bun", ["apps/server/src/index.ts"], {
    cwd: root,
    env: serverEnv(server),
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Starts the built app as `server`, its output appended to `log`; resolves once it listens. */
export async function startServer(server: AppServer, log: WriteStream): Promise<ChildProcess> {
  const child = spawnServer(server);
  child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      log.write(chunk);
      output += chunk.toString("utf8");
      if (output.includes('"event":"listening"')) resolve();
    });
    child.once("exit", (code) => reject(new Error(`server exited before listening (${code})`)));
  });
  return child;
}

export async function stopServer(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill(signal);
  await exited;
}
