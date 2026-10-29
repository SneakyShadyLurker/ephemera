import { z } from "zod";
import { creatorArtStatusSchema } from "../creator/schema.ts";
import { importReportSchema } from "../preset/sillytavern.ts";
import { revisionSchema, storedFields, withRevision } from "../revision.ts";
import { artFamilySchema } from "./family.ts";
import {
  detectionSchema,
  nodeTitleSchema,
  workflowRefusalCodeSchema,
  workflowRefusalSchema,
} from "./finalize.ts";
import {
  apiGraphSchema,
  classTypeSchema,
  nodeIdSchema,
  WORKFLOW_LIMITS,
  workflowNameSchema,
} from "./graph.ts";
import { workflowUuidSchema } from "./id.ts";
import { workflowChoicesSchema } from "./slots.ts";

/*
 * A user's workflows as stored and listed, and the bodies of the
 * `/api/workflows` routes. A graph from the tab is untrusted: every save
 * parses it here, then normalizes and finalizes it again on the server.
 */

export const workflowFieldsSchema = z.strictObject({
  name: workflowNameSchema,
  family: artFamilySchema,
  /** The API-format template with placeholders already applied (`finalizeWorkflow`). */
  graph: apiGraphSchema,
});
export type WorkflowFields = z.infer<typeof workflowFieldsSchema>;

export const storedWorkflowSchema = z.strictObject({
  ...workflowFieldsSchema.shape,
  id: workflowUuidSchema,
  ...storedFields,
});
export type StoredWorkflow = z.infer<typeof storedWorkflowSchema>;

/** The list row: never the graph. */
export const workflowSummarySchema = z.strictObject({
  id: workflowUuidSchema,
  name: workflowNameSchema,
  family: artFamilySchema,
  nodes: z.number().int().min(1).max(WORKFLOW_LIMITS.nodes),
  revision: revisionSchema,
  updatedAt: z.number().int(),
});
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

/** `POST /api/workflows/inspect`: a parsed file, its name for the panel only, and the workflow it would replace. */
export const workflowInspectSchema = z.strictObject({
  source: z.unknown(),
  /** Shown and used for the name suggestion; never stored or logged. */
  fileName: z
    .string()
    .min(1)
    .max(WORKFLOW_LIMITS.fileNameLength)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
  replacing: workflowUuidSchema.optional(),
});
export type WorkflowInspect = z.infer<typeof workflowInspectSchema>;

/** `POST /api/workflows`: the inspected graph (before placeholders) and the tab's choices. */
export const workflowCreateSchema = z.strictObject({
  id: workflowUuidSchema,
  name: workflowNameSchema,
  family: artFamilySchema,
  graph: apiGraphSchema,
  choices: workflowChoicesSchema,
});
export type WorkflowCreate = z.infer<typeof workflowCreateSchema>;

/** `PATCH /api/workflows/:id`: name and family only; the graph is never touched. */
export const workflowPatchSchema = withRevision(
  z.strictObject({ name: workflowNameSchema.optional(), family: artFamilySchema.optional() }),
);
export type WorkflowPatch = z.infer<typeof workflowPatchSchema>;

/** `PUT /api/workflows/:id/graph`: a newly inspected graph and its choices. */
export const workflowGraphReplaceSchema = z.strictObject({
  revision: revisionSchema,
  graph: apiGraphSchema,
  choices: workflowChoicesSchema,
});
export type WorkflowGraphReplace = z.infer<typeof workflowGraphReplaceSchema>;

/** One node as the import panel names it: display metadata, never part of the graph. */
export const workflowNodeInfoSchema = z.strictObject({
  id: nodeIdSchema,
  title: nodeTitleSchema,
  classType: classTypeSchema,
});

export const WORKFLOW_FORMATS = ["api", "ui"] as const;

/**
 * Why an import refuses a node class: it writes or reads ComfyUI's files,
 * it is not on the allowlist, it loads a reference image, or the live
 * ComfyUI reports it as an output node.
 */
export const BLOCKED_REASONS = [
  "refused_writes",
  "not_allowed",
  "reference_only",
  "output_node",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** A node class an import refuses, with why. */
export const blockedNodeSchema = z.strictObject({
  classType: classTypeSchema,
  reason: z.enum(BLOCKED_REASONS),
});
export type BlockedNode = z.infer<typeof blockedNodeSchema>;

/** `POST /api/workflows/inspect` (200): what the panel shows and the tab finalizes after each choice. */
export const inspectionSchema = z.strictObject({
  format: z.enum(WORKFLOW_FORMATS),
  /** Whether the live `/object_info` was read. */
  checked: z.boolean(),
  /** The normalized graph, before placeholders; the tab sends it back to save. */
  graph: apiGraphSchema,
  nodes: z.array(workflowNodeInfoSchema).max(WORKFLOW_LIMITS.nodes),
  detection: detectionSchema,
  report: importReportSchema.pick({ changed: true, skipped: true }),
  /** Node classes of the normalized graph an import refuses; any one makes the file unsavable. */
  blocked: z.array(blockedNodeSchema).max(WORKFLOW_LIMITS.nodes),
  live: creatorArtStatusSchema,
  nameSuggestion: z.string().max(WORKFLOW_LIMITS.nameLength),
});
export type Inspection = z.infer<typeof inspectionSchema>;

/** A create or graph replacement refused (409, 413, 422). */
export const workflowSaveErrorSchema = z.discriminatedUnion("error", [
  z.strictObject({
    error: z.literal("blocked_nodes"),
    nodes: z.array(classTypeSchema).min(1).max(WORKFLOW_LIMITS.nodes),
  }),
  z.strictObject({
    error: z.literal("invalid_workflow"),
    code: workflowRefusalCodeSchema,
    nodes: workflowRefusalSchema.shape.nodes,
  }),
  z.strictObject({ error: z.literal("name_taken") }),
  z.strictObject({ error: z.literal("full") }),
]);
export type WorkflowSaveError = z.infer<typeof workflowSaveErrorSchema>;
