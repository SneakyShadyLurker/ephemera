import { createFileRoute } from "@tanstack/react-router";
import { PersonasScreen } from "../personas/Gallery.tsx";
import { personasQuery } from "../personas/queries.ts";

export const Route = createFileRoute("/personas/")({
  // The list arrives with the screen. A failure renders at once (no retries here, so a click never stalls); the gallery shows it and retries.
  loader: async ({ context }) => {
    await context.queryClient
      .query({ ...personasQuery, staleTime: "static", retry: false })
      .catch(() => undefined);
  },
  component: PersonasScreen,
});
