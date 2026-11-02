import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { type FileHandle, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A user's data at rest: the serialized SQLite image, or one portrait's PNG,
 * encrypted with AES-256-GCM under a key derived from the master key for that
 * user. The one module allowed to write files (scripts/persistence-audit.ts),
 * and it writes ciphertext only.
 *
 * Layout: magic "EPHEMERA" (8 bytes), format version (1), HKDF salt (32),
 * GCM nonce (12), ciphertext, GCM tag (16). Salt and nonce are fresh per
 * write; the header, the username and, for a portrait, its context are
 * authenticated as AAD, so a file copied into another user's folder, renamed
 * to another portrait, presented as the other kind, or altered, fails to open.
 */
export const ENCRYPTED_FILE = "ephemera.sqlite.enc";
/** The data directory's folder of user folders: `<dataDir>/users/<username>/ENCRYPTED_FILE`. */
export const USERS_DIR = "users";
/** A user's portrait files: `<dataDir>/users/<username>/PORTRAITS_DIR/<id>PORTRAIT_FILE_SUFFIX`. */
export const PORTRAITS_DIR = "portraits";
export const PORTRAIT_FILE_SUFFIX = ".enc";

const PORTRAIT_FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.enc$/;

/** The suffix of `writeEncryptedFile`'s temp files, which a crash may leave behind. */
const TEMP_FILE_SUFFIX = ".tmp";
export const isTempFile = (name: string): boolean => name.endsWith(TEMP_FILE_SUFFIX);

/** The file name of the portrait file with this id. */
export const portraitFileName = (id: string): string => `${id}${PORTRAIT_FILE_SUFFIX}`;

/** The id a portrait file name holds: a lowercase UUID followed by the suffix, else undefined. */
export const parsePortraitFileName = (name: string): string | undefined =>
  PORTRAIT_FILE_NAME.exec(name)?.[1];

/** The AAD context that binds a portrait file to its id. */
export const portraitContext = (id: string): string => `portrait:${id}`;

const MAGIC = Buffer.from("EPHEMERA", "ascii");
const VERSION = 0x01;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
const KEY_INFO = "ephemera-user-db-v1:";

/** What made a file unreadable, as a fixed word: never a message, name or key. */
type EncryptedFileFailure = "format" | "auth" | "corrupt";

export class EncryptedFileError extends Error {
  override name = "EncryptedFileError";
  readonly reason: EncryptedFileFailure;
  constructor(reason: EncryptedFileFailure) {
    super(`The encrypted file cannot be opened (${reason})`);
    this.reason = reason;
  }
}

/**
 * The master key (32 bytes), the user the file belongs to and, for a portrait
 * file, its context (`portraitContext`); none for the database file.
 */
export interface EncryptionScope {
  key: Buffer;
  username: string;
  context?: string;
}

function userKey(scope: EncryptionScope, salt: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync("sha256", scope.key, salt, Buffer.from(KEY_INFO + scope.username, "utf8"), 32),
  );
}

/** `header ‖ username`, then `0x00 ‖ context` when there is one; a username holds no 0x00. */
const additionalData = (header: Uint8Array, scope: EncryptionScope) =>
  Buffer.concat(
    scope.context === undefined
      ? [header, Buffer.from(scope.username, "utf8")]
      : [
          header,
          Buffer.from(scope.username, "utf8"),
          Buffer.of(0),
          Buffer.from(scope.context, "utf8"),
        ],
  );

export function encryptSnapshot(plain: Uint8Array, scope: EncryptionScope): Uint8Array {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.of(VERSION), salt, nonce]);
  const cipher = createCipheriv("aes-256-gcm", userKey(scope, salt), nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(header, scope));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

export function decryptSnapshot(bytes: Uint8Array, scope: EncryptionScope): Uint8Array {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.length < HEADER_BYTES + TAG_BYTES ||
    !data.subarray(0, MAGIC.length).equals(MAGIC) ||
    data[MAGIC.length] !== VERSION
  ) {
    throw new EncryptedFileError("format");
  }
  const header = data.subarray(0, HEADER_BYTES);
  const salt = data.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const nonce = data.subarray(MAGIC.length + 1 + SALT_BYTES, HEADER_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", userKey(scope, salt), nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(header, scope));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(data.subarray(HEADER_BYTES, data.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new EncryptedFileError("auth");
  }
}

/**
 * What a filesystem answers when it cannot sync a directory (some bind mounts
 * and network filesystems). SQLite's unix VFS ignores a directory fsync that
 * fails, so these count as best effort; a file's fsync failing stays fatal.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);

const directorySyncUnsupported = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  DIRECTORY_SYNC_UNSUPPORTED.has(error.code);

/**
 * Makes a directory's entries (a created, renamed or removed file) durable,
 * where the filesystem can sync a directory at all.
 */
export async function syncDirectory(path: string): Promise<void> {
  // Windows cannot open a directory to sync it; NTFS journals the rename itself.
  if (process.platform === "win32") return;
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (directorySyncUnsupported(error)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * What Windows answers while another program (an antivirus scan, the search
 * indexer) briefly holds the target open; the rename is retried for a while.
 */
const RENAME_BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;

async function replace(temp: string, path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      const busy =
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        RENAME_BUSY.has(error.code);
      if (!busy || attempt === RENAME_ATTEMPTS) throw error;
      await Bun.sleep(50 * attempt);
    }
  }
}

/**
 * Replaces `path` with `bytes` atomically: a 0600 temp file beside it,
 * written and synced, renamed over the target, then the folder synced. On
 * failure the temp file is removed and the target is left as it was.
 */
export async function writeEncryptedFile(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}${TEMP_FILE_SUFFIX}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replace(temp, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
  await syncDirectory(dirname(path));
}
