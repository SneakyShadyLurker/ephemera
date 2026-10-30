import { modelIdSchema } from "@ephemera/core";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { modelsQuery } from "../api.ts";
import { personasQuery } from "../personas/queries.ts";
import { SettingsScreen } from "../settings/SettingsScreen.tsx";
import { sectionSchema } from "../settings/sections.ts";
import { useWindowShown } from "../settings/window-link.tsx";

/**
 * Settings. `section` is the category shown (`settings/sections.ts`); an
 * unknown one is dropped. `window` names a model whose context window is to
 * be set: Model setup opens, Context lists it, scrolls to it and focuses its
 * window editor (`windowLink`).
 */
export const Route = createFileRoute("/settings")({
  validateSearch: z.object({
    section: sectionSchema.optional().catch(undefined),
    window: modelIdSchema.optional().catch(undefined),
  }),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(personasQuery);
    void context.queryClient.prefetchQuery(modelsQuery);
  },
  component: function SettingsRoute() {
    const search = Route.useSearch();
    const shown = useWindowShown();
    return <SettingsScreen search={search} onWindowShown={shown} />;
  },
});
