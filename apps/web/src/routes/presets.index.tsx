import { createFileRoute } from "@tanstack/react-router";
import { PresetsScreen } from "../presets/List.tsx";
import { presetsQuery } from "../presets/queries.ts";

export const Route = createFileRoute("/presets/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(presetsQuery("sampler"));
    void context.queryClient.prefetchQuery(presetsQuery("prompt"));
  },
  component: PresetsScreen,
});
