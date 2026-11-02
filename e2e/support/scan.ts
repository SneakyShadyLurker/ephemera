import type { Dirent } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect } from "@playwright/test";
import {
  decryptSnapshot,
  ENCRYPTED_FILE,
  type EncryptionScope,
  PORTRAIT_FILE_SUFFIX,
  PORTRAITS_DIR,
  parsePortraitFileName,
  portraitContext,
  USERS_DIR,
} from "../../apps/server/src/persistence/encrypted-file.ts";
import { E2E_DATA_KEY } from "./env.ts";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface ScanResult {
  /** Files containing the needle. */
  hits: string[];
  /** Paths that could not be read; the hop is unverified while any remain. */
  unreadable: string[];
  scanned: number;
  /** Encrypted user databases and portrait files decrypted and scanned as plaintext (`dataDirContaining`). */
  decrypted: number;
}

/** Text, or bytes such as a fragment of an image. */
export type Needle = string | Buffer;

/** One needle or several, as a list. */
export const needleList = (needle: Needle | readonly Needle[]): readonly Needle[] =>
  typeof needle === "string" || Buffer.isBuffer(needle) ? [needle] : needle;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * The base64 forms of `bytes` inside any longer base64 text: one per offset
 * the bytes can start at within a 3-byte group, each without the characters
 * the neighbouring bytes share.
 */
function base64Forms(bytes: Buffer): string[] {
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    return encoded.slice(Math.ceil((offset * 8) / 6), end);
  });
}

/**
 * The byte patterns a scan for `needle` looks for: the text as UTF-8 and
 * UTF-16LE, and its base64 forms (a candidate portrait travels as base64 in
 * the art stream, and its PNG carries its marker as raw bytes) as both too.
 * A binary needle (a fragment of an image) is looked for as raw bytes and in
 * its base64 forms, as a data URL or a stream would carry it.
 */
function needlePatterns(needle: Needle): Buffer[] {
  const bytes = typeof needle === "string" ? Buffer.from(needle, "utf8") : needle;
  const raw = typeof needle === "string" ? [bytes, Buffer.from(needle, "utf16le")] : [bytes];
  return [
    ...raw,
    ...base64Forms(bytes).flatMap((text) => [
      Buffer.from(text, "utf8"),
      Buffer.from(text, "utf16le"),
    ]),
  ];
}

/** Whether `bytes` hold `needle` in any form `needlePatterns` lists. */
export const holds = (bytes: Buffer, needle: Needle): boolean =>
  needlePatterns(needle).some((pattern) => bytes.includes(pattern));

/**
 * Files under `dir` whose bytes contain `needle`, or any of several, in any
 * form `needlePatterns` lists. Compressed content (e.g. LevelDB blocks) is not decoded, so a scan is
 * evidence alongside the storage API checks, not proof. A missing root or an
 * unreadable file is reported, never counted as clean (PRINCIPLES.md 1).
 */
export async function filesContaining(
  dir: string,
  needle: Needle | readonly Needle[],
  options: { skip?: (path: string) => boolean; modifiedSince?: number } = {},
): Promise<ScanResult> {
  const patterns = needleList(needle).flatMap(needlePatterns);
  const result: ScanResult = { hits: [], unreadable: [], scanned: 0, decrypted: 0 };
  let entries: Dirent[] | undefined;
  for (let attempt = 1; entries === undefined; attempt++) {
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch (error) {
      // A directory removed while listed (a parallel test's artifacts): the root is listed again.
      const removedBelow =
        isMissing(error) &&
        (await stat(dir).then(
          () => true,
          () => false,
        ));
      if (removedBelow && attempt < 5) continue;
      result.unreadable.push(dir);
      return result;
    }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.split("/").some((part) => SKIP_DIRS.has(part)) || options.skip?.(path)) continue;
    try {
      if (
        options.modifiedSince !== undefined &&
        (await stat(path)).mtimeMs < options.modifiedSince
      ) {
        continue;
      }
      const bytes = await readFile(path);
      result.scanned++;
      if (patterns.some((pattern) => bytes.includes(pattern))) result.hits.push(path);
    } catch (error) {
      // A file removed while scanning holds nothing any more.
      if (!isMissing(error)) result.unreadable.push(path);
    }
  }
  return result;
}

/** Marks a hit found in a user database's decrypted plaintext. */
export const PLAINTEXT_HIT = "#plaintext";

/** The master key the e2e servers encrypt under. */
const DATA_KEY = Buffer.from(E2E_DATA_KEY, "hex");

/**
 * The scope a user's encrypted file opens under, from its path: a file in
 * `users/<name>/` is the user's database, one in `users/<name>/portraits/`
 * a portrait file bound to the id its name holds (an unfinished write's
 * `<id>.enc.<uuid>.tmp` holds the same id). A portrait file name without an
 * id has no scope, so it cannot be decrypted.
 */
function scopeOf(path: string, key: Buffer): EncryptionScope {
  const folder = dirname(path);
  if (basename(folder) !== PORTRAITS_DIR || basename(dirname(dirname(folder))) !== USERS_DIR) {
    return { key, username: basename(folder) };
  }
  const name = basename(path);
  const end = name.indexOf(PORTRAIT_FILE_SUFFIX);
  const id =
    end < 0 ? undefined : parsePortraitFileName(name.slice(0, end + PORTRAIT_FILE_SUFFIX.length));
  if (id === undefined) throw new Error("Not a portrait file name");
  return { key, username: basename(dirname(folder)), context: portraitContext(id) };
}

