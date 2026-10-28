import {
  cardScanDepth,
  cardTokenBudget,
  compareInChat,
  ENTRY_ACTIVATIONS,
  type EntryActivation,
  type EntryPlacement,
  type EntrySettingsPatch,
  entrySettings,
  entryTitle,
  insertionOrder,
  type KeyProblem,
  keyProblem,
  type Lorebook,
  type LorebookEntry,
  lorebookScanDepth,
  PRESET_LIMITS,
  withEntrySettings,
} from "@ephemera/core";
import { matches } from "@/lib/find";
import { oneOf } from "@/lib/one-of.ts";

/*
 * The lorebook screen's editing rules. Activation, order and placement are
 * core's (packages/core/src/lorebook); this module only edits the book and
 * finds entries in it. Card data, not chat content.
 */

/**
 * Keys already checked, so no render compiles a pattern twice (a hostile book
 * could hold hundreds of thousands). Card data, not chat content; bounded,
 * after which new keys are still checked but no longer remembered.
 */
const checked = new Map<string, KeyProblem | null>();
const MAX_CHECKED = 100_000;

function problemOf(key: string, useRegex: boolean): KeyProblem | null {
  const id = `${useRegex ? "r" : "p"}${key}`;
  const known = checked.get(id);
  if (known !== undefined) return known;
  const problem = keyProblem(key, useRegex);
  if (checked.size < MAX_CHECKED) checked.set(id, problem);
  return problem;
}

type KeyProblems = { key: string; problem: KeyProblem }[];

const problemsOf = (keys: readonly string[], useRegex: boolean): KeyProblems =>
  keys.flatMap((key) => {
    const problem = problemOf(key, useRegex);
    return problem === null ? [] : [{ key, problem }];
  });

/** The entry's keys that can never match, and why. */
export function entryKeyProblems(entry: LorebookEntry): KeyProblems {
  return problemsOf(entry.keys, entry.useRegex);
}

/** The entry's secondary keys that can never match, and why (prepared like the keys). */
export function secondaryKeyProblems(entry: LorebookEntry): KeyProblems {
  return problemsOf(entry.secondaryKeys ?? [], entry.useRegex);
}

/** Whether any of the entry's keys or secondary keys can never match. */
const needsFix = (entry: LorebookEntry) =>
  entryKeyProblems(entry).length > 0 || secondaryKeyProblems(entry).length > 0;

/** How many entries have a key or secondary key that never matches. */
export const entriesToFix = (entries: readonly LorebookEntry[]) => entries.filter(needsFix).length;

/**
 * The book's settings as the fields show them: the card's values when
 * activation uses them, else empty (the defaults), and the depth it reads.
 */
export function bookSettings(book: Lorebook) {
  return {
    depth: cardScanDepth(book),
    effectiveDepth: lorebookScanDepth(book),
    budget: cardTokenBudget(book),
    chaining: book.recursiveScanning === true,
  };
}

/** The event pool names the book's entries use, each once, in book order: the editor's suggestions. */
export function bookPools(book: Lorebook): string[] {
  return [...new Set(book.entries.flatMap((entry) => entrySettings(entry).poolNames))];
}

/** The book with one entry changed; every field it does not name stays as it was. */
export function withEntry(book: Lorebook, index: number, change: Partial<LorebookEntry>): Lorebook {
  return {
    ...book,
    entries: book.entries.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
  };
}

/**
 * The book with one entry's native settings changed through core's one
 * writer (`withEntrySettings`); every other field and setting stays.
 */
export function withSettings(book: Lorebook, index: number, patch: EntrySettingsPatch): Lorebook {
  return {
    ...book,
    entries: book.entries.map((entry, at) =>
      at === index ? withEntrySettings(entry, patch) : entry,
    ),
  };
}

/** Whether a value is one of the editor's three activation choices (core's `entryActivation`). */
export const isActivation = oneOf(ENTRY_ACTIVATIONS);

/** The chance "By chance" starts from when the card holds none between 1% and 99%. */
const DEFAULT_CHANCE = 10;

/**
 * The fields that make the entry go in as `next`, through core's settings
 * writer. "By chance" switches the chance on, keeping a stored 1% to 99%;
 * leaving it, or choosing "Always", switches it off and keeps the number.
 */
