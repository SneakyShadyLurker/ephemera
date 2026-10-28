import type { Locator, Page } from "@playwright/test";
import { CARD_LIMITS } from "../packages/core/src/card/limits.ts";
import { type CardFile, uniqueName } from "./support/cards.ts";
import { chooseCharacter, lastReply, openChat, send, upstreamRecords } from "./support/chat.ts";
import {
  createCharacterViaApi,
  createLorebookViaApi,
  expectNoOverflow,
  linkLorebookViaApi,
  loreEntry,
  saved,
  seriousAxeViolations,
  setLibraryEntriesViaApi,
  setLorebookViaApi,
} from "./support/entities.ts";
import { notALorebookFile, worldInfoFile } from "./support/lorebook-files.ts";
import { expect, test, unsafe } from "./support/test.ts";

/*
 * The lorebook library: books of their own, persisted per user, linked to
 * characters and read with their chats beside the card's own book. Book
 * data, never chat content; the retention matrix covers what a chat makes
 * of a linked book (retention.spec.ts, rows lore and timed).
 */

const entries = (page: Page) => page.getByRole("list", { name: "Entries in prompt order" });
const library = (page: Page) => page.getByRole("list", { name: "Lorebooks", exact: true });
/** A library book's row: its link, its counts and links, its More menu. */
const bookRow = (page: Page, name: string) =>
  library(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
const linkedBooks = (page: Page) => page.getByRole("list", { name: "Linked lorebooks" });
const linkedCharacters = (page: Page) => page.getByRole("region", { name: "Linked characters" });
const find = (page: Page) => page.getByRole("searchbox", { name: "Find lorebooks and characters" });

/** Imports through the library's file picker, as the owner would. */
async function importLorebooks(page: Page, files: CardFile[]) {
  await page.locator('input[type="file"]').setInputFiles(files);
}

/** A library book as the API returns it. */
async function storedBook(page: Page, id: string) {
  const response = await page.request.get(`/api/lorebooks/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    name: string;
    book: { entries: Record<string, unknown>[]; [key: string]: unknown };
  };
}

/** The ids of the library's books, as the API lists them. */
async function bookIds(page: Page) {
  const response = await page.request.get("/api/lorebooks");
  expect(response.status()).toBe(200);
  const library = (await response.json()) as { lorebooks: { id: string }[] };
  return library.lorebooks.map((book) => book.id);
}

/**
 * Every create the tab sends, by body. The first is stored on the server
 * as sent while its answer never reaches the tab; the second waits for
 * `held` when given; the rest go through.
 */
async function loseFirstCreate(page: Page, held?: Promise<void>) {
  const bodies: { id: string; name: string; book?: unknown }[] = [];
  await page.route("**/api/lorebooks", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const body = request.postDataJSON() as (typeof bodies)[number];
    bodies.push(body);
    if (bodies.length === 1) {
      await page.request.post("/api/lorebooks", { headers: unsafe(), data: body });
      return route.abort();
    }
    if (bodies.length === 2) await held;
    return route.continue();
  });
  return bodies;
}

/** The id the next lorebook import answers with. */
const nextImport = (page: Page) =>
  page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/lorebooks/import" && response.status() === 201,
    )
    .then(async (response) => ((await response.json()) as { id: string }).id);

test("the navigation opens the library; an empty one offers both ways in, and a new book keeps its name, description and entry", async ({
  page,
}) => {
  // The test's user has no lorebook yet, so the library is empty.
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Lorebooks" })
    .click();
  await expect(page).toHaveURL(/\/lorebooks$/);
  await expect(page.getByRole("heading", { level: 1, name: "Lorebooks" })).toBeVisible();
  const empty = page.getByText(/^Background and events for your characters\./).locator("..");
  await expect(empty.getByRole("button", { name: "Import lorebook" })).toBeVisible();
  await empty.getByRole("button", { name: "New lorebook" }).click();

  // The new book opens with its placeholder name selected, ready to be typed over.
  await expect(page).toHaveURL(/\/lorebooks\/[0-9a-f-]{36}$/);
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("New lorebook");
  expect(
    await name.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
  ).toEqual([0, "New lorebook".length]);
  await page.keyboard.type("Harbour almanac");
  await expect(name).toHaveValue("Harbour almanac");
  await expect(linkedCharacters(page)).toContainText("Not linked to a character yet.");

  await page.getByRole("button", { name: "Add a description" }).click();
  const description = page.getByRole("textbox", { name: "Description" });
  await expect(description).toBeFocused();
  await description.fill("Tides and bells of Solm.");
  await page.getByRole("button", { name: "Add the first entry" }).click();
  await expect(page.getByRole("textbox", { name: "Title" })).toBeFocused();
  await page.getByRole("textbox", { name: "Title" }).fill("Spring tide");
  const keywords = page.getByLabel("Keywords", { exact: true });
  await keywords.fill("tide");
  await keywords.press("Enter");
  await page.getByLabel("Text", { exact: true }).fill("The spring tide floods the lower quay.");
  await saved(page);

  await page.reload();
  await expect(name).toHaveValue("Harbour almanac");
  await expect(
    page.getByRole("button", { name: "Edit description: Tides and bells of Solm." }),
  ).toBeVisible();
  await entries(page).getByRole("button", { name: "Edit Spring tide" }).click();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue(
    "The spring tide floods the lower quay.",
  );
  await page.getByRole("link", { name: "Lorebooks" }).first().click();
  await expect(bookRow(page, "Harbour almanac")).toContainText("1 entry, all on");
  await expect(bookRow(page, "Harbour almanac")).toContainText("Not linked");
});

test("a World Info file imports with its report, a non-lorebook is refused with a reason, and an export imports again with the same entries", async ({
  page,
}) => {
  const name = uniqueName("Solm almanac");
  const refused = uniqueName("shopping");
  await page.goto("/lorebooks");
  const imported = nextImport(page);
  await importLorebooks(page, [worldInfoFile(name), notALorebookFile(refused)]);
  const id = await imported;

  const report = page.getByRole("status").filter({ hasText: `Imported ${name}.` });
  await expect(report).toContainText("It is linked to no character yet.");
  await expect(report).toContainText("Some settings changed or were left out.");
  await report.getByRole("button", { name: "Show details" }).click();
  await expect(report.getByRole("heading", { name: "Left out" })).toBeVisible();
  await expect(report).toContainText("automation");
  await expect(
    page.getByRole("status").filter({ hasText: `${refused}.json was not imported` }),
  ).toContainText("it isn't an Ephemera lorebook or a SillyTavern World Info file");

  // The new row says it arrived, with its counts by how entries go in.
  const row = bookRow(page, name);
  await expect(row).toContainText("Imported");
  await expect(row).toContainText("2 entries, all on");
  await expect(row).toContainText("1 on keywords");
  await expect(row).toContainText("1 by chance");
  const book = await storedBook(page, id);
  expect(book.book.entries.map((entry) => entry.comment)).toEqual(["Harbour", "Gull omen"]);

  // Export downloads a native book, which imports again with the same entries.
  await row.getByRole("button", { name: `More for ${name}` }).click();
  const item = page.getByRole("menuitem", { name: "Export as JSON" });
  const href = (await item.getAttribute("href")) ?? "";
  const download = page.waitForEvent("download");
  await item.click();
  // The browser downloads rather than navigates, under the book's own name.
  expect((await download).suggestedFilename()).toBe(`${name}.json`);
  // Playwright sends no owner headers with browser downloads (SWAG adds them in
  // production), so the same link is fetched with them to check what it exports.
  const response = await page.request.get(href);
  expect(response.headers()["content-disposition"]).toContain("attachment;");
  const exported = Buffer.from(await response.body());
  const json = JSON.parse(exported.toString("utf8")) as {
    format: string;
    version: number;
    data: { entries: unknown[] };
  };
  expect(json.format).toBe("ephemera.lorebook");
  expect(json.data.entries).toHaveLength(2);
  const again = nextImport(page);
  await importLorebooks(page, [
    { name: `${name} again.json`, mimeType: "application/json", buffer: exported },
  ]);
  const copy = await storedBook(page, await again);
  expect(copy.book.entries).toEqual(book.book.entries);
});

test("a trim-only lorebook import explains its changes and its native readback stays quiet", async ({
  page,
}) => {
  const name = uniqueName("Trimmed lore");
  const longName = "n".repeat(CARD_LIMITS.shortTextLength + 1);
  const content = "The harbour lamp stays lit.";
  await page.goto("/lorebooks");
  const imported = nextImport(page);
  await importLorebooks(page, [
    {
      name: `${name}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          entries: [
            {
              keys: ["x".repeat(CARD_LIMITS.shortTextLength + 1), "lamp"],
              name: longName,
              content,
            },
          ],
        }),
      ),
    },
  ]);
  const book = await storedBook(page, await imported);
  const report = page.getByRole("status").filter({ hasText: `Imported ${name}.` });
  await expect(report).toContainText("Some settings changed or were left out.");
  await report.getByRole("button", { name: "Show details" }).click();
  await expect(report.getByRole("heading", { name: "Changed", exact: true })).toBeVisible();
  await expect(report).toContainText(
    "Some lorebook keywords were left out to fit the keyword limits.",
  );
  await expect(report).toContainText(
    "Some lorebook entry names were shortened to fit the name limit.",
  );
  await expect(report.getByRole("heading", { name: "Left out", exact: true })).toHaveCount(0);
  expect(book.book.entries).toHaveLength(1);
  expect(book.book.entries[0]).toMatchObject({
    keys: ["lamp"],
    name: longName.slice(0, CARD_LIMITS.shortTextLength),
    content,
  });

  await report.getByRole("button", { name: "Dismiss" }).click();
  await expect(report).toHaveCount(0);

  const nativeName = uniqueName("Native readback");
  const nativeImport = nextImport(page);
  await importLorebooks(page, [
    {
      name: `${nativeName}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ format: "ephemera.lorebook", version: 1, data: book.book }),
      ),
    },
  ]);
  const readback = await storedBook(page, await nativeImport);
  expect(readback.name).toBe(book.name);
  expect(readback.book.entries).toEqual(book.book.entries);
  const quiet = page.getByRole("status").filter({ hasText: `Imported ${book.name}.` });
  await expect(quiet).toBeVisible();
  await expect(quiet).not.toContainText("Some settings changed or were left out.");
  await expect(quiet.getByRole("button", { name: "Show details" })).toHaveCount(0);
});

test("a book linked to two characters from its editor shows on both sheets; unlinking from one keeps it in the library", async ({
  page,
}) => {
  const [ada, bo] = [uniqueName("Ada"), uniqueName("Bo")];
  const adaId = await createCharacterViaApi(page.request, ada);
  const boId = await createCharacterViaApi(page.request, bo);
  const name = uniqueName("Shared lore");
  const id = await createLorebookViaApi(page.request, name, {
    entries: [loreEntry({ comment: "Bells", keys: ["bell"], content: "Bells ring at dusk." })],
  });
  await page.goto(`/lorebooks/${id}`);
  await expect(linkedCharacters(page)).toContainText("Not linked to a character yet.");
  await linkedCharacters(page).getByRole("button", { name: "Manage characters" }).click();
  const picker = page.getByRole("dialog", { name: `Characters linked to ${name}` });
  for (const character of [ada, bo]) {
    await picker.getByRole("searchbox", { name: "Find a character" }).fill(character);
    await picker.getByRole("checkbox", { name: character }).click();
    await expect(picker.getByRole("checkbox", { name: character })).toBeChecked();
  }
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(linkedCharacters(page)).toContainText(
    "Linked to 2 characters. Edits apply to all of them.",
  );
  await page.reload();
  await expect(linkedCharacters(page)).toContainText("Linked to 2 characters.");
  await page.getByRole("link", { name: "Lorebooks" }).first().click();
  await expect(bookRow(page, name)).toContainText("Linked to 2 characters");

  for (const character of [adaId, boId]) {
    await page.goto(`/characters/${character}`);
    await expect(linkedBooks(page).getByRole("link", { name })).toBeVisible();
    await expect(page.locator("#s-lorebook")).toContainText("1 of 8 linked");
  }

  // Bo's sheet unlinks it: gone there, still in the library and on Ada's sheet.
  await page.getByRole("button", { name: `Unlink ${name}` }).click();
  await expect(page.locator("#s-lorebook").getByRole("status")).toHaveText(
    `Unlinked ${name}. It stays in your library.`,
  );
  await expect(linkedBooks(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Link a lorebook" })).toBeEnabled();
  await expect(linkedBooks(page)).toHaveCount(0);
  await page.goto("/lorebooks");
  await expect(bookRow(page, name)).toContainText("Linked to 1 character");
  // Ada has no portrait: her leaf holds her initial, large enough to read and within the leaf.
  const leaf = bookRow(page, name).locator(`[title="${ada}"] > span`).filter({ visible: true });
  await expect(leaf).toHaveText("A");
  const { size, width } = await leaf.evaluate((el) => ({
    size: Number.parseFloat(getComputedStyle(el.firstElementChild ?? el).fontSize),
    width: el.getBoundingClientRect().width,
  }));
  expect(size).toBeGreaterThanOrEqual(10);
  expect(size).toBeLessThanOrEqual(width);
  await page.goto(`/characters/${adaId}`);
  await expect(linkedBooks(page).getByRole("link", { name })).toBeVisible();
});

test("a character takes at most eight books: the ninth link is refused with 8 of 8", async ({
  page,
}) => {
  const character = uniqueName("Collector");
  const characterId = await createCharacterViaApi(page.request, character);
  for (let at = 1; at <= 7; at++) {
    const id = await createLorebookViaApi(page.request, uniqueName(`Volume ${at}`));
    await linkLorebookViaApi(page.request, id, characterId);
  }
  const eighthId = await createLorebookViaApi(page.request, uniqueName("Volume 8"));
  const ninth = uniqueName("Volume 9");
  const ninthId = await createLorebookViaApi(page.request, ninth);

  // The ninth book's picker still offers the character at seven; an eighth link arrives meanwhile.
  await page.goto(`/lorebooks/${ninthId}`);
  await linkedCharacters(page).getByRole("button", { name: "Manage characters" }).click();
  const picker = page.getByRole("dialog", { name: /^Characters linked to / });
  await picker.getByRole("searchbox", { name: "Find a character" }).fill(character);
  const choice = picker.getByRole("checkbox", { name: character });
  await expect(choice).toBeEnabled();
  await linkLorebookViaApi(page.request, eighthId, characterId);
  await choice.click();
  await expect(picker.getByRole("alert")).toHaveText(
    `Not linked: ${character} already has 8 of 8 lorebooks linked.`,
  );
  await expect(choice).not.toBeChecked();
  // The library reloaded with the refusal: the character is full and says so.
  await expect(choice).toBeDisabled();
  await expect(picker).toContainText("8 of 8 lorebooks linked");

  // The sheet says the same: the ninth book cannot be chosen, nor a new one made.
  await page.goto(`/characters/${characterId}`);
  await expect(linkedBooks(page).getByRole("listitem")).toHaveCount(8);
  await expect(page.locator("#s-lorebook")).toContainText("8 of 8 linked");
  await page.getByRole("button", { name: "Link a lorebook" }).click();
  const books8 = page.getByRole("dialog", { name: `Lorebooks linked to ${character}` });
  await books8.getByRole("searchbox", { name: "Find a lorebook" }).fill(ninth);
  await expect(books8.getByRole("checkbox", { name: ninth })).toBeDisabled();
  await expect(books8.getByRole("checkbox", { name: ninth })).not.toBeChecked();
  await expect(books8.getByRole("button", { name: "New lorebook" })).toBeDisabled();
  await expect(books8).toContainText("8 of 8 lorebooks linked");
  // The server refuses it too.
  const refused = await page.request.put(`/api/lorebooks/${ninthId}/characters/${characterId}`, {
    headers: unsafe(),
  });
  expect(refused.status()).toBe(409);
});

test("a linked book's entry reaches the request for its character only, and the inspector names the book and opens it on that entry", async ({
  page,
}) => {
  const linked = uniqueName("Lamplighter");
  const other = uniqueName("Ferryman");
  const linkedId = await createCharacterViaApi(page.request, linked);
  await createCharacterViaApi(page.request, other);
  await setLorebookViaApi(page.request, linkedId, {
    entries: [
      loreEntry({ comment: "Card bell", keys: ["bell"], content: "The card's bell lore." }),
    ],
  });
  const name = uniqueName("Harbour library");
  const libraryLore = "Library lore: the fog horn answers the bell.";
  const id = await createLorebookViaApi(page.request, name, {
    entries: [loreEntry({ comment: "Fog horn", keys: ["bell"], content: libraryLore })],
  });
  await linkLorebookViaApi(page.request, id, linkedId);

  await openChat(page, "mock-fast");
  await chooseCharacter(page, other);
  const unlinkedLine = `The bell rings for the ferry ${crypto.randomUUID()}`;
  await send(page, unlinkedLine);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [unlinked] = await upstreamRecords(unlinkedLine);
  expect(unlinked).toBeDefined();
  expect(JSON.stringify(unlinked?.messages)).not.toContain(libraryLore);

  await chooseCharacter(page, linked, { confirm: true });
  const line = `The bell rings at the lamp ${crypto.randomUUID()}`;
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  const sent = JSON.stringify(record?.messages);
  expect(sent).toContain(libraryLore);
  expect(sent).toContain("The card's bell lore.");

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const section = page.getByRole("dialog", { name: "Prompt" }).getByRole("region", {
    name: "Lorebook",
  });
  await expect(section).toContainText(`${linked}'s 2 lorebooks, read together`);
  await expect(
    section.getByRole("link", { name: `${linked}'s lorebook: edit Card bell` }),
  ).toBeVisible();
  await section.getByRole("link", { name: `${name}: edit Fog horn` }).click();
  await expect(page).toHaveURL(new RegExp(`/lorebooks/${id}\\?entry=0$`));
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Fog horn");
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
});

test("an inspector link follows its entry when the book changed since the reply", async ({
  page,
}) => {
  const character = uniqueName("Bellringer");
  const characterId = await createCharacterViaApi(page.request, character);
  const name = uniqueName("Tower library");
  const horn = loreEntry({ comment: "Fog horn", keys: ["bell"], content: "The horn answers." });
  const id = await createLorebookViaApi(page.request, name, { entries: [horn] });
  await linkLorebookViaApi(page.request, id, characterId);
  // The inspector names an entry's book once more than one was read: the card has one too.
  await setLorebookViaApi(page.request, characterId, {
    entries: [loreEntry({ comment: "Card bell", keys: ["bell"], content: "The card's bell." })],
  });

  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  await send(page, `The bell rings in the tower ${crypto.randomUUID()}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  // The report names the entry at index 0; an entry added before it moves it to 1.
  await setLibraryEntriesViaApi(page.request, id, [
    loreEntry({ comment: "Harbour chain", keys: ["chain"], content: "A chain bars the harbour." }),
    horn,
  ]);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const section = page.getByRole("dialog", { name: "Prompt" }).getByRole("region", {
    name: "Lorebook",
  });
  await section.getByRole("link", { name: `${name}: edit Fog horn` }).click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Fog horn");
  await expect(page).toHaveURL(new RegExp(`/lorebooks/${id}\\?entry=1$`));
});

test("a duplicated character's sheet lists the books it kept", async ({ page }) => {
  const character = uniqueName("Warden");
  const characterId = await createCharacterViaApi(page.request, character);
  const name = uniqueName("Gate library");
  const id = await createLorebookViaApi(page.request, name, {
    entries: [loreEntry({ comment: "Gate", keys: ["gate"], content: "The gate closes at dusk." })],
  });
  await linkLorebookViaApi(page.request, id, characterId);

  // Through the library first, so its list is already in the tab's memory.
  await page.goto("/lorebooks");
  await expect(bookRow(page, name)).toContainText("Linked to 1 character");
  await page.getByRole("link", { name: "Characters" }).first().click();
  await page.getByRole("link", { name: character }).first().click();
  await expect(page.getByRole("list", { name: "Linked lorebooks" })).toContainText(name);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    `${character} (copy)`,
  );
  await expect(page.getByRole("list", { name: "Linked lorebooks" })).toContainText(name);
});

test("by chance at 100% is sent and at 0% is not, and an entry that loses its event pool to a prioritized one is left out and says which pool", async ({
  page,
}) => {
  const character = uniqueName("Augur");
  const characterId = await createCharacterViaApi(page.request, character);
  const name = uniqueName("Omens");
  const pooled = (comment: string, settings: object) =>
    loreEntry({ comment, keys: ["storm"], content: `${comment} lore.`, settings });
  const id = await createLorebookViaApi(page.request, name, {
    entries: [
      loreEntry({
        comment: "Sure omen",
        constant: true,
        content: "Sure omen lore.",
        settings: { useProbability: true, probability: 100 },
      }),
      loreEntry({
        comment: "Never omen",
        constant: true,
        content: "Never omen lore.",
        settings: { useProbability: true, probability: 0 },
      }),
      pooled("Thunder", { poolNames: ["Weather"], poolWeight: 1 }),
      pooled("Lightning", { poolNames: ["Weather"], poolPrioritized: true }),
    ],
  });
  await linkLorebookViaApi(page.request, id, characterId);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  const line = `A storm gathers ${crypto.randomUUID()}`;
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  const sent = JSON.stringify(record?.messages);
  expect(sent).toContain("Sure omen lore.");
  expect(sent).toContain("Lightning lore.");
  expect(sent).not.toContain("Never omen lore.");
  expect(sent).not.toContain("Thunder lore.");

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const section = page.getByRole("dialog", { name: "Prompt" }).getByRole("region", {
    name: "Lorebook",
  });
  const list = section.getByRole("list", { name: "Lorebook entries sent" });
  await expect(list).toContainText("Sure omen");
  await expect(list).toContainText("Lightning");
  const others = section.getByRole("button", { name: /^Other entries/ });
  await expect(others).toHaveAccessibleName(
    "Other entries: 1 left out by chance, 1 left out by an event pool",
  );
  await others.click();
  await expect(section.getByText("Never omen, chance did not pass (0%)")).toBeVisible();
  await expect(section.getByText("Thunder, pool Weather went to Lightning")).toBeVisible();
});

test("in a library book, By chance and a keyword entry's chance show their markers in the list", async ({
  page,
}) => {
  const name = uniqueName("Chances");
  const id = await createLorebookViaApi(page.request, name, {
    entries: [
      loreEntry({ comment: "Gull", keys: ["gull"], content: "Gull lore." }),
      loreEntry({ comment: "Fog", keys: ["fog"], content: "Fog lore." }),
    ],
  });
  await page.goto(`/lorebooks/${id}?entry=0`);
  const group = page.getByRole("group", { name: "Goes in" });
  await group.getByRole("button", { name: "By chance", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Chance in percent" })).toHaveValue("10");
  await saved(page);
  await expect(entries(page).getByRole("button", { name: "Edit Gull" })).toContainText(
    "By chance, 10%",
  );

  await entries(page).getByRole("button", { name: "Edit Fog" }).click();
  await page.getByRole("button", { name: "When it goes in", exact: true }).click();
  const chance = page
    .locator("section[aria-labelledby='entry-title']")
    .getByRole("textbox", { name: "Chance in percent" });
  await chance.fill("40");
  await chance.press("Tab");
  await expect(
    page.getByRole("button", { name: "When it goes in", exact: true }),
  ).toHaveAccessibleDescription(/^40% chance when it matches/);
  await expect(entries(page).getByRole("button", { name: "Edit Fog" })).toContainText("40% chance");
  await expect
    .poll(async () => (await storedBook(page, id)).book.entries.map((entry) => entry.settings), {
      timeout: 15_000,
    })
    .toEqual([
      expect.objectContaining({ useProbability: true, probability: 10 }),
      expect.objectContaining({ useProbability: true, probability: 40 }),
    ]);
  await page.goto("/lorebooks");
  await expect(bookRow(page, name)).toContainText("1 on keywords");
  await expect(bookRow(page, name)).toContainText("1 by chance");
});

test("deleting a book names the characters that lose it and takes it off their sheets", async ({
  page,
}) => {
  const [ada, bo] = [uniqueName("Ada"), uniqueName("Bo")];
  const adaId = await createCharacterViaApi(page.request, ada);
  const boId = await createCharacterViaApi(page.request, bo);
  const name = uniqueName("Doomed lore");
  const id = await createLorebookViaApi(page.request, name);
  await linkLorebookViaApi(page.request, id, adaId);
  await linkLorebookViaApi(page.request, id, boId);
  await page.goto(`/characters/${adaId}`);
  await expect(linkedBooks(page).getByRole("link", { name })).toBeVisible();

  await page.goto("/lorebooks");
  await bookRow(page, name)
    .getByRole("button", { name: `More for ${name}` })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
  await expect(dialog).toContainText(`2 characters lose it: ${ada} and ${bo}.`);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Deleted ${name}.` })).toBeVisible();
  await expect(bookRow(page, name)).toHaveCount(0);
  expect((await page.request.get(`/api/lorebooks/${id}`)).status()).toBe(404);

  for (const character of [adaId, boId]) {
    await page.goto(`/characters/${character}`);
    await expect(page.getByRole("button", { name: "Link a lorebook" })).toBeEnabled();
    await expect(page.getByRole("link", { name })).toHaveCount(0);
  }
});

