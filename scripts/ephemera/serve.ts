/**
 * The process `./ephemera start` runs: the server on the built app and, for
 * a local install, the gateway in front of it. They live and stop together;
 * a stop gives the server its orderly shutdown, which saves every library.
 * Its output is the server's operational log; in the background it goes
 * nowhere, as in the container (docs/PRINCIPLES.md 1).
 */
import { rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../apps/server/src/config.ts";
import { localAccess, serverEnv } from "./env.ts";
import { gatewayHandler } from "./gateway.ts";
import { ensureStateDir, RUN_FILE, type RunState, runEnv, SERVER_ENTRY } from "./service.ts";

const env = runEnv(serverEnv());
const access = localAccess(env);
const config = loadConfig(env);

const gateway =
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

const server = Bun.spawn([process.execPath, "--no-env-file", SERVER_ENTRY], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

const state: RunState = {
  pid: process.pid,
  url: access?.origin ?? `http://${config.host}:${config.port}`,
  local: access !== undefined,
  startedAt: new Date().toISOString(),
};
ensureStateDir();
writeFileSync(RUN_FILE, `${JSON.stringify(state)}\n`, { mode: 0o600 });

let stopping = false;
async function stop(code?: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    void gateway?.stop(true);
    server.kill("SIGTERM");
  }
  const exit = await server.exited;
  rmSync(RUN_FILE, { force: true });
  process.exit(code ?? exit);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => void stop(0));
}
// The server ending on its own (a refused start, a crash) ends the gateway too.
void server.exited.then((exit) => stop(exit));
