import { createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { type FileHandle, mkdir, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decryptSnapshot,
  ENCRYPTED_FILE,
  EncryptedFileError,
  encryptSnapshot,
  parsePortraitFileName,
  portraitContext,
  portraitFileName,
  syncDirectory,
  writeEncryptedFile,
} from "../src/persistence/index.ts";

const key = randomBytes(32);
const alice = { key, username: "alice" };

/** Whether the bytes hold the marker as UTF-8 or UTF-16LE text. */
const holds = (bytes: Uint8Array, marker: string) =>
  Buffer.from(bytes).includes(Buffer.from(marker, "utf8")) ||
  Buffer.from(bytes).includes(Buffer.from(marker, "utf16le"));

function failure(run: () => unknown): EncryptedFileError {
  try {
    run();
  } catch (error) {
    if (error instanceof EncryptedFileError) return error;
    throw error;
  }
  throw new Error("expected an EncryptedFileError");
}

describe("encrypted snapshots", () => {
  it("round-trips an empty and a multi-megabyte image without any plaintext in the ciphertext", () => {
    const marker = `canary-${crypto.randomUUID()}`;
    const large = Buffer.concat([
      randomBytes(3 * 1024 * 1024),
      Buffer.from(marker, "utf8"),
      Buffer.from(marker, "utf16le"),
      randomBytes(1024 * 1024),
    ]);
    for (const plain of [new Uint8Array(0), large]) {
      const sealed = encryptSnapshot(plain, alice);
      expect(Buffer.from(decryptSnapshot(sealed, alice)).equals(Buffer.from(plain))).toBe(true);
      expect(holds(sealed, marker)).toBe(false);
    }
    expect(holds(large, marker)).toBe(true);
  });

  it("uses a fresh salt and nonce for every encryption", () => {
    const plain = Buffer.from("the same image");
    const first = encryptSnapshot(plain, alice);
    const second = encryptSnapshot(plain, alice);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(Buffer.from(first).subarray(9, 53).equals(Buffer.from(second).subarray(9, 53))).toBe(
      false,
    );
    expect(Buffer.from(decryptSnapshot(first, alice)).toString()).toBe("the same image");
    expect(Buffer.from(decryptSnapshot(second, alice)).toString()).toBe("the same image");
  });

  it("refuses a flipped byte anywhere: format in the magic and version, auth elsewhere", () => {
    const sealed = Buffer.from(encryptSnapshot(randomBytes(40), alice));
    for (let offset = 0; offset < sealed.length; offset++) {
      const altered = Buffer.from(sealed);
      altered[offset] = (altered[offset] ?? 0) ^ 0x01;
      expect(failure(() => decryptSnapshot(altered, alice)).reason).toBe(
        offset < 9 ? "format" : "auth",
      );
    }
  });

  it("refuses another master key, another user, a short file and a foreign file", () => {
    const sealed = encryptSnapshot(Buffer.from("alice's data"), alice);
    const errors = [
      failure(() => decryptSnapshot(sealed, { key: randomBytes(32), username: "alice" })),
      failure(() => decryptSnapshot(sealed, { key, username: "bob" })),
      failure(() => decryptSnapshot(sealed.subarray(0, 68), alice)),
      failure(() => decryptSnapshot(Buffer.from("SQLite format 3\0".padEnd(100, "\0")), alice)),
    ];
    expect(errors.map((error) => error.reason)).toEqual(["auth", "auth", "format", "format"]);
    for (const error of errors) {
      const text = `${String(error)} ${error.stack ?? ""}`;
      expect(text).not.toContain("alice");
      expect(text).not.toContain("bob");
      expect(text).not.toContain(key.toString("hex"));
    }
  });
});

describe("encryption contexts", () => {
  /** Sealed before contexts existed: "portrait-files fixture", a key of 32 bytes 0x2a, user alice. */
  const FIXTURE =
    "455048454d45524101b99df838384331c492efc8d425ed22af915839ef66470c03e87dc9bb969abf55b5072bb8063542c45a5531ec10f82cc045b5d3dad139280f890ee4a2eb893977f3d6e8800ba14b69bb8962cc8edea7b2fb2e";
  const fixtureScope = { key: Buffer.alloc(32, 0x2a), username: "alice" };

  it("opens a database file written before contexts existed", () => {
    expect(Buffer.from(decryptSnapshot(Buffer.from(FIXTURE, "hex"), fixtureScope)).toString()).toBe(
      "portrait-files fixture",
    );
  });

  it("keeps the database file's AAD at header and username", () => {
    const sealed = Buffer.from(encryptSnapshot(Buffer.from("image"), alice));
    const header = sealed.subarray(0, 53);
    const salt = sealed.subarray(9, 41);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(hkdfSync("sha256", key, salt, Buffer.from("ephemera-user-db-v1:alice"), 32)),
      sealed.subarray(41, 53),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.concat([header, Buffer.from("alice", "utf8")]));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([
      decipher.update(sealed.subarray(53, sealed.length - 16)),
      decipher.final(),
    ]);
    expect(plain.toString()).toBe("image");
  });

  it("binds a portrait file to its user and id, apart from the database file", () => {
    const id = crypto.randomUUID();
    const portrait = { ...alice, context: portraitContext(id) };
    const sealed = encryptSnapshot(Buffer.from("png"), portrait);
    expect(Buffer.from(decryptSnapshot(sealed, portrait)).toString()).toBe("png");
    const errors = [
      failure(() => decryptSnapshot(sealed, { ...portrait, username: "bob" })),
      failure(() =>
        decryptSnapshot(sealed, { ...alice, context: portraitContext(crypto.randomUUID()) }),
      ),
      failure(() => decryptSnapshot(sealed, alice)),
      failure(() => decryptSnapshot(encryptSnapshot(Buffer.from("image"), alice), portrait)),
    ];
    expect(errors.map((error) => error.reason)).toEqual(["auth", "auth", "auth", "auth"]);
  });

  it("names a portrait file by its id and reads only that form back", () => {
    const id = crypto.randomUUID();
    expect(portraitFileName(id)).toBe(`${id}.enc`);
    expect(parsePortraitFileName(portraitFileName(id))).toBe(id);
    expect(parsePortraitFileName(`${"-".repeat(36)}.enc`)).toBeUndefined();
    expect(parsePortraitFileName(`${id.toUpperCase()}.enc`)).toBeUndefined();
    expect(parsePortraitFileName(id)).toBeUndefined();
    expect(parsePortraitFileName(`${id}.enc.${crypto.randomUUID()}.tmp`)).toBeUndefined();
    expect(parsePortraitFileName(ENCRYPTED_FILE)).toBeUndefined();
  });
});

