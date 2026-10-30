import { readFile } from "node:fs/promises";

/**
 * Reads the bundled starter card once at startup (starter.ts). Lives here
 * because this module is the only server code allowed to touch the file
 * system (scripts/persistence-audit.ts); it only reads, and only that card.
 */
export async function readStarterCardFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}
