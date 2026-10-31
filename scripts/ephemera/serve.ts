/**
 * The process `./ephemera start` runs: the server on the built app and, for
 * a local install, the gateway in front of it. They live and stop together;
 * a stop gives the server its orderly shutdown, which saves every library.
 * Its output is the server's operational log; in the background it goes
 * nowhere, as in the container (docs/PRINCIPLES.md 1).
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../apps/server/src/config.ts";
import { localAccess, serverEnv } from "./env.ts";
import { gatewayHandler } from "./gateway.ts";
import {
  EXIT_FILE,
  type ExitState,
  ensureStateDir,
  RUN_FILE,
  type RunState,
  readJson,
  runEnv,
  running,
  SERVER_ENTRY,
  STOP_FILE,
} from "./service.ts";

const env = runEnv(serverEnv());
const access = localAccess(env);
const config = loadConfig(env);

// One server per checkout: the record is taken exclusively before anything
// listens, so a second start ends here instead of orphaning the first.
ensureStateDir();
if (running() !== undefined) {
  process.stderr.write("Ephemera is already running.\n");
  process.exit(1);
}
const state: RunState = {
  pid: process.pid,
  url: access?.origin ?? `http://${config.host}:${config.port}`,
  local: access !== undefined,
  startedAt: new Date().toISOString(),
};
try {
  writeFileSync(RUN_FILE, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
} catch {
  process.stderr.write("Ephemera is already starting.\n");
  process.exit(1);
}

function finish(code: number): never {
  if (readJson<RunState>(RUN_FILE)?.pid === process.pid) rmSync(RUN_FILE, { force: true });
  const exit: ExitState = { pid: process.pid, code };
  writeFileSync(EXIT_FILE, `${JSON.stringify(exit)}\n`);
  process.exit(code);
}

let gateway: Bun.Server<undefined> | undefined;
try {
  gateway =
    access &&
    Bun.serve({
      hostname: "127.0.0.1",
      port: access.port,
      development: false,
      fetch: gatewayHandler({
        access,
        proxyKey: config.proxyKey,
        target: `http://127.0.0.1:${config.port}`,
      }),
      error: () => new Response("Gateway error\n", { status: 500 }),
    });
} catch {
  process.stderr.write(`Port ${access?.port} is taken.\n`);
  finish(1);
}

// Its own process group, so a terminal's hangup or Ctrl-C reaches this
// process alone, which turns it into the server's orderly stop. The stop is
// asked over IPC, which works where signals do not (Windows).
const server = spawn(process.execPath, ["--no-env-file", SERVER_ENTRY], {
  env,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
const exited = new Promise<number>((resolve) => {
  server.on("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
});

/** How often a stop request is looked for. */
const STOP_POLL_MS = 300;

/** How long the gateway may take to hand the last replies to the browser. */
const GATEWAY_DRAIN_MS = 5_000;

let stopping = false;
async function stop(): Promise<never> {
  if (!stopping) {
    stopping = true;
    if (!server.connected || !server.send("stop")) server.kill("SIGTERM");
  }
  const code = await exited;
  // Replies the server finished may still be on their way to the browser.
  await Promise.race([gateway?.stop(), Bun.sleep(GATEWAY_DRAIN_MS)]);
  finish(code);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => void stop());
}
// The server ending on its own (a refused start, a crash) ends the gateway too.
void exited.then(() => stop());
// `./ephemera stop` asks through a file: a signal would end this at once on Windows.
setInterval(() => {
  if (readJson<{ pid: number }>(STOP_FILE)?.pid !== process.pid) return;
  rmSync(STOP_FILE, { force: true });
  void stop();
}, STOP_POLL_MS);