test("Copy to library makes an independent copy of a card's book, linked to no one", async ({
  page,
}) => {
  const character = uniqueName("Mira");
  const characterId = await createCharacterViaApi(page.request, character);
  await setLorebookViaApi(page.request, characterId, {
    entries: [loreEntry({ comment: "Lamp", keys: ["lamp"], content: "The lamp burns whale oil." })],
  });
  await page.goto("/lorebooks");
  await find(page).fill(character);
  const cards = page.getByRole("list", { name: "Lorebooks in character cards" });
  await expect(cards.getByRole("link", { name: `${character}'s lorebook` })).toBeVisible();
  await cards.getByRole("button", { name: `Copy to library: ${character}'s lorebook` }).click();

  await expect(page).toHaveURL(/\/lorebooks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("status").first()).toContainText(
    "Copied to library. The original stays in the character's card.",
  );
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    `${character}'s lorebook`,
  );
  await expect(linkedCharacters(page)).toContainText("Not linked to a character yet.");
  await entries(page).getByRole("button", { name: "Edit Lamp" }).click();
  await page.getByLabel("Text", { exact: true }).fill("The copy's lamp burns tallow.");
  const copyId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect
    .poll(async () => (await storedBook(page, copyId)).book.entries[0]?.content, {
      timeout: 15_000,
    })
    .toBe("The copy's lamp burns tallow.");

  // The card keeps its own text, and the character carries no linked book.
  const card = (await (await page.request.get(`/api/characters/${characterId}`)).json()) as {
    card: { lorebook?: { entries: { content: string }[] } };
  };
  expect(card.card.lorebook?.entries[0]?.content).toBe("The lamp burns whale oil.");
  await page.goto(`/characters/${characterId}`);
  await expect(page.getByRole("button", { name: "Link a lorebook" })).toBeEnabled();
  await expect(linkedBooks(page)).toHaveCount(0);
});

