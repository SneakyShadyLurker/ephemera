/**
 * Running the server for `./ephemera`: the environment it gets, the build it
 * serves, and finding, waiting for and stopping the process `start` left
 * running.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROXY_KEY_HEADER } from "../../apps/server/src/boundary.ts";
import { DEFAULT_DATA_DIR, type Env, HOME_DIR, localAccess, ROOT, STATE_DIR } from "./env.ts";

export const SERVER_ENTRY = join(ROOT, "apps/server/src/index.ts");
export const SERVE_ENTRY = join(ROOT, "scripts/ephemera/serve.ts");
export const WEB_WORKSPACE = join(ROOT, "apps/web");
/**
 * The build the server serves, apart from `apps/web/dist` (which `bun run
 * build` and e2e rewrite), and the next one, made beside it while the
 * server runs and swapped in only while it is stopped.
 */
export const STATIC_DIR = join(STATE_DIR, "web");
export const STAGING_DIR = join(STATE_DIR, "web-next");
export const RUN_FILE = join(STATE_DIR, "server.json");
/** How the last `serve.ts` ended: whether its server saved every library. */
export const EXIT_FILE = join(STATE_DIR, "exit.json");
/** A stop asked of the running `serve.ts`, naming its PID: signals do not reach it on Windows. */
export const STOP_FILE = join(STATE_DIR, "stop.json");
/** The commit an installed copy (not a Git checkout) was downloaded at. */
export const REVISION_FILE = join(ROOT, "REVISION");
const BUILD_FILE = join(STATE_DIR, "build.json");
const STAGED_FILE = join(STATE_DIR, "build-next.json");

/** What the running `serve.ts` wrote about itself. */
export interface RunState {
  pid: number;
  url: string;
  local: boolean;
  startedAt: string;
}

export interface ExitState {
  pid: number;
  code: number;
}

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

/**
 * The code's commit: the checkout's, or the one an installed copy records.
 * Undefined for any other copy, where every start builds afresh.
 */
export function checkoutRevision(): string | undefined {
  if (existsSync(REVISION_FILE)) return readFileSync(REVISION_FILE, "utf8").trim() || undefined;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The revision the served build was made at. */
export function builtRevision(): string | undefined {
  if (!existsSync(join(STATIC_DIR, "index.html"))) return undefined;
  return readJson<{ revision: string }>(BUILD_FILE)?.revision;
}

/** Whether the served build is not this checkout's, or cannot be known to be. */
export function buildOutdated(): boolean {
  const revision = checkoutRevision();
  return revision === undefined || builtRevision() !== revision;
}

/** The revision a new build is made at: the commit, or a fresh name outside Git. */
export function nextRevision(): string {
  return checkoutRevision() ?? `local-${Date.now().toString(36)}`;
}

/** The command that builds the app into the staging directory, run in the web workspace. */
export function buildCommand(): string[] {
  return [process.execPath, "run", "build", "--outDir", STAGING_DIR, "--emptyOutDir"];
}

/** Records the staged build's revision once it is complete. */
export function stageBuild(revision: string): void {
  writeFileSync(STAGED_FILE, `${JSON.stringify({ revision })}\n`);
}

/** Puts the staged build in the served one's place; only while the server is stopped. */
export function installStagedBuild(): void {
  const staged = readJson<{ revision: string }>(STAGED_FILE);
  if (staged === undefined || !existsSync(join(STAGING_DIR, "index.html"))) {
    throw new Error("no complete staged build");
  }
  rmSync(STATIC_DIR, { recursive: true, force: true });
  renameSync(STAGING_DIR, STATIC_DIR);
  writeFileSync(BUILD_FILE, `${JSON.stringify(staged)}\n`);
  rmSync(STAGED_FILE, { force: true });
}

/**
 * The data directory, a relative one read from the install's home: the
 * server's working directory is a version folder an update removes.
 */
export function dataDir(env: Env): string {
  return env.EPHEMERA_DATA_DIR ? resolve(HOME_DIR, env.EPHEMERA_DATA_DIR) : DEFAULT_DATA_DIR;
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
    EPHEMERA_DATA_DIR: dataDir(env),
    EPHEMERA_STATIC_DIR: STATIC_DIR,
    ...(revision !== undefined && { EPHEMERA_BUILD_REVISION: revision }),
    ...(access && { EPHEMERA_ORIGIN: access.origin, EPHEMERA_HOST: "127.0.0.1" }),
  };
}

/** A process's command line, without the quotes Windows puts around paths with spaces. */
function commandLine(pid: number): string | undefined {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // UTF-8, so a profile path such as C:\Users\Jürgen reads back as written.
            `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
          ],
          { encoding: "utf8", windowsHide: true },
        )
      : spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return (process.platform === "win32" ? result.stdout.replaceAll('"', "") : result.stdout).trim();
}

/** PIDs already seen running serve.ts: Windows answers the command line slowly. */
const confirmed = new Set<number>();

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    confirmed.delete(pid);
    return false;
  }
  if (confirmed.has(pid)) return true;
  // A recycled PID belongs to some other program: only serve.ts's own command line counts.
  const matches = commandLine(pid)?.endsWith(` --no-env-file ${SERVE_ENTRY}`) === true;
  if (matches) confirmed.add(pid);
  return matches;
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
      // Loopback never goes through the shell's HTTP_PROXY.
      proxy: false,
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

export type StopOutcome = "saved" | "not-saved" | "still-running";

/**
 * Stops the running server and waits for it: the orderly stop saves every
 * library first, and `serve.ts` records whether that worked.
 */
export async function stopServer(state: RunState, timeoutMs = 30_000): Promise<StopOutcome> {
  // Saved only on serve.ts's own word that its server ended cleanly.
  const outcome = (): StopOutcome => {
    const exit = readJson<ExitState>(EXIT_FILE);
    return exit?.pid === state.pid && exit.code === 0 ? "saved" : "not-saved";
  };
  // A request file, since a signal would end it at once on Windows; elsewhere
  // SIGTERM too, which a serve.ts from before the request file also heeds.
  writeFileSync(STOP_FILE, `${JSON.stringify({ pid: state.pid })}\n`);
  if (process.platform !== "win32") {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      return outcome();
    }
  }
  if (!alive(state.pid)) return outcome();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(state.pid)) return outcome();
    await sleep(200);
  }
  return "still-running";
}
