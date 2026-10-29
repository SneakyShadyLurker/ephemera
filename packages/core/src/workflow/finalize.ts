import { z } from "zod";
import { CREATOR_ART } from "../creator/limits.ts";
import type { ImportReport } from "../preset/sillytavern.ts";
import { artFamilySchema } from "./family.ts";
import {
  classTypeSchema,
  inputNameSchema,
  nodeIdSchema,
  WORKFLOW_LIMITS,
  type WorkflowGraph,
  type WorkflowNode,
} from "./graph.ts";
import type { NodeMetaMap } from "./meta.ts";
import {
  applySlots,
  type SlotTarget,
  slotTargetSchema,
  type WorkflowChoices,
  type WorkflowSlots,
} from "./slots.ts";

/*
 * From an imported graph to a template: normalization applies the safe
 * fixes, detection finds where Ephemera's values can go, and finalization
 * applies the user's choices to both and writes the placeholders. All of it
 * is pure, so the tab runs finalization after each choice and the server
 * runs it again on save, the only path to a stored template.
 */

/** One line of an import's report, in words, as every import reports. */
export type ReportLine = ImportReport["changed"][number];

/** Why a file cannot become a workflow; content-free, the web app explains each one. */
export const WORKFLOW_REFUSALS = [
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
  "no_output",
  "no_prompt_slot",
  "no_size_slot",
  "no_seed_slot",
  "too_many_targets",
  "not_a_candidate",
  "embedded_placeholder",
] as const;
export const workflowRefusalCodeSchema = z.enum(WORKFLOW_REFUSALS);
export type WorkflowRefusalCode = z.infer<typeof workflowRefusalCodeSchema>;

/** A refusal (422) and the node ids or classes it names, shown as text. */
export const workflowRefusalSchema = z.strictObject({
  error: workflowRefusalCodeSchema,
  nodes: z
    .array(
      z
        .string()
        .min(1)
        .max(256)
        .regex(/^[^\p{Cc}]+$/u),
    )
    .max(WORKFLOW_LIMITS.uiNodes)
    .optional(),
});
export type WorkflowRefusal = z.infer<typeof workflowRefusalSchema>;

/** A node's title on screen: from the file, the class's display name or the class. */
export const nodeTitleSchema = z.string().max(256);

/** A node the user can choose for a place, as the panel lists it. */
export const candidateSchema = z.strictObject({
  node: nodeIdSchema,
  title: nodeTitleSchema,
  classType: classTypeSchema,
  inputs: z.array(inputNameSchema).max(WORKFLOW_LIMITS.inputsPerNode),
  /** The first 80 characters of a prompt candidate's text. */
  preview: z.string().max(80).optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** A place a value goes: the detected choice, or null when the user has to pick, and every candidate. */
export interface Place<T> {
  chosen: T | null;
  candidates: Candidate[];
}

const placeSchema = <T extends z.ZodType>(chosen: T) =>
  z.strictObject({
    chosen: chosen.nullable(),
    candidates: z.array(candidateSchema).max(WORKFLOW_LIMITS.nodes),
  });

const targetsSchema = z.array(slotTargetSchema).max(WORKFLOW_LIMITS.targetsPerPlace);

export const detectionSchema = z.strictObject({
  /** Every text input of the chosen encoders. */
  prompt: placeSchema(targetsSchema.min(1)),
  /** The empty-latent node whose width, height and batch_size are filled. */
  latent: placeSchema(nodeIdSchema),
  /** Always every matching input; never a choice. */
  seed: targetsSchema,
  /** The one SaveImageWebsocket node. */
  output: placeSchema(nodeIdSchema),
  familyGuess: artFamilySchema,
});
export type Detection = z.infer<typeof detectionSchema>;

export interface Normalized {
  /** After the safe fixes, before placeholders. */
  graph: WorkflowGraph;
  /** The fixes applied. */
  changed: ReportLine[];
  /** The nodes dropped. */
  skipped: ReportLine[];
}

export type DetectResult =
  | { ok: true; detection: Detection }
  | { ok: false; refusal: WorkflowRefusal };

export type FinalizeResult =
  | {
      ok: true;
      template: WorkflowGraph;
      slots: WorkflowSlots;
      changed: ReportLine[];
      skipped: ReportLine[];
    }
  | { ok: false; refusal: WorkflowRefusal };

/** The safe fixes of spec § 10.1, run before blocked nodes are assessed. */
export function normalizeWorkflow(
  _graph: WorkflowGraph,
  _meta: NodeMetaMap | undefined,
  _allowlist: ReadonlySet<string>,
): Normalized {
  throw new Error("normalizeWorkflow is not implemented");
}

/** The places of spec § 10.2 to 10.5 and the family guess. */
export function detectSlots(_normalized: Normalized, _meta: NodeMetaMap | undefined): DetectResult {
  throw new Error("detectSlots is not implemented");
}

/** The classes that save or preview an image without `/object_info` saying so. */
const OUTPUT_CLASSES: ReadonlySet<string> = new Set([
  "SaveImage",
  "PreviewImage",
  "SaveImageWebsocket",
]);
const SAVER = "SaveImageWebsocket";
const SIZE_INPUTS = ["width", "height", "batch_size"] as const;

type Link = [string, number];
const isLink = (value: unknown): value is Link =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  Number.isInteger(value[1]);
const linksOf = (node: WorkflowNode): Link[] => Object.values(node.inputs).filter(isLink);

const refuse = (error: WorkflowRefusalCode, nodes?: string[]): FinalizeResult => ({
  ok: false,
  refusal: nodes === undefined ? { error } : { error, nodes },
});

const candidateIn = <T>(place: Place<T>, node: string): Candidate | undefined =>
  place.candidates.find((candidate) => candidate.node === node);

/** Whether `target`'s output reaches `from` by following links upstream. */
function reaches(nodes: ReadonlyMap<string, WorkflowNode>, from: string, target: string): boolean {
  const seen = new Set<string>([from]);
  const pending = [from];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === target) return true;
    for (const [origin] of linksOf(nodes.get(id) ?? { class_type: "", inputs: {} })) {
      if (!seen.has(origin) && nodes.has(origin)) {
        seen.add(origin);
        pending.push(origin);
      }
    }
  }
  return false;
}

