import type { WorkflowNode } from "./graph.ts";

/*
 * Reading a graph's links: an input holding `[nodeId, slot]` takes another
 * node's output. Normalization, detection and finalization share these.
 */

/** The classes that save or preview an image without `/object_info` saying so. */
export const OUTPUT_CLASSES: ReadonlySet<string> = new Set([
  "SaveImage",
  "PreviewImage",
  "SaveImageWebsocket",
]);
/** The one output a template ends in. */
export const SAVER = "SaveImageWebsocket";

export type Link = [string, number];
export const isLink = (value: unknown): value is Link =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  Number.isInteger(value[1]);
export const linksOf = (node: WorkflowNode): Link[] => Object.values(node.inputs).filter(isLink);

/** Every node `roots` take output from, directly or through others, the roots included. */
export function upstreamOf(
  nodes: ReadonlyMap<string, WorkflowNode>,
  roots: Iterable<string>,
): Set<string> {
  const pending = [...roots].filter((id) => nodes.has(id));
  const seen = new Set(pending);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const [origin] of linksOf(nodes.get(id) ?? { class_type: "", inputs: {} })) {
      if (!seen.has(origin) && nodes.has(origin)) {
        seen.add(origin);
        pending.push(origin);
      }
    }
  }
  return seen;
}

/** Whether `target`'s output reaches `from` by following links upstream. */
export function reaches(
  nodes: ReadonlyMap<string, WorkflowNode>,
  from: string,
  target: string,
): boolean {
  return from === target || upstreamOf(nodes, [from]).has(target);
}
