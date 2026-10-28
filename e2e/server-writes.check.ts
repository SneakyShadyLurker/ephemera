import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  encryptSnapshot,
  portraitContext,
  portraitFileName,
} from "../apps/server/src/persistence/encrypted-file.ts";
import { retentionRowPolicy } from "./retention-matrix.ts";
import { portraitPng } from "./support/creator-fixtures.ts";
import {
  APP_SERVERS,
  CANARY_MARKER,
  CLASSES_DIR,
  canary,
  E2E_DATA_KEY,
  FOCUSED_SPECS,
} from "./support/env.ts";
import {
  MATRIX_ROWS,
  type RowLabel,
  SERVER_HOPS,
  type ServerHop,
  scanHop,
} from "./support/retention.ts";
import {
  dataDirContaining,
  filesContaining,
  hitBytes,
  holds,
  PLAINTEXT_HIT,
  type ScanResult,
} from "./support/scan.ts";

/**
 * Retention matrix, server-process hops (local stand-in for the container):
 * runs after every browser project; one test per (hop, row) against the
 * manifest of rows that ran, so a clean cell means the row's content existed
 * and did not persist. Each hop but S-repo covers every app server. A hop
 * that cannot be read fails as unverified. A focused run scans what its
 * specs wrote: a row none of them covers is skipped by name, and the proofs
 * that every server served a chat wait for the whole suite.
 */

/** Scans each hop once for any canary; the per-row tests attribute the hits by label. */
function once(scan: () => Promise<ScanResult>): () => Promise<ScanResult> {
  let result: Promise<ScanResult> | undefined;
  return () => {
    result ??= scan();
    return result;
  };
}

const hops = Object.fromEntries(
  SERVER_HOPS.map((hop) => [hop, once(() => scanHop(hop, CANARY_MARKER))]),
) as Record<ServerHop, () => Promise<ScanResult>>;

/** The hits holding a canary of this row's label, in any form the scan looks for. */
async function hitsFor(scan: ScanResult, label: RowLabel): Promise<string[]> {
  const hits: string[] = [];
  for (const hit of scan.hits) {
    if (holds(await hitBytes(hit), `${CANARY_MARKER}-${label}-`)) hits.push(hit);
  }
  return hits;
}

const ran = once(async () => ({
  hits: await readdir(CLASSES_DIR).catch(() => []),
  unreadable: [],
  scanned: 0,
  decrypted: 0,
}));

for (const hop of SERVER_HOPS) {
  for (const [label, row] of Object.entries(MATRIX_ROWS) as [
    RowLabel,
    { row: string; serverHops?: readonly ServerHop[] },
  ][]) {
    if (!(row.serverHops ?? SERVER_HOPS).includes(hop)) continue;
    test(`${hop} holds no ${label} canary`, async () => {
      const rows = (await ran()).hits;
      // biome-ignore lint/suspicious/noSkippedTests: reports by name the rows a focused run did not cover; the whole suite never skips.
      test.skip(
        retentionRowPolicy(label, rows, FOCUSED_SPECS) === "skip",
        "row outside this focused run",
      );
      const scan = await hops[hop]();
      expect(scan.unreadable, `${hop} unverified`).toEqual([]);
      expect(await hitsFor(scan, label)).toEqual([]);
    });
  }
  test(`${hop} holds no canary of any class`, async () => {
    const scan = await hops[hop]();
    expect(scan).toMatchObject({ hits: [], unreadable: [] });
    // Every test's user has a database of their own on its server, so some were decrypted.
    if (hop === "S-data") expect(scan.decrypted).toBeGreaterThan(0);
  });
}

