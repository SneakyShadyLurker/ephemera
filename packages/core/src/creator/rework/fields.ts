import { clipText, CARD_LIMITS as L } from "../../card/limits.ts";
import { CARD_FIELD_LABELS, type LorebookEntry } from "../../card/schema.ts";
import { splitList } from "../../card/tags.ts";
import { joinKeywords, splitKeywords } from "../../lorebook/keys.ts";
import { entryTitle } from "../../lorebook/rules.ts";
import type { PlacedChange } from "./anchor.ts";
import type { ReworkCard } from "./schema.ts";

/*
 * The field keys of a rework answer (`<field>description</field>`), as the
 * approved prompt names them. Alternates and entries are numbered from 1 in
 * card order; a key resolves against the card as it was sent.
 */

/** The text fields a change can name directly; `characterNote` is the note's prompt. */
export const TEXT_KEYS = [
  "name",
  "description",
  "personality",
  "scenario",
  "firstMessage",
  "exampleDialogue",
  "systemPrompt",
  "postHistoryInstructions",
  "creatorNotes",
  "characterNote",
] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

/** The parts of a lorebook entry a change can name: its content, title or keywords. */
export type EntryPart = "content" | "name" | "keys";

export type ReworkField =
  | { kind: "text"; key: TextKey }
  | { kind: "tags" }
  /** An existing alternate greeting, 0-based. */
  | { kind: "alternate"; index: number }
  /** A greeting the model adds; every occurrence adds one. */
  | { kind: "alternate_new" }
  /** An existing lorebook entry, 0-based. */
  | { kind: "entry"; index: number; part: EntryPart }
  /** An entry the model adds, by the number it gave it (from 1). */
  | { kind: "entry_new"; number: number; part: EntryPart };

const isTextKey = (raw: string): raw is TextKey => (TEXT_KEYS as readonly string[]).includes(raw);

/** Numbers from 1, without leading zeros; six digits are past any card limit. */
const NUMBER = "([1-9]\\d{0,5})";
const ALTERNATE = new RegExp(`^alternate_greeting_${NUMBER}$`);
const ENTRY = new RegExp(`^entry_(new_)?${NUMBER}(?:_(name|keys))?$`);

/** The field a key names; undefined for anything the prompt does not offer. */
export function parseFieldKey(raw: string): ReworkField | undefined {
  if (isTextKey(raw)) return { kind: "text", key: raw };
  if (raw === "tags") return { kind: "tags" };
  if (raw === "alternate_greeting_new") return { kind: "alternate_new" };
  const alternate = ALTERNATE.exec(raw);
  if (alternate !== null) return { kind: "alternate", index: Number(alternate[1]) - 1 };
  const entry = ENTRY.exec(raw);
  if (entry === null) return undefined;
  const number = Number(entry[2]);
  const part: EntryPart = entry[3] === "name" || entry[3] === "keys" ? entry[3] : "content";
  return entry[1] === undefined
    ? { kind: "entry", index: number - 1, part }
    : { kind: "entry_new", number, part };
}

const partSuffix = (part: EntryPart): string => (part === "content" ? "" : `_${part}`);

/** The key of a field, as the prompt and the answer write it: the inverse of `parseFieldKey`. */
export function fieldKey(field: ReworkField): string {
  switch (field.kind) {
    case "text":
      return field.key;
    case "tags":
      return "tags";
    case "alternate":
      return `alternate_greeting_${field.index + 1}`;
    case "alternate_new":
      return "alternate_greeting_new";
    case "entry":
      return `entry_${field.index + 1}${partSuffix(field.part)}`;
    case "entry_new":
      return `entry_new_${field.number}${partSuffix(field.part)}`;
  }
}

/** Tags as the model reads and writes them: short entries separated by commas. */
export const joinList = (items: readonly string[]): string => items.join(", ");

/** The tags a tags field's text holds, within the card's limits; lowercased, as the prompt asks. */
export const tagsOf = (text: string): string[] =>
  splitList(text, L.tagLength, true).slice(0, L.tags);

