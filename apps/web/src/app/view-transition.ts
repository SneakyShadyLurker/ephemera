/**
 * Every native view transition in the tab starts through `document`: the
 * router's (main.tsx), the creator's and the portrait viewer's. A newer
 * transition skips the one still running, and the browser then rejects the
 * older one's `ready` with an AbortError although its update ran. No caller
 * reads `ready`, the router's included, so each skip would be reported as an
 * uncaught error. This settles that one rejection where every transition
 * starts; any other (a duplicate transition name, a failed update) is still
 * reported.
 */
export function settleSkippedViewTransitions(): void {
  if (typeof document.startViewTransition !== "function") return;
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = (...args: Parameters<typeof start>) => {
    const transition = start(...args);
    transition.ready.catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    });
    return transition;
  };
}
