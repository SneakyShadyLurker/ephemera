import type { ChatTurn } from "../chat.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import type { StoredEpisode } from "./memory.ts";
import { EPISODE_SEPARATOR, episodeText, memoryRecalledText } from "./prompt.ts";

/*
 * Recall: which earlier episodes the latest turns call for. Lexical and in
 * process, since one character's book is small. Words are whole, in any
 * case, a plural's "s" set aside. A cue matches when its words appear in a
 * row in the latest turns, function words such as "the" at its edges left
 * out, so "the silver locket" matches "her silver lockets". The last word
 * of a longer cue that does not match, and each title word that is not a
 * function word, count half when present and three or more letters long.
 * Pinned episodes come first and always while they fit; the rest need one
 * cue or two half words, so a stray "night" in a title recalls nothing.
 * An episode and a chapter that holds it, directly or through another, tell
 * the same part of the story: only one of them is recalled.
 */

/** What recall reads of an episode's place in the book. */
type Placed = Pick<StoredEpisode, "id" | "chapterId">;

/** The ids of the chapters that hold `episode`, innermost first, as far as `byId` knows them. */
function chaptersOf(episode: Placed, byId: ReadonlyMap<string, Placed>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([episode.id]);
  let at = episode.chapterId;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    chain.push(at);
    at = byId.get(at)?.chapterId ?? null;
  }
  return chain;
}

/** Every chapter that holds one of `ids`, directly or through another, as `book` places them. */
export function chaptersHolding(ids: Iterable<string>, book: readonly Placed[]): Set<string> {
  const byId = new Map(book.map((episode) => [episode.id, episode]));
  const holding = new Set<string>();
  for (const id of ids) {
    const episode = byId.get(id);
    if (episode !== undefined)
      for (const chapter of chaptersOf(episode, byId)) holding.add(chapter);
  }
  return holding;
}

/** Where each word stands in `text`, read once: a phrase is checked only where its first word is. */
function indexWords(text: readonly string[]): Map<string, number[]> {
  return Map.groupBy(text.keys(), (at) => text[at] ?? "");
}

/** Whether `phrase` occurs in `text` as consecutive whole words; `index` is `text`'s. */
function containsPhrase(
  text: readonly string[],
  index: ReadonlyMap<string, readonly number[]>,
  phrase: readonly string[],
): boolean {
  const [first] = phrase;
  if (first === undefined) return false;
  return (index.get(first) ?? []).some((start) =>
    phrase.every((word, offset) => text[start + offset] === word),
  );
}

const HALF_MIN = 3;
const HALF_WEIGHT = 0.5;
/** The least an unpinned episode needs: one cue, or two half words. */
const RECALL_MIN = 1;
/** Function words cues and titles are full of; none of them says what the episode is about. */
const FUNCTION_WORDS = new Set(
  "a an the of to in on at by as is was are were be been am and or nor but yet so if for with from into onto over under about after before between through during without within upon than then that this these those there here where when while what which who whom whose why how all any both each few more most other some such only own same very can will just not too also his her its our their your she they them him you one two my me we us it".split(
    " ",
  ),
);

/** A word as recall compares it: a plural's "s" (or "ies") set aside. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Lower-cased words: runs of Unicode letters and digits. */
const lowered = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The words recall compares, stemmed. */
const words = (text: string): string[] => lowered(text).map(stem);

/** A cue's words without the function words at its edges, stemmed. */
function cueWords(cue: string): string[] {
  const all = lowered(cue);
  let from = 0;
  let to = all.length;
  while (from < to && FUNCTION_WORDS.has(all[from] ?? "")) from += 1;
  while (to > from && FUNCTION_WORDS.has(all[to - 1] ?? "")) to -= 1;
  return all.slice(from, to).map(stem);
}

/** A title's words that are not function words, stemmed. */
const titleWords = (title: string): string[] =>
  lowered(title)
    .filter((word) => !FUNCTION_WORDS.has(word))
    .map(stem);

/**
 * The candidates these turns call for, best first: pinned ones by recency,
 * then the rest by score, ties by recency (higher `seq`), except that an
 * episode tied with a chapter that holds it goes first, the more specific
 * telling. The last `limits.depth` turns are scanned, their last
 * `limits.words` words only. How many go in, and which of a chapter and
 * its members, is `fitRecall`'s.
 */
