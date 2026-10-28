import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** Which overlays are open: presentation state, never chat content. */
interface UiState {
  navOpen: boolean;
  sessionOpen: boolean;
  inspectorOpen: boolean;
  /** The inspector's code did not load; the browser keeps that until the page reloads. */
  inspectorUnavailable: boolean;
}

export const uiStore = createStore<UiState>()(() => ({
  navOpen: false,
  sessionOpen: false,
  inspectorOpen: false,
  inspectorUnavailable: false,
}));

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(uiStore, selector);
}

/** Surfaces that hold focus while open: dialogs, confirmations, drawers, the portrait viewer. */
const OVERLAY = '[role="dialog"], [role="alertdialog"], [data-portrait-viewer]';
/** Modal surfaces that own the keys wherever focus is. */
const MODAL = '[role="alertdialog"], [data-portrait-viewer]';

/**
 * Whether another overlay owns the keys the chat listens for: the
 * navigation sheet, the inspector, a confirmation or the portrait viewer is
 * open, or the key comes from inside a dialog or a drawer. A surface
 * matching `except` (a shortcut's own sheet) does not count.
 */
export function overlayOwnsKeys(event: KeyboardEvent, except?: string): boolean {
  const { navOpen, inspectorOpen } = uiStore.getState();
  if (navOpen || inspectorOpen || document.querySelector(MODAL) !== null) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(OVERLAY) == null) return false;
  return except === undefined || target.closest(except) === null;
}

/**
 * The owner's latest overlay action: an inspector that finishes loading after
 * a newer one (or after leaving the chat) does not open over it.
 */
let intent = 0;
export const overlayIntent = { next: () => ++intent, current: () => intent };

export const setNavOpen = (navOpen: boolean) => {
  intent++;
  uiStore.setState({ navOpen });
};
export const setSessionOpen = (sessionOpen: boolean) => {
  intent++;
  uiStore.setState({ sessionOpen });
};
export const toggleSession = () => {
  intent++;
  uiStore.setState((state) => ({ sessionOpen: !state.sessionOpen }));
};
export const setInspectorOpen = (open: boolean) =>
  uiStore.setState((state) => ({ inspectorOpen: open && !state.inspectorUnavailable }));
/** The inspector cannot open again in this page; nothing is left open behind it. */
export const markInspectorUnavailable = () =>
  uiStore.setState({ inspectorUnavailable: true, inspectorOpen: false });
