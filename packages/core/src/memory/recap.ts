import { BOUNDARY_BYTES_PER_TOKEN, estimateTokens } from "../tokens.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import {
  type MemoryNotebook,
  NOTEBOOK_LIST_KEYS,
  NOTEBOOK_LISTS,
  type RememberRequest,
  type StoredEpisode,
} from "./memory.ts";
import { episodeText, fillUserPlaceholder } from "./prompt.ts";
import { storyOrder } from "./recall.ts";

/*
 * A chat's recap against the book as it stands: the one rule every reader of
 * a recap applies (the remember route, its replay, prompt assembly), and the
 * roll-up that keeps it short. Pure; the ids are chat content and live only
 * as long as the request that carries them.
 */

/** What the recap rule reads of an episode. */
type Placed = Pick<StoredEpisode, "id" | "chapterId">;

/**
 * The episodes a chat's recap names as the book has them now: ids that still
 * exist, each member a chapter absorbed replaced by its outermost chapter, in
 * the recap's order, each once.
 */
export function reconcileRecap<T extends Placed>(ids: readonly string[], book: readonly T[]): T[] {
  const byId = new Map(book.map((episode) => [episode.id, episode]));
  const seen = new Set<string>();
  const recap: T[] = [];
  for (const id of ids) {
    let episode = byId.get(id);
    if (episode === undefined) continue;
    // Up the chapters that absorbed it; a chain never revisits an episode.
    const climbed = new Set<string>([episode.id]);
    while (episode.chapterId !== null) {
      const outer: T | undefined = byId.get(episode.chapterId);
      if (outer === undefined || climbed.has(outer.id)) break;
      climbed.add(outer.id);
      episode = outer;
    }
    if (seen.has(episode.id)) continue;
    seen.add(episode.id);
    recap.push(episode);
  }
  return recap;
}

/**
 * How heavy a chat's recap may grow before a roll-up, in estimated tokens:
 * the memory blocks' share of the call's `window`, less the notebook and the
 * part left to recall (`MEMORY_LIMITS.recallReserve`), never under
 * `recapTokens.min`; the owner's `cap`, when set, is the most it may be.
 */
export function recapBudget(
  window: number,
  notebook: MemoryNotebook,
  cap: number | null = null,
): number {
  const share = MEMORY_LIMITS.share * window * (1 - MEMORY_LIMITS.recallReserve);
  const { situation, relationships, facts, threads } = notebook;
  const kept = estimateTokens([situation, ...relationships, ...facts, ...threads].join("\n"));
  const room = Math.floor(share - kept);
  const budget = Math.max(MEMORY_LIMITS.recapTokens.min, room);
  return cap === null ? budget : Math.min(budget, cap);
}

/**
 * The book's story outside one chat: the episodes and chapters no chapter
 * holds, but those `own` names (the chat's own), in story order
 * (`storyOrder`), so a chapter stands where its members happened, not where
 * it was written.
 */
export function bookStory<T extends Pick<StoredEpisode, "id" | "seq" | "chapterId">>(
  book: readonly T[],
  own: ReadonlySet<string> = new Set(),
): T[] {
  return storyOrder(
    book.filter((episode) => episode.chapterId === null && !own.has(episode.id)),
    book,
  );
}

/**
 * The newest of `story` (in story order) whose texts together take at most
 * `tokens` by the cheap estimate, in story order: what the story block may
 * tell before the chat, fitted exactly at assembly.
 */
export function latestWithin<T extends Pick<StoredEpisode, "title" | "summary">>(
  story: readonly T[],
  tokens: number,
): T[] {
  let total = 0;
  let from = story.length;
  while (from > 0) {
    const episode = story[from - 1];
    if (episode === undefined) break;
    const next = total + estimateTokens(episodeText(episode));
    if (next > tokens) break;
    total = next;
    from -= 1;
  }
  return story.slice(from);
}

/**
 * The story a chat starts from: the newest of the book's story outside it
 * (`bookStory`, without `own`) that fits the story block's share of `window`.
 * The chat prompt and the next chat's opening both tell this.
 */
export function storyBefore<
  T extends Pick<StoredEpisode, "id" | "seq" | "chapterId" | "title" | "summary">,
>(book: readonly T[], window: number, own?: ReadonlySet<string>): T[] {
  return latestWithin(bookStory(book, own), Math.floor(MEMORY_LIMITS.share * window));
}

/**
 * The earlier episodes a memory call reads as context: the last
 * `MEMORY_LIMITS.previous` of this chat's recap (reconciled), in its order;
 * for a chat without one, the latest of the book's story (`bookStory`).
 * Another chat's episodes never stand where this span begins while this
 * chat has its own.
 */
