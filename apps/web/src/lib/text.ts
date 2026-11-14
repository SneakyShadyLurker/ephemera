import { textLength, type UpstreamFailure } from "@ephemera/core";
import type { ChangeEvent } from "react";

/** Text that starts a sentence: its first letter capitalized. */
export const sentence = (text: string): string =>
  text.charAt(0).toLocaleUpperCase() + text.slice(1);

/**
 * The props that hold a controlled field to `limit` characters. Core's limits
 * count code points (`textLength`), the `maxLength` attribute UTF-16 units,
 * so the attribute allows one more for each character `value` already writes
 * as two: a text within its limit is never refused more typing. Replacing
 * such characters could then let more characters in than the limit, so a
 * change past it is fitted (`fitChange`) before the field's own `onChange`
 * reads it. The attribute is the one of the text before an edit, so a paste
 * of two-unit characters can stop short of the limit; typing goes on to it.
 */
export const charLimit = (limit: number, value: string) => ({
  maxLength: limit + value.length - textLength(value),
  onChangeCapture: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const field = event.target;
    const fitted = fitChange(limit, value, field.value, field.selectionEnd ?? field.value.length);
    if (fitted.text === field.value) return;
    field.value = fitted.text;
    field.setSelectionRange(fitted.caret, fitted.caret);
  },
});

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * An edit from `previous` to `next`, held to `limit` characters as a field's
 * `maxLength` holds typing. What an edit puts in ends at the caret, `end`, so
 * the characters over the limit are taken from just before it: only text the
 * edit itself put in is cut, never text around it. A text already past its
 * limit may shrink or keep its length, and never grows.
 */
export function fitChange(
  limit: number,
  previous: string,
  next: string,
  end: number,
): { text: string; caret: number } {
  const most = Math.max(limit, textLength(previous));
  const over = textLength(next) - most;
  if (over <= 0) return { text: next, caret: end };
  let start = end;
  // One character back: two units when they are a pair, as `textLength` counts them.
  const back = () => {
    const pair =
      start > 1 &&
      isLowSurrogate(next.charCodeAt(start - 1)) &&
      isHighSurrogate(next.charCodeAt(start - 2));
    start -= pair ? 2 : 1;
  };
  for (let cut = 0; cut < over && start > 0; cut += 1) back();
  const fitted = () => next.slice(0, start) + next.slice(end);
  // Units a cut parted from their pair across the caret count on their own: measure what is left.
  while (start > 0 && textLength(fitted()) > most) back();
  return { text: fitted(), caret: start };
}

/** `charLimit` from the props of a field that holds its text as `value`; nothing for one without a limit. */
export const charLimitOf = (props: { maxLength?: number | undefined; value?: unknown }) =>
  props.maxLength === undefined || typeof props.value !== "string"
    ? {}
    : charLimit(props.maxLength, props.value);

const NUMBER = new Intl.NumberFormat("en");
/** A count as the interface prints it: "1,234". */
export const formatCount = (value: number): string => NUMBER.format(value);

const PLURAL = new Intl.PluralRules("en");
/** A count with its noun, as the interface prints it: "1 entry", "1,234 entries". */
export const countOf = (value: number, one: string, other = `${one}s`): string =>
  `${formatCount(value)} ${PLURAL.select(value) === "one" ? one : other}`;

// Lists in the docs' style, without a serial comma: "a, b and c".
const AND = new Intl.ListFormat("en-GB", { type: "conjunction" });
const OR = new Intl.ListFormat("en-GB", { type: "disjunction" });
/** "a", "a and b", "a, b and c". */
export const andList = (items: readonly string[]): string => AND.format(items);
/** "a", "a or b", "a, b or c". */
export const orList = (items: readonly string[]): string => OR.format(items);

/**
 * The items a sentence names, at most `limit` parts: every item when they
 * fit, else the first `limit - 1` and how many more ("3 more"), so a list
 * never ends on "1 more".
 */
export function bounded<T>(
  items: readonly T[],
  limit: number,
): { shown: readonly T[]; more: string | null } {
  if (items.length <= limit) return { shown: items, more: null };
  const shown = items.slice(0, limit - 1);
  return { shown, more: `${formatCount(items.length - shown.length)} more` };
}

/** Names joined with "and", at most `limit` parts (`bounded`). */
export function boundedAndList(names: readonly string[], limit: number): string {
  const { shown, more } = bounded(names, limit);
  return andList(more === null ? shown : [...shown, more]);
}

/** What a model call's failure says when its provider stayed busy through the server's retries. */
export const MODEL_BUSY = "The model is busy. Try again in a moment.";

/** What a model call's failure says when its provider refused the sign-in or holds none that works. */
export const MODEL_SIGNED_OUT =
  "The model's provider has no working sign-in. Check its key or login, then try again.";

/** What a model call's failure says for each of its provider's own failures. */
export const UPSTREAM_NOTE: Record<UpstreamFailure, string> = {
  upstream_busy: MODEL_BUSY,
  upstream_signed_out: MODEL_SIGNED_OUT,
};

/** What an art failure says when Atelier's worker stayed busy through the admission wait. */
export const COMFYUI_BUSY = "ComfyUI stayed busy with other work. Try again in a moment.";
