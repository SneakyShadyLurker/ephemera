import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankCard } from "@ephemera/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usernameSchema } from "../src/identity.ts";
import { createLogger } from "../src/log.ts";
import {
  createInstanceRegistry,
  decryptSnapshot,
  ENCRYPTED_FILE,
  EncryptedFileError,
  encryptSnapshot,
  type InstanceRegistry,
  type InstanceRegistryOptions,
  openUserDatabase,
  PORTRAITS_DIR,
  type Portrait,
  portraitFileName,
  RegistryClosed,
  writeEncryptedFile,
} from "../src/persistence/index.ts";
import { referencedFiles } from "../src/persistence/portraits.ts";

const key = randomBytes(32);
const user = (name: string) => usernameSchema.parse(name);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const modeOf = (path: string) => statSync(path).mode & 0o777;
const fileOf = (dataDir: string, username: string) =>
  join(dataDir, "users", username, ENCRYPTED_FILE);
const portraitsOf = (dataDir: string, username: string) =>
  join(dataDir, "users", username, PORTRAITS_DIR);

/** A portrait the schema accepts: a PNG signature and `size` random bytes. */
const portraitOf = (size = 64): Portrait => ({
  png: new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(size),
    ]),
  ),
  thumb: new Uint8Array(Buffer.from("RIFF\0\0\0\0WEBP", "latin1")),
  width: 1,
  height: 1,
});

/** The user's database file as an outsider reads it. */
async function databaseOnDisk(dataDir: string, username: string): Promise<Database> {
  const bytes = await readFile(fileOf(dataDir, username));
  return Database.deserialize(decryptSnapshot(bytes, { key, username }), { strict: true });
}

/** Whether the bytes hold the marker as UTF-8 or UTF-16LE text. */
const holds = (bytes: Uint8Array, marker: string) =>
  Buffer.from(bytes).includes(Buffer.from(marker, "utf8")) ||
  Buffer.from(bytes).includes(Buffer.from(marker, "utf16le"));

/** Reads a user's file as an outsider would: decrypt, deserialize, query. */
async function namesOnDisk(dataDir: string, username: string): Promise<string[]> {
  const bytes = await readFile(fileOf(dataDir, username));
  const raw = Database.deserialize(decryptSnapshot(bytes, { key, username }), { strict: true });
  const rows = raw.query<{ name: string }, []>("SELECT name FROM characters ORDER BY name").all();
  raw.close();
  return rows.map((row) => row.name);
}

/** The real atomic writer, counted, and able to fail once or wait for a release. */
function writer() {
  const state = {
    calls: 0,
    failNext: false,
    /** Fails the next write whose path matches, once. */
    failOn: undefined as ((path: string) => boolean) | undefined,
    /** Every path written, in order. */
    paths: [] as string[],
    gate: undefined as Promise<void> | undefined,
    open: () => {},
  };
  return {
    state,
    hold() {
      state.gate = new Promise((resolve) => {
        state.open = resolve;
      });
    },
    release() {
      state.gate = undefined;
      state.open();
    },
    write: async (path: string, bytes: Uint8Array) => {
      state.calls += 1;
      await state.gate;
      if (state.failNext || state.failOn?.(path)) {
        state.failNext = false;
        state.failOn = undefined;
        throw new Error("disk full");
      }
      state.paths.push(path);
      await writeEncryptedFile(path, bytes);
    },
  };
}

