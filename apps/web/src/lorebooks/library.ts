import {
  CARD_LIMITS,
  type CharacterSummary,
  clipText,
  type EmbeddedLorebook,
  type Library,
  LOREBOOK_LINKS,
  type LorebookLinks,
  type LorebookSummary,
} from "@ephemera/core";
import { byName, matches } from "@/lib/find";
import { boundedAndList, countOf, formatCount } from "@/lib/text";

/*
 * The library's rules on the page: which characters a book is linked to,
 * which books a character carries, finding and ordering rows, and the words
 * for links and deletions. Book data and character names, never chat content.
 */

/** A character as a link shows it. */
export type LinkedCharacter = Pick<CharacterSummary, "id" | "name" | "portrait">;

/** The ids of the characters `lorebookId` is linked to. */
const linkedTo = (links: LorebookLinks, lorebookId: string): string[] =>
  links.filter((link) => link.lorebookIds.includes(lorebookId)).map((link) => link.characterId);

/** The library books linked to `characterId`, in link order. */
export const booksOf = (links: LorebookLinks, characterId: string): string[] =>
  links.find((link) => link.characterId === characterId)?.lorebookIds ?? [];

/** Whether `characterId` carries as many linked books as it may. */
export const linksFull = (links: LorebookLinks, characterId: string): boolean =>
  booksOf(links, characterId).length >= LOREBOOK_LINKS;

/** What a character at the limit says beside a book it cannot take. */
export const LINKS_FULL_TEXT = `${LOREBOOK_LINKS} of ${LOREBOOK_LINKS} lorebooks linked`;

/**
 * The links after one is made or undone, as the server keeps them: a new
 * link joins the end of the character's books; an existing one stays where
 * it is; unlinking leaves the others' order.
 */
export function withLink(
  links: LorebookLinks,
  characterId: string,
  lorebookId: string,
  linked: boolean,
): LorebookLinks {
  const books = booksOf(links, characterId);
  const next = linked
    ? books.includes(lorebookId)
      ? books
      : [...books, lorebookId]
    : books.filter((id) => id !== lorebookId);
  const others = links.filter((link) => link.characterId !== characterId);
  return next.length === 0 ? others : [...others, { characterId, lorebookIds: next }];
}

/** The characters `lorebookId` is linked to, known to the character list, by name. */
export function linkedCharacters(
  links: LorebookLinks,
  lorebookId: string,
  characters: readonly LinkedCharacter[],
): LinkedCharacter[] {
  const ids = new Set(linkedTo(links, lorebookId));
  return characters
    .filter((character) => ids.has(character.id))
    .sort((a, b) => byName(a.name, b.name));
}

export interface BookRow {
  book: LorebookSummary;
  characters: LinkedCharacter[];
}

/**
 * The library's two lists as Find leaves them (lib/find.ts), each by name:
 * library books found in their name and their linked characters' names, and
 * books in cards found in their character's name.
 */
export function libraryRows(
  library: Library,
  characters: readonly LinkedCharacter[],
  find: string,
): { books: BookRow[]; embedded: EmbeddedLorebook[] } {
  const books = library.lorebooks
    .map((book) => ({ book, characters: linkedCharacters(library.links, book.id, characters) }))
    .filter((row) =>
      matches(find, row.book.name, ...row.characters.map((character) => character.name)),
    )
    .sort((a, b) => byName(a.book.name, b.book.name) || a.book.id.localeCompare(b.book.id));
  const embedded = library.embedded
    .filter((book) => matches(find, book.name))
    .sort((a, b) => byName(a.name, b.name) || a.characterId.localeCompare(b.characterId));
  return { books, embedded };
}

/** "Linked to 1 character", "Linked to 5 characters", or "Not linked". */
export function linkedText(count: number): string {
  if (count === 0) return "Not linked";
  return `Linked to ${countOf(count, "character")}`;
}

/** The book editor's standing line: what an edit reaches. */
export function linkedConsequence(count: number): string {
  if (count === 0) return "Not linked to a character yet.";
  return count === 1
    ? "Linked to 1 character. Edits apply to it."
    : `Linked to ${formatCount(count)} characters. Edits apply to all of them.`;
}

/** What deleting a book does, with the characters that lose it named, a bounded list. */
export function deleteText(names: readonly string[]): string {
  const unlinked =
    names.length === 0
      ? ""
      : ` ${countOf(names.length, "character")} ${names.length === 1 ? "loses" : "lose"} it: ${boundedAndList(names, 5)}.`;
  return `The lorebook is removed from Ephemera.${unlinked} Export it first to keep a copy.`;
}

/** The name of a card's book copied to the library: "Mira's lorebook", within the name limit. */
export function copiedName(characterName: string): string {
  const owner = characterName.trim() || "A character";
  const suffix = "'s lorebook";
  return `${clipText(owner, CARD_LIMITS.nameLength - suffix.length).trim()}${suffix}`;
}
