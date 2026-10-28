import { z } from "zod";
import { fitsNativeFile, isNativeFileAttempt } from "../file-format.ts";
import { normalizeExampleDialogue, normalizeMacroAliases } from "../imports/aliases.ts";
import { importedNoteDepth, importedNoteRole } from "../imports/character-note.ts";
import { stripDecorators } from "../imports/decorators.ts";
import { ignoredFeatureList } from "../imports/foreign-features.ts";
import { convertForeignEntrySettings } from "../imports/lorebook-settings.ts";
import { characterFileSchema, lorebookFileSchema } from "../native-files.ts";
import { utf8Bytes } from "../tokens.ts";
import { finiteNumber, isJsonObject, isRecord } from "./json.ts";
import { clipText, CARD_LIMITS as L, textLength } from "./limits.ts";
import {
  blankCard,
  type CharacterCard,
  characterCardSchema,
  isCardTooLarge,
  type Lorebook,
  lorebookSchema,
  storedCharacterCardSchema,
  storedLorebookDataSchema,
} from "./schema.ts";
import { uniqueTags } from "./tags.ts";

/** Imports V2/V3 cards into native data. Recognized foreign settings are converted once; unknown extensions and transport metadata are discarded. Flat V1 files are retired. */

export type CardImportError =
  | "not_json"
  | "not_a_card"
  | "too_large"
  | "no_name"
  | "field_too_long"
  | "invalid";

/**
 * What an import left out or shortened to fit Ephemera's limits rather than
 * refuse the card: lorebook keywords past the keyword limits, entry names
 * and tags past their length. The import report names them.
 */
const CARD_TRIMS = ["keywords", "entry_names", "tags"] as const;
type CardTrim = (typeof CARD_TRIMS)[number];

const TRIM_SENTENCES: Record<CardTrim, string> = {
  keywords: "Some lorebook keywords were left out to fit the keyword limits.",
  entry_names: "Some lorebook entry names were shortened to fit the name limit.",
  tags: "Some tags were shortened or left out to fit the tag limits.",
};

/** Names in the report what was fitted to the limits. */
function reportTrims(trimmed: ReadonlySet<CardTrim>, report: ConversionReport): void {
  for (const trim of CARD_TRIMS) if (trimmed.has(trim)) report.changed.push(TRIM_SENTENCES[trim]);
}

export type CardImportResult =
  | {
      ok: true;
      card: CharacterCard;
      version: 1 | 2 | 3;
      report: ConversionReport;
    }
  | { ok: false; error: CardImportError; field?: string };

const toText = (value: unknown) =>
  value === null || value === undefined
    ? ""
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value;

const toList = (value: unknown) =>
  value === null || value === undefined
    ? []
    : typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item) => typeof item === "string" || typeof item === "number").map(String)
        : value;

const toOptionalBoolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);

/** Missing or non-object extensions become empty; an object must be valid JSON within the depth limit. */
const toExtensions = (value: unknown) => (isRecord(value) ? value : {});

const text = (max: number = L.textLength) => z.preprocess(toText, z.string().max(max));
const list = (maxItems: number, maxLength: number = L.textLength) =>
  z.preprocess(toList, z.array(z.string().max(maxLength)).max(maxItems));
const optionalText = (max: number = L.textLength) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value : undefined),
    z.string().max(max).optional(),
  );
const optionalNumber = z.preprocess(finiteNumber, z.number().optional());
const optionalBoolean = z.preprocess(toOptionalBoolean, z.boolean().optional());
const extensions = z.preprocess(
  toExtensions,
  z.custom<import("./json.ts").JsonObject>(isJsonObject),
);

const looseEntry = z.object({
  keys: list(L.tags, L.shortTextLength),
  content: text(),
  extensions,
  enabled: z.preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean()),
  insertion_order: z.preprocess((value) => finiteNumber(value) ?? 0, z.number()),
  case_sensitive: optionalBoolean,
  use_regex: z.preprocess((value) => value === true, z.boolean()),
  constant: optionalBoolean,
  name: optionalText(L.shortTextLength),
  priority: optionalNumber,
  id: z.preprocess(
    (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? value
        : typeof value === "string"
          ? value
          : undefined,
    z.union([z.number(), z.string().max(L.shortTextLength)]).optional(),
  ),
  comment: optionalText(),
  selective: optionalBoolean,
  secondary_keys: z.preprocess(
    (value) => (value === undefined || value === null ? undefined : toList(value)),
    z.array(z.string().max(L.shortTextLength)).max(L.tags).optional(),
  ),
  position: z.preprocess(
    (value) => (value === "before_char" || value === "after_char" ? value : undefined),
    z.enum(["before_char", "after_char"]).optional(),
  ),
});

