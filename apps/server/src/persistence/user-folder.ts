import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Username } from "../identity.ts";
import { DataDirectoryError, ownerOnly } from "./db.ts";
import { isTempFile, PORTRAITS_DIR, USERS_DIR } from "./encrypted-file.ts";

/**
 * The user's folder, `<dataDir>/users/<username>/`, created owner-only (0700)
 * with `users/` itself and the folder's `portraits/` on first use and asserted
 * a direct child of `users/`. Each directory whose entries gained a folder is
 * pushed onto `created`, so the caller syncs it (`syncDirectory`) before
 * relying on the new folder. A write that crashed before its rename leaves a
 * temp file (ciphertext only); it is removed here, in both folders.
 */
export function userFolder(dataDir: string, username: Username, created: string[]): string {
  const usersDir = join(dataDir, USERS_DIR);
  const dir = join(usersDir, username);
  if (dirname(dir) !== usersDir || basename(dir) !== username) {
    throw new DataDirectoryError("A user's folder must be a direct child of the users directory");
  }
  if (mkdirSync(usersDir, { recursive: true, mode: 0o700 }) !== undefined) created.push(dataDir);
  ownerOnly(usersDir, 0o700);
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) created.push(usersDir);
  ownerOnly(dir, 0o700);
  const portraits = join(dir, PORTRAITS_DIR);
  if (mkdirSync(portraits, { recursive: true, mode: 0o700 }) !== undefined) created.push(dir);
  ownerOnly(portraits, 0o700);
  for (const folder of [dir, portraits]) {
    for (const name of readdirSync(folder)) {
      if (isTempFile(name)) unlinkSync(join(folder, name));
    }
  }
  return dir;
}
