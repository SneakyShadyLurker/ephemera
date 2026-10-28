import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MemoryScreen } from "../memory/MemoryScreen.tsx";

/**
 * A character's memory, loaded on demand as its own chunk; the open chat
 * survives the visit. `from` says the chat's Memory mark opened it (a static
 * UI origin, never chat content), so Back returns to the chat.
 */
export const Route = createFileRoute("/characters/$id_/memory")({
  validateSearch: z.object({ from: z.literal("chat").optional().catch(undefined) }),
  component: function MemoryRoute() {
    const { id } = Route.useParams();
    const { from } = Route.useSearch();
    return <MemoryScreen id={id} from={from} />;
  },
});
