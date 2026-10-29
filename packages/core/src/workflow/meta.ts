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
  /** An INT whose widget carries a `fixed` or `randomize` control, as a seed does. */
  controlAfterGenerate?: true;
  /** A combo's choices, in ComfyUI's order. */
  choices?: string[];
}

export interface NodeMeta {
  outputNode: boolean;
  displayName?: string;
  /** Required inputs, then optional ones, each in ComfyUI's order. */
  inputs: Record<string, InputMeta>;
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

/**
 * One input's kind from its spec. A combo is either its choices array or
 * `["COMBO", { options }]`; an input with `forceInput` is a socket; any type
 * that is not a widget type is a link.
 */
function inputMeta(spec: unknown): InputMeta | undefined {
  if (!Array.isArray(spec)) return undefined;
  const [type, options] = spec;
  const opts = isRecord(options) ? options : {};
  if (opts.forceInput === true) return { kind: "LINK" };
  if (Array.isArray(type)) return { kind: "COMBO", choices: choicesOf(type) };
  if (type === "COMBO") return { kind: "COMBO", choices: choicesOf(opts.options) };
  if (type === "INT") {
    const control = opts.control_after_generate;
    return control !== undefined && control !== false
      ? { kind: "INT", controlAfterGenerate: true }
      : { kind: "INT" };
  }
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

/** Each class's meta, from a parsed `/object_info` answer. */
export function nodeMetaFrom(objectInfo: ObjectInfo): NodeMetaMap {
  const meta = new Map<string, NodeMeta>();
  for (const [classType, info] of Object.entries(objectInfo)) {
    const inputs: Record<string, InputMeta> = {};
    for (const [name, spec] of [
      ...Object.entries(info.input.required ?? {}),
      ...Object.entries(info.input.optional ?? {}),
    ].flatMap(
      ([name, spec]): [string, unknown][] => dynamicGroupSpecs(name, spec) ?? [[name, spec]],
    )) {
      const input = inputMeta(spec);
      if (input !== undefined && !Object.hasOwn(inputs, name)) inputs[name] = input;
    }
    meta.set(classType, {
      outputNode: info.output_node === true,
      ...(info.display_name === undefined ? {} : { displayName: info.display_name }),
      inputs,
    });
  }
  return meta;
}
