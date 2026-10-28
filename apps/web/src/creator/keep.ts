import type { CreatorStore, KeepRun } from "./store.ts";

/** The steps after a Keep, which the action bar supplies. */
interface KeepSteps {
  /** Refreshes what the destination shows: the characters list, a portrait loaded ahead. */
  settle: (run: KeepRun) => Promise<void>;
  /** Navigates to the gallery or the sheet. */
  leave: (run: KeepRun) => Promise<void>;
}

/**
 * Keep, then leave for the gallery or the sheet and empty the session. The
 * steps after the save take time, and the owner may leave meanwhile and
 * start a new description; only a session that is still the one Keep
 * started from is navigated away from and emptied.
 */
export async function keepAndLeave(
  store: CreatorStore,
  steps: KeepSteps,
  /** Keep and edit after a portrait failure: the card is saved and needs no second try. */
  cardSaved = false,
): Promise<void> {
  const { epoch, description } = store.getState();
  if (!cardSaved && !(await store.getState().keep())) return;
  const run = store.getState().keepRun;
  if (run === null) return;
  const ours = () => {
    const state = store.getState();
    return state.epoch === epoch && state.keepRun?.snapshot.id === run.snapshot.id;
  };
  await steps.settle(run);
  if (!ours()) return;
  await steps.leave(run);
  // Leaving the screen returns the session to its description; anything else is new work.
  const state = store.getState();
  if (ours() || (state.card === null && state.description === description)) state.clear();
}
