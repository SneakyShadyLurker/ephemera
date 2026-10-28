/** Text that starts a sentence: its first letter capitalized. */
export const sentence = (text: string): string =>
  text.charAt(0).toLocaleUpperCase() + text.slice(1);

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

/** What an art failure says when Atelier's worker stayed busy through the admission wait. */
export const COMFYUI_BUSY = "ComfyUI stayed busy with other work. Try again in a moment.";
