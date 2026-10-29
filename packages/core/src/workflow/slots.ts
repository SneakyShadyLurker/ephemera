import { z } from "zod";
import { inputNameSchema, nodeIdSchema, WORKFLOW_LIMITS, type WorkflowGraph } from "./graph.ts";

/*
 * Where Ephemera's values go in a template. Finalization picks the targets;
 * `applySlots` writes the five whole-string placeholders the server's
 * `fillWorkflow` fills at each run, and nothing else may look like one.
 */

/** One node input Ephemera fills. */
export const slotTargetSchema = z.strictObject({ node: nodeIdSchema, input: inputNameSchema });
export type SlotTarget = z.infer<typeof slotTargetSchema>;

const targets = (max: number) => z.array(slotTargetSchema).min(1).max(max);

/** The finalized mapping: where each value goes, and the one output node. Produced by `finalizeWorkflow`, never sent by the tab. */
export const workflowSlotsSchema = z.strictObject({
  prompt: targets(WORKFLOW_LIMITS.targetsPerPlace),
  seed: targets(WORKFLOW_LIMITS.targetsPerPlace),
  width: targets(4),
  height: targets(4),
  count: targets(4),
  /** The one SaveImageWebsocket node. */
  output: nodeIdSchema,
});
export type WorkflowSlots = z.infer<typeof workflowSlotsSchema>;

/** What the tab chooses and sends back: node ids only. Absent fields mean the detected choice. */
export const workflowChoicesSchema = z.strictObject({
  output: nodeIdSchema.optional(),
  latent: nodeIdSchema.optional(),
  prompt: z.array(nodeIdSchema).min(1).max(WORKFLOW_LIMITS.targetsPerPlace).optional(),
});
export type WorkflowChoices = z.infer<typeof workflowChoicesSchema>;

/** The placeholders a slot fills, by slot. */
const PLACEHOLDER = {
  prompt: "{{prompt}}",
  seed: "{{seed}}",
  width: "{{width}}",
  height: "{{height}}",
  count: "{{count}}",
} as const;

/** Any placeholder text, whole or embedded, as `fillWorkflow` recognises it. */
const ANY_PLACEHOLDER = /\{\{\w*\}\}/;

export type ApplySlotsResult =
  | { ok: true; graph: WorkflowGraph }
  | { ok: false; refusal: { error: "embedded_placeholder"; nodes: string[] } };

/**
 * The template: a copy of `graph` with each target's input set to its
 * placeholder. Any other value holding placeholder text refuses, naming its
 * nodes, since `fillWorkflow` would refuse it at every run. A target the
 * graph lacks is a finalization bug and throws.
 */
export function applySlots(graph: WorkflowGraph, slots: WorkflowSlots): ApplySlotsResult {
  if (graph[slots.output] === undefined) throw new Error("slot output is not in the graph");
  const template = structuredClone(graph);
  const written = new Set<string>();
  for (const slot of ["prompt", "seed", "width", "height", "count"] as const) {
    for (const { node, input } of slots[slot]) {
      const inputs = template[node]?.inputs;
      if (inputs === undefined || !Object.hasOwn(inputs, input)) {
        throw new Error("slot target is not in the graph");
      }
      inputs[input] = PLACEHOLDER[slot];
      written.add(JSON.stringify([node, input]));
    }
  }
  const nodes = Object.entries(template).flatMap(([id, node]) =>
    Object.entries(node.inputs).some(
      ([input, value]) =>
        !written.has(JSON.stringify([id, input])) && ANY_PLACEHOLDER.test(JSON.stringify(value)),
    )
      ? [id]
      : [],
  );
  return nodes.length === 0
    ? { ok: true, graph: template }
    : { ok: false, refusal: { error: "embedded_placeholder", nodes } };
}
