import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

/**
 * Three form factors, chosen by available width rather than device, so a
 * narrow split-screen tablet gets the phone layout.
 */
type FormFactor = "phone" | "tablet" | "desktop";

type Query = "desktop" | "tablet" | "dock" | "coarse";

/** Matches from a breakpoint in styles.css, where it is defined once (`@theme static`). */
function atLeast(name: "tablet" | "desktop" | "dock"): MediaQueryList {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--breakpoint-${name}`)
    .trim();
  // Without the stylesheet (a failed asset) the app still runs unstyled, as phone, keeping the chat.
  return window.matchMedia(value === "" ? "not all" : `(width >= ${value})`);
}

let lists: Record<Query, MediaQueryList> | undefined;
let touch: MediaQueryList | undefined;

/** Touch: no hover, so controls that hover reveals are shown, and replies swipe by drag. */
const coarse = () => (touch ??= window.matchMedia("(pointer: coarse)"));

/** Built on first use, never at module load, so the stylesheet is in place by then. */
function queries(): Record<Query, MediaQueryList> {
  lists ??= {
    desktop: atLeast("desktop"),
    tablet: atLeast("tablet"),
    /** Rail, full-width thread and Session panel side by side; below this Session overlays. */
    dock: atLeast("dock"),
    coarse: coarse(),
  };
  return lists;
}

function subscribe(onChange: () => void): () => void {
  const all = Object.values(queries());
  for (const query of all) query.addEventListener("change", onChange);
  return () => {
    for (const query of all) query.removeEventListener("change", onChange);
  };
}

function formFactor(): FormFactor {
  const { desktop, tablet } = queries();
  if (desktop.matches) return "desktop";
  return tablet.matches ? "tablet" : "phone";
}

export function useFormFactor(): FormFactor {
  return useSyncExternalStore(subscribe, formFactor);
}

/** Whether Session can dock beside the thread, read now. */
export const canDock = (): boolean => queries().dock.matches;

export function useCanDock(): boolean {
  return useSyncExternalStore(subscribe, canDock);
}

/** Whether the primary pointer is touch, read now. */
export const isCoarsePointer = (): boolean => coarse().matches;

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, isCoarsePointer);
}

/**
 * Keeps focus when `layout` changes and a component swaps one tree for
 * another (docked or overlaid, say): if the element focused last left the
 * document with the swap, focus moves to the new element with its `id`, or
 * else to what `fallback` picks given the element that left, still inside
 * its detached tree. A swap that leaves the focused element in place changes
 * nothing. Removal fires no focus event, so the last `focusin` names it.
 */
export function useFocusAcrossLayout(
  layout: unknown,
  fallback?: (lost: Element) => HTMLElement | null | undefined,
): void {
  const last = useRef<Element | null>(null);
  useEffect(() => {
    const note = (event: FocusEvent) => {
      last.current = event.target instanceof Element ? event.target : null;
    };
    document.addEventListener("focusin", note);
    return () => document.removeEventListener("focusin", note);
  }, []);
  const previous = useRef(layout);
  useLayoutEffect(() => {
    if (Object.is(previous.current, layout)) return;
    previous.current = layout;
    const lost = last.current;
    if (lost === null || lost.isConnected) return;
    const twin = lost.id === "" ? null : document.getElementById(lost.id);
    (twin ?? fallback?.(lost))?.focus();
  });
}
