import type { Lorebook, LorebookEntry } from "../card/schema.ts";
import type { LorebookReport } from "../prompt/inspect.ts";
import {
  clip,
  combinedBudget,
  LOREBOOK_LINKS,
  LOREBOOK_RULES,
  lorebookScanDepth,
} from "./rules.ts";

/*
 * A character's books as one activation (activate.ts): the book in its card
 * first, then its linked library books in link order. Entries are
 * concatenated; each keeps its own book's scan depth and chaining. They
 * share one budget (`combinedBudget`).
 */

/** One book a request activates: `id` is the library book's, null for the card's own. */
export interface LorebookSource {
  id: string | null;
  name: string;
  book: Lorebook;
}

/** A source as the report names it, with how many entries its book has. */
type LorebookSourceSummary = LorebookReport["sources"][number];

/** One entry of the combined list, with what it keeps from its book. */
export interface CombinedEntry {
  entry: LorebookEntry;
  /** Its library book's id, null for the card's own; names it in the timed state. */
  book: string | null;
  /** Its index inside its book. */
  index: number;
  /** Its book's scan depth; the entry's own `scanDepth` still overrides it. */
  scanDepth: number;
  /** Whether its book chains (`recursiveScanning`): only such entries recurse or are recursed into. */
  chains: boolean;
}

export interface CombinedLorebooks {
  /** In order; the combined index of a source's first entry is the sum of the counts before it. */
  sources: LorebookSourceSummary[];
  /** Every source's entries, concatenated in source order. */
  entries: CombinedEntry[];
  /** The scan depth the report names as the books': the first source's. */
  scanDepth: number;
}

/** One book's entries with its context: `scanDepth` as given, its chaining as the book says. */
function bookEntries(source: LorebookSource, scanDepth: number): CombinedEntry[] {
  const chains = source.book.recursiveScanning === true;
  return source.book.entries.map((entry, index) => ({
    entry,
    book: source.id,
    index,
    scanDepth,
    chains,
  }));
}

const summary = (source: LorebookSource): LorebookSourceSummary => ({
  id: source.id,
  name: clip(source.name),
  count: source.book.entries.length,
});

/**
 * Combines `sources`, the card's own book (id null) first, then linked books
 * in link order, for a model whose window is `window` tokens. A source whose
 * id came earlier is left out (a book counts once), and at most
 * `LOREBOOK_LINKS + 1` take part. Each book reads its own scan depth
 * (`lorebookScanDepth`); the budget is the largest any of them allows.
 */
export function combineLorebooks(
  sources: readonly LorebookSource[],
  window: number,
): { books: CombinedLorebooks; budget: number } {
  const seen = new Set<string | null>();
  const taken = sources
    .filter((source) => {
      if (seen.has(source.id)) return false;
      seen.add(source.id);
      return true;
    })
    .slice(0, LOREBOOK_LINKS + 1);
  const [first] = taken;
  return {
    books: {
      sources: taken.map(summary),
      entries: taken.flatMap((source) => bookEntries(source, lorebookScanDepth(source.book))),
      scanDepth:
        first === undefined ? LOREBOOK_RULES.defaultScanDepth : lorebookScanDepth(first.book),
    },
    budget: combinedBudget(
      taken.map((source) => source.book),
      window,
    ),
  };
}

/**
 * Where a combined index lies: its source's position in `sources` and its
 * index inside that book; null past the last source.
 */
export function entryOrigin(
  sources: readonly Pick<LorebookSourceSummary, "count">[],
  combined: number,
): { source: number; index: number } | null {
  if (!Number.isInteger(combined) || combined < 0) return null;
  let start = 0;
  for (const [source, { count }] of sources.entries()) {
    if (combined < start + count) return { source, index: combined - start };
    start += count;
  }
  return null;
}
