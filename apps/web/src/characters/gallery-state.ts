import { hasTag, sameTag } from "@ephemera/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Order } from "./filter.ts";

/**
 * The gallery's presentation state, kept in memory while the tab is open so
 * the search and filters survive a visit to a sheet. Never chat content.
 */
export interface GalleryState {
  query: string;
  tags: string[];
  order: Order;
  /** Characters imported in this visit: their portraits surface once. */
  arrived: string[];
  /** The character last opened, whose tile carries the portrait transition back. */
  opened: string | null;
}

export const galleryStore = createStore<GalleryState>()(() => ({
  query: "",
  tags: [],
  order: "recent",
  arrived: [],
  opened: null,
}));

export function useGallery<T>(selector: (state: GalleryState) => T): T {
  return useStore(galleryStore, selector);
}

export const setQuery = (query: string) => galleryStore.setState({ query });
export const setOrder = (order: Order) => galleryStore.setState({ order });
export const toggleTag = (tag: string) =>
  galleryStore.setState((state) => ({
    tags: hasTag(state.tags, tag)
      ? state.tags.filter((t) => !sameTag(t, tag))
      : [...state.tags, tag],
  }));
export const clearFilters = () => galleryStore.setState({ query: "", tags: [] });
export const setOpened = (opened: string | null) => galleryStore.setState({ opened });
