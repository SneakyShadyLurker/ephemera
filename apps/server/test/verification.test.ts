import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankCard, type CharacterCard } from "@ephemera/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usernameSchema } from "../src/identity.ts";
import { createLogger } from "../src/log.ts";
import {
  createInstanceRegistry,
  ENCRYPTED_FILE,
  EncryptedFileError,
  type InstanceRegistry,
  PORTRAITS_DIR,
  verifyInstances,
} from "../src/persistence/index.ts";
import { samplePortrait } from "./helpers.ts";

const key = randomBytes(32);
const user = (name: string) => usernameSchema.parse(name);

const card = (name: string): CharacterCard => ({ ...blankCard(name), tags: ["fantasy"] });

/** Every file under a directory with its bytes and modification time. */
async function files(dir: string): Promise<Record<string, { bytes: Buffer; mtimeMs: number }>> {
  const found: Record<string, { bytes: Buffer; mtimeMs: number }> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found[path] = { bytes: await readFile(path), mtimeMs: statSync(path).mtimeMs };
  }
  return found;
}

describe("startup verification", () => {
  let root: string;
  let lines: string[];
  const open: InstanceRegistry[] = [];
  const log = () => createLogger((line) => lines.push(line));

  const registry = (dataDir: string) => {
    const created = createInstanceRegistry({ dataDir, key, log: log() });
    open.push(created);
    return created;
  };

  const dataDirectory = async () => {
    const dataDir = join(root, randomUUID());
    await mkdir(dataDir, { mode: 0o700 });
    return dataDir;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ephemera-verification-"));
  });
  beforeEach(() => {
    lines = [];
  });
  afterEach(async () => {
    for (const created of open.splice(0)) await created.close().catch(() => {});
    // Verification logs events and counts only: no path, no name.
    for (const line of lines) {
      expect(["count", "event", "level", "time"]).toEqual(
        expect.arrayContaining(Object.keys(JSON.parse(line))),
      );
    }
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Two users with flushed files and one entry that is not a user's folder. */
  const userSet = async () => {
    const dataDir = await dataDirectory();
    const instances = registry(dataDir);
    for (const name of ["alice", "bob"]) {
      instances.instance(user(name)).stores.characters.create(card(`Card of ${name}`));
    }
    await instances.close();
    await writeFile(join(dataDir, "users", "README"), "not a user");
    return dataDir;
  };

  it("verifies a valid set of user files without modifying any", async () => {
    const dataDir = await userSet();
    const untouched = await files(dataDir);

    await expect(verifyInstances({ dataDir, key, log: log() })).resolves.toBe(2);
    expect(await files(dataDir)).toEqual(untouched);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["startup.foreign_entry"]);
  });

  it("warns once about a missing portrait file and modifies nothing", async () => {
    const dataDir = await dataDirectory();
    const instances = registry(dataDir);
    const portrait = await samplePortrait();
    for (const name of ["alice", "bob"]) {
      const { characters } = instances.instance(user(name)).stores;
      characters.create(card(`First of ${name}`), portrait);
      characters.create(card(`Second of ${name}`), portrait);
    }
    await instances.close();
    const portraits = join(dataDir, "users", "bob", PORTRAITS_DIR);
    const [name] = readdirSync(portraits);
    await rm(join(portraits, name ?? ""));
    const untouched = await files(dataDir);

    await expect(verifyInstances({ dataDir, key, log: log() })).resolves.toBe(2);
    expect(await files(dataDir)).toEqual(untouched);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: "startup.portrait_missing", count: 1 }),
    ]);

    // A name no portrait file has counts as a foreign entry; a temp leftover does not.
    await writeFile(join(portraits, "notes.txt"), "not a portrait");
    await writeFile(join(portraits, `${randomUUID()}.enc.${randomUUID()}.tmp`), "leftover");
    lines = [];
    await expect(verifyInstances({ dataDir, key, log: log() })).resolves.toBe(2);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      "startup.foreign_entry",
      "startup.portrait_missing",
    ]);
  });

  it("stops verification under the wrong key, writing nothing", async () => {
    const dataDir = await userSet();
    const untouched = await files(dataDir);

    await expect(
      verifyInstances({ dataDir, key: randomBytes(32), log: log() }),
    ).rejects.toBeInstanceOf(EncryptedFileError);
    expect(await files(dataDir)).toEqual(untouched);
  });

  it("stops verification at a corrupted file, writing nothing", async () => {
    const dataDir = await userSet();
    const file = join(dataDir, "users", "bob", ENCRYPTED_FILE);
    const bytes = await readFile(file);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    await writeFile(file, bytes);
    const untouched = await files(dataDir);

    await expect(verifyInstances({ dataDir, key, log: log() })).rejects.toBeInstanceOf(
      EncryptedFileError,
    );
    expect(await files(dataDir)).toEqual(untouched);
  });
});
