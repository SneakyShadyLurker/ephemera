import { createHash, randomBytes } from "node:crypto";
import { ALWAYS_SPECS, SPEC_AREAS } from "../areas.ts";

/** Everything the server writes during e2e runs goes under this ignored directory. */
export const E2E_DIR = new URL("../../.e2e/", import.meta.url).pathname;

/**
 * Synthetic settings shared by the e2e servers and tests. The ports derive
 * from the checkout's path into one of 4,760 slots of eight, above the
 * highest port Chromium refuses to load (10080) and below the ephemeral
 * range, so runs in separate worktrees almost always use separate ports; a
 * port another process holds fails the run at start rather than sharing it.
 */
const PORT_BASE =
  11_000 + (createHash("sha256").update(E2E_DIR).digest().readUInt32BE() % 4_760) * 8;
const APP_PORT = PORT_BASE;
export const UPSTREAM_PORT = PORT_BASE + 1;
/** The server e2e/restart.spec.ts starts and kills on its own. */
export const RESTART_PORT = PORT_BASE + 2;
/** The mock ComfyUI (e2e/support/mock-comfyui.ts). */
export const COMFYUI_PORT = PORT_BASE + 5;
export const E2E_PROXY_KEY = "e2e-proxy-key-0123456789abcdef0123456789";
/** Atelier's key, which opens the image card route only (apps/server/src/boundary.ts). */
export const E2E_INTEGRATION_KEY = "e2e-integration-key-0123456789abcdef01234";
/** The master key the e2e servers encrypt user databases under; a fixed test value. */
export const E2E_DATA_KEY = "e2e0".repeat(16);
export const RUN_STARTED = `${E2E_DIR}started-at`;
/**
 * The spec files a focused run takes (`bun run test:affected` sets
 * `EPHEMERA_E2E_SPECS` to their names); undefined for the whole suite, which
 * an empty value also means.
 */
const knownSpecs = new Set([...Object.keys(SPEC_AREAS), ...ALWAYS_SPECS]);

export function parseFocusedSpecs(value: string | undefined): string[] | undefined {
  const focused = value?.split(",").filter((name) => name !== "") ?? [];
  const unknown = focused.filter((name) => !knownSpecs.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown EPHEMERA_E2E_SPECS filenames: ${unknown.join(", ")}. Use spec filenames listed in e2e/areas.ts.`,
    );
  }
  return focused.length === 0 ? undefined : focused;
}

export const FOCUSED_SPECS = parseFocusedSpecs(process.env.EPHEMERA_E2E_SPECS);

/**
 * An e2e app server on its own port, with what it keeps apart so the
 * retention check can inspect everything it wrote: its data directory
 * (SQLite), `TMPDIR`, `HOME` and captured output.
 */
export const appServer = (port: number, dir: string) => ({
  port,
  dir,
  origin: `http://127.0.0.1:${port}`,
  data: `${dir}data`,
  tmp: `${dir}tmp`,
  home: `${dir}home`,
  log: `${dir}server.log`,
});

/**
 * The app servers playwright.config.ts starts: `main` for the parallel specs,
 * and `serial` for the specs that run one test at a time beside them.
 */
export const APP_SERVERS = {
  main: appServer(APP_PORT, E2E_DIR),
  serial: appServer(PORT_BASE + 4, `${E2E_DIR}serial/`),
} as const;
export type AppServer = ReturnType<typeof appServer>;

/** The environment an e2e app server runs the built app with. */
export const serverEnv = (server: AppServer): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: server.home,
  TMPDIR: server.tmp,
  EPHEMERA_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
  EPHEMERA_UPSTREAM_API_KEY: "e2e-upstream-key",
  EPHEMERA_PROXY_KEY: E2E_PROXY_KEY,
  EPHEMERA_INTEGRATION_KEY: E2E_INTEGRATION_KEY,
  EPHEMERA_DATA_KEY: E2E_DATA_KEY,
  EPHEMERA_ORIGIN: server.origin,
  EPHEMERA_PORT: String(server.port),
  EPHEMERA_STATIC_DIR: new URL("../../apps/web/dist", import.meta.url).pathname,
  EPHEMERA_DATA_DIR: server.data,
  // Every test signs in as a new user; specs import the cards they need.
  EPHEMERA_STARTER_CHARACTER: "off",
  /** A synthetic second workflow beside the bundled ones (e2e/support/workflows/). */
  EPHEMERA_WORKFLOWS_DIR: new URL("./workflows", import.meta.url).pathname,
  COMFYUI_ALLOWED_ORIGINS: `http://127.0.0.1:${COMFYUI_PORT}`,
});
/** The server e2e/creator-retention.spec.ts starts and kills on its own. */
export const CREATOR_RESTART = appServer(PORT_BASE + 6, `${E2E_DIR}creator-restart/`);
/** The origin of the parallel specs' app server. */
export const APP_ORIGIN = APP_SERVERS.main.origin;
export type AppServerName = keyof typeof APP_SERVERS;
export const isAppServerName = (name: string | undefined): name is AppServerName =>
  name !== undefined && Object.hasOwn(APP_SERVERS, name);

/** One empty file per retention matrix row that ran, named by its canary label. */
export const CLASSES_DIR = `${E2E_DIR}classes`;

/** What SWAG injects for `user` after their Authelia sign-in. */
export const swagHeaders = (user: string) => ({
  "X-Ephemera-Proxy-Key": E2E_PROXY_KEY,
  "Remote-User": user,
});

/**
 * SWAG's headers plus the binding to `user` that the tab adds to its API
 * requests, which every unsafe request through the proxy key needs. A browser
 * context that switches users carries `swagHeaders` only, so its tab's own
 * binding goes out unchanged.
 */
export const boundHeaders = (user: string) => ({ ...swagHeaders(user), "X-Ephemera-User": user });

/**
 * A username no other test uses: `u-` and 8 random lowercase hex characters.
 * Every test signs in as one of its own (e2e/support/test.ts), so its user's
 * instance, settings included, is the test's alone (PRINCIPLES.md 2).
 */
export const freshUser = () => `u-${randomBytes(4).toString("hex")}`;

/** What Atelier's server sends for `user` in place of SWAG's headers: its own key and their name. */
export const integrationHeaders = (user: string) => ({
  "X-Ephemera-Proxy-Key": E2E_INTEGRATION_KEY,
  "Remote-User": user,
});

/**
 * Canaries are assembled at runtime so no source file contains the marker;
 * a scan for it can then only hit copies written during the run.
 */
export const CANARY_MARKER = ["zq", "canary", "7w"].join("");

export function canary(label: string): string {
  return `${CANARY_MARKER}-${label}-${crypto.randomUUID().slice(0, 8)}`;
}
