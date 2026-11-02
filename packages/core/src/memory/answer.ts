import type { z } from "zod";
import { CREATOR_LIMITS } from "../creator/limits.ts";
import { readMemoryCastLine } from "./cast.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import { withUserPlaceholder } from "./prompt.ts";

/*
 * Reading a memory call's answer: the protocol rules between the model's
 * text and the memory the server writes. Pure; the answer is chat content
 * until it validates, and nothing here keeps it.
 */

/**
 * How many characters `repairObject` may scan per character of the answer,
 * across all its candidates. A few stray braces cost one pass each; an
 * answer of thousands of unclosed ones would otherwise cost one pass per
 * brace, synchronously on the server every user shares.
 */
const REPAIR_SCAN_PER_CHARACTER = 8;

/**
 * Where the balanced `{ … }` block starting at `start` ends, read as JSON
 * would (braces inside strings do not count), or -1 when it never closes
 * within the text or within `budget.left` scanned characters, which it
 * spends.
 */
function closingBrace(text: string, start: number, budget: { left: number }): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const stop = Math.min(text.length, start + budget.left);
  for (let at = start; at < stop; at += 1) {
    const char = text[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        budget.left -= at + 1 - start;
        return at;
      }
    }
  }
  budget.left -= stop - start;
  return -1;
}

/**
 * The last balanced `{ … }` block of a model's answer that reads as JSON
 * and, brought within its bounds by `clamp` (core's `clampMemoryAnswer` and
 * `clampChapterOutput`), checks against `schema`: the one repair of an
 * answer wrapped in prose or a code fence, one that writes a draft before
 * its final object, or one past a bound. Every `{` starts a candidate but
 * those inside a block that already read as JSON, so a stray brace in the
 * prose costs one pass. The scan stops once it has read
 * `REPAIR_SCAN_PER_CHARACTER` times the answer's length, keeping what it
 * found. Undefined when no block validates.
 */
export function repairObject<T>(
  text: string | undefined,
  schema: z.ZodType<T>,
  clamp: (value: unknown) => unknown = (value) => value,
): T | undefined {
  if (text === undefined) return undefined;
  let found: T | undefined;
  const budget = { left: REPAIR_SCAN_PER_CHARACTER * text.length };
  let start = text.indexOf("{");
  while (start !== -1 && budget.left > 0) {
    const end = closingBrace(text, start, budget);
    let next = start + 1;
    if (end !== -1) {
      let value: unknown;
      let read = true;
      try {
        value = JSON.parse(text.slice(start, end + 1));
      } catch {
        read = false;
      }
      if (read) {
        const parsed = schema.safeParse(clamp(value));
        if (parsed.success) found = parsed.data;
        // A block that read as JSON is one candidate: the objects inside it are its own.
        next = end + 1;
      }
    }
    start = text.indexOf("{", next);
  }
  return found;
}

/**
 * A memory call's answer with each of the persona's name `forms`
 * (`userNameForms`) as `{{user}}` in every string, brought within its bounds
 * again since the placeholder can be longer than the name. Optional cast
 * edits that outgrow their bounds are discarded by the memory clamp.
 */
export function unnamedAnswer<T>(
  value: T,
  forms: readonly string[],
  schema: z.ZodType<T>,
  clamp: (value: unknown) => unknown,
): T {
  if (forms.length === 0) return value;
  const swapText = (text: string): string => {
    const anchor = readMemoryCastLine(text);
    return anchor === null
      ? forms.reduce(withUserPlaceholder, text)
      : JSON.stringify(
          Object.fromEntries(
            Object.entries(anchor).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, forms.reduce(withUserPlaceholder, value)]],
            ),
          ),
        );
  };
  const swap = (field: unknown): unknown =>
    typeof field === "string"
      ? swapText(field)
      : Array.isArray(field)
        ? field.map(swap)
        : typeof field === "object" && field !== null
          ? Object.fromEntries(Object.entries(field).map(([key, item]) => [key, swap(item)]))
          : field;
  const parsed = schema.safeParse(clamp(swap(value)));
  return parsed.success ? parsed.data : value;
}

/**
 * An object call's room for its answer: what the `window` leaves after
 * `inputTokens` (counted and calibrated by the caller), at most
 * `CREATOR_LIMITS.maxOutputTokens`. Null when the input leaves less than
 * `MEMORY_LIMITS.replyReserve`.
 */
export function answerRoom(window: number, inputTokens: number): number | null {
  const left = Math.floor(window - inputTokens);
  return left < MEMORY_LIMITS.replyReserve ? null : Math.min(left, CREATOR_LIMITS.maxOutputTokens);
}
