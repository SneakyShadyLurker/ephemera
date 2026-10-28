import { createFileRoute } from "@tanstack/react-router";
import { PersonaSheetScreen } from "../personas/Sheet.tsx";

/** The persona sheet, loaded on demand as its own chunk; `/personas/new` opens an empty one. */
export const Route = createFileRoute("/personas/$id")({
  component: function PersonaSheetRoute() {
    const { id } = Route.useParams();
    return <PersonaSheetScreen id={id} />;
  },
});
