import { createFileRoute } from "@tanstack/react-router";
import { modelsQuery } from "../api.ts";
import { charactersQuery } from "../characters/queries.ts";
import { ChatScreen } from "../chat/ChatScreen.tsx";
import { presetsQuery } from "../presets/queries.ts";

export const Route = createFileRoute("/")({
  // Starts the model list request without holding the screen back; the prompt
  // presets tell the chat which reasoning a request needs.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(modelsQuery);
    void context.queryClient.prefetchQuery(charactersQuery);
    void context.queryClient.prefetchQuery(presetsQuery("prompt"));
  },
  component: ChatScreen,
});
