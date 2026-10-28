import type { StoredEpisode } from "@ephemera/core";
import { useId, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { countOf } from "@/lib/text";
import type { OpenEpisode } from "./EpisodeEditor.tsx";
import { type BookRow, bookRows } from "./memory.ts";
import { Unfold } from "./Unfold.tsx";

/** Said where the book is empty: memories come by themselves. */
export const NOTHING_REMEMBERED = "Nothing remembered yet. Memories arrive as the story grows.";

/**
 * What a row says under its summary: how much of the story it holds. A
 * chapter counts the memories it gathers directly, as its disclosure does.
 */
function metaText(episode: StoredEpisode, members: number): string {
  const turns = countOf(episode.turns, "turn");
  const size =
    episode.kind === "chapter"
      ? `A chapter of ${countOf(members, "memory", "memories")}, ${turns}`
      : turns;
  return episode.pinned ? `${size}, always in the prompt.` : `${size}.`;
}

/**
 * The memories, newest first: each its title, its summary and its cues;
 * a chapter folds the memories it gathers under a disclosure, a chapter
 * among them with its own. A row opens its editor, which the screen owns.
 */
export function EpisodeList({
  episodes,
  onOpen,
}: {
  episodes: StoredEpisode[];
  onOpen: OpenEpisode;
}) {
  const rows = bookRows(episodes);
  if (rows.length === 0) {
    return <p className="font-story text-reed text-turn">{NOTHING_REMEMBERED}</p>;
  }
  return (
    // One column at the screen's width: no title, summary or cue widens it.
    <ol aria-label="Memories" data-memory-list="" className="grid grid-cols-[minmax(0,1fr)]">
      {rows.map((row) => (
        <li key={row.episode.id} className="border-rush border-t first:border-t-0">
          <BookEntry row={row} onOpen={onOpen} />
        </li>
      ))}
    </ol>
  );
}

/**
 * One row and, for a chapter, the rows it gathers under their disclosure,
 * indented a step per level; on phones a level below the first steps in
 * by its rule alone, so a deep chapter keeps its width. The rows unfold on
 * the spring and fold away again.
 */
function BookEntry({
  row,
  onOpen,
  depth = 0,
}: {
  row: BookRow;
  onOpen: OpenEpisode;
  depth?: number;
}) {
  const { episode, members } = row;
  const [open, setOpen] = useState(false);
  const membersId = useId();
  const count = members.length;
  return (
    <>
      <EpisodeRow episode={episode} members={count} onOpen={onOpen} />
      {count > 0 && (
        <div className="pb-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={membersId}
            onClick={() => setOpen((current) => !current)}
            className="press flex min-h-8 w-fit items-center gap-1 rounded-md text-note text-reed hover:text-ink touch:min-h-11"
          >
            <ChevronDownIcon
              size={16}
              className={cn(
                "transition-[rotate] duration-(--duration-panel-in) ease-spring",
                open && "rotate-180",
              )}
            />
            {open
              ? "Hide the memories it gathers"
              : `Show the ${countOf(count, "memory", "memories")} it gathers`}
          </button>
          <Unfold show={open} id={membersId}>
            <ol
              className={cn(
                "mt-1 grid grid-cols-[minmax(0,1fr)] border-rush border-l",
                depth < 1 ? "ml-3 pl-4" : "ml-3 pl-4 max-tablet:ml-0 max-tablet:pl-3",
              )}
            >
              {members.map((member) => (
                <li key={member.episode.id}>
                  <BookEntry row={member} onOpen={onOpen} depth={depth + 1} />
                </li>
              ))}
            </ol>
          </Unfold>
        </div>
      )}
    </>
  );
}

function EpisodeRow({
  episode,
  members,
  onOpen,
}: {
  episode: StoredEpisode;
  members: number;
  onOpen: OpenEpisode;
}) {
  return (
    <button
      type="button"
      data-episode={episode.id}
      onClick={() => onOpen(episode.id, members)}
      className="press -mx-3 grid w-[calc(100%+1.5rem)] min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-lg px-3 py-4 text-left transition-colors duration-(--duration-quick) ease-fade [overflow-wrap:anywhere] hover:bg-surface-hover"
    >
      <span className="font-semibold font-story text-[1.125rem] text-ink leading-6">
        {episode.title}
      </span>
      <span className="line-clamp-4 whitespace-pre-line font-story text-reed text-turn">
        {episode.summary}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-1.5">
        {episode.cues.map((cue, at) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a model may repeat a cue; the list never reorders.
            key={`${at}:${cue}`}
            // The row's one column holds it: a long cue truncates at the row's width instead of widening it.
            className="min-w-0 max-w-full truncate rounded-[4px] border border-rush px-1.5 text-meta text-reed"
          >
            {cue}
          </span>
        ))}
        <span className="text-meta text-reed">{metaText(episode, members)}</span>
      </span>
    </button>
  );
}
