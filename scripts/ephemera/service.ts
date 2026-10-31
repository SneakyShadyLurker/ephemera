/**
 * Running the server for `./ephemera`: the environment it gets, the build it
 * serves, and finding, waiting for and stopping the process `start` left
 * running.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROXY_KEY_HEADER } from "../../apps/server/src/boundary.ts";
import { type Env, localAccess, ROOT, STATE_DIR } from "./env.ts";

export const SERVER_ENTRY = join(ROOT, "apps/server/src/index.ts");
export const SERVE_ENTRY = join(ROOT, "scripts/ephemera/serve.ts");
export const STATIC_DIR = join(ROOT, "apps/web/dist");
export const RUN_FILE = join(STATE_DIR, "server.json");
const BUILD_FILE = join(STATE_DIR, "build.json");
const BUILT_PAGE = join(STATIC_DIR, "index.html");

/** What the running `serve.ts` wrote about itself. */
export interface RunState {
  pid: number;
  url: string;
  local: boolean;
  startedAt: string;
}

/** The build in `apps/web/dist`, as `./ephemera` made it. */
interface BuildStamp {
  revision: string;
  /** The built page's modification time, so a build made by other means is noticed. */
  pageModified: number;
}

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

/** The checkout's commit, or a fixed name outside Git. */
export function checkoutRevision(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "local";
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The revision the current build was made at, when it is still the build `./ephemera` made. */
export function builtRevision(): string | undefined {
  const stamp = readJson<BuildStamp>(BUILD_FILE);
  if (stamp === undefined || !existsSync(BUILT_PAGE)) return undefined;
  return statSync(BUILT_PAGE).mtimeMs === stamp.pageModified ? stamp.revision : undefined;
}

/** Records that the build in `apps/web/dist` was made at `revision`. */
export function stampBuild(revision: string): void {
  ensureStateDir();
  const stamp: BuildStamp = { revision, pageModified: statSync(BUILT_PAGE).mtimeMs };
  writeFileSync(BUILD_FILE, `${JSON.stringify(stamp)}\n`);
}

/**
 * The server's environment under `./ephemera`: the built app, the build's
 * revision (so an open tab offers a reload after an update) and, for a local
 * install, the gateway's origin and a loopback-only server behind it.
 */
export function runEnv(env: Env): Env {
  const access = localAccess(env);
  const revision = builtRevision();
  return {
    ...env,
    EPHEMERA_STATIC_DIR: STATIC_DIR,
    ...(revision !== undefined && { EPHEMERA_BUILD_REVISION: revision }),
    ...(access && { EPHEMERA_ORIGIN: access.origin, EPHEMERA_HOST: "127.0.0.1" }),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A recycled PID belongs to some other program.
  const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return command.status === 0 && command.stdout.includes(SERVE_ENTRY);
}

/** The running server, if any; a record left by one that died is removed. */
export function running(): RunState | undefined {
  const state = readJson<RunState>(RUN_FILE);
  if (state === undefined) return undefined;
  if (alive(state.pid)) return state;
  rmSync(RUN_FILE, { force: true });
  return undefined;
}

/** Whether the server answers its health route, through the gateway when there is one. */
export async function healthy(state: RunState, proxyKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${state.url}/api/health`, {
      headers: state.local ? {} : { [PROXY_KEY_HEADER]: proxyKey },
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** Whether something already listens on a loopback port. */
export async function portTaken(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the started server answers, or its process ends, or the time
 * runs out. Opening every library before listening can take a while.
 */
export async function waitUntilReady(
  pid: number,
  proxyKey: string,
  timeoutMs = 120_000,
): Promise<RunState | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readJson<RunState>(RUN_FILE);
    if (state?.pid === pid && (await healthy(state, proxyKey))) return state;
    if (!alive(pid)) return undefined;
    await sleep(250);
  }
  return undefined;
}

/**
 * Stops the running server and waits for it: the orderly stop saves every
 * library first. True once it has ended.
 */
export async function stopServer(state: RunState, timeoutMs = 30_000): Promise<boolean> {
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(state.pid)) {
      rmSync(RUN_FILE, { force: true });
      return true;
    }
    await sleep(200);
  }
  return false;
}
