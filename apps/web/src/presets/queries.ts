import {
  clipText,
  MAX_JSON_BYTES,
  PRESET_LIMITS,
  type PromptBlock,
  type PromptPreset,
  presetImportResponseSchema,
  promptPresetResponseSchema,
  promptPresetsResponseSchema,
  type SamplerPreset,
  type SamplerValues,
  type StoredPromptPreset,
  type StoredSamplerPreset,
  samplerPresetResponseSchema,
  samplerPresetsResponseSchema,
} from "@ephemera/core";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import type { z } from "zod";
import { createImportQueue, type FileImport, importFile, tooLargeImport } from "@/app/importing";
import { sentence } from "@/lib/text";
import { api, entityError, entityHref, entityRetry } from "../api.ts";
import { arrivals } from "../sheet/arrival.ts";
import {
  type CreateOutcome,
  createOutcome,
  creating,
  duplicating,
  removing,
  type SaveResult,
  saving,
} from "../sheet/saving.ts";

/*
 * Server data for prompt and sampler presets, in memory only like every
 * query. Preset text is untrusted and always rendered as text.
 */

export type PresetKind = "prompt" | "sampler";

type Stored<Kind extends PresetKind> = Kind extends "prompt"
  ? StoredPromptPreset
  : StoredSamplerPreset;
type Preset<Kind extends PresetKind> = Kind extends "prompt" ? PromptPreset : SamplerPreset;

const responseSchemas = {
  prompt: { list: promptPresetsResponseSchema, one: promptPresetResponseSchema },
  sampler: { list: samplerPresetsResponseSchema, one: samplerPresetResponseSchema },
} as const;

const routes = (kind: PresetKind) => (kind === "prompt" ? api.presets.prompt : api.presets.sampler);

const parseList = <Kind extends PresetKind>(kind: Kind, body: unknown): Stored<Kind>[] =>
  responseSchemas[kind].list.parse(body).presets as Stored<Kind>[];

const parseOne = <Kind extends PresetKind>(kind: Kind, body: unknown): Stored<Kind> =>
  responseSchemas[kind].one.parse(body).preset as Stored<Kind>;

export const presetsQuery = <Kind extends PresetKind>(kind: Kind) =>
  queryOptions({
    queryKey: ["presets", kind],
    queryFn: async ({ signal }): Promise<Stored<Kind>[]> => {
      const response = await routes(kind).$get(undefined, { init: { signal } });
      if (!response.ok) throw new Error("unavailable");
      return parseList(kind, await response.json());
    },
  });

export const presetQuery = <Kind extends PresetKind>(kind: Kind, id: string) =>
  queryOptions({
    queryKey: ["presets", kind, id],
    retry: entityRetry,
    queryFn: async ({ signal }): Promise<Stored<Kind>> => {
      const response = await routes(kind)[":id"].$get({ param: { id } }, { init: { signal } });
      if (!response.ok) throw entityError(response.status);
      return parseOne(kind, await response.json());
    },
  });

/** A download link's address for one independent native preset file. */
export function presetExportUrl(kind: PresetKind, id: string): string {
  return entityHref(routes(kind)[":id"].export, id);
}

/** A new preset of either kind, as one creation holds it (sheet/creation.ts). */
export type NewPreset =
  | { kind: "prompt"; preset: PromptPreset }
  | { kind: "sampler"; preset: SamplerPreset };

/**
 * Creates a preset under a client-chosen id, so a retry after a lost response
 * that passes the same id is harmless.
 */
export async function createPreset<Kind extends PresetKind>(
  kind: Kind,
  id: string,
  preset: Preset<Kind>,
): Promise<CreateOutcome> {
  const result = await creating((init) =>
    kind === "prompt"
      ? api.presets.prompt.$post({ json: { id, preset: preset as PromptPreset } }, { init })
      : api.presets.sampler.$post({ json: { id, preset: preset as SamplerPreset } }, { init }),
  );
  return createOutcome(id, result);
}

/** Saves edited fields against `revision`; the saved preset carries its new revision. */
export function savePromptPreset(
  id: string,
  patch: Partial<PromptPreset>,
  revision: number,
): Promise<SaveResult<StoredPromptPreset>> {
  return saving(
    (init) =>
      api.presets.prompt[":id"].$patch({ param: { id }, json: { ...patch, revision } }, { init }),
    async (response) => promptPresetResponseSchema.parse(await response.json()).preset,
  );
}

/** Saves edited fields against `revision`; the saved preset carries its new revision. */
export function saveSamplerPreset(
  id: string,
  patch: Partial<SamplerPreset>,
  revision: number,
): Promise<SaveResult<StoredSamplerPreset>> {
  return saving(
    (init) =>
      api.presets.sampler[":id"].$patch({ param: { id }, json: { ...patch, revision } }, { init }),
    async (response) => samplerPresetResponseSchema.parse(await response.json()).preset,
  );
}

