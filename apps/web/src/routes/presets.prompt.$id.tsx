import { createFileRoute } from "@tanstack/react-router";
import { PromptPresetScreen } from "../presets/PromptSheet.tsx";
import { presetQuery } from "../presets/queries.ts";

/** The prompt preset editor, loaded on demand as its own chunk. */
export const Route = createFileRoute("/presets/prompt/$id")({
  preloadStaleTime: 0,
  loader: {
    staleReloadMode: "blocking",
    handler: ({ context, params }) =>
      context.queryClient
        .query({ ...presetQuery("prompt", params.id), staleTime: 0 })
        .catch(() => undefined),
  },
  component: function PromptPresetRoute() {
    const { id } = Route.useParams();
    return <PromptPresetScreen id={id} />;
  },
});