/**
 * The first decimal id the graph does not use. It counts up from 1 rather
 * than past the largest id, so a huge id never breaks the arithmetic, and it
 * ends within the node count plus one steps.
 */
function freeId(nodes: ReadonlyMap<string, WorkflowNode>): string {
  let next = 1;
  while (nodes.has(String(next))) next++;
  return String(next);
}

/** An ImageScale value that already gives the latent's size: the latent's value or the placeholder. */
const fits = (value: unknown, latent: unknown, placeholder: string): boolean =>
  value === placeholder || JSON.stringify(value) === JSON.stringify(latent);

/**
 * The template (spec § 10.6): the chosen output, every other output dropped
 * with the nodes only they consumed; the chosen latent, reached from the
 * output, and an ImageScale before the save unless one already gives the
 * latent's size; the chosen encoders' text inputs; every seed; then the
 * placeholders. Choices name candidates only. Report lines follow
 * normalization's.
 */
export function finalizeWorkflow(
  normalized: Normalized,
  detection: Detection,
  choices: WorkflowChoices,
  meta?: NodeMetaMap,
): FinalizeResult {
  const source = normalized.graph;
  const nodes = new Map(Object.entries(structuredClone(source)));
  const changed = [...normalized.changed];
  const skipped = [...normalized.skipped];
  const candidates = [
    ...detection.prompt.candidates,
    ...detection.latent.candidates,
    ...detection.output.candidates,
  ];
  const named = (id: string): string => {
    const classType = source[id]?.class_type ?? id;
    const title =
      candidates.find((candidate) => candidate.node === id)?.title ??
      meta?.get(classType)?.displayName ??
      classType;
    return `${title} (node ${id})`;
  };

  // 1. The output, and every other output with what only it consumed.
  if (choices.output !== undefined && candidateIn(detection.output, choices.output) === undefined) {
    return refuse("not_a_candidate", [choices.output]);
  }
  const outputId = choices.output ?? detection.output.chosen;
  const chosenOutput = outputId === null ? undefined : nodes.get(outputId);
  if (outputId === null || chosenOutput === undefined || !isLink(chosenOutput.inputs.images)) {
    return refuse("no_output");
  }
  for (const [id, node] of nodes) {
    const output =
      candidateIn(detection.output, id) !== undefined ||
      OUTPUT_CLASSES.has(node.class_type) ||
      meta?.get(node.class_type)?.outputNode === true;
    if (id !== outputId && output) {
      nodes.delete(id);
      skipped.push(`${named(id)}, not the chosen output.`);
    }
  }
  const consumed = new Set(
    Object.values(source).flatMap((node) => linksOf(node).map(([id]) => id)),
  );
  for (let dropped = true; dropped; ) {
    dropped = false;
    const used = new Set([...nodes.values()].flatMap((node) => linksOf(node).map(([id]) => id)));
    for (const id of nodes.keys()) {
      if (id !== outputId && consumed.has(id) && !used.has(id)) {
        nodes.delete(id);
        skipped.push(`${named(id)}, only a left-out output used it.`);
        dropped = true;
      }
    }
  }
  if (chosenOutput.class_type !== SAVER) {
    nodes.set(outputId, { class_type: SAVER, inputs: { images: chosenOutput.inputs.images } });
    changed.push(`${named(outputId)} now sends the picture to Ephemera instead of a file.`);
  }

  // 2. The latent, reached from the output, and the exact final size.
  if (choices.latent !== undefined && candidateIn(detection.latent, choices.latent) === undefined) {
    return refuse("not_a_candidate", [choices.latent]);
  }
  const latentId = choices.latent ?? detection.latent.chosen;
  const latent = latentId === null ? undefined : nodes.get(latentId);
  if (
    latentId === null ||
    latent === undefined ||
    !SIZE_INPUTS.every((input) => Object.hasOwn(latent.inputs, input)) ||
    !reaches(nodes, outputId, latentId)
  ) {
    return refuse("no_size_slot");
  }
  const width: SlotTarget[] = [{ node: latentId, input: "width" }];
  const height: SlotTarget[] = [{ node: latentId, input: "height" }];
  const save = nodes.get(outputId);
  const images = save?.inputs.images;
  if (save === undefined || !isLink(images)) return refuse("no_output");
  const [feederId] = images;
  const feeder = nodes.get(feederId);
  if (
    feeder?.class_type === "ImageScale" &&
    fits(feeder.inputs.width, latent.inputs.width, "{{width}}") &&
    fits(feeder.inputs.height, latent.inputs.height, "{{height}}")
  ) {
    width.push({ node: feederId, input: "width" });
    height.push({ node: feederId, input: "height" });
  } else {
    const scaleId = freeId(nodes);
    nodes.set(scaleId, {
      class_type: "ImageScale",
      inputs: {
        image: images,
        upscale_method: "lanczos",
        width: "{{width}}",
        height: "{{height}}",
        crop: "disabled",
      },
    });
    save.inputs.images = [scaleId, 0];
    width.push({ node: scaleId, input: "width" });
    height.push({ node: scaleId, input: "height" });
    changed.push(
      `Resized to the requested size before saving, so the picture arrives at ${CREATOR_ART.width} x ${CREATOR_ART.height}.`,
    );
  }

  // 3. The prompt: every text input of the chosen encoders.
  const present = ({ node, input }: SlotTarget): boolean =>
    Object.hasOwn(nodes.get(node)?.inputs ?? {}, input);
  let prompt: SlotTarget[];
  if (choices.prompt === undefined) {
    prompt = (detection.prompt.chosen ?? []).filter(present);
  } else {
    const encoders = [...new Set(choices.prompt)];
    const refused = encoders.filter(
      (id) => candidateIn(detection.prompt, id) === undefined || !nodes.has(id),
    );
    if (refused.length > 0) return refuse("not_a_candidate", refused);
    prompt = encoders
      .flatMap((node) =>
        (candidateIn(detection.prompt, node)?.inputs ?? []).map((input) => ({ node, input })),
      )
      .filter(present);
  }
  if (prompt.length === 0) return refuse("no_prompt_slot");
  if (prompt.length > WORKFLOW_LIMITS.targetsPerPlace) return refuse("too_many_targets");
  for (const node of new Set(prompt.map((target) => target.node))) {
    const length = prompt
      .filter((target) => target.node === node)
      .reduce((sum, { input }) => {
        const text = nodes.get(node)?.inputs[input];
        return sum + (typeof text === "string" ? Array.from(text).length : 0);
      }, 0);
    changed.push(
      length === 0
        ? `The empty prompt of ${named(node)} now takes the card's image prompt.`
        : `The written prompt of ${named(node)}, ${length} ${length === 1 ? "character" : "characters"}, is replaced by the card's image prompt.`,
    );
  }

  // 4. Every seed the graph still has.
  const seed = detection.seed.filter(present);
  if (seed.length === 0) return refuse("no_seed_slot");
  if (seed.length > WORKFLOW_LIMITS.targetsPerPlace) return refuse("too_many_targets");

  // 5. The placeholders.
  const slots: WorkflowSlots = {
    prompt,
    seed,
    width,
    height,
    count: [{ node: latentId, input: "batch_size" }],
    output: outputId,
  };
  const applied = applySlots(Object.fromEntries(nodes), slots);
  if (!applied.ok) return { ok: false, refusal: applied.refusal };
  return { ok: true, template: applied.graph, slots, changed, skipped };
}
