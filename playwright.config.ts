import { availableParallelism, loadavg } from "node:os";
import { defineConfig, devices } from "@playwright/test";
import { APP_SERVERS, COMFYUI_PORT, FOCUSED_SPECS, UPSTREAM_PORT } from "./e2e/support/env.ts";

// The supported browsers are Chromium-based (ARCHITECTURE.md § Browser baseline).
const browsers = [{ name: "chromium", use: devices["Desktop Chrome"] }];

/*
 * Every test signs in as a user of its own (e2e/support/test.ts), so its
 * settings and entities are its alone and the tests within a spec run side
 * by side too. Three specs run one test at a time against an app server of
 * their own, beside the parallel specs: the M10 acceptance chat, since
 * `mock-scripted` keeps one queue of replies for the whole mock upstream, and
 * the two that would starve whatever ran beside them (a 6 MB card with 5,000
 * rows; large noisy portraits on the shared mock's event loop), whose tests
 * hold Playwright's exclusive lock and so run once nothing else does.
 */
const SERIAL = /(prompt-behavior|vast-lorebook|art-transport)\.spec\.ts$/;

/** The retention scans: they run once every other project is done, whether or not a test failed. */
const SCANS = "server-writes";

/*
 * Measured on 16 cores: 75% keeps per-test times flat; all cores add no
 * speed, only load flakes. Cores other work already holds (another
 * worktree's suite) are left to it, down to four workers; `--workers`
 * overrides the count.
 */
const cores = availableParallelism();
const workers = Math.max(
  4,
  Math.min(Math.floor(cores * 0.75), Math.floor(cores - (loadavg()[0] ?? 0))),
);

/** A coding agent reads the failures and the summary; a person watches the list. */
const agent = [process.env.AI_AGENT, process.env.CLAUDECODE, process.env.CODEX_THREAD_ID].some(
  (value) => value !== undefined && value !== "",
);

/**
 * A project's spec files: every file `match` takes, or in a focused run
 * those of them the run names. The choice is made here rather than by a
 * command line filter, which would leave the retention scans out: they
 * depend on the browser projects, and a dependency runs whole.
 */
function specs(match: RegExp): RegExp | RegExp[] {
  if (FOCUSED_SPECS === undefined) return match;
  const chosen = FOCUSED_SPECS.filter((name) => match.test(name));
  // An empty list would match every file; this pattern matches none.
  if (chosen.length === 0) return /(?!)/;
  return chosen.map((name) => new RegExp(`/${RegExp.escape(name)}$`));
}

export default defineConfig({
  testDir: "e2e",
  // Local runs are the only runs: a focused test would silently skip the retention matrix.
  forbidOnly: true,
  workers,
  /*
   * A failed test runs once more at the end, alone, when this suite's own
   * load is gone. Passing then, it is reported as flaky, never as passed.
   */
  retries: 1,
  retryStrategy: "isolated",
  reporter: agent ? "failures" : "list",
  // Fails once, by name, when this Playwright's Chromium is not installed.
  globalSetup: "./e2e/support/preflight.ts",
  use: {
    baseURL: APP_SERVERS.main.origin,
    trace: "retain-on-failure",
  },
  projects: [
    // Listed first, so its worker starts at once rather than after the parallel specs' queue.
    {
      name: "serial",
      testMatch: specs(SERIAL),
      use: { ...devices["Desktop Chrome"], baseURL: APP_SERVERS.serial.origin },
      fullyParallel: false,
      workers: 1,
      teardown: SCANS,
    },
    ...browsers.map((browser) => ({
      ...browser,
      fullyParallel: true,
      testMatch: specs(/\.spec\.ts$/),
      testIgnore: SERIAL,
      teardown: SCANS,
    })),
    /*
     * Scans what every app server wrote. A teardown rather than a dependent:
     * a failed test elsewhere still leaves the scans of everything that ran.
     * A scan reads files, so a second try would find the same.
     */
    { name: SCANS, testMatch: /server-writes\.check\.ts$/, retries: 0 },
  ],
  webServer: [
    {
      command: "bun e2e/support/mock-upstream.ts",
      port: UPSTREAM_PORT,
      reuseExistingServer: false,
    },
    {
      command: "bun e2e/support/mock-comfyui.ts",
      port: COMFYUI_PORT,
      reuseExistingServer: false,
    },
    // Started in order: the main server clears the last run's files first.
    ...Object.keys(APP_SERVERS).map((name) => ({
      command: `bun e2e/support/app-server.ts ${name}`,
      wait: { stdout: /"event":"listening"/ },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
    })),
  ],
});
