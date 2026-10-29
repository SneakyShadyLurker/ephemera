import { join } from "node:path";
import {
  type ArtFamily,
  comfyuiWorkflowIdSchema,
  creatorArtWorkflowsSchema,
  DEFAULT_SETTINGS,
  type EphemeraMeta,
  fileFamilyOf,
  MODEL_INPUT_EXCEPTIONS,
  type NodeMetaMap,
  stripEphemeraKey,
  USER_WORKFLOW_PREFIX,
  type WorkflowGraph,
} from "@ephemera/core";
import { z } from "zod";
import type { Logger } from "../log.ts";
import { readWorkflowFiles, WorkflowFileError } from "../persistence/workflow-files.ts";
import { createAllowlist, type NodeAllowlist, OUTPUT_CLASS } from "./allowlist.ts";

export type { WorkflowGraph };
export { WorkflowFileError };

/*
 * The ComfyUI workflows (API format), one file each in the bundled
 * `workflows/` or in `EPHEMERA_WORKFLOWS_DIR`, found when the server starts:
 * the file name is the id. The bundled graphs derive from Atelier's ComfyUI
 * graphs (MIT). A template
 * marks each value the client supplies with a whole-string placeholder such
 * as "{{seed}}".
 */

export type WorkflowId = string;

/** The curated node classes alone, for callers that configure no extras. */
const DEFAULT_ALLOWLIST = createAllowlist([]);

const graphSchema: z.ZodType<WorkflowGraph> = z.record(
  z.string().min(1),
  z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }),
);

/**
 * What fills a template: the image prompt and the numbers of one batch, and
 * for a reference graph the job input its LoadImage node reads.
 */
interface WorkflowValues {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  count: number;
  referenceImage?: string;
}

/** Every template has these. */
const PLACEHOLDERS = ["prompt", "seed", "width", "height", "count"] as const;
/** Only a reference graph has this, and only a value given for it fills it. */
const REFERENCE_PLACEHOLDER = "referenceImage";
type Placeholder = (typeof PLACEHOLDERS)[number] | typeof REFERENCE_PLACEHOLDER;
const isPlaceholder = (name: string): name is Placeholder =>
  name === REFERENCE_PLACEHOLDER || (PLACEHOLDERS as readonly string[]).includes(name);

/** A whole input value that is a placeholder, and any placeholder text at all. */
const WHOLE = /^\{\{(\w+)\}\}$/;
const ANY = /\{\{\w*\}\}/;

/**
 * The template with every placeholder replaced. Values go in as JSON values,
 * not as text: the prompt stays a string whatever it contains (quotes,
 * backslashes, newlines, text that looks like a placeholder) and is encoded
 * once when the graph is sent; the numbers stay numbers. A template that
 * lacks a placeholder, or has one this function does not know, is refused;
 * so is a reference image given to a template without its placeholder, or a
 * template with one and no reference image given.
 */
export function fillWorkflow(template: WorkflowGraph, values: WorkflowValues): WorkflowGraph {
  for (const name of ["seed", "width", "height", "count"] as const) {
    if (!Number.isSafeInteger(values[name]) || values[name] < 0) {
      throw new RangeError(`workflow ${name} must be a non-negative integer`);
    }
  }
  const used = new Set<Placeholder>();
  const filled: WorkflowGraph = {};
  for (const [id, node] of Object.entries(template)) {
    const inputs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      const placeholder = typeof value === "string" ? WHOLE.exec(value)?.[1] : undefined;
      const filling =
        placeholder !== undefined && isPlaceholder(placeholder) ? values[placeholder] : undefined;
      if (placeholder !== undefined && isPlaceholder(placeholder) && filling !== undefined) {
        used.add(placeholder);
        inputs[name] = filling;
      } else if (ANY.test(JSON.stringify(value))) {
        throw new Error("workflow template has an unknown or embedded placeholder");
      } else {
        inputs[name] = value;
      }
    }
    filled[id] = { class_type: node.class_type, inputs };
  }
  const expected = PLACEHOLDERS.length + (values.referenceImage === undefined ? 0 : 1);
  if (used.size !== expected) {
    throw new Error("workflow template lacks a placeholder");
  }
  return filled;
}

