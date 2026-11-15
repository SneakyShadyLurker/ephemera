import search from "approx-string-match";
import { z } from "zod";
import { withoutHighlights } from "../preset/highlight.ts";
import { givenName, WORD, wholeName } from "../prompt/names.ts";
import { castKey } from "./key.ts";
import { CAST_LIMITS } from "./limits.ts";
import {
  CAST_ANCHOR_FIELDS,
  type CastAnchor,
  type CastChange,
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

/** A panel entry: public discoveries and corrections, with canonical overrides, cues and hidden state left out. */
export const discoveredCastEntry = (
  entry: CastEntry,
  correction: Partial<CastAnchor> = {},
): CastEntry => {
  const { developments: _developments, continuity: _continuity, hidden: _hidden, ...rest } = entry;
  return { ...rest, anchor: discoveredCastAnchor(entry, correction) };
};

/** Identity recovery must never borrow knowledge, developments, hidden state or recency from a future scene. */
export const castIdentity = ({
  developments: _developments,
  continuity: _continuity,
  introduced: _introduced,
  discovered: _discovered,
  seen: _seen,
  hidden: _hidden,
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

/** What a quote opens and closes with beyond its words: its own quotation marks, an elision, bracketed or not. */
const QUOTE_EDGE = /^[\s"'.,;:!?[\]-]+|[\s"'.,;:!?[\]-]+$/g;

/** An elision inside a quote, as `quoteKey` spells it: three dots or more, bracketed or not. */
const ELISION = /\s*\[?\.{3,}\]?\s*/;

/** A text's words, as a near-exact quote is compared: punctuation between them says nothing. */
const WORDS = new RegExp(`${WORD}+(?:'${WORD}+)*`, "gu");

/** The fewest words a quote has to be compared nearly: a shorter one stays exact. */
const NEAR_WORDS = 6;

/**
 * Whether the words `quote` are a run of the words `turn` with at most one
 * word in ten missing, added or different: one word for a quote of up to
 * nineteen, two from twenty. Each of the quote's distinct words is one
 * symbol and every other word of the turn another, so the approximate
 * search counts whole words, never letters.
 */
function nearlyQuoted(turn: readonly string[], quote: readonly string[]): boolean {
  const symbols = new Map<string, string>();
  for (const word of quote)
    if (!symbols.has(word)) symbols.set(word, String.fromCharCode(0x100 + symbols.size));
  const symbolsOf = (words: readonly string[]) =>
    words.map((word) => symbols.get(word) ?? "\u00ff").join("");
  const allowed = Math.max(1, Math.floor(quote.length / 10));
  return search(symbolsOf(turn), symbolsOf(quote), allowed).length > 0;
}

/**
 * Whether `evidence` quotes one of the shown turns, compared as `quoteKey`
 * reads both: its whole words in their order; or, around an elision, every
 * part so in that turn, in the quote's order; or, for a quote of at least
 * `NEAR_WORDS` words, nearly so (`nearlyQuoted`). Always within one turn:
 * words of two turns ground nothing. This is grounding, not semantic proof.
 */
const quotedIn = (keys: readonly string[], evidence: string): boolean => {
  const quote = quoteKey(evidence).replace(QUOTE_EDGE, "");
  if (quote === "") return false;
  const parts = quote
    .split(ELISION)
    .map((part) => part.replace(QUOTE_EDGE, ""))
    .filter((part) => part !== "");
  const words = quote.match(WORDS) ?? [];
  return keys.some((key) => {
    // Whole words at both ends: "red" is not quoted by "tired".
    if (wholeName(quote).test(key)) return true;
    if (parts.length > 1) {
      let from = 0;
      const inOrder = parts.every((part) => {
        const pattern = wholeName(part, "gu");
        pattern.lastIndex = from;
        const found = pattern.exec(key);
        if (found !== null) from = found.index + found[0].length;
        return found !== null;
      });
      if (inOrder) return true;
    }
    return words.length >= NEAR_WORDS && nearlyQuoted(key.match(WORDS) ?? [], words);
  });
};

/**
 * The keeper's changes with every introduction and evidenced item a shown
 * turn does not quote left out: developments, continuity cues, knowledge
 * items, hidden fields and discoveries. A hidden field sent as "" ends one
 * and needs no quote.
 */
export function groundedCastChanges(changes: CastChanges, shown: readonly string[]): CastChanges {
  const keys = shown.map(quoteKey);
  const quoted = (item: { value: string; evidence: string }): boolean =>
    item.value.trim() !== "" && quotedIn(keys, item.evidence);
  const grounded = <T extends Record<string, { value: string; evidence: string } | "" | undefined>>(
    fields: T,
  ): T =>
    Object.fromEntries(
      Object.entries(fields).filter(
        ([, item]) => item !== undefined && (item === "" || quoted(item)),
      ),
    ) as T;
  const groundedContinuity = ({
    knowledge,
    ...cues
  }: NonNullable<CastChange["continuity"]>): NonNullable<CastChange["continuity"]> => ({
    ...grounded(cues),
    ...(knowledge === undefined ? {} : { knowledge: knowledge.filter(quoted) }),
  });
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
            ...(change.continuity === undefined
              ? {}
              : { continuity: groundedContinuity(change.continuity) }),
            ...(change.hidden === undefined ? {} : { hidden: grounded(change.hidden) }),
            ...(change.discovered === undefined ? {} : { discovered: grounded(change.discovered) }),
          },
        ];
      }),
    ),
  };
}

/** A hyphen that joins a compound name, as models write it: "Ann-Marie" does not name Ann. */
const JOINER = "[-\\u2010\\u2011]";

/**
 * The entries a shown turn names, by index: by the whole name, an earlier
 * name, or the given name when no other entry's name and not the player's
 * holds that word. Names are read as written and as whole words, in the
 * text without its highlight markup. A story that writes someone's name has
 * told the player of them, whatever the keeper answered. A capitalised
 * everyday word that is someone's name too ("May I come in?" with a May in
 * the cast) counts as well: telling the two apart would cost the plain
 * mentions ("Rose smiles.") this rule exists for, and what it shows early
 * is a name, never a detail.
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
      "u",
    );
    return texts.some((text) => pattern.test(text));
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