test("a New whose answer was lost is sent again under its id, New waits for it, and one book is made", async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bodies = await loseFirstCreate(page, held);
  try {
    await page.goto("/lorebooks");
    const before = await bookIds(page);
    const create = page.getByRole("button", { name: "New lorebook" }).first();
    await create.click();
    await expect(page.getByRole("alert").filter({ hasText: "Not created:" })).toBeVisible();
    // The server stored it; the tab never heard.
    expect(await bookIds(page)).toHaveLength(before.length + 1);

    await create.click();
    await expect(create).toBeDisabled();
    await create.click({ force: true });
    release();
    await expect(page).toHaveURL(new RegExp(`/lorebooks/${bodies[0]?.id}$`));
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
      "New lorebook",
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await bookIds(page)).toHaveLength(before.length + 1);
  } finally {
    release();
  }
});

test("a copy whose answer was lost is sent again with the book first read and its id, making one copy", async ({
  page,
}) => {
  const character = uniqueName("Tamsin");
  const characterId = await createCharacterViaApi(page.request, character);
  await setLorebookViaApi(page.request, characterId, {
    entries: [loreEntry({ comment: "Lamp", keys: ["lamp"], content: "The lamp burns whale oil." })],
  });
  const bodies = await loseFirstCreate(page);
  await page.goto("/lorebooks");
  const before = await bookIds(page);
  await find(page).fill(character);
  const copy = page.getByRole("button", { name: `Copy to library: ${character}'s lorebook` });
  await copy.click();
  await expect(page.getByRole("alert").filter({ hasText: "Not copied:" })).toBeVisible();

  // The card changes meanwhile; the retry is the same copy, not a second one of the new text.
  await setLorebookViaApi(page.request, characterId, {
    entries: [loreEntry({ comment: "Lamp", keys: ["lamp"], content: "The lamp burns tallow." })],
  });
  await copy.click();
  await expect(page).toHaveURL(new RegExp(`/lorebooks/${bodies[0]?.id}$`));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(await bookIds(page)).toHaveLength(before.length + 1);
  const stored = await storedBook(page, bodies[0]?.id ?? "");
  expect(stored.name).toBe(`${character}'s lorebook`);
  expect(stored.book.entries[0]?.content).toBe("The lamp burns whale oil.");
});