/** A model file a loader node of the workflow needs. */
export interface RequiredModel {
  classType: string;
  input: string;
  file: string;
}

export interface Workflow {
  graph: WorkflowGraph;
  /** The SaveImageWebsocket node whose binary frames are the batch. */
  output: string;
  models: RequiredModel[];
  /**
   * The image-model family the graph runs, as the file's `ephemera.family`
   * declares or else as the first word of its id names; it picks the art metaprompt.
   */
  family: ArtFamily;
}

function workflow(source: unknown, family: ArtFamily, allowlist: NodeAllowlist): Workflow {
  const graph = graphSchema.parse(source);
  if (Object.values(graph).some((node) => !allowlist.allows(node.class_type, "file"))) {
    throw new Error("workflow uses a node class that is not allowed");
  }
  return describeWorkflow(graph, family);
}

/**
 * A template's save node and the model files its loaders need, for a server
 * file and a user's stored graph alike; a graph without exactly one save
 * node throws.
 */
export function describeWorkflow(graph: WorkflowGraph, family: ArtFamily): Workflow {
  const outputs = Object.entries(graph).filter(([, node]) => node.class_type === OUTPUT_CLASS);
  const output = outputs[0]?.[0];
  if (output === undefined || outputs.length !== 1) {
    throw new Error("workflow needs exactly one SaveImageWebsocket node");
  }
  // Without a live `/object_info` the class names are all there is: loaders and the model-only LoRA.
  const models = Object.values(graph).flatMap((node) =>
    node.class_type.endsWith("Loader") || node.class_type === "LoraLoaderModelOnly"
      ? Object.entries(node.inputs).flatMap(([input, file]) =>
          input.endsWith("_name") && typeof file === "string"
            ? [{ classType: node.class_type, input, file }]
            : [],
        )
      : [],
  );
  return { graph, output, models, family };
}

/**
 * The model files a graph needs, read from a live `/object_info`: any string
 * input whose spec is a combo and whose name ends in `_name` or `_path`, the
 * convention ComfyUI's loaders follow, with the exceptions core lists. A
 * class the instance lacks needs none here; it is a missing node instead.
 */
export function requiredModels(graph: WorkflowGraph, meta: NodeMetaMap): RequiredModel[] {
  const { notFiles, files } = MODEL_INPUT_EXCEPTIONS;
  return Object.values(graph).flatMap((node) => {
    const inputs = meta.get(node.class_type)?.inputs;
    if (inputs === undefined) return [];
    const named = Object.hasOwn(files, node.class_type) ? (files[node.class_type] ?? []) : [];
    return Object.entries(node.inputs).flatMap(([input, file]) =>
      typeof file === "string" &&
      Object.hasOwn(inputs, input) &&
      inputs[input]?.kind === "COMBO" &&
      (named.includes(input) || (/_(name|path)$/.test(input) && !notFiles.has(input)))
        ? [{ classType: node.class_type, input, file }]
        : [],
    );
  });
}

/** Words of an id written in capitals on screen. */
const ACRONYMS: ReadonlySet<string> = new Set(["moss", "sft"]);

/**
 * The name on screen, from the id: "krea2-gonzalomo" is "Krea 2 Gonzalomo",
 * "moss-sample-sft" is "MOSS Sample SFT".
 */
function workflowName(id: WorkflowId): string {
  return id
    .split("-")
    .map((word) => {
      if (ACRONYMS.has(word)) return word.toUpperCase();
      const [, letters = word, digits] = /^([a-z]+)(\d+)$/.exec(word) ?? [];
      const title = letters.charAt(0).toUpperCase() + letters.slice(1);
      return digits === undefined ? title : `${title} ${digits}`;
    })
    .join(" ");
}

