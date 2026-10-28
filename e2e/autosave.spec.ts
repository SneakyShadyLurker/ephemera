import type { Page } from "@playwright/test";
import { uniqueName } from "./support/cards.ts";
import {
  createCharacterViaApi,
  createPersonaViaApi,
  createPresetViaApi,
  expectNoOverflow,
  FORM_FACTORS,
  seriousAxeViolations,
} from "./support/entities.ts";
import { expect, test, unsafe } from "./support/test.ts";

test("a successful create with a lost response reconciles later edits before opening the saved sheet", async ({
  page,
}) => {
  const name = uniqueName("Lost response");
  const posts: unknown[] = [];
  await page.route("**/api/personas", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort();
    }
    return route.fallback();
  });
  await page.goto("/personas/new");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await expect(
    page.getByText("Not saved: can't reach Ephemera. Retrying", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Description").fill("Typed after the response was lost.");
  await expect(page).toHaveURL(/\/personas\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  await page.reload();
  await expect(page.getByLabel("Description")).toHaveValue("Typed after the response was lost.");
});

for (const kind of ["character", "persona", "prompt", "sampler"] as const) {
  test(`a failed ${kind} deletion keeps unsaved edits recoverable`, async ({ page }) => {
    const initialName = uniqueName(`Delete ${kind}`);
    let id: string;
    let collection: string;
    let api: string;
    if (kind === "character") {
      id = await createCharacterViaApi(page.request, initialName);
      collection = "characters";
      api = `/api/characters/${id}`;
    } else if (kind === "persona") {
      id = await createPersonaViaApi(page.request, initialName);
      collection = "personas";
      api = `/api/personas/${id}`;
    } else {
      const { presets } = await (await page.request.get(`/api/presets/${kind}`)).json();
      const {
        id: _id,
        revision: _revision,
        createdAt: _created,
        updatedAt: _updated,
        ...preset
      } = presets[0];
      id = await createPresetViaApi(page.request, kind, { ...preset, name: initialName });
      collection = "presets";
      api = `/api/presets/${kind}/${id}`;
    }
    await page.goto(
      `/${collection}/${kind === "prompt" || kind === "sampler" ? `${kind}/` : ""}${id}`,
    );
    let blocked = true;
    await page.route(`**${api}`, (route) => {
      const method = route.request().method();
      if (method === "DELETE")
        return kind === "sampler"
          ? route.fulfill({
              status: 409,
              contentType: "application/json",
              body: '{"error":"last_preset"}',
            })
          : route.abort();
      return blocked && method === "PATCH" ? route.abort() : route.fallback();
    });
    const editedName = `${initialName} edited`;
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(editedName);
    await expect(
      page.getByText("Not saved: can't reach Ephemera. Retrying", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog", { name: `Delete ${editedName}?` })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByRole("alert").filter({ hasText: "Not deleted" })).toBeVisible();
    blocked = false;
    await page
      .getByRole("link", { name: collection[0]?.toUpperCase() + collection.slice(1), exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/${collection}$`));
    const saved = await (await page.request.get(api)).json();
    expect((saved.card ?? saved.persona ?? saved.preset ?? saved).name).toBe(editedName);
  });
}

test("an edit made during a reorder, while a save is in flight, is saved with the new order", async ({
  page,
}) => {
  const id = await createCharacterViaApi(page.request, uniqueName("Reordered"), {
    firstMessage: "Opening.",
    alternateGreetings: ["One", "Two"],
  });
  // The first save is held in flight until the reorder and the next edit have landed.
  let firstSave: () => void = () => {};
  const firstSaveStarted = new Promise<void>((started) => {
    let held = false;
    void page.route(`**/api/characters/${id}`, async (route) => {
      if (route.request().method() === "PATCH" && !held) {
        held = true;
        const release = new Promise<void>((done) => {
          firstSave = done;
        });
        started();
        await release;
      }
      return route.fallback();
    });
  });
  await page.goto(`/characters/${id}`);
  await page.getByLabel("First message", { exact: true }).fill("Opening, edited.");
  await firstSaveStarted;
  await page.getByRole("button", { name: /^Alternate 2:/ }).click();
  await page.getByRole("button", { name: "Move Alternate 2 earlier" }).click();
  await page.getByLabel("First message", { exact: true }).fill("Opening, edited again.");
  await expect(page.getByLabel("First message", { exact: true })).toHaveValue(
    "Opening, edited again.",
  );
  firstSave();
  // Both edits reach the server, and neither overwrites the other (a reorder once ran as a
  // transition, and the later edit was committed and then lost to the older state).
  const card = async () =>
    (
      (await (await page.request.get(`/api/characters/${id}`)).json()) as {
        card: { firstMessage: string; alternateGreetings: string[] };
      }
    ).card;
  await expect
    .poll(
      async () => {
        const { firstMessage, alternateGreetings } = await card();
        return { firstMessage, alternateGreetings };
      },
      { timeout: 15_000 },
    )
    .toEqual({ firstMessage: "Opening, edited again.", alternateGreetings: ["Two", "One"] });
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("a save refused because another tab saved first is resolved by Keep mine or Reload", async ({
  page,
  context,
}) => {
  const id = await createCharacterViaApi(page.request, uniqueName("Two tabs"));
  const other = await context.newPage();
  await page.goto(`/characters/${id}`);
  await other.goto(`/characters/${id}`);
  const description = (tab: typeof page) => tab.getByRole("textbox", { name: "Description" });
  // The visible save state; its screen-reader twin, later in the page, repeats the text.
  const status = (tab: typeof page) =>
    tab.getByText(/^(Saved|Not saved: changed in another tab)$/).first();
  const notice = (tab: typeof page) => tab.locator("[data-conflict]");

  await description(other).fill("The other tab's text.");
  await expect(status(other)).toHaveText("Saved", { timeout: 15_000 });

  // This tab opened the card before that save, so its save is refused and nothing is lost.
  await description(page).fill("This tab's text.");
  await expect(notice(page)).toBeVisible({ timeout: 15_000 });
  await expect(status(page)).toHaveText("Not saved: changed in another tab");
  await expectNoOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await notice(page).getByRole("button", { name: "Keep mine" }).click();
  await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
  await expect(notice(page)).toHaveCount(0);
  const stored = async () =>
    (
      (await (await page.request.get(`/api/characters/${id}`)).json()) as {
        card: { description: string };
      }
    ).card.description;
  expect(await stored()).toBe("This tab's text.");

  // Now the other tab is behind; Reload shows the saved text and drops its edit.
  await description(other).fill("A later edit in the other tab.");
  await expect(notice(other)).toBeVisible({ timeout: 15_000 });
  await notice(other).getByRole("button", { name: "Reload" }).click();
  await expect(notice(other)).toHaveCount(0);
  await expect(description(other)).toHaveValue("This tab's text.");
  expect(await stored()).toBe("This tab's text.");

  // After Reload the tab saves against the new revision.
  await description(other).fill("Saved after the reload.");
  await expect(status(other)).toHaveText("Saved", { timeout: 15_000 });
  expect(await stored()).toBe("Saved after the reload.");
});

/** Saves the character from outside this tab, so this tab's next save is refused as stale. */
async function saveElsewhere(page: Page, id: string) {
  const { revision } = (await (await page.request.get(`/api/characters/${id}`)).json()) as {
    revision: number;
  };
  const response = await page.request.patch(`/api/characters/${id}`, {
    headers: unsafe(),
    data: { description: "Saved by another tab.", revision },
  });
  expect(response.status()).toBe(200);
}

for (const { name, width, height, scheme } of FORM_FACTORS) {
  test(`the conflict notice fits the ${name} layout on a sheet and the lorebook, and passes axe`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const id = await createCharacterViaApi(page.request, uniqueName("Stale"));
    await page.goto(`/characters/${id}`);
    // The sheet has loaded the card, and with it the revision it will save against.
    await expect(page.getByRole("textbox", { name: "Personality" })).toBeVisible();
    await saveElsewhere(page, id);
    await page.getByRole("textbox", { name: "Personality" }).fill("Edited here.");
    const notice = page.locator("[data-conflict]");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    // Keyboard reaches both choices.
    await notice.getByRole("button", { name: "Reload" }).focus();
    await page.keyboard.press("Tab");
    await expect(notice.getByRole("button", { name: "Keep mine" })).toBeFocused();

    await page.goto(`/characters/${id}/lorebook`);
    await page.getByRole("button", { name: "Add the first entry" }).click();
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
    await saveElsewhere(page, id);
    await page.getByRole("textbox", { name: "Title" }).fill("Harbour");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}

test("Reload works on a sheet that just created its character, and keeps the edits if it cannot fetch", async ({
  page,
}) => {
  await page.goto("/characters/new");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(uniqueName("Fresh"));
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const id = page.url().split("/").at(-1) ?? "";
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await saveElsewhere(page, id);
  const personality = page.getByRole("textbox", { name: "Personality" });
  await personality.fill("Edited here.");
  const notice = page.locator("[data-conflict]");
  await expect(notice).toBeVisible({ timeout: 15_000 });

  // The fetch fails: nothing is dropped, and the choice stays.
  await page.route(`**/api/characters/${id}`, (route) =>
    route.request().method() === "GET" ? route.abort() : route.fallback(),
  );
  await notice.getByRole("button", { name: "Reload" }).click();
  await expect(notice.getByRole("button", { name: "Reload" })).toBeEnabled({ timeout: 15_000 });
  await expect(notice).toBeVisible();
  await expect(personality).toHaveValue("Edited here.");

  await page.unroute(`**/api/characters/${id}`);
  await notice.getByRole("button", { name: "Reload" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Saved by another tab.",
  );
  await expect(personality).toHaveValue("");
  await personality.fill("Saved after the reload.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
});
