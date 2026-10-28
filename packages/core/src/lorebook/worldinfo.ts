import { type LorebookImportError, normalizeLorebook } from "../card/import.ts";
import { finiteNumber, isRecord } from "../card/json.ts";
import { CARD_LIMITS as L } from "../card/limits.ts";
import type { Lorebook } from "../card/schema.ts";
import { isNativeFileAttempt } from "../file-format.ts";
import { POSITION_CODES, SILLYTAVERN_ENTRY_KEYS } from "../imports/lorebook-settings.ts";
import { lorebookFileSchema } from "../native-files.ts";

/** Import-only World Info adapter. Foreign entry fields are translated before the shared card-book converter validates native output. */

const isSettingField = (field: string): field is keyof typeof SILLYTAVERN_ENTRY_KEYS =>
  Object.hasOwn(SILLYTAVERN_ENTRY_KEYS, field);

/** Recognized foreign entry fields, converted or reported at the import boundary. */
const ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "uid",
  "key",
  "keysecondary",
  "comment",
  "content",
  "constant",
  "selective",
  "order",
  "disable",
  "name",
  "priority",
  "use_regex",
  "case_sensitive",
  "id",
  "extensions",
]);

/** Recognized top-level book fields in foreign input. */
export const BOOK_FIELDS = [
  "name",
  "description",
  "scan_depth",
  "token_budget",
  "recursive_scanning",
  "extensions",
] as const;
type WorldInfoBookField = (typeof BOOK_FIELDS)[number];

export type WorldInfoImportError = "not_a_lorebook" | LorebookImportError;

type WorldInfoImportResult =
  | {
      ok: true;
      book: Lorebook;
      /** A World Info file, or a card's `character_book` on its own. */
      format: "native" | "worldInfo" | "characterBook";
      report: import("../card/import.ts").ConversionReport;
      /** Book fields the file did not give (or gave unreadable), so their defaults apply. */
      defaulted: WorldInfoBookField[];
    }
  | { ok: false; error: WorldInfoImportError; field?: string };

/** A World Info entry has SillyTavern's `key` where a card entry has `keys`. */
const isWorldInfoEntry = (entry: Record<string, unknown>) =>
  !Object.hasOwn(entry, "keys") && Object.hasOwn(entry, "key");

/**
 * A World Info entry as a card entry, still loose: the card importer
 * coerces and bounds it. Extensions are the entry's own `extensions`, then
 * its unnamed fields, then its settings, later ones winning.
 */
function cardEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const extensions: [string, unknown][] = [];
  // Appended one at a time: a spread of a very wide object overflows the call stack.
  if (isRecord(entry.extensions)) {
    for (const pair of Object.entries(entry.extensions)) extensions.push(pair);
  }
  const settings: [string, unknown][] = [];
  for (const [field, value] of Object.entries(entry)) {
    // The position's extension is a code; the spec's two positions are not.
    if (field === "position") {
      if (finiteNumber(value) !== undefined) settings.push(["position", finiteNumber(value)]);
    } else if (isSettingField(field)) settings.push([SILLYTAVERN_ENTRY_KEYS[field], value]);
    else if (!ENTRY_FIELDS.has(field)) extensions.push([field, value]);
  }
  const { position, caseSensitive } = entry;
  return {
    keys: entry.key,
    secondary_keys: entry.keysecondary,
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    insertion_order: entry.order,
    enabled: entry.disable !== true,
    use_regex: entry.use_regex,
    name: entry.name,
    priority: entry.priority,
    case_sensitive: typeof caseSensitive === "boolean" ? caseSensitive : entry.case_sensitive,
    id: entry.id ?? entry.uid,
    position:
      typeof position === "number"
        ? position === POSITION_CODES.after
          ? "after_char"
          : "before_char"
        : position,
    // Entries, not assignment: an own `__proto__` key stays data.
    extensions: Object.fromEntries([...extensions, ...settings]),
  };
}

/**
 * Reads a SillyTavern World Info file (entries keyed by uid, or listed) or a
 * card's `character_book` on its own into the canonical lorebook, with the
 * card importer's normalization, limits and report. Never throws.
 */
export function importWorldInfo(json: unknown): WorldInfoImportResult {
  if (isNativeFileAttempt(json)) {
    const native = lorebookFileSchema.safeParse(json);
    return native.success
      ? {
          ok: true,
          book: native.data.data,
          format: "native",
          defaulted: [],
          report: { kept: [], changed: [], skipped: [] },
        }
      : { ok: false, error: "invalid" };
  }
  if (!isRecord(json)) return { ok: false, error: "not_a_lorebook" };
  const { entries } = json;
  if (!Array.isArray(entries) && !isRecord(entries)) return { ok: false, error: "not_a_lorebook" };
  const listed: unknown[] = Array.isArray(entries) ? entries : Object.values(entries);
  if (listed.length > L.lorebookEntries) return { ok: false, error: "too_large" };
  const records = listed.filter(isRecord);
  const worldInfo = !Array.isArray(entries) || records.some(isWorldInfoEntry);
  const book = worldInfo
    ? {
        ...Object.fromEntries(
          BOOK_FIELDS.flatMap((field) =>
            Object.hasOwn(json, field) ? [[field, json[field]]] : [],
          ),
        ),
        entries: records.map((entry) =>
          !Array.isArray(entries) || isWorldInfoEntry(entry) ? cardEntry(entry) : entry,
        ),
      }
    : json;
  const normalized = normalizeLorebook(book);
  if (!normalized.ok) return normalized;
  const defaulted = BOOK_FIELDS.filter((field) =>
    field === "extensions" ? !isRecord(json.extensions) : !Object.hasOwn(json, field),
  );
  return {
    ok: true,
    book: normalized.book,
    report: normalized.report,
    format: worldInfo ? "worldInfo" : "characterBook",
    defaulted,
  };
}
