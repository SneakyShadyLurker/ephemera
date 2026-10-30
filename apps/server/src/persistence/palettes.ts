import {
  builtInBase,
  type CustomPalette,
  type CustomPaletteInput,
  type CustomSlot,
  customPaletteId,
  customPaletteInputSchema,
  customSlotSchema,
} from "@ephemera/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { customPalettes, settings } from "./schema.ts";
import type { CustomPaletteStore } from "./store.ts";

/**
 * The player's palettes, by slot. Every write parses the core schema first,
 * as the other stores do (PRINCIPLES.md 1). Creating never replaces,
 * replacing never creates, and replacing or deleting names the save it acts
 * on (`updatedAt`), so a tab whose list is behind another's cannot overwrite
 * or delete a palette it has not seen. Deleting the palette the settings
 * choose returns them to its built-in base, or to the default palette, in
 * the same transaction.
 */
export function createCustomPaletteStore(db: Db): CustomPaletteStore {
  const get = (slot: CustomSlot): CustomPalette | undefined =>
    db.select().from(customPalettes).where(eq(customPalettes.slot, slot)).get();

  return {
    list(): CustomPalette[] {
      return db.select().from(customPalettes).orderBy(asc(customPalettes.slot)).all();
    },

    create(requestedSlot: CustomSlot, input: CustomPaletteInput): CustomPalette | undefined {
      const slot = customSlotSchema.parse(requestedSlot);
      const fields = customPaletteInputSchema.parse(input);
      return db.transaction(() => {
        if (get(slot) !== undefined) return undefined;
        db.insert(customPalettes)
          .values({ slot, ...fields, updatedAt: Date.now() })
          .run();
        return get(slot);
      });
    },

    replace(
      requestedSlot: CustomSlot,
      input: CustomPaletteInput,
      updatedAt: number,
    ): CustomPalette | "missing" | "changed" {
      const slot = customSlotSchema.parse(requestedSlot);
      const fields = customPaletteInputSchema.parse(input);
      return db.transaction(() => {
        const current = get(slot);
        if (current === undefined) return "missing";
        if (current.updatedAt !== updatedAt) return "changed";
        db.update(customPalettes)
          .set({ ...fields, updatedAt: Math.max(Date.now(), updatedAt + 1) })
          .where(eq(customPalettes.slot, slot))
          .run();
        return get(slot) ?? "missing";
      });
    },

    delete(requestedSlot: CustomSlot, updatedAt: number): "deleted" | "missing" | "changed" {
      const slot = customSlotSchema.parse(requestedSlot);
      return db.transaction(() => {
        const removed = get(slot);
        if (removed === undefined) return "missing";
        if (removed.updatedAt !== updatedAt) return "changed";
        db.delete(customPalettes).where(eq(customPalettes.slot, slot)).run();
        const palette = builtInBase(removed.base);
        db.update(settings)
          .set({ palette, updatedAt: Date.now() })
          .where(and(eq(settings.id, 1), eq(settings.palette, customPaletteId(slot))))
          .run();
        return "deleted";
      });
    },
  };
}
