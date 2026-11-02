import { RE2JS, RE2JSSyntaxException } from "re2js";
import { CARD_LIMITS, clipText } from "../card/limits.ts";
import { clip, type KeyProblem, LOREBOOK_RULES } from "./rules.ts";

/*
 * Lorebook keys. **Decided:** a key is a pattern
 * when written `/pattern/flags` or when the entry's `useRegex`
 * is set (V3; the whole key is the pattern). Patterns run only on re2js,
 * which matches in linear time; card text never reaches the native `RegExp`.
 * Plain keys are case-insensitive unless the entry is case-sensitive; a key
 * without whitespace matches whole words by `Intl.Segmenter` boundaries
 * unless the entry turns whole words off, a key with whitespace anywhere in
 * a message.
 */

export { KEY_PROBLEMS, type KeyProblem } from "./rules.ts";

type ParsedKey =
  | { kind: "blank" }
  | { kind: "plain"; text: string }
  | { kind: "pattern"; source: string; flags: number };

/** JavaScript flags re2js honors; `g y d u v` change nothing for a yes-or-no match. */
const flagOf = (flag: string): number | undefined =>
  flag === "i"
    ? RE2JS.CASE_INSENSITIVE
    : flag === "m"
      ? RE2JS.MULTILINE
      : flag === "s"
        ? RE2JS.DOTALL
        : undefined;
const IGNORED_FLAGS = "gyduv";
/** Every flag JavaScript knows; a slash key with any other letter after it is plain text. */
const JS_FLAGS = "dgimsuvy";

/**
 * `/pattern/flags`: the last slash splits off the flags, which must be
 * JavaScript's. A key is treated as a pattern only with a valid
 * regex as a pattern, `/r/rpg` or `/usr/bin` is plain text.
 */
function slashForm(key: string): { source: string; flags: string } | null {
  if (!key.startsWith("/")) return null;
  const last = key.lastIndexOf("/");
  if (last <= 1) return null;
  const flags = key.slice(last + 1);
  for (const flag of flags) if (!JS_FLAGS.includes(flag)) return null;
  return { source: key.slice(1, last), flags };
}

/**
 * Keywords written as one text: split on commas, but not inside a
 * `/pattern/`, trimmed, empty ones dropped. One owner for the lorebook
 * editor and the rework, which reads a keyword list back from the model.
 */
export function splitKeywords(
  text: string,
  original?: {
    literals: ReadonlySet<number>;
    separators: ReadonlySet<number>;
    emptyKeys: ReadonlySet<number>;
    offset: number;
  },
): string[] {
  const keys: string[] = [];
  let start = 0;
  const add = (end: number) => {
    let left = start;
    let right = end;
    if (original !== undefined) {
      while (
        left < right &&
        /\s/.test(text[left] ?? "") &&
        !original.literals.has(original.offset + left)
      )
        left += 1;
      while (
        right > left &&
        /\s/.test(text[right - 1] ?? "") &&
        !original.literals.has(original.offset + right - 1)
      )
        right -= 1;
    }
    const key = text.slice(left, right);
    if (key.trim() !== "" || original?.emptyKeys.has(original.offset + left))
      keys.push(original === undefined ? key.trim() : key);
  };
  let first = -1;
  let lastSlash = -1;
  let lastNonWhitespace = -1;
  let flags = true;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    // Completeness is the old /^\/.+\/[a-z]*$/s rule, after trimming.
    // Track its last slash and suffix instead of rescanning a growing prefix.
    const complete = lastSlash > first + 1 && flags;
    if (
      char === "," &&
      !original?.literals.has(original.offset + at) &&
      (original?.separators.has(original.offset + at) ||
        first === -1 ||
        text[first] !== "/" ||
        complete)
    ) {
      add(at);
      start = at + 1;
      first = -1;
      lastSlash = -1;
      lastNonWhitespace = -1;
      flags = true;
      continue;
    }
    if (/\s/.test(char)) continue;
    if (first === -1) first = at;
    if (char === "/") {
      lastSlash = at;
      flags = true;
    } else {
      flags = flags && char >= "a" && char <= "z" && lastNonWhitespace === at - 1;
    }
    lastNonWhitespace = at;
  }
  add(text.length);
  return keys;
}

