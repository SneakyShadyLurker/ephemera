import { createFileRoute } from "@tanstack/react-router";
import { PromptPresetScreen } from "../presets/PromptSheet.tsx";

/** The prompt preset editor, loaded on demand as its own chunk. */
export const Route = createFileRoute("/presets/prompt/$id")({
  component: function PromptPresetRoute() {
    const { id } = Route.useParams();
    return <PromptPresetScreen id={id} />;
  },
});
