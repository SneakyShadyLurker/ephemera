import { useSyncExternalStore } from "react";

/** CSS stops the loops under this preference; effects that tune running animations re-run when it changes. */
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the preference is set; false where there is no window to ask (a server render). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/** How a scroll a script starts moves, read as it starts: at once under the preference, smoothly otherwise. */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia(QUERY).matches ? "instant" : "smooth";
}
