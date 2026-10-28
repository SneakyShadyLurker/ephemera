import { type BrowserContext, expect, type Locator, type Page } from "@playwright/test";
import { APP_ORIGIN, UPSTREAM_PORT } from "./env.ts";

/*
 * Sign-in expiry (PRINCIPLES.md 2). SWAG with Authelia answers an expired
 * session with a 302 to the portal on every request (docs/ARCHITECTURE.md
 * § Sign-in expiry); these helpers route the app's requests to exactly that,
 * with a mock portal on another origin.
 */

/** The mock upstream stands in for the portal: a real second origin, so the sign-in window can load it. */
const PORTAL = `http://127.0.0.1:${UPSTREAM_PORT}/__portal`;

export const notice = (page: Page) => page.locator("[data-signin]");

/** Each URL the simulated sign-in redirect answered, per browser context. */
const answered = new WeakMap<BrowserContext, Set<string>>();

/** The loads the browser follows by itself, an `<img>`, script, stylesheet or font. */
const SUBRESOURCE_DIRECTIVES = new Set([
  "img-src",
  "script-src",
  "script-src-elem",
  "style-src",
  "style-src-elem",
  "font-src",
]);

/**
 * Whether a policy violation is the browser refusing to follow the sign-in
 * redirect for such a load: the redirect answered `url` in `context`, and the
 * CSP allows only 'self', behind SWAG as here. That refusal is the policy
 * working, so the policy check leaves exactly these out (support/test.ts); a
 * fetch, frame or worker that follows the redirect still fails it.
 */
export const answeredBySignIn = (
  context: BrowserContext,
  directive: string,
  url: string,
): boolean => SUBRESOURCE_DIRECTIVES.has(directive) && answered.get(context)?.has(url) === true;

/**
 * Every API request, static asset and the renewal page of the app server at
 * `origin` answered by the sign-in redirect, as SWAG does for everything
 * behind Authelia.
 */
export async function expire(
  context: BrowserContext,
  origin = APP_ORIGIN,
): Promise<{ chat: () => number }> {
  let chat = 0;
  const urls = answered.get(context) ?? new Set<string>();
  answered.set(context, urls);
  const target = new URL(origin).origin;
  await context.route(
    (url) => url.origin === target && /^\/(api|assets)\/|^\/auth\/renewed$/.test(url.pathname),
    async (route) => {
      const request = route.request();
      urls.add(request.url());
      if (new URL(request.url()).pathname === "/api/chat") chat++;
      await route.fulfill({
        status: 302,
        headers: {
          Location: `${PORTAL}?rd=${encodeURIComponent(request.url())}&rm=${request.method()}`,
        },
      });
    },
  );
  return { chat: () => chat };
}

/**
 * The owner signs in: the session is back, and the portal sends the window to
 * its `rd`. `from`: the notice signed in from, where a modal holds its own;
 * `origin`: the app server the page is on.
 */
export async function signInThroughPortal(
  page: Page,
  context: BrowserContext,
  { from = notice(page), origin = APP_ORIGIN }: { from?: Locator; origin?: string } = {},
) {
  const popupPromise = context.waitForEvent("page");
  await from.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;
  await popup.waitForURL(`${PORTAL}?**`);
  await expect(from).toContainText("Waiting for you to sign in");
  const rd = new URL(popup.url()).searchParams.get("rd") ?? "";
  expect(rd).toBe(`${origin}/auth/renewed`);
  await context.unrouteAll({ behavior: "ignoreErrors" });
  answered.delete(context);
  // As Authelia does after a sign-in; the page closes itself before it finishes loading.
  const closed = popup.waitForEvent("close");
  await popup.evaluate((url) => window.location.assign(url), rd);
  await closed;
}
