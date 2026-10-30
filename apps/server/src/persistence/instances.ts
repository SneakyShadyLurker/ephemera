import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Username } from "../identity.ts";
import { errorClass, type Logger } from "../log.ts";
import type { StarterCharacter } from "../starter.ts";
import { createStores } from "./create-stores.ts";
import { MIGRATIONS } from "./db.ts";
import {
  decryptSnapshot,
  ENCRYPTED_FILE,
  encryptSnapshot,
  PORTRAITS_DIR,
  syncDirectory,
  writeEncryptedFile,
} from "./encrypted-file.ts";
import {
  createMemoryPortraitFiles,
  createPortraitFiles,
  type PortraitFiles,
} from "./portrait-files.ts";
import { referencedFiles } from "./portraits.ts";
import { type InstanceRegistry, RegistryClosed, type Stores, type UserInstance } from "./store.ts";
import { openUserDatabase } from "./user-database.ts";
import { userFolder } from "./user-folder.ts";

export interface InstanceRegistryOptions {
  /** ":memory:" keeps every instance in memory only: no folder, no file, no flush. */
  dataDir: string | ":memory:";
  /** The 32-byte master key. */
  key: Buffer;
  log: Logger;
  idleMs?: number;
  sweepMs?: number;
  now?: () => number;
  migrationsFolder?: string;
  /** Replaces the atomic encrypted writer; for tests that make writes fail or wait. */
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
  /** The workflow a new user's settings start on: the workflow registry's default. */
  defaultWorkflow?: string;
  /** Added to a new user's library once, when their database is created; none when unset. */
  starterCharacter?: StarterCharacter;
}

const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

interface Entry extends UserInstance {
  inFlight: number;
  lastUsed: number;
  /** Flushes asked for and not yet settled. */
  flushing: number;
  close(): void;
}

/**
 * Every user's instance, opened on first use and kept in memory while in use.
 * Opening is synchronous end to end (read, decrypt, deserialize, migrate,
 * seed, then `map.set`), so two first requests for one user cannot both open
 * it. A file that exists but cannot be opened throws and is never replaced.
 * On disk the open also deletes portrait files no row names; rows whose
 * file is missing are kept.
 */
export function createInstanceRegistry(options: InstanceRegistryOptions): InstanceRegistry {
  const { dataDir, key, log } = options;
  const idleMs = options.idleMs ?? IDLE_MS;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const now = options.now ?? Date.now;
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS;
  const write = options.write ?? writeEncryptedFile;
  const map = new Map<Username, Entry>();
  let closed = false;
  let sweeping: Promise<void> | undefined;

  const open = (username: Username): Entry => {
    const unsynced: string[] = [];
    let file: string | undefined;
    let snapshot: Uint8Array | undefined;
    let files: PortraitFiles;
    if (dataDir === ":memory:") {
      files = createMemoryPortraitFiles();
    } else {
      const dir = userFolder(dataDir, username, unsynced);
      file = join(dir, ENCRYPTED_FILE);
      files = createPortraitFiles({
        dir: join(dir, PORTRAITS_DIR),
        scope: { key, username },
        write,
        log,
      });
      if (existsSync(file)) snapshot = decryptSnapshot(readFileSync(file), { key, username });
    }
    const database = openUserDatabase(snapshot, migrationsFolder);
    let stores: Stores;
    try {
      if (file !== undefined) {
        const { orphans, missing } = files.reconcile(referencedFiles(database.client));
        if (orphans > 0) log.info({ event: "instance.portrait_orphans", count: orphans });
        if (missing > 0) log.warn({ event: "instance.portrait_missing", count: missing });
      }
      stores = createStores(
        database.db,
        files,
        options.defaultWorkflow === undefined ? {} : { defaultWorkflow: options.defaultWorkflow },
      );
      // Only a database created here: a user who deleted the starter does not get it back.
      const starter = options.starterCharacter;
      if (snapshot === undefined && starter !== undefined) {
        stores.characters.create(starter.card, starter.portrait);
      }
    } catch (error) {
      database.close();
      throw error;
    }
    // A new instance is dirty until its first flush; an opened one is dirty once a migration or write lands.
    let flushedChanges = snapshot === undefined ? -1 : 0;
    let pending: Promise<void> = Promise.resolve();

    const flush = async () => {
      if (file === undefined) return;
      if (database.changes() === flushedChanges && !files.hasStaged) return;
      while (unsynced.length > 0) {
        await syncDirectory(unsynced[0] as string);
        unsynced.shift();
      }
      // Every staged portrait the rows name is written first; a put during a write loops again.
      do {
        await files.writeStaged(referencedFiles(database.client));
      } while (files.hasStaged);
      // From the check above to the encryption, synchronous: the image names only
      // written files, and writes landing during the file write stay dirty.
      const target = database.changes();
      const referenced = referencedFiles(database.client);
      const bytes = encryptSnapshot(database.client.serialize(), { key, username });
      await write(file, bytes);
      flushedChanges = target;
      // Only once that image is durable: the files it no longer names. Never throws.
      await files.collect(referenced);
    };

    const entry: Entry = {
      username,
      stores,
      calibration: new Map(),
      inFlight: 0,
      lastUsed: now(),
      flushing: 0,
      enter() {
        entry.inFlight += 1;
      },
      leave() {
        entry.inFlight = Math.max(0, entry.inFlight - 1);
        entry.lastUsed = now();
      },
      flushIfDirty() {
        entry.flushing += 1;
        const run = pending.then(flush).finally(() => {
          entry.flushing -= 1;
        });
        // A failed flush leaves the instance dirty and the queue running.
        pending = run.catch(() => {});
        return run;
      },
      close: database.close,
    };
    return entry;
  };

  const instance = (username: Username): UserInstance => {
    if (closed) throw new RegistryClosed("The instance registry is closed");
    const existing = map.get(username);
    if (existing !== undefined) return existing;
    try {
      const entry = open(username);
      map.set(username, entry);
      return entry;
    } catch (error) {
      log.error({ event: "instance.open", errorClass: errorClass(error) });
      throw error;
    }
  };

  const evictIdle = async () => {
    for (const [username, entry] of map) {
      const seen = entry.lastUsed;
      if (entry.inFlight > 0 || now() - seen < idleMs) continue;
      try {
        await entry.flushIfDirty();
      } catch (error) {
        log.error({ event: "instance.flush", errorClass: errorClass(error) });
        continue;
      }
      // Dropped only if nothing touched it while the flush ran.
      if (
        map.get(username) === entry &&
        entry.inFlight === 0 &&
        entry.lastUsed === seen &&
        entry.flushing === 0
      ) {
        map.delete(username);
        entry.close();
      }
    }
  };

  const sweep = () => {
    if (sweeping !== undefined || closed) return;
    sweeping = evictIdle()
      .catch((error: unknown) => {
        log.error({ event: "instance.sweep", errorClass: errorClass(error) });
      })
      .finally(() => {
        sweeping = undefined;
      });
  };

  // In memory, dropping an instance would lose its data: nothing is evicted.
  const timer = dataDir === ":memory:" ? undefined : setInterval(sweep, sweepMs);
  timer?.unref();

  const flushAll = async () => {
    const results = await Promise.allSettled(
      [...map.values()].map((entry) => entry.flushIfDirty()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  };

  return {
    instance,
    get size() {
      return map.size;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await sweeping;
      try {
        await flushAll();
      } finally {
        for (const entry of map.values()) entry.close();
        map.clear();
      }
    },
  };
}
