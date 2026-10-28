import { createFileRoute } from "@tanstack/react-router";
import { SheetScreen } from "../characters/Sheet.tsx";

/** The character sheet, loaded on demand as its own chunk; `/characters/new` opens an empty one. */
export const Route = createFileRoute("/characters/$id")({
  component: function CharacterSheetRoute() {
    const { id } = Route.useParams();
    return <SheetScreen id={id} />;
  },
});
