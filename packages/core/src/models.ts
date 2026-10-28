import { z } from "zod";
import { modelIdSchema } from "./chat.ts";
import { REASONING_EFFORTS, type ReasoningEffort } from "./preset/sampler.ts";
import type { Settings } from "./settings.ts";

/*
 * Per-model limits from the upstream's model catalog: CLIProxyAPI's
 * (`/v1/models?client_version=`) or the standard `/v1/models` list, the only
 * owner of a model's context window. The catalog is untrusted input:
 * unknown fields are ignored and a malformed value reads as "not reported".
 */

/** The efforts the AI SDK can send; "provider-default" sends nothing. */
type SentEffort = Exclude<ReasoningEffort, "provider-default">;
const SENT_EFFORTS = REASONING_EFFORTS.filter(
  (effort): effort is SentEffort => effort !== "provider-default",
);

export const modelInfoSchema = z.strictObject({
  id: modelIdSchema,
  /** Tokens; null when CLIProxyAPI reports none. */
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
 * CLIProxyAPI's rich catalog (`{models:[{slug}]}`) or the standard OpenAI
 * list (`{object:"list",data:[{id}]}`); the rich one wins when a body has both.
 */
const catalogSchema = z.union([
  z
    .looseObject({ models: entriesSchema })
    .transform(({ models }) => ({ key: "slug" as const, models })),
  z
    .looseObject({ data: entriesSchema })
    .transform(({ data }) => ({ key: "id" as const, models: data })),
]);
/** The fields an entry may report beside its id; each is read only when well formed. */
const reportedShape = {
  context_window: z.unknown().optional(),
  supported_reasoning_levels: z.unknown().optional(),
  /** Codex-format catalogs list what a model reads, such as `["text", "image"]`. */
  input_modalities: z.unknown().optional(),
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

const windowSchema = z.number().int().positive();
const levelsSchema = z.array(z.looseObject({ effort: z.string() }));
const modalitiesSchema = z.array(z.string());

/**
 * The listed models in a catalog response, sorted by id; hidden entries are
 * left out and the first entry of an id wins. A standard list reports no
 * window, efforts or image support unless an entry carries the rich fields.
 * Undefined when it is not a catalog.
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
    const window = windowSchema.safeParse(entry.context_window);
    const levels = levelsSchema.safeParse(entry.supported_reasoning_levels);
    const reported = new Set(levels.success ? levels.data.map((level) => level.effort) : []);
    const modalities = modalitiesSchema.safeParse(entry.input_modalities);
    byId.set(entry.id, {
      id: entry.id,
      contextWindow: window.success ? window.data : null,
      reasoning: levels.success ? SENT_EFFORTS.filter((effort) => reported.has(effort)) : null,
      images: modalities.success ? modalities.data.includes("image") : null,
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

/** Bounds of a context window the owner sets for a model CLIProxyAPI reports none for. */
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
  /** "catalog": reported by CLIProxyAPI; "owner": set in Settings because none is reported. */
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
