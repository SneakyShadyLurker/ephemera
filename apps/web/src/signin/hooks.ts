import { useStore } from "zustand";
import { isSignedInPhase, notReached, type SignInPhase, signIn } from "./signin.ts";

export function useSignInPhase(): SignInPhase {
  return useStore(signIn.store, (state) => state.phase);
}

/** False while the session is gone: nothing that needs a request can start. */
export function useSignedIn(): boolean {
  return useStore(signIn.store, (state) => isSignedInPhase(state.phase));
}

/** Why an action got no answer, following the sign-in state (see `notReached`). */
export function useNotReached(): string {
  return notReached(useSignInPhase());
}

/** Advances with every renewal; images that failed while signed out key on it to load again. */
export function useRenewals(): number {
  return useStore(signIn.store, (state) => state.renewals);
}
