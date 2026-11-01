import { flushSync } from "react-dom";
import { useStore } from "zustand";
import { createCharacter } from "../characters/queries.ts";
import { signIn } from "../signin/signin.ts";
import { artSessionDeps } from "./art-session-deps.ts";
import { type CreatorState, createCreatorStore } from "./store.ts";
import { streamBrainstorm, streamCard } from "./stream.ts";

export { hasUnsavedCard, keeping } from "./store.ts";

/** The tab's one creator session; it loads with the create screen. */
export const creatorStore = createCreatorStore({
  ...artSessionDeps,
  streamCard,
  streamBrainstorm,
  // Keep goes through the existing create call.
  saveCard: createCharacter,
});

export function useCreator<T>(selector: (state: CreatorState) => T): T {
  return useStore(creatorStore, selector);
}

// Signed in again: a card, batch or brainstorm round the sign-in interrupted is sent once more, after the saves.
signIn.onRenewed(() => creatorStore.getState().resume(), "resume");

// `pagehide` empties the session synchronously, DOM included, so the back/forward cache cannot
// restore a description, a card or a portrait. A reload or a closed tab loses the memory anyway.
window.addEventListener("pagehide", () => {
  flushSync(() => creatorStore.getState().clear());
});