describe("writeEncryptedFile", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ephemera-enc-"));
  });
  afterAll(async () => {
    chmodSync(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  it("writes an owner-only file, replaces an existing one and leaves no temp file", async () => {
    const path = join(dir, ENCRYPTED_FILE);
    await writeEncryptedFile(path, Buffer.from("first"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    await writeEncryptedFile(path, Buffer.from("second"));
    expect((await readFile(path)).toString()).toBe("second");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([ENCRYPTED_FILE]);
  });

  /**
   * Makes every fsync of a directory (or of a file) fail with `code`, as a
   * filesystem that cannot sync one answers; runs `body`, then restores fsync.
   */
  async function failingSync(
    target: "directory" | "file",
    code: string,
    body: () => Promise<void>,
  ) {
    const probe = await open(dir, "r");
    const prototype: FileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    const sync = prototype.sync;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
      if ((await this.stat()).isDirectory() === (target === "directory")) {
        throw Object.assign(new Error("injected fsync failure"), { code });
      }
      return sync.call(this);
    });
    try {
      await body();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }

  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"])(
    "treats a directory fsync failing with %s as best effort",
    async (code) => {
      const folder = join(dir, `best-effort-${code}`);
      await mkdir(folder, { mode: 0o700 });
      const path = join(folder, ENCRYPTED_FILE);
      await failingSync("directory", code, async () => {
        await writeEncryptedFile(path, Buffer.from("written"));
        await syncDirectory(folder);
      });
      expect((await readFile(path)).toString()).toBe("written");
      expect(await readdir(folder)).toEqual([ENCRYPTED_FILE]);
    },
  );

  it("fails on any other directory fsync error, and on any file fsync error", async () => {
    const folder = join(dir, "fatal");
    await mkdir(folder, { mode: 0o700 });
    await failingSync("directory", "EIO", async () => {
      await expect(syncDirectory(folder)).rejects.toMatchObject({ code: "EIO" });
    });
    await failingSync("file", "EINVAL", async () => {
      await expect(
        writeEncryptedFile(join(folder, ENCRYPTED_FILE), Buffer.from("x")),
      ).rejects.toMatchObject({ code: "EINVAL" });
    });
    expect(await readdir(folder)).toEqual([]);
  });

  it("throws and leaves no temp file when the folder is not writable", async () => {
    const locked = join(dir, "locked");
    await mkdir(locked, { mode: 0o700 });
    chmodSync(locked, 0o500);
    try {
      await expect(
        writeEncryptedFile(join(locked, ENCRYPTED_FILE), Buffer.from("x")),
      ).rejects.toThrow();
      expect(await readdir(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