/** The file name suffix of a workflow's reference graph, which loads a portrait as its image input. */
const REFERENCE_SUFFIX = ".reference.json";

/**
 * Fills a template with sample values and throws as `fillWorkflow` would at
 * a run: the last gate before a server file or a user's template is taken.
 * `reference` probes the reference placeholder.
 */
export function dryFill(graph: WorkflowGraph, reference = false): void {
  fillWorkflow(graph, {
    prompt: "",
    seed: 0,
    width: 1,
    height: 1,
    count: 1,
    ...(reference ? { referenceImage: "" } : {}),
  });
}

/**
 * A file's graph as discovery admits it, without its reserved `ephemera` key,
 * and what that key declared; `reference` probes the reference placeholder.
 */
function admitted(
  file: string,
  id: WorkflowId,
  source: unknown,
  reference: boolean,
  allowlist: NodeAllowlist,
): { workflow: Workflow; meta: EphemeraMeta } {
  try {
    const { graph, meta } = stripEphemeraKey(source);
    const parsed = workflow(graph, meta.family ?? fileFamilyOf(id), allowlist);
    dryFill(parsed.graph, reference);
    return { workflow: parsed, meta };
  } catch (error) {
    throw new WorkflowFileError(`workflow file is not a valid workflow: ${file}`, file, {
      cause: error,
    });
  }
}

/**
 * Every graph given: `<id>.json` is the workflow `<id>`, and
 * `<id>.reference.json` its reference graph, which is never a workflow of
 * its own. A file may carry the reserved top-level `ephemera` key
 * (`{ family?, name? }`), which never reaches the graph. A file that is not a
 * valid workflow, whose placeholders `fillWorkflow` would refuse, whose name
 * uses the reserved `user-` prefix or is an id already found, or a reference
 * graph without its workflow, stops the server; so does a node class outside
 * `allowlist`, the curated classes alone unless given. Errors name the file,
 * never its content. `names` holds each workflow's name on screen; `general`
 * the files that run General only because their first word names no family.
 */
export function discoverWorkflows(
  files: readonly { file: string; source: unknown }[],
  allowlist: NodeAllowlist = DEFAULT_ALLOWLIST,
): {
  workflows: ReadonlyMap<WorkflowId, Workflow>;
  references: ReadonlyMap<WorkflowId, Workflow>;
  names: ReadonlyMap<WorkflowId, string>;
  general: readonly string[];
} {
  const workflows = new Map<WorkflowId, Workflow>();
  const references = new Map<WorkflowId, Workflow>();
  const names = new Map<WorkflowId, string>();
  const general: string[] = [];
  for (const { file, source } of files) {
    const reference = file.endsWith(REFERENCE_SUFFIX);
    const id = file.slice(0, -(reference ? REFERENCE_SUFFIX : ".json").length);
    if (!comfyuiWorkflowIdSchema.safeParse(id).success) {
      throw new WorkflowFileError(`workflow file name is not a workflow id: ${file}`, file);
    }
    if (id.startsWith(USER_WORKFLOW_PREFIX)) {
      throw new WorkflowFileError(`workflow file name uses the reserved prefix: ${file}`, file);
    }
    const found = reference ? references : workflows;
    if (found.has(id)) throw new WorkflowFileError(`workflow file name is taken: ${file}`, file);
    const { workflow: loaded, meta } = admitted(file, id, source, reference, allowlist);
    found.set(id, loaded);
    if (!reference) names.set(id, meta.name ?? workflowName(id));
    if (meta.family === undefined && fileFamilyOf(id) === "general") general.push(file);
  }
  for (const id of references.keys()) {
    if (!workflows.has(id)) {
      const file = `${id}${REFERENCE_SUFFIX}`;
      throw new WorkflowFileError(`reference graph has no workflow: ${file}`, file);
    }
  }
  return { workflows, references, names, general };
}

/** The workflows shipped with the server. */
export const BUNDLED_WORKFLOWS_DIR = join(import.meta.dirname, "workflows");

