import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { createGate } from "../gate.ts";
import { toMediumImage } from "../images.ts";
import type { Db } from "./db.ts";
import type { PortraitFiles } from "./portrait-files.ts";
import { portraits } from "./schema.ts";
import { type Portrait, type PortraitStore, portraitSchema } from "./store.ts";

/** Which owner column a portrait row hangs from. */
export type PortraitOwner = "characterId" | "personaId";

/** A version that only grows: the time, or one past the previous version. */
const nextVersion = (previous: number | undefined) => Math.max(Date.now(), (previous ?? 0) + 1);

/**
 * A portrait that passed `portraitSchema`, now or when it was first written;
 * only a copy of a portrait stored without a medium WebP lacks one.
 */
type Checked = Omit<Portrait, "png" | "medium" | "thumb"> & {
  png: Uint8Array;
  medium?: Uint8Array;
  thumb: Uint8Array;
};

/** The file ids the database's portrait rows name: every PNG and every medium WebP. */
export function referencedFiles(client: Database): Set<string> {
  const rows = client
    .query<{ file: string; medium_file: string | null }, []>(
      "SELECT file, medium_file FROM portraits",
    )
    .all();
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.file);
    if (row.medium_file !== null) ids.add(row.medium_file);
  }
  return ids;
}

/**
 * Medium WebPs derived from a PNG at once, across all users: each decodes a
 * PNG of up to a few megabytes, and a first gallery visit asks for many.
 */
const derivations = createGate(2);
/** A derivation's place in line is never given up. */
const stay = new AbortController().signal;

/**
 * Portrait rows for one kind of owner: the one owner of portrait storage for
 * characters and personas alike. Every write parses the portrait schema, so
 * only what the image pipeline produced is stored. `owners` is the owning
 * table, whose `updatedAt` moves with its portrait. The PNG and the medium
 * WebP go to `files`; the row keeps their file ids, the thumb and the
 * dimensions. A replaced or removed portrait's files are not touched here:
 * the flush collects every file the written image no longer names.
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
    const mediumFile = portrait.medium === undefined ? null : files.put(portrait.medium);
    const image = {
      thumb: Buffer.from(portrait.thumb),
      width: portrait.width,
      height: portrait.height,
      version: next,
      file,
      mediumFile,
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

  /** Derivations under way, by the PNG's file id: concurrent requests share one. */
  const deriving = new Map<string, Promise<Uint8Array | undefined>>();

  /**
   * Derives the medium WebP from the PNG `file` and keeps it as the row's
   * medium file, unless the portrait was replaced in the meantime. Neither
   * the owner's `updatedAt` nor the version moves. Undefined when the PNG is
   * missing or cannot be decoded.
   */
  const deriveMedium = (id: string, file: string) => {
    const running = deriving.get(file);
    if (running !== undefined) return running;
    const derived = (async () => {
      const release = await derivations.enter(stay);
      try {
        const png = await files.load(file);
        if (png === undefined) return undefined;
        let medium: Uint8Array;
        try {
          medium = await toMediumImage(png);
        } catch {
          return undefined;
        }
        // File ids are never reused; an unmatched staged file is dropped by the next flush.
        db.update(portraits)
          .set({ mediumFile: files.put(medium) })
          .where(and(eq(column, id), eq(portraits.file, file)))
          .run();
        return medium;
      } finally {
        release?.();
        deriving.delete(file);
      }
    })();
    deriving.set(file, derived);
    return derived;
  };

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
        .select({
          file: portraits.file,
          mediumFile: portraits.mediumFile,
          thumb: portraits.thumb,
          version: portraits.version,
        })
        .from(portraits)
        .where(eq(column, id))
        .get();
      if (row === undefined) return undefined;
      const { version } = row;
      if (size === "thumb") return { bytes: row.thumb, version };
      if (size === "full") {
        const bytes = await files.load(row.file);
        return bytes === undefined ? undefined : { bytes, version };
      }
      if (row.mediumFile !== null) {
        const bytes = await files.load(row.mediumFile);
        if (bytes !== undefined) return { bytes, version };
      }
      // Without a readable medium file it is derived once; without a readable PNG, the thumb stands in.
      return { bytes: (await deriveMedium(id, row.file)) ?? row.thumb, version };
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
     * source whose PNG is missing yields a copy without a portrait; one whose
     * medium file is missing or unreadable, a copy without a medium file.
     */
    copy(from: string, to: string) {
      const image = db
        .select({
          file: portraits.file,
          mediumFile: portraits.mediumFile,
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
      const medium = image.mediumFile === null ? undefined : files.read(image.mediumFile);
      const { thumb, width, height } = image;
      put(
        to,
        { png, ...(medium !== undefined && { medium }), thumb, width, height },
        nextVersion(undefined),
      );
    },
  };
}
