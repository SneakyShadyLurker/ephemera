import { isRecord } from "../card/json.ts";

/*
 * A model's parsed JSON answer brought within its schema's bounds before the
 * schema reads it, so a slightly oversized answer is kept rather than
 * retried. Shared by the memory and the cast answers; imports nothing that
 * imports `chat.ts`.
 */

/**
 * `text` trimmed and cut to `max` UTF-16 units, at the last word break when
 * there is one, and never inside a macro such as `{{user}}`, as an answer's
 * strings are.
 */
export function cutText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  let kept = trimmed.slice(0, max);
  // A cut between two words loses nothing of either; else back to the last break.
  const whole = /\s/.test(trimmed.charAt(max));
  const space = kept.search(/\s\S*$/);
  if (!whole && space > 0) kept = kept.slice(0, space);
  const open = kept.lastIndexOf("{{");
  if (open !== -1 && !kept.includes("}}", open)) kept = kept.slice(0, open);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return kept.trimEnd();
}

/** A string cut to `max`; anything else as it came, for the schema to refuse. */
export const clampText = (value: unknown, max: number): unknown =>
  typeof value === "string" ? cutText(value, max) : value;

/** A list's strings cut to `max` each, blank ones dropped, at most `count` kept. */
export const clampLines = (value: unknown, max: number, count: number): unknown =>
  Array.isArray(value)
    ? value
        .map((item) => clampText(item, max))
        .filter((item) => item !== "")
        .slice(0, count)
    : value;

/** The keys `shape` names, each clamped by its function; a key the answer lacks stays absent. */
export function clampKeys(
  value: unknown,
  shape: Record<string, (field: unknown) => unknown>,
): unknown {
  if (!isRecord(value)) return value;
  const clamped: Record<string, unknown> = {};
  for (const [key, clamp] of Object.entries(shape)) {
    if (key in value) clamped[key] = clamp(value[key]);
  }
  return clamped;
}
