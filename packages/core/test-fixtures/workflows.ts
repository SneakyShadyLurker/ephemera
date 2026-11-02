import { z } from "zod";
import { isRecord } from "../src/card/json.ts";
import { workflowRefusalCodeSchema } from "../src/workflow/finalize.ts";

/*
 * The ComfyUI workflow fixtures in `workflows/`, exported from a stock
 * ComfyUI (see its README). Core stays free of Node types, but its tests run
 * in a Node-compatible process, so the file system is reached through
 * `process.getBuiltinModule`.
 */

interface FileSystem {
  readdirSync(path: URL): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
}

const host = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;

function fileSystem(): FileSystem {
  const fs = host?.getBuiltinModule?.("node:fs");
  if (fs === undefined) throw new Error("These fixtures need a runtime with node:fs");
  return fs as FileSystem;
}

const FIXTURES_DIR = new URL("./workflows/", import.meta.url);

/** How a fixture file fares: converted and accepted, or refused with a code at a stage. */
const outcomeSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    stage: z.literal("convert"),
    code: workflowRefusalCodeSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    stage: z.literal("gate"),
    code: z.literal("reference_only"),
  }),
]);
export type WorkflowFixtureOutcome = z.infer<typeof outcomeSchema>;

/** Why a UI node has no API node. */
const omittedReasonSchema = z.enum([
  "bypassed",
  "muted",
  "reroute",
  "primitive",
  "subgraph_instance",
]);

const expectationSchema = z.strictObject({
  /** API node id -> UI execution id: the root node id, or `<instance>:<inner>` inside a subgraph. */
  apiToUi: z.record(z.string(), z.string()),
  /** UI execution id -> why the API export has no node for it. */
  omitted: z.record(z.string(), omittedReasonSchema),
  ui: outcomeSchema,
  api: outcomeSchema,
});
export type WorkflowExpectation = z.infer<typeof expectationSchema>;

export interface WorkflowFixture {
  name: string;
  /** The UI export (File > Export), parsed but unchecked. */
  ui: unknown;
  /** The API export (File > Export (API)), `_meta` included. */
  api: unknown;
  /** The `/object_info` entries of the classes the fixture uses. */
  objectInfo: unknown;
  expect: WorkflowExpectation;
}

function readJson(fs: FileSystem, file: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(file, FIXTURES_DIR), "utf8"));
}

/** Every fixture set, in name order; a missing or malformed file throws. */
export function loadWorkflowFixtures(): WorkflowFixture[] {
  const fs = fileSystem();
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".expect.json"))
    .map((file) => file.slice(0, -".expect.json".length))
    .sort()
    .map((name) => ({
      name,
      ui: readJson(fs, `${name}.ui.json`),
      api: readJson(fs, `${name}.api.json`),
      objectInfo: readJson(fs, `${name}.object_info.json`),
      expect: expectationSchema.parse(readJson(fs, `${name}.expect.json`)),
    }));
}

/** One fixture set by name; an unknown name throws. */
export function loadWorkflowFixture(name: string): WorkflowFixture {
  const fixture = loadWorkflowFixtures().find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`No workflow fixture named ${name}`);
  return fixture;
}

/** An API export without each node's `_meta`, the shape `apiGraphSchema` takes. */
export function withoutMeta(api: unknown): unknown {
  if (!isRecord(api)) return api;
  return Object.fromEntries(
    Object.entries(api).map(([id, node]) => {
      if (!isRecord(node)) return [id, node];
      const { _meta: _, ...rest } = node;
      return [id, rest];
    }),
  );
}
