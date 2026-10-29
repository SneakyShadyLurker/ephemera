import type { WorkflowGraph } from "./graph.ts";
import type { NodeMetaMap } from "./meta.ts";

/*
 * How the import report names a node: its title, then its id, as "Save
 * Image (node 9)". The graph holds no titles (`_meta` is dropped before it is
 * parsed), so a node's title comes from the file's own titles when the caller
 * has them, else the class's display name from `/object_info`, else the class.
 */

/** The file's own node titles by node id, as the inspection's display list carries them. */
export type NodeTitles = ReadonlyMap<string, string>;

/** A class's title on screen: its display name when meta has one, else the class. */
export const titleOf = (classType: string, meta: NodeMetaMap | undefined): string =>
  meta?.get(classType)?.displayName ?? classType;

/** A node's title on screen: the file's own, else its class's. */
export const nodeTitle = (
  graph: WorkflowGraph,
  id: string,
  meta: NodeMetaMap | undefined,
  titles?: NodeTitles,
): string => titles?.get(id) ?? titleOf(graph[id]?.class_type ?? id, meta);

/** "Title (node id)", as every report line names a node. */
export const nodeLabel = (
  graph: WorkflowGraph,
  id: string,
  meta: NodeMetaMap | undefined,
  titles?: NodeTitles,
): string => `${nodeTitle(graph, id, meta, titles)} (node ${id})`;
