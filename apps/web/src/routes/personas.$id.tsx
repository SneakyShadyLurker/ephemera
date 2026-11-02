import { createFileRoute } from "@tanstack/react-router";
import { personaQuery } from "../personas/queries.ts";
import { PersonaSheetScreen } from "../personas/Sheet.tsx";

/** The persona sheet, loaded on demand as its own chunk; `/personas/new` opens an empty one. */
export const Route = createFileRoute("/personas/$id")({
  preloadStaleTime: 0,
  loader: {
    staleReloadMode: "blocking",
    handler: ({ context, params }) =>
      params.id === "new"
        ? undefined
        : context.queryClient
            .query({ ...personaQuery(params.id), staleTime: 0 })
            .catch(() => undefined),
  },
  component: function PersonaSheetRoute() {
    const { id } = Route.useParams();
    return <PersonaSheetScreen id={id} />;
  },
});
