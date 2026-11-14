/**
 * Every native view transition in the tab starts through `document`: the
 * router's (main.tsx), the creator's and the portrait viewer's. The browser
 * drops a transition's animation when a newer transition starts, the window
 * changes size or the tab is hidden, and then rejects its `ready` although
 * its update ran. No caller reads `ready`, the router's included, so each
 * drop would be reported as an uncaught error. This settles those rejections
 * where every transition starts; any other (a duplicate transition name, a
 * failed update) is still reported.
 */
export function settleSkippedViewTransitions(): void {
  if (typeof document.startViewTransition !== "function") return;
  const start = document.startViewTransition.bind(document);
  const size = () => `${window.innerWidth}x${window.innerHeight}`;
  document.startViewTransition = (...args: Parameters<typeof start>) => {
    const before = size();
    const transition = start(...args);
    transition.ready.catch((error: unknown) => {
      if (!(error instanceof DOMException)) throw error;
      // A newer transition took over.
      if (error.name === "AbortError") return;
      // The same error names a duplicate transition name, so the cause is checked, not the text.
      const dropped = size() !== before || document.visibilityState === "hidden";
      if (error.name !== "InvalidStateError" || !dropped) throw error;
    });
    return transition;
  };
}
