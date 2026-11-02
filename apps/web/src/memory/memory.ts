import {
  type CharacterMemory,
  MEMORY_LIMITS,
  type MemoryState,
  memoryModelOf,
  type OpeningRequest,
  type Settings,
  type StoredEpisode,
} from "@ephemera/core";
import type { QueryClient } from "@tanstack/react-query";
import { countOf, formatCount } from "@/lib/text";
import { type ChatState, editHolds, rememberableTurns, spanToRemember } from "../chat/store.ts";
import type { SaveResult } from "../sheet/saving.ts";
import { MEMORY_KEY, type OpeningFailure, refreshMemory, saveMemoryState } from "./queries.ts";

/*
 * What the memory surfaces (the screen, the sheet's section) share: turning
 * memory on and off, reading the book as rows, and whether the open chat has
 * enough to remember now. Character data and chat metadata only.
 */

/**
 * Turns memory on or off for a character. A switch says one thing, so a
 * revision another tab moved is taken and the change sent once more.
 * The cached memory follows the answer; the chat follows the cache.
 */
export async function setMemoryOn(
  queryClient: QueryClient,
  characterId: string,
  enabled: boolean,
  state: MemoryState | null,
): Promise<SaveResult<MemoryState>> {
  let result = await saveMemoryState(characterId, { enabled }, state?.revision ?? 0);
  if (!result.ok && result.reason === "conflict") {
    result = await saveMemoryState(characterId, { enabled }, result.revision);
  }
  if (result.ok) {
    const saved = result.saved;
    queryClient.setQueryData<CharacterMemory>(MEMORY_KEY(characterId), (current) => ({
      state: saved,
      episodes: current?.episodes ?? [],
    }));
  }
  void refreshMemory(queryClient, characterId);
  return result;
}

/**
 * A row of the book: an episode or a chapter, with the rows a chapter
 * gathers, oldest first; a chapter a later one absorbed keeps its own.
 */
export interface BookRow {
  episode: StoredEpisode;
  members: BookRow[];
}

/**
 * The book newest first, each chapter holding its members in story order,
 * a chapter inside a chapter with its own. A member whose chapter is
 * missing stands on its own.
 */
export function bookRows(episodes: readonly StoredEpisode[]): BookRow[] {
  const ordered = [...episodes].sort((a, b) => a.seq - b.seq);
  const ids = new Set(ordered.map((episode) => episode.id));
  const gathered = new Map<string, StoredEpisode[]>();
  for (const episode of ordered) {
    const { chapterId } = episode;
    if (chapterId === null || !ids.has(chapterId)) continue;
    const members = gathered.get(chapterId);
    if (members === undefined) gathered.set(chapterId, [episode]);
    else members.push(episode);
  }
  // A chapter is written after its members: only earlier ones nest, so no row holds itself.
  const row = (episode: StoredEpisode): BookRow => ({
    episode,
    members: (gathered.get(episode.id) ?? []).filter((member) => member.seq < episode.seq).map(row),
  });
  return ordered
    .filter((episode) => episode.chapterId === null || !ids.has(episode.chapterId))
    .reverse()
    .map(row);
}

/**
 * The row focus moves to once the row `deleted` is gone, of the rows shown
 * in order (`shown`): the one after it, else the one before, else none
 * (null), for the list's heading.
 */
export function rowAfterDelete(shown: readonly string[], deleted: string): string | null {
  const at = shown.indexOf(deleted);
  if (at === -1) return shown[0] ?? null;
  return shown[at + 1] ?? shown[at - 1] ?? null;
}

/**
 * Whether the open chat holds enough to remember now: at least two turns
 * with text between the folded ones and the newest `keepTurns` messages,
 * as Remember now takes them, and no memory being written.
 */
export function rememberable(state: ChatState, keepTurns: number): boolean {
  return state.memory.status !== "remembering" && rememberableTurns(state, keepTurns).length >= 2;
}

/** Whether an open message edit in the span Remember now takes holds it until Save or Cancel. */
export const rememberNowHeld = (state: ChatState, keepTurns: number): boolean =>
  editHolds(state, spanToRemember(state, keepTurns));

const DAY_MS = 86_400_000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dated = new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" });

/** When `at` was, in plain words: "today", "3 days ago", or the date past a month. */
function whenText(at: number, now: number): string {
  const start = (time: number) => {
    const day = new Date(time);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };
  const days = Math.round((start(now) - start(at)) / DAY_MS);
  return days > 30 ? `on ${dated.format(at)}` : relative.format(-Math.max(0, days), "day");
}