const looseLorebook = z.object({
  name: optionalText(L.shortTextLength),
  description: optionalText(),
  scan_depth: optionalNumber,
  token_budget: optionalNumber,
  recursive_scanning: optionalBoolean,
  extensions,
  entries: z.preprocess(
    (value) => (Array.isArray(value) ? value.filter(isRecord) : []),
    z.array(looseEntry).max(L.lorebookEntries),
  ),
});

const looseAsset = z.object({
  type: z.string().max(L.shortTextLength),
  uri: z.string().max(L.textLength),
  name: z.string().max(L.shortTextLength),
  ext: z.string().max(L.shortTextLength),
});

const looseData = z.object({
  name: text(L.nameLength),
  nickname: text(L.shortTextLength),
  description: text(),
  personality: text(),
  scenario: text(),
  first_mes: text(),
  alternate_greetings: list(L.alternateGreetings),
  mes_example: text(),
  system_prompt: text(),
  post_history_instructions: text(),
  creator_notes: text(),
  tags: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : toList(value),
    z.array(z.string().max(L.tagLength)).max(L.tags),
  ),
  creator: text(L.shortTextLength),
  character_version: text(L.shortTextLength),
  extensions,
  character_book: z.preprocess(
    (value) => (isRecord(value) ? value : undefined),
    looseLorebook.optional(),
  ),
  assets: z.array(looseAsset).max(L.assets).optional(),
  creator_notes_multilingual: z.preprocess(
    (value) =>
      isRecord(value)
        ? Object.fromEntries(Object.entries(value).filter(([, note]) => typeof note === "string"))
        : undefined,
    z.record(z.string().max(L.shortTextLength), z.string().max(L.textLength)).optional(),
  ),
  source: z.preprocess(
    (value) => (value === undefined || value === null ? undefined : toList(value)),
    z.array(z.string().max(L.textLength)).max(L.sources).optional(),
  ),
  group_only_greetings: list(L.alternateGreetings),
  creation_date: optionalNumber,
  modification_date: optionalNumber,
});

/** A keyword list within the limits: overlong keywords left out, then the first `L.tags`. */
function fitKeywords(value: unknown, trimmed: Set<CardTrim>): unknown {
  const list = toList(value);
  if (!Array.isArray(list)) return value;
  const kept = list.filter((key) => textLength(key) <= L.shortTextLength).slice(0, L.tags);
  if (kept.length < list.length) trimmed.add("keywords");
  return kept;
}

/**
 * Real cards carry lorebook keywords (long regex alternations), entry names
 * and tags past Ephemera's limits; one of them should not cost the whole
 * card. They are fitted here, before validation, and reported.
 */
function fitLists(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  trimmed: Set<CardTrim>;
} {
  const trimmed = new Set<CardTrim>();
  const fitted = { ...data };
  // The same coercion as the schema's: numbers become text, a string is a comma list.
  const tags = typeof data.tags === "string" ? data.tags.split(",") : toList(data.tags);
  if (Array.isArray(tags)) {
    const kept = uniqueTags(
      tags
        .map((tag) => String(tag).trim())
        .filter(Boolean)
        .map((tag) => {
          if (textLength(tag) <= L.tagLength) return tag;
          trimmed.add("tags");
          return clipText(tag, L.tagLength).trim();
        }),
    );
    if (kept.length > L.tags) trimmed.add("tags");
    fitted.tags = kept.slice(0, L.tags);
  }
  const book = data.character_book;
  if (isRecord(book)) fitted.character_book = fitBook(book, trimmed);
  return { data: fitted, trimmed };
}

/** A lorebook's entries with their keywords and names fitted to the limits. */
function fitBook(book: Record<string, unknown>, trimmed: Set<CardTrim>): Record<string, unknown> {
  if (!Array.isArray(book.entries)) return book;
  return {
    ...book,
    entries: book.entries.map((entry) => {
      if (!isRecord(entry)) return entry;
      const next: Record<string, unknown> = { ...entry, keys: fitKeywords(entry.keys, trimmed) };
      if (entry.secondary_keys !== undefined && entry.secondary_keys !== null) {
        next.secondary_keys = fitKeywords(entry.secondary_keys, trimmed);
      }
      if (typeof entry.name === "string" && textLength(entry.name) > L.shortTextLength) {
        next.name = clipText(entry.name, L.shortTextLength);
        trimmed.add("entry_names");
      }
      return next;
    }),
  };
}

