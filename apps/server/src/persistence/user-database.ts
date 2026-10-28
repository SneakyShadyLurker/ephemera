import { Database } from "bun:sqlite";
import { configureTemporaryStorage, type Db, MIGRATIONS, migrateDatabase } from "./db.ts";
import { EncryptedFileError } from "./encrypted-file.ts";
import { upgradeNativeData } from "./native-upgrade.ts";

interface UserDatabase {
  client: Database;
  db: Db;
  /** Change counter for rows and the native data version, including startup upgrades. */
  changes: () => number;
  close: () => void;
}

/**
 * Opens a user's database in memory, from the decrypted snapshot of their
 * file or empty for a new user, and applies pending migrations. It never
 * touches the disk: no journal, no WAL, no temp file. A snapshot SQLite cannot
 * read is `EncryptedFileError("corrupt")`.
 */
export function openUserDatabase(
  snapshot: Uint8Array | undefined,
  migrationsFolder = MIGRATIONS,
): UserDatabase {
  let client: Database;
  if (snapshot === undefined) {
    client = new Database(":memory:", { strict: true });
  } else {
    try {
      client = Database.deserialize(snapshot, { strict: true });
    } catch {
      throw new EncryptedFileError("corrupt");
    }
  }
  try {
    configureTemporaryStorage(client);
    if (snapshot !== undefined) {
      try {
        // Deserializing accepts any bytes; the first read finds out whether they are a database.
        client.query("SELECT count(*) FROM sqlite_master").get();
      } catch {
        throw new EncryptedFileError("corrupt");
      }
    }
    const db = migrateDatabase(client, migrationsFolder);
    const upgraded = upgradeNativeData(client);
    const total = client.query<{ changes: number }, []>("SELECT total_changes() AS changes");
    return {
      client,
      db,
      changes: () => (total.get()?.changes ?? 0) + Number(upgraded),
      close: () => client.close(true),
    };
  } catch (error) {
    client.close(true);
    throw error;
  }
}
