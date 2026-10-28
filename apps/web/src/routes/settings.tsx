import { modelIdSchema } from "@ephemera/core";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { modelsQuery } from "../api.ts";
import { personasQuery } from "../personas/queries.ts";
import { SettingsScreen } from "../settings/SettingsScreen.tsx";
import { useWindowShown } from "../settings/window-link.tsx";

/**
 * Settings. `window` names a model whose context window is to be set: Context
 * lists it, scrolls to it and focuses its window editor (`windowLink`).
 */
export const Route = createFileRoute("/settings")({
  validateSearch: z.object({
    window: modelIdSchema.optional().catch(undefined),
  }),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(personasQuery);
    void context.queryClient.prefetchQuery(modelsQuery);
  },
  component: function SettingsRoute() {
    const { window } = Route.useSearch();
    const shown = useWindowShown();
    return <SettingsScreen windowFor={window ?? null} onWindowShown={shown} />;
  },
});
