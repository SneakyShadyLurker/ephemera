import { flushSync } from "react-dom";

/**
 * Moves the screen from one state to the next inside a native view
 * transition, so a shared element (the chosen kind) morphs and the rest
 * crossfades; reduced motion keeps a short fade (styles.css). Not React's
 * <ViewTransition>: the creator's state lives in an external store
 * (session.ts), whose updates React always applies synchronously, never as
 * the transition a <ViewTransition> animates.
 */
export function inTransition(update: () => void): void {
  // No snapshot can be shown in a hidden tab. Completion can arrive from an
  // Effect there, so let React commit normally rather than flushing in a lifecycle.
  if (document.visibilityState === "hidden") {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}

/** The shared-element name of a kind's label, from its panel to the describe state's control. */
export const kindTransition = (kind: string) => `creator-kind-${kind}`;
