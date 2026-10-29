import { z } from "zod";
import { isRecord, type JsonValue } from "../card/json.ts";
import { artFamilySchema } from "./family.ts";

/*
 * A ComfyUI graph in API format: node id -> { class_type, inputs }. Server
 * files, imports and stored user workflows all take this shape; a graph from
 * a file or a request is untrusted, so every key, string and array is
 * bounded before anything reads it.
 */

export const WORKFLOW_LIMITS = {
  /** Per user. */
  workflows: 24,
  /** Bundled files and `EPHEMERA_WORKFLOWS_DIR` together. */
  serverWorkflows: 64,
  /** The most node classes or model files a missing status names. */
  missingNames: 64,
  /** The longest node class or model file name a missing status names. */
  missingNameLength: 256,
  nameLength: 64,
  /** The inspect request's display name, never stored or logged. */
  fileNameLength: 255,
  /** A serialized API template. */
  graphBytes: 256 * 1024,
  /** After flattening subgraphs. */
  nodes: 200,
  inputsPerNode: 64,
  /** Any one string input (a negative prompt, a note). */
  stringLength: 16 * 1024,
  /** Any one array input. */
  arrayLength: 64,
  /** The inspect request body (UI files carry layout and previews). */
  uploadBytes: 2 * 1024 * 1024,
  /** Before flattening. */
  uiNodes: 400,
  subgraphDepth: 4,
  jsonDepth: 16,
  /** Encoders sharing the prompt, samplers sharing the seed. */
  targetsPerPlace: 8,
} as const;

/** One node as a template holds it: inputs are literals or `[nodeId, slot]` links. */
export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export type WorkflowGraph = Record<string, WorkflowNode>;

/** Refused as keys anywhere (node ids, input names, nested objects) by this check, not by a pattern alone. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const safeKey = (pattern: RegExp) =>
  z
    .string()
    .regex(pattern)
    .refine((key) => !FORBIDDEN_KEYS.has(key), "reserved key");

/**
 * A record whose own keys are checked against FORBIDDEN_KEYS as given: Zod
 * drops an own `__proto__` key from a record silently, so the key schema
 * alone would accept an object carrying one.
 */
export const safeRecord = <K extends z.core.$ZodRecordKey, V extends z.ZodType>(key: K, value: V) =>
  z
    .unknown()
    .refine(
      (input) => !isRecord(input) || !Object.keys(input).some((name) => FORBIDDEN_KEYS.has(name)),
      "reserved key",
    )
    .pipe(z.record(key, value));

export const nodeIdSchema = safeKey(/^[A-Za-z0-9_:.-]{1,64}$/);
export const inputNameSchema = safeKey(/^[A-Za-z0-9_.:-]{1,64}$/);
export const classTypeSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

/** A key inside an object input: any short text without control characters. */
const nestedKeySchema = safeKey(/^[^\p{Cc}]{1,128}$/u);

/** One input value: a bounded JSON value, which a link `[nodeId, slot]` is too. */
export const inputValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(WORKFLOW_LIMITS.stringLength),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(inputValueSchema).max(WORKFLOW_LIMITS.arrayLength),
    safeRecord(nestedKeySchema, inputValueSchema),
  ]),
);

const apiNodeSchema = z.strictObject({
  class_type: classTypeSchema,
  inputs: safeRecord(inputNameSchema, inputValueSchema).refine(
    (inputs) => Object.keys(inputs).length <= WORKFLOW_LIMITS.inputsPerNode,
    "too many inputs",
  ),
});

/** An API-format graph as Ephemera holds it; `_meta` is dropped before it gets here. */
export const apiGraphSchema = safeRecord(nodeIdSchema, apiNodeSchema).refine((graph) => {
  const count = Object.keys(graph).length;
  return count >= 1 && count <= WORKFLOW_LIMITS.nodes;
}, "too many nodes");

/** A workflow's name on screen: trimmed, short, no control characters. */
export const workflowNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(WORKFLOW_LIMITS.nameLength)
  .regex(/^[^\p{Cc}]+$/u);

/** The reserved top-level `ephemera` key of a server file: its family and name, both optional. */
const ephemeraMetaSchema = z.strictObject({
  family: artFamilySchema.optional(),
  name: workflowNameSchema.optional(),
});
export type EphemeraMeta = z.infer<typeof ephemeraMetaSchema>;

/**
 * A source without its reserved `ephemera` key, and what the key declared.
 * A source without the key passes unchanged; an invalid declaration throws.
 */
export function stripEphemeraKey(source: unknown): { graph: unknown; meta: EphemeraMeta } {
  if (!isRecord(source) || !Object.hasOwn(source, "ephemera")) return { graph: source, meta: {} };
  const { ephemera, ...graph } = source;
  return { graph, meta: ephemeraMetaSchema.parse(ephemera) };
}

/**
 * Whether no object or array in `source` nests deeper than `limit` (the top
 * level counts as 1). It walks without recursion and stops at the first
 * value past the limit, so an over-deep body is refused before Zod sees it.
 */
export function walkDepth(source: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[source, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, parent] = next;
    if (typeof value !== "object" || value === null) continue;
    const depth = parent + 1;
    if (depth > limit) return false;
    for (const child of Object.values(value)) pending.push([child, depth]);
  }
  return true;
}
