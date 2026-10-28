import { flushSync } from "react-dom";
import { useStore } from "zustand";
import { setCreatorWriting } from "../creator/writing.ts";
import { signIn } from "../signin/signin.ts";
import { createReworkStore, isLocked, type ReworkState } from "./store.ts";
import { streamRework } from "./stream.ts";

/** The tab's one rework session; the sheet binds it to its character and clears it on leaving. */
export const reworkStore = createReworkStore({
  streamRework,
  signedIn: signIn.signedIn,
  // The navigation lamp reads the creator's in-flight flag; a rework is model writing too.
  writing: setCreatorWriting,
});

export function useRework<T>(selector: (state: ReworkState) => T): T {
  return useStore(reworkStore, selector);
}

/** While the model works or its changes are under review, the sheet's fields are read-only. */
export const useReworkLocked = (): boolean => useRework(isLocked);

// Signed in again: a run the sign-in interrupted is sent once more, after the saves.
signIn.onRenewed(() => reworkStore.getState().resume(), "resume");

// `pagehide` empties the session synchronously, DOM included, so the back/forward cache cannot
// restore a request, an answer, a change or an Undo snapshot. A reload loses the memory anyway.
window.addEventListener("pagehide", () => {
  flushSync(() => reworkStore.getState().clear());
});
