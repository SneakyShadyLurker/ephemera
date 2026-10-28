import { flushSync } from "react-dom";

/**
 * Moves the screen from one state to the next inside a native view
 * transition, so a shared element (the chosen kind) morphs and the rest
 * crossfades; reduced motion keeps a short fade (styles.css).
 */
export function inTransition(update: () => void): void {
  document.startViewTransition(() => flushSync(update));
}

/** The shared-element name of a kind's label, from its panel to the describe state's control. */
export const kindTransition = (kind: string) => `creator-kind-${kind}`;
