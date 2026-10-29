import {
  type ArtFamily,
  type BlockedReason,
  WORKFLOW_LIMITS,
  type WorkflowRefusalCode,
} from "@ephemera/core";
import { andList } from "@/lib/text";

/*
 * What the import panel says. Every refusal is a plain sentence on what is
 * wrong, then its way out; a node is "title (node id)". Only the refusals an
 * API export fixes suggest it.
 */

const AGAIN = "import again.";

/** What is wrong, with the listed nodes after a colon when there are any, then the way out. */
const naming =
  (wrong: string, way: string) =>
  (nodes: readonly string[]): string =>
    `${wrong}${nodes.length > 0 ? `: ${andList(nodes)}` : ""}. ${way}`;

const fixed = (text: string) => (): string => text;

/** One sentence per core refusal; a new code fails the build until it has one. */
const REFUSAL_COPY = {
  not_a_workflow: fixed(
    "This file is not a ComfyUI workflow. Save or export the workflow from ComfyUI and import that file.",
  ),
  too_large: fixed(
    "This file is too large or too complex to import. Remove nodes, or export it in API format from ComfyUI.",
  ),
  too_many_nodes: fixed(
    `This workflow has more than ${WORKFLOW_LIMITS.nodes} nodes once its subgraphs are opened up. Remove nodes in ComfyUI and ${AGAIN}`,
  ),
  too_deep: fixed(
    "This file is nested too deeply to read. Flatten its subgraphs, or export it in API format from ComfyUI.",
  ),
  unknown_node: naming(
    "Your ComfyUI does not know some nodes in this file",
    `Install them in ComfyUI, or remove them, and ${AGAIN}`,
  ),
  dynamic_inputs: naming(
    "Some nodes have inputs that grow as they are connected, which Ephemera cannot read yet",
    `Remove them in ComfyUI and ${AGAIN}`,
  ),
  widget_values_short: naming(
    "Some nodes hold fewer values than your ComfyUI expects",
    `Open the workflow in ComfyUI, save it again and ${AGAIN}`,
  ),
  subgraph_widgets: naming(
    "A subgraph's values do not match its inputs",
    `Open the workflow in ComfyUI, save it again and ${AGAIN}`,
  ),
  muted_dependency: naming(
    "A muted node feeds a node that runs",
    `Unmute it, or remove its link, in ComfyUI and ${AGAIN}`,
  ),
  bypass_dependency: naming(
    "A bypassed node cannot pass on what the next node needs",
    `Remove the bypass in ComfyUI and ${AGAIN}`,
  ),
  unconnected_input: naming("A node lacks an input it needs", `Connect it in ComfyUI and ${AGAIN}`),
  no_output: fixed(
    `This workflow has no node that outputs an image. Add a Save Image node in ComfyUI and ${AGAIN}`,
  ),
  no_prompt_slot: fixed(
    `No node in this workflow takes a text prompt. Add a text encoder for the prompt in ComfyUI and ${AGAIN}`,
  ),
  no_size_slot: fixed(
    `No empty latent image sets the picture's size. Add one in ComfyUI and ${AGAIN}`,
  ),
  no_seed_slot: fixed(
    `No sampler has a seed Ephemera can set. Add a sampler with a seed in ComfyUI and ${AGAIN}`,
  ),
  too_many_targets: fixed(
    `More than ${WORKFLOW_LIMITS.targetsPerPlace} nodes share the prompt or the seed. Remove some in ComfyUI and ${AGAIN}`,
  ),
  linked_prompt: fixed(
    "The prompt comes from another node that also feeds something else. Give the prompt its own text in ComfyUI and import again.",
  ),
  not_a_candidate: naming("That node cannot take this place", "Choose another node."),
  embedded_placeholder: naming(
    "Some values already hold text like {{prompt}}, which Ephemera writes itself",
    `Change that text in ComfyUI and ${AGAIN}`,
  ),
} satisfies Record<WorkflowRefusalCode, (nodes: readonly string[]) => string>;

/** A refusal in words; `nodes` are as the panel names them ("title (node id)", or a class). */
export const refusalText = (code: WorkflowRefusalCode, nodes: readonly string[]): string =>
  REFUSAL_COPY[code](nodes);

/** A file the tab refuses before sending it. */
export type TabRefusal = { kind: "not_json" } | { kind: "too_large" };

export const fileRefusalText = (fileName: string, refusal: TabRefusal): string =>
  refusal.kind === "not_json" ? `${fileName} is not a JSON file.` : refusalText("too_large", []);

/** Why a blocked node cannot run, before its name. */
export const BLOCKED_COPY: Record<BlockedReason, string> = {
  not_allowed:
    "Not on this server's list of in-memory nodes. Remove it in ComfyUI and import again, or ask the operator to add it to EPHEMERA_COMFYUI_EXTRA_NODES.",
  refused_writes:
    "This node writes files or shows output in ComfyUI. Remove it in ComfyUI and import again.",
  output_node:
    "This node writes files or shows output in ComfyUI. Remove it in ComfyUI and import again.",
  reference_only:
    "This node loads a reference image, which imported workflows cannot use yet. Remove it in ComfyUI and import again.",
};

export const FAMILY_HELP: Record<ArtFamily, string> = {
  general: "General uses plain-language image prompts.",
  krea2: "Krea 2 prompts are written for Krea 2 models.",
  moss: "MOSS prompts are written for MOSS Image models.",
};

const WORDS = ["no", "one", "two", "three"] as const;

/** The line above the footer while places wait for a choice. */
export const unchosenSummary = (count: number): string =>
  `Choose ${WORDS[count] ?? String(count)} ${count === 1 ? "mapping" : "mappings"} before saving.`;

export const INSPECT_BUSY = "Another import is still being read. Try again in a moment.";

export const SAVE_FULL = `${WORKFLOW_LIMITS.workflows} workflows is the most Ephemera keeps. Delete one, then save.`;

export const DELETED_ELSEWHERE = "This workflow was deleted in another tab.";

/** A UI file needs the live ComfyUI to place its values. */
export const uiNotReached = (address: string): string =>
  address === ""
    ? "No ComfyUI address is saved. Reading a saved workflow needs it."
    : `Not reached at ${address}. Reading a saved workflow needs it.`;

/** An API file reads without ComfyUI. */
export const API_NOT_REACHED = "Not reached. You can save without a check.";

export const LIVE_READY = "Every node and model file is there.";

export const LIVE_MISSING = "Some nodes or model files are not on your ComfyUI.";

export const MISSING_HELP =
  "Saved, but cannot run yet: its row shows Missing requirements until these are installed.";

export const SERVER_NAME_NOTE = "A server workflow has this name too; both are listed.";

/** Said once in the list after a save the live ComfyUI did not check. */
export const SAVED_UNCHECKED =
  "Saved without a check; its row shows what it lacks once ComfyUI answers.";