test("the scan finds a candidate portrait's marker as raw bytes and as base64", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephemera-scan-"));
  try {
    const marker = canary("control");
    const png = portraitPng(marker);
    const planted: Record<string, Buffer | string> = { "clean.bin": Buffer.alloc(4096, 7) };
    planted["raw.png"] = Buffer.concat([Buffer.alloc(100), png]);
    // The art stream's form, at each offset a 3-byte group can put the marker.
    for (const lead of [0, 1, 2]) {
      const base64 = Buffer.concat([Buffer.alloc(lead, 1), png]).toString("base64");
      planted[`stream-${lead}.ndjson`] = JSON.stringify({ type: "image", index: 0, png: base64 });
      planted[`utf16-${lead}.txt`] = Buffer.from(base64, "utf16le");
    }
    for (const [name, bytes] of Object.entries(planted)) await writeFile(join(dir, name), bytes);
    const scan = await filesContaining(dir, marker);
    expect(scan.scanned).toBe(Object.keys(planted).length);
    expect(scan.unreadable).toEqual([]);
    expect(scan.hits.map((path) => path.slice(dir.length + 1)).sort()).toEqual(
      Object.keys(planted)
        .filter((name) => name !== "clean.bin")
        .sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the S-data scan finds a canary only inside a user's encrypted files' plaintext", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephemera-scan-"));
  try {
    const marker = canary("control");
    const key = Buffer.from(E2E_DATA_KEY, "hex");
    const folder = join(dir, "users", "control");
    await mkdir(folder, { recursive: true });
    const sealed = encryptSnapshot(Buffer.from(`row ${marker} row`, "utf8"), {
      key,
      username: "control",
    });
    const file = join(folder, "ephemera.sqlite.enc");
    // An unfinished write's temp file is a user database too.
    const temp = `${file}.0f3c.tmp`;
    await writeFile(file, sealed);
    await writeFile(temp, sealed);
    // A portrait file is bound to its id as well as its user, its temp file to the same id.
    const id = randomUUID();
    const portraits = join(folder, "portraits");
    await mkdir(portraits);
    const portrait = encryptSnapshot(Buffer.from(`png ${marker} png`, "utf8"), {
      key,
      username: "control",
      context: portraitContext(id),
    });
    const portraitFile = join(portraits, portraitFileName(id));
    const portraitTemp = `${portraitFile}.${randomUUID()}.tmp`;
    await writeFile(portraitFile, portrait);
    await writeFile(portraitTemp, portrait);

    expect(await filesContaining(dir, marker)).toMatchObject({ hits: [], unreadable: [] });
    const scan = await dataDirContaining(dir, marker);
    expect(scan).toMatchObject({ unreadable: [], decrypted: 4 });
    expect(scan.hits.sort()).toEqual(
      [file, temp, portraitFile, portraitTemp].map((path) => `${path}${PLAINTEXT_HIT}`).sort(),
    );
    for (const hit of scan.hits) expect(holds(await hitBytes(hit), marker)).toBe(true);

    // A file the key, user or id does not open leaves the hop unverified, never clean.
    const other = join(dir, "users", "other");
    await mkdir(join(other, "portraits"), { recursive: true });
    await writeFile(join(other, "ephemera.sqlite.enc"), sealed);
    await writeFile(join(other, "portraits", portraitFileName(id)), portrait);
    const wrongId = join(portraits, portraitFileName(randomUUID()));
    await writeFile(wrongId, portrait);
    expect((await dataDirContaining(dir, marker)).unreadable.sort()).toEqual(
      [
        join(other, "ephemera.sqlite.enc"),
        join(other, "portraits", portraitFileName(id)),
        wrongId,
      ].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The whole suite sends a chat through every server; a focused run may not.
if (FOCUSED_SPECS === undefined) {
  for (const [name, server] of Object.entries(APP_SERVERS)) {
    test(`the ${name} server's data directory was scanned and its log recorded replies`, async () => {
      const scan = await dataDirContaining(server.data, CANARY_MARKER);
      expect(scan.scanned).toBeGreaterThan(0);
      expect(scan.decrypted).toBeGreaterThan(0);
      expect(await readFile(server.log, "utf8")).toContain('"event":"generation.end"');
    });
  }

  test("the main server's log recorded errors", async () => {
    expect(await readFile(APP_SERVERS.main.log, "utf8")).toContain('"event":"generation.error"');
  });
}
