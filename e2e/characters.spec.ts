import AxeBuilder from "@axe-core/playwright";
import { pngText, svg } from "../apps/server/test/image-fixtures.ts";
import { EXAMPLE_SEPARATOR } from "../packages/core/src/prompt/examples.ts";
import {
  importCards,
  jsonCard,
  openSheet,
  pngCard,
  tile,
  uniqueName,
  v3,
} from "./support/cards.ts";
import { chooseCharacter, lastReply, messages, openChat, send } from "./support/chat.ts";
import { createCharacterViaApi } from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

const card = (name: string, extra: Record<string, unknown> = {}) =>
  v3({
    name,
    description: `${name} keeps the lantern lit.`,
    first_mes: `*${name} looks up.*`,
    alternate_greetings: ["Rain.", "Morning."],
    tags: ["lantern"],
    creator: "E2E",
    extensions: { other_app: { kept: true } },
    ...extra,
  });

test("imports PNG and JSON cards, reports each file and shows their portraits", async ({
  page,
}) => {
  const withArt = uniqueName("Wren");
  const withoutArt = uniqueName("Keeper");
  await importCards(page, [
    await pngCard("wren.png", card(withArt)),
    jsonCard("keeper.json", card(withoutArt)),
    jsonCard("notes.json", { hello: "world" }),
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Imported 2 cards." })).toContainText(
    "notes.json was not imported: it is not a character card.",
  );

  const art = tile(page, withArt).locator("img");
  await expect(art).toHaveJSProperty("complete", true);
  expect(await art.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(60);
  const src = await art.getAttribute("src");
  expect(src).toMatch(/^\/api\/characters\/[0-9a-f-]+\/portrait\/image\?size=thumb&v=\d+$/);
  const response = await page.request.get(src ?? "");
  expect(response.headers()["content-type"]).toBe("image/webp");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["cache-control"]).toBe("private, no-cache, no-transform");
  const etag = response.headers().etag ?? "";
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  const revalidated = await page.request.get(src ?? "", { headers: { "If-None-Match": etag } });
  expect(revalidated.status()).toBe(304);

  // Without art, the cover keeps the mark alone; the caption names the character.
  await expect(tile(page, withoutArt).locator("img")).toHaveCount(0);
  await expect(tile(page, withoutArt).locator("svg[data-icon='Mark']")).toBeVisible();
});

test("search, tag filter and order narrow the gallery; a tag filter or order glides the cards, a search applies at once", async ({
  page,
}) => {
  const tag = `t${crypto.randomUUID().slice(0, 6)}`;
  const [alpha, beta, gamma] = ["Alpha", "Beta", "Gamma"].map(uniqueName);
  await importCards(page, [
    jsonCard("a.json", card(alpha ?? "", { tags: [tag, "shared"] })),
    jsonCard("b.json", card(beta ?? "", { tags: [tag], creator: "Findable" })),
    jsonCard("c.json", card(gamma ?? "", { tags: ["other"] })),
  ]);

  // Every view transition the page starts, counted.
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document);
    Object.assign(window, { transitions: 0 });
    document.startViewTransition = ((update?: ViewTransitionUpdateCallback) => {
      (window as unknown as { transitions: number }).transitions++;
      return start(update);
    }) as typeof document.startViewTransition;
  });
  const transitions = () =>
    page.evaluate(() => (window as unknown as { transitions: number }).transitions);

  const search = page.getByRole("searchbox", { name: "Search characters" });
  await search.fill("findable");
  await expect(tile(page, beta ?? "")).toBeVisible();
  await expect(tile(page, alpha ?? "")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/\d+ of \d+/);
  await search.fill("");
  await expect(tile(page, alpha ?? "")).toBeVisible();
  expect(await transitions()).toBe(0);

  await page.getByRole("button", { name: "Tags" }).click();
  await page.getByRole("searchbox", { name: "Find a tag" }).fill(tag);
  await page.getByRole("checkbox", { name: new RegExp(tag) }).check();
  await page.keyboard.press("Escape");
  await expect(tile(page, alpha ?? "")).toBeVisible();
  await expect(tile(page, beta ?? "")).toBeVisible();
  await expect(tile(page, gamma ?? "")).toHaveCount(0);
  const filtered = await transitions();
  expect(filtered).toBeGreaterThan(0);
  const shownNames = async () =>
    (await page.getByRole("list", { name: "Characters" }).getByRole("link").allInnerTexts()).map(
      (text) => text.split("\n")[0],
    );
  const before = await shownNames();

  await page.getByRole("button", { name: /^Order:/ }).click();
  await page.getByRole("menuitemradio", { name: "Name" }).click();
  await expect.poll(shownNames).toEqual([alpha, beta]);
  // Cards that moved glided there.
  if (before.join() !== [alpha, beta].join()) {
    expect(await transitions()).toBeGreaterThan(filtered);
  }

  await page.getByRole("button", { name: `Remove tag filter ${tag}` }).click();
  await expect(tile(page, gamma ?? "")).toBeVisible();

  await search.fill("no character is called this");
  await expect(page.getByRole("heading", { name: "No characters match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
});

test("a new character is saved once named, and every field and greeting persists", async ({
  page,
}) => {
  const name = uniqueName("Tobias");
  const examples = `{{user}}: Hi${EXAMPLE_SEPARATOR}{{char}}: Welcome back.`;
  await page.goto("/characters");
  await page.locator("header").getByRole("button", { name: "New character" }).click();
  await expect(page.getByText("Add a name to save")).toBeVisible();

  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // The optional details wait in Card details, after the portrait, name and tags.
  await page.getByText("Card details", { exact: true }).click();
  const fields: [string, string][] = [
    ["Nickname", "Toby"],
    ["Creator", "E2E"],
    ["Version", "2"],
    ["Description", "An archivist."],
    ["Personality", "Curious."],
    ["Scenario", "A library at night."],
    ["First message", "*He closes the book.*"],
    ["Examples", examples],
    ["System prompt", "{{original}} Stay in the archive."],
    ["Post-history instructions", "Keep it short."],
    ["Creator notes", "For testing."],
  ];
  for (const [label, value] of fields) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("textbox", { name: "Tags" }).fill("mystery");
  await page.getByRole("textbox", { name: "Tags" }).press("Enter");

  const addAlternate = page.getByRole("button", { name: "Add alternate" });
  for (const text of ["One", "Two", "Three"]) {
    await addAlternate.click();
    await page.getByRole("textbox", { name: /^Alternate \d+$/ }).fill(text);
  }
  // Alternate 3 is open: move it earlier, then to the first position.
  await page.getByRole("button", { name: "Move Alternate 3 earlier" }).click();
  await page.getByRole("button", { name: "More for Alternate 2" }).click();
  await page.getByRole("menuitem", { name: "Move to position" }).click();
  await page.getByRole("spinbutton", { name: "Move to position" }).fill("1");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  // Now: Three, One, Two. Remove "One" and undo, then use "Two" as the first message.
  await page.getByRole("button", { name: /^Alternate 2: One/ }).click();
  await page.getByRole("button", { name: "More for Alternate 2" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: /^Alternate 3: Two/ }).click();
  await page.getByRole("button", { name: "More for Alternate 3" }).click();
  await page.getByRole("menuitem", { name: "Use as first message" }).click();

  const id = page.url().split("/").at(-1) ?? "";
  const stored = async () => (await (await page.request.get(`/api/characters/${id}`)).json()).card;
  await expect.poll(stored, { timeout: 10_000 }).toMatchObject({
    name,
    nickname: "Toby",
    creator: "E2E",
    characterVersion: "2",
    description: "An archivist.",
    personality: "Curious.",
    scenario: "A library at night.",
    firstMessage: "Two",
    alternateGreetings: ["Three", "One", "*He closes the book.*"],
    exampleDialogue: examples,
    systemPrompt: "{{original}} Stay in the archive.",
    postHistoryInstructions: "Keep it short.",
    creatorNotes: "For testing.",
    tags: ["mystery"],
  });

  // Back to the gallery and in again, without a reload: the sheet shows the saved character.
  await page.getByRole("link", { name: "Characters" }).first().click();
  await page.getByRole("searchbox", { name: "Search characters" }).fill(name);
  await tile(page, name).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  await expect(page.getByLabel("First message", { exact: true })).toHaveValue("Two");

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  await expect(page.getByLabel("First message", { exact: true })).toHaveValue("Two");
});

test("a character just created, duplicated, is itself again on Back", async ({ page }) => {
  const name = uniqueName("Rowan");
  await page.goto("/characters");
  await page.locator("header").getByRole("button", { name: "New character" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const created = page.url();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    `${name} (copy)`,
  );
  // Not a blank "new" sheet at the created character's address.
  await page.goBack();
  await expect(page).toHaveURL(created);
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
});

test("the gallery comes back where it was left, by its link and by Back", async ({ page }) => {
  const stem = uniqueName("Shelf");
  await Promise.all(
    Array.from({ length: 36 }, (_, at) => createCharacterViaApi(page.request, `${stem} ${at}`)),
  );
  await page.goto("/characters");
  await page.getByRole("searchbox", { name: "Search characters" }).fill(stem);
  const cast = page.getByRole("list", { name: "Characters" }).getByRole("link");
  await expect(cast).toHaveCount(36);
  const scroller = page.locator("main [data-skip-target]");
  const far = cast.last();
  await far.scrollIntoViewIfNeeded();
  // Where the gallery stood at the click itself: a click may first scroll its target into view.
  await page.evaluate(() =>
    document.addEventListener(
      "click",
      () => {
        const at = document.querySelector("main [data-skip-target]")?.scrollTop;
        document.body.dataset.left = String(at);
      },
      { capture: true },
    ),
  );
  const left = () => page.evaluate(() => Number(document.body.dataset.left));
  const now = () => scroller.evaluate((element) => element.scrollTop);

  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await far.click();
  await expect(name).toBeVisible();
  const first = await left();
  expect(first).toBeGreaterThan(0);
  await page.getByRole("link", { name: "Characters" }).first().click();
  await expect(far).toBeInViewport();
  expect(await now()).toBeCloseTo(first, 0);

  await far.click();
  await expect(name).toBeVisible();
  const second = await left();
  await page.goBack();
  await expect(far).toBeInViewport();
  expect(await now()).toBeCloseTo(second, 0);
});

test("a failed save says so and retries; leaving with it unsaved asks", async ({ page }) => {
  const name = uniqueName("Mara");
  await importCards(page, [jsonCard("m.json", card(name))]);
  await openSheet(page, name);

  await page.route("**/api/characters/*", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await page.getByLabel("Personality", { exact: true }).fill("Sceptical.");
  await expect(page.getByText("Not saved: can't reach Ephemera. Retrying").first()).toBeVisible();

  await page.getByRole("link", { name: "Characters" }).first().click();
  const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();

  await page.unroute("**/api/characters/*");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("duplicate, export and delete, with a chat draft that is never at risk", async ({ page }) => {
  const name = uniqueName("Ines");
  await importCards(page, [await pngCard("ines.png", card(name))]);
  // A chat draft makes any page navigation ask; exports must not navigate.
  await page.goto("/");
  await page.getByLabel("Message", { exact: true }).fill(canary("draft"));
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Characters" })
    .click();
  await page.getByRole("searchbox", { name: "Search characters" }).fill(name);
  await tile(page, name).click();

  for (const format of ["PNG", "JSON"] as const) {
    await page.getByRole("button", { name: "More actions" }).click();
    const item = page.getByRole("menuitem", { name: `Export as ${format}` });
    const href = (await item.getAttribute("href")) ?? "";
    const download = page.waitForEvent("download");
    await item.click();
    // The browser downloads rather than navigates, under the card's own name.
    const file = await download;
    expect(file.suggestedFilename()).toBe(`${name}.${format.toLowerCase()}`);
    // Playwright sends neither extraHTTPHeaders nor routes with browser downloads, so the
    // download itself meets the owner boundary (SWAG adds the headers in production). The
    // same link is fetched with the owner headers to check what it exports.
    const response = await page.request.get(href);
    expect(response.headers()["content-disposition"]).toContain("attachment;");
    const bytes = Buffer.from(await response.body());
    const exported =
      format === "PNG"
        ? JSON.parse(Buffer.from(pngText(bytes).ephemera ?? "", "base64").toString("utf8"))
        : JSON.parse(bytes.toString("utf8"));
    expect(exported).toMatchObject({
      format: "ephemera.character",
      version: 1,
      data: { name },
    });
    expect(exported.data).not.toHaveProperty("extensions");
    if (format === "PNG") {
      expect(pngText(bytes)).not.toHaveProperty("ccv3");
      expect(pngText(bytes)).not.toHaveProperty("chara");
    }
  }
  expect(dialogs).toBe(0);

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    `${name} (copy)`,
  );
  await expect(page.locator("#s-identity img")).toHaveJSProperty("complete", true);
  // Back is the character it was copied from, loaded again; Forward is the copy.
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  await page.goForward();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    `${name} (copy)`,
  );

  const copyId = page.url().split("/").at(-1) ?? "";
  const { portrait } = await (await page.request.get(`/api/characters/${copyId}`)).json();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: `Delete ${name} (copy)?` });
  await expect(confirm.getByRole("button", { name: "Keep it" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/characters$/);
  expect((await page.request.get(`/api/characters/${copyId}`)).status()).toBe(404);
  expect(
    (await page.request.get(`/api/characters/${copyId}/portrait/image?v=${portrait}`)).status(),
  ).toBe(404);
  await page.getByRole("searchbox", { name: "Search characters" }).fill(name);
  await expect(page.getByRole("list", { name: "Characters" }).getByRole("link")).toHaveCount(1);

  // The chat draft survived all of it.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chat" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/draft/);
});

test("a portrait upload accepts PNG and refuses SVG", async ({ page }) => {
  const name = uniqueName("Kestrel");
  await importCards(page, [jsonCard("k.json", card(name))]);
  await openSheet(page, name);
  const picker = page.locator('#s-identity input[type="file"]');

  await picker.setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from(svg) });
  await expect(
    page.getByRole("alert").filter({ hasText: "Use a PNG, JPEG or WebP image." }),
  ).toBeVisible();

  const png = await pngCard("p.png", card("ignored"), 40, 60);
  await picker.setInputFiles(png);
  await expect(page.locator("#s-identity img")).toHaveJSProperty("complete", true);
  await expect(page.getByRole("button", { name: "Portrait actions" })).toBeVisible();
});

test("the chat speaks as the chosen character, and switching asks first", async ({ page }) => {
  // Three viewports each load the session, generate and confirm two character choices.
  test.setTimeout(60_000);
  const [first, second] = [uniqueName("Seraphina"), uniqueName("Mara")];
  await importCards(page, [
    await pngCard("s.png", card(first ?? "")),
    jsonCard("m.json", card(second ?? "")),
  ]);

  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await openChat(page, "mock-fast");
    await chooseCharacter(page, first ?? "");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(first ?? "");
    // The card's first message opens the chat.
    await expect(lastReply(page)).toContainText(`${first} looks up.`);
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    // The character is present once, at the head of the latest reply (above the story on
    // phones, with its name), not on every turn.
    const presence = page.locator("[data-presence]");
    await expect(presence).toHaveCount(1);
    if (width < 720) await expect(presence).toContainText(first ?? "");
    else await expect(lastReply(page).locator("[data-presence]")).toHaveCount(1);
    const portrait = presence.locator("img");
    await expect(portrait).toHaveJSProperty("complete", true);
    const box = await portrait.boundingBox();
    expect(box?.width).toBe(width >= 1200 ? 160 : width >= 720 ? 112 : 96);
    await expect(messages(page).locator("img")).toHaveCount(width < 720 ? 0 : 1);
    // Who speaks opens the turn, read once with its colon by assistive technology.
    expect(await lastReply(page).evaluate((turn) => turn.textContent)).toMatch(
      new RegExp(`^${first}: `),
    );

    await chooseCharacter(page, second ?? "", { confirm: false });
    await expect(messages(page)).toHaveCount(3);
    await chooseCharacter(page, second ?? "", { confirm: true });
    await expect(messages(page)).toHaveCount(1);
    await expect(lastReply(page)).toContainText(`${second} looks up.`);
  }

  await chooseCharacter(page, "No character");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(page.locator("[data-presence]")).toHaveCount(0);
  expect(await lastReply(page).evaluate((turn) => turn.textContent)).toMatch(/^Model: /);
});