export function activationChange(
  entry: LorebookEntry,
  next: EntryActivation,
): Partial<LorebookEntry> {
  const { chance, probability } = entrySettings(entry);
  let patch: EntrySettingsPatch = {};
  if (next === "chance") {
    const kept = probability !== null && probability >= 1 && probability <= 99;
    patch = { useProbability: true, probability: kept ? probability : DEFAULT_CHANCE };
  } else if (chance !== null && (next === "always" || entry.constant === true)) {
    patch = { useProbability: false };
  }
  return {
    constant: next !== "keywords",
    settings: withEntrySettings(entry, patch).settings ?? {},
  };
}

export type RemovedEntry = { entry: LorebookEntry; index: number };

export function withRestored(book: Lorebook, removed: RemovedEntry): Lorebook {
  const entries = [...book.entries];
  entries.splice(Math.min(removed.index, entries.length), 0, removed.entry);
  return { ...book, entries };
}

/** Whether Find finds the entry (lib/find.ts) in its title, keys, secondary keys or text. */
function matchesFind(entry: LorebookEntry, index: number, query: string): boolean {
  return matches(
    query,
    entryTitle(entry, index),
    ...entry.keys,
    ...(entry.secondaryKeys ?? []),
    entry.content,
  );
}

/** The list's groups, in the order the prompt speaks them. */
const LIST_GROUPS = ["before", "after", "examples", "authorsNote", "chat", "notSent"] as const;
export type ListGroup = (typeof LIST_GROUPS)[number];

const GROUP_OF: Record<EntryPlacement, ListGroup> = {
  before: "before",
  after: "after",
  examplesTop: "examples",
  examplesBottom: "examples",
  anTop: "authorsNote",
  anBottom: "authorsNote",
  depth: "chat",
};

/** Within a group: example dialogue before, then after; the Author's Note above, then below. */
const PLACE_RANK: Record<EntryPlacement, number> = {
  before: 0,
  after: 0,
  examplesTop: 0,
  examplesBottom: 1,
  anTop: 0,
  anBottom: 1,
  depth: 0,
};

/** One group of the list: the entries shown, and how many it holds before Find. */
export interface ShownGroup {
  group: ListGroup;
  indexes: number[];
  total: number;
}

/**
 * The entries the list shows, grouped in speaking order, each group in the
 * order the prompt sends it: insertion order (core's rule); example and
 * Author's Note entries by their side first; entries in the chat deepest
 * first, then as the assembly orders one depth (`compareInChat`). Found by
 * `query` and, when `toFix`, only those with a key that never matches.
 * Groups without entries are left out.
 */
export function findEntries(entries: LorebookEntry[], query: string, toFix: boolean): ShownGroup[] {
  const trimmed = query.trim();
  const settings = entries.map(entrySettings);
  const place = (index: number) => {
    const setting = settings[index];
    if (setting === undefined) throw new Error("no such entry");
    return setting;
  };
  const sorted = insertionOrder(entries).sort((a, b) => {
    const first = place(a);
    const second = place(b);
    const byGroup =
      LIST_GROUPS.indexOf(GROUP_OF[first.placement]) -
      LIST_GROUPS.indexOf(GROUP_OF[second.placement]);
    if (byGroup !== 0) return byGroup;
    if (first.placement === "depth" && second.placement === "depth") {
      // Every lorebook depth block has the default order; depth and role decide.
      const order = PRESET_LIMITS.defaultOrder;
      return compareInChat({ ...first, order }, { ...second, order });
    }
    return PLACE_RANK[first.placement] - PLACE_RANK[second.placement];
  });
  const groups = new Map<ListGroup, ShownGroup>();
  for (const index of sorted) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const group = GROUP_OF[place(index).placement];
    const shown = groups.get(group) ?? { group, indexes: [], total: 0 };
    groups.set(group, shown);
    shown.total += 1;
    if (trimmed !== "" && !matchesFind(entry, index, trimmed)) continue;
    if (toFix && !needsFix(entry)) continue;
    shown.indexes.push(index);
  }
  return LIST_GROUPS.flatMap((group) => {
    const shown = groups.get(group);
    return shown === undefined ? [] : [shown];
  });
}

/** The entries in the list's order, as found: the order focus moves in. */
export const listOrder = (groups: readonly ShownGroup[]) =>
  groups.flatMap((group) => group.indexes);