describe("instance registry", () => {
  let root: string;
  let lines: string[];
  const open: InstanceRegistry[] = [];

  const registry = (dataDir: string, options: Partial<InstanceRegistryOptions> = {}) => {
    const created = createInstanceRegistry({
      dataDir,
      key,
      log: createLogger((line) => lines.push(line)),
      ...options,
    });
    open.push(created);
    return created;
  };

  const dataDirectory = async () => {
    const dataDir = join(root, randomUUID());
    await mkdir(dataDir, { mode: 0o700 });
    return dataDir;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ephemera-instances-"));
  });
  beforeEach(() => {
    lines = [];
  });
  afterEach(async () => {
    for (const created of open.splice(0)) await created.close().catch(() => {});
    expect(lines.join("\n")).not.toMatch(/alice|bob/);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps temporary sort storage in memory for fresh and encrypted restored databases", () => {
    const fresh = openUserDatabase(undefined);
    let snapshot: Uint8Array;
    const sorted = (client: Database) => {
      expect(client.query("PRAGMA temp_store").get()).toEqual({ temp_store: 2 });
      const sql = "SELECT value FROM sort_samples ORDER BY value";
      expect(
        client
          .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .some(({ detail }) => detail.includes("USE TEMP B-TREE FOR ORDER BY")),
      ).toBe(true);
      const rows = client.query<{ value: string }, []>(sql).all();
      expect(rows).toHaveLength(2_048);
      expect(rows[0]?.value.startsWith("0001-synthetic-")).toBe(true);
      expect(rows.at(-1)?.value.startsWith("2048-synthetic-")).toBe(true);
    };
    try {
      expect(fresh.client.query("PRAGMA temp_store").get()).toEqual({ temp_store: 2 });
      fresh.client.run("CREATE TABLE sort_samples (value TEXT NOT NULL)");
      fresh.client.run(`
        WITH RECURSIVE samples(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM samples WHERE n < 2048
        )
        INSERT INTO sort_samples
        SELECT printf('%04d-synthetic-', 2049 - n) || hex(zeroblob(1024)) FROM samples
      `);
      sorted(fresh.client);
      snapshot = encryptSnapshot(fresh.client.serialize(), { key, username: "alice" });
      expect(Buffer.from(snapshot).includes(Buffer.from("synthetic-"))).toBe(false);
    } finally {
      fresh.close();
    }
    const restored = openUserDatabase(decryptSnapshot(snapshot, { key, username: "alice" }));
    try {
      sorted(restored.client);
    } finally {
      restored.close();
    }
  });

  it("closes a deserialized connection when its first read finds corrupt bytes", () => {
    const closing = vi.spyOn(Database.prototype, "close");
    try {
      expect(() => openUserDatabase(new Uint8Array(4096))).toThrow(EncryptedFileError);
      expect(closing).toHaveBeenCalledExactlyOnceWith(true);
      const client = closing.mock.contexts[0];
      if (!(client instanceof Database)) throw new Error("connection was not closed");
      expect(() => client.query("SELECT 1").get()).toThrow();
    } finally {
      closing.mockRestore();
    }
  });

  it("closes a user's connection when migrations cannot initialize it", () => {
    const closing = vi.spyOn(Database.prototype, "close");
    try {
      expect(() => openUserDatabase(undefined, join(root, "missing-migrations"))).toThrow();
      expect(closing).toHaveBeenCalledExactlyOnceWith(true);
      const client = closing.mock.contexts[0];
      if (!(client instanceof Database)) throw new Error("connection was not closed");
      expect(() => client.query("SELECT 1").get()).toThrow();
    } finally {
      closing.mockRestore();
    }
  });

  it("creates the user's folder owner-only on first use and the file only on the first flush", async () => {
    const dataDir = await dataDirectory();
    const instances = registry(dataDir);
    expect(existsSync(join(dataDir, "users"))).toBe(false);

    const alice = instances.instance(user("alice"));
    expect(modeOf(join(dataDir, "users"))).toBe(0o700);
    expect(modeOf(join(dataDir, "users", "alice"))).toBe(0o700);
    expect(await readdir(join(dataDir, "users", "alice"))).toEqual(["portraits"]);

    await alice.flushIfDirty();
    expect((await readdir(join(dataDir, "users", "alice"))).sort()).toEqual([
      ENCRYPTED_FILE,
      "portraits",
    ]);
    expect(modeOf(fileOf(dataDir, "alice"))).toBe(0o600);
    expect(await readdir(join(dataDir, "users"))).toEqual(["alice"]);
    expect(instances.instance(user("alice"))).toBe(alice);
    expect(instances.size).toBe(1);
  });

  it("keeps in-memory instances off the disk", async () => {
    const instances = registry(":memory:");
    const alice = instances.instance(user("alice"));
    const portrait = portraitOf();
    const id = alice.stores.characters.create(blankCard("Wren"), portrait);
    await alice.flushIfDirty();
    const reopened = instances.instance(user("alice")).stores.characters;
    expect(reopened.get(id)?.card.name).toBe("Wren");
    expect(Buffer.from((await reopened.portrait(id, "full"))?.bytes ?? [])).toEqual(
      Buffer.from(portrait.png),
    );
    expect(existsSync(":memory:")).toBe(false);
    expect(existsSync("users")).toBe(false);
  });

  it("isolates users: each has its own entities, seeded presets and settings", async () => {
    const dataDir = await dataDirectory();
    const instances = registry(dataDir);
    const alice = instances.instance(user("alice")).stores;
    const id = alice.characters.create(blankCard("Wren"));
    expect(existsSync(join(dataDir, "users", "bob"))).toBe(false);

    const bob = instances.instance(user("bob")).stores;
    expect(existsSync(join(dataDir, "users", "bob"))).toBe(true);
    expect(bob.characters.get(id)).toBeUndefined();
    expect(bob.characters.list()).toEqual([]);
    expect(alice.characters.list().map((row) => row.id)).toEqual([id]);
    for (const stores of [alice, bob]) {
      expect(stores.presets.prompt.list()).toHaveLength(1);
      expect(stores.presets.sampler.list()).toHaveLength(1);
      expect(stores.settings.get()).toMatchObject({
        promptPresetId: stores.presets.prompt.list()[0]?.id,
        samplerPresetId: stores.presets.sampler.list()[0]?.id,
      });
    }
    expect(bob.presets.prompt.list()[0]?.id).not.toBe(alice.presets.prompt.list()[0]?.id);
  });

  it("gives only a new user's library the starter character, so a deleted one stays gone", async () => {
    const dataDir = await dataDirectory();
    const starterCharacter = { card: blankCard("Starter"), portrait: portraitOf() };
    const first = registry(dataDir, { starterCharacter });
    const alice = first.instance(user("alice"));
    const [starter] = alice.stores.characters.list();
    expect(alice.stores.characters.list().map((row) => row.name)).toEqual(["Starter"]);
    expect(
      Buffer.from((await alice.stores.characters.portrait(starter?.id ?? "", "full"))?.bytes ?? []),
    ).toEqual(Buffer.from(starterCharacter.portrait.png));
    alice.stores.characters.remove(starter?.id ?? "");
    await alice.flushIfDirty();
    await first.close();

    const restarted = registry(dataDir, { starterCharacter });
    expect(restarted.instance(user("alice")).stores.characters.list()).toEqual([]);
    expect(
      restarted
        .instance(user("bob"))
        .stores.characters.list()
        .map((row) => row.name),
    ).toEqual(["Starter"]);
  });

  it("starts a new library's reply model on the default model and never changes a saved one", async () => {
    const dataDir = await dataDirectory();
    const first = registry(dataDir, { defaultModel: "vendor/chat-large" });
    const alice = first.instance(user("alice"));
    expect(alice.stores.settings.get().model).toBe("vendor/chat-large");
    alice.stores.settings.update({ model: "vendor/chat-own" });
    await alice.flushIfDirty();
    await first.close();

    const restarted = registry(dataDir, { defaultModel: "vendor/chat-small" });
    expect(restarted.instance(user("alice")).stores.settings.get().model).toBe("vendor/chat-own");
    expect(restarted.instance(user("bob")).stores.settings.get().model).toBe("vendor/chat-small");
    expect(registry(":memory:").instance(user("carol")).stores.settings.get().model).toBeNull();
  });

  it("encrypts the file, reopens it after a restart and never replaces one it cannot open", async () => {
    const dataDir = await dataDirectory();
    const marker = `canary-${randomUUID()}`;
    const first = registry(dataDir);
    const alice = first.instance(user("alice"));
    alice.stores.characters.create(blankCard(marker));
    await alice.flushIfDirty();
    await first.close();
    const good = await readFile(fileOf(dataDir, "alice"));
    expect(holds(good, marker)).toBe(false);

    const restarted = registry(dataDir);
    expect(restarted.instance(user("alice")).stores.characters.list()[0]?.name).toBe(marker);
    await restarted.close();

    const flipped = Buffer.from(good);
    flipped[100] = (flipped[100] ?? 0) ^ 0x01;
    await mkdir(join(dataDir, "users", "bob"), { mode: 0o700 });
    const cases = [
      { name: "alice", bytes: good, options: { key: randomBytes(32) } },
      { name: "alice", bytes: flipped, options: {} },
      // alice's file copied into bob's folder.
      { name: "bob", bytes: good, options: {} },
    ];
    for (const { name, bytes, options } of cases) {
      await writeFile(fileOf(dataDir, name), bytes);
      const instances = registry(dataDir, options);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => instances.instance(user(name))).toThrow(EncryptedFileError);
      }
      expect(instances.size).toBe(0);
      expect((await readFile(fileOf(dataDir, name))).equals(bytes)).toBe(true);
      expect((await readdir(join(dataDir, "users", name))).sort()).toEqual([
        ENCRYPTED_FILE,
        "portraits",
      ]);
    }
    expect(lines.filter((line) => line.includes('"event":"instance.open"'))).toHaveLength(6);
    expect(lines.join("\n")).toContain('"errorClass":"EncryptedFileError"');
  });

  it("writes only when the database changed, and coalesces writes made during a flush", async () => {
    const dataDir = await dataDirectory();
    const counted = writer();
    const instances = registry(dataDir, { write: counted.write });
    const alice = instances.instance(user("alice"));
    await alice.flushIfDirty();
    expect(counted.state.calls).toBe(1);
    const file = fileOf(dataDir, "alice");
    const before = await readFile(file);
    const mtime = statSync(file).mtimeMs;

    alice.stores.characters.list();
    await alice.flushIfDirty();
    expect(counted.state.calls).toBe(1);
    expect((await readFile(file)).equals(before)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);

    counted.hold();
    alice.stores.characters.create(blankCard("A"));
    const flushes = [alice.flushIfDirty()];
    await vi.waitFor(() => expect(counted.state.calls).toBe(2));
    alice.stores.characters.create(blankCard("B"));
    flushes.push(alice.flushIfDirty());
    alice.stores.characters.create(blankCard("C"));
    flushes.push(alice.flushIfDirty());
    counted.release();
    await Promise.all(flushes);
    // The flush in progress, then one follow-up for both later writes.
    expect(counted.state.calls).toBe(3);
    expect(await namesOnDisk(dataDir, "alice")).toEqual(["A", "B", "C"]);
  });

  it("keeps a failed write dirty, retries it, and runs flushes queued behind it", async () => {
    const dataDir = await dataDirectory();
    const counted = writer();
    const instances = registry(dataDir, { write: counted.write });
    const alice = instances.instance(user("alice"));
    await alice.flushIfDirty();
    const file = fileOf(dataDir, "alice");
    const before = await readFile(file);

    counted.state.failNext = true;
    alice.stores.characters.create(blankCard("Kept"));
    await expect(alice.flushIfDirty()).rejects.toThrow("disk full");
    expect((await readFile(file)).equals(before)).toBe(true);
    await alice.flushIfDirty();
    expect(await namesOnDisk(dataDir, "alice")).toEqual(["Kept"]);

    counted.state.failNext = true;
    alice.stores.characters.create(blankCard("Queued"));
    const failed = alice.flushIfDirty();
    const queued = alice.flushIfDirty();
    await expect(failed).rejects.toThrow("disk full");
    await queued;
    expect(await namesOnDisk(dataDir, "alice")).toEqual(["Kept", "Queued"]);
  });

  it("migrates a file from an older schema and writes the migrated snapshot once", async () => {
    const migrations = join(root, "m3-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    await copyFile(join(source, "0000_characters.sql"), join(migrations, "0000_characters.sql"));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    const applied = journal.entries.length;
    journal.entries = journal.entries.slice(0, 1);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    old
      .query(
        "INSERT INTO characters (id, name, nickname, creator, tags, card, created_at, updated_at) VALUES (?, 'Wren', '', '', '[]', ?, 1, 1)",
      )
      .run(randomUUID(), JSON.stringify(blankCard("Wren")));
    const dataDir = await dataDirectory();
    await mkdir(join(dataDir, "users", "alice"), { recursive: true, mode: 0o700 });
    await writeEncryptedFile(
      fileOf(dataDir, "alice"),
      encryptSnapshot(old.serialize(), { key, username: "alice" }),
    );
    old.close();

    const counted = writer();
    const alice = registry(dataDir, { write: counted.write }).instance(user("alice"));
    expect(alice.stores.characters.list().map((row) => row.name)).toEqual(["Wren"]);
    await alice.flushIfDirty();
    expect(counted.state.calls).toBe(1);
    const bytes = await readFile(fileOf(dataDir, "alice"));
    const raw = Database.deserialize(decryptSnapshot(bytes, { key, username: "alice" }));
    expect(raw.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({
      n: applied,
    });
    raw.close();

    const again = writer();
    const reopened = registry(dataDir, { write: again.write }).instance(user("alice"));
    reopened.stores.characters.list();
    await reopened.flushIfDirty();
    expect(again.state.calls).toBe(0);
  });

  it("flushes and drops idle instances, but never one with a request in flight", async () => {
    const dataDir = await dataDirectory();
    let clock = 0;
    const instances = registry(dataDir, { idleMs: 1_000, sweepMs: 5, now: () => clock });
    const alice = instances.instance(user("alice"));
    await alice.flushIfDirty();
    alice.enter();
    alice.stores.characters.create(blankCard("Last"));
    alice.leave();
    const bob = instances.instance(user("bob"));
    bob.enter();

    clock += 2_000;
    await vi.waitFor(() => expect(instances.size).toBe(1));
    expect(await namesOnDisk(dataDir, "alice")).toEqual(["Last"]);
    await pause(30);
    expect(instances.instance(user("bob"))).toBe(bob);

    bob.leave();
    clock += 2_000;
    await vi.waitFor(() => expect(instances.size).toBe(0));
    const reopened = instances.instance(user("alice"));
    expect(reopened).not.toBe(alice);
    expect(reopened.stores.characters.list().map((row) => row.name)).toEqual(["Last"]);
  });

  it("never overlaps sweeps: while one waits on a slow flush, later ticks start none", async () => {
    const dataDir = await dataDirectory();
    let clock = 0;
    // Every sweep reads the clock for each instance it considers.
    let clockReads = 0;
    const counted = writer();
    const instances = registry(dataDir, {
      idleMs: 1_000,
      sweepMs: 2,
      now: () => {
        clockReads += 1;
        return clock;
      },
      write: counted.write,
    });
    instances.instance(user("alice")).stores.characters.create(blankCard("Slow"));

    counted.hold();
    clock += 2_000;
    await vi.waitFor(() => expect(counted.state.calls).toBe(1));
    const reads = clockReads;
    await pause(40);
    expect(clockReads).toBe(reads);
    expect(counted.state.calls).toBe(1);
    expect(instances.size).toBe(1);

    counted.release();
    await vi.waitFor(() => expect(instances.size).toBe(0));
    expect(lines.filter((line) => line.includes('"level":"error"'))).toEqual([]);
    expect(await namesOnDisk(dataDir, "alice")).toEqual(["Slow"]);
  });

  it("flushes every instance on close and refuses new ones once closing starts", async () => {
    const dataDir = await dataDirectory();
    const instances = registry(dataDir);
    const alice = instances.instance(user("alice"));
    await alice.flushIfDirty();
    alice.stores.characters.create(blankCard("Unflushed"));
    instances.instance(user("bob")).stores.characters.create(blankCard("New"));

    const closing = instances.close();
    expect(() => instances.instance(user("alice"))).toThrow(RegistryClosed);
    await closing;
    expect(instances.size).toBe(0);
    expect(await namesOnDisk(dataDir, "alice")).toEqual(["Unflushed"]);
    expect(await namesOnDisk(dataDir, "bob")).toEqual(["New"]);
  });

  it("removes temp files a crashed write left in the user's folder", async () => {
    const dataDir = await dataDirectory();
    const first = registry(dataDir);
    first.instance(user("alice")).stores.characters.create(blankCard("Wren"));
    await first.close();
    const leftover = `${fileOf(dataDir, "alice")}.${randomUUID()}.tmp`;
    await writeFile(leftover, randomBytes(64));

    const alice = registry(dataDir).instance(user("alice"));
    expect((await readdir(join(dataDir, "users", "alice"))).sort()).toEqual([
      ENCRYPTED_FILE,
      "portraits",
    ]);
    expect(alice.stores.characters.list().map((row) => row.name)).toEqual(["Wren"]);
  });

  it("flushes and reopens four 16 MB portraits within 2 seconds, the database file staying small", async () => {
    const dataDir = await dataDirectory();
    const alice = registry(dataDir).instance(user("alice"));
    for (let i = 0; i < 4; i++) {
      alice.stores.characters.create(blankCard(`Big ${i}`), portraitOf(16 * 1024 * 1024));
    }

    const started = performance.now();
    await alice.flushIfDirty();
    const reopened = registry(dataDir).instance(user("alice"));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(statSync(fileOf(dataDir, "alice")).size).toBeLessThan(1024 * 1024);
    const files = await readdir(portraitsOf(dataDir, "alice"));
    expect(files).toHaveLength(4);
    for (const name of files) {
      expect(statSync(join(portraitsOf(dataDir, "alice"), name)).size).toBeGreaterThan(
        16 * 1024 * 1024,
      );
    }
    expect(reopened.stores.characters.list()).toHaveLength(4);
  }, 30_000);

  const events = (name: string) =>
    lines.map((line) => JSON.parse(line)).filter((line) => line.event === name);

  it("writes a portrait's file before the database file that names it", async () => {
    const dataDir = await dataDirectory();
    const counted = writer();
    const alice = registry(dataDir, { write: counted.write }).instance(user("alice"));
    const id = alice.stores.characters.create(blankCard("Wren"), portraitOf());
    await alice.flushIfDirty();
    const raw = await databaseOnDisk(dataDir, "alice");
    const [file] = referencedFiles(raw);
    raw.close();
    expect(counted.state.paths).toEqual([
      join(portraitsOf(dataDir, "alice"), portraitFileName(file ?? "")),
      fileOf(dataDir, "alice"),
    ]);
    expect(await alice.stores.characters.portrait(id, "full")).toBeDefined();
  });

  it("keeps a replaced portrait's file until a database file without it is written", async () => {
    const dataDir = await dataDirectory();
    const counted = writer();
    const alice = registry(dataDir, { write: counted.write }).instance(user("alice"));
    const id = alice.stores.characters.create(blankCard("Wren"), portraitOf());
    await alice.flushIfDirty();
    const [old] = await readdir(portraitsOf(dataDir, "alice"));

    const replacement = portraitOf();
    alice.stores.characters.setPortrait(id, replacement);
    counted.state.failOn = (path) => path === fileOf(dataDir, "alice");
    await expect(alice.flushIfDirty()).rejects.toThrow("disk full");
    expect(await readdir(portraitsOf(dataDir, "alice"))).toHaveLength(2);
    const raw = await databaseOnDisk(dataDir, "alice");
    expect([...referencedFiles(raw)].map(portraitFileName)).toEqual([old]);
    raw.close();

    await alice.flushIfDirty();
    const remaining = await readdir(portraitsOf(dataDir, "alice"));
    expect(remaining).toHaveLength(1);
    expect(remaining).not.toContain(old);
    expect(Buffer.from((await alice.stores.characters.portrait(id, "full"))?.bytes ?? [])).toEqual(
      Buffer.from(replacement.png),
    );
  });

  it("never writes a database file naming a portrait file not yet written", async () => {
    const dataDir = await dataDirectory();
    const counted = writer();
    const checked: number[] = [];
    const write = async (path: string, bytes: Uint8Array) => {
      if (path === fileOf(dataDir, "alice")) {
        const raw = Database.deserialize(decryptSnapshot(bytes, { key, username: "alice" }));
        const named = [...referencedFiles(raw)];
        raw.close();
        for (const id of named) {
          expect(existsSync(join(portraitsOf(dataDir, "alice"), portraitFileName(id)))).toBe(true);
        }
        checked.push(named.length);
      }
      await counted.write(path, bytes);
    };
    const alice = registry(dataDir, { write }).instance(user("alice"));
    const first = alice.stores.characters.create(blankCard("A"), portraitOf());
    counted.hold();
    const flush = alice.flushIfDirty();
    await vi.waitFor(() => expect(counted.state.calls).toBe(1));
    // Lands while the first portrait's write waits.
    const second = alice.stores.characters.create(blankCard("B"), portraitOf());
    counted.release();
    await flush;
    await alice.flushIfDirty();
    expect(checked.length).toBeGreaterThan(0);
    const raw = await databaseOnDisk(dataDir, "alice");
    expect(referencedFiles(raw).size).toBe(2);
    raw.close();
    for (const id of [first, second]) {
      expect(await alice.stores.characters.portrait(id, "full")).toBeDefined();
    }
  });

  it("deletes a portrait file no row names when the instance opens", async () => {
    const dataDir = await dataDirectory();
    const first = registry(dataDir);
    const id = first
      .instance(user("alice"))
      .stores.characters.create(blankCard("Wren"), portraitOf());
    await first.close();
    const kept = await readdir(portraitsOf(dataDir, "alice"));
    const stray = portraitFileName(randomUUID());
    await writeFile(join(portraitsOf(dataDir, "alice"), stray), randomBytes(64), { mode: 0o600 });

    const alice = registry(dataDir).instance(user("alice"));
    expect(await readdir(portraitsOf(dataDir, "alice"))).toEqual(kept);
    expect(events("instance.portrait_orphans")).toEqual([expect.objectContaining({ count: 1 })]);
    expect(await alice.stores.characters.portrait(id, "full")).toBeDefined();
  });

  it("keeps a row whose portrait file is missing and serves its thumb", async () => {
    const dataDir = await dataDirectory();
    const portrait = portraitOf();
    const first = registry(dataDir);
    const id = first.instance(user("alice")).stores.characters.create(blankCard("Wren"), portrait);
    await first.close();
    const [name] = await readdir(portraitsOf(dataDir, "alice"));
    const path = join(portraitsOf(dataDir, "alice"), name ?? "");
    const bytes = await readFile(path);
    await rm(path);

    const alice = registry(dataDir).instance(user("alice")).stores.characters;
    expect(events("instance.portrait_missing")).toEqual([expect.objectContaining({ count: 1 })]);
    expect(alice.get(id)?.portrait).toEqual(expect.any(Number));
    expect(Buffer.from((await alice.portrait(id, "thumb"))?.bytes ?? [])).toEqual(
      Buffer.from(portrait.thumb),
    );
    expect(await alice.portrait(id, "full")).toBeUndefined();

    await writeFile(path, bytes, { mode: 0o600 });
    expect(Buffer.from((await alice.portrait(id, "full"))?.bytes ?? [])).toEqual(
      Buffer.from(portrait.png),
    );
  });
});