test("an empty library invites an import on the populated gallery's edges", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createCharacterViaApi(page.request, uniqueName("Edges"));
  const header = page.locator("main header");
  const edges = async () => {
    const title = await header.getByRole("heading", { level: 1 }).boundingBox();
    const last = await header.getByRole("button", { name: "Create with AI" }).boundingBox();
    return { left: title?.x ?? Number.NaN, right: (last?.x ?? 0) + (last?.width ?? 0) };
  };
  await page.goto("/characters");
  await expect(page.getByRole("list", { name: "Characters" })).toBeVisible();
  const populated = await edges();

  await page.route("**/api/characters", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { characters: [] } })
      : route.continue(),
  );
  await page.reload();
  const heading = page.getByRole("heading", { name: "No characters yet" });
  await expect(heading).toBeVisible();
  // One container: the header keeps its edges, and the empty state starts on them.
  const empty = await edges();
  expect(Math.abs(empty.left - populated.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(empty.right - populated.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(((await heading.boundingBox())?.x ?? 0) - populated.left)).toBeLessThanOrEqual(1);
  // One first step in the body; the header keeps the others.
  const body = page.locator("main [data-skip-target]");
  await expect(body.getByRole("button")).toHaveCount(1);
  await expect(body.getByRole("button", { name: "Import cards" })).toBeVisible();
});

