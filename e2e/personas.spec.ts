import type { Page } from "@playwright/test";
import { imageFile, uniqueName } from "./support/cards.ts";
import { chooseCharacter, chooseModel, messages, send } from "./support/chat.ts";
import {
  closeSession,
  createCharacterViaApi,
  createPersonaViaApi,
  expectNoOverflow,
  openSession,
  seriousAxeViolations,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

const card = (page: Page, name: string) =>
  page.getByRole("list", { name: "Personas" }).getByRole("link", { name, exact: false });

async function moreAction(page: Page, action: string) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

test("a persona is created, edited, given a portrait, duplicated and deleted", async ({ page }) => {
  const name = uniqueName("Aria");
  await page.goto("/personas");
  // The header's button: an empty gallery shows a second one in its empty state.
  await page.locator("header").getByRole("button", { name: "New persona" }).click();
  await expect(page).toHaveURL(/\/personas\/new$/);
  await expect(page.getByText("Add a name to save")).toBeVisible();

  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByLabel("Description").fill("A cartographer's apprentice.");
  await expect(page).toHaveURL(/\/personas\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // The avatar goes through the portrait pipeline and is served for revalidation on every use.
  const portrait = page.waitForResponse((response) =>
    /\/api\/personas\/[^/]+\/portrait\/image\?size=full&v=/.test(response.url()),
  );
  await page.locator('input[type="file"]').setInputFiles(await imageFile("me.png"));
  const served = await portrait;
  expect(served.headers()["cache-control"]).toBe("private, no-cache, no-transform");
  expect(served.headers().etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect(served.headers()["x-content-type-options"]).toBe("nosniff");
  const personaId = page.url().split("/").at(-1) ?? "";

  await page.reload();
  await expect(page.getByLabel("Description")).toHaveValue("A cartographer's apprentice.");

  await moreAction(page, "Duplicate");
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(`${name} (copy)`);
  await expect(page.locator('img[src*="/api/personas/"]')).toBeVisible();

  await page.goto(`/personas/${personaId}`);
  await moreAction(page, "Delete");
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/personas$/);
  await expect(card(page, `${name} (copy)`)).toBeVisible();
  await expect(card(page, name).filter({ hasNotText: "(copy)" })).toHaveCount(0);
  const gone = await page.request.get(`/api/personas/${personaId}/portrait/image`);
  expect(gone.status()).toBe(404);
});

test("a new chat starts as the bound persona, else the default; turns keep their persona", async ({
  page,
}) => {
  const bound = uniqueName("Captain Ines");
  const fallback = uniqueName("Aria");
  const withBinding = uniqueName("Mara");
  const withoutBinding = uniqueName("Wren");
  const boundId = await createPersonaViaApi(page.request, bound);
  const defaultId = await createPersonaViaApi(page.request, fallback);
  await createCharacterViaApi(page.request, withBinding);
  await createCharacterViaApi(page.request, withoutBinding);

  // The default persona is a switch on its sheet.
  await page.goto(`/personas/${defaultId}`);
  await page.getByRole("switch", { name: "Default persona" }).click();
  await expect(page.getByRole("switch", { name: "Default persona" })).toBeChecked();

  // A character goes with a persona through the picker on the persona's sheet.
  await page.goto(`/personas/${boundId}`);
  await page.getByRole("button", { name: "Add character" }).click();
  await page.getByRole("checkbox", { name: withBinding }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Characters" })).toContainText(withBinding);

  await page.goto("/");
  await chooseModel(page, "mock-fast");
  await chooseCharacter(page, withBinding);
  await openSession(page);
  await expect(page.getByRole("combobox", { name: "Persona" })).toContainText(bound);
  await closeSession(page);
  await chooseCharacter(page, withoutBinding);
  await openSession(page);
  await expect(page.getByRole("combobox", { name: "Persona" })).toContainText(fallback);
  await closeSession(page);

  await send(page, canary("in"));
  const firstTurn = messages(page).first();
  await expect(firstTurn).toContainText(fallback);
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    `Write to ${withoutBinding} as ${fallback}`,
  );

  // Changing persona keeps the chat and leaves earlier cues alone.
  await openSession(page);
  const persona = page.getByRole("combobox", { name: "Persona" });
  await persona.click();
  await page.getByRole("option", { name: bound, exact: true }).click();
  await closeSession(page);
  await expect(messages(page)).toHaveCount(2);
  await expect(firstTurn).toContainText(fallback);
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    `Write to ${withoutBinding} as ${bound}`,
  );

  // Leave no default behind for other specs.
  await page.goto(`/personas/${defaultId}`);
  await page.getByRole("switch", { name: "Default persona" }).click();
  await expect(page.getByRole("switch", { name: "Default persona" })).not.toBeChecked();
});

test("Find in the character picker matches a name whatever its accents and case", async ({
  page,
}) => {
  const tag = crypto.randomUUID().slice(0, 6);
  const wanted = `Renée ${tag}`.normalize("NFD");
  const other = `Renata ${tag}`;
  const personaId = await createPersonaViaApi(page.request, uniqueName("Aria"));
  await createCharacterViaApi(page.request, wanted);
  await createCharacterViaApi(page.request, other);
  await page.goto(`/personas/${personaId}`);
  await page.getByRole("button", { name: "Add character" }).click();
  await page.getByRole("searchbox", { name: "Find a character" }).fill(`RENEE ${tag}`);
  await expect(page.getByRole("checkbox", { name: wanted })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: other })).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "Find a character" })
    .fill(`RENÉE ${tag}`.normalize("NFD"));
  await expect(page.getByRole("checkbox", { name: wanted })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: other })).toHaveCount(0);
  await page.getByRole("checkbox", { name: wanted }).click();
  await expect(page.getByRole("checkbox", { name: wanted })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Characters" })).toContainText(wanted);
  await page.reload();
  await expect(page.getByRole("list", { name: "Characters" })).toContainText(wanted);
});

