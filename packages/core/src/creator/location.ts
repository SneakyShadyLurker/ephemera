/*
 * The Location line that opens a card's opening (the creator prompts) and
 * every reply (DEFAULT_FORMAT_PROMPT): `> Location: place, time`, then an
 * empty line. Models often drop the quote mark or the empty line, so the
 * creator sets each opening in this shape and the chat shows replies in it.
 */

/**
 * The label of a Location line, read on one line: an optional quote mark,
 * Markdown emphasis around the word, then its colon, or the end of a line
 * still streaming in. No two runs of it match the same characters, so it
 * takes linear time on untrusted text.
 */
const LOCATION_LABEL = /^(?:>[ \t]*)?([*_]*)location\b([*_]*)[ \t]*(?::|$)([*_]*)[ \t]*/i;

/** The opening's Location line without its quote mark, or "" when it opens without one. */
export function locationLine(opening: string): string {
  const first = opening.trim().split("\n")[0]?.trim() ?? "";
  return LOCATION_LABEL.test(first) ? first.replace(/^>\s*/, "") : "";
}

/**
 * A text that opens with a Location line, with that line set as
 * `> Location: place` and an empty line before the rest; the rest is left
 * as it is. Any other text comes back unchanged.
 */
export function formatLocationLine(text: string): string {
  const start = text.trimStart();
  const newline = start.indexOf("\n");
  const first = newline === -1 ? start : start.slice(0, newline);
  const label = LOCATION_LABEL.exec(first);
  if (label === null) return text;
  const [matched, open = "", ...closes] = label;
  let place = first.slice(matched.length).trim();
  // Emphasis opened before the label and not closed in it wraps the whole line.
  if (open !== "" && closes.join("") === "" && place.endsWith(open)) {
    place = place.slice(0, -open.length).trim();
  }
  const location = `> Location: ${place}`.trimEnd();
  const rest = newline === -1 ? "" : start.slice(newline + 1).replace(/^\s+/, "");
  return rest === "" ? location : `${location}\n\n${rest}`;
}
