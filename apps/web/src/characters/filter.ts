import { type CharacterSummary, hasTag, tagKey, uniqueTags } from "@ephemera/core";
import { byName, fold, matches } from "@/lib/find";

export type Order = "recent" | "name";

interface GalleryFilter {
  query: string;
  tags: string[];
  order: Order;
}

/**
 * Search by name, nickname, creator or tag (every word must match somewhere),
 * keep characters carrying every checked tag, then order them.
 */
export function filterCharacters(
  characters: CharacterSummary[],
  { query, tags, order }: GalleryFilter,
): CharacterSummary[] {
  const found = characters.filter(
    (character) =>
      tags.every((tag) => hasTag(character.tags, tag)) &&
      matches(query, character.name, character.nickname, character.creator, ...character.tags),
  );
  return found.sort((a, b) =>
    order === "name" ? byName(a.name, b.name) : b.updatedAt - a.updatedAt,
  );
}

/**
 * Every tag with the number of characters carrying it, most used first.
 * Spellings that differ only in case count as one tag, shown in its most
 * used spelling.
 */
export function tagCounts(characters: CharacterSummary[]): [tag: string, count: number][] {
  const groups = new Map<string, Map<string, number>>();
  for (const character of characters) {
    for (const tag of uniqueTags(character.tags)) {
      const key = tagKey(tag);
      const spellings = groups.get(key) ?? new Map<string, number>();
      spellings.set(tag, (spellings.get(tag) ?? 0) + 1);
      groups.set(key, spellings);
    }
  }
  const counts = [...groups.values()].map((spellings): [string, number] => {
    let shown = "";
    let most = 0;
    let total = 0;
    for (const [tag, count] of spellings) {
      total += count;
      if (count > most) [shown, most] = [tag, count];
    }
    return [shown, total];
  });
  return counts.sort(([a, x], [b, y]) => y - x || byName(a, b));
}

/** Names shared by more than one character, whose captions then show the creator. */
export function repeatedNames(characters: CharacterSummary[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { name } of characters) {
    const key = fold(name);
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  return repeated;
}