/** Actual keys after passage edits, shared by placement limits and Apply. */
export function changedKeywords(
  keys: readonly string[],
  changes: readonly PlacedChange[],
): string[] {
  const source = joinKeywords(keys);
  const literals = new Set<number>();
  const separators = new Set<number>();
  const emptyKeys = new Set<number>();
  let at = 0;
  for (const key of keys) {
    if (
      key.trim() === "" &&
      !changes.some((change) =>
        key.length === 0
          ? change.start <= at && at < change.end
          : change.start < at + key.length && at < change.end,
      )
    )
      emptyKeys.add(at);
    for (let index = 0; index < key.length; index += 1) {
      if (key[index] === "," || /\s/.test(key[index] ?? "")) literals.add(at + index);
    }
    separators.add(at + key.length);
    at += key.length + 2;
  }
  let result = "";
  let cursor = 0;
  const protectedPositions = new Set<number>();
  const structuralPositions = new Set<number>();
  const keptEmptyKeys = new Set<number>();
  const keep = (end: number) => {
    for (const at of emptyKeys) {
      if (cursor <= at && (at < end || (at === end && end === source.length)))
        keptEmptyKeys.add(result.length + at - cursor);
    }
    for (let index = cursor; index < end; index += 1) {
      if (literals.has(index)) protectedPositions.add(result.length + index - cursor);
      if (separators.has(index)) structuralPositions.add(result.length + index - cursor);
    }
    result += source.slice(cursor, end);
  };
  for (const change of changes.toSorted((a, b) => a.start - b.start)) {
    keep(change.start);
    result += change.replace;
    cursor = change.end;
  }
  keep(source.length);
  if (changes.some((change) => change.whole)) {
    return [
      ...new Set(
        result
          .split("\n")
          .flatMap((line) => splitKeywords(line))
          .map((key) => clipText(key, L.shortTextLength)),
      ),
    ];
  }
  const next: string[] = [];
  let start = 0;
  for (let index = 0; index <= result.length; index += 1) {
    if (index === result.length || (result[index] === "\n" && !protectedPositions.has(index))) {
      next.push(
        ...splitKeywords(result.slice(start, index), {
          literals: protectedPositions,
          separators: structuralPositions,
          emptyKeys: keptEmptyKeys,
          offset: start,
        }),
      );
      start = index + 1;
    }
  }
  return next;
}

/** An entry's title as the lorebook screen edits it: its comment, else its name. */
export const entryName = (entry: LorebookEntry): string =>
  entry.comment?.trim() ? entry.comment : (entry.name ?? "");

function entryPartText(entry: LorebookEntry, part: EntryPart): string {
  if (part === "content") return entry.content;
  return part === "name" ? entryName(entry) : joinKeywords(entry.keys);
}

/**
 * A field's current text as the model is shown it; tags and keywords comma
 * joined, a new greeting or entry empty. A change's find is placed in it. Undefined when the card has no such
 * alternate, entry or note.
 */
export function fieldText(card: ReworkCard, field: ReworkField): string | undefined {
  switch (field.kind) {
    case "text":
      return field.key === "characterNote" ? card.characterNote?.prompt : card[field.key];
    case "tags":
      return joinList(card.tags);
    case "alternate":
      return card.alternateGreetings[field.index];
    case "alternate_new":
    case "entry_new":
      return "";
    case "entry": {
      const entry = card.lorebook?.entries[field.index];
      return entry === undefined ? undefined : entryPartText(entry, field.part);
    }
  }
}

const PART_LABELS: Record<EntryPart, string> = { content: "", name: ", name", keys: ", keywords" };

/** What the review calls a field: "Description", "Alternate 2", "Entry 3: The harbour, keywords". */
export function fieldLabel(field: ReworkField, card: ReworkCard): string {
  switch (field.kind) {
    case "text":
      return CARD_FIELD_LABELS[field.key];
    case "tags":
      return "Tags";
    case "alternate":
      return `Alternate ${field.index + 1}`;
    case "alternate_new":
      return "New alternate";
    case "entry": {
      const entry = card.lorebook?.entries[field.index];
      const numbered = `Entry ${field.index + 1}`;
      const title = entry === undefined ? numbered : entryTitle(entry, field.index);
      const named = title === numbered ? numbered : `${numbered}: ${title}`;
      return `${named}${PART_LABELS[field.part]}`;
    }
    case "entry_new":
      return `New entry ${field.number}${PART_LABELS[field.part]}`;
  }
}
