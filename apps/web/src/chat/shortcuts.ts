import { useEffect } from "react";
import { overlayOwnsKeys } from "@/app/ui.ts";
import { isComposing } from "@/lib/keys.ts";
import { COMPOSER } from "./Composer.tsx";
import { swipe } from "./Swipe.tsx";
import { chatStore } from "./session.ts";

/** Controls whose arrow keys move inside them, and fields other than the composer. */
const OWNS_ARROWS =
  'input, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="radiogroup"], [role="tablist"], [role="toolbar"], [role="slider"]';

/**
 * Chat keys: Left and Right swipe the last reply while the
 * composer is empty and no control owns the arrows; Ctrl+Enter replaces the
 * last reply and Alt+Enter continues it, also from the composer. The edit
 * field keeps Ctrl+Enter for Save.
 */
export function useChatShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposing(event)) return;
      const state = chatStore.getState();
      if (overlayOwnsKeys(event) || state.editing !== null) return;
      const target = event.target instanceof Element ? event.target : null;
      const composer = target?.matches(COMPOSER) ?? false;
      const otherField = !composer && target?.closest(`textarea, ${OWNS_ARROWS}`) != null;

      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey) {
        // Off while the composer holds a draft, wherever focus is.
        if (event.ctrlKey || event.metaKey || event.altKey || otherField || state.draft !== "") {
          return;
        }
        event.preventDefault();
        void swipe(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Enter" && !otherField && !event.shiftKey) {
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          void state.regenerate();
        } else if (event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          void state.continueReply();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
