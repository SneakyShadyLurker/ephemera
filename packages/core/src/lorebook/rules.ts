import { clipText } from "../card/limits.ts";
import type { Lorebook, LorebookEntry } from "../card/schema.ts";
import { MAX_MACRO_OUTPUT } from "../prompt/macros.ts";

/** Native lorebook bounds and defaults, each with one owner. */

/**
 * Work units of the scan's bound. One unit is about one character of a plain
 * `includes` search. Weights measured in Bun 1.4.2 (JavaScriptCore) with
 * `bun --bun vitest` on the owner's machine, 2026-09-29, where one unit came
 * to 0.035 ns (a 20-character key against two 64 KB messages: 4.4 us):
 *
 * - Lowercasing: 0.3 ns per character. Word segmentation: 20 ns per character.
 * - An occurrence rejected at a word boundary: 20 to 30 ns.
 * - Per message check and per key (macros, parsing, calls): about 50 ns and 1 us.
 * - Macro parsing and expansion reserve 21 ns per evaluation work unit,
 *   sharing the scan's bound.
 * - A visit to a key whose outcome is cached, or one reason built from it,
 *   which every recursive pass repeats: about 25 ns (measured the same way, 2026-10-01).
 * - re2js `test`: up to 53 ns per character for small programs (`(a+)+$` on
 *   `aaaa`, where the DFA gives up) and 0.1 to 0.5 ns per character and
 *   instruction for large ones (2,002 instructions on Cyrillic text).
 * - re2js match position (`matcher().find()`, Pike VM, only after `test`
 *   matched): 10 to 13 ns per character and instruction.
 * - Compiling: 4 us for a small pattern, 1.1 ms for 8,009 instructions.
 *
 * With these weights every path measured 0.003 to 0.038 ns per unit, so
 * `scanWork` stops any scan after about 0.6 s on that machine. The
 * 5,000-entry book with 100 plain keys each over 128 KB stops there after
 * about 93,000 keys (0.45 s); a 300-entry book with 5 keys each over 20 KB
 * uses under 1% of it. Pattern keys are weighted for their worst case, so a
 * book with hundreds of them over a long scan can reach the bound.
 */
const SCAN_COSTS = {
  plainChar: 1,
  lowerChar: 10,
  segmentChar: 600,
  occurrence: 800,
  check: 1_500,
  visit: 750,
  key: 30_000,
  macroEvaluation: 600,
  patternChar: 2_000,
  patternInstChar: 12,
  matchInstChar: 325,
  compile: 500_000,
  compileInst: 5_000,
} as const;

export const LOREBOOK_RULES = {
  /** Default history scan depth. */
  defaultScanDepth: 2,
  maxScanDepth: 1_000,
  /** Maximum share of a context window for lorebook text. */
  budgetShare: 0.25,
  /** The largest `{m,n}` bound a pattern key may use. */
  maxPatternRepeat: 100,
  /** The scan's work bound, in the units of `scanCosts`. */
  scanWork: 15_000_000_000,
  scanCosts: SCAN_COSTS,
  /**
   * Entry text one request may fill with macros and count, in characters:
   * four times the macro limit, far above any window's quarter. Past it the
   * remaining entries are reported unscanned.
   */
  entryText: 4 * MAX_MACRO_OUTPUT,
  /** Report bounds: entries listed per status, key problems, text length. */
  reportEntries: 200,
  reportKeyProblems: 100,
  reportText: 200,
  /**
   * Entries one request activates across a character's books, taken in
   * source order (combine.ts); entries past it are reported unscanned. It
   * also bounds the timed effects a chat carries.
   */
  combinedEntries: 10_000,
  /** Bounded pool membership, retained pool names and weighted draw settings. */
  poolsPerEntry: 8,
  poolNamesKept: 64,
  poolWeight: { min: 1, max: 10_000, default: 100 },
} as const;

/** The most library lorebooks linked to one character, beside the book in its card. */
export const LOREBOOK_LINKS = 8;

/** Why a key can never match; re2js-free, so the inspector schema can name them. */
export const KEY_PROBLEMS = ["invalidPattern", "unsupportedPattern", "repeatTooLarge"] as const;
/** Why a key can never match. */
export type KeyProblem = (typeof KEY_PROBLEMS)[number];

