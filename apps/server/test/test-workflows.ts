import {
  BUNDLED_WORKFLOWS_DIR,
  createWorkflowRegistry,
  type WorkflowId,
  type WorkflowRegistry,
} from "../src/comfyui/workflow.ts";
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
export function testWorkflows(defaultWorkflow?: WorkflowId): WorkflowRegistry {
  return createWorkflowRegistry({
    files: [...publicWorkflowFiles(), ...readWorkflowFiles(FIXTURE_WORKFLOWS_DIR)],
    defaultWorkflow,
  });
}

export const TEST_WORKFLOWS = testWorkflows();
