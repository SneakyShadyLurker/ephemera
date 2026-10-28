import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** The list screens whose scroll is kept. */
type ScrollId = "characters" | "personas" | "lorebooks" | "presets";

/**
 * Where each list screen's body was scrolled, kept in memory while the tab is
 * open, so the way back from a sheet lands where the list was left. Never in
 * browser storage, which is why the router's own restoration stays off (main.tsx).
 */
const positions = new Map<ScrollId, number>();

/** The next arrival at the list starts at the top, where it says what was just done (Kept, Deleted). */
export const forgetScroll = (id: ScrollId) => positions.delete(id);

/**
 * Keeps the scroll of the scroller it sits in, under `id`; place it first in
 * that scroller. Layout effects run children first and in order, so the
 * position is back before the rows after it check they are on screen
 * (`useOnScreen`) and before the route's view transition takes its picture.
 * `ready` while the list is shown (loaded, not replaced by an error): a
 * shorter body would clamp the position, and the clamp is not kept.
 */
export function KeptScroll({ id, ready }: { id: ScrollId; ready: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const scroller = anchor.current?.parentElement;
    if (!ready || !scroller) return;
    scroller.scrollTop = positions.get(id) ?? 0;
    const keep = () => positions.set(id, scroller.scrollTop);
    scroller.addEventListener("scroll", keep, { passive: true });
    return () => scroller.removeEventListener("scroll", keep);
  }, [id, ready]);
  return <span ref={anchor} hidden />;
}

/**
 * Whether `ref` shows within its screen's scroller while `active`: measured
 * before paint, then as the scroller moves. A shared transition back from a
 * sheet lands only on what is on screen, not on a row the list has moved out
 * of view, and leaves from it again once it is scrolled back in.
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || element === null) return;
    const scroller = element.closest<HTMLElement>("[data-skip-target]");
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const bounds = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      setOnScreen(rect.bottom > bounds.top && rect.top < bounds.bottom);
    };
    measure();
    scroller?.addEventListener("scroll", measure, { passive: true });
    return () => scroller?.removeEventListener("scroll", measure);
  }, [ref, active]);
  return onScreen;
}
