import { BUILD_HEADER } from "@ephemera/server/build";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * Whether the server runs another build than this tab: a tab loaded before a
 * deploy keeps its code, whose schemas can refuse what the new server sends.
 * Once seen it stays seen; only a reload loads the new build.
 */
const behind = createStore<boolean>()(() => false);

/**
 * Reads the build an API response names (apiFetch sees every one) against
 * the build this tab was bundled as; a response naming none says nothing.
 */
export function noteBuild(response: Response): void {
  const served = response.headers.get(BUILD_HEADER);
  if (served !== null && served !== import.meta.env.EPHEMERA_BUILD) behind.setState(true);
}

/** Whether a response named another build than this tab's. */
export const behindServer = (): boolean => behind.getState();

export const useBehindServer = (): boolean => useStore(behind);
