import type { PlacedChange } from "@ephemera/core";
import { diffWordsWithSpace } from "diff";

/*
 * How a field under review reads as tracked changes: the original text cut
 * at each placed change, long unchanged stretches folded away, and each
 * change as a word diff of the passage it replaces. Presentation only; core
 * owns which passage a change replaces (placeChanges). The texts here are
 * creation drafts (PRINCIPLES.md 1): memory only, and the diff memo is
 * cleared with the rest of the review.
 */

/** One stretch of a word diff: kept, struck from the original, or inserted. */
export interface Run {
  kind: "same" | "del" | "ins";
  text: string;
}

export type Segment =
  | { kind: "same"; text: string }
  /** Unchanged text folded behind "Show N unchanged words". */
  | { kind: "collapsed"; text: string; words: number }
  | {
      kind: "change";
      /** The change's arrival order (`PlacedChange.at`) as text. */
      id: string;
      /** The passage of the original the change replaces, as it stands in the field. */
      find: string;
      replace: string;
      runs: Run[];
      /**
       * "inline" interleaves struck and inserted words; "passage" shows the
       * replacement as one inserted passage with the original behind a
       * disclosure, for a large rewrite that keeps little of the original.
       */
      mode: "inline" | "passage";
      /**
       * Where the change's reason and decision stand, as an offset into the
       * original: the end of the sentence holding the change's end, so the
       * prose reads on and the row follows it (`reasonOffsets`).
       */
      reasonAt: number;
    };

interface SegmentOptions {
  /** Unchanged runs longer than this many words fold away, keeping context beside changes. */
  collapseWords: number;
}

/** Context beside a change: its sentence when that is at most this many words. */
const CONTEXT_SENTENCE_WORDS = 40;
/** Context beside a change whose sentence is longer. Also the least a fold may hide. */
const CONTEXT_WORDS = 12;
/** A change is a passage when find and replace together pass this many words... */
const PASSAGE_WORDS = 80;
/** ...and the word diff keeps less than this share of the find's words. */
const PASSAGE_KEPT = 0.4;
/** Most word diffs remembered; the oldest goes first. */
const MEMO_SIZE = 20_000;
/**
 * The bounds of one word diff, whose cost grows with the square of its edits:
 * past this many inserted and deleted tokens (words and whitespace runs), or
 * this many milliseconds, jsdiff gives up and the change reads as a passage.
 */
const DIFF_BOUNDS = { maxEditLength: 1_000, timeout: 100 } as const;

const WORD = /\S+/gu;
const countWords = (text: string): number => text.match(WORD)?.length ?? 0;

/** A change's word diff and how it reads. */
interface Tracked {
  runs: Run[];
  mode: "inline" | "passage";
}

const memo = new Map<string, Tracked>();

/** The original struck, then the replacement inserted, without empty runs. */
const struckThenInserted = (find: string, replace: string): Run[] => [
  ...(find === "" ? [] : [{ kind: "del" as const, text: find }]),
  ...(replace === "" ? [] : [{ kind: "ins" as const, text: replace }]),
];

/**
 * How a change reads (R3): as interleaved words, or for a large rewrite that
 * keeps little of the original as one inserted passage. A replacement too
 * short to keep enough of the find is a passage by its size alone, and is
 * never diffed; so is a rewrite whose diff passes `DIFF_BOUNDS`.
 */
function track(find: string, replace: string): Tracked {
  const findWords = countWords(find);
  const replaceWords = countWords(replace);
  const large = findWords > 0 && findWords + replaceWords > PASSAGE_WORDS;
  // A removal, however long, stays struck in view, so nothing is emptied unseen.
  if (large && replace !== "" && replaceWords < findWords * PASSAGE_KEPT) {
    return { runs: struckThenInserted(find, replace), mode: "passage" };
  }
  const parts =
    find === "" || replace === "" ? undefined : diffWordsWithSpace(find, replace, DIFF_BOUNDS);
  if (parts === undefined) {
    // A small removal, an insertion (one inserted passage already, with no original to disclose)
    // or a diff that gave up, which reads as a passage.
    const inline = replace === "" || findWords === 0;
    return { runs: struckThenInserted(find, replace), mode: inline ? "inline" : "passage" };
  }
  const runs: Run[] = parts.map((part) => ({
    kind: part.added ? "ins" : part.removed ? "del" : "same",
    text: part.value,
  }));
  if (!large) return { runs, mode: "inline" };
  const kept = runs.reduce((sum, run) => sum + (run.kind === "same" ? countWords(run.text) : 0), 0);
  return { runs, mode: kept / findWords < PASSAGE_KEPT ? "passage" : "inline" };
}

/**
 * A change's word diff, whitespace kept as written, and how it reads.
 * Memoized, so a review re-rendering on every streamed change diffs each
 * change once.
 */
function trackedChange(find: string, replace: string): Tracked {
  // The length prefix keeps the key unambiguous whatever either text holds.
  const key = `${find.length}:${find}${replace}`;
  const known = memo.get(key);
  if (known !== undefined) {
    memo.delete(key);
    memo.set(key, known);
    return known;
  }
  const tracked = track(find, replace);
  memo.set(key, tracked);
  if (memo.size > MEMO_SIZE) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  return tracked;
}

