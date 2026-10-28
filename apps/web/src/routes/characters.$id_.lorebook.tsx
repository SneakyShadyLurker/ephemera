import { createFileRoute } from "@tanstack/react-router";
import { entrySearch, useEntryNavigation } from "../lorebook/entry-search.ts";
import { LorebookScreen } from "../lorebook/LorebookScreen.tsx";

/**
 * A character's lorebook, loaded on demand as its own chunk. The
 * `entry` search parameter opens an entry (lorebook/entry-search.ts).
 */
export const Route = createFileRoute("/characters/$id_/lorebook")({
  validateSearch: entrySearch,
  component: function LorebookRoute() {
    const { id } = Route.useParams();
    const { entry } = Route.useSearch();
    const onEntry = useEntryNavigation(Route.fullPath);
    return <LorebookScreen id={id} entry={entry} onEntry={onEntry} />;
  },
});
