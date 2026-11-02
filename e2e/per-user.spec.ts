import type {
  APIRequestContext,
  BrowserContext,
  Page,
  PlaywrightWorkerArgs,
  Response,
} from "@playwright/test";
import { tile, uniqueName } from "./support/cards.ts";
import { lastReply, turns, upstreamRecords } from "./support/chat.ts";
import { portraitPng } from "./support/creator-fixtures.ts";
import {
  createCharacterViaApi,
  createPersonaViaApi,
  patchSettings,
  readSettings,
  setPortraitViaApi,
} from "./support/entities.ts";
import { boundHeaders, canary, freshUser, swagHeaders } from "./support/env.ts";
import { appOrigin, expect, test } from "./support/test.ts";

/*
 * Per-user instances (PRINCIPLES.md 2): every Authelia user has their own
 * characters, personas, settings and portraits, in a folder created by their
 * first admitted request. Every test takes users nobody else touched, so
 * parallel tests never share an instance.
 */

/** An API client signed in as `user`; dispose it at the end of the test. */
const asUser = (playwright: PlaywrightWorkerArgs["playwright"], user: string) =>
  playwright.request.newContext({ baseURL: appOrigin(), extraHTTPHeaders: boundHeaders(user) });

async function listed(request: APIRequestContext, kind: "characters" | "personas") {
  const response = await request.get(`/api/${kind}`);
  expect(response.status()).toBe(200);
  return ((await response.json())[kind] as { id: string }[]).map((entry) => entry.id);
}

/** A character of the client's user with a stored portrait; its id and portrait version. */
async function characterWithPortrait(request: APIRequestContext, name: string) {
  const id = await createCharacterViaApi(request, name);
  return { id, portrait: await setPortraitViaApi(request, id, portraitPng(name)) };
}

/** The next response to `method path`, as the tab receives it. */
const responseTo = (page: Page, method: string, path: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === path,
  );

/**
 * An Authelia re-login as `user` in the same browser: from now on every
 * request carries their `Remote-User`. SWAG's headers only, so the tab's own
 * binding goes out as it is; headers, not routing, which would turn the HTTP
 * cache off.
 */
const signInAs = (context: BrowserContext, user: string) =>
  context.setExtraHTTPHeaders(swagHeaders(user));

/**
 * Holds the tab's background reads (late workflow-status reads, refetches)
 * across a same-tab switch, so the request under test is the one that
 * crosses the identity boundary. Routing turns the HTTP cache off, so the
 * release ends it as soon as the refusal is seen, and the test reloads once
 * more with the cache on.
 */
async function holdBackgroundReads(page: Page): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<void>();
  await page.route("**/api/**", async (route) => {
    if (route.request().method() === "GET") await held.promise;
    await route.continue();
  });
  return async () => {
    held.resolve();
    await page.unrouteAll({ behavior: "wait" });
  };
}

/** A reload with the HTTP cache on serves the new user's shell, not a cached one of the earlier user. */
async function reloadsAs(page: Page, user: string) {
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-user", user);
}

/**
 * The refusal of a request bound to the tab's earlier user. Its body is gone
 * with the reload it causes; the tab reloads only for `identity_mismatch`, so
 * the reload that follows says which refusal it was.
 */
function expectIdentityMismatch(response: Response) {
  expect(response.status()).toBe(412);
}

/** Counts dialogs; a beforeunload guard that held up the reload would show here. */
function countDialogs(page: Page): () => number {
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  return () => dialogs;
}

