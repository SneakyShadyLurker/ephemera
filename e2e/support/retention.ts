import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext, BrowserContext, BrowserType, Page } from "@playwright/test";
import { MATRIX_ROWS, type RowLabel, SERVER_HOPS, type ServerHop } from "../retention-matrix.ts";
import { browserStorage, turns } from "./chat.ts";
import type { ComfyScope } from "./creator.ts";
import {
  APP_SERVERS,
  type AppServer,
  boundHeaders,
  CANARY_MARKER,
  CLASSES_DIR,
  E2E_DIR,
  RUN_STARTED,
} from "./env.ts";
import type { ScopeOptions } from "./mock-comfyui.ts";
import {
  dataDirContaining,
  filesContaining,
  holds,
  type Needle,
  needleList,
  type ScanResult,
} from "./scan.ts";
import { appOrigin, expect, test, watchPolicyViolations } from "./test.ts";

export { MATRIX_ROWS, type RowLabel, SERVER_HOPS, type ServerHop } from "../retention-matrix.ts";

const root = new URL("../../", import.meta.url).pathname;
const TEST_ARTIFACTS = /\/(test-results|playwright-report|blob-report|\.vitest)\//;

/** One hop across every app server, as one result. */
async function everyServer(scan: (server: AppServer) => Promise<ScanResult>): Promise<ScanResult> {
  const results = await Promise.all(Object.values(APP_SERVERS).map(scan));
  return {
    hits: results.flatMap((result) => result.hits),
    unreadable: results.flatMap((result) => result.unreadable),
    scanned: results.reduce((total, result) => total + result.scanned, 0),
    decrypted: results.reduce((total, result) => total + result.decrypted, 0),
  };
}

/**
 * The files of one server hop holding `needle` (or any of several), across
 * every app server; S-repo covers the repository's files this run modified.
 * A hop that cannot be read reports it, never counts as clean.
 */
export async function scanHop(
  hop: ServerHop,
  needle: Needle | readonly Needle[],
): Promise<ScanResult> {
  switch (hop) {
    // The writable data directory (each user's encrypted database, decrypted here) holds characters, never chat.
    case "S-data":
      return everyServer((server) => dataDirContaining(server.data, needle));
    case "S-tmp":
      return everyServer((server) => filesContaining(server.tmp, needle));
    case "S-log":
      return everyServer(async (server) => {
        try {
          const log = await readFile(server.log);
          const hit = needleList(needle).some((one) => holds(log, one));
          return { hits: hit ? [server.log] : [], unreadable: [], scanned: 1, decrypted: 0 };
        } catch {
          return { hits: [], unreadable: [server.log], scanned: 0, decrypted: 0 };
        }
      });
    case "S-home":
      return everyServer((server) => filesContaining(server.home, needle));
    case "S-repo":
      return filesContaining(root, needle, {
        modifiedSince: Number(await readFile(RUN_STARTED, "utf8")),
        // The e2e directory is checked above; test artifacts hold synthetic page content by design.
        skip: (path) => path.startsWith(E2E_DIR) || TEST_ARTIFACTS.test(path),
      });
  }
}

/**
 * The server hops holding `needle`, or any of several: content without the
 * canary marker, such as fragments of a re-encoded image or a kept card's
 * mark. Each hop must be readable. The needle stays in the caller's memory.
 */
export async function serverHopsHolding(needle: Needle | readonly Needle[]): Promise<ServerHop[]> {
  const found: ServerHop[] = [];
  for (const hop of SERVER_HOPS) {
    const scan = await scanHop(hop, needle);
    expect(scan.unreadable, `${hop} unverified`).toEqual([]);
    if (scan.hits.length > 0) found.push(hop);
  }
  return found;
}

/** Marks a row as run: an empty file named by its label, never a canary value. */
export async function recordClass(label: RowLabel) {
  await mkdir(CLASSES_DIR, { recursive: true });
  await writeFile(join(CLASSES_DIR, label), "");
}

