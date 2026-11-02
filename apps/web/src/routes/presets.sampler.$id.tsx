import { createFileRoute } from "@tanstack/react-router";
import { presetQuery } from "../presets/queries.ts";
import { SamplerPresetScreen } from "../presets/SamplerSheet.tsx";

/** The sampler preset editor, loaded on demand as its own chunk. */
export const Route = createFileRoute("/presets/sampler/$id")({
  preloadStaleTime: 0,
  loader: {
    staleReloadMode: "blocking",
    handler: ({ context, params }) =>
      context.queryClient
        .query({ ...presetQuery("sampler", params.id), staleTime: 0 })
        .catch(() => undefined),
  },
  component: function SamplerPresetRoute() {
    const { id } = Route.useParams();
    return <SamplerPresetScreen id={id} />;
  },
});
