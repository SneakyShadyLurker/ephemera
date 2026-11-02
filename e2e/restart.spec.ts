import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { chooseModel, lastReply, send, turns, upstreamRecords } from "./support/chat.ts";
import { appServer, CANARY_MARKER, canary, E2E_DIR, RESTART_PORT } from "./support/env.ts";
import { startServer as start, stopServer } from "./support/own-server.ts";
import {
  expectBackForwardRestoresNothing,
  expectClipboardUnchanged,
  expectProfileClean,
  expectStorageEmpty,
  expectUrlsClean,
  MATRIX_ROWS,
  openProfile,
  recordClass,
  writeClipboardSentinel,
} from "./support/retention.ts";
import { dataDirContaining, filesContaining } from "./support/scan.ts";
import { expect, test } from "./support/test.ts";

/*
 * Retention matrix, server restart mid-stream (docs/ARCHITECTURE.md
 * § Retention matrix, row R): a server process of its own, killed while a
 * reply streams, with SIGKILL and with SIGTERM, then restarted. Its data,
 * temp and home directories and its output are its own, so its server cells
 * are asserted here; the main check scans the repository through the manifest.
 */

const RESTART = appServer(RESTART_PORT, `${E2E_DIR}restart/`);
const { origin: ORIGIN, dir: DIR, data: DATA, tmp: TMP, home: HOME, log: LOG } = RESTART;
const startServer = (log: Parameters<typeof start>[1]) => start(RESTART, log);

/**
 * Sends a canary on mock-stall, whose stream stays open after the reply, and
 * proves it streamed before the server goes: a SIGTERM's drain cannot finish it.
 */
async function sendHeld(page: Page) {
  const line = canary("rst");
  await send(page, line);
  await expect(lastReply(page)).toContainText(line);
  expect(await upstreamRecords(line)).toHaveLength(1);
  return line;
}

test(`retention matrix: ${MATRIX_ROWS.rst.row}`, async ({ browserName, playwright, user }) => {
  // Two held replies (the SIGTERM one waits out the 8 s drain), two restarts and a profile scan; generous for a loaded machine.
  test.setTimeout(180_000);
  await rm(DIR, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await mkdir(HOME, { recursive: true });
  const log = createWriteStream(LOG, { flags: "a" });
  let server = await startServer(log);
  const profile = await openProfile(playwright[browserName], ORIGIN, user);
  const { context, page } = profile;
  try {
    await page.goto("/");
    const sentinel = await writeClipboardSentinel(page);

    for (const signal of ["SIGKILL", "SIGTERM"] as const) {
      await test.step(`rst: ${signal} mid-stream, then a restart`, async () => {
        await chooseModel(page, "mock-stall");
        const line = await sendHeld(page);
        await stopServer(server, signal);
        await expect(lastReply(page)).toHaveAttribute("data-status", "failed", {
          timeout: 15_000,
        });
        // The chat stays in the tab.
        await expect(turns(page).filter({ hasText: line })).toHaveCount(2);
        server = await startServer(log);
        await chooseModel(page, "mock-slow");
        const again = canary("rst");
        await send(page, again);
        // mock-slow streams for about 9 s; generous for a loaded machine.
        await expect(lastReply(page)).toHaveAttribute("data-status", "complete", {
          timeout: 45_000,
        });
        await expect(lastReply(page)).toContainText(again);
      });
    }

    await test.step("B-store", () => expectStorageEmpty(page));
    await test.step("B-url", () => expectUrlsClean(page));
    await test.step("B-bf", () => expectBackForwardRestoresNothing(page));
    await test.step("B-clip", () => expectClipboardUnchanged(page, sentinel));
    await context.close();
    expect(profile.policyViolations, "Content Security Policy violations").toEqual([]);
    await test.step("B-disk", () => expectProfileClean(profile.dir));
    await stopServer(server, "SIGTERM");
    await new Promise<void>((resolve) => log.end(resolve));

    await test.step("S-data", async () => {
      const scan = await dataDirContaining(DATA, CANARY_MARKER);
      expect(scan.decrypted).toBeGreaterThan(0);
      expect(scan).toMatchObject({ hits: [], unreadable: [] });
    });
    await test.step("S-tmp", async () => {
      expect(await filesContaining(TMP, CANARY_MARKER)).toMatchObject({
        hits: [],
        unreadable: [],
      });
    });
    await test.step("S-log", async () => {
      const output = await readFile(LOG, "utf8");
      // Three starts, all captured.
      expect(output.split('"event":"listening"')).toHaveLength(4);
      expect(output).not.toContain(CANARY_MARKER);
    });
    await test.step("S-home", async () => {
      expect(await filesContaining(HOME, CANARY_MARKER)).toMatchObject({
        hits: [],
        unreadable: [],
      });
    });
    await recordClass("rst");
  } finally {
    await context.close();
    await stopServer(server, "SIGTERM");
    log.end();
    await rm(profile.dir, { recursive: true, force: true });
  }
});
