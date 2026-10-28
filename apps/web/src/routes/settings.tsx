import { createFileRoute } from "@tanstack/react-router";
import { modelsQuery } from "../api.ts";
import { personasQuery } from "../personas/queries.ts";
import { SettingsScreen } from "../settings/SettingsScreen.tsx";

export const Route = createFileRoute("/settings")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(personasQuery);
    void context.queryClient.prefetchQuery(modelsQuery);
  },
  component: SettingsScreen,
});
