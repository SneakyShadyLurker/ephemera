import { z } from "zod";
import { isRecord } from "../card/json.ts";
import { classTypeSchema, inputNameSchema } from "./graph.ts";

/*
 * Per-class facts a live ComfyUI's `/object_info` gives: which inputs are
 * widgets and of what kind, which are sockets, and which classes are output
 * nodes. Conversion and detection read them; an API import saved without a
 * reachable ComfyUI has none.
 */

export type InputKind = "INT" | "FLOAT" | "STRING" | "BOOLEAN" | "COMBO" | "LINK";

export interface InputMeta {
  kind: InputKind;
  /**
   * A widget the frontend follows with a `fixed` or `randomize` control, as
   * a seed's: an INT that asks for one, or is named `seed` or `noise_seed`
   * and does not refuse one; a combo that asks for one (and a filter list,
   * unless it is a multi-select).
   */
  controlAfterGenerate?: true;
  /** A combo the frontend shows as a multi-select. */
  multiSelect?: true;
  /** A combo's choices, in ComfyUI's order. */
  choices?: string[];
}

/**
 * A growing input: sockets a saved workflow names `<input>.<slot>`, as the
 * API format does, from the slot names or the prefix ComfyUI gives; or one
 * whose saved form the importer cannot read (a dynamic group, a template of
 * several inputs or of widgets).
 */
export type GrowingInput =
  | { kind: "sockets"; min: number; names?: string[]; prefix?: string }
  | { kind: "unreadable" };

export interface NodeMeta {
  outputNode: boolean;
  displayName?: string;
  /** Required inputs, then optional ones, each in ComfyUI's `input_order` (else as listed). */
  inputs: Record<string, InputMeta>;
  /** The required inputs' names, a growing input by its own name. */
  required?: string[];
  /** Growing inputs by name. */
  growing?: Record<string, GrowingInput>;
  /** Widgets only the UI has (an upload button), saved after the inputs' values. */
  uiOnlyWidgets?: number;
}
export type NodeMetaMap = ReadonlyMap<string, NodeMeta>;

/**
 * A record with only the keys `key` accepts. A user's ComfyUI may have node
 * packs whose class or input names the graph schemas refuse; those classes
 * can never be in an accepted graph, so they are left out instead of
 * failing the whole answer. Object.fromEntries keeps `__proto__` an own key.
 */
const keysOf = (key: z.ZodString) => (value: unknown) =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([name]) => key.safeParse(name).success))
    : value;

/** One input group: name -> `[type, options?]`, read leniently by `inputMeta`. */
const inputGroupSchema = z.preprocess(
  keysOf(inputNameSchema),
  z.record(inputNameSchema, z.unknown()),
);

/** A parsed `/object_info` answer, keeping only what `nodeMetaFrom` reads. */
export const objectInfoSchema = z.preprocess(
  keysOf(classTypeSchema),
  z.record(
    classTypeSchema,
    z.object({
      input: z
        .object({ required: inputGroupSchema.optional(), optional: inputGroupSchema.optional() })
        .catch({}),
      input_order: z
        .object({
          required: z.array(z.string()).optional(),
          optional: z.array(z.string()).optional(),
        })
        .optional()
        .catch(undefined),
      output_node: z.boolean().catch(false).optional(),
      display_name: z.string().max(256).optional().catch(undefined),
    }),
  ),
);
export type ObjectInfo = z.infer<typeof objectInfoSchema>;

const choicesOf = (values: unknown): string[] =>
  Array.isArray(values)
    ? values.flatMap((value) =>
        typeof value === "string" || typeof value === "number" ? [String(value)] : [],
      )
    : [];

/** The INT inputs the frontend gives a control unless the spec says otherwise. */
const SEED_NAMES: ReadonlySet<string> = new Set(["seed", "noise_seed"]);

/**
 * One input's kind from its spec. A combo is either its choices array or
 * `["COMBO", { options }]`; an input with `forceInput` is a socket; any type
 * that is not a widget type is a link. A control follows the frontend: a
 * truthy option, and for an INT an unset (or null) one defers to the name.
 */
function inputMeta(spec: unknown, name = ""): InputMeta | undefined {
  if (!Array.isArray(spec)) return undefined;
  const [type, options] = spec;
  const opts = isRecord(options) ? options : {};
  if (opts.forceInput === true) return { kind: "LINK" };
  const control = opts.control_after_generate;
  const controlled = (on: unknown) => (on ? ({ controlAfterGenerate: true } as const) : {});
  const multi = opts.multi_select ? ({ multiSelect: true } as const) : {};
  if (Array.isArray(type)) {
    return { kind: "COMBO", choices: choicesOf(type), ...controlled(control), ...multi };
  }
  if (type === "COMBO") {
    return { kind: "COMBO", choices: choicesOf(opts.options), ...controlled(control), ...multi };
  }
  if (type === "INT") return { kind: "INT", ...controlled(control ?? SEED_NAMES.has(name)) };
  if (type === "FLOAT" || type === "STRING" || type === "BOOLEAN") return { kind: type };
  return typeof type === "string" ? { kind: "LINK" } : undefined;
}