test("a sheet's New lorebook whose answer was lost is sent again under its id, making one book and one link", async ({
  page,
}) => {
  const character = uniqueName("Corwen");
  const characterId = await createCharacterViaApi(page.request, character);
  const bodies = await loseFirstCreate(page);
  const before = await bookIds(page);
  await page.goto(`/characters/${characterId}`);
  const link = page.getByRole("button", { name: "Link a lorebook" });
  await expect(link).toBeEnabled();
  await link.click();
  const picker = page.getByRole("dialog", { name: `Lorebooks linked to ${character}` });
  const create = picker.getByRole("button", { name: "New lorebook" });
  await create.click();
  await expect(picker.getByRole("alert").filter({ hasText: "Not created:" })).toBeVisible();
  // The server stored it; the tab never heard, and nothing is linked yet.
  expect(await bookIds(page)).toHaveLength(before.length + 1);

  await create.click();
  await expect(page.locator("#s-lorebook").getByRole("status")).toHaveText(
    `Created a lorebook and linked it to ${character}.`,
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(await bookIds(page)).toHaveLength(before.length + 1);
  await page.reload();
  await expect(linkedBooks(page).getByRole("listitem")).toHaveCount(1);
  await expect(linkedBooks(page).getByRole("link", { name: "New lorebook" })).toHaveAttribute(
    "href",
    new RegExp(`/lorebooks/${bodies[0]?.id}$`),
  );
  await expect(page.locator("#s-lorebook")).toContainText("1 of 8 linked");
});

test("a copy the server refused reads the card again on retry, under a new id, making one copy", async ({
  page,
}) => {
  const character = uniqueName("Odile");
  const characterId = await createCharacterViaApi(page.request, character);
  await setLorebookViaApi(page.request, characterId, {
    entries: [loreEntry({ comment: "Lamp", keys: ["lamp"], content: "Too much lamp oil." })],
  });
  // The first create is refused as too large and stores nothing; the rest go through.
  const bodies: { id: string }[] = [];
  await page.route("**/api/lorebooks", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON() as { id: string });
    if (bodies.length === 1) return route.fulfill({ status: 413, json: { error: "too_large" } });
    return route.continue();
  });
  await page.goto("/lorebooks");
  const before = await bookIds(page);
  await find(page).fill(character);
  const copy = page.getByRole("button", { name: `Copy to library: ${character}'s lorebook` });
  await copy.click();
  await expect(page.getByRole("alert").filter({ hasText: "Not copied:" })).toHaveText(
    "Not copied: it is larger than Ephemera allows.",
  );

  // The owner shortens the card's book; the retry copies that, not the refused one.
  await setLorebookViaApi(page.request, characterId, {
    entries: [loreEntry({ comment: "Lamp", keys: ["lamp"], content: "The lamp burns tallow." })],
  });
  await copy.click();
  await expect.poll(() => bodies.length).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/lorebooks/${bodies[1]?.id}$`));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.id).not.toBe(bodies[0]?.id);
  expect(await bookIds(page)).toHaveLength(before.length + 1);
  const stored = await storedBook(page, bodies[1]?.id ?? "");
  expect(stored.book.entries[0]?.content).toBe("The lamp burns tallow.");
});

test("a sheet's New whose link failed, then linked from the picker, makes another book on the next New", async ({
  page,
}) => {
  const character = uniqueName("Ysolde");
  const characterId = await createCharacterViaApi(page.request, character);
  const created: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/lorebooks")
      created.push((request.postDataJSON() as { id: string }).id);
  });
  // The first link the tab sends fails; the rest go through.
  let links = 0;
  await page.route("**/api/lorebooks/*/characters/*", (route) =>
    route.request().method() === "PUT" && ++links === 1
      ? route.fulfill({ status: 500 })
      : route.continue(),
  );
  const before = await bookIds(page);
  await page.goto(`/characters/${characterId}`);
  const link = page.getByRole("button", { name: "Link a lorebook" });
  await expect(link).toBeEnabled();
  await link.click();
  const picker = page.getByRole("dialog", { name: `Lorebooks linked to ${character}` });
  const create = picker.getByRole("button", { name: "New lorebook" });
  await create.click();
  await expect(picker.getByRole("alert").filter({ hasText: "Not linked:" })).toBeVisible();

  // The book was made; the owner links it by hand.
  const orphan = picker.getByRole("checkbox", { name: "New lorebook" });
  await orphan.click();
  await expect(orphan).toBeChecked();
  await expect(page.locator("#s-lorebook")).toContainText("1 of 8 linked");
  await create.click();
  await expect(page.locator("#s-lorebook").getByRole("status")).toHaveText(
    `Created a lorebook and linked it to ${character}.`,
  );
  expect(created).toHaveLength(2);
  expect(created[1]).not.toBe(created[0]);
  expect(await bookIds(page)).toHaveLength(before.length + 2);
  await page.reload();
  await expect(linkedBooks(page).getByRole("listitem")).toHaveCount(2);
  await expect(page.locator("#s-lorebook")).toContainText("2 of 8 linked");
});

test("Find narrows the library by book name and by a linked character's name, and says when nothing matches", async ({
  page,
}) => {
  const tag = crypto.randomUUID().slice(0, 6);
  const keeper = `Navigator ${tag}`;
  const keeperId = await createCharacterViaApi(page.request, keeper);
  await setLorebookViaApi(page.request, keeperId, {
    entries: [loreEntry({ comment: "Stars", keys: ["star"] })],
  });
  const [charts, tides] = [`Star charts ${tag}`, `Tide tables ${tag}`];
  const chartsId = await createLorebookViaApi(page.request, charts);
  await createLorebookViaApi(page.request, tides);
  await linkLorebookViaApi(page.request, chartsId, keeperId);
  await page.goto("/lorebooks");

  await find(page).fill(`tide tables ${tag}`);
  await expect(library(page).getByRole("link")).toHaveCount(1);
  await expect(bookRow(page, tides)).toBeVisible();
  await expect(page.getByRole("list", { name: "Lorebooks in character cards" })).toHaveCount(0);

  // A character's name finds the books linked to it and the book in its card.
  await find(page).fill(keeper);
  await expect(library(page).getByRole("link")).toHaveCount(1);
  await expect(bookRow(page, charts)).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Lorebooks in character cards" })
      .getByRole("link", { name: `${keeper}'s lorebook` }),
  ).toBeVisible();

  await find(page).fill(`nothing at all ${tag}`);
  await expect(page.getByText("No lorebook or character matches.")).toBeVisible();
  await expect(library(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Clear find" }).click();
  await expect(find(page)).toHaveValue("");
  await expect(bookRow(page, charts)).toBeVisible();
  await expect(bookRow(page, tides)).toBeVisible();
});

