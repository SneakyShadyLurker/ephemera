import { createFileRoute } from "@tanstack/react-router";
import { charactersQuery } from "../characters/queries.ts";
import { LibraryScreen } from "../lorebooks/LibraryScreen.tsx";
import { libraryQuery } from "../lorebooks/queries.ts";

export const Route = createFileRoute("/lorebooks/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(libraryQuery);
    void context.queryClient.prefetchQuery(charactersQuery);
  },
  component: LibraryScreen,
});
