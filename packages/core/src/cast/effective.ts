import { z } from "zod";
import { withoutHighlights } from "../preset/highlight.ts";
import { givenName, isEverydayName, wholeName } from "../prompt/names.ts";
import { castKey } from "./key.ts";
import { CAST_LIMITS } from "./limits.ts";
import {
  CAST_ANCHOR_FIELDS,
  type CastAnchor,
  type CastChanges,
  type CastEntry,
  type CastRegister,
  castContinuitySchema,
  rememberedCastAnchorSchema,
  setAnchorFields,
} from "./register.ts";

/** One precedence rule for every reader. Owner corrections may explicitly clear a field. */
export const effectiveCastAnchor = (
  entry: Pick<CastEntry, "anchor" | "developments">,
  correction: Partial<CastAnchor> = {},
): CastAnchor => {
  const anchor = { ...entry.anchor };
  for (const field of CAST_ANCHOR_FIELDS) {
    const value = entry.developments?.[field];
    if (value !== undefined) anchor[field] = value;
  }
  return { ...anchor, ...correction };
};

/** The anchor as the player knows it, never a fallback to hidden canon. */
export const discoveredCastAnchor = (
  entry: Pick<CastEntry, "anchor" | "discovered">,
  correction: Partial<CastAnchor> = {},
): CastAnchor => {
  const anchor = { ...entry.anchor };
  for (const field of CAST_ANCHOR_FIELDS) anchor[field] = entry.discovered?.[field]?.value ?? "";
  return { ...anchor, ...correction };
};

/** A panel entry: public discoveries and corrections, with canonical overrides left out. */
export const discoveredCastEntry = (
  entry: CastEntry,
  correction: Partial<CastAnchor> = {},
): CastEntry => {
  const { developments: _developments, continuity: _continuity, ...rest } = entry;
  return { ...rest, anchor: discoveredCastAnchor(entry, correction) };
};

/** Identity recovery must never borrow knowledge or developments from a future scene. */
export const castIdentity = ({
  developments: _developments,
  continuity: _continuity,
  introduced: _introduced,
  discovered: _discovered,
  ...entry
}: CastEntry): CastEntry => entry;

/**
 * A text as a quote is compared: highlight markup and Markdown emphasis out,
 * quotation marks, dashes and ellipses in one spelling, spacing collapsed,
 * lower case. A model copies words, seldom their typography.
 */
const quoteKey = (text: string): string =>
  withoutHighlights(text)
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032`]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** What a quote opens and closes with beyond its words: its own quotation marks, an elision. */
const QUOTE_EDGE = /^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g;

/**
 * Whether `evidence` quotes one of the shown turns: its whole words in
 * their order, within one turn, compared as `quoteKey` reads both. This is
 * grounding, not semantic proof.
 */
const quotedIn = (keys: readonly string[], evidence: string): boolean => {
  const quote = quoteKey(evidence).replace(QUOTE_EDGE, "");
  if (quote === "") return false;
  // Whole words at both ends: "red" is not quoted by "tired".
  const pattern = wholeName(quote);
  return keys.some((key) => pattern.test(key));
};

/** The keeper's changes with every introduction and evidenced field a shown turn does not quote left out. */
export function groundedCastChanges(changes: CastChanges, shown: readonly string[]): CastChanges {
  const keys = shown.map(quoteKey);
  const grounded = <T extends Record<string, { value: string; evidence: string } | undefined>>(
    fields: T,
  ): T =>
    Object.fromEntries(
      Object.entries(fields).filter(
        ([, item]) =>
          item !== undefined && item.value.trim() !== "" && quotedIn(keys, item.evidence),
      ),
    ) as T;
  return {
    ...changes,
    cast: Object.fromEntries(
      Object.entries(changes.cast).map(([name, change]) => {
        const { introduce: candidate, ...rest } = change;
        const introduce =
          candidate !== undefined && quotedIn(keys, candidate.evidence)
            ? { introduce: candidate }
            : {};
        return [
          name,
          {
            ...rest,
            ...introduce,
            ...(change.developments === undefined
              ? {}
              : { developments: grounded(change.developments) }),
            ...(change.continuity === undefined ? {} : { continuity: grounded(change.continuity) }),
            ...(change.discovered === undefined ? {} : { discovered: grounded(change.discovered) }),
          },
        ];
      }),
    ),
  };
}

/** A hyphen that joins a compound name, as models write it: "Ann-Marie" does not name Ann. */
const JOINER = "[-\\u2010\\u2011]";

/** What stands before a word that opens a sentence, a line or a quotation. */
const SENTENCE_START = /(?:^|[.!?…:\n])[\s"'“‘«([*_~-]*$/u;

/** What follows a name that opens a scene line's cue: ` (25): `. */
const CUE_AFTER = /^ \(\d{1,4}\):/;

/**
 * The entries a shown turn names, by index: by the whole name, an earlier
 * name, or the given name when no other entry's name and not the player's
 * holds that word. Names are read as written and as whole words, in the
 * text without its highlight markup. A one-word name that is an everyday
 * word too (`isEverydayName`) counts only where a sentence would not
 * capitalise it anyway, or where it opens a scene line's cue. A story that
 * writes someone's name has told the player of them, whatever the keeper
 * answered.
 */
export function namedInTurns(
  entries: readonly Pick<CastEntry, "anchor" | "aka">[],
  shown: readonly string[],
  player: string | null,
): Set<number> {
  const named = new Set<number>();
  if (shown.length === 0) return named;
  const texts = shown.map((text) => withoutHighlights(text).normalize("NFC"));
  const written = (name: string): boolean => {
    const form = name.normalize("NFC").trim();
    if (form === "") return false;
    const pattern = new RegExp(
      `(?<!\\p{L}${JOINER})${wholeName(form).source}(?!${JOINER}\\p{L})`,
      "gu",
    );
    const everyday = !/\s/.test(form) && isEverydayName(form);
    return texts.some((text) =>
      text
        .matchAll(pattern)
        .some(
          ({ index, 0: found }) =>
            !everyday ||
            !SENTENCE_START.test(text.slice(0, index)) ||
            CUE_AFTER.test(text.slice(index + found.length)),
        ),
    );
  };
  const words = (name: string) => castKey(name).split(" ");
  const playerWords = player === null ? [] : words(player);
  const taken = (form: string, at: number): boolean => {
    const key = castKey(form);
    return (
      playerWords.includes(key) ||
      entries.some(
        (other, index) =>
          index !== at &&
          [other.anchor.name, ...other.aka].some((name) => words(name).includes(key)),
      )
    );
  };
  for (const [at, entry] of entries.entries()) {
    const first = givenName(entry.anchor.name);
    if (
      [entry.anchor.name, ...entry.aka].some(written) ||
      (first !== null && !taken(first, at) && written(first))
    )
      named.add(at);
  }
  return named;
}

/** Request-only archivist context: no ids, aliases, role or volatile scene state. */
export const memoryCastContextSchema = z
  .array(
    z.strictObject({
      anchor: rememberedCastAnchorSchema,
      continuity: castContinuitySchema.exactOptional(),
    }),
  )
  .max(CAST_LIMITS.entries);
export type MemoryCastContext = z.infer<typeof memoryCastContextSchema>;

export const memoryCastContext = (register: CastRegister): MemoryCastContext =>
  register.entries.map((entry) => {
    const anchor = effectiveCastAnchor(entry);
    return {
      anchor: { name: anchor.name, gender: anchor.gender, ...setAnchorFields(anchor) },
      ...(entry.continuity === undefined ? {} : { continuity: entry.continuity }),
    };
  });
