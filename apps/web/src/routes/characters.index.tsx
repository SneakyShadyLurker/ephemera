import { createFileRoute } from "@tanstack/react-router";
import { GalleryScreen } from "../characters/Gallery.tsx";
import { charactersQuery } from "../characters/queries.ts";

export const Route = createFileRoute("/characters/")({
  // The list arrives with the screen. A failure renders at once (no retries here, so a click never stalls); the gallery shows it and retries.
  loader: async ({ context }) => {
    await context.queryClient
      .query({ ...charactersQuery, staleTime: "static", retry: false })
      .catch(() => undefined);
  },
  component: GalleryScreen,
});