/** A user's encrypted file's plaintext, decrypted under the scope its path names. */
async function plaintext(path: string, key: Buffer): Promise<Buffer> {
  const bytes = await readFile(path);
  return Buffer.from(decryptSnapshot(bytes, scopeOf(path, key)));
}

/**
 * A scanned file's plaintext. A temp file may still be written while a test
 * scans, by another test's user on the same server: it is read again until
 * it decrypts, or is renamed into place (missing), for at most two seconds;
 * one that still does not decrypt then is unreadable.
 */
async function settledPlaintext(path: string, key: Buffer): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await plaintext(path, key);
    } catch (error) {
      if (isMissing(error) || !path.endsWith(".tmp") || attempt === 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * A server's data directory as the S-data hop scans it: every file's raw
 * bytes as `filesContaining` reads them, and every user database
 * (`users/<name>/ephemera.sqlite.enc`) and portrait file
 * (`users/<name>/portraits/<id>.enc`), an unfinished write's temp file
 * included, decrypted and scanned as plaintext, where a hit is
 * `<path>#plaintext`. A file there that cannot be decrypted is unreadable,
 * so the hop fails as unverified rather than clean.
 */
export async function dataDirContaining(
  dataDir: string,
  needle: Needle | readonly Needle[],
  key: Buffer = DATA_KEY,
): Promise<ScanResult> {
  const result = await filesContaining(dataDir, needle);
  const patterns = needleList(needle).flatMap(needlePatterns);
  const scanPlaintext = async (path: string) => {
    try {
      const plain = await settledPlaintext(path, key);
      result.decrypted++;
      if (patterns.some((pattern) => plain.includes(pattern))) {
        result.hits.push(`${path}${PLAINTEXT_HIT}`);
      }
    } catch (error) {
      // A file removed while scanning (a temp file renamed into place) holds nothing any more.
      if (!isMissing(error)) result.unreadable.push(path);
    }
  };
  const usersDir = join(dataDir, USERS_DIR);
  let users: Dirent[];
  try {
    users = await readdir(usersDir, { withFileTypes: true });
  } catch (error) {
    // No user ever made a request: there is nothing to decrypt.
    if (!isMissing(error)) result.unreadable.push(usersDir);
    return result;
  }
  for (const user of users) {
    if (!user.isDirectory()) continue;
    const dir = join(usersDir, user.name);
    let files: Dirent[];
    try {
      files = await readdir(dir, { withFileTypes: true });
    } catch {
      result.unreadable.push(dir);
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith(ENCRYPTED_FILE)) continue;
      await scanPlaintext(join(dir, file.name));
    }
    const portraitsDir = join(dir, PORTRAITS_DIR);
    let portraits: Dirent[];
    try {
      portraits = await readdir(portraitsDir, { withFileTypes: true });
    } catch (error) {
      // A folder the server has not opened since portrait files came has none.
      if (!isMissing(error)) result.unreadable.push(portraitsDir);
      continue;
    }
    for (const file of portraits) {
      if (file.isFile()) await scanPlaintext(join(portraitsDir, file.name));
    }
  }
  return result;
}

/** The bytes a hit names: the file's own, or an encrypted file's plaintext for a `#plaintext` hit. */
export async function hitBytes(hit: string, key: Buffer = DATA_KEY): Promise<Buffer> {
  return hit.endsWith(PLAINTEXT_HIT)
    ? plaintext(hit.slice(0, -PLAINTEXT_HIT.length), key)
    : readFile(hit);
}

/**
 * Where fragments are taken, inside each image's compressed noise: a model's
 * JPEG copy of a noisy portrait (683 x 1024, about 9.5 KB, its noise from
 * about 3 KB on) and a noisy PNG portrait, as the mock ComfyUI paints it or
 * as the server re-encodes it (e2e/support/creator-fixtures.ts).
 */
export const FRAGMENT_OFFSETS = {
  jpeg: [3_584, 5_120, 6_656, 8_192],
  png: [2_048, 16_384, 40_960, 65_536],
} as const;
const FRAGMENT_BYTES = 32;

/**
 * Fragments of an image, each from its compressed noise so only a copy of
 * this image holds one. Positive control: a scan finds every fragment in
 * planted copies of the image, raw and in each extra copy given.
 */
export async function imageFragments(
  bytes: Buffer,
  offsets: readonly number[],
  copies: Record<string, string> = {},
): Promise<Buffer[]> {
  const fragments = offsets.map((offset) => bytes.subarray(offset, offset + FRAGMENT_BYTES));
  for (const fragment of fragments) {
    // Random bytes, not the flat rows' repeated pattern, which every portrait shares.
    expect(fragment.byteLength).toBe(FRAGMENT_BYTES);
    expect(new Set(fragment).size).toBeGreaterThan(FRAGMENT_BYTES / 2);
  }
  const dir = await mkdtemp(join(tmpdir(), "ephemera-image-scan-"));
  try {
    await writeFile(join(dir, "clean.bin"), Buffer.alloc(4096, 7));
    await writeFile(join(dir, "raw.bin"), Buffer.concat([Buffer.alloc(100), bytes]));
    for (const [name, text] of Object.entries(copies)) await writeFile(join(dir, name), text);
    for (const fragment of fragments) {
      const scan = await filesContaining(dir, fragment);
      expect(scan.hits.map((path) => path.slice(dir.length + 1)).sort()).toEqual(
        ["raw.bin", ...Object.keys(copies)].sort(),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return fragments;
}
