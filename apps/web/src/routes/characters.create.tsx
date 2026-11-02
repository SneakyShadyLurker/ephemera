import { createFileRoute } from "@tanstack/react-router";
import { modelsQuery } from "../api.ts";
import { CreateScreen } from "../creator/CreateScreen.tsx";
import { artStatusQuery } from "../creator/queries.ts";
import { personasQuery } from "../personas/queries.ts";
import { settingsQuery } from "../settings/settings.ts";

/** Create with AI: a static segment, matched before `/characters/$id`. Nothing of it reaches the URL. */
export const Route = createFileRoute("/characters/create")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(modelsQuery);
    // After the saved settings (the root loader's request), so the saved workflow is the one checked.
    void context.queryClient.ensureQueryData(settingsQuery).then(
      (settings) => context.queryClient.prefetchQuery(artStatusQuery(settings.comfyuiWorkflow)),
      () => undefined,
    );
    void context.queryClient.prefetchQuery(personasQuery);
  },
  component: CreateScreen,
});
