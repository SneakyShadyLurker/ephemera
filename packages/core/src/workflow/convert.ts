import { isRecord } from "../card/json.ts";
import type { ReportLine, WorkflowRefusal, WorkflowRefusalCode } from "./finalize.ts";
import { apiGraphSchema, WORKFLOW_LIMITS, type WorkflowGraph, walkDepth } from "./graph.ts";
import type { GrowingInput, NodeMeta, NodeMetaMap } from "./meta.ts";
import {
  SUBGRAPH_INPUT,
  SUBGRAPH_OUTPUT,
  type UiDefinition,
  type UiInput,
  type UiLink,
  type UiNode,
  uiWorkflowSchema,
} from "./ui-format.ts";

/*
 * A saved (UI) ComfyUI workflow to the API graph its frontend would queue,
 * per spec § 9.3: bound the file, flatten subgraph instances into
 * `<instance>:<inner>` nodes, drop frontend-only, muted and bypassed nodes
 * (following links through them as the frontend does), name the widget
 * values from `/object_info`, resolve links and emit. Pure: the file and
 * the live `/object_info` meta in, a graph and its display list or a
 * refusal out. The frontend's rules are the specification, pinned by
 * fixtures exported from a stock ComfyUI; this is an own implementation.
 */

export type WorkflowFormat = "api" | "ui";

/** Which format a parsed file is in (§ 9.2), or undefined for neither. */
export function detectFormat(source: unknown): WorkflowFormat | undefined {
  if (!isRecord(source)) return undefined;
  if (
    Array.isArray(source.nodes) &&
    Array.isArray(source.links) &&
    (source.version === 0.4 || source.version === 1)
  ) {
    return "ui";
  }
  const nodes = Object.entries(source).filter(([key]) => key !== "ephemera");
  return nodes.length > 0 &&
    nodes.every(
      ([, node]) => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs),
    )
    ? "api"
    : undefined;
}

/** The refusals conversion gives. */
export const CONVERT_REFUSALS = [
  "not_a_workflow",
  "too_large",
  "too_many_nodes",
  "too_deep",
  "unknown_node",
  "dynamic_inputs",
  "widget_values_short",
  "subgraph_widgets",
  "muted_dependency",
  "bypass_dependency",
  "unconnected_input",
] as const satisfies readonly WorkflowRefusalCode[];
export type ConvertRefusalCode = (typeof CONVERT_REFUSALS)[number];

/** A node as the panel names it (§ 9.4); never inside the graph, never stored or logged. */
export interface DisplayNode {
  id: string;
  title: string;
  classType: string;
}

export interface Converted {
  ok: true;
  graph: WorkflowGraph;
  nodes: DisplayNode[];
  /** Values the file holds that no input takes, for the report's Left out. */
  skipped: ReportLine[];
}

export type ConvertResult = Converted | { ok: false; refusal: WorkflowRefusal };

/** Frontend-only nodes: links pass through a Reroute, a PrimitiveNode's value is copied. */
const REROUTE = "Reroute";
const PRIMITIVE = "PrimitiveNode";
const NOTES: ReadonlySet<string> = new Set(["Note", "MarkdownNote"]);
const MUTED = 2;
const BYPASSED = 4;
const TITLE_LENGTH = 256;
const LISTED = 256;

class Refused extends Error {
  readonly code: ConvertRefusalCode;
  readonly nodes: string[] | undefined;
  constructor(code: ConvertRefusalCode, nodes?: string[]) {
    super(code);
    this.code = code;
    this.nodes = nodes;
  }
}

const refusal = (code: ConvertRefusalCode, nodes?: string[]): ConvertResult => ({
  ok: false,
  refusal:
    nodes === undefined || nodes.length === 0
      ? { error: code }
      : { error: code, nodes: [...new Set(nodes)].slice(0, WORKFLOW_LIMITS.uiNodes) },
});

/** Where an input's value comes from once links are followed. */
type Source =
  | { kind: "link"; node: string; slot: number }
  | { kind: "value"; value: unknown }
  | { kind: "missing"; why: "muted" | "bypassed" | "none" };

const NONE: Source = { kind: "missing", why: "none" };

