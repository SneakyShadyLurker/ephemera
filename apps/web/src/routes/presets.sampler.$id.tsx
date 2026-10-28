import { createFileRoute } from "@tanstack/react-router";
import { SamplerPresetScreen } from "../presets/SamplerSheet.tsx";

/** The sampler preset editor, loaded on demand as its own chunk. */
export const Route = createFileRoute("/presets/sampler/$id")({
  component: function SamplerPresetRoute() {
    const { id } = Route.useParams();
    return <SamplerPresetScreen id={id} />;
  },
});
