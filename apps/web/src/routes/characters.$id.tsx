import { createFileRoute } from "@tanstack/react-router";
import { characterQuery } from "../characters/queries.ts";
import { SheetScreen } from "../characters/Sheet.tsx";

/** The character sheet, loaded on demand as its own chunk; `/characters/new` opens an empty one. */
export const Route = createFileRoute("/characters/$id")({
  preloadStaleTime: 0,
  loader: {
    staleReloadMode: "blocking",
    handler: ({ context, params }) =>
      params.id === "new"
        ? undefined
        : context.queryClient
            .query({ ...characterQuery(params.id), staleTime: 0 })
            .catch(() => undefined),
  },
  component: function CharacterSheetRoute() {
    const { id } = Route.useParams();
    return <SheetScreen id={id} />;
  },
});