/** Keywords as one text, the inverse of `splitKeywords` for keys without a comma outside a pattern. */
export const joinKeywords = (keys: readonly string[]): string => keys.join(", ");

/** Keys added once each, within the card's count and length limits. */
export function addKeywords(keys: readonly string[], added: readonly string[]): string[] {
  const next = [...keys];
  for (const key of added) {
    const clipped = clipText(key, CARD_LIMITS.shortTextLength);
    if (clipped.trim() === "" || next.includes(clipped)) continue;
    if (next.length >= CARD_LIMITS.tags) break;
    next.push(clipped);
  }
  return next;
}

/** How a key (macros already filled) is matched. */
export function parseKey(key: string, useRegex: boolean): ParsedKey {
  if (key.trim() === "") return { kind: "blank" };
  const slashed = slashForm(key);
  if (slashed === null) {
    return useRegex
      ? { kind: "pattern", source: key, flags: 0 }
      : { kind: "plain", text: key.trim() };
  }
  let flags = 0;
  for (const flag of slashed.flags) {
    if (!IGNORED_FLAGS.includes(flag)) flags |= flagOf(flag) ?? 0;
  }
  return { kind: "pattern", source: slashed.source, flags };
}

/** Whether a counted repetition (`{m}`, `{m,}`, `{m,n}`) passes `maxPatternRepeat`. */
function repeatTooLarge(source: string): boolean {
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char !== "{") continue;
    let j = i + 1;
    let bound = "";
    while (j < source.length && /[\d,]/.test(source[j] ?? "")) {
      bound += source[j];
      j += 1;
    }
    if (source[j] !== "}" || !/^\d+(,\d*)?$/.test(bound)) continue;
    if (
      bound.split(",").some((part) => part !== "" && Number(part) > LOREBOOK_RULES.maxPatternRepeat)
    )
      return true;
  }
  return false;
}

