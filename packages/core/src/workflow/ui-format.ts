import { z } from "zod";
import { WORKFLOW_LIMITS } from "./graph.ts";

/*
 * ComfyUI's saved (UI) workflow format, read leniently: only what conversion
 * uses is checked, unknown keys pass, and `extra` (layout, native reroutes)
 * is never read. A root file is version 0.4 with link tuples or version 1
 * with link objects; the frontend writes subgraph definitions in version 1
 * form inside a 0.4 root, so every links array takes either encoding.
 */

/** Sockets and widgets on one UI node, and values in one `widgets_values`. */
export const UI_SLOTS = 256;
/** Links in one graph or definition. */
export const UI_LINKS = WORKFLOW_LIMITS.uiNodes * WORKFLOW_LIMITS.inputsPerNode;

/** The ids a definition's links use for its input and output boundary. */
export const SUBGRAPH_INPUT = "-10";
export const SUBGRAPH_OUTPUT = "-20";

/** A node id as conversion composes it into `<instance>:<inner>`. */
const nodeIdSchema = z
  .union([z.number().int().min(0), z.string().regex(/^[A-Za-z0-9_.-]{1,16}$/)])
  .transform(String);
/** A link end: a node id, or a definition's boundary (`-10`, `-20`). */
const linkEndSchema = z
  .union([z.number().int(), z.string().regex(/^-?[A-Za-z0-9_.]{1,16}$/)])
  .transform(String);
const slotSchema = z.number().int().min(0).max(UI_SLOTS);
const linkIdSchema = z.number().int();

export interface UiLink {
  id: number;
  originId: string;
  originSlot: number;
  targetId: string;
  targetSlot: number;
}

const tupleLinkSchema = z
  .tuple([linkIdSchema, linkEndSchema, slotSchema, linkEndSchema, slotSchema])
  .rest(z.unknown())
  .transform(
    ([id, originId, originSlot, targetId, targetSlot]): UiLink => ({
      id,
      originId,
      originSlot,
      targetId,
      targetSlot,
    }),
  );
const objectLinkSchema = z
  .looseObject({
    id: linkIdSchema,
    origin_id: linkEndSchema,
    origin_slot: slotSchema,
    target_id: linkEndSchema,
    target_slot: slotSchema,
  })
  .transform(
    (link): UiLink => ({
      id: link.id,
      originId: link.origin_id,
      originSlot: link.origin_slot,
      targetId: link.target_id,
      targetSlot: link.target_slot,
    }),
  );
/** Either encoding; an empty entry an old file left in the array is skipped. */
const linksSchema = z
  .array(z.union([tupleLinkSchema, objectLinkSchema, z.null()]))
  .max(UI_LINKS)
  .transform((links) => links.filter((link): link is UiLink => link !== null));

/** A socket or widget type, kept when it is text. */
const slotTypeSchema = z.string().max(256).optional().catch(undefined);

const inputSchema = z.looseObject({
  name: z.string().max(256),
  type: slotTypeSchema,
  link: linkIdSchema.nullable().optional(),
  /** Present when the socket belongs to a widget. */
  widget: z
    .looseObject({ name: z.string().max(256) })
    .optional()
    .catch(undefined),
});
export type UiInput = z.infer<typeof inputSchema>;

const outputSchema = z.looseObject({ type: slotTypeSchema });

const valuesSchema = z.record(z.string(), z.unknown());

const nodeSchema = z.looseObject({
  id: nodeIdSchema,
  /** A class, a frontend-only node (`Reroute`, `Note`) or a subgraph definition's id. */
  type: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\p{Cc}]+$/u),
  title: z.string().max(1024).nullable().optional().catch(undefined),
  /** 0 always, 2 muted, 4 bypassed; 1 and 3 run as 0. */
  mode: z.number().int().optional().catch(undefined),
  inputs: z.array(inputSchema).max(UI_SLOTS).nullable().optional(),
  outputs: z.array(outputSchema).max(UI_SLOTS).nullable().optional(),
  widgets_values: z
    .union([z.array(z.unknown()).max(UI_SLOTS), valuesSchema])
    .nullable()
    .optional(),
  widgets_values_named: valuesSchema.nullable().optional().catch(undefined),
});
export type UiNode = z.infer<typeof nodeSchema>;

const boundarySchema = z.looseObject({ name: z.string().max(256) });

const definitionSchema = z.looseObject({
  id: z.string().min(1).max(64),
  inputs: z.array(boundarySchema).max(UI_SLOTS).optional(),
  outputs: z.array(boundarySchema).max(UI_SLOTS).optional(),
  nodes: z.array(nodeSchema).max(WORKFLOW_LIMITS.uiNodes),
  links: linksSchema.optional(),
});
export type UiDefinition = z.infer<typeof definitionSchema>;

/** A saved workflow; `extra`, groups and layout are not read. */
export const uiWorkflowSchema = z.looseObject({
  version: z.union([z.literal(0.4), z.literal(1)]),
  nodes: z.array(nodeSchema).max(WORKFLOW_LIMITS.uiNodes),
  links: linksSchema,
  definitions: z
    .looseObject({ subgraphs: z.array(definitionSchema).max(WORKFLOW_LIMITS.uiNodes).optional() })
    .nullable()
    .optional(),
});
export type UiWorkflow = z.infer<typeof uiWorkflowSchema>;
