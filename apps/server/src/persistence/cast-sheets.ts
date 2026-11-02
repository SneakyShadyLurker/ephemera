import { type CastSheet, castSheetSchema } from "@ephemera/core";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { castSheets } from "./schema.ts";
import type { CastSheetStore } from "./store.ts";

const sheetWriteSchema = castSheetSchema.pick({ fingerprint: true, entries: true });

/**
 * Characters' cast sheets (spec: character data derived from the card
 * alone, PRINCIPLES.md 1). Every write parses the core schema first, which
 * refuses volatile state; the row goes with its character.
 */
export function createCastSheetStore(db: Db): CastSheetStore {
  const get = (characterId: string): CastSheet | null => {
    const row = db.select().from(castSheets).where(eq(castSheets.characterId, characterId)).get();
    if (row === undefined) return null;
    const { createdAt: _createdAt, ...sheet } = row;
    return sheet;
  };

  return {
    get,

    put(requestedId, input) {
      const characterId = z.uuid().parse(requestedId);
      const { fingerprint, entries } = sheetWriteSchema.parse(input);
      const time = Date.now();
      const row = db
        .insert(castSheets)
        .values({ characterId, fingerprint, entries, createdAt: time, updatedAt: time })
        .onConflictDoUpdate({
          target: castSheets.characterId,
          set: { fingerprint, entries, revision: sql`${castSheets.revision} + 1`, updatedAt: time },
        })
        .returning()
        .get();
      const { createdAt: _createdAt, ...sheet } = row;
      return sheet;
    },
  };
}
