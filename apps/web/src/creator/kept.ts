import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * The character Keep just saved, for the gallery's confirmation: a kept card
 * is ordinary character data, no longer a creation draft. In memory only.
 */
export const keptStore = createStore<{ kept: { id: string; name: string } | null }>()(() => ({
  kept: null,
}));

export function useKept() {
  return useStore(keptStore, (state) => state.kept);
}