test("a card without a portrait names its character once, below the cover", async ({ page }) => {
  const name = uniqueName("Unpainted");
  await createCharacterViaApi(page.request, name);
  await page.goto("/characters");
  const card = tile(page, name);
  await expect(card).toBeVisible();
  // The link is still named by the character, and the cover holds no second name.
  await expect(card).toHaveAccessibleName(new RegExp(`^${name}`));
  expect(await card.evaluate((link, text) => link.textContent?.split(text).length ?? 0, name)).toBe(
    2,
  );
  await expect(card.locator("svg[data-icon='Mark']")).toBeVisible();
});

test("on desktop the sheet's optional details wait in Card details", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = uniqueName("Details");
  await createCharacterViaApi(page.request, name, { creator: "Archive", characterVersion: "3" });
  await openSheet(page, name);
  const identity = page.locator("#s-identity");
  const nickname = identity.getByRole("textbox", { name: "Nickname" });
  await expect(identity.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  await expect(nickname).toBeHidden();
  // Closed, its summary says what is set.
  const summary = identity.getByText("Card details", { exact: true });
  await expect(identity.locator("summary")).toContainText("Archive, version 3");
  await summary.click();
  await expect(nickname).toBeVisible();
  await expect(identity.getByRole("textbox", { name: "Creator" })).toHaveValue("Archive");
});