export function previousEpisodes<T extends Pick<StoredEpisode, "id" | "seq" | "chapterId">>(
  recap: readonly T[],
  book: readonly T[],
): T[] {
  if (recap.length > 0) return recap.slice(-MEMORY_LIMITS.previous);
  return bookStory(book).slice(-MEMORY_LIMITS.previous);
}

/** The most characters a notebook holds: a full situation and every list full. */
const NOTEBOOK_CHARACTERS = NOTEBOOK_LIST_KEYS.reduce(
  (sum: number, key) => sum + NOTEBOOK_LISTS[key].max * NOTEBOOK_LISTS[key].line,
  MEMORY_LIMITS.situation,
);

/**
 * The characters a notebook may take for a call's `window`: its part of the
 * memory blocks' share (`MEMORY_LIMITS.notebookShare`), about four
 * characters a token. Null when a full notebook fits it anyway.
 */
export function notebookRoom(window: number): number | null {
  const room = Math.floor(
    MEMORY_LIMITS.share * MEMORY_LIMITS.notebookShare * window * BOUNDARY_BYTES_PER_TOKEN,
  );
  return room >= NOTEBOOK_CHARACTERS ? null : room;
}

/**
 * The oldest part of a recap a roll-up merges into a chapter: half of it,
 * the newest `MEMORY_LIMITS.recapKeep` never, once the recap is heavier than
 * `recapTokens` or longer than `MEMORY_LIMITS.recapCount`. Empty when no
 * roll-up is due or fewer than two episodes would merge.
 */
export function rollupMembers<T extends Pick<StoredEpisode, "title" | "summary">>(
  recap: readonly T[],
  recapTokens: number,
): T[] {
  const heavy =
    estimateTokens(recap.map(episodeText).join("\n\n")) > recapTokens ||
    recap.length > MEMORY_LIMITS.recapCount;
  const merged = Math.min(Math.floor(recap.length / 2), recap.length - MEMORY_LIMITS.recapKeep);
  return heavy && merged >= 2 ? recap.slice(0, merged) : [];
}

/**
 * The characters a chapter's summary may take in a recap of `recapTokens`
 * (`recapBudget`): its share (`MEMORY_LIMITS.chapterShare`), about four
 * characters a token, never less than an episode's summary and never more
 * than `MEMORY_LIMITS.chapterSummary`.
 */
export function chapterRoom(recapTokens: number): number {
  const share = Math.floor(recapTokens * MEMORY_LIMITS.chapterShare * BOUNDARY_BYTES_PER_TOKEN);
  return Math.min(MEMORY_LIMITS.chapterSummary, Math.max(MEMORY_LIMITS.summary, share));
}

/**
 * The memories a chapter merges as the text its canon's keys are matched
 * against, with the persona's `user` name where they say `{{user}}`, as the
 * keys are filled.
 */
export const memberTurns = (
  members: readonly StoredEpisode[],
  user: string,
): RememberRequest["turns"] =>
  members.map((member) => ({
    role: "assistant",
    content: fillUserPlaceholder(
      `${member.title}\n${member.summary}\n${member.cues.join(", ")}`,
      user,
    ),
  }));

/**
 * The members a chapter call merges and its input, for a window that may
 * not hold them all (a long book's oldest half): the oldest part whose
 * input (`inputFor`) leaves the answer room (`roomFor`), halved until it
 * does, two at least, so every call still condenses some of it. Null when
 * even two leave no room.
 */
export function fitChapterMembers<Input>(
  members: readonly StoredEpisode[],
  inputFor: (merged: readonly StoredEpisode[]) => Input,
  roomFor: (input: Input) => number | null,
): { members: StoredEpisode[]; input: Input; room: number } | null {
  let merged = [...members];
  let input = inputFor(merged);
  let room = roomFor(input);
  while (room === null && merged.length > 2) {
    merged = merged.slice(0, Math.max(2, Math.floor(merged.length / 2)));
    input = inputFor(merged);
    room = roomFor(input);
  }
  return room === null ? null : { members: merged, input, room };
}

/**
 * A chat's folded recap after a memory call: the ids it sent, reconciled
 * with the book. The new episode is not among them: the tab holds it apart
 * until a request folds it. A chapter the call wrote stands
 * where its members stood, which a roll-up always takes from the front, so
 * first even when none of them is left.
 */
export function recapAfter(
  sent: readonly string[],
  book: readonly Placed[],
  written: { episode: Placed; chapter?: Placed | undefined },
): string[] {
  const { episode, chapter } = written;
  const ids = [
    ...(chapter === undefined ? [] : [chapter.id]),
    ...sent.filter((id) => id !== episode.id),
  ];
  return reconcileRecap(ids, book).map(({ id }) => id);
}
