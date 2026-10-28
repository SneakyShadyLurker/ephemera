import {
  applySheetPatch,
  type CharacterCard,
  type CharacterPatch,
  type CharacterSummary,
  characterCardSchema,
  characterPatchSchema,
  copyName,
} from "@ephemera/core";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { PortraitFiles } from "./portrait-files.ts";
import { createPortraitRows } from "./portraits.ts";
import { revised } from "./revised.ts";
import { characterLorebooks, characters, portraits } from "./schema.ts";
import {
  type CharacterStore,
  type Portrait,
  portraitSchema,
  type StoredCharacter,
  type Updated,
} from "./store.ts";

const summaryColumns = (card: CharacterCard) => ({
  name: card.name,
  nickname: card.nickname,
  creator: card.creator,
  tags: card.tags,
});

/**
 * The character repository. Every write parses its input with the character
 * schemas first, so a value of any other shape (a chat turn, a message list, a
 * generation request) is rejected before it can reach the database
 * (PRINCIPLES.md 1). There is deliberately no generic write.
 */
export function createCharacterStore(db: Db, files: PortraitFiles): CharacterStore {
  const now = () => Date.now();
  const rows = createPortraitRows(db, "characterId", characters, files);

  return {
    ...rows.store,
    exists: rows.exists,

    list(): CharacterSummary[] {
      return db
        .select({
          id: characters.id,
          name: characters.name,
          nickname: characters.nickname,
          creator: characters.creator,
          tags: characters.tags,
          portrait: portraits.version,
          updatedAt: characters.updatedAt,
        })
        .from(characters)
        .leftJoin(portraits, eq(portraits.characterId, characters.id))
        .orderBy(desc(characters.updatedAt))
        .all();
    },

    get(id: string): StoredCharacter | undefined {
      return db
        .select({
          id: characters.id,
          card: characters.card,
          portrait: portraits.version,
          revision: characters.revision,
          createdAt: characters.createdAt,
          updatedAt: characters.updatedAt,
        })
        .from(characters)
        .leftJoin(portraits, eq(portraits.characterId, characters.id))
        .where(eq(characters.id, id))
        .get();
    },

    create(input: CharacterCard, portraitInput?: Portrait, requestedId?: string): string {
      const card = characterCardSchema.parse(input);
      const portrait =
        portraitInput === undefined ? undefined : portraitSchema.parse(portraitInput);
      const id = requestedId === undefined ? crypto.randomUUID() : z.uuid().parse(requestedId);
      const time = now();
      db.transaction(() => {
        // A repeated create (a retry after a lost response) finds its own row and writes nothing.
        const inserted = db
          .insert(characters)
          .values({ id, ...summaryColumns(card), card, createdAt: time, updatedAt: time })
          .onConflictDoNothing({ target: characters.id })
          .returning({ id: characters.id })
          .all();
        if (portrait && inserted.length > 0) rows.insertFirst(id, portrait);
      });
      return id;
    },

    update(
      id: string,
      input: CharacterPatch,
      expected: number,
    ): Updated<{ card: CharacterCard; revision: number }> {
      const patch = characterPatchSchema.parse(input);
      return db.transaction(() =>
        revised(
          db
            .select({ card: characters.card, revision: characters.revision })
            .from(characters)
            .where(eq(characters.id, id))
            .get(),
          expected,
          {
            apply: (row) => characterCardSchema.parse(applySheetPatch(row.card, patch)),
            compare: (row) => row.card,
            write: (edited, revision) => {
              const card = characterCardSchema.parse(edited);
              db.update(characters)
                .set({ ...summaryColumns(card), card, revision, updatedAt: now() })
                .where(eq(characters.id, id))
                .run();
              return { card, revision };
            },
          },
        ),
      );
    },

    duplicate(id: string): string | undefined {
      return db.transaction(() => {
        const source = db.select().from(characters).where(eq(characters.id, id)).get();
        if (source === undefined) return undefined;
        const card = characterCardSchema.parse({
          ...source.card,
          name: copyName(source.card.name),
        });
        const copy = crypto.randomUUID();
        const time = now();
        db.insert(characters)
          .values({ id: copy, ...summaryColumns(card), card, createdAt: time, updatedAt: time })
          .run();
        rows.copy(id, copy);
        // The copy carries the same library lorebooks, in the same order.
        const links = db
          .select({
            lorebookId: characterLorebooks.lorebookId,
            position: characterLorebooks.position,
          })
          .from(characterLorebooks)
          .where(eq(characterLorebooks.characterId, id))
          .all();
        if (links.length > 0) {
          db.insert(characterLorebooks)
            .values(links.map((link) => ({ ...link, characterId: copy })))
            .run();
        }
        return copy;
      });
    },

    /** Removes the character; its portrait, persona binding and lorebook links go with it (foreign key cascade). */
    remove(id: string): boolean {
      return (
        db.delete(characters).where(eq(characters.id, id)).returning({ id: characters.id }).all()
          .length > 0
      );
    },
  };
}
