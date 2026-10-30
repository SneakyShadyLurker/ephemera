import type { ArtFamily } from "../creator/prompts.ts";
import type { Candidate, DetectResult, Normalized, WorkflowRefusalCode } from "./finalize.ts";
import { WORKFLOW_LIMITS, type WorkflowGraph, type WorkflowNode } from "./graph.ts";
import { isLink, upstreamOf } from "./links.ts";
import type { NodeMetaMap } from "./meta.ts";
import { imageOutputs } from "./normalize.ts";
import { type NodeTitles, nodeTitle } from "./report.ts";
import type { SlotTarget } from "./slots.ts";

/*
 * Where Ephemera's values go in a normalized graph: the image output, the encoders whose conditioning reaches the
 * output's sampler positive, the empty latent the sampler chain starts
 * from, every seed, and the art family the loaders suggest. A place with
 * several candidates and no evidence stays unchosen for the user.
 */

/** Each text encoder's prompt inputs. */
export const TEXT_INPUTS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ["CLIPTextEncode", ["text"]],
  ["CLIPTextEncodeSDXL", ["text_g", "text_l"]],
  ["CLIPTextEncodeSDXLRefiner", ["text"]],
  ["CLIPTextEncodeFlux", ["clip_l", "t5xxl"]],
  ["CLIPTextEncodeSD3", ["clip_l", "clip_g", "t5xxl"]],
  ["CLIPTextEncodeHiDream", ["clip_l", "clip_g", "t5xxl", "llama"]],
  ["CLIPTextEncodeLumina2", ["user_prompt"]],
  ["TextEncodeQwenImageEdit", ["prompt"]],
  ["TextEncodeQwenImageEditPlus", ["prompt"]],
  ["TextEncodeQwenImage21", ["prompt"]],
  ["TextEncodeMOSSImageEdit", ["prompt"]],
  ["TextEncodeKrea2OstrisEdit", ["prompt"]],
  ["MOSSImageLayoutPrompt", ["prompt"]],
]);

/** The empty-latent classes by name; any `Empty...LatentImage` with the size inputs counts too. */
export const EMPTY_LATENTS: ReadonlySet<string> = new Set([
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "EmptyFlux2LatentImage",
  "EmptyQwenImageLayeredLatentImage",
]);
const EMPTY_LATENT_PATTERN = /^Empty.*LatentImage$/;
const SIZE_INPUTS = ["width", "height", "batch_size"];

/** Each sampler or guider's positive conditioning input. */
export const SAMPLER_POSITIVE: ReadonlyMap<string, string> = new Map<string, string>([
  ["KSampler", "positive"],
  ["KSamplerAdvanced", "positive"],
  ["SamplerCustom", "positive"],
  ["CFGGuider", "positive"],
  ["DualCFGGuider", "cond1"],
  ["BasicGuider", "conditioning"],
]);

/**
 * The conditioning inputs the trace follows through a node that passes
 * conditioning on; `ConditioningZeroOut` is a negative marker and stops it.
 * Combine and Concat pass both sides, so both encoders are chosen.
 */
export const PASS_THROUGH: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ["FluxGuidance", ["conditioning"]],
  ["ConditioningSetTimestepRange", ["conditioning"]],
  ["ConditioningSetArea", ["conditioning"]],
  ["ConditioningSetAreaPercentage", ["conditioning"]],
  ["ConditioningSetAreaStrength", ["conditioning"]],
  ["ConditioningSetMask", ["conditioning"]],
  ["FluxKontextMultiReferenceLatentMethod", ["conditioning"]],
  ["ReferenceLatent", ["conditioning"]],
  ["ConditioningCombine", ["conditioning_1", "conditioning_2"]],
  ["ConditioningConcat", ["conditioning_to", "conditioning_from"]],
]);

/** The samplers whose `seed` or `noise_seed` always takes the seed. */
const SEEDED = new Set(["KSampler", "KSamplerAdvanced", "SamplerCustom", "RandomNoise"]);
const SEED_INPUTS = ["seed", "noise_seed"];

/** Loader inputs naming a model file, read for the family guess. */
const FILE_INPUTS = ["unet_name", "ckpt_name", "clip_name", "lora_name", "model_name"];

const PREVIEW_LENGTH = 80;

/** The first 80 characters, never splitting one and never past 80 code units. */
function previewOf(text: string): string {
  const characters = Array.from(text).slice(0, PREVIEW_LENGTH);
  while (characters.join("").length > PREVIEW_LENGTH) characters.pop();
  return characters.join("");
}

const refuse = (error: WorkflowRefusalCode): DetectResult => ({ ok: false, refusal: { error } });

function familyOf(graph: WorkflowGraph): ArtFamily {
  const names = Object.values(graph).flatMap((node) => [
    node.class_type,
    ...FILE_INPUTS.flatMap((input) => {
      const value = node.inputs[input];
      return typeof value === "string" ? [value] : [];
    }),
  ]);
  if (names.some((name) => /krea/i.test(name))) return "krea2";
  if (names.some((name) => /moss/i.test(name))) return "moss";
  return "general";
}

