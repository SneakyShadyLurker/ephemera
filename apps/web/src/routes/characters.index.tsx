import { createFileRoute } from "@tanstack/react-router";
import { GalleryScreen } from "../characters/Gallery.tsx";
import { charactersQuery } from "../characters/queries.ts";

export const Route = createFileRoute("/characters/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(charactersQuery);
  },
  component: GalleryScreen,
});
