import { z } from "zod";
import { CARD_LIMITS, clipText } from "./limits.ts";

/**
 * Tags compare without regard to case: "Fantasy" and "fantasy" are one tag.
 * Each keeps the spelling it was written in.
 */
export const tagKey = (tag: string): string => tag.toLowerCase();

export const sameTag = (a: string, b: string): boolean => tagKey(a) === tagKey(b);

export const hasTag = (tags: readonly string[], tag: string): boolean =>
  tags.some((other) => sameTag(other, tag));

/** The tags once each, in order, each in its first spelling. */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tagKey(tag);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The entries of a typed list (tags, or a model's): split at commas and line
 * breaks, trimmed, each cut to `maxLength`, empty and repeated ones dropped;
 * lowercased when asked.
 */
export function splitList(text: string, maxLength: number, lowercase: boolean): string[] {
  const items = text
    .split(/[,\n]/u)
    .map((item) => clipText(lowercase ? item.trim().toLowerCase() : item.trim(), maxLength).trim())
    .filter((item) => item !== "");
  return [...new Set(items)];
}

/** The tags with those in the text (one, or a comma list) added, each once and within the card's limits. */
export function addTags(tags: readonly string[], text: string): string[] {
  const added = uniqueTags(splitList(text, CARD_LIMITS.tagLength, false)).filter(
    (tag) => !hasTag(tags, tag),
  );
  return [...tags, ...added.slice(0, Math.max(0, CARD_LIMITS.tags - tags.length))];
}

/** A tag list as cards and event scopes bound it. */
export const tagsSchema = z
  .array(z.string().trim().min(1).max(CARD_LIMITS.tagLength))
  .max(CARD_LIMITS.tags);
