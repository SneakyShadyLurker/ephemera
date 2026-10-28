import {
  CUSTOM_SLOTS,
  type CustomPalette,
  type CustomPaletteInput,
  type CustomSlot,
  customPaletteInputSchema,
  paletteResponseSchema,
  palettesResponseSchema,
} from "@ephemera/core";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../api.ts";
import { queryClient } from "../app/query.ts";
import { failureOf, failureWords, SAVE_TIMEOUT_MS, unsafeOptions } from "../sheet/saving.ts";
import { notReached } from "../signin/signin.ts";

/*
 * The player's custom palettes (PRINCIPLES.md 1: UI settings, kept on the
 * server, in memory here like every query). The app paints them through
 * theme.tsx; the editor saves and deletes them here.
 */

const PALETTES_KEY = ["palettes"] as const;

export const customPalettesQuery = queryOptions({
  queryKey: PALETTES_KEY,
  queryFn: async ({ signal }): Promise<CustomPalette[]> => {
    const response = await api.palettes.$get(undefined, { init: { signal } });
    if (!response.ok) throw new Error("unavailable");
    return palettesResponseSchema.parse(await response.json()).palettes;
  },
  staleTime: Number.POSITIVE_INFINITY,
});

const withSaved = (list: CustomPalette[] | undefined, saved: CustomPalette) =>
  [...(list ?? []).filter((palette) => palette.slot !== saved.slot), saved].sort(
    (a, b) => a.slot - b.slot,
  );

/** A palette's input fields as core's schema writes them: trimmed, keys in the schema's order. */
const inputFields = z.object(customPaletteInputSchema.shape);

/** The same palette, field for field, as an input sent to save it. */
function sameAs(saved: CustomPalette, input: CustomPaletteInput): boolean {
  const a = inputFields.safeParse(saved);
  const b = inputFields.safeParse(input);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}

/** The saved palettes as the server has them now, refreshing the list. */
const freshList = () => queryClient.fetchQuery({ ...customPalettesQuery, staleTime: 0 });

type SaveOutcome =
  | { ok: true; palette: CustomPalette }
  | { ok: false; reason: string; slotTaken?: { free: CustomSlot | undefined } };

/**
 * Saves a palette: a new one (`updatedAt` null) into its empty slot, a saved
 * one over the save it names. Why it was not saved comes in words after
 * "Not saved: ". A slot another tab filled meanwhile is refused with
 * `slotTaken` and the slot still free, if any, unless it holds this very palette (a save whose answer was
 * lost); a palette another tab changed or deleted is refused, and the list
 * reloads to show it.
 */
export async function saveCustomPalette(
  slot: CustomSlot,
  input: CustomPaletteInput,
  updatedAt: number | null,
): Promise<SaveOutcome> {
  try {
    const param = { slot: String(slot) as "1" | "2" | "3" };
    const init = { init: { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) } };
    const response =
      updatedAt === null
        ? await api.palettes[":slot"].$post({ param, json: input }, init)
        : await api.palettes[":slot"].$put({ param, json: { ...input, updatedAt } }, init);
    if (response.status === 409 && updatedAt === null) {
      const list = await freshList();
      const there = list.find((palette) => palette.slot === slot);
      if (there !== undefined && sameAs(there, input)) return { ok: true, palette: there };
      const free = CUSTOM_SLOTS.find((other) => !list.some((palette) => palette.slot === other));
      return {
        ok: false,
        reason: "another tab saved a palette in this slot first",
        slotTaken: { free },
      };
    }
    if (response.status === 409 || response.status === 404) {
      void freshList();
      return {
        ok: false,
        reason:
          response.status === 409 ? "it changed in another tab" : "it was deleted in another tab",
      };
    }
    if (!response.ok) {
      return { ok: false, reason: failureWords(failureOf(response.status)) };
    }
    const { palette } = paletteResponseSchema.parse(await response.json());
    queryClient.setQueryData(PALETTES_KEY, (list: CustomPalette[] | undefined) =>
      withSaved(list, palette),
    );
    return { ok: true, palette };
  } catch {
    return { ok: false, reason: notReached() };
  }
}

/**
 * Deletes the palette saved at `updatedAt`; or why it was not deleted. One
 * already gone counts as deleted; one another tab changed since is kept.
 */
export async function deleteCustomPalette(
  slot: CustomSlot,
  updatedAt: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await api.palettes[":slot"].$delete(
      { param: { slot: String(slot) as "1" | "2" | "3" }, query: { updatedAt: String(updatedAt) } },
      unsafeOptions(),
    );
    if (response.status === 409) {
      void freshList();
      return { ok: false, reason: "it changed in another tab, so it was kept" };
    }
    if (!response.ok && response.status !== 404) return { ok: false, reason: notReached() };
    queryClient.setQueryData(PALETTES_KEY, (list: CustomPalette[] | undefined) =>
      (list ?? []).filter((palette) => palette.slot !== slot),
    );
    return { ok: true };
  } catch {
    return { ok: false, reason: notReached() };
  }
}
