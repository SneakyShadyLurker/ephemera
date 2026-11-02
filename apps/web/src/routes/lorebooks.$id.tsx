import { createFileRoute } from "@tanstack/react-router";
import { entrySearch, useEntryNavigation } from "../lorebook/entry-search.ts";
import { BookScreen } from "../lorebooks/BookScreen.tsx";
import { lorebookQuery } from "../lorebooks/queries.ts";

/**
 * A library lorebook, loaded on demand as its own chunk. The
 * `entry` search parameter opens an entry (lorebook/entry-search.ts).
 */
export const Route = createFileRoute("/lorebooks/$id")({
  validateSearch: entrySearch,
  preloadStaleTime: 0,
  loader: {
    staleReloadMode: "blocking",
    handler: ({ context, params }) =>
      context.queryClient
        .query({ ...lorebookQuery(params.id), staleTime: 0 })
        .catch(() => undefined),
  },
  component: function BookRoute() {
    const { id } = Route.useParams();
    const { entry } = Route.useSearch();
    const onEntry = useEntryNavigation(Route.fullPath);
    return <BookScreen id={id} entry={entry} onEntry={onEntry} />;
  },
});