/** The encoders whose conditioning reaches a sampler positive among `chain`. */
export function positiveEncoders(
  nodes: ReadonlyMap<string, WorkflowNode>,
  chain: Iterable<string>,
): Set<string> {
  const reached = new Set<string>();
  const seen = new Set<string>();
  const pending: string[] = [];
  for (const id of chain) {
    const node = nodes.get(id);
    const positive = node === undefined ? undefined : SAMPLER_POSITIVE.get(node.class_type);
    const link = positive === undefined ? undefined : node?.inputs[positive];
    if (isLink(link)) pending.push(link[0]);
  }
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (node === undefined) continue;
    if (TEXT_INPUTS.has(node.class_type)) {
      reached.add(id);
      continue;
    }
    for (const input of PASS_THROUGH.get(node.class_type) ?? []) {
      const link = node.inputs[input];
      if (isLink(link)) pending.push(link[0]);
    }
  }
  return reached;
}

/** The empty latent to fill: the one there is, else the one `chain` reaches, else none. */
export function latentIn(latents: readonly string[], chain: ReadonlySet<string>): string | null {
  if (latents.length === 1) return latents[0] ?? null;
  const reachable = latents.filter((id) => chain.has(id));
  return reachable.length === 1 ? (reachable[0] ?? null) : null;
}

/**
 * The places and the family guess, or the refusal
 * naming the missing one. With several outputs, the prompt and latent are
 * found across every output's branch; finalization finds them again from
 * the chosen output's.
 */
export function detectWorkflow(
  normalized: Normalized,
  meta: NodeMetaMap | undefined,
  titles?: NodeTitles,
): DetectResult {
  const { graph } = normalized;
  const nodes = new Map(Object.entries(graph));
  const candidate = (node: string, inputs: string[], preview?: string): Candidate => {
    const classType = graph[node]?.class_type ?? "";
    return {
      node,
      title: nodeTitle(graph, node, meta, titles),
      classType,
      inputs,
      ...(preview === undefined ? {} : { preview }),
    };
  };

  // Output: every image output; the one there is, else the user picks.
  const outputs = imageOutputs(graph, meta);
  if (outputs.length === 0) return refuse("no_output");
  const output = outputs.length === 1 ? (outputs[0] ?? null) : null;
  const chain = upstreamOf(nodes, output === null ? outputs : [output]);

  // Prompt: the encoders whose conditioning reaches a sampler positive in the chain.
  // A linked text input shows the text of the node that supplies it.
  const textOf = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (!isLink(value)) return undefined;
    return Object.values(nodes.get(value[0])?.inputs ?? {}).find(
      (text): text is string => typeof text === "string" && text !== "",
    );
  };
  const encoders = [...nodes].flatMap(([id, node]) => {
    const inputs = (TEXT_INPUTS.get(node.class_type) ?? []).filter((input) =>
      Object.hasOwn(node.inputs, input),
    );
    if (inputs.length === 0) return [];
    const texts = inputs.flatMap((input) => textOf(node.inputs[input]) ?? []);
    const text = texts.find((value) => value !== "") ?? "";
    const length = texts.reduce((sum, value) => sum + Array.from(value).length, 0);
    return [{ candidate: candidate(id, inputs, previewOf(text)), length }];
  });
  if (encoders.length === 0) return refuse("no_prompt_slot");
  const reached = positiveEncoders(nodes, chain);
  const ranked = encoders
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(({ candidate }) => candidate);
  const chosenEncoders = encoders
    .map(({ candidate }) => candidate)
    .filter(({ node }) => reached.has(node));
  const prompt: SlotTarget[] = chosenEncoders.flatMap(({ node, inputs }) =>
    inputs.map((input) => ({ node, input })),
  );
  if (chosenEncoders.length > WORKFLOW_LIMITS.targetsPerPlace) return refuse("too_many_targets");
  if (prompt.length > WORKFLOW_LIMITS.targetsPerPlace) return refuse("too_many_targets");

  // Latent: the empty latents; the one there is, else the one the chain reaches.
  const latents = [...nodes].flatMap(([id, node]) =>
    (EMPTY_LATENTS.has(node.class_type) || EMPTY_LATENT_PATTERN.test(node.class_type)) &&
    SIZE_INPUTS.every((input) => Object.hasOwn(node.inputs, input))
      ? [id]
      : [],
  );
  if (latents.length === 0) return refuse("no_size_slot");
  const latent = latentIn(latents, chain);

  // Seed: every named seed of a sampler, and with meta every INT with a seed control.
  const seed: SlotTarget[] = [...nodes].flatMap(([id, node]) => {
    const inputs = meta?.get(node.class_type)?.inputs ?? {};
    return Object.keys(node.inputs).flatMap((input) =>
      (SEEDED.has(node.class_type) && SEED_INPUTS.includes(input)) ||
      (inputs[input]?.kind === "INT" && inputs[input]?.controlAfterGenerate === true)
        ? [{ node: id, input }]
        : [],
    );
  });
  if (seed.length === 0) return refuse("no_seed_slot");
  if (seed.length > WORKFLOW_LIMITS.targetsPerPlace) return refuse("too_many_targets");

  return {
    ok: true,
    detection: {
      prompt: { chosen: prompt.length === 0 ? null : prompt, candidates: ranked },
      latent: { chosen: latent, candidates: latents.map((id) => candidate(id, [...SIZE_INPUTS])) },
      seed,
      output: { chosen: output, candidates: outputs.map((id) => candidate(id, ["images"])) },
      familyGuess: familyOf(graph),
    },
  };
}