test("Session's 'Always use with' binds the persona to the character", async ({ page }) => {
  const persona = uniqueName("Cartographer");
  const character = uniqueName("Tobias");
  await createPersonaViaApi(page.request, persona);
  await createCharacterViaApi(page.request, character);
  await page.goto("/");
  await chooseCharacter(page, character);
  await openSession(page);
  const combobox = page.getByRole("combobox", { name: "Persona" });
  await combobox.click();
  await page.getByRole("option", { name: persona, exact: true }).click();
  await page.getByRole("checkbox", { name: `Always use with ${character}` }).click();
  await expect(page.getByRole("checkbox", { name: `Always use with ${character}` })).toBeChecked();
  await closeSession(page);

  await page.goto("/personas");
  await expect(card(page, persona)).toContainText(`With ${character}`);
});

for (const { name, width, height, scheme } of [
  { name: "desktop light", width: 1440, height: 900, scheme: "light" },
  { name: "tablet dark", width: 820, height: 1180, scheme: "dark" },
  { name: "phone dark", width: 390, height: 844, scheme: "dark" },
] as const) {
  test(`persona screens fit and pass axe: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const id = await createPersonaViaApi(page.request, uniqueName("Aria"), "Who I am.");
    await page.goto("/personas");
    await expect(page.getByRole("list", { name: "Personas" })).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.goto(`/personas/${id}`);
    await expect(page.getByRole("switch", { name: "Default persona" })).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}

test("a binding that could not be saved from Session says so", async ({ page }) => {
  const persona = uniqueName("Unbound");
  const character = uniqueName("Harbour");
  await createPersonaViaApi(page.request, persona);
  await createCharacterViaApi(page.request, character);
  await page.goto("/");
  await chooseCharacter(page, character);
  await openSession(page);
  await page.getByRole("combobox", { name: "Persona" }).click();
  await page.getByRole("option", { name: persona, exact: true }).click();
  await page.route("**/api/personas/bindings/**", (route) => route.abort());
  await page.getByRole("checkbox", { name: `Always use with ${character}` }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not changed" })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: `Always use with ${character}` }),
  ).not.toBeChecked();
});
