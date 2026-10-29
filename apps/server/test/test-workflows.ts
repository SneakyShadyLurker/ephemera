import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiGraphSchema, userWorkflowId, type WorkflowFields } from "@ephemera/core";
import type { RunWorkflow } from "../src/comfyui/catalog.ts";
import {
  BUNDLED_WORKFLOWS_DIR,
  createWorkflowRegistry,
  type ServerWorkflows,
  type WorkflowId,
} from "../src/comfyui/workflow.ts";
import type { WorkflowStore } from "../src/persistence/store.ts";
import { readWorkflowFiles } from "../src/persistence/workflow-files.ts";

/** Synthetic graphs shaped like the public ones, with placeholder model files. */
export const FIXTURE_WORKFLOWS_DIR = new URL("./fixtures/workflows", import.meta.url).pathname;

/** The public graphs only, whatever else the bundled directory holds. */
export const publicWorkflowFiles = () =>
  readWorkflowFiles(BUNDLED_WORKFLOWS_DIR).filter(({ file }) =>
    file.startsWith("krea2-gonzalomo."),
  );

/**
 * The public graphs plus the synthetic fixtures (`krea2-fixture` with its
 * reference graph, `moss-fixture` without one): every test that needs a
 * second workflow or a MOSS one uses these, never another bundled graph.
 */
export function testWorkflows(defaultWorkflow?: WorkflowId): ServerWorkflows {
  return createWorkflowRegistry({
    files: [...publicWorkflowFiles(), ...readWorkflowFiles(FIXTURE_WORKFLOWS_DIR)],
    defaultWorkflow,
  });
}

export const TEST_WORKFLOWS = testWorkflows();

/**
 * The text of a `flux-general.json`: the MOSS fixture's graph, whose first
 * word names no family, with the reserved `ephemera` key when one is given.
 */
export function fluxGeneralSource(ephemera?: unknown): string {
  const graph: Record<string, unknown> = JSON.parse(
    readFileSync(join(FIXTURE_WORKFLOWS_DIR, "moss-fixture.json"), "utf8"),
  );
  return JSON.stringify(ephemera === undefined ? graph : { ephemera, ...graph });
}

/**
 * The default workflow's graph as a user's stored template, with the
 * sampler's steps changed so a run on it is told from one on the file.
 */
export function userGraph(steps = 5, extra: WorkflowFields["graph"] = {}): WorkflowFields["graph"] {
  const graph = apiGraphSchema.parse(
    structuredClone(TEST_WORKFLOWS.get(TEST_WORKFLOWS.defaultWorkflow).graph),
  );
  const sampler = graph["7"];
  if (sampler === undefined) throw new Error("the default graph has no sampler");
  sampler.inputs.steps = steps;
  return { ...graph, ...extra };
}

/** Stores a user workflow and answers the id it goes by (`user-<uuid>`). */
export function storeUserWorkflow(
  store: WorkflowStore,
  { name = "Mine", family = "krea2", graph = userGraph() }: Partial<WorkflowFields> = {},
): { id: string; uuid: string } {
  const uuid = crypto.randomUUID();
  if (store.create({ name, family, graph }, uuid) !== "created") {
    throw new Error("the user workflow was not created");
  }
  return { id: userWorkflowId(uuid), uuid };
}

/** A server workflow as a route resolves it for a run (catalog.ts). */
export function serverRun(id: WorkflowId = TEST_WORKFLOWS.defaultWorkflow): RunWorkflow {
  const reference = TEST_WORKFLOWS.referenceOf(id);
  return {
    id,
    ...TEST_WORKFLOWS.get(id),
    blocked: [],
    ...(reference === undefined ? {} : { reference }),
  };
}