/** ComfyUI's cap on a dynamic group's rows. */
const DYNAMIC_GROUP_MAX_ROWS = 20;

/**
 * A dynamic group's inputs as a graph submits them, `<group>.<row>.<field>`
 * for each template field and row below its max; undefined for any other spec.
 */
function dynamicGroupSpecs(name: string, spec: unknown): [string, unknown][] | undefined {
  if (!Array.isArray(spec) || spec[0] !== "COMFY_DYNAMICGROUP_V3") return undefined;
  const opts: unknown = spec[1];
  const template = isRecord(opts) && isRecord(opts.template) ? opts.template : {};
  const fields = [template.required, template.optional].flatMap((group) =>
    isRecord(group) ? Object.entries(group) : [],
  );
  const max = isRecord(opts) && typeof opts.max === "number" ? opts.max : DYNAMIC_GROUP_MAX_ROWS;
  const rows = Math.max(0, Math.min(Math.floor(max), DYNAMIC_GROUP_MAX_ROWS));
  return Array.from({ length: rows }, (_, row) =>
    fields.map(([field, fieldSpec]): [string, unknown] => [`${name}.${row}.${field}`, fieldSpec]),
  ).flat();
}

/** A growing socket input's slots, or undefined for any other spec. */
function growingInput(spec: unknown): GrowingInput | undefined {
  if (!Array.isArray(spec)) return undefined;
  if (spec[0] === "COMFY_DYNAMICGROUP_V3") return { kind: "unreadable" };
  if (spec[0] !== "COMFY_AUTOGROW_V3") return undefined;
  const opts: unknown = spec[1];
  const template = isRecord(opts) && isRecord(opts.template) ? opts.template : {};
  const input = isRecord(template.input) ? template.input : {};
  const fields = [input.required, input.optional].flatMap((group) =>
    isRecord(group) ? Object.values(group) : [],
  );
  const [field] = fields;
  if (fields.length !== 1 || inputMeta(field)?.kind !== "LINK") return { kind: "unreadable" };
  const names = Array.isArray(template.names)
    ? template.names.filter((name): name is string => typeof name === "string")
    : undefined;
  const prefix = typeof template.prefix === "string" ? template.prefix : undefined;
  if (names === undefined && prefix === undefined) return { kind: "unreadable" };
  const min = typeof template.min === "number" ? Math.max(0, Math.floor(template.min)) : 0;
  return {
    kind: "sockets",
    min,
    ...(names === undefined ? {} : { names }),
    ...(prefix === undefined ? {} : { prefix }),
  };
}

/** An input whose widget the UI follows with an upload button it saves a value for. */
const hasUpload = (spec: unknown): boolean =>
  Array.isArray(spec) &&
  isRecord(spec[1]) &&
  Object.entries(spec[1]).some(([key, value]) => key.endsWith("_upload") && value === true);

/** A group's entries in `order` first, then the rest as listed. */
function ordered(group: Record<string, unknown> | undefined, order: string[] | undefined) {
  const entries = Object.entries(group ?? {});
  if (order === undefined) return entries;
  const rank = new Map(order.map((name, index) => [name, index]));
  const at = (name: string) => rank.get(name) ?? order.length;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => at(a.entry[0]) - at(b.entry[0]) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Each class's meta, from a parsed `/object_info` answer. */
export function nodeMetaFrom(objectInfo: ObjectInfo): NodeMetaMap {
  const meta = new Map<string, NodeMeta>();
  for (const [classType, info] of Object.entries(objectInfo)) {
    const inputs: Record<string, InputMeta> = {};
    const required: string[] = [];
    const growing: Record<string, GrowingInput> = {};
    let uiOnlyWidgets = 0;
    const groups = [
      ...ordered(info.input.required, info.input_order?.required).map(
        (entry): [string, unknown, boolean] => [...entry, true],
      ),
      ...ordered(info.input.optional, info.input_order?.optional).map(
        (entry): [string, unknown, boolean] => [...entry, false],
      ),
    ];
    for (const [name, spec, isRequired] of groups) {
      const grows = growingInput(spec);
      if (grows !== undefined) growing[name] = grows;
      if (hasUpload(spec)) uiOnlyWidgets++;
      const expanded = dynamicGroupSpecs(name, spec);
      if (expanded === undefined && isRequired && !required.includes(name)) required.push(name);
      for (const [inputName, inputSpec] of expanded ?? [[name, spec]]) {
        const input = inputMeta(inputSpec, inputName);
        if (input !== undefined && !Object.hasOwn(inputs, inputName)) inputs[inputName] = input;
      }
    }
    meta.set(classType, {
      outputNode: info.output_node === true,
      ...(info.display_name === undefined ? {} : { displayName: info.display_name }),
      inputs,
      required,
      ...(Object.keys(growing).length === 0 ? {} : { growing }),
      ...(uiOnlyWidgets === 0 ? {} : { uiOnlyWidgets }),
    });
  }
  return meta;
}
