import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./db.ts";
import type { PortraitFiles } from "./portrait-files.ts";
import { portraits } from "./schema.ts";
import { type Portrait, type PortraitStore, portraitSchema } from "./store.ts";

/** Which owner column a portrait row hangs from. */
export type PortraitOwner = "characterId" | "personaId";

/** A version that only grows: the time, or one past the previous version. */
const nextVersion = (previous: number | undefined) => Math.max(Date.now(), (previous ?? 0) + 1);

/** A portrait that passed `portraitSchema`, now or when it was first written. */
type Checked = Omit<Portrait, "png" | "thumb"> & { png: Uint8Array; thumb: Uint8Array };

/** The file ids the database's portrait rows name. */
export function referencedFiles(client: Database): Set<string> {
  const rows = client.query<{ file: string }, []>("SELECT file FROM portraits").all();
  return new Set(rows.map((row) => row.file));
}

/**
 * Portrait rows for one kind of owner: the one owner of portrait storage for
 * characters and personas alike. Every write parses the portrait schema, so
 * only what the image pipeline produced is stored. `owners` is the owning
 * table, whose `updatedAt` moves with its portrait. The PNG goes to `files`;
 * the row keeps its file id, the thumb and the dimensions. A replaced or
 * removed portrait's file is not touched here: the flush collects every file
 * the written image no longer names.
 */
export function createPortraitRows(
  db: Db,
  owner: PortraitOwner,
  owners: SQLiteTable & { id: SQLiteColumn; updatedAt: SQLiteColumn },
  files: PortraitFiles,
) {
  const column = portraits[owner];

  const version = (id: string) =>
    db.select({ version: portraits.version }).from(portraits).where(eq(column, id)).get()?.version;

  /** Inserts or replaces a parsed portrait; call inside a transaction that checked the owner exists. */
  const put = (id: string, portrait: Checked, next: number) => {
    const file = files.put(portrait.png);
    const image = {
      thumb: Buffer.from(portrait.thumb),
      width: portrait.width,
      height: portrait.height,
      version: next,
      file,
    };
    db.insert(portraits)
      .values({ [owner]: id, ...image })
      .onConflictDoUpdate({ target: column, set: image })
      .run();
  };

  const exists = (id: string) =>
    db.select({ id: owners.id }).from(owners).where(eq(owners.id, id)).get() !== undefined;

  const touch = (id: string) =>
    db.update(owners).set({ updatedAt: Date.now() }).where(eq(owners.id, id)).run();

  const store: PortraitStore = {
    setPortrait(id, input) {
      const portrait = portraitSchema.parse(input);
      return db.transaction(() => {
        if (!exists(id)) return undefined;
        const next = nextVersion(version(id));
        put(id, portrait, next);
        touch(id);
        return next;
      });
    },

    removePortrait(id) {
      return db.transaction(() => {
        const removed =
          db.delete(portraits).where(eq(column, id)).returning({ id: portraits.id }).all().length >
          0;
        if (removed) touch(id);
        return removed;
      });
    },

    portraitVersion: version,

    async portrait(id, size) {
      const row = db
        .select({ file: portraits.file, thumb: portraits.thumb, version: portraits.version })
        .from(portraits)
        .where(eq(column, id))
        .get();
      if (row === undefined) return undefined;
      if (size === "thumb") return { bytes: row.thumb, version: row.version };
      const bytes = await files.load(row.file);
      return bytes === undefined ? undefined : { bytes, version: row.version };
    },
  };

  return {
    store,
    /** Whether the owner exists, without reading its row. */
    exists,
    /** Stores a new owner's first portrait; inside the owner's create transaction. */
    insertFirst: (id: string, portrait: Portrait) => put(id, portrait, nextVersion(undefined)),
    /**
     * Copies one owner's portrait into a new file for another (duplicate);
     * inside its transaction. The bytes passed the schema when first written
     * and come from an authenticated file, so they are not parsed again. A
     * source whose file is missing yields a copy without a portrait.
     */
    copy(from: string, to: string) {
      const image = db
        .select({
          file: portraits.file,
          thumb: portraits.thumb,
          width: portraits.width,
          height: portraits.height,
        })
        .from(portraits)
        .where(eq(column, from))
        .get();
      if (image === undefined) return;
      const png = files.read(image.file);
      if (png === undefined) return;
      const { thumb, width, height } = image;
      put(to, { png, thumb, width, height }, nextVersion(undefined));
    },
  };
}
