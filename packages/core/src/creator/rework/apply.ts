import { CARD_LIMITS as L } from "../../card/limits.ts";
import type { Lorebook, LorebookEntry } from "../../card/schema.ts";
import { newEntry } from "../../lorebook/rules.ts";
import { blankLorebook } from "../../lorebook/stored.ts";
import { type PlacedChange, splice } from "./anchor.ts";
import { changedKeywords, type EntryPart, entryName, joinList, tagsOf } from "./fields.ts";
import type { ReworkCard } from "./schema.ts";

/*
 * The accepted changes written into the card as it was sent. Offsets and
 * indexes refer to that card, so changes apply later offsets first within
 * a field, greetings and entries by their original index before removals
 * drop any, and every character outside a change stays as it was.
 */

export interface AppliedChanges {
  /** The fields the changes touched, with their new values; untouched fields are absent. */
  next: Partial<ReworkCard>;
  /** The keys `next` carries, for Undo. */
  touched: (keyof ReworkCard)[];
}

/** A whole change with nothing to put in: the greeting or entry goes. */
const removes = (changes: readonly PlacedChange[]): boolean =>
  changes.some((change) => change.whole && change.replace === "");

/** Changes grouped by a key, each group in arrival order; a change without a key is left out. */
function groupBy<K>(
  changes: readonly PlacedChange[],
  key: (change: PlacedChange) => K | undefined,
): Map<K, PlacedChange[]> {
  const groups = Map.groupBy(
    changes.toSorted((a, b) => a.at - b.at),
    key,
  );
  return new Map(
    [...groups].flatMap(([at, group]): [K, PlacedChange[]][] =>
      at === undefined ? [] : [[at, group]],
    ),
  );
}

/** An entry's title, as the lorebook screen shows it first (`comment`), and its `name` where it has one. */
function named(entry: LorebookEntry, title: string, always: boolean): LorebookEntry {
  const name = title.trim();
  return always || entry.name !== undefined
    ? { ...entry, comment: name, name }
    : { ...entry, comment: name };
}

/**
 * One part of an entry rewritten by its changes, spliced into the part's
 * text as the model read it (`fieldText`); keywords are then split back.
 */
function withPart(entry: LorebookEntry, part: EntryPart, changes: PlacedChange[], isNew: boolean) {
  if (changes.length === 0) return entry;
  if (part === "content") return { ...entry, content: splice(entry.content, changes) };
  if (part === "keys") return { ...entry, keys: changedKeywords(entry.keys, changes) };
  return named(entry, splice(entryName(entry), changes), isNew);
}

const PARTS: EntryPart[] = ["content", "name", "keys"];

function applyToBook(book: Lorebook | null, changes: readonly PlacedChange[]): Lorebook {
  const base = book ?? blankLorebook();
  const existing = groupBy(changes, (change) =>
    change.field.kind === "entry" ? change.field.index : undefined,
  );
  const entries = base.entries.flatMap((entry, index) => {
    const own = existing.get(index) ?? [];
    const content = own.filter(
      (change) => change.field.kind === "entry" && change.field.part === "content",
    );
    if (removes(content)) return [];
    return [
      PARTS.reduce(
        (out, part) =>
          withPart(
            out,
            part,
            own.filter((change) => change.field.kind === "entry" && change.field.part === part),
            false,
          ),
        entry,
      ),
    ];
  });
  const added = groupBy(changes, (change) =>
    change.field.kind === "entry_new" ? change.field.number : undefined,
  );
  for (const number of [...added.keys()].sort((a, b) => a - b)) {
    if (entries.length >= L.lorebookEntries) break;
    const own = added.get(number) ?? [];
    entries.push(
      PARTS.reduce(
        (out, part) =>
          withPart(
            out,
            part,
            own.filter((change) => change.field.kind === "entry_new" && change.field.part === part),
            true,
          ),
        newEntry(entries),
      ),
    );
  }
  return { ...base, entries };
}

function applyToGreetings(
  greetings: readonly string[],
  changes: readonly PlacedChange[],
): string[] {
  const byIndex = groupBy(changes, (change) =>
    change.field.kind === "alternate" ? change.field.index : undefined,
  );
  const kept = greetings.flatMap((greeting, index) => {
    const own = byIndex.get(index) ?? [];
    return removes(own) ? [] : [splice(greeting, own)];
  });
  const added = [...changes]
    .filter((change) => change.field.kind === "alternate_new")
    .sort((a, b) => a.at - b.at)
    .map((change) => change.replace);
  return [...kept, ...added].slice(0, L.alternateGreetings);
}

/** Applies every accepted change on top of the card as sent. */
export function applyChanges(card: ReworkCard, accepted: readonly PlacedChange[]): AppliedChanges {
  const next: Partial<ReworkCard> = {};
  const text = groupBy(accepted, (change) =>
    change.field.kind === "text" ? change.field.key : undefined,
  );
  for (const [key, changes] of text) {
    if (key === "characterNote") {
      const note = card.characterNote;
      if (note !== null) next.characterNote = { ...note, prompt: splice(note.prompt, changes) };
    } else {
      next[key] = splice(card[key], changes);
    }
  }
  const tags = accepted.filter((change) => change.field.kind === "tags");
  if (tags.length > 0) next.tags = tagsOf(splice(joinList(card.tags), tags));
  const greetings = accepted.filter(
    (change) => change.field.kind === "alternate" || change.field.kind === "alternate_new",
  );
  if (greetings.length > 0) {
    next.alternateGreetings = applyToGreetings(card.alternateGreetings, greetings);
  }
  const lore = accepted.filter(
    (change) => change.field.kind === "entry" || change.field.kind === "entry_new",
  );
  if (lore.length > 0) next.lorebook = applyToBook(card.lorebook, lore);
  const touched = Object.keys(next).filter((key): key is keyof ReworkCard => key in card);
  return { next, touched };
}