test("a second user sees none of the first user's data, in the app or the API", async ({
  page,
  context,
  playwright,
}) => {
  const [a, b] = [freshUser(), freshUser()];
  const asA = await asUser(playwright, a);
  const asB = await asUser(playwright, b);
  try {
    const name = uniqueName("Isolated");
    const persona = uniqueName("Hidden persona");
    const character = await characterWithPortrait(asA, name);
    const personaId = await createPersonaViaApi(asA, persona);
    await patchSettings(asA, { theme: "dark" });
    const portraitUrl = `/api/characters/${character.id}/portrait/image?size=thumb&v=${character.portrait}`;
    expect(await listed(asA, "characters")).toEqual([character.id]);
    expect((await asA.get(portraitUrl)).status()).toBe(200);

    await signInAs(context, a);
    await page.goto("/characters");
    await expect(tile(page, name)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-user", a);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await signInAs(context, b);
    await page.goto("/characters");
    await expect(page.getByRole("heading", { name: "No characters yet" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-user", b);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await page.goto("/personas");
    await expect(page.getByRole("heading", { name: "No personas yet" })).toBeVisible();
    await expect(page.getByText(persona)).toHaveCount(0);

    expect(await listed(asB, "characters")).toEqual([]);
    expect(await listed(asB, "personas")).toEqual([]);
    expect((await asB.get(`/api/characters/${character.id}`)).status()).toBe(404);
    expect((await asB.get(portraitUrl)).status()).toBe(404);
    expect((await asB.get(`/api/personas/${personaId}`)).status()).toBe(404);
    expect((await readSettings(asB)).theme).toBe("system");
    const shell = await (await asB.get("/")).text();
    expect(shell).toContain(`data-user="${b}"`);
    expect(shell).not.toContain("data-theme");
    // The first user's data is untouched by the second user's visit.
    expect((await readSettings(asA)).theme).toBe("dark");
    expect(await listed(asA, "personas")).toEqual([personaId]);
  } finally {
    await asA.dispose();
    await asB.dispose();
  }
});

test.describe("a same-tab switch to another user", () => {
  test("a settings change is refused and the tab reloads as the new user", async ({
    page,
    context,
    playwright,
  }) => {
    const [a, b] = [freshUser(), freshUser()];
    const asA = await asUser(playwright, a);
    const asB = await asUser(playwright, b);
    try {
      await patchSettings(asA, { theme: "dark" });
      const dialogs = countDialogs(page);
      await signInAs(context, a);
      await page.goto("/settings");
      const theme = page.getByRole("group", { name: "Theme" }).last();
      await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      const release = await holdBackgroundReads(page);
      try {
        await signInAs(context, b);
        const refused = responseTo(page, "PATCH", "/api/settings");
        await theme.getByRole("button", { name: "Light" }).click();
        expectIdentityMismatch(await refused);
        await expect(page.locator("html")).toHaveAttribute("data-user", b);
      } finally {
        await release();
      }
      await reloadsAs(page, b);

      // The new user's own defaults, nothing of the first user's.
      await expect(page.locator("html")).not.toHaveAttribute("data-theme");
      await expect(
        page
          .getByRole("group", { name: "Theme" })
          .last()
          .getByRole("button", { name: "Match system" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect((await readSettings(asB)).theme).toBe("system");
      expect((await readSettings(asA)).theme).toBe("dark");
      expect(dialogs()).toBe(0);
    } finally {
      await asA.dispose();
      await asB.dispose();
    }
  });

  test("a pending sheet autosave is refused and the tab reloads as the new user", async ({
    page,
    context,
    playwright,
  }) => {
    const [a, b] = [freshUser(), freshUser()];
    const asA = await asUser(playwright, a);
    const asB = await asUser(playwright, b);
    try {
      const name = uniqueName("Autosaved");
      const id = await createCharacterViaApi(asA, name);
      const dialogs = countDialogs(page);
      await signInAs(context, a);
      await page.goto(`/characters/${id}`);
      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();

      const typed = `Typed after the switch ${crypto.randomUUID()}`;
      const release = await holdBackgroundReads(page);
      try {
        await signInAs(context, b);
        const refused = responseTo(page, "PATCH", `/api/characters/${id}`);
        await page.getByRole("textbox", { name: "Description" }).fill(typed);
        expectIdentityMismatch(await refused);
        await expect(page.locator("html")).toHaveAttribute("data-user", b);
      } finally {
        await release();
      }
      await reloadsAs(page, b);

      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
      await expect(page.getByText(name)).toHaveCount(0);
      await expect(page.getByText(typed)).toHaveCount(0);
      expect(await listed(asB, "characters")).toEqual([]);
      expect((await asB.get(`/api/characters/${id}`)).status()).toBe(404);
      // The edit reached neither user's database.
      expect((await (await asA.get(`/api/characters/${id}`)).json()).card.description).toBe("");
      expect(dialogs()).toBe(0);
    } finally {
      await asA.dispose();
      await asB.dispose();
    }
  });

  test("a chat generation is refused before the model and the tab reloads as the new user", async ({
    page,
    context,
    playwright,
  }) => {
    const [a, b] = [freshUser(), freshUser()];
    const asA = await asUser(playwright, a);
    const asB = await asUser(playwright, b);
    try {
      const name = uniqueName("Chatted");
      const greeting = `*${name} waves.*`;
      const characterId = await createCharacterViaApi(asA, name, { firstMessage: greeting });
      await patchSettings(asA, { model: "mock-fast", characterId });
      const dialogs = countDialogs(page);
      await signInAs(context, a);
      await page.goto("/");
      await expect(page.getByText(greeting.replaceAll("*", ""))).toBeVisible();
      // The draft's preview goes out as the first user, before the switch.
      const line = canary("in");
      const previewed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/chat/preview" &&
          (response.request().postData() ?? "").includes(line) &&
          response.ok(),
      );
      await page.getByLabel("Message", { exact: true }).fill(line);
      await previewed;

      // A background collection refetch must not reload the tab before the POST
      // reaches the real identity boundary. Release reads once its reload commits.
      const collectionReads = Promise.withResolvers<void>();
      await page.route("**/api/characters", async (route) => {
        if (route.request().method() === "GET") await collectionReads.promise;
        await route.continue();
      });
      try {
        await signInAs(context, b);
        const refused = responseTo(page, "POST", "/api/chat");
        await page.getByLabel("Message", { exact: true }).press("Enter");
        expectIdentityMismatch(await refused);
        await expect(page.locator("html")).toHaveAttribute("data-user", b);
      } finally {
        collectionReads.resolve();
      }

      await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
      await expect(turns(page)).toHaveCount(0);
      await expect(lastReply(page)).toHaveCount(0);
      await expect(page.getByText(name)).toHaveCount(0);
      expect(await upstreamRecords(line)).toEqual([]);
      const settings = await readSettings(asB);
      expect(settings.characterId).toBeNull();
      expect(settings.model).toBeNull();
      expect(await listed(asB, "characters")).toEqual([]);
      expect(dialogs()).toBe(0);
    } finally {
      // Keep interception stable while the new document mounts, then retire the
      // released gate after checking the actual chat, not just the HTML shell.
      await page.unrouteAll({ behavior: "wait" });
      await asA.dispose();
      await asB.dispose();
    }
  });
});

test("a portrait cached for one user is revalidated and refused for the next", async ({
  page,
  context,
  playwright,
}) => {
  const [a, b] = [freshUser(), freshUser()];
  const asA = await asUser(playwright, a);
  try {
    const name = uniqueName("Cached");
    const { id } = await characterWithPortrait(asA, name);
    await signInAs(context, a);
    const cached = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/characters/${id}/portrait/image` &&
        response.status() === 200,
    );
    await page.goto("/characters");
    const art = tile(page, name).locator("img");
    await expect(art).toHaveJSProperty("complete", true);
    expect(await art.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const etag = (await cached).headers().etag ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const src = (await art.getAttribute("src")) ?? "";

    await signInAs(context, b);
    await page.goto("/characters");
    await expect(page.locator("html")).toHaveAttribute("data-user", b);
    const revalidated = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/characters/${id}/portrait/image`,
    );
    const outcome = await page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const image = new Image();
          image.onload = () => resolve("load");
          image.onerror = () => resolve("error");
          image.src = url;
        }),
      src,
    );
    expect(outcome).toBe("error");
    // The browser asked the server with the cached copy's validator, and the server refused.
    const response = await revalidated;
    expect(response.status()).toBe(404);
    expect((await response.request().allHeaders())["if-none-match"]).toBe(etag);
  } finally {
    await asA.dispose();
  }
});
