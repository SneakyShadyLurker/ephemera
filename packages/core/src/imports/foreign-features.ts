import { finiteNumber, isJsonObject, type JsonObject, type JsonValue } from "../card/json.ts";

import { hasDecorators } from "./decorators.ts";
import { convertForeignEntrySettings, SILLYTAVERN_ENTRY_KEYS } from "./lorebook-settings.ts";

/*
 * Foreign lorebook settings with no native behavior. Import adapters use
 * these codes to report omissions before discarding unsupported metadata.
 */

export const IGNORED_FEATURES = [
  "priority",
  "groupScoring",
  "automation",
  "vectorized",
  "characterFilter",
  "triggers",
  "recursionLevel",
  "outlet",
  "otherExtensions",
  "bookExtensions",
  "decorators",
] as const;
export type IgnoredFeature = (typeof IGNORED_FEATURES)[number];

const SILLYTAVERN_KEYS: ReadonlySet<string> = new Set(Object.values(SILLYTAVERN_ENTRY_KEYS));

const filled = (value: JsonValue | undefined) => typeof value === "string" && value.trim() !== "";
const listed = (value: JsonValue | undefined) => Array.isArray(value) && value.length > 0;

/** A `character_filter` naming characters or tags. */
function filters(value: JsonValue | undefined): boolean {
  return isJsonObject(value) && (listed(value.names) || listed(value.tags));
}

/** Which ignored features one entry uses. */
export function ignoredEntryFeatures(entry: Record<string, unknown>): IgnoredFeature[] {
  const ext: JsonObject = isJsonObject(entry.extensions) ? entry.extensions : {};
  const converted = convertForeignEntrySettings(entry);
  const found: Record<IgnoredFeature, boolean> = {
    priority: entry.priority !== undefined,
    // Event pools act (activate.ts); their group scoring does not.
    groupScoring: ext.use_group_scoring === true,
    automation: filled(ext.automation_id),
    vectorized: ext.vectorized === true,
    characterFilter: filters(ext.character_filter),
    triggers: listed(ext.triggers),
    recursionLevel: (finiteNumber(ext.delay_until_recursion) ?? 0) > 1,
    // Only SillyTavern's `{{outlet}}` macro sends an outlet entry; Ephemera has none.
    outlet: converted.outlet,
    otherExtensions: Object.keys(ext).some(
      (key) => key !== "ephemera" && !SILLYTAVERN_KEYS.has(key),
    ),
    bookExtensions: false,
    decorators: typeof entry.content === "string" && hasDecorators(entry.content),
  };
  return IGNORED_FEATURES.filter((feature) => found[feature]);
}

/** Which ignored features the book itself uses, apart from its entries. */
export function ignoredBookFeatures(book: Record<string, unknown>): IgnoredFeature[] {
  return Object.keys(isJsonObject(book.extensions) ? book.extensions : {}).some(
    (key) => key !== "ephemera",
  )
    ? ["bookExtensions"]
    : [];
}

/** Which ignored features a lorebook uses, on the book or any entry, for an import report; none without a book. */
export function ignoredFeatureList(book: Record<string, unknown> | undefined): IgnoredFeature[] {
  if (book === undefined) return [];
  const found = new Set(ignoredBookFeatures(book));
  for (const entry of Array.isArray(book.entries) ? book.entries : []) {
    for (const feature of ignoredEntryFeatures(entry)) found.add(feature);
  }
  return IGNORED_FEATURES.filter((feature) => found.has(feature));
}