test.describe("by keyboard", () => {
  /** Escape closes `surface`, and focus goes back to `opener`. */
  const dismiss = async (page: Page, surface: Locator, opener: Locator) => {
    await page.keyboard.press("Escape");
    await expect(surface).toHaveCount(0);
    await expect(opener).toBeFocused();
  };

  test("the row menu and the delete dialog open and close by keyboard, focus back on the menu's button", async ({
    page,
  }) => {
    const name = uniqueName("Keyed lore");
    await createLorebookViaApi(page.request, name);
    await page.goto("/lorebooks");
    const more = bookRow(page, name).getByRole("button", { name: `More for ${name}` });
    await more.focus();
    await page.keyboard.press("Enter");
    // Base UI honors the popup's explicit label.
    const menu = page.getByRole("menu", { name: `Actions for ${name}` });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await dismiss(page, menu, more);

    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await dismiss(page, dialog, more);
    await expect(bookRow(page, name)).toBeVisible();
  });

  test("the pickers and the editor's actions open and close by keyboard, focus back on their triggers", async ({
    page,
  }) => {
    const character = uniqueName("Keyed keeper");
    const characterId = await createCharacterViaApi(page.request, character);
    const name = uniqueName("Keyed book");
    const id = await createLorebookViaApi(page.request, name);
    await page.goto(`/lorebooks/${id}`);

    const manage = linkedCharacters(page).getByRole("button", { name: "Manage characters" });
    // It waits for the library and the characters to load.
    await expect(manage).toBeEnabled();
    await manage.focus();
    await page.keyboard.press("Enter");
    const characters = page.getByRole("dialog", { name: `Characters linked to ${name}` });
    await expect(characters).toBeVisible();
    await expect(characters.getByRole("searchbox", { name: "Find a character" })).toBeFocused();
    await page.keyboard.type(character);
    await expect(characters.getByRole("searchbox", { name: "Find a character" })).toHaveValue(
      character,
    );
    await page.keyboard.press("Tab");
    await expect(characters.getByRole("checkbox", { name: character })).toBeFocused();
    await page.keyboard.press(" ");
    await expect(characters.getByRole("checkbox", { name: character })).toBeChecked();
    await dismiss(page, characters, manage);
    await expect(linkedCharacters(page)).toContainText("Linked to 1 character.");

    const actions = page.getByRole("button", { name: "More actions" });
    await actions.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Lorebook actions" });
    await expect(menu).toBeVisible();
    await dismiss(page, menu, actions);

    await page.goto(`/characters/${characterId}`);
    const link = page.getByRole("button", { name: "Link a lorebook" });
    // It waits for the library to load.
    await expect(link).toBeEnabled();
    await link.focus();
    await page.keyboard.press("Enter");
    const books = page.getByRole("dialog", { name: `Lorebooks linked to ${character}` });
    await expect(books).toBeVisible();
    await expect(books.getByRole("searchbox", { name: "Find a lorebook" })).toBeFocused();
    await dismiss(page, books, link);
  });
});