/** Forgets every remembered diff; the review calls it when its drafts are cleared. */
export function clearWordDiffs(): void {
  memo.clear();
}

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

/** Offset where the nearest `count` words of `text` end, counted from its start. */
function afterWords(text: string, count: number): number {
  let end = 0;
  let seen = 0;
  for (const match of text.matchAll(WORD)) {
    end = match.index + match[0].length;
    if (++seen === count) break;
  }
  return end;
}

/** Offset where the nearest `count` words of `text` start, counted from its end. */
function beforeWords(text: string, count: number): number {
  const starts = [...text.matchAll(WORD)].map((match) => match.index);
  return starts[Math.max(0, starts.length - count)] ?? text.length;
}

/**
 * Where the context after a change ends in the run that follows it: the rest
 * of the change's sentence when short enough, else its first words. Sentence
 * boundaries include line breaks, so context never runs into the next
 * paragraph.
 */
function leadingContext(run: string): number {
  const first = sentences.segment(run)[Symbol.iterator]().next();
  if (first.done) return 0;
  const sentence = first.value.segment;
  return countWords(sentence) <= CONTEXT_SENTENCE_WORDS
    ? sentence.length
    : afterWords(sentence, CONTEXT_WORDS);
}

/** Where the context before a change starts in the run that precedes it; as `leadingContext`. */
function trailingContext(run: string): number {
  let last: Intl.SegmentData | undefined;
  for (const segment of sentences.segment(run)) last = segment;
  if (last === undefined) return run.length;
  const sentence = last.segment;
  return countWords(sentence) <= CONTEXT_SENTENCE_WORDS
    ? last.index
    : last.index + beforeWords(sentence, CONTEXT_WORDS);
}

/** An unchanged run, folded when long, with context kept on the sides that touch a change. */
function unchanged(
  run: string,
  afterChange: boolean,
  beforeChange: boolean,
  collapseWords: number,
): Segment[] {
  if (run === "") return [];
  if (countWords(run) <= collapseWords) return [{ kind: "same", text: run }];
  const from = afterChange ? leadingContext(run) : 0;
  const to = beforeChange ? Math.max(from, trailingContext(run)) : run.length;
  const hidden = run.slice(from, to);
  const words = countWords(hidden);
  // Folding away a few words costs the reader more than it saves.
  if (words < CONTEXT_WORDS) return [{ kind: "same", text: run }];
  const segments: Segment[] = [];
  if (from > 0) segments.push({ kind: "same", text: run.slice(0, from) });
  segments.push({ kind: "collapsed", text: hidden, words });
  if (to < run.length) segments.push({ kind: "same", text: run.slice(to) });
  return segments;
}

/**
 * Where each change's reason row stands, as an offset into `text`: the end
 * of the sentence holding the change's end, before the line break that
 * closes it, never before the change itself. A row whose sentence runs into
 * a later change waits for that change's row, so the rows sharing a place
 * stack in text order. `ordered` is sorted by start and does not overlap.
 */
function reasonOffsets(text: string, ordered: readonly PlacedChange[]): number[] {
  const bounds = [...sentences.segment(text)];
  const offsets = ordered.map((change) => {
    if (change.end >= text.length) return change.end;
    const last = change.end > change.start ? change.end - 1 : change.start;
    const sentence = bounds.find(
      ({ index, segment }) => index <= last && last < index + segment.length,
    );
    if (sentence === undefined) return change.end;
    const end = sentence.index + sentence.segment.length;
    // A line break stays after the row, so a paragraph break still reads as one.
    const space = /\s*$/u.exec(sentence.segment)?.[0] ?? "";
    return Math.max(change.end, space.includes("\n") ? end - space.length : end);
  });
  for (let index = offsets.length - 2; index >= 0; index--) {
    const next = ordered[index + 1];
    const later = offsets[index + 1];
    if (next !== undefined && later !== undefined && (offsets[index] ?? 0) > next.start) {
      offsets[index] = later;
    }
  }
  return offsets;
}

/**
 * The field's original text as segments: unchanged runs (folded per R2) and
 * one segment per change, in text order. Joining every segment's text (a
 * change's `find`) gives back `text`. Changes come from `placeChanges` for
 * this field and do not overlap.
 */
export function segmentField(
  text: string,
  changes: PlacedChange[],
  options: SegmentOptions,
): Segment[] {
  const ordered = [...changes].sort((a, b) => a.start - b.start || a.at - b.at);
  const reasons = reasonOffsets(text, ordered);
  const segments: Segment[] = [];
  let offset = 0;
  for (const [index, change] of ordered.entries()) {
    segments.push(
      ...unchanged(text.slice(offset, change.start), index > 0, true, options.collapseWords),
    );
    const find = text.slice(change.start, change.end);
    const { runs, mode } = trackedChange(find, change.replace);
    segments.push({
      kind: "change",
      id: String(change.at),
      find,
      replace: change.replace,
      runs,
      mode,
      reasonAt: reasons[index] ?? change.end,
    });
    offset = change.end;
  }
  segments.push(...unchanged(text.slice(offset), ordered.length > 0, false, options.collapseWords));
  return segments;
}
