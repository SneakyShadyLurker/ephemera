import { CARD_LIMITS as L, textLength } from "../../card/limits.ts";
import { splitList } from "../../card/tags.ts";
import { changedKeywords, fieldKey, fieldText, parseFieldKey, type ReworkField } from "./fields.ts";
import type { RawChange } from "./parse.ts";
import type { ReworkCard } from "./schema.ts";

/*
 * Where each change goes in the card as it was sent. A find must match
 * exactly once; else once with whitespace runs collapsed on both sides;
 * else the change is not placed. Offsets always point into the original
 * text, so every character outside a change stays as it was. Pure and
 * deterministic: the server and the browser place the same answer alike.
 */

/** Why a change was not placed; it is never applied. */
export type Unplaced =
  /** The key names no field the prompt offers, or one the card does not have. */
  | "no_such_field"
  /** The find occurs nowhere in the field. */
  | "missing"
  /** The find occurs more than once. */
  | "ambiguous"
  /** It touches a passage an earlier change already took. */
  | "overlap"
  /** It would blank a field that can be neither removed nor cleared. */
  | "empty"
  /** It would clear a field with no conversion of the description placed before it. */
  | "no_conversion"
  /** The field would pass its card limit. */
  | "too_long";

export interface PlacedChange {
  at: number;
  field: ReworkField;
  why: string;
  find: string;
  replace: string;
  /** The passage the change replaces, as offsets into `fieldText` of the sent card. */
  start: number;
  end: number;
  /** It replaces the whole field. */
  whole: boolean;
}

export type ReworkPlacement =
  | { ok: true; change: PlacedChange }
  | {
      ok: false;
      at: number;
      /** Null when the key names no field. */
      field: ReworkField | null;
      why: string;
      /** As written, so the review can show what was proposed. */
      find: string;
      replace: string;
      reason: Unplaced;
    };

/**
 * New items, which a change always writes whole, whatever its find says.
 * Every other field, the name, tags and an entry's title and keywords
 * included, takes a find as a passage of its text (`fieldText`).
 */
const alwaysWhole = (field: ReworkField): boolean =>
  field.kind === "alternate_new" || field.kind === "entry_new";

/** Only an alternate greeting or an entry (through its content) can be removed. */
const removable = (field: ReworkField): boolean =>
  field.kind === "alternate" || (field.kind === "entry" && field.part === "content");

/** The fields a conversion folds into the description and then clears. */
const FOLDED: readonly string[] = ["personality", "scenario"];

/**
 * A conversion: the description replaced whole with new text, as Rework does
 * to bring a card into its layout.
 */
export const isConversion = (change: PlacedChange): boolean =>
  change.whole &&
  change.replace !== "" &&
  change.field.kind === "text" &&
  change.field.key === "description";

/**
 * A folded field cleared after a conversion. It is placed only after one,
 * and decided with it, so its text is never lost without the description
 * that holds it.
 */
export const isClearing = (change: PlacedChange): boolean =>
  change.whole &&
  change.replace === "" &&
  change.field.kind === "text" &&
  FOLDED.includes(change.field.key);

/** Where `find` starts in `text`, each occurrence counted, overlapping ones too; at most two. */
function occurrences(text: string, find: string): number[] {
  const found: number[] = [];
  for (
    let at = text.indexOf(find);
    at !== -1 && found.length < 2;
    at = text.indexOf(find, at + 1)
  ) {
    found.push(at);
  }
  return found;
}

const WHITESPACE = /\s/u;

/** The text with each whitespace run as one space, and where each of its characters came from. */
function normalize(text: string): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (!WHITESPACE.test(char)) {
      out += char;
      from.push(i);
    } else if (!out.endsWith(" ")) {
      out += " ";
      from.push(i);
    }
  }
  return { text: out, from };
}

type Normalized = ReturnType<typeof normalize>;
type Match = { start: number; end: number } | "missing" | "ambiguous";

/**
 * The one passage `find` names in `text`: exactly, else with whitespace
 * collapsed on both sides. `normalized` gives the field's collapsed text,
 * made once per field however many changes it has.
 */
function match(text: string, find: string, normalized: () => Normalized): Match {
  const exact = occurrences(text, find);
  if (exact.length > 1) return "ambiguous";
  const [start] = exact;
  if (start !== undefined) return { start, end: start + find.length };
  const wanted = find.replace(/\s+/gu, " ").trim();
  if (wanted === "") return "missing";
  const field = normalized();
  const found = occurrences(field.text, wanted);
  if (found.length > 1) return "ambiguous";
  const [at] = found;
  if (at === undefined) return "missing";
  // The find is trimmed, so both ends fall on non-whitespace characters of the original.
  const first = field.from[at] ?? 0;
  const last = field.from[at + wanted.length - 1] ?? first;
  return { start: first, end: last + 1 };
}

/** The text with each change's passage replaced, later offsets first so earlier ones stay valid. */
export function splice(text: string, changes: readonly PlacedChange[]): string {
  return changes
    .toSorted((a, b) => b.start - a.start)
    .reduce(
      (out, change) => out.slice(0, change.start) + change.replace + out.slice(change.end),
      text,
    );
}

