import type { Normalized, ReportLine } from "./finalize.ts";
import type { WorkflowGraph } from "./graph.ts";
import { isLink, linksOf, OUTPUT_CLASSES, SAVER } from "./links.ts";
import type { NodeMetaMap } from "./meta.ts";
import { type NodeTitles, nodeLabel } from "./report.ts";

/** Whether a class is the sanctioned output, or one nothing may admit; the server's allowlist owns both. */
export type ClassPredicate = (classType: string) => boolean;

/**
 * The image outputs a graph can end in: nodes whose `images` input is linked
 * and whose class saves or previews an image (`SaveImage`, `PreviewImage`,
 * `SaveImageWebsocket`, or an output node by meta). Finalization turns the
 * chosen one into the template's `SaveImageWebsocket` and drops the others,
 * so they are never assessed as blocked.
 */
export function imageOutputs(graph: WorkflowGraph, meta: NodeMetaMap | undefined): string[] {
  return Object.entries(graph).flatMap(([id, node]) =>
    isLink(node.inputs.images) &&
    (OUTPUT_CLASSES.has(node.class_type) || meta?.get(node.class_type)?.outputNode === true)
      ? [id]
      : [],
  );
}

const isPreview = (classType: string) => classType.startsWith("Preview");

/**
 * The safe fixes of spec § 10.1, run before blocked nodes are assessed. One
 * linked sanctioned output is kept; without one, the one image saver (else
 * the one preview) becomes `SaveImageWebsocket` with only its `images`;
 * several stay for the output choice. Every other output node nothing
 * consumes is dropped, alone. `isOutputClass` names the sanctioned output
 * and `isRefused` the always-refused classes, which count as output nodes
 * without meta.
 */
export function normalizeWorkflow(
  source: WorkflowGraph,
  meta: NodeMetaMap | undefined,
  isOutputClass: ClassPredicate,
  isRefused: ClassPredicate,
  titles?: NodeTitles,
): Normalized {
  const graph = structuredClone(source);
  const changed: ReportLine[] = [];
  const skipped: ReportLine[] = [];
  const classOf = (id: string) => graph[id]?.class_type ?? "";

  const images = imageOutputs(graph, meta);
  const sanctioned = images.filter((id) => isOutputClass(classOf(id)));
  const savers = images.filter((id) => !isPreview(classOf(id)));
  const kept = new Set(sanctioned.length > 0 ? sanctioned : savers.length > 0 ? savers : images);
  if (kept.size === 1 && sanctioned.length === 0) {
    const [id] = kept;
    const node = id === undefined ? undefined : graph[id];
    if (id !== undefined && node !== undefined) {
      changed.push(
        `${nodeLabel(source, id, meta, titles)} now sends the picture to Ephemera instead of a file.`,
      );
      graph[id] = { class_type: SAVER, inputs: { images: node.inputs.images } };
    }
  }

  const consumed = new Set(
    Object.values(source).flatMap((node) => linksOf(node).map(([id]) => id)),
  );
  for (const [id, node] of Object.entries(source)) {
    const output =
      OUTPUT_CLASSES.has(node.class_type) ||
      isOutputClass(node.class_type) ||
      isRefused(node.class_type) ||
      meta?.get(node.class_type)?.outputNode === true;
    if (output && !kept.has(id) && !consumed.has(id)) {
      delete graph[id];
      skipped.push(`${nodeLabel(source, id, meta, titles)}, nothing depended on it.`);
    }
  }
  return { graph, changed, skipped };
}