/** Lookaround and backreferences, which RE2 refuses by design, told apart from typos. */
function syntaxProblem(error: RE2JSSyntaxException): KeyProblem {
  const piece = error.getPattern() ?? "";
  const description = error.getDescription();
  if (/^\(\?<?[=!]/.test(piece)) return "unsupportedPattern";
  if (description === "invalid escape sequence" && /^\\(?:[1-9]|k<)/.test(piece))
    return "unsupportedPattern";
  if (description === "invalid repeat count") return "repeatTooLarge";
  return "invalidPattern";
}

/** Compiles a pattern key on re2js, or says why it never matches. */
export function compilePattern(source: string, flags: number): RE2JS | KeyProblem {
  if (repeatTooLarge(source)) return "repeatTooLarge";
  try {
    // JavaScript's \u escapes and named groups, in RE2's spelling.
    return RE2JS.compile(RE2JS.translateRegExp(source), flags);
  } catch (error) {
    return error instanceof RE2JSSyntaxException ? syntaxProblem(error) : "invalidPattern";
  }
}

/** Why a key as written can never match, for the editor; null when it can. */
export function keyProblem(key: string, useRegex: boolean): KeyProblem | null {
  const parsed = parseKey(key, useRegex);
  if (parsed.kind !== "pattern") return null;
  const compiled = compilePattern(parsed.source, parsed.flags);
  return typeof compiled === "string" ? compiled : null;
}

const costs = LOREBOOK_RULES.scanCosts;

/** Counts the scan's work; once a charge would pass the bound, the scan is exhausted. */
export class WorkMeter {
  used = 0;
  exhausted = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Adds `units` when they fit; false (and exhausted from then on) when they do not. */
  charge(units: number): boolean {
    if (this.exhausted || this.used + units > this.limit) {
      this.exhausted = true;
      return false;
    }
    this.used += units;
    return true;
  }
}

/** One scanned message, with its lowercase form and word boundaries computed once. */
export class ScannedMessage {
  private lower: string | undefined;
  private readonly boundaries = new Map<boolean, Uint8Array>();
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  /** The text keys of this case mode search; null when the meter runs out. */
  haystack(folded: boolean, meter: WorkMeter): string | null {
    if (!folded) return this.text;
    if (this.lower === undefined) {
      if (!meter.charge(this.text.length * costs.lowerChar)) return null;
      this.lower = this.text.toLowerCase();
    }
    return this.lower;
  }

  /** 1 at every word boundary of `haystack(folded)`, the ends included. */
  wordBoundaries(folded: boolean, meter: WorkMeter): Uint8Array | null {
    const known = this.boundaries.get(folded);
    if (known !== undefined) return known;
    const text = this.haystack(folded, meter);
    if (text === null || !meter.charge(text.length * costs.segmentChar)) return null;
    const marks = new Uint8Array(text.length + 1);
    for (const segment of segmenter().segment(text)) marks[segment.index] = 1;
    marks[text.length] = 1;
    this.boundaries.set(folded, marks);
    return marks;
  }
}

let words: Intl.Segmenter | undefined;
const segmenter = () => {
  words ??= new Intl.Segmenter(undefined, { granularity: "word" });
  return words;
};

/** The result of one key against one message: the matched text, no match, or out of work. */
export const EXHAUSTED: unique symbol = Symbol("exhausted");
export type KeyMatch = string | null | typeof EXHAUSTED;

/** The original-case text at a match in the (possibly lowercased) haystack. */
function original(message: ScannedMessage, haystack: string, at: number, length: number): string {
  const source = haystack.length === message.text.length ? message.text : haystack;
  return clip(source.slice(at, at + length));
}

const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
/** Whether the code point starting at `at` is a letter, digit or mark. */
const wordCharAt = (text: string, at: number) => {
  const code = text.codePointAt(at);
  return code !== undefined && WORD_CHAR.test(String.fromCodePoint(code));
};
/** Whether the code point ending just before `at` is a letter, digit or mark. */
const wordCharBefore = (text: string, at: number) => {
  if (at === 0) return false;
  const low = text.charCodeAt(at - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && at >= 2 ? at - 2 : at - 1;
  return wordCharAt(text, start);
};

/**
 * A plain key against one message. With `wholeWords` a key without
 * whitespace matches only as a whole word; a key with whitespace, or any key
 * without `wholeWords`, matches anywhere.
 */
export function matchPlain(
  key: string,
  modes: { caseSensitive: boolean; wholeWords: boolean },
  message: ScannedMessage,
  meter: WorkMeter,
): KeyMatch {
  const { caseSensitive, wholeWords } = modes;
  const folded = !caseSensitive;
  const needle = folded ? key.toLowerCase() : key;
  const haystack = message.haystack(folded, meter);
  if (haystack === null) return EXHAUSTED;
  if (!meter.charge(haystack.length + needle.length + costs.check)) return EXHAUSTED;
  let at = haystack.indexOf(needle);
  if (at === -1) return null;
  if (!wholeWords || /\s/.test(needle)) return original(message, haystack, at, needle.length);
  const marks = message.wordBoundaries(folded, meter);
  if (marks === null) return EXHAUSTED;
  while (at !== -1) {
    const end = at + needle.length;
    // A word boundary, or punctuation beside the key: "Maren" matches "Maren's",
    // which the segmenter keeps as one word, but not "Marena".
    if (
      (marks[at] === 1 || !wordCharBefore(haystack, at)) &&
      (marks[end] === 1 || !wordCharAt(haystack, end))
    ) {
      return original(message, haystack, at, needle.length);
    }
    if (!meter.charge(costs.occurrence)) return EXHAUSTED;
    at = haystack.indexOf(needle, at + 1);
  }
  return null;
}

/** A compiled pattern key against one message. */
export function matchPattern(pattern: RE2JS, message: ScannedMessage, meter: WorkMeter): KeyMatch {
  const instructions = Number(pattern.re2().numberOfInstructions()) || 1;
  const length = message.text.length;
  const testCost = length * (costs.patternChar + instructions * costs.patternInstChar);
  if (!meter.charge(testCost + costs.check)) return EXHAUSTED;
  if (!pattern.test(message.text)) return null;
  // The position search runs the slower Pike VM; without the work for it, the key
  // still matched but its text is not reported.
  if (!meter.charge(length * instructions * costs.matchInstChar)) return "";
  const matcher = pattern.matcher(message.text);
  return matcher.find() ? clip(matcher.group() ?? "") : "";
}

/** The work to compile a pattern, charged after compiling it once. */
export function compileCost(pattern: RE2JS | KeyProblem): number {
  if (typeof pattern === "string") return costs.compile;
  return costs.compile + Number(pattern.re2().numberOfInstructions()) * costs.compileInst;
}
