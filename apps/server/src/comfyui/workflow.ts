import { join } from "node:path";
import {
  type ArtModel,
  artModelOf,
  comfyuiWorkflowIdSchema,
  creatorArtWorkflowsSchema,
  DEFAULT_SETTINGS,
} from "@ephemera/core";
import { z } from "zod";
import { readWorkflowFiles, WorkflowFileError } from "../persistence/workflow-files.ts";

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

const graphSchema = z.record(
  z.string().min(1),
  z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }),
);
export type WorkflowGraph = z.infer<typeof graphSchema>;

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
interface RequiredModel {
  classType: string;
  input: string;
  file: string;
}

export interface Workflow {
  graph: WorkflowGraph;
  /** The SaveImageWebsocket node whose binary frames are the batch. */
  output: string;
  models: RequiredModel[];
  /** The image model the graph runs, named by the first word of its id; it picks the art metaprompt. */
  artModel: ArtModel;
}

/**
 * The only node classes a graph may use: no node may write to disk, so an
 * image leaves only through SaveImageWebsocket. Extend the list only with
 * classes that keep their output in memory.
 */
const ALLOWED_NODE_CLASSES: ReadonlySet<string> = new Set([
  "CLIPLoader",
  "CLIPTextEncode",
  "ConditioningZeroOut",
  "EmptyFlux2LatentImage",
  "EmptySD3LatentImage",
  "FluxKontextMultiReferenceLatentMethod",
  "ImageScaleBy",
  "ImageScaleToTotalPixels",
  "KSampler",
  "Krea2OstrisEditModelPatch",
  "LoadImage",
  "LoraLoaderModelOnly",
  "ModelAttentionBackend",
  "SaveImageWebsocket",
  "SkipLayerGuidanceDiTSimple",
  "TextEncodeKrea2OstrisEdit",
  "UNETLoader",
  "VAEDecode",
  "VAEEncode",
  "VAELoader",
]);

function workflow(source: unknown, artModel: ArtModel): Workflow {
  const graph = graphSchema.parse(source);
  if (Object.values(graph).some((node) => !ALLOWED_NODE_CLASSES.has(node.class_type))) {
    throw new Error("workflow uses a node class that is not allowed");
  }
  const outputs = Object.entries(graph).filter(
    ([, node]) => node.class_type === "SaveImageWebsocket",
  );
  const output = outputs[0]?.[0];
  if (output === undefined || outputs.length !== 1) {
    throw new Error("workflow needs exactly one SaveImageWebsocket node");
  }
  const models = Object.values(graph).flatMap((node) =>
    node.class_type.endsWith("Loader") || node.class_type === "LoraLoaderModelOnly"
      ? Object.entries(node.inputs).flatMap(([input, file]) =>
          input.endsWith("_name") && typeof file === "string"
            ? [{ classType: node.class_type, input, file }]
            : [],
        )
      : [],
  );
  return { graph, output, models, artModel };
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

/** A file's graph as discovery admits it; `reference` probes the reference placeholder. */
function admitted(file: string, source: unknown, artModel: ArtModel, reference: boolean): Workflow {
  try {
    const parsed = workflow(source, artModel);
    fillWorkflow(parsed.graph, {
      prompt: "",
      seed: 0,
      width: 1,
      height: 1,
      count: 1,
      ...(reference ? { referenceImage: "" } : {}),
    });
    return parsed;
  } catch (error) {
    throw new WorkflowFileError(`workflow file is not a valid workflow: ${file}`, file, {
      cause: error,
    });
  }
}

/**
 * Every graph given: `<id>.json` is the workflow `<id>`, and
 * `<id>.reference.json` its reference graph, which is never a workflow of
 * its own. A file that is not a valid workflow, whose placeholders
 * `fillWorkflow` would refuse, whose name names no image model or an id
 * already found, or a reference graph without its workflow, stops the
 * server. Errors name the file, never its content.
 */
export function discoverWorkflows(files: readonly { file: string; source: unknown }[]): {
  workflows: ReadonlyMap<WorkflowId, Workflow>;
  references: ReadonlyMap<WorkflowId, Workflow>;
} {
  const workflows = new Map<WorkflowId, Workflow>();
  const references = new Map<WorkflowId, Workflow>();
  for (const { file, source } of files) {
    const reference = file.endsWith(REFERENCE_SUFFIX);
    const id = file.slice(0, -(reference ? REFERENCE_SUFFIX : ".json").length);
    if (!comfyuiWorkflowIdSchema.safeParse(id).success) {
      throw new WorkflowFileError(`workflow file name is not a workflow id: ${file}`, file);
    }
    const artModel = artModelOf(id);
    if (artModel === undefined) {
      throw new WorkflowFileError(`workflow file name names no image model: ${file}`, file);
    }
    const found = reference ? references : workflows;
    if (found.has(id)) throw new WorkflowFileError(`workflow file name is taken: ${file}`, file);
    found.set(id, admitted(file, source, artModel, reference));
  }
  for (const id of references.keys()) {
    if (!workflows.has(id)) {
      const file = `${id}${REFERENCE_SUFFIX}`;
      throw new WorkflowFileError(`reference graph has no workflow: ${file}`, file);
    }
  }
  return { workflows, references };
}

/** The workflows shipped with the server. */
export const BUNDLED_WORKFLOWS_DIR = join(import.meta.dirname, "workflows");

export type WorkflowList = z.infer<typeof creatorArtWorkflowsSchema>;

/**
 * The workflows the server runs, built once at startup (index.ts) and passed
 * to every route that paints.
 */
export interface WorkflowRegistry {
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
 * default without a graph or more workflows than the list allows.
 */
export function createWorkflowRegistry({
  files,
  defaultWorkflow = DEFAULT_SETTINGS.comfyuiWorkflow,
}: {
  files: readonly { file: string; source: unknown }[];
  defaultWorkflow?: WorkflowId | undefined;
}): WorkflowRegistry {
  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const { workflows, references } = discoverWorkflows(sorted);
  if (!workflows.has(defaultWorkflow)) throw new Error("the default workflow has no file");
  const list = creatorArtWorkflowsSchema.parse({
    workflows: [...workflows.keys()].map((id) => ({ id, name: workflowName(id) })),
  });
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
}: {
  bundledDir?: string;
  workflowsDir?: string | undefined;
  defaultWorkflow?: WorkflowId | undefined;
}): WorkflowRegistry {
  return createWorkflowRegistry({
    files: [
      ...readWorkflowFiles(bundledDir),
      ...(workflowsDir === undefined ? [] : readWorkflowFiles(workflowsDir)),
    ],
    defaultWorkflow,
  });
}
