import type { Page } from "@playwright/test";
import { importCards, jsonCard, uniqueName, v3 } from "./support/cards.ts";
import { chooseCharacter, lastReply, openChat, send, upstreamRecords } from "./support/chat.ts";
import {
  choose,
  createCharacterViaApi,
  expectNoOverflow,
  loreEntry,
  saved,
  seriousAxeViolations,
  setLorebookViaApi,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

const card = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/characters/${id}`)).json()) as {
    card: { lorebook?: { entries: Record<string, unknown>[]; [key: string]: unknown } };
  };

const entries = (page: Page) => page.getByRole("list", { name: "Entries in prompt order" });

test("the owner creates a lorebook from the sheet and edits an entry that autosaves", async ({
  page,
}) => {
  const name = uniqueName("Keeper");
  const id = await createCharacterViaApi(page.request, name);
  await page.goto(`/characters/${id}`);
  await page.getByRole("link", { name: "Create lorebook" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Lorebook" })).toBeVisible();
  await page.getByRole("button", { name: "Add the first entry" }).click();

  await expect(page.getByRole("textbox", { name: "Title" })).toBeFocused();
  await page.getByRole("textbox", { name: "Title" }).fill("The Grey Lantern");
  const keywords = page.getByLabel("Keywords", { exact: true });
  await keywords.fill("lantern");
  await keywords.press("Enter");
  await keywords.fill("grey light, lamp room");
  await keywords.press(",");
  await keywords.fill("/bells? (?:toll|ring)s?/i");
  await keywords.press("Enter");
  await page.getByLabel("Text", { exact: true }).fill("The lamp {{char}} trims by hand.");
  await page.getByRole("button", { name: "Where it goes" }).click();
  await choose(page, "Placement", "After the character");
  const order = page.getByRole("textbox", { name: "Order" });
  await order.fill("40");
  await order.press("Tab");
  await page
    .getByRole("group", { name: "Goes in" })
    .getByRole("button", { name: "Always", exact: true })
    .click();
  await saved(page);

  const book = (await card(page, id)).card.lorebook;
  expect(book?.entries).toHaveLength(1);
  expect(book?.entries[0]).toMatchObject({
    comment: "The Grey Lantern",
    keys: ["lantern", "grey light", "lamp room", "/bells? (?:toll|ring)s?/i"],
    content: "The lamp {{char}} trims by hand.",
    settings: { placement: "after" },
    insertionOrder: 40,
    constant: true,
    enabled: true,
  });
  // The row stands after the character, marked always on.
  await expect(entries(page).getByRole("button", { name: "Edit The Grey Lantern" })).toContainText(
    "Always on",
  );

  // The sheet summarizes it.
  await page.getByRole("link", { name: name }).first().click();
  await expect(page.locator("#s-lorebook")).toContainText(
    "1 entry, 1 enabled, 1 of them always on",
  );
});

test("the list is one tab stop: arrows move, Space switches an entry, Enter opens it", async ({
  page,
}) => {
  const id = await createCharacterViaApi(page.request, uniqueName("Rover"));
  await setLorebookViaApi(page.request, id, {
    entries: [
      loreEntry({ comment: "First", keys: ["a"], insertionOrder: 10 }),
      loreEntry({ comment: "Second", keys: ["b"], insertionOrder: 20 }),
      loreEntry({
        comment: "Third",
        keys: ["c"],
        insertionOrder: 30,
        settings: { placement: "after" },
      }),
    ],
  });
  await page.goto(`/characters/${id}/lorebook`);
  const row = (title: string) => entries(page).getByRole("button", { name: `Edit ${title}` });
  await row("First").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row("Second")).toBeFocused();
  await page.keyboard.press("End");
  await expect(row("Third")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(row("First")).toBeFocused();
  await expect(entries(page).locator('[tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.getByRole("switch", { name: "Second enabled" })).not.toBeChecked();
  await expect(row("Second")).toContainText("Off,");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Second");
  await saved(page);
  expect((await card(page, id)).card.lorebook?.entries[1]?.enabled).toBe(false);
});

test("an order or placement change moves the row; remove has Undo; the whole book can go", async ({
  page,
}) => {
  const name = uniqueName("Mover");
  const id = await createCharacterViaApi(page.request, name);
  await setLorebookViaApi(page.request, id, {
    entries: [
      loreEntry({ comment: "Alpha", keys: ["a"], insertionOrder: 10 }),
      loreEntry({ comment: "Beta", keys: ["b"], insertionOrder: 20 }),
    ],
  });
  await page.goto(`/characters/${id}/lorebook?entry=0`);
  await page.getByRole("button", { name: "Where it goes" }).click();
  const order = page.getByRole("textbox", { name: "Order" });
  await order.fill("30");
  await order.press("Enter");
  await order.press("Tab");
  const titles = () =>
    entries(page)
      .getByRole("button", { name: /^Edit / })
      .allTextContents();
  await expect.poll(async () => (await titles()).join("|")).toMatch(/Beta.*Alpha/);

  await page.getByRole("button", { name: "More for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await expect(page.getByRole("status")).toContainText("Alpha removed.");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(entries(page).getByRole("button", { name: "Edit Alpha" })).toBeVisible();
  await saved(page);
  expect((await card(page, id)).card.lorebook?.entries).toHaveLength(2);

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remove lorebook" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove lorebook" }).click();
  await expect(page.getByRole("link", { name: "Create lorebook" })).toBeVisible();
  expect((await card(page, id)).card.lorebook).toBeUndefined();
});

test("find narrows the list, and keys that never match are flagged and filtered", async ({
  page,
}) => {
  const id = await createCharacterViaApi(page.request, uniqueName("Finder"));
  await setLorebookViaApi(page.request, id, {
    entries: [
      loreEntry({ comment: "Harbour of Solm", keys: ["harbour"] }),
      loreEntry({ comment: "Tide", constant: true }),
      loreEntry({
        comment: "Bell",
        keys: ["bell", "/(?<=old )chapel/"],
        settings: { placement: "after" },
      }),
    ],
  });
  await page.goto(`/characters/${id}/lorebook`);
  await page.getByRole("searchbox", { name: "Find entries" }).fill("solm");
  await expect(entries(page)).toContainText("1 of 2");
  await expect(entries(page).getByRole("button", { name: /^Edit / })).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Find entries" }).fill("nothing here");
  await page.getByRole("button", { name: "Clear find" }).click();
  await expect(entries(page).getByRole("button", { name: /^Edit / })).toHaveCount(3);

  await page.getByRole("button", { name: "1 to fix" }).click();
  await expect(entries(page).getByRole("button", { name: /^Edit / })).toHaveCount(1);
  await entries(page).getByRole("button", { name: "Edit Bell" }).click();
  await expect(page.getByText(/uses lookaround or a backreference/)).toBeVisible();
  await expect(page.getByText("The other keywords still work.", { exact: false })).toBeVisible();
});

test("the inspector says which entries went in, on which words, and why others did not", async ({
  page,
}) => {
  const character = uniqueName("Lorekeeper");
  const id = await createCharacterViaApi(page.request, character, {
    description: "Keeper of the light.",
  });
  await setLorebookViaApi(page.request, id, {
    tokenBudget: 40,
    entries: [
      loreEntry({
        comment: "Tide",
        constant: true,
        content: "High water at dusk.",
        insertionOrder: 5,
      }),
      loreEntry({ comment: "Lantern", keys: ["lantern"], content: "The Grey Lantern burns oil." }),
      loreEntry({
        comment: "Harbour",
        keys: ["harbour"],
        content: "Solm harbour ".repeat(40),
        // Fitted last, as the lowest order: it alone misses the budget.
        insertionOrder: 1,
      }),
      loreEntry({ comment: "Gulls", keys: ["gulls"], content: "Gull lore.", enabled: false }),
      loreEntry({
        comment: "Bell",
        keys: ["bell"],
        content: "Bell lore.",
        settings: { placement: "after" },
      }),
    ],
  });
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  const line = `The LANTERN by the harbour ${canary("in")}`;
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  const [record] = await upstreamRecords(line);
  const contents = record?.messages.map((message) => message.content) ?? [];
  const lore = contents.indexOf("High water at dusk.\nThe Grey Lantern burns oil.");
  expect(lore).toBeGreaterThan(-1);
  expect(lore).toBeLessThan(contents.indexOf("Keeper of the light."));
  expect(contents.join("\n")).not.toContain("Solm harbour");
  expect(contents.join("\n")).not.toContain("Bell lore.");

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const section = page.getByRole("dialog", { name: "Prompt" }).getByRole("region", {
    name: "Lorebook",
  });
  await expect(section).toContainText("2 entries went in, 1 over the budget");
  const sent = section.getByRole("list", { name: "Lorebook entries sent" });
  await expect(sent).toContainText("Before the character, always on");
  await expect(sent).toContainText("Before the character, matched LANTERN");
  await expect(
    section.getByRole("list", { name: "Lorebook entries over the budget" }),
  ).toContainText("Harbour");
  await section.getByRole("button", { name: /^Other entries: 1 not matched, 1 off/ }).click();
  await expect(section).toContainText("Bell");
  await expect(section).toContainText("Gulls");
  await expect(
    page
      .getByRole("list", { name: "Prompt in send order" })
      .getByText("Lorebook, before character: 2 entries"),
  ).toBeVisible();
});

test("the inspector explains secondary, chained, in-chat and timed entries as the model received them", async ({
  page,
}) => {
  const character = uniqueName("Keeper");
  const id = await createCharacterViaApi(page.request, character, {
    description: "Keeper of the light.",
  });
  await setLorebookViaApi(page.request, id, {
    // Only the latest message is read, so the second send keys nothing itself.
    scanDepth: 1,
    recursiveScanning: true,
    entries: [
      loreEntry({
        comment: "The Grey Lantern",
        keys: ["lantern"],
        secondaryKeys: ["storm"],
        selective: true,
        content: "Lantern lore: the lamp is trimmed nightly.",
        settings: { logic: "andAny", sticky: 4 },
      }),
      loreEntry({ comment: "Lamp room", keys: ["lamp"], content: "Lamp room lore." }),
      loreEntry({
        comment: "Gull omen",
        keys: ["gull"],
        content: "Gull omen lore.",
        settings: { placement: "depth", depth: 1, role: "system" },
      }),
      loreEntry({
        comment: "Bell",
        keys: ["bell"],
        content: "Bell lore.",
        settings: { cooldown: 3 },
      }),
      loreEntry({
        comment: "Wreck",
        keys: ["wreck"],
        content: "Wreck lore.",
        settings: { delay: 2 },
      }),
    ],
  });
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  const dialog = page.getByRole("dialog", { name: "Prompt" });
  const section = dialog.getByRole("region", { name: "Lorebook" });
  const sent = section.getByRole("list", { name: "Lorebook entries sent" });
  const others = section.getByRole("button", { name: /^Other entries/ });
  const show = (mode: "Last sent" | "Preview") =>
    dialog
      .getByRole("radio", { name: mode })
      .or(dialog.getByRole("button", { name: mode }))
      .click();

  // The first message: a secondary match, an entry brought in, one in the chat, one delayed.
  const first = `The lantern shook in the storm; a gull, a bell, a wreck ${canary("in")}`;
  await send(page, first);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [one] = await upstreamRecords(first);
  const sentOne = one?.messages ?? [];
  const lore = sentOne.map((message) => message.content).join("\n");
  expect(lore).toContain("Lantern lore: the lamp is trimmed nightly.");
  expect(lore).toContain("Lamp room lore.");
  expect(lore).toContain("Bell lore.");
  expect(lore).not.toContain("Wreck lore.");
  // In the chat at depth 1, as system: just before the message being answered.
  const gull = sentOne.findIndex((message) => message.content === "Gull omen lore.");
  expect(sentOne[gull]?.role).toBe("system");
  expect(sentOne[gull + 1]?.content).toBe(first);

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(section).toContainText(
    /Entries' text was read \d+ more times? for entries it brings in\./,
  );
  await expect(sent).toContainText("Before the character, matched lantern, with storm");
  await expect(sent).toContainText(
    "Before the character, brought in by The Grey Lantern, matched lamp",
  );
  await expect(sent).toContainText("In the chat at depth 1 as system, matched gull");
  await expect(sent).toContainText("Before the character, matched bell");
  await expect(others).toHaveAccessibleName("Other entries: 1 waiting for a longer chat");
  await others.click();
  await expect(section.getByText("Wreck, until 2 messages", { exact: true })).toBeVisible();
  // The lorebook block sits inside the chat history band, which counts it.
  const band = dialog.getByRole("button", { name: /Chat history/ });
  await expect(band).toContainText("1 message sent, 1 lorebook block among them");
  await band.click();
  await expect(
    dialog
      .getByRole("list", { name: "Chat history as sent" })
      .getByText("Lorebook, in the chat at depth 1: 1 entry", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // The next message keys nothing: the lantern stays in, the bell rests. The preview says so first.
  const second = `Quiet night ${canary("in")}`;
  await page.getByLabel("Message", { exact: true }).fill(second);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await show("Preview");
  await expect(dialog).toContainText("Preview for mock-fast.");
  await expect(sent).toContainText("Before the character, stays in, 2 more messages");
  const preview = await sent.getByRole("listitem").allTextContents();
  const previewOthers = await others.textContent();
  await page.keyboard.press("Escape");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [two] = await upstreamRecords(second);
  const loreTwo = (two?.messages ?? []).map((message) => message.content).join("\n");
  expect(loreTwo).toContain("Lantern lore: the lamp is trimmed nightly.");
  expect(loreTwo).toContain("Lamp room lore.");
  expect(loreTwo).not.toContain("Bell lore.");
  expect(loreTwo).not.toContain("Gull omen lore.");

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await show("Last sent");
  await expect(dialog).toContainText("Sent to mock-fast at");
  // Each row ends in its token count, which parallel tests' replies can recalibrate between the two.
  const explained = (rows: string[]) => rows.map((row) => row.replace(/\d+$/, ""));
  await expect
    .poll(async () => explained(await sent.getByRole("listitem").allTextContents()))
    .toEqual(explained(preview));
  expect(await others.textContent()).toBe(previewOthers);
  await expect(sent).toContainText(
    "Before the character, brought in by The Grey Lantern, matched lamp",
  );
  await expect(others).toHaveAccessibleName(/1 resting after going in/);
  await others.click();
  await expect(section.getByText("Bell, 1 more message", { exact: true })).toBeVisible();
});

test("a foreign lorebook imports to native settings and exports native data", async ({ page }) => {
  const name = uniqueName("Imported lore");
  const book = {
    recursive_scanning: true,
    extensions: {},
    entries: [
      {
        enabled: true,
        insertion_order: 100,
        use_regex: false,
        comment: "Tobin",
        keys: ["Tobin"],
        content: "Her brother.",
        secondary_keys: ["drowned"],
        selective: true,
        extensions: { depth: 4 },
      },
    ],
  };
  await importCards(page, [jsonCard("lore.json", v3({ name, character_book: book }))]);
  // Recursion, secondary keywords and a SillyTavern depth are all acted on now: nothing to name.
  const status = page.getByRole("status").filter({ hasText: "Imported" });
  await expect(status).toContainText(`Imported ${name}.`);
  await expect(status).not.toContainText("lorebook keeps");
  const [summary] = (await (await page.request.get("/api/characters")).json()).characters.filter(
    (character: { name: string }) => character.name === name,
  );
  await page.goto(`/characters/${summary.id}/lorebook?entry=0`);
  await expect(page.getByLabel("Text", { exact: true })).toBeVisible();
  await expect(page.getByText(/kept but not used|kept in the card but not/)).toHaveCount(0);
  await page.getByLabel("Text", { exact: true }).fill("Her younger brother.");
  await saved(page);
  const exported = await (
    await page.request.get(`/api/characters/${summary.id}/export.json`)
  ).json();
  expect(exported.data.lorebook).toMatchObject({
    recursiveScanning: true,
    entries: [
      {
        content: "Her younger brother.",
        secondaryKeys: ["drowned"],
        selective: true,
        settings: { depth: 4 },
      },
    ],
  });
});

for (const { name, width, height, scheme } of [
  { name: "desktop", width: 1440, height: 900, scheme: "light" },
  { name: "tablet", width: 820, height: 1180, scheme: "dark" },
  { name: "phone", width: 390, height: 844, scheme: "dark" },
] as const) {
  test(`the lorebook fits the ${name} layout and passes axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const character = uniqueName("Fitted");
    const id = await createCharacterViaApi(page.request, character);
    await setLorebookViaApi(page.request, id, {
      recursiveScanning: true,
      entries: [
        loreEntry({
          comment: "A rather long entry title that must truncate gracefully",
          keys: ["one", "two"],
        }),
        loreEntry({
          comment: "Bell",
          keys: ["bell", "/(?<=old )chapel/"],
          settings: { placement: "after" },
        }),
        loreEntry({ comment: "Tobin", keys: ["Tobin"], secondaryKeys: ["x"], enabled: false }),
      ],
    });
    await page.goto(`/characters/${id}`);
    await expect(page.locator("#s-lorebook")).toContainText("3 entries");
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await page.goto(`/characters/${id}/lorebook`);
    await expect(entries(page)).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await entries(page).getByRole("button", { name: "Edit Bell" }).click();
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Bell");
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    if (name !== "desktop") {
      // The entry replaced the list; Back returns to it.
      await page.getByRole("button", { name: "Entries" }).click();
      await expect(entries(page)).toBeVisible();
    }
  });
}

