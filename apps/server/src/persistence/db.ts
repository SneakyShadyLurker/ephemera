import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

export const MIGRATIONS = join(import.meta.dirname, "../../drizzle");

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export class DataDirectoryError extends Error {
  override name = "DataDirectoryError";
}

class MigrationError extends Error {
  override name = "MigrationError";
}

/** Keeps SQLite's temporary tables and sort results off disk on every connection. */
export function configureTemporaryStorage(client: Database) {
  client.run("PRAGMA temp_store = MEMORY");
}

/**
 * Gives a path exactly the owner-only mode it needs (0700 for a directory),
 * so neither others' access nor missing owner bits remain. A path
 * the server's user does not own cannot be changed: the server refuses to
 * start rather than keep entities where other accounts can read them.
 */
export function ownerOnly(path: string, mode: number) {
  if ((statSync(path).mode & 0o777) === mode) return;
  try {
    chmodSync(path, mode);
  } catch {
    throw new DataDirectoryError(
      "The data directory and database must be owner-only and owned by the server's user",
    );
  }
}

/**
 * Creates the data directory owner-only (0700), or repairs one that existed (a
 * bind mount, an earlier checkout): mkdir's mode applies only to a directory it
 * creates. Run at startup, before anything is read from or written to it.
 */
export function prepareDataDirectory(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  ownerOnly(dataDir, 0o700);
}

/**
 * Applies every pending migration to an open client and returns the Drizzle
 * database over it. Drizzle applies them in one transaction, where SQLite
 * ignores a migration's own `PRAGMA foreign_keys=OFF`: a table rebuild's
 * DROP TABLE would cascade into portraits, bindings and settings. Enforcement
 * stays off while migrating, so a migration never relies on a cascade. Drizzle
 * has committed by the time the result is checked: a migration that left
 * references to missing rows stops the start, and the deploy script's
 * pre-migration snapshot is the way back.
 */
export function migrateDatabase(client: Database, migrationsFolder: string): Db {
  const db = drizzle({ client, schema, casing: "snake_case" });
  client.run("PRAGMA foreign_keys = OFF");
  migrate(db, { migrationsFolder });
  if (client.query("PRAGMA foreign_key_check").all().length > 0) {
    throw new MigrationError("A migration left rows whose references do not exist");
  }
  client.run("PRAGMA foreign_keys = ON");
  return db;
}
