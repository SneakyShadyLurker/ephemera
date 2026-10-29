import { type Candidate, CREATOR_ART, type NodeTitles, type SlotTarget } from "@ephemera/core";
import { type ChoicePlace, choosable, type Draft, nodeName } from "./panel-state.ts";

/*
 * The four places Ephemera fills, as the import panel lists them: derived
 * from core's finalization of the current choices (its slots) and, while a
 * place waits for a choice, from detection. Names and values come from the
 * inspection; nothing here is stored.
 */

/** One node a place fills, with the inputs it fills there. */
export interface MappingTarget {
  title: string;
  node: string;
  inputs: string[];
}

/** A Select for a place detection could not settle. */
export interface MappingChoice {
  place: ChoicePlace;
  label: "Prompt node" | "Size node" | "Output node";
  ask: string;
  value: string | null;
  options: { value: string; title: string; description: string }[];
}

export interface MappingRow {
  place: "prompt" | "size" | "seed" | "output";
  label: "Prompt" | "Size and count" | "Seed" | "Image output";
  /** Empty while the place waits for a choice. */
  targets: MappingTarget[];
  /** The value the file holds, shown after "In this file:". */
  inFile: string | null;
  /** What Ephemera does with it. */
  does: string;
  choice: MappingChoice | null;
}

const SIZE_INPUTS = ["width", "height", "batch_size"];
const SAVER = "SaveImageWebsocket";
const PREVIEW_LENGTH = 60;

const isLink = (value: unknown): value is [string, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  typeof value[1] === "number";

/** A short first line of text, quoted. */
const quoted = (text: string): string => {
  const [first = ""] = text.split("\n");
  const line = first.trim();
  return `"${line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH).trimEnd()}…` : line}"`;
};

/** A graph value as the panel shows it: a list's inner values, a link by its node, text quoted. */
export function fileValue(value: unknown, titles: NodeTitles): string {
  if (isLink(value)) return `from ${nodeName(titles, value[0])}`;
  if (typeof value === "object" && value !== null && "__value__" in value) {
    const inner = value.__value__;
    return Array.isArray(inner) ? inner.map(String).join(", ") : String(inner);
  }
  if (typeof value === "string") return value.trim() === "" ? "no text" : quoted(value);
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

/** Targets by node, each node once with its inputs, in their order. */
function byNode(draft: Draft, targets: readonly SlotTarget[]): MappingTarget[] {
  const grouped = new Map<string, string[]>();
  for (const { node, input } of targets) grouped.set(node, [...(grouped.get(node) ?? []), input]);
  return [...grouped].map(([node, inputs]) => ({ title: titleOf(draft, node), node, inputs }));
}

function titleOf(draft: Draft, node: string): string {
  const { detection, graph } = draft.inspection;
  const candidate = [
    ...detection.prompt.candidates,
    ...detection.latent.candidates,
    ...detection.output.candidates,
  ].find((option) => option.node === node);
  return draft.titles.get(node) ?? candidate?.title ?? graph[node]?.class_type ?? node;
}

const valueAt = (draft: Draft, { node, input }: SlotTarget): unknown =>
  draft.inspection.graph[node]?.inputs[input];

const CHOICES = {
  prompt: { label: "Prompt node", ask: "Choose the prompt node" },
  latent: { label: "Size node", ask: "Choose the size node" },
  output: { label: "Output node", ask: "Choose the output node" },
} as const;

function choiceOf(draft: Draft, place: ChoicePlace): MappingChoice | null {
  if (!choosable(draft, place)) return null;
  const chosen = draft.choices[place];
  const describe = (candidate: Candidate): string => {
    const where = [`node ${candidate.node}`, ...candidate.inputs].join(", ");
    return candidate.preview === undefined ? where : `${where}: ${quoted(candidate.preview)}`;
  };
  return {
    place,
    ...CHOICES[place],
    value: Array.isArray(chosen) ? (chosen[0] ?? null) : (chosen ?? null),
    options: draft.inspection.detection[place].candidates.map((candidate) => ({
      value: candidate.node,
      title: titleOf(draft, candidate.node),
      description: describe(candidate),
    })),
  };
}

export function mappingRows(draft: Draft): MappingRow[] {
  const { detection } = draft.inspection;
  const slots = draft.final.ok ? draft.final.slots : null;
  const waiting = (place: ChoicePlace) =>
    slots === null && draft.choices[place] === undefined && choosable(draft, place);

  const chosenPrompt = draft.choices.prompt?.flatMap((node) =>
    (detection.prompt.candidates.find((option) => option.node === node)?.inputs ?? []).map(
      (input) => ({ node, input }),
    ),
  );
  const promptTargets: SlotTarget[] = waiting("prompt")
    ? []
    : (slots?.prompt ?? chosenPrompt ?? detection.prompt.chosen ?? []);

  const latent = waiting("latent")
    ? null
    : (slots?.count[0]?.node ?? draft.choices.latent ?? detection.latent.chosen);
  const seed = slots?.seed ?? detection.seed;
  const output = waiting("output")
    ? null
    : (slots?.output ?? draft.choices.output ?? detection.output.chosen);

  const values = (targets: readonly SlotTarget[]) =>
    targets.length === 0
      ? null
      : [...new Set(targets.map((target) => fileValue(valueAt(draft, target), draft.titles)))].join(
          ", ",
        );
  const size = (() => {
    if (latent === null) return null;
    const inputs = draft.inspection.graph[latent]?.inputs ?? {};
    const { width, height, batch_size: batch } = inputs;
    return typeof width === "number" && typeof height === "number" && typeof batch === "number"
      ? `${width} x ${height}, batch ${batch}`
      : SIZE_INPUTS.map((input) => fileValue(inputs[input], draft.titles)).join(", ");
  })();

  return [
    {
      place: "prompt",
      label: "Prompt",
      targets: byNode(draft, promptTargets),
      inFile: values(promptTargets),
      does: "Replaced by the card's image prompt.",
      choice: choiceOf(draft, "prompt"),
    },
    {
      place: "size",
      label: "Size and count",
      targets:
        latent === null
          ? []
          : [{ title: titleOf(draft, latent), node: latent, inputs: SIZE_INPUTS }],
      inFile: size,
      does: `Set to ${CREATOR_ART.width} x ${CREATOR_ART.height} and the batch Ephemera asks for.`,
      choice: choiceOf(draft, "latent"),
    },
    {
      place: "seed",
      label: "Seed",
      targets: byNode(draft, seed),
      inFile: values(seed),
      does: "Set for every batch.",
      choice: null,
    },
    {
      place: "output",
      label: "Image output",
      targets: output === null ? [] : [{ title: titleOf(draft, output), node: output, inputs: [] }],
      inFile: null,
      does:
        output !== null && draft.inspection.graph[output]?.class_type === SAVER
          ? "Sends the picture to Ephemera."
          : "Now sends the picture to Ephemera instead of a file.",
      choice: choiceOf(draft, "output"),
    },
  ];
}

/** The file's nodes that stay as they are: neither filled by Ephemera nor left out. */
export function otherNodes(draft: Draft): Draft["inspection"]["nodes"] {
  const graph = draft.final.ok ? draft.final.template : draft.inspection.graph;
  const placed = new Set(
    mappingRows(draft).flatMap((row) => row.targets.map((target) => target.node)),
  );
  if (draft.final.ok) {
    const { slots } = draft.final;
    for (const target of [...slots.width, ...slots.height]) placed.add(target.node);
  }
  return draft.inspection.nodes.filter(
    (node) => Object.hasOwn(graph, node.id) && !placed.has(node.id),
  );
}