export type WorkflowList = z.infer<typeof creatorArtWorkflowsSchema>;

/**
 * The workflows the server runs, built once at startup (index.ts); each
 * request merges them with the user's own in its catalog (catalog.ts).
 */
export interface ServerWorkflows {
  /** The workflows the owner can choose, in file name order. */
  list: WorkflowList;
  has(id: WorkflowId): boolean;
  /** The graph of a workflow `requested` admitted; an id without one throws. */
  get(id: WorkflowId): Workflow;
  /** A saved choice whose file is gone falls back to the default, as a deleted preset's reference clears. */
  known(id: WorkflowId): WorkflowId;
  /**
   * The workflow a request runs: the one it names, which must have a graph
   * (never another in its place), or, when it names none, the saved one.
   * Undefined refuses the request.
   */
  requested(named: WorkflowId | undefined, saved: WorkflowId): WorkflowId | undefined;
  /**
   * A workflow's reference graph, or undefined when it has none. One runs
   * only on Atelier's private worker, which holds the portrait in memory
   * under the job's lease; a plain ComfyUI always runs the text graph.
   */
  referenceOf(id: WorkflowId): Workflow | undefined;
  /** The configured default, else the core one; it must have a graph. */
  defaultWorkflow: WorkflowId;
}

/**
 * The registry over every graph file given, from any number of directories,
 * in file name order. Two files of one name stop the server, as does a
 * default without a graph or more workflows than the list allows. Each file
 * that runs General only because its first word names no family is logged
 * once, by file name.
 */
export function createWorkflowRegistry({
  files,
  defaultWorkflow = DEFAULT_SETTINGS.comfyuiWorkflow,
  allowlist,
  log,
}: {
  files: readonly { file: string; source: unknown }[];
  defaultWorkflow?: WorkflowId | undefined;
  allowlist?: NodeAllowlist | undefined;
  log?: Logger | undefined;
}): ServerWorkflows {
  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const { workflows, references, names, general } = discoverWorkflows(sorted, allowlist);
  if (!workflows.has(defaultWorkflow)) throw new Error("the default workflow has no file");
  const list = creatorArtWorkflowsSchema.parse({
    workflows: [...workflows].map(([id, { family }]) => ({
      id,
      name: names.get(id) ?? workflowName(id),
      family,
      scope: "server",
    })),
  });
  for (const file of general) log?.info({ event: "startup.workflows", family: "general", file });
  const known = (id: WorkflowId): WorkflowId => (workflows.has(id) ? id : defaultWorkflow);
  return {
    list,
    has: (id) => workflows.has(id),
    get(id) {
      const found = workflows.get(id);
      if (found === undefined) throw new Error("workflow has no graph");
      return found;
    },
    known,
    requested: (named, saved) =>
      named === undefined ? known(saved) : workflows.has(named) ? named : undefined,
    referenceOf: (id) => references.get(id),
    defaultWorkflow,
  };
}

/**
 * The registry over the bundled graphs and, when configured, the graphs of
 * `EPHEMERA_WORKFLOWS_DIR`, which may add workflows or reference graphs for
 * bundled ones but never replace a file.
 */
export function loadWorkflowRegistry({
  bundledDir = BUNDLED_WORKFLOWS_DIR,
  workflowsDir,
  defaultWorkflow,
  allowlist,
  log,
}: {
  bundledDir?: string;
  workflowsDir?: string | undefined;
  defaultWorkflow?: WorkflowId | undefined;
  /** The node classes files may use; the curated ones alone when not given. */
  allowlist?: NodeAllowlist | undefined;
  log?: Logger | undefined;
}): ServerWorkflows {
  return createWorkflowRegistry({
    files: [
      ...readWorkflowFiles(bundledDir),
      ...(workflowsDir === undefined ? [] : readWorkflowFiles(workflowsDir)),
    ],
    defaultWorkflow,
    allowlist,
    log,
  });
}
