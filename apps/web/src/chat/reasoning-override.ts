import type { ReasoningEffort } from "@ephemera/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * The reasoning effort Session sets for this tab in place of the sampler
 * preset's: null follows the preset. Never saved, so a reload follows the
 * preset again; choosing a sampler preset clears it.
 */
interface ReasoningOverrideState {
  effort: ReasoningEffort | null;
}

export const reasoningOverrideStore = createStore<ReasoningOverrideState>()(() => ({
  effort: null,
}));

export function useReasoningOverride(): ReasoningEffort | null {
  return useStore(reasoningOverrideStore, (state) => state.effort);
}

export const setReasoningOverride = (effort: ReasoningEffort | null) => {
  reasoningOverrideStore.setState({ effort });
};
