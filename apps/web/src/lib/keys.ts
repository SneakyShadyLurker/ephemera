import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Whether a keydown belongs to an IME composition still under way, so its
 * Enter or Escape confirms or cancels a candidate rather than acting. keyCode
 * 229 marks a keydown the IME is still processing; `isComposing` alone misses some.
 */
export function isComposing(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