interface Host {
  scope: Scope;
  node: UiNode;
  definition: UiDefinition;
  /** Promoted widget values by definition input index. */
  promoted: Map<number, unknown>;
}

/** One graph level: the root, or a subgraph instance's copy of its definition. */
interface Scope {
  /** `""` at the root, `<instance>:` (nested: `<outer>:<inner>:`) inside. */
  prefix: string;
  nodes: Map<string, UiNode>;
  links: Map<number, UiLink>;
  /** Expanded instances by local id. */
  children: Map<string, Scope>;
  host?: Host;
}

interface FlatNode {
  id: string;
  node: UiNode;
  scope: Scope;
}

const modeOf = (node: UiNode) => node.mode ?? 0;
const inactive = (node: UiNode) => modeOf(node) === MUTED || modeOf(node) === BYPASSED;
const inputsOf = (node: UiNode): UiInput[] => node.inputs ?? [];

/** Whether any object in the file holds more nodes than a saved workflow may, counted before parsing. */
function countsNodes(source: Record<string, unknown>): number {
  const definitions = isRecord(source.definitions) ? source.definitions.subgraphs : undefined;
  const inner = Array.isArray(definitions)
    ? definitions.reduce<number>(
        (sum, definition) =>
          sum +
          (isRecord(definition) && Array.isArray(definition.nodes) ? definition.nodes.length : 0),
        0,
      )
    : 0;
  return (Array.isArray(source.nodes) ? source.nodes.length : 0) + inner;
}

/**
 * How deep instances nest, a definition counting 1 plus its deepest
 * instance; a definition that instances itself is infinitely deep.
 */
function nestingDepth(roots: UiNode[], definitions: Map<string, UiDefinition>): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return Number.POSITIVE_INFINITY;
    visiting.add(id);
    let deepest = 0;
    for (const node of definitions.get(id)?.nodes ?? []) {
      if (definitions.has(node.type)) deepest = Math.max(deepest, depthOf(node.type));
      if (deepest > WORKFLOW_LIMITS.subgraphDepth) break;
    }
    visiting.delete(id);
    memo.set(id, 1 + deepest);
    return 1 + deepest;
  };
  return roots.reduce(
    (deepest, node) =>
      definitions.has(node.type) ? Math.max(deepest, depthOf(node.type)) : deepest,
    0,
  );
}

/** A node's values by input name, when it saved them that way. */
const namedValues = (node: UiNode): Record<string, unknown> | undefined =>
  node.widgets_values_named ?? (isRecord(node.widgets_values) ? node.widgets_values : undefined);

const positionalValues = (node: UiNode): unknown[] | undefined =>
  Array.isArray(node.widgets_values) ? node.widgets_values : undefined;

/**
 * The definition inputs that feed an inner widget, in definition order, and
 * the instance's value for each: by name, else by position among them, else
 * none (the inner node keeps its own). A positional list of another length
 * cannot be lined up.
 */
function promotedValues(
  definition: UiDefinition,
  host: UiNode,
  hostId: string,
): Map<number, unknown> {
  const inner = new Map(definition.nodes.map((node) => [String(node.id), node]));
  const bound = (definition.inputs ?? []).flatMap((_, index) =>
    (definition.links ?? []).some(
      (link) =>
        link.originId === SUBGRAPH_INPUT &&
        link.originSlot === index &&
        inputsOf(inner.get(link.targetId) ?? { id: "", type: "-" })[link.targetSlot]?.widget !==
          undefined,
    )
      ? [index]
      : [],
  );
  const values = new Map<number, unknown>();
  const named = namedValues(host);
  if (named !== undefined) {
    for (const index of bound) {
      const name = definition.inputs?.[index]?.name ?? "";
      if (Object.hasOwn(named, name)) values.set(index, named[name]);
    }
    return values;
  }
  const positional = positionalValues(host) ?? [];
  if (positional.length === 0) return values;
  if (positional.length !== bound.length) throw new Refused("subgraph_widgets", [hostId]);
  bound.forEach((index, position) => {
    values.set(index, positional[position]);
  });
  return values;
}

/** Counts what flattening materializes; tests read it, the public API never does. */
export type MaterializeProbe = (id: string) => void;

