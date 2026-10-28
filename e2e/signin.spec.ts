import {
  browserStorage,
  lastReply,
  openChat,
  send,
  turns,
  upstreamRecords,
} from "./support/chat.ts";
import { portraitPng } from "./support/creator-fixtures.ts";
import {
  createCharacterViaApi,
  expectNoOverflow,
  FORM_FACTORS,
  seriousAxeViolations,
} from "./support/entities.ts";
import { APP_ORIGIN, CANARY_MARKER, canary } from "./support/env.ts";
import { expire, notice, signInThroughPortal } from "./support/signin.ts";
import { expect, test } from "./support/test.ts";

/*
 * Authelia expiry (PRINCIPLES.md 2), with the redirect SWAG sends and a mock
 * portal on another origin (e2e/support/signin.ts).
 */

test.describe("sign-in expiry", () => {
  test("expiry mid-send keeps the chat and stores nothing", async ({ page, context }) => {
    await openChat(page, "mock-fast");
    const start = page.url();
    const entries = await page.evaluate(() => window.history.length);
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await page.locator("[data-reply-actions]").getByRole("button", { name: "New reply" }).click();
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(page.locator("[data-reply-actions]")).toContainText("2 / 2");

    const routes = await expire(context);
    const line = canary("in");
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "waiting");
    await expect(lastReply(page)).toContainText("Not sent yet: waiting for you to sign in.");
    await expect(notice(page)).toContainText("Your sign-in has expired");
    await expect(notice(page)).toContainText("Your message is kept");
    // The owner keeps writing; nothing more can be sent until the session is back.
    const draft = canary("draft");
    await page.getByLabel("Message", { exact: true }).fill(draft);
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(page.url()).toBe(start);

    await signInThroughPortal(page, context);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(lastReply(page)).toContainText(line.replace("-in-", "-out-"));
    await expect(notice(page)).toContainText("Signed in again");
    await expect(notice(page)).toContainText("Your message was sent");
    // Sent once: one refused attempt, then exactly one request upstream.
    expect(routes.chat()).toBe(1);
    expect(await upstreamRecords(line)).toHaveLength(1);
    await expect(turns(page).filter({ hasText: line })).toHaveCount(1);
    // The chat, the draft and the earlier swipes are all still there.
    await expect(turns(page)).toHaveCount(4);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(draft);
    // The notice folds away by itself (4 s, generous bound for a loaded machine).
    await expect(notice(page)).toHaveCount(0, { timeout: 15_000 });
    // Never navigated; nothing reached storage or the URL.
    expect(page.url()).toBe(start);
    expect(await page.evaluate(() => window.history.length)).toBe(entries);
    expect(JSON.stringify(await browserStorage(page))).not.toContain(CANARY_MARKER);
  });

  test("an expired session strands no screen and never reloads the tab", async ({
    page,
    context,
    request,
  }) => {
    // A portrait in the gallery, asked for once the session is gone (below).
    const portrayed = await createCharacterViaApi(
      request,
      `Portrayed ${crypto.randomUUID().slice(0, 6)}`,
    );
    const uploaded = await request.put(`/api/characters/${portrayed}/portrait`, {
      headers: { Origin: APP_ORIGIN },
      multipart: {
        file: { name: "portrait.png", mimeType: "image/png", buffer: portraitPng("expiry") },
      },
    });
    expect(uploaded.ok()).toBe(true);
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    // The page's code has all arrived (app/preload.ts) before the session goes.
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => Object.assign(window, { kept: true }));
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    await expire(context);
    // The gallery shows the list it holds until its refetch comes back refused; on a
    // slow round trip its tiles ask for their portraits first, which the refusal is
    // held for here. The browser refuses to follow those to the portal, which the
    // policy check allows (support/signin.ts).
    const portraitAsked = Promise.withResolvers<boolean>();
    page.on("request", (sent) => {
      if (sent.url().includes(`/api/characters/${portrayed}/portrait/image`)) {
        portraitAsked.resolve(true);
      }
    });
    let asked = false;
    await context.route(`${APP_ORIGIN}/api/characters`, async (route) => {
      asked = await Promise.race([
        portraitAsked.promise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      return route.fallback();
    });
    const main = page.getByRole("navigation", { name: "Main" });
    await main.getByRole("link", { name: "Characters" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Characters" })).toBeVisible();
    await expect.poll(() => asked, { timeout: 15_000 }).toBe(true);
    await expect(notice(page)).toContainText("Your sign-in has expired");
    await main.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await main.getByRole("link", { name: "Chat" }).click();
    await expect(turns(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Prompt" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => (window as { kept?: boolean }).kept)).toBe(true);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    expect(dialogs).toBe(0);
  });

  test("code that fails to load closes the inspector and keeps the chat", async ({
    page,
    context,
  }) => {
    let aborted = 0;
    await context.route(`${APP_ORIGIN}/assets/Inspector-*.js`, (route) => {
      aborted++;
      return route.abort();
    });
    const console: string[] = [];
    page.on("console", (message) => console.push(message.text()));
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await page.evaluate(() => Object.assign(window, { kept: true }));
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await expect.poll(() => aborted).toBeGreaterThan(0);
    // The failure is said where the owner looks, and announced.
    await expect(page.getByRole("status")).toContainText(
      "The prompt inspector didn't load; a reload brings it back and ends the chat.",
    );
    await expect(page.getByRole("dialog", { name: "Prompt" })).toHaveCount(0);
    await expect(turns(page)).toHaveCount(2);
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    // Trying again leaves nothing open behind the scenes: the Session shortcut still works.
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Prompt" })).toHaveCount(0);
    await page.getByLabel("Message", { exact: true }).focus();
    await page.keyboard.press("Control+.");
    await expect(page.getByRole("dialog", { name: "Session" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => (window as { kept?: boolean }).kept)).toBe(true);
    // React's own report would print the error's message; it is silenced (main.tsx).
    expect(console.join("\n")).not.toContain("Inspector-");
  });

  test("a screen whose code cannot load says so and never reloads the tab", async ({
    page,
    context,
  }) => {
    // Hashed chunk names change with every build: the Settings screen's is the one with its copy.
    await context.route(`${APP_ORIGIN}/assets/settings-*.js`, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (body.includes("Starting a chat")) return route.abort();
      return route.fulfill({ response, body });
    });
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await page.evaluate(() => Object.assign(window, { kept: true }));
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    const main = page.getByRole("navigation", { name: "Main" });
    await main.getByRole("link", { name: "Settings" }).click();
    // The browser keeps a failed module fetch until a reload, so nothing offers a futile retry.
    await expect(page.getByRole("alert")).toContainText(
      "a reload brings the screen back and ends the chat",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(main).toBeVisible();
    expect(await page.evaluate(() => (window as { kept?: boolean }).kept)).toBe(true);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    expect(dialogs).toBe(0);
    await main.getByRole("link", { name: "Chat" }).click();
    await expect(turns(page)).toHaveCount(2);
  });

  test("a tab from an earlier build offers a reload and keeps the chat", async ({
    page,
    context,
  }) => {
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await page.evaluate(() => Object.assign(window, { kept: true }));
    const update = page.locator("[data-update-notice]");
    await expect(update).toHaveCount(0);
    // The server was deployed again: its answers name another build than the tab's.
    await context.route(`${APP_ORIGIN}/api/**`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), "x-ephemera-build": "a-later-build" },
      });
    });
    const main = page.getByRole("navigation", { name: "Main" });
    await main.getByRole("link", { name: "Characters" }).click();
    await expect(update).toContainText("Ephemera was updated");
    await expect(update.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(await page.evaluate(() => (window as { kept?: boolean }).kept)).toBe(true);
    await update.getByRole("button", { name: "Dismiss" }).click();
    await expect(update).toHaveCount(0);
    await main.getByRole("link", { name: "Chat" }).click();
    await expect(turns(page)).toHaveCount(2);
    expect(JSON.stringify(await browserStorage(page))).not.toContain(CANARY_MARKER);
  });

  test("a code block whose highlighter cannot load shows as plain text", async ({
    page,
    context,
  }) => {
    let aborted = 0;
    await context.route(`${APP_ORIGIN}/assets/highlighted-body-*.js`, (route) => {
      aborted++;
      return route.abort();
    });
    await openChat(page, "mock-fast");
    // The renderer itself is in the module map before the reply arrives (app/preload.ts).
    await page.waitForLoadState("networkidle");
    await send(page, "See:\n\n```js\nconst tide = 1;\n```");
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect.poll(() => aborted).toBeGreaterThan(0);
    // The fallback shows the raw text, fences included; rendered Markdown never does.
    await expect(lastReply(page)).toContainText("```js");
    await expect(lastReply(page).locator('[data-streamdown="code-block"]')).toHaveCount(0);
    await expect(turns(page)).toHaveCount(2);
    await expect(page.getByText("This screen could not load")).toHaveCount(0);
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  });

  test("the preview follows a draft typed while signed out once the session is back", async ({
    page,
    context,
  }) => {
    await openChat(page, "mock-fast");
    await expire(context);
    // The preview of the first draft is what meets the expired session.
    await page.getByLabel("Message", { exact: true }).fill(canary("draft"));
    await expect(notice(page)).toContainText("Your sign-in has expired");
    const later = canary("draft");
    await page.getByLabel("Message", { exact: true }).fill(later);
    const previewed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/chat/preview" &&
        (response.request().postData() ?? "").includes(later) &&
        response.ok(),
    );
    await signInThroughPortal(page, context);
    await previewed;
  });

  test("a stream running when the session expires keeps going", async ({ page, context }) => {
    await openChat(page, "mock-slow");
    const line = canary("in");
    await send(page, line);
    await expect(lastReply(page)).toContainText("Reply:");
    await expire(context);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
    await expect(lastReply(page)).toContainText(line.replace("-in-", "-out-"));
  });

  test("a retry refused again says so and never loops", async ({ page, context }) => {
    await page.clock.install();
    await openChat(page, "mock-fast");
    const routes = await expire(context);
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "waiting");
    // A renewal is announced, as the tab's own user, but the session is still gone (another
    // window's sign-in failed).
    await page.evaluate(() =>
      new BroadcastChannel("ephemera-signin").postMessage({
        type: "renewed",
        user: document.documentElement.dataset.user,
      }),
    );
    await expect(notice(page)).toContainText("Still signed out");
    await expect(lastReply(page)).toHaveAttribute("data-status", "waiting");
    // One attempt, one retry after the announcement, and nothing on its own after that,
    // past the longest a renewal waits (RENEWAL_PASS_MS, 15 s).
    await page.clock.runFor(16_000);
    expect(routes.chat()).toBe(2);
    await signInThroughPortal(page, context);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  });

  test("sheet edits made while signed out are saved once the session is back", async ({
    page,
    context,
    request,
  }) => {
    const id = await createCharacterViaApi(
      request,
      `Signed out ${crypto.randomUUID().slice(0, 6)}`,
    );
    await page.goto(`/characters/${id}`);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    // The page's code has all arrived (app/preload.ts) before the session goes.
    await page.waitForLoadState("networkidle");
    await expire(context);
    const description = "Written while signed out.";
    await page.getByRole("textbox", { name: "Description" }).fill(description);
    await expect(page.getByText("Not saved: signed out")).toBeVisible();
    await expect(notice(page)).toContainText("Your edits are kept in this tab");
    await signInThroughPortal(page, context);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(notice(page)).toContainText("Your edits are saved.");
    const saved = await request.get(`/api/characters/${id}`);
    expect((await saved.json()).card.description).toBe(description);
  });

  test("an export while signed out keeps the tab where it is", async ({
    page,
    context,
    request,
  }) => {
    const id = await createCharacterViaApi(request, `Export ${crypto.randomUUID().slice(0, 6)}`);
    await page.goto(`/characters/${id}`);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    // The page's code has all arrived (app/preload.ts) before the session goes.
    await page.waitForLoadState("networkidle");
    await expire(context);
    let downloads = 0;
    page.on("download", () => downloads++);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Export as JSON" }).click();
    await expect(notice(page)).toContainText("Your sign-in has expired");
    expect(page.url()).toBe(`${APP_ORIGIN}/characters/${id}`);
    await signInThroughPortal(page, context);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Export as JSON" }).click();
    await download;
    expect(downloads).toBe(1);
  });
});

for (const { name, width, height, scheme } of FORM_FACTORS) {
  test(`the sign-in notice fits the ${name} layout and passes axe`, async ({ page, context }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    await openChat(page, "mock-fast");
    await expire(context);
    await send(page, canary("in"));
    await expect(notice(page)).toContainText("Your sign-in has expired");
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    // Reachable by keyboard, between the thread and the composer.
    await notice(page).getByRole("button", { name: "Sign in" }).focus();
    await page.keyboard.press("Tab");
    const composer = page
      .locator("form")
      .filter({ has: page.getByLabel("Message", { exact: true }) });
    await expect(composer.locator(":focus")).toHaveCount(1);
  });
}
