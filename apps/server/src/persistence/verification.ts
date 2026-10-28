import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { usernameSchema } from "../identity.ts";
import type { Logger } from "../log.ts";
import { MIGRATIONS } from "./db.ts";
import {
  decryptSnapshot,
  ENCRYPTED_FILE,
  encryptSnapshot,
  isTempFile,
  PORTRAITS_DIR,
  parsePortraitFileName,
  portraitFileName,
  USERS_DIR,
  writeEncryptedFile,
} from "./encrypted-file.ts";
import { referencedFiles } from "./portraits.ts";
import { openUserDatabase } from "./user-database.ts";

/*
 * What runs at startup before the server listens: verifying that every
 * user's file opens under the configured key.
 */

class VerificationError extends Error {
  override name = "VerificationError";
}

function integrityOk(client: Database): boolean {
  const rows = client.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  return rows.length === 1 && rows[0]?.integrity_check === "ok";
}

interface VerificationOptions {
  dataDir: string;
  /** The 32-byte master key. */
  key: Buffer;
  log: Logger;
  migrationsFolder?: string;
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
}

/**
 * Opens every user's encrypted file in memory (decrypt, deserialize, migrate,
 * upgrade, integrity check) so a wrong key or a migration that
 * cannot apply stops the start instead of failing users one by one. Portrait
 * files are checked for presence only: a missing one is counted and warned
 * about, never decrypted and never a failure. A changed database is atomically
 * encrypted and written before startup succeeds. Creates no folder.
 * Resolves to the number of files verified; a file that does not
 * open rejects with its error class.
 */
export async function verifyInstances(options: VerificationOptions): Promise<number> {
  const { dataDir, key, log } = options;
  const usersDir = join(dataDir, USERS_DIR);
  if (!existsSync(usersDir)) return 0;
  let verified = 0;
  let foreign = false;
  let missing = 0;
  for (const entry of await readdir(usersDir, { withFileTypes: true })) {
    const username = usernameSchema.safeParse(entry.name);
    if (!entry.isDirectory() || !username.success) {
      foreign = true;
      continue;
    }
    const file = join(usersDir, entry.name, ENCRYPTED_FILE);
    // A folder whose first flush never happened holds no file yet.
    if (!existsSync(file)) continue;
    const snapshot = decryptSnapshot(await readFile(file), { key, username: username.data });
    const database = openUserDatabase(snapshot, options.migrationsFolder ?? MIGRATIONS);
    const portraitsDir = join(usersDir, entry.name, PORTRAITS_DIR);
    try {
      if (!integrityOk(database.client)) {
        throw new VerificationError("A user's database fails its integrity check");
      }
      for (const id of referencedFiles(database.client)) {
        if (!existsSync(join(portraitsDir, portraitFileName(id)))) missing += 1;
      }
      if (database.changes() > 0) {
        await (options.write ?? writeEncryptedFile)(
          file,
          encryptSnapshot(database.client.serialize(), { key, username: username.data }),
        );
      }
    } finally {
      database.close();
    }
    if (existsSync(portraitsDir)) {
      for (const name of await readdir(portraitsDir)) {
        if (parsePortraitFileName(name) === undefined && !isTempFile(name)) foreign = true;
      }
    }
    verified += 1;
  }
  if (foreign) log.warn({ event: "startup.foreign_entry" });
  if (missing > 0) log.warn({ event: "startup.portrait_missing", count: missing });
  return verified;
}
