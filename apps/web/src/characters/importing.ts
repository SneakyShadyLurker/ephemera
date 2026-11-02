import type { QueryClient } from "@tanstack/react-query";
import { createImportQueue } from "@/app/importing";
import { galleryStore } from "./gallery-state.ts";
import { importCard, refreshCharacters } from "./queries.ts";

/**
 * The gallery's card imports, one at a time (each can be 32 MB): the list
 * refreshes as each arrives so portraits surface in order, then every file
 * is reported.
 */
export const cardImports = createImportQueue(importCard);

export function importCards(files: File[], queryClient: QueryClient): Promise<void> {
  return cardImports.add(files, async (outcome) => {
    galleryStore.setState((state) => ({ arrived: [...state.arrived, outcome.id] }));
    await refreshCharacters(queryClient);
  });
}

/** Card files a drop or picker may offer; anything else is left to the server to refuse. */
export const CARD_FILE_TYPES = ".png,.json,image/png,application/json";