/**
 * Every node of the file at its execution id, instances expanded. Each node
 * visited counts against `uiNodes` and each materialized class node against
 * `nodes`, both before the node is added, so instancing cannot multiply the
 * work past the bounds.
 */
function flatten(
  root: UiNode[],
  links: UiLink[],
  definitions: Map<string, UiDefinition>,
  probe: MaterializeProbe,
): FlatNode[] {
  const flat: FlatNode[] = [];
  let visited = 0;
  let materialized = 0;
  const expand = (nodes: UiNode[], scopeLinks: UiLink[], prefix: string, host?: Host): Scope => {
    const scope: Scope = {
      prefix,
      nodes: new Map(),
      links: new Map(scopeLinks.map((link) => [link.id, link])),
      children: new Map(),
      ...(host === undefined ? {} : { host }),
    };
    for (const node of nodes) {
      const id = String(node.id);
      if (scope.nodes.has(id)) throw new Refused("not_a_workflow");
      scope.nodes.set(id, node);
      if (NOTES.has(node.type)) continue;
      if (++visited > WORKFLOW_LIMITS.uiNodes) throw new Refused("too_many_nodes");
      const definition = definitions.get(node.type);
      if (definition !== undefined && !inactive(node)) {
        const promoted = promotedValues(definition, node, `${prefix}${id}`);
        scope.children.set(
          id,
          expand(definition.nodes, definition.links ?? [], `${prefix}${id}:`, {
            scope,
            node,
            definition,
            promoted,
          }),
        );
        continue;
      }
      const virtual = node.type === REROUTE || node.type === PRIMITIVE || definition !== undefined;
      if (!virtual && !inactive(node) && ++materialized > WORKFLOW_LIMITS.nodes) {
        throw new Refused("too_many_nodes");
      }
      probe(`${prefix}${id}`);
      flat.push({ id: `${prefix}${id}`, node, scope });
    }
    return scope;
  };
  expand(root, links, "");
  return flat;
}

/**
 * Follows a link to the output that feeds it: across subgraph boundaries,
 * through Reroutes and bypassed nodes, to a PrimitiveNode's value, or to
 * nothing (a muted origin, a dangling link). A loop resolves to nothing.
 */
function resolver(byId: Map<string, FlatNode>) {
  const resolve = (scope: Scope, linkId: number, seen: Set<string>): Source => {
    const key = `${scope.prefix}|${linkId}`;
    if (seen.has(key)) return NONE;
    seen.add(key);
    const link = scope.links.get(linkId);
    if (link === undefined) return NONE;

    if (link.originId === SUBGRAPH_INPUT) {
      const host = scope.host;
      if (host === undefined) return NONE;
      const name = host.definition.inputs?.[link.originSlot]?.name;
      const outer = inputsOf(host.node).find((input) => input.name === name);
      if (outer?.link !== undefined && outer.link !== null) {
        return resolve(host.scope, outer.link, seen);
      }
      return host.promoted.has(link.originSlot)
        ? { kind: "value", value: host.promoted.get(link.originSlot) }
        : NONE;
    }

    const child = scope.children.get(link.originId);
    if (child !== undefined) {
      const inner = [...child.links.values()].find(
        (candidate) =>
          candidate.targetId === SUBGRAPH_OUTPUT && candidate.targetSlot === link.originSlot,
      );
      return inner === undefined ? NONE : resolve(child, inner.id, seen);
    }

    const origin = byId.get(`${scope.prefix}${link.originId}`);
    if (origin === undefined) return NONE;
    const { node } = origin;
    const follow = (input: UiInput | undefined): Source =>
      input?.link === undefined || input.link === null ? NONE : resolve(scope, input.link, seen);

    if (modeOf(node) === MUTED) return { kind: "missing", why: "muted" };
    if (modeOf(node) === BYPASSED) {
      const type = node.outputs?.[link.originSlot]?.type;
      const through = follow(inputsOf(node).find((input) => input.type === type));
      return through.kind === "missing" && through.why === "none"
        ? { kind: "missing", why: "bypassed" }
        : through;
    }
    if (node.type === REROUTE) return follow(inputsOf(node)[0]);
    if (node.type === PRIMITIVE) {
      const values = positionalValues(node);
      return values !== undefined && values.length > 0 ? { kind: "value", value: values[0] } : NONE;
    }
    return { kind: "link", node: origin.id, slot: link.originSlot };
  };
  return (scope: Scope, input: UiInput | undefined): Source | undefined =>
    input?.link === undefined || input.link === null
      ? undefined
      : resolve(scope, input.link, new Set());
}

