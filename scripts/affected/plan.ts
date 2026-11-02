import {
  ALWAYS_SPECS,
  type Area,
  COMPOSITION,
  NO_E2E,
  SOURCE_AREAS,
  SPEC_AREAS,
} from "../../e2e/areas.ts";

/** Changes that reach every spec: dependencies and compiler configuration. */
const EVERYTHING = [/(^|\/)package\.json$/, /^bun\.lock$/, /(^|\/)tsconfig[^/]*\.json$/];

/** The specs a change calls for: `all`, the spec files to run, or none. */
export type Specs = "all" | string[];

/** The areas a source path serves, or `all` for source the table does not name. */
export function areasOf(path: string): readonly Area[] | "all" | "none" {
  if (NO_E2E.some((pattern) => pattern.test(path))) return "none";
  let best: (typeof SOURCE_AREAS)[number] | undefined;
  for (const entry of SOURCE_AREAS) {
    if (path.startsWith(entry[0]) && entry[0].length > (best?.[0].length ?? 0)) best = entry;
  }
  return best?.[1] ?? "all";
}

/**
 * Whether importing a file says nothing about where a change lands: the
 * files that compose the app, and shared source no area owns (the API
 * client, query cache, persistence), which nearly every module reaches.
 * Importer traversal stops before these hubs. A change to shared source
 * owned by `all` itself still takes the whole suite.
 */
export const isHub = (path: string) =>
  COMPOSITION.some((pattern) => pattern.test(path)) || areasOf(path) === "all";

/**
 * The e2e specs a change calls for. `changed` are repository paths
 * (deleted ones included, since what imported them is affected),
 * `existing` those still on disk, `importing` the spec files Playwright
 * found to import a changed file, `users` the source files that import a
 * path directly or transitively, stopping before hubs
 * (scripts/affected/graph.ts).
 */
export function specsFor(
  changed: string[],
  existing: string[],
  importing: string[] = [],
  users: (path: string) => readonly string[] = () => [],
): Specs {
  if (changed.some((path) => EVERYTHING.some((pattern) => pattern.test(path)))) return "all";
  const areas = new Set<Area>();
  const specs = new Set<string>(importing);
  for (const path of changed) {
    // A spec that changed runs itself; the support files reach every spec.
    const spec = /^e2e\/([^/]+\.spec\.ts)$/.exec(path)?.[1];
    if (spec !== undefined) {
      // A spec that is gone takes its retention rows with it: the whole suite says which.
      if (!existing.includes(path)) return "all";
      specs.add(spec);
      continue;
    }
    const owned = areasOf(path);
    if (owned === "none") continue;
    // The change reaches its own areas and those of the code that uses it.
    const reached = [owned, ...users(path).map(areasOf)];
    if (reached.includes("all")) return "all";
    for (const owner of reached) {
      if (owner !== "all" && owner !== "none") for (const area of owner) areas.add(area);
    }
  }
  for (const [spec, exercised] of Object.entries(SPEC_AREAS)) {
    if (exercised.some((area) => areas.has(area))) specs.add(spec);
  }
  if (specs.size > 0) for (const spec of ALWAYS_SPECS) specs.add(spec);
  return [...specs].sort();
}