/** Why an entry went in or stayed out, in the inspector's report. */
export const LOREBOOK_STATUSES = [
  "sent",
  "doesNotFit",
  "afterCutoff",
  "blockOff",
  "notMatched",
  /** Its primary key matched and its secondary keys' logic ruled it out. */
  "filtered",
  /** It would have gone in and lost its trigger chance's roll for this request. */
  "chanceMissed",
  /** It would have gone in and another entry holds one of its event pools for this request. */
  "poolLost",
  "off",

  /** A timed effect: it cannot activate again yet. */
  "cooldown",
  /** Its delay: the chat is shorter than it waits for. */
  "delayed",
  /**
   * Delayed until recursion ("Another entry only") and no recursive pass
   * reached it: the book does not chain, or the first pass activated nothing.
   */
  "chainOnly",
  /** Placed at the Author's Note, which this request does not send. */
  "noteOff",
  "empty",
  "tooLong",
  "unscanned",
] as const;
export type LorebookStatus = (typeof LOREBOOK_STATUSES)[number];

/** Cuts `text` to the report's length without leaving half a surrogate pair. */
export const clip = (text: string): string => clipText(text, LOREBOOK_RULES.reportText);

/** The card's `scanDepth` when activation honours it (a non-negative number), clamped; else null. */
export function cardScanDepth(book: Lorebook): number | null {
  const depth = book.scanDepth;
  if (depth === undefined || !Number.isFinite(depth) || depth < 0) return null;
  return Math.min(Math.trunc(depth), LOREBOOK_RULES.maxScanDepth);
}

/** **Decided:** the card's `scanDepth` when a non-negative number, clamped; else 2. */
export function lorebookScanDepth(book: Lorebook): number {
  return cardScanDepth(book) ?? LOREBOOK_RULES.defaultScanDepth;
}

/** The card's `tokenBudget` when activation honours it (a positive number), whole; else null. */
export function cardTokenBudget(book: Lorebook): number | null {
  const budget = book.tokenBudget;
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return null;
  return Math.floor(budget);
}

/**
 * **Decided:** the card's `tokenBudget` when positive, never above a quarter
 * of the context window; without one, a quarter of the window.
 */
export function lorebookBudget(book: Lorebook, window: number): number {
  const cap = Math.max(0, Math.floor(window * LOREBOOK_RULES.budgetShare));
  const budget = cardTokenBudget(book);
  return budget === null ? cap : Math.min(budget, cap);
}

/**
 * **Decided:** the books a request activates together share one budget, the
 * largest any of them allows by `lorebookBudget`; 0 without a book.
 */
export function combinedBudget(books: readonly Lorebook[], window: number): number {
  return books.reduce((largest, book) => Math.max(largest, lorebookBudget(book, window)), 0);
}

/** The entry's name in lists and the report: its comment, name, first key or position. */
export function entryTitle(entry: LorebookEntry, index: number): string {
  const title =
    entry.comment?.trim() ||
    entry.name?.trim() ||
    entry.keys.find((key) => key.trim() !== "")?.trim() ||
    `Entry ${index + 1}`;
  return clip(title);
}

/**
 * A new entry: enabled, keyword-triggered, before the character, after every
 * other order, with the next numeric id. One owner for the lorebook screen
 * and the rework.
 */
export function newEntry(entries: readonly LorebookEntry[]): LorebookEntry {
  const orders = entries.map((entry) => entry.insertionOrder);
  const ids = entries.flatMap((entry) => (typeof entry.id === "number" ? [entry.id] : []));
  return {
    keys: [],
    content: "",
    enabled: true,
    insertionOrder: orders.length === 0 ? 100 : Math.max(...orders) + 10,
    useRegex: false,
    constant: false,
    id: ids.length === 0 ? 0 : Math.max(...ids) + 1,
    comment: "",
  };
}

/** Entry indexes by ascending insertion order; later book entries win ties. */
export function insertionOrder(entries: readonly LorebookEntry[]): number[] {
  return entries
    .map((_, index) => index)
    .sort((a, b) => {
      const byOrder = (entries[a]?.insertionOrder ?? 0) - (entries[b]?.insertionOrder ?? 0);
      return byOrder === 0 ? b - a : byOrder;
    });
}
