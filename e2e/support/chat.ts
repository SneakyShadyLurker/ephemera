import { expect, type Locator, type Page } from "@playwright/test";
import { choose, closeSession, openSession } from "./entities.ts";
import { UPSTREAM_PORT } from "./env.ts";
import type { MockCall, MockModel, UpstreamRecordView } from "./upstream.ts";

/** Chooses the model in Session; a Session sheet is closed again, a docked panel stays. */
export async function chooseModel(page: Page, model: MockModel) {
  await openSession(page);
  await choose(page, "Model", model);
  await closeSession(page);
}

/**
 * Confirming the dialogs that close a chat without remembering its ending:
 * the one action they have, or, while they offer to remember the ending
 * (memory on, its ending unremembered), the way out without it.
 */
const START_WITHOUT_REMEMBERING = /^Start new (chat|without remembering)$/;
const CLEAR_WITHOUT_REMEMBERING = /^Clear( without remembering)?$/;

/**
 * Chooses the chat's character in Session. `confirm` answers the "Start a new
 * chat" question that a non-empty chat asks; leave it out when none is expected.
 */
export async function chooseCharacter(
  page: Page,
  name: string,
  { confirm }: { confirm?: boolean } = {},
) {
  await openSession(page);
  const combobox = page.getByRole("combobox", { name: "Character" });
  await combobox.click();
  await page.getByRole("option", { name, exact: true }).click();
  if (confirm !== undefined) {
    const dialog = page.getByRole("alertdialog", { name: /^Start a new chat/ });
    await dialog
      .getByRole("button", { name: confirm ? START_WITHOUT_REMEMBERING : "Keep chatting" })
      .click();
    await expect(dialog).toHaveCount(0);
  }
  await closeSession(page);
}

/**
 * Opens the chat with `model`. The test's user is its own, so the other
 * choices are the seeded baseline's until the test changes them.
 */
export async function openChat(page: Page, model: MockModel) {
  await page.goto("/");
  await chooseModel(page, model);
}

export async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByLabel("Message", { exact: true }).press("Enter");
}

export const messages = (page: Page) => page.locator("[data-message]");

/** The chat's turns without a card's greeting, which a new chat may open on. */
export const turns = (page: Page) => page.locator("[data-message]:not([data-greeting])");

export const lastReply = (page: Page) =>
  page.locator('[data-message][data-role="assistant"]').last();

/** The last reply's row: New reply, Continue, More, and the pager once there are alternates. */
export const replyActions = (page: Page) => page.locator("[data-reply-actions]");

/** The last reply's pager. */
export const replyCounter = (page: Page) =>
  replyActions(page).getByRole("group", { name: "Replies" });

/**
 * Picks `item` from a More menu: a turn's own, or the last reply's in its
 * actions row (`[data-reply-actions]`). Edit and Delete live there.
 */
export async function moreAction(page: Page, scope: Locator, item: string) {
  await scope.hover();
  await scope.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** Clear through its confirmation dialog, never remembering the ending. */
export async function clearChat(page: Page, confirm = true) {
  await page.getByRole("button", { name: /^Clear/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Clear this chat?" });
  await dialog
    .getByRole("button", { name: confirm ? CLEAR_WITHOUT_REMEMBERING : "Keep chatting" })
    .click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Sets the replies `mock-scripted` gives, in order. The queue is one for the
 * whole mock upstream, so only the serial prompt behavior spec uses it.
 */
export async function scriptReplies(replies: string[]) {
  const response = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/__script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(replies),
  });
  expect(response.status).toBe(204);
}

/**
 * What the mock upstream saw for requests whose last user turn (a card's
 * first, a memory or keeper call's message) contains `text`: without
 * `call`, the chat's and creator's own requests only; with `call`, only
 * fixture calls of that kind (memory, chapter, opening, cast, castSheet).
 */
export async function upstreamRecords(
  text: string,
  call?: MockCall,
): Promise<UpstreamRecordView[]> {
  const query = new URLSearchParams({ contains: text, ...(call === undefined ? {} : { call }) });
  const response = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/__records?${query}`);
  return (await response.json()) as UpstreamRecordView[];
}

/** The hostile URLs the mock upstream was asked for; any entry means untrusted content reached the network. */
export async function beacons(): Promise<string[]> {
  return (await (await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/__beacons`)).json()) as string[];
}

export async function expectUpstreamAborted(text: string) {
  await expect
    .poll(async () => (await upstreamRecords(text)).map((record) => record.aborted))
    .toEqual([true]);
}

/**
 * Every browser storage surface the page can see, serialized for canary
 * search. A surface the browser does not expose reads `"unverified: ..."`,
 * which no expectation of an empty surface accepts (PRINCIPLES.md 1).
 */
export async function browserStorage(page: Page) {
  return await page.evaluate(async () => {
    const unverified = (surface: string) => `unverified: ${surface} is not available`;
    /** Every entry path in the origin private file system, directories included. */
    async function opfsEntries(dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]> {
      const names: string[] = [];
      const iterable = dir as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      };
      for await (const [name, handle] of iterable.entries()) {
        names.push(`${prefix}${name}`);
        if (handle.kind === "directory") {
          names.push(
            ...(await opfsEntries(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)),
          );
        }
      }
      return names;
    }
    const buckets = (navigator as Navigator & { storageBuckets?: { keys(): Promise<string[]> } })
      .storageBuckets;
    const navigation = (
      window as Window & {
        navigation?: { entries(): { url: string | null; getState(): unknown }[] };
      }
    ).navigation;
    return {
      localStorage: Object.entries(localStorage),
      sessionStorage: Object.entries(sessionStorage),
      indexedDB:
        "databases" in indexedDB
          ? (await indexedDB.databases()).map((db) => db.name)
          : unverified("indexedDB.databases()"),
      cookies: document.cookie,
      cacheStorage: await caches.keys(),
      serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
      opfs:
        "getDirectory" in navigator.storage
          ? await opfsEntries(await navigator.storage.getDirectory(), "")
          : unverified("navigator.storage.getDirectory()"),
      storageBuckets:
        buckets === undefined ? unverified("navigator.storageBuckets") : await buckets.keys(),
      url: location.href,
      historyState: JSON.stringify(history.state),
      navigationEntries:
        navigation === undefined
          ? unverified("navigation.entries()")
          : navigation.entries().map((entry) => ({
              url: entry.url,
              state: JSON.stringify(entry.getState()),
            })),
      windowName: window.name,
    };
  });
}
