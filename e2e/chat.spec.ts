import { clearChat, lastReply, messages, openChat, send } from "./support/chat.ts";
import { APP_ORIGIN, canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

test("the page opts out of translation and autocomplete", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("translate", "no");
  await expect(page.locator('meta[name="google"]')).toHaveAttribute("content", "notranslate");
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute("autocomplete", "off");
});

test("an upstream error shows a failed reply without upstream text", async ({ page }) => {
  const input = canary("in");
  await openChat(page, "mock-error");
  await send(page, input);
  await expect(lastReply(page)).toHaveAttribute("data-status", "failed");
  await expect(lastReply(page).locator("[data-prose]")).toHaveText("Reply interrupted.");
});

test("Clear asks first, keeps the chat when declined, then empties it", async ({ page }) => {
  const input = canary("in");
  await openChat(page, "mock-slow");
  await send(page, input);
  await expect(lastReply(page)).toContainText("Reply:");

  await clearChat(page, false);
  await expect(messages(page)).toHaveCount(2);

  await clearChat(page);
  await expect(messages(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear" })).toBeDisabled();
});

test("leaving a non-empty chat asks for confirmation", async ({ page }) => {
  await openChat(page, "mock-fast");
  await page.getByLabel("Message", { exact: true }).fill(canary("draft"));
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  expect((await dialog).type()).toBe("beforeunload");
  await (await dialog).dismiss();
});

test("pagehide empties the chat, DOM included, before the page is hidden", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await page.getByLabel("Message", { exact: true }).fill(canary("draft"));
  // Counted in the same task as the event: a back/forward cache snapshot taken
  // right after pagehide must already be empty.
  const after = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    return {
      messages: document.querySelectorAll("[data-message]").length,
      draft: document.querySelector("textarea")?.value,
    };
  });
  expect(after).toEqual({ messages: 0, draft: "" });
});

test("every response is no-store and every request stays on the app origin", async ({ page }) => {
  const responses: { url: string; cacheControl: string | undefined; etag: string | undefined }[] =
    [];
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", async (response) => {
    const headers = await response.allHeaders();
    responses.push({
      url: response.url(),
      cacheControl: headers["cache-control"],
      etag: headers.etag,
    });
  });
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  const kinds = responses.map((r) => new URL(r.url).pathname);
  expect(kinds).toContain("/");
  expect(kinds).toContain("/api/models");
  expect(kinds).toContain("/api/chat");
  expect(kinds.some((path) => path.endsWith(".js"))).toBe(true);
  expect(kinds.some((path) => path.endsWith(".css"))).toBe(true);
  // The one exception (PRINCIPLES.md 1): a portrait addressed by its current version,
  // revalidated on every use against a validator bound to the requester.
  const portrait = /^\/api\/(characters|personas)\/[^/]+\/portrait\/image$/;
  for (const response of responses) {
    const url = new URL(response.url);
    const cacheable = portrait.test(url.pathname) && url.searchParams.has("v");
    expect(response, response.url).toMatchObject(
      cacheable
        ? {
            cacheControl: "private, no-cache, no-transform",
            etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
          }
        : { cacheControl: "no-store, no-transform" },
    );
  }
  for (const url of requests) expect(new URL(url).origin).toBe(APP_ORIGIN);
});
