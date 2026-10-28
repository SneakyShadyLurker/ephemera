/** Import and edit limits for character cards (PRINCIPLES.md 3). One owner: server and web read these. */
export const CARD_LIMITS = {
  /** Largest accepted upload, PNG or JSON. */
  uploadBytes: 32 * 1024 * 1024,
  /** Largest card JSON after decoding from a PNG chunk or file. */
  cardJsonBytes: 8 * 1024 * 1024,
  nameLength: 200,
  /** Any other text field. */
  textLength: 256 * 1024,
  /** Short identity fields: nickname, creator, version, tags. */
  shortTextLength: 200,
  tagLength: 64,
  tags: 100,
  alternateGreetings: 200,
  lorebookEntries: 5_000,
  assets: 100,
  sources: 50,
  /** Nesting depth of extension data. */
  jsonDepth: 64,
} as const;

/** Multipart overhead allowed on top of the file itself. */
const MULTIPART_SLACK = 64 * 1024;

/** The largest JSON request body: one entity, a card's fields, a persona or a preset file. */
export const MAX_JSON_BYTES = CARD_LIMITS.cardJsonBytes + MULTIPART_SLACK;

/** The largest request body any route accepts, an upload with its multipart overhead. */
export const MAX_REQUEST_BYTES = CARD_LIMITS.uploadBytes + MULTIPART_SLACK;

/**
 * Length in Unicode code points, the unit Zod's string `.max()` counts
 * (zod.dev/api#strings), so a text within a limit here passes the schemas
 * and one that passes them is not cut on the next import.
 */
export function textLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** Text cut to `max` code points, as `textLength` counts them. */
export function clipText(text: string, max: number): string {
  // A code point is one or two UTF-16 units: text within `max` units is within `max` code points.
  if (text.length <= max) return text;
  let end = 0;
  let kept = 0;
  for (const char of text) {
    if (kept === max) break;
    end += char.length;
    kept += 1;
  }
  return text.slice(0, end);
}
