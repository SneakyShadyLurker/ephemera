import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Username } from "../identity.ts";
import { errorClass, type Logger } from "../log.ts";
import {
  decryptSnapshot,
  encryptSnapshot,
  parsePortraitFileName,
  portraitContext,
  portraitFileName,
} from "./encrypted-file.ts";

/**
 * A user's portrait PNGs, one encrypted file each under
 * `users/<username>/portraits/`, named by an id the store assigns. A row in
 * the user's database names its file; a file is written before any image
 * that names it, and deleted only once a durable image no longer names it.
 */
export interface PortraitFiles {
  /** Stages the bytes under a new id; durable at the next flush. */
  put(png: Uint8Array): string;
  /** Staged or in-flight bytes, else the file decrypted; undefined when missing or unreadable. */
  read(id: string): Uint8Array | undefined;
  /** `read` without blocking on the disk, for request handlers. */
  load(id: string): Promise<Uint8Array | undefined>;
  /** True while any staged entry has not been written yet. */
  readonly hasStaged: boolean;
  /** Writes every currently staged id in `referenced`; drops staged ids not in it. */
  writeStaged(referenced: ReadonlySet<string>): Promise<void>;
  /** Deletes every portrait file not in `referenced` and not staged or in flight. */
  collect(referenced: ReadonlySet<string>): Promise<void>;
  /** At open: deletes files no row names; returns how many it deleted and how many referenced ids have no file. */
  reconcile(referenced: ReadonlySet<string>): { orphans: number; missing: number };
}

const missingFile = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** The portrait files of one user's folder, written through the registry's `write`. */
export function createPortraitFiles(options: {
  /** `<userFolder>/portraits` */
  dir: string;
  scope: { key: Buffer; username: Username };
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  log: Logger;
}): PortraitFiles {
  const { dir, scope, write, log } = options;
  const staged = new Map<string, Uint8Array>();
  const inFlight = new Map<string, Uint8Array>();
  const pathOf = (id: string) => join(dir, portraitFileName(id));
  const scopeOf = (id: string) => ({ ...scope, context: portraitContext(id) });
  const pending = (id: string) => staged.has(id) || inFlight.has(id);
  const unreadable = (error: unknown) => {
    log.warn({ event: "portrait.read", errorClass: errorClass(error) });
    return undefined;
  };

  return {
    put(png) {
      const id = randomUUID();
      staged.set(id, png);
      return id;
    },
    read(id) {
      const bytes = staged.get(id) ?? inFlight.get(id);
      if (bytes !== undefined) return bytes;
      try {
        return decryptSnapshot(readFileSync(pathOf(id)), scopeOf(id));
      } catch (error) {
        return unreadable(error);
      }
    },
    async load(id) {
      const bytes = staged.get(id) ?? inFlight.get(id);
      if (bytes !== undefined) return bytes;
      try {
        return decryptSnapshot(await readFile(pathOf(id)), scopeOf(id));
      } catch (error) {
        return unreadable(error);
      }
    },
    get hasStaged() {
      return staged.size > 0;
    },
    async writeStaged(referenced) {
      const ids = [...staged.keys()];
      // Ids are never reused, so a dropped id cannot become referenced later.
      for (const id of ids) if (!referenced.has(id)) staged.delete(id);
      for (const id of ids) {
        const png = staged.get(id);
        if (png === undefined) continue;
        staged.delete(id);
        inFlight.set(id, png);
        try {
          await write(pathOf(id), encryptSnapshot(png, scopeOf(id)));
        } catch (error) {
          staged.set(id, png);
          throw error;
        } finally {
          inFlight.delete(id);
        }
      }
    },
    async collect(referenced) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        log.warn({ event: "portrait.collect", errorClass: errorClass(error) });
        return;
      }
      for (const name of names) {
        const id = parsePortraitFileName(name);
        if (id === undefined || referenced.has(id) || pending(id)) continue;
        try {
          await unlink(join(dir, name));
        } catch (error) {
          if (!missingFile(error)) {
            log.warn({ event: "portrait.collect", errorClass: errorClass(error) });
          }
        }
      }
    },
    reconcile(referenced) {
      const present = new Set<string>();
      let orphans = 0;
      for (const name of readdirSync(dir)) {
        const id = parsePortraitFileName(name);
        if (id === undefined) continue;
        if (referenced.has(id) || pending(id)) {
          present.add(id);
          continue;
        }
        try {
          unlinkSync(join(dir, name));
          orphans += 1;
        } catch (error) {
          if (!missingFile(error)) throw error;
        }
      }
      let missing = 0;
      for (const id of referenced) if (!present.has(id)) missing += 1;
      return { orphans, missing };
    },
  };
}

/** Portraits of an in-memory instance: a Map, never the disk. */
export function createMemoryPortraitFiles(): PortraitFiles {
  const bytes = new Map<string, Uint8Array>();
  const drop = (referenced: ReadonlySet<string>) => {
    for (const id of [...bytes.keys()]) if (!referenced.has(id)) bytes.delete(id);
  };
  return {
    put(png) {
      const id = randomUUID();
      bytes.set(id, png);
      return id;
    },
    read: (id) => bytes.get(id),
    load: async (id) => bytes.get(id),
    hasStaged: false,
    async writeStaged(referenced) {
      drop(referenced);
    },
    async collect(referenced) {
      drop(referenced);
    },
    reconcile: () => ({ orphans: 0, missing: 0 }),
  };
}
