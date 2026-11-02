import { CREATOR_LIMITS as C } from "./limits.ts";
import {
  type BrainstormOption,
  brainstormOptionSchema,
  type CreatorKind,
  creatorKindSchema,
} from "./schema.ts";

/*
 * Reading a brainstorm answer: the classifier's word, and the ideas the model
 * writes one JSON object per line. Pure; the answer is a creation draft and
 * nothing here keeps it. An idea past its bound is invalid, never cut.
 */

const isKind = (word: string): word is CreatorKind => creatorKindSchema.safeParse(word).success;

/** The kind a classifier answer names: the whole trimmed answer in lowercase, else the last kind word in it; null for none. */
export function parseBrainstormKind(answer: string): CreatorKind | null {
  const whole = answer.trim().toLowerCase();
  if (isKind(whole)) return whole;
  const words: string[] = whole.match(/[a-z]+/g) ?? [];
  return words.findLast(isKind) ?? null;
}

/** The key two pitches are the same idea by: trimmed, lowercased, inner whitespace collapsed. */
export function pitchKey(pitch: string): string {
  return pitch.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A bullet or a number a model may write before a line's object. */
const LINE_MARKER = /^(?:[-*+•]|\d+[.)])\s*/;

/** One idea from a parsed value; null unless it is an object of two valid strings. */
function optionOf(value: unknown): BrainstormOption | null {
  const parsed = brainstormOptionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One idea from one answer line: a fence, bullet or number before the object is ignored; a line that is not an object of two valid strings is null. Nothing is cut. */
export function parseBrainstormOption(line: string): BrainstormOption | null {
  // An array's brackets and separating comma around the object go too, so an array written one
  // object per line streams every idea, its first and last included, as the final reading keeps them.
  // String steps, not a trailing regex: whitespace runs inside a line must not backtrack.
  let text = line.trim().replace(LINE_MARKER, "");
  if (text.startsWith("[")) text = text.slice(1).trimStart();
  if (text.endsWith(",")) text = text.slice(0, -1).trimEnd();
  if (text.endsWith("]")) text = text.slice(0, -1).trimEnd();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    return optionOf(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The ideas accepted so far: new by `pitchKey`, at most `brainstormOptions`. */
function optionList() {
  const options: BrainstormOption[] = [];
  const seen = new Set<string>();
  return {
    options,
    /** Whether `option` joined the list. */
    accept(option: BrainstormOption | null): option is BrainstormOption {
      if (option === null || options.length >= C.brainstormOptions) return false;
      const key = pitchKey(option.pitch);
      if (seen.has(key)) return false;
      seen.add(key);
      options.push(option);
      return true;
    },
  };
}

/**
 * Reads an answer as it streams: `push(text)` returns the ideas newly accepted
 * by the lines it completed (valid, not a duplicate by `pitchKey`, under ten);
 * `end()` flushes a last line without a newline the same way. `options` is
 * everything accepted so far, in order.
 */
export function brainstormReader(): {
  push(text: string): BrainstormOption[];
  end(): BrainstormOption[];
  readonly options: BrainstormOption[];
} {
  const list = optionList();
  let pending = "";
  const read = (lines: string[]) =>
    lines.map(parseBrainstormOption).filter((option) => list.accept(option));
  return {
    push(text) {
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      return read(lines);
    },
    end() {
      const last = pending;
      pending = "";
      return read([last]);
    },
    get options() {
      return list.options;
    },
  };
}

/**
 * The ideas of an answer written as one JSON array instead of one object per
 * line, as some models answer however they are asked: the text from its
 * first `[` to its last `]`, each valid element accepted as the reader would.
 */
function arrayOptions(answer: string): BrainstormOption[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start === -1 || end < start) return [];
  let value: unknown;
  try {
    value = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const list = optionList();
  for (const element of value) list.accept(optionOf(element));
  return list.options;
}

/**
 * A whole answer through `brainstormReader`; `ok` when exactly ten. The one
 * normalisation for live and final lists. An answer short of ten by its lines
 * is read once more as one JSON array, and the longer reading counts, so a
 * pretty-printed list or a compact one broken across lines still counts.
 */
export function parseBrainstormAnswer(answer: string): {
  ok: boolean;
  options: BrainstormOption[];
} {
  const reader = brainstormReader();
  reader.push(answer);
  reader.end();
  const lines = reader.options;
  const array = lines.length < C.brainstormOptions ? arrayOptions(answer) : [];
  const options = array.length > lines.length ? array : lines;
  return { ok: options.length === C.brainstormOptions, options };
}

/** The answer lines the model wrote for `options`, for an earlier round's assistant turn. */
export function brainstormAnswerLines(options: readonly BrainstormOption[]): string {
  return options.map(({ pitch, brief }) => JSON.stringify({ pitch, brief })).join("\n");
}
