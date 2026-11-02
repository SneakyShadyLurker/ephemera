import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * Whether the creator is writing a card or developing its art: presentation
 * state, never content. The navigation mark's drip runs at the in-flight
 * pace while it is set, as it does for a chat reply. Kept apart from the creator's
 * session so the app shell can read it without loading the creator.
 */
const writingStore = createStore<{ writing: boolean }>()(() => ({ writing: false }));

export const setCreatorWriting = (writing: boolean) => writingStore.setState({ writing });

export function useCreatorWriting(): boolean {
  return useStore(writingStore, (state) => state.writing);
}