/** Duplicates a preset: the copy's id, or why there is none. */
export function duplicatePreset(kind: PresetKind, id: string): Promise<CreateOutcome> {
  return duplicating((options) => routes(kind)[":id"].duplicate.$post({ param: { id } }, options));
}

/** Deletes a preset: the last one of a kind stays; an unreachable server fails. */
export async function deletePreset(
  kind: PresetKind,
  id: string,
): Promise<"removed" | "last" | "failed"> {
  let last = false;
  const removed = await removing(async (init) => {
    const response = await routes(kind)[":id"].$delete({ param: { id } }, init);
    last = response.status === 409;
    return response;
  });
  return last ? "last" : removed ? "removed" : "failed";
}

/** After any change: that kind's list and preset reload in the background. */
export function refreshPresets(
  queryClient: QueryClient,
  kind: PresetKind,
  id?: string,
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: presetsQuery(kind).queryKey, exact: true }),
    id === undefined
      ? undefined
      : queryClient.invalidateQueries({ queryKey: presetQuery(kind, id).queryKey }),
  ]).then(() => undefined);
}

/** "deepseek-v4-pro, temperature 0.9, up to 1,200 tokens"; Session leaves the model out. */
export function samplerSummary(values: SamplerValues, withModel = true): string {
  const parts = [
    withModel ? (values.model ?? "the chat's model") : null,
    values.temperature === null ? null : `temperature ${values.temperature}`,
    values.topP === null ? null : `top-p ${values.topP}`,
    values.maxOutputTokens === null
      ? null
      : `up to ${values.maxOutputTokens.toLocaleString("en")} tokens`,
    values.seed === null ? null : `seed ${values.seed}`,
    values.reasoning === "provider-default"
      ? null
      : `reasoning ${REASONING_LABELS[values.reasoning].toLowerCase()}`,
  ].filter((part): part is string => part !== null);
  if (parts.length === (withModel ? 1 : 0)) parts.push("nothing overridden");
  return sentence(parts.join(", "));
}

export const REASONING_LABELS: Record<SamplerValues["reasoning"], string> = {
  "provider-default": "Model default",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

/** "12 blocks, 10 on, 3 custom". */
export function promptSummary(blocks: PromptBlock[]): string {
  // The chat history is on unless a preset (an imported one) switched it off.
  const on = blocks.filter((block) =>
    block.kind === "chatHistory" ? block.enabled !== false : block.enabled,
  ).length;
  const custom = blocks.filter((block) => block.kind === "custom").length;
  return [
    `${blocks.length} blocks`,
    on === blocks.length ? "all on" : `${on} on`,
    custom > 0 ? `${custom} custom` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export type PresetImport = FileImport<z.infer<typeof presetImportResponseSchema>>;

/** Every refusal the import route can answer in words, so a new one fails the typecheck here. */
type ImportRefusal = InferResponseType<typeof api.presets.import.$post, 422>["error"];

const IMPORT_REASONS: Record<ImportRefusal, string> = {
  not_a_preset: "it isn't an Ephemera preset or a SillyTavern Chat Completion preset",
  too_large: "a prompt in it is longer than Ephemera allows",
};

/** A preset file's name without `.json`, as the new presets' name. */
function presetNameFromFile(fileName: string): string {
  const name = clipText(fileName.replace(/\.json$/i, "").trim(), PRESET_LIMITS.nameLength).trim();
  return name === "" ? "Imported preset" : name;
}

/**
 * Imports one native preset or a foreign Chat Completion preset pair. The file is untrusted: parsed as JSON here, validated
 * and mapped by the server (packages/core), never interpreted otherwise.
 */
export async function importPreset(file: File): Promise<PresetImport> {
  // The file goes inside a JSON body: past that body's ceiling, the server would refuse it.
  if (file.size > MAX_JSON_BYTES) return tooLargeImport(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { key: crypto.randomUUID(), ok: false, file: file.name, reason: "it isn't valid JSON" };
  }
  const name = presetNameFromFile(file.name);
  const promptId = crypto.randomUUID();
  const samplerId = crypto.randomUUID();
  return importFile(
    file,
    (init) =>
      api.presets.import.$post({ json: { promptId, samplerId, name, file: parsed } }, { init }),
    IMPORT_REASONS,
    (body) => presetImportResponseSchema.safeParse(body).data,
  );
}

/** The Presets screen's imports, one file at a time. */
export const presetImports = createImportQueue(importPreset);

/** What a preset sheet does on arrival: a new preset selects its name for typing. */
export const presetArrivals = arrivals<{ selectName: boolean }>();
