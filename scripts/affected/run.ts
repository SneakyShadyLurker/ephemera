/**
 * Runs the checks a change calls for (ARCHITECTURE.md § Affected tests):
 *
 *   bun run test:affected [--base <ref>] [--dry-run] [--workers <value>]
 *
 * The change is everything that differs from the merge base with `<ref>`
 * (default `origin/main`): commits, staged and unstaged edits, new files.
 * `bun run check` runs whole, the gate before a merge, then Playwright the
 * specs of the areas the change serves (e2e/areas.ts), with the retention
 * scans after them.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { type Importers, importersOf, usersOf } from "./graph.ts";
import { isHub, specsFor } from "./plan.ts";

const ROOT = resolve(import.meta.dir, "../..");
let options: { base: string; "dry-run"?: boolean; workers?: string };
try {
  options = parseArgs({
    options: {
      base: { type: "string", default: "origin/main" },
      "dry-run": { type: "boolean" },
      workers: { type: "string" },
    },
    strict: true,
  }).values;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("usage: bun run test:affected [--base <ref>] [--dry-run] [--workers <value>]");
  process.exit(2);
}
const { base } = options;

/** The whole suite's environment: a focus left in the shell must not narrow it. */
const { EPHEMERA_E2E_SPECS: _focus, ...WHOLE } = process.env;

/** A command's output split at `separator`, or undefined when it fails. */
async function output(command: string[], separator: string): Promise<string[] | undefined> {
  const result = await $`${command}`.cwd(ROOT).env(WHOLE).quiet().nothrow();
  return result.exitCode === 0 ? result.text().split(separator).filter(Boolean) : undefined;
}

async function run(label: string, command: string[], env: Record<string, string> = {}) {
  console.log(`\n▸ ${label}`);
  const child = Bun.spawn(command, {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...WHOLE, ...env },
  });
  const code = await child.exited;
  if (code !== 0) {
    console.error(`\n${label} failed`);
    process.exit(code);
  }
}

// Both the diff and Playwright's listing compare against the merge base, so work landed on `base` since does not count.
const mergeBase = (await output(["git", "merge-base", "HEAD", base], "\n"))?.[0];
const [committed, untracked] = await Promise.all([
  // NUL-separated, so no path is quoted; without rename detection, so a moved file's old path counts.
  mergeBase === undefined
    ? undefined
    : output(["git", "diff", "--name-only", "--no-renames", "-z", mergeBase], "\0"),
  output(["git", "ls-files", "--others", "--exclude-standard", "-z"], "\0"),
]);
if (mergeBase === undefined || committed === undefined || untracked === undefined) {
  console.error(`test:affected could not read the change against ${base}`);
  process.exit(2);
}
const changed = [...new Set([...committed, ...untracked])].sort();
const existing = changed.filter((path) => existsSync(resolve(ROOT, path)));

/*
 * The specs that import a changed file, from Playwright's own graph. A
 * listing that fails leaves the question open, so the plan takes every spec.
 */
const listed = await output(
  [
    "bun",
    "x",
    "playwright",
    "test",
    `--only-changed=${mergeBase}`,
    "--list",
    "--pass-with-no-tests",
  ],
  "\n",
);
const importing = [
  ...new Set(
    (listed ?? []).flatMap(
      (line) => /› (?:.*\/)?([^/›]+\.spec\.ts):\d+:\d+ ›/.exec(line)?.[1] ?? [],
    ),
  ),
];
// The source's own import graph; without one, as without the listing, every spec runs.
let importers: Importers | undefined;
try {
  importers = importersOf(ROOT);
} catch (error) {
  console.error(`import graph unavailable: ${error instanceof Error ? error.message : "unknown"}`);
}
const graph = importers;
const specs =
  listed === undefined || graph === undefined
    ? "all"
    : specsFor(changed, existing, importing, (path) => usersOf(graph, path, isHub));

console.log(`${changed.length} changed files against ${base}`);
console.log("  check      whole");
console.log(
  `  e2e        ${specs === "all" ? "all" : specs.length === 0 ? "none" : specs.join(", ")}`,
);
if (options["dry-run"]) process.exit(0);

await run("check", ["bun", "run", "check"]);
const e2e = ["bun", "run", "test:e2e"];
if (options.workers !== undefined) e2e.push(`--workers=${options.workers}`);
if (specs === "all") await run("e2e", e2e);
else if (specs.length > 0) {
  await run(`e2e: ${specs.join(", ")}`, e2e, {
    EPHEMERA_E2E_SPECS: specs.join(","),
  });
}
console.log("\ntest:affected passed");