/** Whether a socket name is one of a growing input's slots, `<input>.<slot>`. */
function growingSlot(name: string, meta: NodeMeta): [string, GrowingInput] | undefined {
  for (const [input, growing] of Object.entries(meta.growing ?? {})) {
    if (name.startsWith(`${input}.`)) return [input, growing];
  }
  return undefined;
}

const slotFits = (slot: string, growing: GrowingInput): boolean =>
  growing.kind === "sockets" &&
  /^[A-Za-z0-9_-]{1,32}$/.test(slot) &&
  ((growing.names?.includes(slot) ?? false) ||
    (growing.prefix !== undefined &&
      slot.startsWith(growing.prefix) &&
      /^\d+$/.test(slot.slice(growing.prefix.length))));

/** A node's widget values by input name, or the count missing; surplus counts unused values. */
function widgetValues(
  node: UiNode,
  meta: NodeMeta,
): { values: Map<string, unknown>; missing: boolean; surplus: number } {
  const widgets = Object.entries(meta.inputs).filter(([, input]) => input.kind !== "LINK");
  const values = new Map<string, unknown>();
  const named = namedValues(node);
  if (named !== undefined) {
    for (const [name] of widgets) {
      if (Object.hasOwn(named, name)) values.set(name, named[name]);
    }
    return { values, missing: false, surplus: 0 };
  }
  const positional = positionalValues(node) ?? [];
  let next = 0;
  for (const [name, input] of widgets) {
    if (next >= positional.length) return { values, missing: true, surplus: 0 };
    values.set(name, positional[next++]);
    if (input.controlAfterGenerate === true && next < positional.length) next++;
  }
  return {
    values,
    missing: false,
    surplus: Math.max(0, positional.length - next - (meta.uiOnlyWidgets ?? 0)),
  };
}

const MISSING_CODE = {
  muted: "muted_dependency",
  bypassed: "bypass_dependency",
  none: "unconnected_input",
} as const;

const titleOf = (node: UiNode, meta: NodeMeta | undefined): string =>
  (typeof node.title === "string" && node.title.trim() !== ""
    ? node.title
    : (meta?.displayName ?? node.type)
  ).slice(0, TITLE_LENGTH);

