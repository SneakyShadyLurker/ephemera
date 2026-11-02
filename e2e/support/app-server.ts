/**
 * Starts the built app for e2e tests as one of the APP_SERVERS (named by the
 * first argument) with its own TMPDIR and HOME and captures its output, so
 * the retention check can inspect everything the server wrote.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { APP_SERVERS, E2E_DIR, isAppServerName, RUN_STARTED } from "./env.ts";
import { spawnServer } from "./own-server.ts";

const name = process.argv[2];
if (!isAppServerName(name)) throw new Error(`no app server named ${name}`);
const server = APP_SERVERS[name];

// Playwright starts its web servers one after another, the main one first:
// it clears the last run's files before any other server writes.
if (name === "main") rmSync(E2E_DIR, { recursive: true, force: true });
mkdirSync(server.tmp, { recursive: true });
mkdirSync(server.home, { recursive: true });
if (name === "main") writeFileSync(RUN_STARTED, String(Date.now()));

const child = spawnServer(server);
// Each chunk reaches the log before the next, so a stop loses none of it.
child.stdout?.on("data", (chunk: Buffer) => {
  appendFileSync(server.log, chunk);
  process.stdout.write(chunk);
});
child.stderr?.on("data", (chunk: Buffer) => {
  appendFileSync(server.log, chunk);
  process.stderr.write(chunk);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    child.kill();
    process.exit(0);
  });
}
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
