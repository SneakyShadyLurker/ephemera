import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { arrivals } from "../sheet/arrival.ts";

/*
 * The library's presentation state, in memory while the tab is open, so Find
 * and the last action's words survive a visit to a book. Never chat content;
 * never in the URL, history or storage.
 */

interface LibraryState {
  find: string;
  /** The book last opened from its row, whose name glides back into that row. */
  opened: string | null;
  /** What an action elsewhere did (a delete in the editor), said once on the library's arrival. */
  notice: string | null;
}

const libraryStore = createStore<LibraryState>()(() => ({
  find: "",
  opened: null,
  notice: null,
}));

export function useLibrary<T>(selector: (state: LibraryState) => T): T {
  return useStore(libraryStore, selector);
}

export const setFind = (find: string) => libraryStore.setState({ find });
export const setOpened = (opened: string | null) => libraryStore.setState({ opened });
export const setNotice = (notice: string | null) => libraryStore.setState({ notice });

/** The notice left for the library, taken once. */
export function takeNotice(): string | null {
  const { notice } = libraryStore.getState();
  libraryStore.setState({ notice: null });
  return notice;
}

/** What a book's editor does on arrival: say what brought it there, select a new book's name. */
export const bookArrivals = arrivals<{ notice?: string; selectName?: boolean }>();