for (const { width, height } of [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 },
]) {
  test(`the gallery and sheet fit at ${width}px and pass axe`, async ({ page }) => {
    const name = uniqueName("Layout");
    await importCards(page, [await pngCard("l.png", card(name))]);
    await page.setViewportSize({ width, height });
    for (const open of [() => page.goto("/characters"), () => openSheet(page, name)]) {
      await open();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // Measure settled colors, not an entrance fade in progress (as in design.spec.ts).
      await expect
        .poll(() =>
          page.evaluate(
            () => document.getAnimations().filter((a) => a instanceof CSSTransition).length,
          ),
        )
        .toBe(0);
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(
        serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
      ).toEqual([]);
    }
  });
}

test("the gallery and sheet work from the keyboard", async ({ page }) => {
  const name = uniqueName("Keys");
  await importCards(page, [jsonCard("k.json", card(name))]);
  await page.goto("/characters");
  const search = page.getByRole("searchbox", { name: "Search characters" });
  await search.focus();
  await page.keyboard.type(name);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Tags" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Filter by tag" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Tags" })).toBeFocused();

  await tile(page, name).focus();
  await page.keyboard.press("Enter");
  const nameField = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(nameField).toHaveValue(name);
  await page.getByRole("button", { name: "More actions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Alternate 1:/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Alternate 1" })).toBeVisible();
});

