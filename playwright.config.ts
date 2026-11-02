import { defineConfig, devices } from "@playwright/test";
import {
  APP_SERVERS,
  type AppServerName,
  COMFYUI_PORT,
  FOCUSED_SPECS,
  UPSTREAM_PORT,
} from "./e2e/support/env.ts";

// The supported browsers are Chromium-based (ARCHITECTURE.md § Browser baseline).
const browsers = [{ name: "chromium", use: devices["Desktop Chrome"] }];

/*
 * Every test signs in as a user of its own (e2e/support/test.ts), so its
 * settings and entities are its alone and the tests within a spec run side
 * by side too. The M10 acceptance chat runs one test at a time against an
 * app server of its own, beside the parallel specs, since `mock-scripted`
 * keeps one queue of replies for the whole mock upstream.
 */
const SERIAL_GROUPS: {
  name: string;
  server: AppServerName;
  testMatch: RegExp;
  dependencies?: string[];
}[] = [
  { name: "serial", server: "serial", testMatch: /prompt-behavior\.spec\.ts$/ },
  // A 6 MB card and 5,000 rows starve whatever runs beside them: this runs once the rest is done.
  {
    name: "vast-lorebook",
    server: "serial",
    testMatch: /vast-lorebook\.spec\.ts$/,
    dependencies: [...browsers.map((browser) => browser.name), "serial"],
  },
  // Large noisy portraits block the shared mock's event loop, so generate them one at a time last.
  {
    name: "large-art",
    server: "serial",
    testMatch: /art-transport\.spec\.ts$/,
    dependencies: [...browsers.map((browser) => browser.name), "serial", "vast-lorebook"],
  },
];

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
  // Measured on 16 cores: 75% keeps per-test times flat; all cores add no speed, only load flakes.
  workers: "75%",
  reporter: [["list"]],
  use: {
    baseURL: APP_SERVERS.main.origin,
    trace: "retain-on-failure",
  },
  projects: [
    // Listed first, so their workers start at once rather than after the parallel specs' queue.
    // One worker each, one test at a time.
    ...SERIAL_GROUPS.map(({ server, ...group }) => ({
      ...group,
      testMatch: specs(group.testMatch),
      use: { ...devices["Desktop Chrome"], baseURL: APP_SERVERS[server].origin },
      fullyParallel: false,
      workers: 1,
    })),
    ...browsers.map((browser) => ({
      ...browser,
      fullyParallel: true,
      testMatch: specs(/\.spec\.ts$/),
      testIgnore: SERIAL_GROUPS.map((group) => group.testMatch),
    })),
    // Scans what every app server wrote, once every browser project is done.
    {
      name: "server-writes",
      testMatch: /server-writes\.check\.ts$/,
      dependencies: [
        ...browsers.map((browser) => browser.name),
        ...SERIAL_GROUPS.map((group) => group.name),
      ],
    },
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