/** Drops keys whose value is undefined, so optional fields are absent rather than undefined. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** A loosely parsed lorebook with its absent optional fields left out. */
function tidyBook(book: z.infer<typeof looseLorebook>) {
  return withoutUndefined({
    ...book,
    entries: book.entries.map((entry) => withoutUndefined(entry)),
  });
}

function versionOf(value: unknown): { data: unknown; version: 2 | 3 } | undefined {
  if (!isRecord(value)) return undefined;
  if (value.spec === "chara_card_v3" && isRecord(value.data))
    return { data: value.data, version: 3 };
  if (value.spec === "chara_card_v2" && isRecord(value.data))
    return { data: value.data, version: 2 };
  return undefined;
}

/**
 * A validation path named by the schema only: record keys come from the card
 * (untrusted, up to the card's size), so any segment that is not an index or
 * a field-like name is replaced.
 */
const schemaPath = (path: PropertyKey[]) =>
  path
    .map((segment) =>
      typeof segment === "number" || /^[a-z][a-z0-9_]{0,63}$/.test(String(segment))
        ? String(segment)
        : "*",
    )
    .join(".");

/** A failed parse as an import error, named by its first issue's field; `tooBig` tells an over-long field apart. */
function importFailure(
  error: z.ZodError,
  tooBig: boolean,
): { ok: false; error: "field_too_long" | "invalid"; field?: string } {
  const issue = error.issues[0];
  const field = issue === undefined ? undefined : schemaPath(issue.path);
  const code = tooBig && issue?.code === "too_big" ? "field_too_long" : "invalid";
  return field ? { ok: false, error: code, field } : { ok: false, error: code };
}

/** Normalizes a parsed card of any supported version to the canonical form. */
export function normalizeCard(value: unknown): CardImportResult {
  if (isNativeFileAttempt(value)) {
    const native = characterFileSchema.safeParse(value);
    return native.success
      ? {
          ok: true,
          card: native.data.data,
          version: 1,
          report: emptyConversionReport(),
        }
      : { ok: false, error: "invalid" };
  }
  const found = versionOf(value);
  if (found === undefined || !isRecord(found.data)) return { ok: false, error: "not_a_card" };
  const fitted = fitLists(found.data);
  const parsed = looseData.safeParse(fitted.data);
  if (!parsed.success) return importFailure(parsed.error, true);
  const data = parsed.data;
  if (data.name.trim() === "") return { ok: false, error: "no_name" };
  const report = emptyConversionReport();
  const card = convertForeignCard(data, report);
  const canonical = characterCardSchema.safeParse(card);
  if (!canonical.success) {
    if (isCardTooLarge(canonical.error)) return { ok: false, error: "too_large" };
    return importFailure(canonical.error, false);
  }
  reportTrims(fitted.trimmed, report);
  return { ok: true, card: canonical.data, version: found.version, report };
}

export type LorebookImportError = "too_large" | "field_too_long" | "invalid";

export type LorebookImportResult =
  | { ok: true; book: Lorebook; report: ConversionReport }
  | { ok: false; error: LorebookImportError; field?: string };

/**
 * Normalizes a lorebook in the card's `character_book` shape, read as a
 * card's embedded book is: the same coercions, fitted lists and limits. A
 * standalone book past its size limit (`fitsNativeFile`) is too large.
 */
export function normalizeLorebook(value: Record<string, unknown>): LorebookImportResult {
  if (isNativeFileAttempt(value)) {
    const native = lorebookFileSchema.safeParse(value);
    return native.success
      ? { ok: true, book: native.data.data, report: emptyConversionReport() }
      : { ok: false, error: "invalid" };
  }
  const trimmed = new Set<CardTrim>();
  const parsed = looseLorebook.safeParse(fitBook(value, trimmed));
  if (!parsed.success) return importFailure(parsed.error, true);
  const report = emptyConversionReport();
  const canonical = lorebookSchema.safeParse(convertForeignBook(tidyBook(parsed.data), report));
  if (!canonical.success) return importFailure(canonical.error, false);
  if (!fitsNativeFile("ephemera.lorebook", canonical.data))
    return { ok: false, error: "too_large" };
  reportTrims(trimmed, report);
  return { ok: true, book: canonical.data, report };
}

/**
 * Parses card JSON text (a JSON file, or a PNG chunk already decoded to text).
 * The bound counts UTF-8 bytes, including the version envelope.
 */
