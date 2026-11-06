import { useEffect } from "react";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { reviewOrder } from "./order.ts";
import { reworkStore } from "./session.ts";

/*
 * The sheet scrolls once per run, to the first change that arrives, and
 * only if the owner has not scrolled since sending (R2): after that,
 * arrivals keep the reader's place (the browser's scroll anchoring).
 */

/** Keys that scroll the sheet, outside a text field. */
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]);

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("textarea, input, select") !== null);

export function useFirstChangeScroll(): void {
  useEffect(() => {
    let epoch = reworkStore.getState().epoch;
    let scrolled = false;
    let done = false;
    let active = true;
    let frame = 0;
    const cancel = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const owner = () => {
      scrolled = true;
      cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !typing(event.target)) owner();
    };
    window.addEventListener("wheel", owner, { passive: true, capture: true });
    window.addEventListener("touchmove", owner, { passive: true, capture: true });
    window.addEventListener("keydown", key, { capture: true });
    const unsubscribe = reworkStore.subscribe((state) => {
      // Every new run starts afresh.
      if (state.epoch !== epoch) {
        cancel();
        epoch = state.epoch;
        scrolled = false;
        done = false;
      }
      if (state.phase !== "working" && !(state.phase === "review" && state.ended === "complete")) {
        cancel();
        return;
      }
      if (done || state.phase !== "working") return;
      const [first] = reviewOrder(state.changes);
      if (first === undefined) return;
      done = true;
      if (scrolled) return;
      const scheduledEpoch = epoch;
      // The change's view renders after this update.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = reworkStore.getState();
        if (
          !active ||
          scrolled ||
          current.epoch !== scheduledEpoch ||
          (current.phase !== "working" &&
            !(current.phase === "review" && current.ended === "complete"))
        )
          return;
        const target = document.querySelector<HTMLElement>(`[data-change-at="${first.at}"]`);
        target?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
      });
    });
    return () => {
      active = false;
      unsubscribe();
      cancel();
      window.removeEventListener("wheel", owner, { capture: true });
      window.removeEventListener("touchmove", owner, { capture: true });
      window.removeEventListener("keydown", key, { capture: true });
    };
  }, []);
}
