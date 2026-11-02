import { hasTag, sameTag } from "@ephemera/core";
import { addTransitionType, startTransition, useEffect, useState } from "react";
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

/** What the gallery filters by. */
export const filtersOf = ({ query, tags, order }: GalleryState) => ({ query, tags, order });

/** The transition type of a new order or tag filter: the gallery's cards glide to their places. */
export const REORDER = "gallery-reorder";

/**
 * The filters the gallery's cards show. A search applies at once, so typing
 * stays immediate; a new order or tag filter applies in a transition typed
 * `REORDER`, so the cards glide to their places (the gallery's
 * ViewTransitions). Held in React state for that: an external store's
 * updates are always synchronous, never a transition.
 */
export function useShownFilters() {
  const [shown, setShown] = useState(() => filtersOf(galleryStore.getState()));
  useEffect(
    () =>
      galleryStore.subscribe((state, previous) => {
        if (state.order !== previous.order || state.tags !== previous.tags) {
          startTransition(() => {
            addTransitionType(REORDER);
            setShown(filtersOf(state));
          });
        } else if (state.query !== previous.query) {
          setShown(filtersOf(state));
        }
      }),
    [],
  );
  return shown;
}