export interface Profile {
  dir: string;
  context: BrowserContext;
  page: Page;
  policyViolations: string[];
}

/**
 * A persistent Chromium profile for one row, signed in as `user`, so its
 * directory can be scanned after the browser closes. The back/forward cache
 * stays on (Playwright turns it off by default) and every `pageshow` is
 * recorded for the B-bf cell.
 */
export async function openProfile(
  browserType: BrowserType,
  origin: string,
  user: string,
): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), "ephemera-profile-"));
  const context = await browserType.launchPersistentContext(dir, {
    baseURL: origin,
    extraHTTPHeaders: boundHeaders(user),
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const policyViolations = await watchPolicyViolations(context);
  await context.addInitScript(() => {
    const record = window as unknown as { __pageshows?: boolean[] };
    record.__pageshows = [];
    window.addEventListener("pageshow", (event) => record.__pageshows?.push(event.persisted));
  });
  const page = context.pages()[0] ?? (await context.newPage());
  // The leave guard asks before a non-empty chat is left; the owner confirms.
  page.on("dialog", (dialog) => dialog.accept());
  return { dir, context, page, policyViolations };
}

/** B-clip, before the row: a sentinel in the clipboard, no canary. */
export async function writeClipboardSentinel(page: Page): Promise<string> {
  const sentinel = `clipboard-sentinel-${crypto.randomUUID()}`;
  await page.evaluate((text) => navigator.clipboard.writeText(text), sentinel);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel);
  return sentinel;
}

/** B-clip, after the row: the sentinel is still there, so nothing was copied. */
export async function expectClipboardUnchanged(page: Page, sentinel: string) {
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel);
}

/**
 * B-store: every storage surface is empty, HttpOnly cookies included, and
 * holds no canary nor any of `needles` (chat content without one).
 */
export async function expectStorageEmpty(page: Page, needles: string[] = []) {
  const storage = await browserStorage(page);
  expect(storage).toMatchObject({
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    cookies: "",
    cacheStorage: [],
    serviceWorkers: 0,
    opfs: [],
    storageBuckets: [],
    windowName: "",
  });
  for (const needle of [CANARY_MARKER, ...needles]) {
    expect(JSON.stringify(storage)).not.toContain(needle);
  }
  expect(await page.context().cookies()).toEqual([]);
}

/**
 * B-url: the URL, `history.state` and every `navigation.entries()` URL and
 * state hold no canary, nor any of `needles` (chat metadata without one).
 */
export async function expectUrlsClean(page: Page, needles: string[] = []) {
  const { url, historyState, navigationEntries } = await browserStorage(page);
  expect(Array.isArray(navigationEntries), String(navigationEntries)).toBe(true);
  expect(navigationEntries.length).toBeGreaterThan(0);
  const urls = JSON.stringify({ url, historyState, navigationEntries });
  for (const needle of [CANARY_MARKER, ...needles]) expect(urls).not.toContain(needle);
}

/** A chat page shows no turn and an empty composer. */
async function expectChatEmpty(page: Page) {
  // A new document reads the shared choices anew; a greeting of any character is not a turn.
  await expect(turns(page)).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
}

/**
 * B-bf: leave the page and come back, then find nothing restored. Either
 * the back/forward cache served the page (and `pagehide` had emptied it), or
 * Chromium refused to cache it because the document is `no-store`
 * (PRINCIPLES.md 1), which it names in `notRestoredReasons`. Any other way
 * back fails with the reasons, since the cell would pass without evidence.
 * `expectEmpty` checks the page shows nothing it held; a chat by default.
 */
