/*
 * The one cheap token estimate, without a tokenizer: UTF-8 bytes over a
 * fixed ratio, so ASCII runs four characters a token and CJK close to one.
 * History block boundaries and the memory recap's weight both use it.
 */

/** UTF-8 bytes per token in the estimate; no tokenizer runs. */
export const BOUNDARY_BYTES_PER_TOKEN = 4;

const utf8 = new TextEncoder();

/** The UTF-8 byte length of `text`, a lone surrogate counted as U+FFFD. */
export const utf8Bytes = (text: string): number => utf8.encode(text).byteLength;

/** The estimated tokens of `text`. */
export const estimateTokens = (text: string): number =>
  Math.ceil(utf8Bytes(text) / BOUNDARY_BYTES_PER_TOKEN);

/** The UTF-8 bytes of one code point, a lone surrogate counted as U+FFFD. */
const codePointBytes = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/**
 * The longest end of `text` whose estimate is within `tokens`, cut at a
 * code point boundary: the latest state of a text that is too long.
 */
export function clipTailToTokens(text: string, tokens: number): string {
  const budget = Math.max(0, tokens) * BOUNDARY_BYTES_PER_TOKEN;
  if (utf8Bytes(text) <= budget) return text;
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    const low = text.charCodeAt(start - 1);
    const high = start > 1 ? text.charCodeAt(start - 2) : 0;
    const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
    const size = pair ? 2 : 1;
    const next = bytes + codePointBytes(text.codePointAt(start - size) ?? 0);
    if (next > budget) break;
    bytes = next;
    start -= size;
  }
  return text.slice(start);
}
