import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usernameSchema } from "../src/identity.ts";
import { createLogger } from "../src/log.ts";
import {
  createMemoryPortraitFiles,
  createPortraitFiles,
  encryptSnapshot,
  PORTRAITS_DIR,
  portraitContext,
  portraitFileName,
  writeEncryptedFile,
} from "../src/persistence/index.ts";
import { userFolder } from "../src/persistence/user-folder.ts";
import { plainPng } from "./image-fixtures.ts";

const key = randomBytes(32);
const alice = usernameSchema.parse("alice");
const modeOf = (path: string) => statSync(path).mode & 0o777;
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

describe("portrait files", () => {
  let root: string;
  let lines: string[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ephemera-portraits-"));
  });
  beforeEach(() => {
    lines = [];
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A fresh user folder's `portraits/`, created as the registry creates it. */
  const portraitsDir = async () => {
    const dataDir = join(root, randomUUID());
    await mkdir(dataDir, { mode: 0o700 });
    return join(userFolder(dataDir, alice, []), PORTRAITS_DIR);
  };

  const store = (
    dir: string,
    write: (path: string, bytes: Uint8Array) => Promise<void> = writeEncryptedFile,
  ) =>
    createPortraitFiles({
      dir,
      scope: { key, username: alice },
      write,
      log: createLogger((line) => lines.push(line)),
    });

  /** The real writer, able to fail once. */
  function writer() {
    const state = { failNext: false };
    return {
      state,
      write: async (path: string, bytes: Uint8Array) => {
        if (state.failNext) {
          state.failNext = false;
          throw new Error("disk full");
        }
        await writeEncryptedFile(path, bytes);
      },
    };
  }

  it("serves staged bytes, then writes an owner-only file that reads back from disk", async () => {
    const dir = await portraitsDir();
    const files = store(dir);
    const png = await plainPng();
    const id = files.put(png);
    expect(files.hasStaged).toBe(true);
    expect(same(files.read(id), png)).toBe(true);
    expect(await readdir(dir)).toEqual([]);

    await files.writeStaged(new Set([id]));
    expect(files.hasStaged).toBe(false);
    expect(await readdir(dir)).toEqual([portraitFileName(id)]);
    expect(modeOf(join(dir, portraitFileName(id)))).toBe(0o600);
    expect(modeOf(dir)).toBe(0o700);
    expect(same(store(dir).read(id), png)).toBe(true);
  });

  it("never writes a staged id the references do not name", async () => {
    const dir = await portraitsDir();
    const files = store(dir);
    const dropped = files.put(randomBytes(32));
    const kept = files.put(randomBytes(32));
    await files.writeStaged(new Set([kept]));
    expect(await readdir(dir)).toEqual([portraitFileName(kept)]);
    expect(files.hasStaged).toBe(false);
    await files.writeStaged(new Set([dropped, kept]));
    expect(await readdir(dir)).toEqual([portraitFileName(kept)]);
  });

  it("keeps a failed write staged and readable, and writes it next time", async () => {
    const dir = await portraitsDir();
    const disk = writer();
    const files = store(dir, disk.write);
    const png = randomBytes(64);
    const id = files.put(png);
    disk.state.failNext = true;
    await expect(files.writeStaged(new Set([id]))).rejects.toThrow("disk full");
    expect(files.hasStaged).toBe(true);
    expect(same(files.read(id), png)).toBe(true);
    expect(await readdir(dir)).toEqual([]);

    await files.writeStaged(new Set([id]));
    expect(files.hasStaged).toBe(false);
    expect(same(store(dir).read(id), png)).toBe(true);
  });

  it("collects unreferenced files and keeps referenced and staged ones", async () => {
    const dir = await portraitsDir();
    const files = store(dir);
    const unreferenced = files.put(randomBytes(16));
    const referenced = files.put(randomBytes(16));
    await files.writeStaged(new Set([unreferenced, referenced]));
    const references = new Set([referenced]);
    const staged = files.put(randomBytes(16));

    await files.collect(references);
    expect(await readdir(dir)).toEqual([portraitFileName(referenced)]);
    expect(files.read(staged)).toBeDefined();
    await files.writeStaged(new Set([staged]));
    await files.collect(new Set([referenced, staged]));
    expect((await readdir(dir)).sort()).toEqual(
      [portraitFileName(referenced), portraitFileName(staged)].sort(),
    );
  });

  it("keeps a file in flight: on disk, its write not yet settled", async () => {
    const dir = await portraitsDir();
    let renamed: () => void = () => {};
    const onDisk = new Promise<void>((resolve) => {
      renamed = resolve;
    });
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const files = store(dir, async (path, bytes) => {
      await writeEncryptedFile(path, bytes);
      renamed();
      await finished;
    });
    const id = files.put(randomBytes(16));
    const writing = files.writeStaged(new Set([id]));
    await onDisk;
    await files.collect(new Set());
    expect(await readdir(dir)).toEqual([portraitFileName(id)]);
    finish();
    await writing;
  });

  it("reconciles at open: deletes orphans, counts missing files, leaves foreign names", async () => {
    const dir = await portraitsDir();
    const files = store(dir);
    const kept = files.put(randomBytes(16));
    const orphan = files.put(randomBytes(16));
    await files.writeStaged(new Set([kept, orphan]));
    const malformed = `${randomUUID().toUpperCase()}.enc`;
    await writeFile(join(dir, "notes.txt"), "x");
    await writeFile(join(dir, malformed), "x");
    const absent = randomUUID();

    expect(store(dir).reconcile(new Set([kept, absent]))).toEqual({ orphans: 1, missing: 1 });
    expect((await readdir(dir)).sort()).toEqual(
      [portraitFileName(kept), "notes.txt", malformed].sort(),
    );
  });

  it("fails the reconcile when the folder cannot be listed", async () => {
    const path = join(root, `${randomUUID()}.file`);
    await writeFile(path, "not a folder");
    expect(() => store(path).reconcile(new Set())).toThrow();
  });

  it("sweeps a temp file a crashed portrait write left", async () => {
    const dataDir = join(root, randomUUID());
    await mkdir(dataDir, { mode: 0o700 });
    const dir = join(userFolder(dataDir, alice, []), PORTRAITS_DIR);
    const leftover = join(dir, `${portraitFileName(randomUUID())}.${randomUUID()}.tmp`);
    await writeFile(leftover, randomBytes(32));
    const created: string[] = [];
    userFolder(dataDir, alice, created);
    expect(created).toEqual([]);
    expect(existsSync(leftover)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports the user folder as created when it made the portraits folder", async () => {
    const dataDir = join(root, randomUUID());
    await mkdir(dataDir, { mode: 0o700 });
    const created: string[] = [];
    const folder = userFolder(dataDir, alice, created);
    expect(created).toEqual([dataDir, join(dataDir, "users"), folder]);
    expect(modeOf(join(folder, PORTRAITS_DIR))).toBe(0o700);
  });

  it("returns nothing for a file sealed for another user or another id, logging a class only", async () => {
    const dir = await portraitsDir();
    const id = randomUUID();
    const other = randomUUID();
    await writeEncryptedFile(
      join(dir, portraitFileName(id)),
      encryptSnapshot(randomBytes(16), { key, username: "bob", context: portraitContext(id) }),
    );
    await writeEncryptedFile(
      join(dir, portraitFileName(other)),
      encryptSnapshot(randomBytes(16), { key, username: alice, context: portraitContext(id) }),
    );
    const files = store(dir);
    expect(files.read(id)).toBeUndefined();
    expect(files.read(other)).toBeUndefined();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({
        event: "portrait.read",
        errorClass: "EncryptedFileError",
      });
      expect(line).not.toMatch(/alice|bob/);
      expect(line).not.toContain(id);
      expect(line).not.toContain(other);
    }
  });

  it("keeps the memory store off the disk and drops what is not referenced", async () => {
    const before = await readdir(root);
    const files = createMemoryPortraitFiles();
    const png = randomBytes(32);
    const kept = files.put(png);
    const replaced = files.put(randomBytes(32));
    expect(files.hasStaged).toBe(false);
    expect(same(files.read(kept), png)).toBe(true);
    await files.writeStaged(new Set([kept, replaced]));
    await files.collect(new Set([kept]));
    expect(files.read(replaced)).toBeUndefined();
    expect(same(files.read(kept), png)).toBe(true);
    expect(files.reconcile(new Set([randomUUID()]))).toEqual({ orphans: 0, missing: 0 });
    expect(await readdir(root)).toEqual(before);
  });
});
