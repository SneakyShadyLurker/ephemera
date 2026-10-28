import { createFileRoute } from "@tanstack/react-router";
import { PersonasScreen } from "../personas/Gallery.tsx";
import { personasQuery } from "../personas/queries.ts";

export const Route = createFileRoute("/personas/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(personasQuery);
  },
  component: PersonasScreen,
});
