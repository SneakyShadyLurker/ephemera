import { flushSync } from "react-dom";
import { useStore } from "zustand";
import { artSessionDeps, modelInfo } from "../creator/art-session-deps.ts";
import { setCreatorWriting } from "../creator/writing.ts";
import { reworkStore } from "../rework/session.ts";
import { isLocked } from "../rework/store.ts";
import { currentSettings } from "../settings/settings.ts";
import { signIn } from "../signin/signin.ts";
import { createSheetArtStore, type SheetArtState } from "./store.ts";

/** The tab's one sheet-art session; the sheet binds it on opening the studio and clears it on leaving. */
export const sheetArtStore = createSheetArtStore({
  ...artSessionDeps,
  savedModel: () => currentSettings().model,
  modelInfo,
  reworkLocked: () => isLocked(reworkStore.getState()),
  // The navigation lamp reads the creator's in-flight flag; new art is model work too.
  writing: setCreatorWriting,
});

export function useSheetArt<T>(selector: (state: SheetArtState) => T): T {
  return useStore(sheetArtStore, selector);
}

// Signed in again: a batch or a Use the sign-in interrupted is sent once more, after the saves.
signIn.onRenewed(() => {
  const state = sheetArtStore.getState();
  state.resumeArt();
  state.resumeUse();
}, "resume");

// `pagehide` empties the session synchronously, DOM included, so the back/forward cache cannot
// restore a direction or a candidate. A reload or a closed tab loses the memory anyway.
window.addEventListener("pagehide", () => {
  flushSync(() => sheetArtStore.getState().clear());
});
