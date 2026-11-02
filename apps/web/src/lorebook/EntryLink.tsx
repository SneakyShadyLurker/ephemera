import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * The entry a followed link meant, by the title its report gave it. A report
 * is a snapshot and the book may have changed since, so the editor checks the
 * title before it opens the index (LorebookEditor). Kept in memory for one
 * navigation, never in the URL or history state.
 */
let followed: { index: number; title: string } | null = null;
export function takeFollowedEntry(): { index: number; title: string } | null {
  const taken = followed;
  followed = null;
  return taken;
}

/**
 * A link to one lorebook entry's editor: in a character's card (`book` null)
 * or in the library. The URL carries the entry's index in its book, book
 * data the editor's own list puts there too, and only when the owner follows
 * the link; nothing of the chat that listed it.
 */
export function EntryLink({
  characterId,
  book,
  index,
  title,
  label,
  className,
  children,
}: {
  characterId: string;
  /** The library book's id, or null for the card's own book. */
  book: string | null;
  index: number;
  /** The entry's title where the link was listed, which the editor checks the index against. */
  title: string;
  /** The link's name when its words say less than where it goes. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const follow = () => {
    followed = { index, title };
  };
  return book === null ? (
    <Link
      to="/characters/$id/lorebook"
      params={{ id: characterId }}
      search={{ entry: index }}
      aria-label={label}
      onClick={follow}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/lorebooks/$id"
      params={{ id: book }}
      search={{ entry: index }}
      aria-label={label}
      onClick={follow}
      className={className}
    >
      {children}
    </Link>
  );
}