test.describe("review fixes", () => {
  test("removing a lorebook created in the same visit saves the removal", async ({ page }) => {
    const id = await createCharacterViaApi(page.request, uniqueName("Short-lived"));
    await page.goto(`/characters/${id}/lorebook`);
    await page.getByRole("button", { name: "Add the first entry" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill("Brief");
    await saved(page);
    expect((await card(page, id)).card.lorebook?.entries).toHaveLength(1);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Remove lorebook" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove lorebook" }).click();
    await expect(page.getByRole("link", { name: "Create lorebook" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: "Create lorebook" })).toBeVisible();
    expect((await card(page, id)).card.lorebook).toBeUndefined();
  });

  test("Space on a row's own switch changes only that entry", async ({ page }) => {
    const id = await createCharacterViaApi(page.request, uniqueName("Switches"));
    await setLorebookViaApi(page.request, id, {
      entries: [
        loreEntry({ comment: "Alpha", keys: ["a"], insertionOrder: 10 }),
        loreEntry({ comment: "Beta", keys: ["b"], insertionOrder: 20 }),
      ],
    });
    await page.goto(`/characters/${id}/lorebook`);
    await entries(page).getByRole("button", { name: "Edit Alpha" }).click();
    await page.getByRole("switch", { name: "Beta enabled" }).click();
    await page.keyboard.press(" ");
    await saved(page);
    await expect(page.getByRole("switch", { name: "Alpha enabled" })).toBeChecked();
    expect((await card(page, id)).card.lorebook?.entries[0]?.enabled).toBe(true);
  });

  test("on a phone, Back returns focus to the entry's row, and Remove moves it to the next", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await createCharacterViaApi(page.request, uniqueName("Focus"));
    await setLorebookViaApi(page.request, id, {
      entries: ["One", "Two", "Three"].map((comment, i) =>
        loreEntry({ comment, keys: [comment.toLowerCase()], insertionOrder: i }),
      ),
    });
    await page.goto(`/characters/${id}/lorebook`);
    await entries(page).getByRole("button", { name: "Edit Two" }).click();
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Two");
    await page.getByRole("button", { name: "Entries" }).click();
    await expect(entries(page).getByRole("button", { name: "Edit Two" })).toBeFocused();

    await entries(page).getByRole("button", { name: "Edit Two" }).click();
    await page.getByRole("button", { name: "More for Two" }).click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await expect(entries(page).getByRole("button", { name: "Edit Three" })).toBeFocused();
  });

  test("an imported book's repeated keyword is removed once", async ({ page }) => {
    const id = await createCharacterViaApi(page.request, uniqueName("Repeats"));
    await setLorebookViaApi(page.request, id, {
      entries: [loreEntry({ comment: "Bell", keys: ["bell", "bell", "tide"] })],
    });
    await page.goto(`/characters/${id}/lorebook?entry=0`);
    await page.getByRole("button", { name: "Remove keyword bell" }).first().click();
    await saved(page);
    expect((await card(page, id)).card.lorebook?.entries[0]?.keys).toEqual(["bell", "tide"]);
  });

  test("the pattern engine stays in the lorebook screen's chunk, out of the chat's first paint", async ({
    page,
  }) => {
    const scripts: { path: string; text: string }[] = [];
    page.on("response", async (response) => {
      if (response.url().endsWith(".js")) {
        scripts.push({ path: new URL(response.url()).pathname, text: await response.text() });
      }
    });
    const shell = await (await page.request.get("/")).text();
    await page.goto("/");
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const engine = scripts.filter(({ text }) => text.includes("numberOfInstructions"));
    // It arrives with the preload after the first paint, in a chunk the page's entry never names.
    expect(engine.length).toBeGreaterThan(0);
    for (const { path } of engine) {
      expect(shell).not.toContain(path);
      expect(path).not.toMatch(/\/index-[^/]+\.js$/);
    }
  });
});

