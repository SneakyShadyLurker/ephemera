/*
 * Find and order by name, the same on every list: the gallery, the lorebook
 * library, a book's entries and the checklists.
 */

/** Lowercase without diacritics, so "ines" finds "Inès". */
export const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * Whether every word of `query` appears somewhere in `texts`, case and
 * accents aside. An empty query matches everything.
 */
export function matches(query: string, ...texts: string[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(texts.join("\n"));
  return words.every((word) => haystack.includes(word));
}

const loose = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const exact = new Intl.Collator(undefined, { numeric: true });

/**
 * By name as a person reads it, in the reader's locale: case and accents
 * aside and numbers by value ("Book 2" before "Book 10"), then exactly, so
 * the order is stable.
 */
export const byName = (a: string, b: string): number => loose.compare(a, b) || exact.compare(a, b);
