import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";

/*
 * The `entry` search parameter, one rule for both sources of a book (a
 * character's lorebook and a library book): the open entry's index in the
 * book (book data, never chat content), so Back closes it on phones.
 */

/** The routes that open a book's entries. */
type BookRoute = "/characters/$id/lorebook" | "/lorebooks/$id";

/** The routes' search: an entry's index, dropped when it is not one. */
export const entrySearch = z.object({
  entry: z.number().int().min(0).optional().catch(undefined),
});

/** Opens an entry (or the list, for undefined); `push` adds a history step, else it replaces. */
export function useEntryNavigation(from: BookRoute) {
  const navigate = useNavigate({ from });
  return (next: number | undefined, push: boolean) =>
    void navigate({ search: next === undefined ? {} : { entry: next }, replace: !push });
}