export function parseCardText(text: string): CardImportResult {
  if (utf8Bytes(text) > L.cardJsonBytes) {
    return { ok: false, error: "too_large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ok: false, error: "not_json" };
  }
  return normalizeCard(value);
}

/** Content-free import and migration diagnostics. No untrusted text is interpolated. */
export interface ConversionReport {
  kept: string[];
  changed: string[];
  skipped: string[];
}
export const emptyConversionReport = (): ConversionReport => ({
  kept: [],
  changed: [],
  skipped: [],
});

function convertForeignBook(
  book: z.infer<typeof looseLorebook>,
  report: ConversionReport,
): Lorebook {
  for (const feature of ignoredFeatureList(book)) {
    if (feature === "recursionLevel")
      report.changed.push("Higher recursion delay levels became recursive-only activation.");
    else report.skipped.push(`Unsupported lorebook feature omitted: ${feature}.`);
  }
  const entries = book.entries.map((entry) => {
    const { settings: converted, outlet } = convertForeignEntrySettings(entry);
    const { secondaryKeys, ...settings } = converted;
    const content = stripDecorators(entry.content);
    if (outlet)
      report.changed.push("An unsupported outlet entry was disabled; its text was retained.");
    return withoutUndefined({
      keys: entry.keys.map(normalizeMacroAliases),
      content:
        settings.placement === "examplesTop" || settings.placement === "examplesBottom"
          ? normalizeExampleDialogue(content)
          : normalizeMacroAliases(content),
      enabled: outlet ? false : entry.enabled,
      insertionOrder: entry.insertion_order,
      useRegex: entry.use_regex,
      constant: entry.constant,
      name: entry.name,
      id: entry.id,
      comment: entry.comment,
      selective: entry.selective,
      ...(secondaryKeys ? { secondaryKeys: secondaryKeys.map(normalizeMacroAliases) } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
    });
  });
  return withoutUndefined({
    name: book.name,
    description: book.description,
    scanDepth: book.scan_depth,
    tokenBudget: book.token_budget,
    recursiveScanning: book.recursive_scanning,
    entries,
  });
}

function convertForeignCard(
  data: z.infer<typeof looseData>,
  report: ConversionReport,
): CharacterCard {
  const note = data.extensions.depth_prompt;
  const noteData =
    isRecord(note) && typeof note.prompt === "string"
      ? {
          prompt: normalizeMacroAliases(note.prompt),
          depth: importedNoteDepth(note.depth),
          role: importedNoteRole(note.role),
        }
      : undefined;
  if (Object.keys(data.extensions).some((key) => key !== "depth_prompt"))
    report.skipped.push("Unsupported character extensions were omitted.");
  if (
    data.assets?.length ||
    data.source?.length ||
    data.group_only_greetings.length ||
    data.creator_notes_multilingual ||
    data.creation_date !== undefined ||
    data.modification_date !== undefined
  )
    report.skipped.push("Unused character transport metadata was omitted.");
  return {
    ...blankCard(data.name.trim()),
    nickname: data.nickname,
    description: normalizeMacroAliases(data.description),
    personality: normalizeMacroAliases(data.personality),
    scenario: normalizeMacroAliases(data.scenario),
    firstMessage: normalizeMacroAliases(data.first_mes),
    alternateGreetings: data.alternate_greetings.map(normalizeMacroAliases),
    exampleDialogue: normalizeExampleDialogue(data.mes_example),
    systemPrompt: normalizeMacroAliases(data.system_prompt),
    postHistoryInstructions: normalizeMacroAliases(data.post_history_instructions),
    creatorNotes: data.creator_notes,
    creator: data.creator,
    characterVersion: data.character_version,
    tags: uniqueTags(data.tags.map((tag) => tag.trim()).filter(Boolean)),
    ...(noteData ? { characterNote: noteData } : {}),
    ...(data.character_book ? { lorebook: convertForeignBook(data.character_book, report) } : {}),
  };
}

/** Raw old persisted card data, without the public file byte refinement. Throws on invalid data. */
export function upgradeLegacyCharacterCard(value: unknown): CharacterCard {
  const native = storedCharacterCardSchema.safeParse(value);
  if (native.success) return native.data;
  return storedCharacterCardSchema.parse(
    convertForeignCard(looseData.parse(value), emptyConversionReport()),
  );
}

/** Raw old persisted book data, without fitting/truncation or public file byte refinement. */
export function upgradeLegacyLorebook(value: unknown): Lorebook {
  const native = storedLorebookDataSchema.safeParse(value);
  if (native.success) return native.data;
  return storedLorebookDataSchema.parse(
    convertForeignBook(looseLorebook.parse(value), emptyConversionReport()),
  );
}