test.describe("Native lorebook controls", () => {
  /** Unrelated native settings stay through edits. */
  const NATIVE = { sticky: 0 };
  const row = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
  const pressed = (page: Page, group: string, name: string) =>
    page.getByRole("group", { name: group }).getByRole("button", { name, exact: true });
  /** An entry's own number field, not the book's of the same name. */
  const number = (page: Page, name: string) =>
    page
      .locator("section[aria-labelledby='entry-title']")
      .getByRole("textbox", { name, exact: true });
  const setNumber = async (page: Page, name: string, value: string) => {
    const field = number(page, name);
    await field.fill(value);
    await field.press("Tab");
  };

  test("each control writes the card as withEntrySettings says, autosaves, and the export re-imports equal", async ({
    page,
  }) => {
    const name = uniqueName("Settings");
    const id = await createCharacterViaApi(page.request, name);
    await setLorebookViaApi(page.request, id, {
      entries: [loreEntry({ comment: "Gull omen", keys: ["gull"], settings: NATIVE })],
    });
    await page.goto(`/characters/${id}/lorebook?entry=0`);

    // The secondary condition: the quiet button reveals the field with focus in it.
    await page
      .getByRole("button", { name: "Add words the messages must also have, or must not have" })
      .click();
    const secondary = page.getByLabel("Secondary keywords", { exact: true });
    await expect(secondary).toBeFocused();
    await secondary.fill("storm");
    await secondary.press("Enter");
    await choose(page, "Secondary keyword condition", "also have all of");

    await row(page, "Where it goes").click();
    await choose(page, "Placement", "In the chat");
    await setNumber(page, "Depth", "3");
    await choose(page, "Role", "User");
    await expect(row(page, "Where it goes")).toHaveAccessibleDescription(
      "In the chat at depth 3 as user, order 100",
    );

    await row(page, "When it goes in").click();
    await setNumber(page, "Sticky", "2");
    await setNumber(page, "Cooldown", "1");
    await setNumber(page, "Delay", "4");
    await expect(page.getByText("Can't go in before the chat has 4 messages.")).toContainText(
      "Once in, it stays in for 2 more messages, then can't come back for 1.",
    );
    await expect(number(page, "Sticky")).toHaveAccessibleDescription(
      /Can't go in before the chat has 4 messages/,
    );

    await row(page, "What brings it in").click();
    await pressed(page, "Can go in through", "Its keywords only").click();
    await page.getByRole("switch", { name: "Its text can bring in other entries" }).click();

    await row(page, "What it matches").click();
    await setNumber(page, "Scan depth", "5");
    await pressed(page, "Whole words", "Off").click();
    await pressed(page, "Match case", "On").click();
    // Default clears the explicit override.
    await pressed(page, "Match case", "Default").click();
    await expect(page.getByText("Default is off", { exact: true })).toBeVisible();
    await expect(row(page, "What it matches")).toHaveAccessibleDescription(
      "Last 5 messages, inside words too, any case",
    );

    await page.getByRole("switch", { name: "Chaining" }).click();
    await saved(page);

    const book = (await card(page, id)).card.lorebook;
    expect(book?.recursiveScanning).toBe(true);
    const entry = book?.entries[0];
    expect(entry).toMatchObject({ secondaryKeys: ["storm"], selective: true });
    expect(entry?.settings).toEqual({
      placement: "depth",
      depth: 3,
      role: "user",
      logic: "andAll",
      sticky: 2,
      cooldown: 1,
      delay: 4,
      excludeRecursion: true,
      recursiveOnly: false,
      preventRecursion: true,
      scanDepth: 5,
      wholeWords: false,
      caseSensitive: null,
    });
    // Match case is a native setting, with no duplicate transport field.
    expect(entry).not.toHaveProperty("case_sensitive");

    // The export imports into a new character with the same book.
    const exported = await (await page.request.get(`/api/characters/${id}/export.json`)).json();
    const copyName = uniqueName("Settings copy");
    await importCards(page, [
      jsonCard("copy.json", { ...exported, data: { ...exported.data, name: copyName } }),
    ]);
    const [copy] = (await (await page.request.get("/api/characters")).json()).characters.filter(
      (character: { name: string }) => character.name === copyName,
    );
    expect((await card(page, copy.id)).card.lorebook).toEqual(exported.data.lorebook);
  });

  test("the list shows every group in speaking order, with its cues, and arrows cross them all", async ({
    page,
  }) => {
    const id = await createCharacterViaApi(page.request, uniqueName("Groups"));
    const at = (comment: string, placement: string, settings: object = {}, order = 100) =>
      loreEntry({
        comment,
        keys: [comment.toLowerCase().split(" ")[0]],
        insertionOrder: order,
        settings: { placement, ...settings },
      });
    await setLorebookViaApi(page.request, id, {
      entries: [
        at("Shallow bell", "depth", { depth: 1, role: "system" }),
        at("Deep gull", "depth", { depth: 4, role: "system", sticky: 2, recursiveOnly: true }),
        at("Fog note", "anBottom"),
        at("Log example", "examplesTop"),
        at("After lamp", "after"),
        at("Before harbour", "before"),
      ],
    });
    await page.goto(`/characters/${id}/lorebook`);
    const list = entries(page);
    const text = (await list.innerText()).replace(/\s+/g, " ");
    const heads = [
      "Before the character",
      "After the character",
      "With the example dialogue",
      "Chat history",
      "With the Author's Note",
      "In the chat",
    ].map((head) => text.indexOf(head));
    expect(heads.every((at) => at >= 0)).toBe(true);
    expect(heads).toEqual(heads.toSorted((a, b) => a - b));
    await expect(list).toContainText("Entries in the chat sit among the messages, deepest first");
    const edit = (title: string) => list.getByRole("button", { name: `Edit ${title}` });
    await expect(edit("Deep gull")).toHaveAccessibleDescription(
      "Depth 4, system, chained only, timing set, deep",
    );
    await expect(edit("Fog note")).toHaveAccessibleDescription("Below, fog");
    await expect(edit("Log example")).toHaveAccessibleDescription("Before, log");

    await edit("Before harbour").focus();
    const order = [
      "Before harbour",
      "After lamp",
      "Log example",
      "Fog note",
      "Deep gull",
      "Shallow bell",
    ];
    for (const title of order.slice(1)) {
      await page.keyboard.press("ArrowDown");
      await expect(edit(title)).toBeFocused();
    }
    await page.keyboard.press("Home");
    await expect(edit("Before harbour")).toBeFocused();
    await page.keyboard.press("End");
    await expect(edit("Shallow bell")).toBeFocused();
  });

  test("By chance gives an entry a trigger chance that stays after a reload", async ({ page }) => {
    const id = await createCharacterViaApi(page.request, uniqueName("Omens"));
    await setLorebookViaApi(page.request, id, {
      entries: [loreEntry({ comment: "Gull omen", keys: ["gull"], settings: NATIVE })],
    });
    await page.goto(`/characters/${id}/lorebook?entry=0`);
    await pressed(page, "Goes in", "By chance").click();
    await expect(number(page, "Chance in percent")).toHaveValue("10");
    await setNumber(page, "Chance in percent", "25");
    await expect(number(page, "Chance in percent")).toHaveAccessibleDescription(
      "Added to about 25% of replies, no keyword needed.",
    );
    await saved(page);
    expect((await card(page, id)).card.lorebook?.entries[0]).toMatchObject({
      constant: true,
      settings: { ...NATIVE, useProbability: true, probability: 25 },
    });

    await page.reload();
    await expect(pressed(page, "Goes in", "By chance")).toHaveAttribute("aria-pressed", "true");
    await expect(number(page, "Chance in percent")).toHaveValue("25");
    await expect(entries(page).getByRole("button", { name: "Edit Gull omen" })).toContainText(
      "By chance, 25%",
    );
  });

  test("an event pool name and weight stay after a reload", async ({ page }) => {
    const id = await createCharacterViaApi(page.request, uniqueName("Pools"));
    await setLorebookViaApi(page.request, id, {
      entries: [
        loreEntry({ comment: "Gull omen", keys: ["gull"], settings: NATIVE }),
        loreEntry({ comment: "Rain", keys: ["rain"], settings: { poolNames: ["Weather"] } }),
      ],
    });
    await page.goto(`/characters/${id}/lorebook?entry=0`);
    await expect(row(page, "Event pool")).toHaveAccessibleDescription("None");
    await row(page, "Event pool").click();
    // The book's other pool names are offered while typing.
    await expect(page.locator("datalist option")).toHaveAttribute("value", "Weather");
    const names = page.getByLabel("Pool names", { exact: true });
    await names.fill("Weather");
    await names.press("Enter");
    await setNumber(page, "Weight", "300");
    await expect(row(page, "Event pool")).toHaveAccessibleDescription("Weather; weight 300");
    await saved(page);
    expect((await card(page, id)).card.lorebook?.entries[0]).toMatchObject({
      settings: { ...NATIVE, poolNames: ["Weather"], poolWeight: 300 },
    });

    await page.reload();
    await expect(row(page, "Event pool")).toHaveAccessibleDescription("Weather; weight 300");
    await expect(entries(page).getByRole("button", { name: "Edit Gull omen" })).toContainText(
      "pool Weather",
    );
  });

  test("by keyboard: rows open with Enter and Space, keep focus, and every control is reachable", async ({
    page,
  }) => {
    const id = await createCharacterViaApi(page.request, uniqueName("Keys"));
    await setLorebookViaApi(page.request, id, {
      entries: [
        loreEntry({
          comment: "Bell",
          keys: ["bell"],
          secondaryKeys: ["dusk"],
          useRegex: true,
          settings: { placement: "depth" },
        }),
      ],
    });
    await page.goto(`/characters/${id}/lorebook?entry=0`);
    // Closed rows are out of the tab order.
    await expect(number(page, "Scan depth")).toBeHidden();
    const rows = ["Where it goes", "When it goes in", "What brings it in", "What it matches"];
    for (const [at, name] of rows.entries()) {
      const button = row(page, name);
      await button.focus();
      await page.keyboard.press(at % 2 === 0 ? "Enter" : " ");
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(button).toBeFocused();
    }
    const controls = [
      // A toggle group is one tab stop, its first option; arrows move within it.
      pressed(page, "Goes in", "Always"),
      page.getByRole("combobox", { name: "Secondary keyword condition" }),
      page.getByLabel("Secondary keywords", { exact: true }),
      page.getByRole("combobox", { name: "Placement" }),
      number(page, "Order"),
      number(page, "Depth"),
      page.getByRole("combobox", { name: "Role" }),
      number(page, "Sticky"),
      number(page, "Cooldown"),
      number(page, "Delay"),
      number(page, "Chance in percent"),
      page.getByRole("button", { name: "Open book settings" }),
      pressed(page, "Can go in through", "Its keywords or another entry"),
      page.getByRole("switch", { name: "Its text can bring in other entries" }),
      number(page, "Scan depth"),
      pressed(page, "Match case", "Default"),
      pressed(page, "Whole words", "Default"),
      page.getByRole("switch", { name: "Keywords are patterns" }),
    ];
    await page.getByRole("textbox", { name: "Title" }).focus();
    for (const control of controls) {
      for (let step = 0; step < 30; step++) {
        if (await control.evaluate((node) => node === document.activeElement)) break;
        await page.keyboard.press("Tab");
      }
      await expect(control).toBeFocused();
    }
    // Closing a row takes its controls out of the tab order again.
    await row(page, "What it matches").click();
    await expect(number(page, "Scan depth")).toBeHidden();
  });

  test("on a phone, Open book settings returns to the list with focus on Chaining, and the entry keeps its rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await createCharacterViaApi(page.request, uniqueName("Chainer"));
    await setLorebookViaApi(page.request, id, {
      entries: [loreEntry({ comment: "Lamp", keys: ["lamp"] })],
    });
    await page.goto(`/characters/${id}/lorebook`);
    await entries(page).getByRole("button", { name: "Edit Lamp" }).click();
    await row(page, "What brings it in").click();
    await expect(row(page, "What brings it in")).toHaveAccessibleDescription(
      "The book doesn't chain entries",
    );
    await page.getByRole("button", { name: "Open book settings" }).click();
    const chaining = page.getByRole("switch", { name: "Chaining" });
    await expect(chaining).toBeFocused();
    await expect(chaining).toBeInViewport();
    await page.keyboard.press(" ");
    await expect(chaining).toBeChecked();

    await entries(page).getByRole("button", { name: "Edit Lamp" }).click();
    await expect(row(page, "What brings it in")).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, "What brings it in")).toHaveAccessibleDescription(
      "Its keywords or another entry, and its text can bring in others",
    );
    await expect(page.getByRole("button", { name: "Open book settings" })).toHaveCount(0);
    await expect
      .poll(async () => (await card(page, id)).card.lorebook?.recursiveScanning, {
        timeout: 15_000,
      })
      .toBe(true);
  });
});
