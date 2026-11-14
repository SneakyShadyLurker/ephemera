import type { AssistantMessage, Reply } from "./store.ts";

/** The alternate of a reply that is on screen. */
export const shownReply = (message: AssistantMessage): Reply =>
  message.replies[message.shown] ?? (message.replies[0] as Reply);