test("an imported portrait surfaces, and only fades under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const name = uniqueName("Motion");
  await importCards(page, [await pngCard("m.png", card(name))]);
  const transition = await tile(page, name)
    .locator("img")
    .evaluate((img) => getComputedStyle(img).transitionProperty);
  expect(transition).toBe("opacity");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  const second = uniqueName("Motion");
  await importCards(page, [await pngCard("n.png", card(second))]);
  const full = await tile(page, second)
    .locator("img")
    .evaluate((img) => getComputedStyle(img).transitionProperty);
  expect(full).toContain("filter");
});

test("going to the last section keeps the app in place, the sheet header in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  const id = await createCharacterViaApi(page.request, uniqueName("Jump"));
  await page.goto(`/characters/${id}`);
  await page.getByRole("button", { name: "Go to section" }).click();
  await page.getByRole("menuitem", { name: "Creator notes" }).click();
  await expect(page.getByRole("textbox", { name: "Creator notes" })).toBeFocused();
  // Only the sheet scrolls; the app around it never moves, so its header stays at the top.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const moved: number[] = [];
        let element = document.querySelector("[data-skip-target]")?.parentElement ?? null;
        for (; element !== null; element = element.parentElement) moved.push(element.scrollTop);
        return moved.filter((top) => top !== 0);
      }),
    )
    .toEqual([]);
  const header = await page.getByRole("button", { name: "Go to section" }).boundingBox();
  expect(header?.y).toBeGreaterThanOrEqual(0);
});

test("the sheet index marks the section you went to and the one you are editing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await createCharacterViaApi(page.request, uniqueName("Index"));
  await page.goto(`/characters/${id}`);
  const index = page.getByRole("navigation", { name: "On this sheet" });
  const current = index.locator('[aria-current="location"]');
  await index.getByRole("link", { name: "Character's Note" }).click();
  await expect(current).toHaveText("Character's Note");
  await index.getByRole("link", { name: "Description" }).click();
  await expect(current).toHaveText("Description");
  // Editing a field marks its section, even one the band has not reached.
  await page.getByRole("textbox", { name: "Creator notes" }).focus();
  await expect(current).toHaveText("Creator notes");
});