/** How many memories a character keeps and when the last one was written: "12 memories, last one today." */
export function countsText(episodes: readonly StoredEpisode[], now: number): string {
  if (episodes.length === 0) return "Nothing remembered yet.";
  const newest = Math.max(...episodes.map((episode) => episode.createdAt));
  const count = episodes.length;
  return `${countOf(count, "memory", "memories")}, last one ${whenText(newest, now)}.`;
}

/**
 * What the episode editor says beside its cues when they break core's
 * limits (a cue too long, more cues than a memory keeps), which would stop
 * the memory from saving; null while they are within them.
 */
export function cueProblem(cues: readonly string[]): string | null {
  const { cue: length, cues: most } = MEMORY_LIMITS;
  const long = cues.filter((cue) => cue.length > length);
  const extra = cues.length - most;
  const problems = [
    long.length === 1
      ? `“${long[0]}” is over ${length} characters, the most a cue holds.`
      : long.length > 1
        ? `${formatCount(long.length)} cues are over ${length} characters, the most a cue holds.`
        : null,
    extra > 0 ? `A memory keeps ${most} cues; remove ${formatCount(extra)} to save it.` : null,
  ].filter((problem) => problem !== null);
  return problems.length === 0 ? null : problems.join(" ");
}

/**
 * Why the episode editor's fields cannot be saved, in plain words naming
 * the field and its limit, for its save line and the screen's header alike.
 */
export function episodeOverLimit(field: "name" | "summary" | "cues", cues: readonly string[]) {
  // The summary's bound is a chapter's, the most any memory holds: the editor keeps an episode's
  // within its own (`maxLength`).
  const { title, chapterSummary: summary, cue, cues: most } = MEMORY_LIMITS;
  switch (field) {
    case "name":
      return `a title holds at most ${formatCount(title)} characters`;
    case "summary":
      return `a summary holds at most ${formatCount(summary)} characters`;
    case "cues":
      return cues.length > most
        ? `a memory keeps at most ${most} cues`
        : `a cue holds at most ${cue} characters`;
  }
}

/**
 * An opening call as memory calls choose it (chat/session.ts): the memory
 * model, else the reply's, the memory effort (none sends the model's
 * default) and the persona chosen; null while no model is chosen.
 */
export function openingRequestFor(
  settings: Pick<Settings, "model" | "memoryModel" | "memoryReasoning" | "personaId">,
): OpeningRequest | null {
  const model = memoryModelOf(settings);
  if (model === null) return null;
  return {
    model,
    ...(settings.memoryReasoning === null ? {} : { reasoning: settings.memoryReasoning }),
    ...(settings.personaId === null ? {} : { personaId: settings.personaId }),
  };
}

/**
 * Why Regenerate cannot write the next chat's opening, or null when it
 * can: memory off, nothing remembered to write it from (no notebook and no
 * memory), or no model chosen.
 */
export function regenerateReason({
  name,
  on,
  remembered,
  model,
}: {
  name: string;
  on: boolean;
  remembered: boolean;
  model: string | null;
}): string | null {
  if (!on) return `Memory is off for ${name}.`;
  if (!remembered) return "Nothing is remembered yet to write it from.";
  if (model === null) return "Choose a model in Settings to write it.";
  return null;
}

/**
 * Why Regenerate wrote nothing: the call's failure, or one that never
 * reached the server (`no_model`: no model chosen; `unsaved`: the
 * notebook's edits could not be saved first).
 */
export type OpeningWriteFailure = OpeningFailure | "no_model" | "unsaved";

/**
 * Where Regenerate stands: at rest, writing, written (Undo restores
 * `previous`), or failed.
 */
export type OpeningWrite =
  | { kind: "idle" }
  | { kind: "writing" }
  | { kind: "done"; previous: string }
  | { kind: "failed"; reason: OpeningWriteFailure };

export type OpeningWriteEvent =
  | { type: "start" }
  | { type: "written"; previous: string }
  | { type: "failed"; reason: OpeningWriteFailure }
  | { type: "stopped" }
  | { type: "edited" };

/**
 * Regenerate's next state: an answer counts only while its write runs, and
 * a write stopped (memory turning off) leaves nothing; an edit of the
 * opening ends Undo's offer, and leaves a failure's note.
 */
export function openingWriteAfter(state: OpeningWrite, event: OpeningWriteEvent): OpeningWrite {
  switch (event.type) {
    case "start":
      return { kind: "writing" };
    case "written":
      return state.kind === "writing" ? { kind: "done", previous: event.previous } : state;
    case "failed":
      return state.kind === "writing" ? { kind: "failed", reason: event.reason } : state;
    case "stopped":
      return state.kind === "writing" ? { kind: "idle" } : state;
    case "edited":
      return state.kind === "done" ? { kind: "idle" } : state;
  }
}