export async function expectBackForwardRestoresNothing(
  page: Page,
  expectEmpty: (page: Page) => Promise<void> = expectChatEmpty,
) {
  await page.goto("about:blank");
  await page.goBack();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __pageshows?: boolean[] }).__pageshows?.length),
    )
    .toBeGreaterThan(0);
  const { persisted, reasons } = await page.evaluate(() => {
    const shows = (window as unknown as { __pageshows: boolean[] }).__pageshows;
    const [entry] = performance.getEntriesByType("navigation") as (PerformanceNavigationTiming & {
      notRestoredReasons?: unknown;
    })[];
    return {
      persisted: shows.at(-1) === true,
      reasons: JSON.stringify(entry?.notRestoredReasons ?? null),
    };
  });
  if (!persisted) {
    expect(
      reasons,
      "the back/forward cache refused the page for a reason other than no-store",
    ).toContain("response-cache-control-no-store");
  }
  await expectEmpty(page);
  expect(await page.content()).not.toContain(CANARY_MARKER);
  expect(JSON.stringify(await browserStorage(page))).not.toContain(CANARY_MARKER);
}

/**
 * B-disk: after the browser closed, no profile file holds a canary, nor any
 * of `needles` (chat content without one, or fragments of an image).
 */
export async function expectProfileClean(dir: string, needles: readonly Needle[] = []) {
  const scan = await filesContaining(dir, [CANARY_MARKER, ...needles]);
  expect(scan.scanned).toBeGreaterThan(0);
  expect(scan).toMatchObject({ hits: [], unreadable: [] });
}

/** What a row's `run` works with, and fills with what its cells look for besides the canary. */
export interface Row {
  context: BrowserContext;
  page: Page;
  /** The test's user's API client, outside the profile. */
  request: APIRequestContext;
  /** The test's `comfy` fixture: a mock ComfyUI scope saved as the user's address. */
  comfy: (options?: ScopeOptions) => Promise<ComfyScope>;
  /**
   * Chat content the row produced that holds no canary, such as a greeting
   * filled from stored text: the B-store, B-url and B-disk cells look for
   * each as for the canary.
   */
  chatContent: string[];
  /** Fragments of images the row made that B-disk looks for too. */
  fragments: Buffer[];
}

/**
 * One row of the retention matrix (docs/ARCHITECTURE.md § Retention matrix),
 * in its own persistent profile opened on `start`: `run` produces the row's
 * content and proves it existed, then every browser cell is a step; the
 * server cells run in e2e/server-writes.check.ts against the manifest each
 * row writes when it ran. `expectEmpty` is what B-bf finds once back (a chat
 * by default), and `n/a` cells are left out through `skip`.
 */
export function matrixRow(
  label: RowLabel,
  run: (row: Row) => Promise<void>,
  {
    start = "/",
    expectEmpty,
    skip = {},
    timeout,
  }: {
    start?: string;
    expectEmpty?: (page: Page) => Promise<void>;
    skip?: { bf?: true; clip?: true };
    timeout?: number;
  } = {},
) {
  test(`retention matrix: ${MATRIX_ROWS[label].row}`, async ({
    browserName,
    comfy,
    playwright,
    request,
    user,
  }) => {
    if (timeout !== undefined) test.setTimeout(timeout);
    const profile = await openProfile(playwright[browserName], appOrigin(), user);
    const { context, page } = profile;
    try {
      await page.goto(start);
      const sentinel = skip.clip ? undefined : await writeClipboardSentinel(page);
      const row: Row = { context, page, request, comfy, chatContent: [], fragments: [] };
      await test.step(`${label}: the content exists`, () => run(row));
      await test.step("B-store", () => expectStorageEmpty(page, row.chatContent));
      await test.step("B-url", () => expectUrlsClean(page, row.chatContent));
      if (!skip.bf) {
        await test.step("B-bf", () => expectBackForwardRestoresNothing(page, expectEmpty));
      }
      if (sentinel !== undefined) {
        await test.step("B-clip", () => expectClipboardUnchanged(page, sentinel));
      }
      await context.close();
      expect(profile.policyViolations, "Content Security Policy violations").toEqual([]);
      await test.step("B-disk", () =>
        expectProfileClean(profile.dir, [...row.chatContent, ...row.fragments]));
      await recordClass(label);
    } finally {
      await context.close();
      await rm(profile.dir, { recursive: true, force: true });
    }
  });
}