for (const { name, width, height, scheme } of [
  { name: "desktop", width: 1440, height: 900, scheme: "light" },
  { name: "tablet", width: 820, height: 1180, scheme: "dark" },
  { name: "phone", width: 390, height: 844, scheme: "dark" },
] as const) {
  test(`the library and a book fit the ${name} layout and pass axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const character = uniqueName("Fitted keeper");
    const characterId = await createCharacterViaApi(page.request, character);
    await setLorebookViaApi(page.request, characterId, {
      entries: [loreEntry({ comment: "Lamp", keys: ["lamp"] })],
    });
    const book = uniqueName("A rather long library lorebook name that must truncate gracefully");
    const id = await createLorebookViaApi(page.request, book, {
      description: "Tides, bells and the lamp room.",
      entries: [
        loreEntry({ comment: "Bell", keys: ["bell"] }),
        loreEntry({ comment: "Tide", constant: true }),
        loreEntry({
          comment: "Omen",
          keys: ["omen"],
          settings: { useProbability: true, probability: 25, poolNames: ["Omens"] },
        }),
      ],
    });
    await linkLorebookViaApi(page.request, id, characterId);

    await page.goto("/lorebooks");
    await find(page).fill(character);
    await expect(bookRow(page, book)).toContainText("Linked to 1 character");
    await expect(
      page.getByRole("button", { name: `Copy to library: ${character}'s lorebook` }),
    ).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await page.goto(`/lorebooks/${id}`);
    await expect(entries(page).getByRole("button", { name: "Edit Omen" })).toBeVisible();
    await expect(linkedCharacters(page)).toContainText("Linked to 1 character.");
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await entries(page).getByRole("button", { name: "Edit Omen" }).click();
    await page.getByRole("button", { name: "Event pool", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Prioritize this entry" })).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await page.goto(`/characters/${characterId}`);
    await expect(linkedBooks(page)).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}
