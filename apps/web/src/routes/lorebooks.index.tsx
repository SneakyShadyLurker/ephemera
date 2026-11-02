import { createFileRoute } from "@tanstack/react-router";
import { charactersQuery } from "../characters/queries.ts";
import { LibraryScreen } from "../lorebooks/LibraryScreen.tsx";
import { libraryQuery } from "../lorebooks/queries.ts";

export const Route = createFileRoute("/lorebooks/")({
  // The library arrives with the screen. A failure renders at once (no retries here, so a click never stalls); the screen shows it and retries.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient
        .query({ ...libraryQuery, staleTime: "static", retry: false })
        .catch(() => undefined),
      context.queryClient
        .query({ ...charactersQuery, staleTime: "static", retry: false })
        .catch(() => undefined),
    ]);
  },
  component: LibraryScreen,
});