/** A short field whose limit is on its parsed value: the name, tags, an entry's title or keywords. */
const isShort = (field: ReworkField): boolean =>
  field.kind === "tags" ||
  (field.kind === "text" && field.key === "name") ||
  ((field.kind === "entry" || field.kind === "entry_new") && field.part !== "content");

/**
 * Whether the field stays within its card limit: a short field by its text
 * with every placed change applied (`result`), any other by its length.
 */
function fits(field: ReworkField, length: number, result: string): boolean {
  switch (field.kind) {
    case "tags":
      return splitList(result, L.tagLength, true).length <= L.tags;
    case "entry":
    case "entry_new":
      if (field.part === "keys") return true;
      return field.part === "name"
        ? textLength(result.trim()) <= L.shortTextLength
        : length <= L.textLength;
    case "text":
      return field.key === "name" ? textLength(result) <= L.nameLength : length <= L.textLength;
    default:
      return length <= L.textLength;
  }
}

/** Places each change against the card as sent, in arrival order. */
export function placeChanges(card: ReworkCard, raw: RawChange[]): ReworkPlacement[] {
  /** Placed ranges by field key, and each field's length after its placed changes. */
  const taken = new Map<string, PlacedChange[]>();
  const lengths = new Map<string, number>();
  let newGreetings = 0;
  const newEntries = new Set<number>();
  /** Existing entries with a placed change, and those a placed change removes. */
  const touchedEntries = new Set<number>();
  const removedEntries = new Set<number>();
  const collapsed = new Map<string, Normalized>();

  return raw.map(({ at, field: key, why, find, replace }): ReworkPlacement => {
    const refuse = (field: ReworkField | null, reason: Unplaced): ReworkPlacement => ({
      ok: false,
      at,
      field,
      why,
      find,
      replace,
      reason,
    });
    const field = parseFieldKey(key);
    if (field === undefined) return refuse(null, "no_such_field");
    const text = fieldText(card, field);
    if (text === undefined) return refuse(field, "no_such_field");

    const named = find === "" || alwaysWhole(field);
    // Every new greeting is a field of its own; nothing can overlap it.
    const id = field.kind === "alternate_new" ? `new-${at}` : fieldKey(field);
    const normalized = () => {
      const known = collapsed.get(id) ?? normalize(text);
      collapsed.set(id, known);
      return known;
    };
    const found = named ? { start: 0, end: text.length } : match(text, find, normalized);
    if (found === "missing" || found === "ambiguous") return refuse(field, found);
    // A find that spans the field, whitespace aside, is a whole change too, so copying
    // the field passes none of the rules for whole changes.
    const whole =
      named || (text.slice(0, found.start).trim() === "" && text.slice(found.end).trim() === "");
    const range = whole ? { start: 0, end: text.length } : found;

    const clears = whole && replace === "" && field.kind === "text" && FOLDED.includes(field.key);
    if (whole && replace === "" && !removable(field) && !clears) return refuse(field, "empty");
    if (clears && !(taken.get("description") ?? []).some(isConversion)) {
      return refuse(field, "no_conversion");
    }

    const earlier = taken.get(id) ?? [];
    const overlaps = earlier.some(
      (other) => whole || other.whole || (range.start < other.end && other.start < range.end),
    );
    if (overlaps) return refuse(field, "overlap");
    // Removing an entry takes all of it: its name and keywords as well as its content.
    const removes = field.kind === "entry" && whole && replace === "";
    if (
      field.kind === "entry" &&
      (removedEntries.has(field.index) || (removes && touchedEntries.has(field.index)))
    ) {
      return refuse(field, "overlap");
    }

    const change: PlacedChange = { at, field, why, find, replace, ...range, whole };
    const length = (lengths.get(id) ?? text.length) - (range.end - range.start) + replace.length;
    // Long texts are measured, short ones written out: a list's count needs its items.
    const result = isShort(field) ? splice(text, [...earlier, change]) : "";
    if ((field.kind === "entry" || field.kind === "entry_new") && field.part === "keys") {
      const keys = field.kind === "entry" ? (card.lorebook?.entries[field.index]?.keys ?? []) : [];
      const next = changedKeywords(keys, [...earlier, change]);
      if (next.length > L.tags || next.some((key) => textLength(key) > L.shortTextLength))
        return refuse(field, "too_long");
    }
    if (field.kind === "text" && field.key === "name" && result.trim() === "") {
      return refuse(field, "empty");
    }
    const counted =
      field.kind === "alternate_new"
        ? card.alternateGreetings.length + newGreetings + 1 <= L.alternateGreetings
        : field.kind !== "entry_new" ||
          newEntries.has(field.number) ||
          (card.lorebook?.entries.length ?? 0) + newEntries.size + 1 <= L.lorebookEntries;
    if (!counted || !fits(field, length, result)) return refuse(field, "too_long");

    taken.set(id, [...earlier, change]);
    lengths.set(id, length);
    if (field.kind === "alternate_new") newGreetings += 1;
    if (field.kind === "entry_new") newEntries.add(field.number);
    if (field.kind === "entry") {
      touchedEntries.add(field.index);
      if (removes) removedEntries.add(field.index);
    }
    return { ok: true, change };
  });
}