/** `convertWorkflow` reporting each node it materializes to `probe`. */
export function convertCounting(
  source: unknown,
  meta: NodeMetaMap,
  probe: MaterializeProbe,
): ConvertResult {
  if (detectFormat(source) !== "ui" || !isRecord(source)) return refusal("not_a_workflow");
  if (!walkDepth(source, WORKFLOW_LIMITS.jsonDepth)) return refusal("too_deep");
  if (countsNodes(source) > WORKFLOW_LIMITS.uiNodes) return refusal("too_many_nodes");
  const parsed = uiWorkflowSchema.safeParse(source);
  if (!parsed.success) return refusal("not_a_workflow");
  const file = parsed.data;
  const definitions = new Map(
    (file.definitions?.subgraphs ?? []).map((definition) => [definition.id, definition]),
  );
  if (nestingDepth(file.nodes, definitions) > WORKFLOW_LIMITS.subgraphDepth) {
    return refusal("too_deep");
  }

  try {
    const flat = flatten(file.nodes, file.links, definitions, probe);
    const byId = new Map(flat.map((entry) => [entry.id, entry]));
    const sourceOf = resolver(byId);
    const emitted = flat.filter(
      ({ node }) =>
        !inactive(node) &&
        node.type !== REROUTE &&
        node.type !== PRIMITIVE &&
        !definitions.has(node.type),
    );

    const unknown = emitted.filter(({ node }) => !meta.has(node.type)).map(({ node }) => node.type);
    if (unknown.length > 0) throw new Refused("unknown_node", unknown);
    const metaOf = (node: UiNode): NodeMeta => meta.get(node.type) as NodeMeta;

    const unreadable = emitted
      .filter(({ node }) => {
        const nodeMeta = metaOf(node);
        return (
          Object.values(nodeMeta.growing ?? {}).some((growing) => growing.kind === "unreadable") ||
          inputsOf(node).some((input) => {
            const slot = growingSlot(input.name, nodeMeta);
            return slot !== undefined && !slotFits(input.name.slice(slot[0].length + 1), slot[1]);
          })
        );
      })
      .map(({ node }) => node.type);
    if (unreadable.length > 0) throw new Refused("dynamic_inputs", unreadable);

    const graph: WorkflowGraph = {};
    const nodes: DisplayNode[] = [];
    const skipped: ReportLine[] = [];
    const short: string[] = [];
    const missing = new Map<ConvertRefusalCode, string[]>();
    const lack = (why: keyof typeof MISSING_CODE, id: string) => {
      const code = MISSING_CODE[why];
      missing.set(code, [...(missing.get(code) ?? []), id]);
    };

    for (const { id, node, scope } of emitted) {
      const nodeMeta = metaOf(node);
      const required = new Set(nodeMeta.required ?? []);
      const byName = new Map(inputsOf(node).map((input) => [input.name, input]));
      const widgets = widgetValues(node, nodeMeta);
      if (widgets.missing) short.push(id);
      const inputs: Record<string, unknown> = {};

      for (const [name, input] of Object.entries(nodeMeta.inputs)) {
        if (Object.hasOwn(nodeMeta.growing ?? {}, name)) continue;
        const from = sourceOf(scope, byName.get(name));
        if (from?.kind === "link") inputs[name] = [from.node, from.slot];
        else if (from?.kind === "value") inputs[name] = from.value;
        else if (input.kind !== "LINK" && widgets.values.has(name)) {
          inputs[name] = widgets.values.get(name);
        } else if (input.kind !== "LINK") {
          if (required.has(name) && !widgets.missing) short.push(id);
        } else if (required.has(name)) {
          lack(from?.why ?? "none", id);
        }
      }

      for (const [name, growing] of Object.entries(nodeMeta.growing ?? {})) {
        if (growing.kind !== "sockets") continue;
        let linked = 0;
        let why: keyof typeof MISSING_CODE = "none";
        for (const input of inputsOf(node)) {
          if (!input.name.startsWith(`${name}.`)) continue;
          const from = sourceOf(scope, input);
          if (from?.kind === "link") {
            inputs[input.name] = [from.node, from.slot];
            linked++;
          } else if (from?.kind === "missing" && from.why !== "none") {
            why = from.why;
          }
        }
        if (required.has(name) && linked < growing.min) lack(why, id);
      }

      graph[id] = { class_type: node.type, inputs };
      nodes.push({ id, title: titleOf(node, nodeMeta), classType: node.type });
      if (widgets.surplus > 0) {
        const count = widgets.surplus;
        skipped.push(
          `${titleOf(node, nodeMeta)} (node ${id}), ${count} ${count === 1 ? "value" : "values"} the node does not use.`,
        );
      }
    }

    if (short.length > 0) throw new Refused("widget_values_short", short);
    for (const code of ["muted_dependency", "bypass_dependency", "unconnected_input"] as const) {
      const ids = missing.get(code);
      if (ids !== undefined) throw new Refused(code, ids.slice(0, LISTED));
    }
    if (Object.keys(graph).length === 0) throw new Refused("not_a_workflow");
    const bounded = apiGraphSchema.safeParse(graph);
    if (!bounded.success) throw new Refused("too_large");
    return { ok: true, graph: bounded.data, nodes, skipped };
  } catch (error) {
    if (error instanceof Refused) return refusal(error.code, error.nodes?.slice(0, LISTED));
    throw error;
  }
}

/** A saved workflow converted to an API graph and its display list, or why it cannot be. */
export const convertWorkflow = (source: unknown, meta: NodeMetaMap): ConvertResult =>
  convertCounting(source, meta, () => {});
