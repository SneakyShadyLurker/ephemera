import { z } from "zod";
import { modelIdSchema } from "./chat.ts";
import { REASONING_EFFORTS, type ReasoningEffort } from "./preset/sampler.ts";
import type { Settings } from "./settings.ts";

/*
 * Per-model limits from the upstream's model catalog (`/models`), the only
 * owner of a model's context window. Providers report the same facts under
 * different field names; each is read where a provider documents it. The
 * catalog is untrusted input: unknown fields are ignored and a malformed
 * value reads as "not reported".
 */

/** The efforts the AI SDK can send; "provider-default" sends nothing. */
type SentEffort = Exclude<ReasoningEffort, "provider-default">;
const SENT_EFFORTS = REASONING_EFFORTS.filter(
  (effort): effort is SentEffort => effort !== "provider-default",
);

export const modelInfoSchema = z.strictObject({
  id: modelIdSchema,
  /** Tokens; null when the provider reports none. */
  contextWindow: z.number().int().positive().nullable(),
  /** The efforts the model offers that Ephemera can send; null when not reported. */
  reasoning: z.array(z.enum(SENT_EFFORTS)).nullable(),
  /** Whether the model reads images; null when not reported. */
  images: z.boolean().nullable(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

/** Far past any real catalog; a longer one is refused as invalid. */
const MAX_CATALOG_MODELS = 2_000;
const entriesSchema = z.array(z.unknown()).max(MAX_CATALOG_MODELS);
/**
 * A rich catalog (`{models:[{slug}]}`), the standard OpenAI list
 * (`{object:"list",data:[{id}]}`) or a bare array of `{id}` entries; the rich
 * one wins when a body has both.
 */
const catalogSchema = z.union([
  z
    .looseObject({ models: entriesSchema })
    .transform(({ models }) => ({ key: "slug" as const, models })),
  z
    .looseObject({ data: entriesSchema })
    .transform(({ data }) => ({ key: "id" as const, models: data })),
  entriesSchema.transform((models) => ({ key: "id" as const, models })),
]);

/** A field read only when well formed; anything else reads as not reported. */
const reported = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const nested = <S extends z.ZodRawShape>(shape: S) => reported(z.looseObject(shape));
const windowField = reported(z.number().int().positive());
const stringsField = reported(z.array(z.string()));

/**
 * The fields an entry may report beside its id, in the shapes providers
 * document; the order they are read in is below. `meta.n_ctx_train` is
 * deliberately not read: it is a training context, not the serving limit,
 * and a wrong window fails replies where an unknown one asks the owner.
 */
const reportedShape = {
  context_window: windowField,
  max_model_len: windowField,
  context_length: windowField,
  max_context_length: windowField,
  top_provider: nested({ context_length: windowField }),
  metadata: nested({ context_length: windowField, tags: stringsField }),
  /** What a model reads, such as `["text", "image"]`. */
  input_modalities: stringsField,
  architecture: nested({ input_modalities: stringsField }),
  capabilities: nested({
    vision: reported(z.boolean()),
    reasoning: reported(z.boolean()),
    reasoning_effort: stringsField,
  }),
  supported_reasoning_levels: reported(
    z
      .array(z.looseObject({ effort: z.string() }))
      .transform((levels) => levels.map((level) => level.effort)),
  ),
  effort: nested({ supported_levels: stringsField }),
  reasoning: nested({ supported_efforts: stringsField }),
  reasoning_efforts: stringsField,
  /** "hide" marks a model the catalog keeps out of lists (image models). */
  visibility: z.unknown().optional(),
};
/** One entry per envelope; a malformed one is skipped, so it cannot take the other models with it. */
const entrySchemas = {
  slug: z
    .looseObject({ slug: modelIdSchema, ...reportedShape })
    .transform(({ slug, ...entry }) => ({ ...entry, id: slug })),
  id: z.looseObject({ id: modelIdSchema, ...reportedShape }),
};
type Entry = z.infer<(typeof entrySchemas)["id"]>;

/** The first window reported. */
function windowOf(entry: Entry): number | null {
  return (
    entry.context_window ??
    entry.max_model_len ??
    entry.context_length ??
    entry.max_context_length ??
    entry.top_provider?.context_length ??
    entry.metadata?.context_length ??
    null
  );
}

/** Image input from the modalities, else a vision flag, else a "vision" tag (which only says yes). */
function imagesOf(entry: Entry): boolean | null {
  const modalities = entry.input_modalities ?? entry.architecture?.input_modalities;
  if (modalities !== undefined) return modalities.includes("image");
  if (entry.capabilities?.vision !== undefined) return entry.capabilities.vision;
  return entry.metadata?.tags?.includes("vision") === true ? true : null;
}

/**
 * The listed efforts Ephemera can send; none when the model says it does not
 * reason. A bare "reasons" flag lists no efforts, so it leaves them unknown.
 */
function reasoningOf(entry: Entry): SentEffort[] | null {
  const listed =
    entry.supported_reasoning_levels ??
    entry.effort?.supported_levels ??
    entry.reasoning?.supported_efforts ??
    entry.reasoning_efforts ??
    entry.capabilities?.reasoning_effort ??
    (entry.capabilities?.reasoning === false ? [] : undefined);
  return listed === undefined ? null : SENT_EFFORTS.filter((effort) => listed.includes(effort));
}

/**
 * The listed models in a catalog response, sorted by id; hidden entries are
 * left out and the first entry of an id wins. Undefined when it is not a
 * catalog.
 */
export function modelsFromCatalog(body: unknown): ModelInfo[] | undefined {
  const parsed = catalogSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const entrySchema = entrySchemas[parsed.data.key];
  const byId = new Map<string, ModelInfo>();
  for (const raw of parsed.data.models) {
    const valid = entrySchema.safeParse(raw);
    if (!valid.success) continue;
    const entry = valid.data;
    if (entry.visibility === "hide" || byId.has(entry.id)) continue;
    byId.set(entry.id, {
      id: entry.id,
      contextWindow: windowOf(entry),
      reasoning: reasoningOf(entry),
      images: imagesOf(entry),
    });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A model's catalog entry by id; undefined without a catalog or when it lists no such model. */
export function modelInfo(
  models: readonly ModelInfo[] | undefined,
  id: string,
): ModelInfo | undefined {
  return models?.find((model) => model.id === id);
}

/**
 * The reasoning choices for a model: the model default, then what it offers.
 * Unreported support (or an unknown model) offers every effort.
 */
export function offeredEfforts(model: ModelInfo | undefined): ReasoningEffort[] {
  return ["provider-default", ...(model?.reasoning ?? SENT_EFFORTS)];
}

/** The effort sent for `chosen` with `model`: the chosen one when offered, else the model default. */
export function effortFor(model: ModelInfo | undefined, chosen: ReasoningEffort): ReasoningEffort {
  return offeredEfforts(model).includes(chosen) ? chosen : "provider-default";
}

/** Bounds of a context window the owner sets for a model the provider reports none for. */
export const CONTEXT_WINDOW_RANGE = { min: 1_024, max: 10_000_000, step: 1_024 } as const;
const MAX_PER_MODEL_ENTRIES = 500;

/** An owner-set value per model id, for at most `MAX_PER_MODEL_ENTRIES` models. */
export const perModel = <T extends z.ZodType>(value: T, what: string) =>
  z
    .record(modelIdSchema, value)
    .refine((values) => Object.keys(values).length <= MAX_PER_MODEL_ENTRIES, `too many ${what}`);

const windowSize = z.number().int().min(CONTEXT_WINDOW_RANGE.min).max(CONTEXT_WINDOW_RANGE.max);

/** Owner-set windows by model id; used only where the catalog reports none. */
export const contextWindowsSchema = perModel(windowSize, "context windows");
export type ContextWindows = z.infer<typeof contextWindowsSchema>;

/** The most a prompt uses of any model's window unless the owner sets another limit for it. */
export const DEFAULT_CONTEXT_LIMIT = 131_072;

/**
 * Owner-set limits by model id: the most of the model's window a prompt may
 * use. A Settings value, never a preset value: an imported preset's
 * `openai_max_context` stays ignored.
 */
export const contextLimitsSchema = perModel(windowSize, "context limits");
export type ContextLimits = z.infer<typeof contextLimitsSchema>;

const tokenCount = z.number().int().min(0);

export const effectiveWindowSchema = z.strictObject({
  /** What a prompt is fitted to: the model's window, capped by the owner's limit. */
  tokens: tokenCount,
  /** "catalog": reported by the provider's catalog; "owner": set in Settings because none is reported. */
  source: z.enum(["catalog", "owner"]),
  /** The model's own window, before the limit. */
  model: tokenCount,
  /** The limit that reduced the window: the owner's, the default, or none. */
  limit: z.enum(["owner", "default"]).nullable(),
});
export type EffectiveWindow = z.infer<typeof effectiveWindowSchema>;

/**
 * The window a prompt is fitted to: the model's (the catalog's, else the
 * owner's for this model) capped by the owner's limit for it, else
 * `DEFAULT_CONTEXT_LIMIT`. Null without a model window, whatever the limit:
 * never a guessed budget (PRODUCT.md § Models). The only place the two meet.
 */
export function effectiveWindow(
  modelId: string,
  catalog: ModelInfo[] | undefined,
  settings: Pick<Settings, "contextWindows" | "contextLimits">,
): EffectiveWindow | null {
  const reported = modelInfo(catalog, modelId)?.contextWindow ?? null;
  // Own keys only: an id such as "constructor" must not read an inherited property.
  const { contextWindows, contextLimits } = settings;
  const owner = Object.hasOwn(contextWindows, modelId) ? contextWindows[modelId] : undefined;
  const modelWindow = reported ?? owner;
  if (modelWindow === undefined) return null;
  const stored = Object.hasOwn(contextLimits, modelId) ? contextLimits[modelId] : undefined;
  const limit = stored ?? DEFAULT_CONTEXT_LIMIT;
  // Clamped here too: a stored limit above a window that later shrank still holds.
  return {
    tokens: Math.min(modelWindow, limit),
    source: reported === null ? "owner" : "catalog",
    model: modelWindow,
    limit: limit >= modelWindow ? null : stored === undefined ? "default" : "owner",
  };
}