export function rankRecall(
  candidates: readonly StoredEpisode[],
  turns: readonly Pick<ChatTurn, "content">[],
  limits: { depth: number; words: number } = MEMORY_LIMITS.recall,
): StoredEpisode[] {
  const scanned = words(
    turns
      .slice(Math.max(0, turns.length - limits.depth))
      .map((turn) => turn.content)
      .join("\n"),
  ).slice(-limits.words);
  const present = indexWords(scanned);
  const scored = candidates.map((episode) => {
    let cues = 0;
    /** Words that count half when present: unmatched longer cues' last ones and the title's. */
    const half = new Set(titleWords(episode.title));
    for (const cue of episode.cues) {
      const phrase = cueWords(cue);
      if (containsPhrase(scanned, present, phrase)) cues += 1;
      else if (phrase.length > 1) half.add(phrase[phrase.length - 1] ?? "");
    }
    const found = [...half].filter((word) => [...word].length >= HALF_MIN && present.has(word));
    return { episode, score: cues + HALF_WEIGHT * found.length };
  });
  const sorted = scored
    .filter(({ episode, score }) => episode.pinned || score >= RECALL_MIN)
    .sort(
      (a, b) =>
        Number(b.episode.pinned) - Number(a.episode.pinned) ||
        (a.episode.pinned ? 0 : b.score - a.score) ||
        b.episode.seq - a.episode.seq,
    );
  // A member a chapter outranks only by recency moves up to just before that chapter.
  const byId = new Map(candidates.map((episode) => [episode.id, episode]));
  const ranked: typeof sorted = [];
  for (const entry of sorted) {
    const chapters = new Set(chaptersOf(entry.episode, byId));
    const tied = ranked.findIndex(
      (above) =>
        chapters.has(above.episode.id) &&
        above.episode.pinned === entry.episode.pinned &&
        (entry.episode.pinned || above.score === entry.score),
    );
    if (tied === -1) ranked.push(entry);
    else ranked.splice(tied, 0, entry);
  }
  return ranked.map(({ episode }) => episode);
}

/**
 * The ranked episodes that go in, in rank order: every pinned one, then at
 * most `max` others, each while the recalled block (`memoryRecalledText`)
 * with those chosen before it stays within `room` by `count`. One that does
 * not fit is skipped and the scan goes on, so a smaller one further down
 * still goes in. Each episode's text is counted once, into a running total
 * of the block's parts; one exact count of the chosen block then drops the
 * last ones while a count that does not add up part by part puts it over.
 * One that a chosen chapter holds, or a chapter that holds a chosen one, is
 * skipped: `book` (the ranked ones by default) gives the chapters between.
 */
export function fitRecall(
  ranked: readonly StoredEpisode[],
  count: (text: string) => number,
  room: number,
  max: number = MEMORY_LIMITS.recall.max,
  book: readonly Placed[] = ranked,
): StoredEpisode[] {
  const byId = new Map(book.map((episode) => [episode.id, episode]));
  const chosen: StoredEpisode[] = [];
  /** The chosen ones and every chapter that holds one. */
  const covered = new Set<string>();
  const chosenIds = new Set<string>();
  const heading = count(memoryRecalledText([]));
  const separator = count(EPISODE_SEPARATOR);
  let total = heading;
  let others = 0;
  for (const episode of ranked) {
    if (!episode.pinned && others >= max) break;
    const chapters = chaptersOf(episode, byId);
    if (covered.has(episode.id) || chapters.some((id) => chosenIds.has(id))) continue;
    const tried = total + (chosen.length === 0 ? 0 : separator) + count(episodeText(episode));
    if (tried > room) continue;
    total = tried;
    chosen.push(episode);
    chosenIds.add(episode.id);
    covered.add(episode.id);
    for (const id of chapters) covered.add(id);
    if (!episode.pinned) others += 1;
  }
  while (chosen.length > 0 && count(memoryRecalledText(chosen)) > room) chosen.pop();
  return chosen;
}

/**
 * `episodes` in story order: an episode by its `seq`, a chapter by the
 * lowest `seq` among the episodes it holds, directly or through chapters,
 * as `book` places them, or its own when `book` knows none of them. Ties
 * keep their order.
 */
export function storyOrder<T extends Pick<StoredEpisode, "id" | "seq" | "chapterId">>(
  episodes: readonly T[],
  book: readonly Pick<StoredEpisode, "id" | "seq" | "chapterId">[],
): T[] {
  const byId = new Map(book.map((episode) => [episode.id, episode]));
  const earliest = new Map<string, number>();
  for (const episode of book) {
    for (const id of chaptersOf(episode, byId)) {
      earliest.set(id, Math.min(earliest.get(id) ?? episode.seq, episode.seq));
    }
  }
  const at = (episode: T) => earliest.get(episode.id) ?? episode.seq;
  return episodes.toSorted((a, b) => at(a) - at(b));
}
