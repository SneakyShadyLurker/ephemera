import { isDeepStrictEqual } from "node:util";
import {
  copyName,
  type EmbeddedLorebook,
  LOREBOOK_LINKS,
  type Lorebook,
  type LorebookFields,
  type LorebookLinks,
  type LorebookSummary,
  lorebookFieldsSchema,
  summarizeLorebook,
} from "@ephemera/core";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { revised } from "./revised.ts";
import { characterLorebooks, characters, lorebooks } from "./schema.ts";
import type {
  LinkedLorebook,
  LinkResult,
  LorebookStore,
  Patch,
  StoredLorebook,
  Updated,
} from "./store.ts";

const lorebookPatchSchema = lorebookFieldsSchema.partial();

/**
 * A book's fields as stored: parsed by the core schema, the book's own name
 * mirroring the row's (trimmed) name.
 */
function storedFields(name: string, book: Lorebook): LorebookFields {
  const trimmed = lorebookFieldsSchema.shape.name.parse(name);
  return lorebookFieldsSchema.parse({ name: trimmed, book: { ...book, name: trimmed } });
}

/** A book's columns: its fields and the counts the list reads (`summarizeLorebook`). */
const columnsOf = (fields: LorebookFields) => ({
  ...fields,
  counts: summarizeLorebook(fields.book),
});

/**
 * The library lorebook repository and the links between books and
 * characters. Every write parses the lorebook schemas first, as the other
 * stores do (PRINCIPLES.md 1); there is no generic write.
 */
export function createLorebookStore(db: Db): LorebookStore {
  const now = () => Date.now();
  const byName = [sql`${lorebooks.name} COLLATE NOCASE`, asc(lorebooks.id)];

  const stored = {
    id: lorebooks.id,
    name: lorebooks.name,
    book: lorebooks.book,
    revision: lorebooks.revision,
    createdAt: lorebooks.createdAt,
    updatedAt: lorebooks.updatedAt,
  };

  const get = (id: string): StoredLorebook | undefined =>
    db.select(stored).from(lorebooks).where(eq(lorebooks.id, id)).get();

  // Counts follow core's rule as it is now: a row written before them, or
  // under an earlier rule, is brought up to date as the database opens.
  for (const row of db
    .select({ id: lorebooks.id, book: lorebooks.book, counts: lorebooks.counts })
    .from(lorebooks)
    .all()) {
    const counts = summarizeLorebook(row.book);
    if (!isDeepStrictEqual(counts, row.counts)) {
      db.update(lorebooks).set({ counts }).where(eq(lorebooks.id, row.id)).run();
    }
  }

  const exists = (table: typeof lorebooks | typeof characters, id: string) =>
    db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !== undefined;

  const linked = (lorebookId: string, characterId: string) =>
    and(
      eq(characterLorebooks.lorebookId, lorebookId),
      eq(characterLorebooks.characterId, characterId),
    );

  return {
    get,

    list(): LorebookSummary[] {
      return db
        .select({
          id: lorebooks.id,
          name: lorebooks.name,
          counts: lorebooks.counts,
          updatedAt: lorebooks.updatedAt,
        })
        .from(lorebooks)
        .orderBy(...byName)
        .all()
        .map(({ counts, ...row }) => ({ ...row, ...counts }));
    },

    embedded(): EmbeddedLorebook[] {
      // Read inside SQLite: only the count leaves the card, not the card itself.
      return db
        .select({
          characterId: characters.id,
          name: characters.name,
          entries: sql<number>`json_array_length(${characters.card}, '$.lorebook.entries')`,
        })
        .from(characters)
        .where(sql`json_type(${characters.card}, '$.lorebook') = 'object'`)
        .orderBy(sql`${characters.name} COLLATE NOCASE`, asc(characters.id))
        .all();
    },

    links(): LorebookLinks {
      const map = new Map<string, string[]>();
      const rows = db
        .select({
          characterId: characterLorebooks.characterId,
          lorebookId: characterLorebooks.lorebookId,
        })
        .from(characterLorebooks)
        .orderBy(asc(characterLorebooks.characterId), asc(characterLorebooks.position))
        .all();
      for (const { characterId, lorebookId } of rows) {
        map.set(characterId, [...(map.get(characterId) ?? []), lorebookId]);
      }
      return [...map].map(([characterId, lorebookIds]) => ({ characterId, lorebookIds }));
    },

    create(input: LorebookFields, requestedId: string): string {
      const parsed = lorebookFieldsSchema.parse(input);
      const fields = storedFields(parsed.name, parsed.book);
      const id = z.uuid().parse(requestedId);
      const time = now();
      // A repeated create (a retry after a lost response) finds its own row and writes nothing.
      db.insert(lorebooks)
        .values({ id, ...columnsOf(fields), createdAt: time, updatedAt: time })
        .onConflictDoNothing({ target: lorebooks.id })
        .run();
      return id;
    },

    update(id: string, input: Patch<LorebookFields>, expected: number): Updated<StoredLorebook> {
      const patch = lorebookPatchSchema.parse(input);
      return db.transaction(() =>
        revised(get(id), expected, {
          apply: (row) => storedFields(patch.name ?? row.name, patch.book ?? row.book),
          compare: ({ name, book }) => ({ name, book }),
          write: (fields, revision) =>
            db
              .update(lorebooks)
              .set({ ...columnsOf(fields), revision, updatedAt: now() })
              .where(eq(lorebooks.id, id))
              .returning(stored)
              .get(),
        }),
      );
    },

    duplicate(id: string): string | undefined {
      return db.transaction(() => {
        const source = get(id);
        if (source === undefined) return undefined;
        const fields = storedFields(copyName(source.name), source.book);
        const copy = crypto.randomUUID();
        const time = now();
        db.insert(lorebooks)
          .values({ id: copy, ...columnsOf(fields), createdAt: time, updatedAt: time })
          .run();
        return copy;
      });
    },

    remove(id: string): boolean {
      return (
        db.delete(lorebooks).where(eq(lorebooks.id, id)).returning({ id: lorebooks.id }).all()
          .length > 0
      );
    },

    booksOf(characterId: string): LinkedLorebook[] {
      return db
        .select({ id: lorebooks.id, name: lorebooks.name, book: lorebooks.book })
        .from(characterLorebooks)
        .innerJoin(lorebooks, eq(lorebooks.id, characterLorebooks.lorebookId))
        .where(eq(characterLorebooks.characterId, characterId))
        .orderBy(asc(characterLorebooks.position))
        .all();
    },

    link(lorebookId: string, characterId: string): LinkResult {
      return db.transaction(() => {
        if (!exists(lorebooks, lorebookId) || !exists(characters, characterId)) return "missing";
        const present = db
          .select({ position: characterLorebooks.position })
          .from(characterLorebooks)
          .where(linked(lorebookId, characterId))
          .get();
        if (present !== undefined) return "linked";
        const { count, last } = db
          .select({ count: sql<number>`count(*)`, last: max(characterLorebooks.position) })
          .from(characterLorebooks)
          .where(eq(characterLorebooks.characterId, characterId))
          .get() ?? { count: 0, last: null };
        if (count >= LOREBOOK_LINKS) return "full";
        db.insert(characterLorebooks)
          .values({ characterId, lorebookId, position: last === null ? 0 : last + 1 })
          .run();
        return "linked";
      });
    },

    unlink(lorebookId: string, characterId: string): boolean {
      return db.transaction(() => {
        if (!exists(lorebooks, lorebookId) || !exists(characters, characterId)) return false;
        db.delete(characterLorebooks).where(linked(lorebookId, characterId)).run();
        return true;
      });
    },
  };
}
