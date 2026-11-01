import { readFile, rm } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { ART_METAPROMPTS } from "../packages/core/src/creator/prompts.ts";
import { tile } from "./support/cards.ts";
import { beacons, upstreamRecords } from "./support/chat.ts";
import {
  ART_TIMEOUT,
  BRAINSTORM_COPY,
  brainstorm,
  COPY,
  createCard,
  expectBatch,
  IMAGES,
  ideaRows,
  KEEP_WITHOUT_PORTRAIT,
  kindControl,
  listCharacters,
  portraits,
  recordArt,
  showcaseAction,
} from "./support/creator.ts";
import {
  brainstormIdea,
  brainstormRequest,
  cardName,
  keptBase,
  mark,
  ownerDescription,
} from "./support/creator-fixtures.ts";
import { choose, createCharacterViaApi, patchSettings } from "./support/entities.ts";
import { APP_SERVERS, canary } from "./support/env.ts";
import { expectStorageEmpty, expectUrlsClean, openProfile } from "./support/retention.ts";
import { dataDirContaining, filesContaining, holds } from "./support/scan.ts";
import { appOrigin, expect, test } from "./support/test.ts";

/*
 * AI card creation against the mock upstream and the mock ComfyUI
 * (e2e/support/mock-comfyui.ts). Kept cards are ordinary character data, so
 * their marks are not retention canaries; the drafts' marks are scanned for here.
 */

const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 2 });

/** The gallery's confirmation after Keep. */
const keptNote = (page: Page, name: string) =>
  page.getByRole("status").filter({ hasText: `Kept ${name}` });

test("Subject: written, four portraits, another picked, and Keep saves exactly one card and its portrait", async ({
  browserName,
  comfy,
  playwright,
  request,
  user,
}) => {
  // A persistent profile, two scans of every server directory and of the profile.
  test.setTimeout(90_000);
  const server = Object.values(APP_SERVERS).find((entry) => entry.origin === appOrigin());
  if (server === undefined) throw new Error("the project names no known app server");
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const name = cardName("subject", base);
  const profile = await openProfile(playwright[browserName], appOrigin(), user);
  const { context, page } = profile;
  try {
    const before = await listCharacters(request);
    const art = await recordArt(page);
    await createCard(page, {
      kind: "subject",
      description: ownerDescription(base),
      model: "mock-fast",
    });
    await expect(heading(page, name)).toBeVisible();
    await expect(page.locator("main")).toContainText(mark(base, "card"));
    await art.expectPortraits(base);
    const radios = portraits(page).getByRole("radio");
    await expectBatch(page);
    await expect(radios.first()).toHaveAccessibleName(`Portrait of ${name}, option 1 of 4`);
    await expect(radios.nth(0)).toHaveAttribute("aria-checked", "true");
    await radios.nth(2).click();
    await expect(radios.nth(2)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(0)).toHaveAttribute("aria-checked", "false");

    // Keep sends the picked portrait, and only it, through the existing upload.
    const upload = page.waitForRequest(
      (candidate) =>
        candidate.method() === "PUT" &&
        /^\/api\/characters\/[\w-]+\/portrait$/.test(new URL(candidate.url()).pathname),
    );
    await page.getByRole("button", { name: COPY.subject.keep }).click();
    const sent = (await upload).postDataBuffer() ?? Buffer.alloc(0);
    expect(IMAGES.map((image) => holds(sent, mark(base, image)))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    await expect(keptNote(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
    await expect(page).toHaveURL(/\/characters$/);
    await expect(tile(page, name).locator("img")).toHaveAttribute(
      "src",
      /^\/api\/characters\/[0-9a-f-]+\/portrait\/image\?size=thumb&v=\d+$/,
    );

    const after = await listCharacters(request);
    expect(after).toHaveLength(before.length + 1);
    const kept = after.filter((character) => character.name === name);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.portrait).toEqual(expect.any(Number));
    const portrait = await request.get(`/api/characters/${kept[0]?.id}/portrait/image`);
    expect(portrait.status()).toBe(200);
    await scope.expectClean();
    await context.close();
    expect(profile.policyViolations, "Content Security Policy violations").toEqual([]);

    /** Where each mark was found: the server's data, temp and home directories, its log, the profile. */
    const log = await readFile(server.log);
    const found = async (what: Parameters<typeof mark>[1]) => {
      const needle = mark(base, what);
      const places: string[] = [];
      for (const [hop, dir] of [
        ["data", server.data],
        ["tmp", server.tmp],
        ["home", server.home],
        ["profile", profile.dir],
      ] as const) {
        const scan =
          hop === "data"
            ? await dataDirContaining(dir, needle)
            : await filesContaining(dir, needle);
        expect(scan.unreadable, `${hop} unverified`).toEqual([]);
        if (scan.hits.length > 0) places.push(hop);
      }
      if (holds(log, needle)) places.push("log");
      return places;
    };
    // The kept card is character data now; nothing else of the draft persisted anywhere.
    expect(await found("card")).toEqual(["data"]);
    for (const draft of ["desc", "prompt", ...IMAGES] as const) {
      // The picked portrait is kept re-encoded, its text chunk stripped, so its mark is gone too.
      expect(await found(draft), draft).toEqual([]);
    }
  } finally {
    await context.close();
    await rm(profile.dir, { recursive: true, force: true });
  }
});

test("Scenario: written with portraits from Atelier's private worker and kept with the first", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "private" });
  const base = keptBase();
  const name = cardName("scenario", base);
  const art = await recordArt(page);
  await createCard(page, {
    kind: "scenario",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expect(heading(page, name)).toBeVisible();
  await art.expectPortraits(base);
  await expectBatch(page);
  await page.getByRole("button", { name: COPY.scenario.keep }).click();
  await expect(keptNote(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  await expect(tile(page, name).locator("img")).toHaveAttribute(
    "src",
    /\/portrait\/image\?size=thumb/,
  );
  const kept = (await listCharacters(request)).filter((character) => character.name === name);
  expect(kept).toEqual([expect.objectContaining({ portrait: expect.any(Number) })]);
  // The lease was released: the private worker holds nothing of the run.
  await scope.expectClean();
  expect((await scope.state()).released).toBe(1);
});

test("without a ComfyUI address the card is kept without art", async ({ page, request }) => {
  const base = keptBase();
  const name = cardName("subject", base);
  const arts: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/creator/art") arts.push(sent.url());
  });
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expect(heading(page, name)).toBeVisible();
  await expect(page.getByText("Portraits off", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT }).click();
  await expect(keptNote(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  const kept = (await listCharacters(request)).filter((character) => character.name === name);
  expect(kept).toEqual([expect.objectContaining({ portrait: null })]);
  expect(arts).toEqual([]);
});

test("Keep opens the gallery at the top, its note in view, however far it was scrolled", async ({
  page,
}) => {
  const base = keptBase();
  const name = cardName("subject", base);
  const shelf = keptBase();
  await Promise.all(
    Array.from({ length: 24 }, (_, at) => createCharacterViaApi(page.request, `${shelf} ${at}`)),
  );
  await page.goto("/characters");
  const scroller = page.locator("main [data-skip-target]");
  await expect(
    page.getByRole("list", { name: "Characters" }).getByRole("link").first(),
  ).toBeVisible();
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
    onGallery: true,
  });
  await expect(heading(page, name)).toBeVisible();
  await page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT }).click();
  await expect(keptNote(page, name)).toBeInViewport({ timeout: ART_TIMEOUT });
  await expect(tile(page, name)).toBeInViewport();
});

test("Multiple Subjects: written with both characters and kept as one card", async ({
  page,
  request,
}) => {
  const base = keptBase();
  const name = cardName("group", base);
  await createCard(page, {
    kind: "group",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expect(heading(page, name)).toBeVisible();
  const picker = page.getByRole("combobox", { name: "Subject" });
  await expect(picker).toHaveText("Ada Reed");
  await picker.click();
  await page.getByRole("option", { name: "Bo Lind" }).click();
  await expect(picker).toHaveText("Bo Lind");
  await page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT }).click();
  await expect(keptNote(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  const kept = (await listCharacters(request)).filter((character) => character.name === name);
  expect(kept).toHaveLength(1);
});

test("a ComfyUI failure says portraits are unavailable and the card can still be kept", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain", fail: true });
  const base = keptBase();
  const name = cardName("subject", base);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expect(
    page.getByText("Portraits unavailable. Try the art again or keep the card without it."),
  ).toBeVisible({ timeout: ART_TIMEOUT });
  await expect(page.getByRole("button", { name: "Try the art again" })).toBeVisible();
  await expect(portraits(page)).toHaveCount(0);
  await scope.expectClean();
  await page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT }).click();
  await expect(keptNote(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  const kept = (await listCharacters(request)).filter((character) => character.name === name);
  expect(kept).toEqual([expect.objectContaining({ portrait: null })]);
});

test("a failed New art keeps the current portraits and the choice", async ({ comfy, page }) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  const radios = portraits(page).getByRole("radio");
  await expectBatch(page);
  await radios.nth(1).click();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  await scope.expectClean();
  // ComfyUI now fails every run.
  await scope.configure({ mode: "plain", fail: true });
  await page.getByRole("button", { name: "New art" }).click();
  await expect(page.getByText("New art failed. The current portraits are kept.")).toBeVisible({
    timeout: ART_TIMEOUT,
  });
  await expectBatch(page);
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  await scope.expectClean();
  expect((await scope.state()).prompts).toBe(1);
});

test("the workflow under New art paints the next batch without writing the card again", async ({
  comfy,
  page,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  let cards = 0;
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/creator/card") cards += 1;
  });
  const art = await recordArt(page);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await art.expectPortraits(base);
  await expectBatch(page);
  const newArt = page.getByRole("button", { name: "New art" });
  const workflow = page.getByRole("combobox", { name: "Workflow", exact: true });
  await expect(workflow).toHaveText("Krea 2 Gonzalomo");

  // The mock ComfyUI holds only the default workflow's model files.
  await choose(page, "Workflow", "Krea 2 Second");
  const checked = page.waitForRequest("**/api/creator/art/status?*");
  await newArt.click();
  expect(new URL((await checked).url()).searchParams.get("workflow")).toBe("krea2-second");
  await expect(page.getByText("New art failed. The current portraits are kept.")).toBeVisible({
    timeout: ART_TIMEOUT,
  });
  await expect(page.getByText(/missing nodes or models the chosen workflow needs/)).toBeVisible();
  await expectBatch(page);

  await choose(page, "Workflow", "Krea 2 Gonzalomo");
  const painted = page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/creator/art" && sent.method() === "POST",
  );
  await newArt.click();
  expect((await painted).postDataJSON()).toMatchObject({ workflow: "krea2-gonzalomo" });
  // A second whole batch, painted and shown; the skipped run reached neither the app server's art route nor ComfyUI.
  await art.expectPortraits(base, 2);
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  await expect(page.getByText("New art failed")).toHaveCount(0);
  await expectBatch(page);
  expect((await scope.state()).prompts).toBe(2);
  await scope.expectClean();
  expect(cards).toBe(1);
});

test("Subject composition is chosen before its first batch and changed with the prompt model under New art", async ({
  comfy,
  page,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  let cards = 0;
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/creator/card") cards += 1;
  });
  const artRequest = () =>
    page.waitForRequest(
      (sent) => new URL(sent.url()).pathname === "/api/creator/art" && sent.method() === "POST",
    );
  const art = await recordArt(page);
  await page.goto("/characters");
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await page.locator('[data-kind="subject"]').click();
  await page.getByRole("textbox", { name: COPY.subject.field }).fill(ownerDescription(base));
  await choose(page, "Model", "mock-fast");
  await choose(page, "Reasoning", "Extra high");
  const composition = page.getByRole("group", { name: "Composition", exact: true });
  await expect(composition.getByRole("button", { name: "Regular", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await composition.getByRole("button", { name: "Diptych", exact: true }).click();
  const first = artRequest();
  await page.getByRole("button", { name: COPY.subject.create }).click();
  expect((await first).postDataJSON()).toMatchObject({
    model: "mock-fast",
    reasoning: "xhigh",
    composition: "diptych",
  });
  await art.expectPortraits(base);
  await expectBatch(page);

  const promptModel = page.getByRole("combobox", { name: "Prompt model", exact: true });
  await expect(promptModel).toHaveText("mock-fast");
  // mock-lowonly offers only low reasoning, so its image prompt goes at the model default.
  await choose(page, "Prompt model", "mock-lowonly");
  await expect(composition.getByRole("button", { name: "Diptych", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await composition.getByRole("button", { name: "Regular", exact: true }).click();
  const next = artRequest();
  const newArt = page.getByRole("button", { name: "New art" });
  await newArt.click();
  const sent = (await next).postDataJSON();
  expect(sent).toMatchObject({ model: "mock-lowonly", composition: "regular" });
  expect(sent).not.toHaveProperty("reasoning");
  await art.expectPortraits(base, 2);
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  await expect(page.getByText("New art failed")).toHaveCount(0);
  await expect(promptModel).toHaveText("mock-lowonly");

  // Its own effort, from the levels the model offers.
  const reasoning = page.getByRole("combobox", { name: "Reasoning", exact: true });
  await expect(reasoning).toHaveText("Model default");
  await choose(page, "Reasoning", "Low");
  const third = artRequest();
  await newArt.click();
  expect((await third).postDataJSON()).toMatchObject({ model: "mock-lowonly", reasoning: "low" });
  await art.expectPortraits(base, 3);
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  await scope.expectClean();
  expect(cards).toBe(1);
});

test("Settings' image prompt model writes the first batch's prompt and leads the Prompt model", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  await patchSettings(request, { imagePromptModel: "mock-lowonly" });
  const art = await recordArt(page);
  const first = page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/creator/art" && sent.method() === "POST",
  );
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  expect((await first).postDataJSON()).toMatchObject({ model: "mock-lowonly" });
  await art.expectPortraits(base);
  await expect(page.getByRole("combobox", { name: "Prompt model", exact: true })).toHaveText(
    "mock-lowonly",
  );
  await scope.expectClean();
});

test("Look is chosen before the first batch, rides as a look tag, and Auto sends none", async ({
  comfy,
  page,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const artRequest = () =>
    page.waitForRequest(
      (sent) => new URL(sent.url()).pathname === "/api/creator/art" && sent.method() === "POST",
    );
  const art = await recordArt(page);
  await page.goto("/characters");
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await page.locator('[data-kind="subject"]').click();
  await page.getByRole("textbox", { name: COPY.subject.field }).fill(ownerDescription(base));
  await choose(page, "Model", "mock-fast");
  await expect(page.getByRole("combobox", { name: "Look", exact: true })).toHaveText("Auto");
  await choose(page, "Look", "Vintage film");
  const first = artRequest();
  await page.getByRole("button", { name: COPY.subject.create }).click();
  expect((await first).postDataJSON()).toMatchObject({ look: "film" });
  await art.expectPortraits(base);
  await expectBatch(page);
  // The metaprompt stays the approved one; the owner's look follows the notes in the user turn.
  const [call] = (await upstreamRecords(mark(base, "card"))).filter(
    (record) => record.messages[0]?.content === ART_METAPROMPTS.krea2.subject,
  );
  expect(call?.messages[1]?.content).toContain("<look>\nfilm\n</look>");

  const newArt = page.getByRole("button", { name: "New art" });
  await expect(page.getByRole("combobox", { name: "Look", exact: true })).toHaveText(
    "Vintage film",
  );
  await choose(page, "Look", "Auto");
  const next = artRequest();
  await newArt.click();
  expect((await next).postDataJSON()).not.toHaveProperty("look");
  await art.expectPortraits(base, 2);
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  await scope.expectClean();
});

test("a direction under the four steers the next image prompt, and Enter paints it", async ({
  comfy,
  page,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const direction = `Golden hour on a rooftop ${mark(base, "steer")}`;
  const art = await recordArt(page);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await art.expectPortraits(base);
  await expectBatch(page);

  const field = page.getByRole("textbox", { name: "Direction for the next art" });
  await field.fill(`  ${direction}  `);
  const painted = page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/creator/art" && sent.method() === "POST",
  );
  await field.press("Enter");
  expect((await painted).postDataJSON()).toMatchObject({ direction });
  await art.expectPortraits(base, 2);
  await expect(page.getByRole("button", { name: "New art" })).toBeEnabled({
    timeout: ART_TIMEOUT,
  });
  // The approved metaprompt goes as it is; the direction follows the notes in the user turn.
  const [call] = await upstreamRecords(mark(base, "steer"));
  expect(call?.messages[0]).toEqual({ role: "system", content: ART_METAPROMPTS.krea2.subject });
  expect(call?.messages[1]?.content.endsWith(`<direction>\n${direction}\n</direction>`)).toBe(true);
  // It stays to be refined, without a line break from Enter.
  await expect(field).toHaveValue(`  ${direction}  `);
  await scope.expectClean();
});

test("Discard returns to the description with its text kept", async ({ page, request }) => {
  const base = keptBase();
  const description = ownerDescription(base);
  const name = cardName("subject", base);
  const before = await listCharacters(request);
  await createCard(page, { kind: "subject", description, model: "mock-fast" });
  await expect(heading(page, name)).toBeVisible();
  await showcaseAction(page, "Discard");
  await expect(page.getByRole("textbox", { name: COPY.subject.field })).toHaveValue(description);
  await expect(heading(page, name)).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(mark(base, "card"));
  expect(await listCharacters(request)).toHaveLength(before.length);
});

test("a card cut off at the output ceiling says the model ran out of room", async ({ page }) => {
  const base = keptBase();
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base, "cut"),
    model: "mock-fast",
  });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The model ran out of room before the card was complete." }),
  ).toContainText("choose a lower reasoning effort");
  // What was written stays; nothing was sent again.
  await expect(page.locator("main")).toContainText(cardName("subject", base));
  expect(await upstreamRecords(mark(base, "desc"))).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Rewrite" })).toBeVisible();
  await expect(page.getByRole("button", { name: COPY.subject.keep })).toHaveCount(0);
});

test("a first draft missing parts is written again at once and ends as a valid card", async ({
  page,
}) => {
  const base = keptBase();
  const name = cardName("subject", base);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base, "retry"),
    model: "mock-fast",
  });
  await expect(
    page.getByText("The first draft was missing parts, so the card is being written again."),
  ).toBeVisible();
  await expect(heading(page, name)).toBeVisible();
  await expect(page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT })).toBeVisible();
  await expect(page.getByText("The first draft was missing parts", { exact: false })).toHaveCount(
    0,
  );
  // The first draft is gone from the screen; the second is the card shown.
  await expect(page.locator("main")).not.toContainText(mark(base, "draft"));
  await expect(page.locator("main")).toContainText(mark(base, "card"));
  const calls = await upstreamRecords(mark(base, "desc"));
  expect(calls).toHaveLength(2);
  expect(calls[1]?.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
  ]);
});

test("while the model thinks, the Writing screen says so until the card's text arrives", async ({
  page,
}) => {
  const base = keptBase();
  const name = cardName("subject", base);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base, "think"),
    model: "mock-fast",
  });
  const thinking = page.getByRole("main").getByText("Thinking", { exact: true });
  await expect(thinking.first()).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "The model is thinking." })).toHaveCount(
    1,
  );
  await expect(heading(page, name)).toBeVisible();
  await expect(thinking).toHaveCount(0);
  // Nothing of the reasoning reached the page.
  await expect(page.locator("main")).not.toContainText("Weighing the card");
});

test("a typed model ID the provider does not list is kept and written with", async ({ page }) => {
  const typed = "vendor/typed-writer";
  await page.goto("/characters");
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await page.locator('[data-kind="subject"]').click();
  await page.getByRole("textbox", { name: COPY.subject.field }).fill(ownerDescription(keptBase()));
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await model.click();
  await page.getByRole("combobox", { name: "Find a model", exact: true }).fill(typed);
  await page.keyboard.press("Enter");
  await expect(model).toHaveText(typed);
  // Kept through a change of kind, not dropped for being unlisted.
  await page.getByRole("button", { name: "Change from Subject" }).click();
  await page.locator('[data-kind="subject"]').click();
  await expect(model).toHaveText(typed);
  const sent = page.waitForRequest("**/api/creator/card");
  await page.getByRole("button", { name: COPY.subject.create }).click();
  expect((await sent).postDataJSON()).toMatchObject({ model: typed });
});

test("the reasoning effort narrows to the model's levels and goes with the card request", async ({
  page,
}) => {
  const base = keptBase();
  await page.goto("/characters");
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await page.locator('[data-kind="subject"]').click();
  await page.getByRole("textbox", { name: COPY.subject.field }).fill(ownerDescription(base));
  const reasoning = page.getByRole("combobox", { name: "Reasoning", exact: true });

  await choose(page, "Model", "mock-lowonly");
  await reasoning.click();
  await expect(page.getByRole("option")).toHaveText(["Model default", "Low"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  await choose(page, "Model", "mock-fast");
  await choose(page, "Reasoning", "Extra high");
  // A model without the level writes at its default; the pick returns with a model that has it.
  await choose(page, "Model", "mock-lowonly");
  await expect(reasoning).toHaveText("Model default");
  await choose(page, "Model", "mock-fast");
  await expect(reasoning).toHaveText("Extra high");
  // Model default chosen while it stands in for the pick replaces the pick.
  await choose(page, "Model", "mock-lowonly");
  await choose(page, "Reasoning", "Model default");
  await choose(page, "Model", "mock-fast");
  await expect(reasoning).toHaveText("Model default");
  // A pick made after the screen opened with one survives a model without it.
  await choose(page, "Reasoning", "Low");
  await page.getByRole("button", { name: "Change from Subject" }).click();
  await page.locator('[data-kind="subject"]').click();
  await expect(reasoning).toHaveText("Low");
  await choose(page, "Reasoning", "Maximum");
  await choose(page, "Model", "mock-lowonly");
  await expect(reasoning).toHaveText("Model default");
  await choose(page, "Model", "mock-fast");
  await expect(reasoning).toHaveText("Maximum");
  await choose(page, "Reasoning", "Extra high");

  const sent = page.waitForRequest("**/api/creator/card");
  await page.getByRole("button", { name: COPY.subject.create }).click();
  expect((await sent).postDataJSON()).toMatchObject({ model: "mock-fast", reasoning: "xhigh" });
  await expect(heading(page, cardName("subject", base))).toBeVisible();
});

test("the portrait workflow is chosen beside the model, checked against ComfyUI and kept", async ({
  comfy,
  page,
}) => {
  const openDescribe = async () => {
    await page.goto("/characters");
    await page.getByRole("button", { name: "Create with AI" }).first().click();
    await page.locator('[data-kind="subject"]').click();
  };
  const workflow = page.getByRole("combobox", { name: "Workflow", exact: true });
  const portraitsStatus = (state: string) =>
    page.getByRole("button", { name: `Portraits ${state}: details` });

  // Without a ComfyUI address there is nothing to choose.
  await openDescribe();
  await expect(portraitsStatus("off")).toBeVisible();
  await expect(workflow).toHaveCount(0);

  await comfy({ mode: "plain" });
  await openDescribe();
  await expect(workflow).toHaveText("Krea 2 Gonzalomo");
  await expect(portraitsStatus("available")).toBeVisible();
  await workflow.click();
  // The bundled workflows and, in file name order among them, the external directory's.
  await expect(page.getByRole("option")).toContainText(["Krea 2 Gonzalomo", "Krea 2 Second"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  // The mock ComfyUI holds only the default workflow's model files.
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/settings" &&
      response.request().method() === "PATCH",
  );
  await choose(page, "Workflow", "Krea 2 Second");
  await expect(portraitsStatus("unavailable")).toBeVisible();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await openDescribe();
  await expect(workflow).toHaveText("Krea 2 Second");

  await choose(page, "Workflow", "Krea 2 Gonzalomo");
  await expect(portraitsStatus("available")).toBeVisible();
});

test("leaving while Keep saves waits for it, saying so, and the card is kept once", async ({
  page,
  request,
}) => {
  const base = keptBase();
  const name = cardName("subject", base);
  const before = await listCharacters(request);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/characters", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expect(heading(page, name)).toBeVisible();
  await page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT }).click();
  await expect(page.getByRole("button", { name: "Keeping…" })).toBeVisible();

  await page.getByRole("main").getByRole("link", { name: "Characters", exact: true }).click();
  const guard = page.getByRole("alertdialog", { name: "Keeping this character…" });
  await expect(guard).toBeVisible();
  // Nothing offers to lose a card that is being saved.
  await expect(guard.getByRole("button", { name: "Leave" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/characters\/create$/);

  release();
  await expect(page).toHaveURL(/\/characters$/, { timeout: ART_TIMEOUT });
  const after = await listCharacters(request);
  expect(after).toHaveLength(before.length + 1);
  expect(after.filter((character) => character.name === name)).toHaveLength(1);
});

test("a failed portrait upload leaves the card kept and Try the portrait again completes it", async ({
  comfy,
  page,
  request,
}) => {
  await comfy({ mode: "plain" });
  const base = keptBase();
  const name = cardName("subject", base);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expectBatch(page);
  const uploads = "**/api/characters/*/portrait";
  await page.route(uploads, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "internal" } })
      : route.continue(),
  );
  await page.getByRole("button", { name: COPY.subject.keep }).click();
  await expect(page.getByRole("alert")).toContainText(`Kept ${name} without its portrait.`, {
    timeout: ART_TIMEOUT,
  });
  const retry = page.getByRole("button", { name: "Try the portrait again" });
  await expect(retry).toBeVisible();
  let kept = (await listCharacters(request)).filter((character) => character.name === name);
  expect(kept).toEqual([expect.objectContaining({ portrait: null })]);

  await page.unroute(uploads);
  await retry.click();
  await expect(keptNote(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  kept = (await listCharacters(request)).filter((character) => character.name === name);
  expect(kept).toEqual([expect.objectContaining({ portrait: expect.any(Number) })]);
});

test("the Portraits group is chosen with the keyboard", async ({ comfy, page }) => {
  await comfy({ mode: "plain" });
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(keptBase()),
    model: "mock-fast",
  });
  const radios = portraits(page).getByRole("radio");
  await expectBatch(page);
  await radios.nth(0).focus();
  const expectChosen = async (index: number) => {
    await expect(radios.nth(index)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(index)).toBeFocused();
    // One stop in the tab order: the chosen option.
    await expect(portraits(page).locator('[tabindex="0"]')).toHaveAttribute(
      "data-option",
      String(index),
    );
  };
  for (const [key, index] of [
    ["ArrowRight", 1],
    ["ArrowDown", 2],
    ["End", 3],
    ["ArrowRight", 0],
    ["ArrowLeft", 3],
    ["Home", 0],
  ] as const) {
    await page.keyboard.press(key);
    await expectChosen(index);
  }
});

test("the chosen portrait opens larger and lays back in its place by Close or a click beside it", async ({
  comfy,
  page,
}) => {
  await comfy({ mode: "plain" });
  const base = keptBase();
  const name = cardName("subject", base);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expectBatch(page);
  const label = `Portrait of ${name}, option 1 of 4`;
  // A CSS locator, as the modal viewer hides the rest of the page from the accessibility tree.
  const trigger = page.locator(`button[aria-label="${label}: show larger"]`);
  const viewer = page.getByRole("dialog", { name: label });
  const frame = await trigger.boundingBox();

  await trigger.click();
  await expect(viewer).toBeVisible();
  await expect(trigger).toHaveCSS("visibility", "hidden");
  const art = viewer.getByRole("img", { name: label });
  await expect
    .poll(async () => (await art.boundingBox())?.height ?? 0)
    .toBeGreaterThan(frame?.height ?? Infinity);
  await viewer.getByRole("button", { name: "Close the portrait" }).click();
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toHaveCSS("visibility", "visible");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(viewer).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // By keyboard, its focus drawn inside the frame, which clips anything outside.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS("outline-style", "solid");
  await expect(trigger).toHaveCSS("outline-offset", "-4px");
  await page.keyboard.press("Enter");
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Stop ends New art at once, keeps the portraits and the choice, and returns focus to New art", async ({
  comfy,
  page,
}) => {
  await comfy({ mode: "plain" });
  const base = keptBase();
  // New art reaches the server only once released.
  let runs = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/creator/art", async (route) => {
    if (++runs > 1) await held;
    await route.continue().catch(() => {});
  });
  try {
    await createCard(page, {
      kind: "subject",
      description: ownerDescription(base),
      model: "mock-fast",
    });
    const radios = portraits(page).getByRole("radio");
    await expectBatch(page);
    await radios.nth(2).click();
    const newArt = page.getByRole("button", { name: "New art" });
    await newArt.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Writing the image prompt" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(newArt).toBeEnabled();
    await expect(newArt).toBeFocused();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(page.getByText("New art failed")).toHaveCount(0);
    await expectBatch(page);
    await expect(radios.nth(2)).toHaveAttribute("aria-checked", "true");

    // A run that ends while Stop holds focus hands it to New art, not to the page.
    await newArt.click();
    const stop = page.getByRole("button", { name: "Stop" });
    await stop.focus();
    release();
    await expect(newArt).toBeFocused({ timeout: ART_TIMEOUT });
    await expect(stop).toHaveCount(0);
    await expectBatch(page);
  } finally {
    release();
  }
});

test("new art arriving while the portrait is open replaces it in the viewer", async ({
  comfy,
  page,
}) => {
  await comfy({ mode: "plain" });
  const base = keptBase();
  const name = cardName("subject", base);
  // New art waits until the viewer is open.
  let runs = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/creator/art", async (route) => {
    if (++runs > 1) await held;
    await route.continue();
  });
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expectBatch(page);
  const newArt = page.getByRole("button", { name: "New art" });
  await newArt.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Writing the image prompt" }),
  ).toBeVisible();
  await expect(newArt).toBeDisabled();
  const label = `Portrait of ${name}, option 1 of 4`;
  const trigger = page.locator(`button[aria-label="${label}: show larger"]`);
  const viewer = page.getByRole("dialog", { name: label });
  await trigger.click();
  await expect(viewer).toBeVisible();
  release();
  // The open viewer hides the page from role queries; Stop leaves once the new batch is whole.
  await expect(page.locator("button").filter({ hasText: /^Stop$/ })).toHaveCount(0, {
    timeout: ART_TIMEOUT,
  });
  await expect(viewer.getByRole("img", { name: label })).toBeVisible();
  await viewer.getByRole("button", { name: "Close the portrait" }).click();
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectBatch(page);
});

test("under reduced motion the reveal completes and the art arriving moves no focus", async ({
  comfy,
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await comfy({ mode: "plain" });
  const base = keptBase();
  // The art waits until the owner's focus is placed.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/creator/art", async (route) => {
    await held;
    await route.continue();
  });
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expect(heading(page, cardName("subject", base))).toBeVisible();
  // Keeping before the portraits arrive is allowed, and says what it keeps.
  await expect(page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT })).toBeVisible();
  const more = page.getByRole("button", { name: "More" });
  await more.focus();
  await expect(more).toBeFocused();
  release();
  await expectBatch(page);
  await expect(page.getByRole("button", { name: COPY.subject.keep })).toBeVisible();
  await expect(more).toBeFocused();
  // The frame and the alternates end fully shown, without the blur of the full reveal.
  const frame = page.locator("canvas.develop-in");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveCSS("filter", "none");
  await expect(frame).toHaveCSS("opacity", "1");
  await expect(portraits(page)).toHaveCSS("opacity", "1");
  await expect(more).toBeFocused();
});

test("a card's markdown image, link and raw HTML load nothing and link nowhere", async ({
  page,
}) => {
  const base = keptBase();
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-hostile",
  });
  await expect(heading(page, cardName("subject", base))).toBeVisible();
  const main = page.locator("main");
  await expect(main).toContainText(mark(base, "card"));
  // The prose is there as text: the link's words, the raw tag and the bare URL.
  await expect(main).toContainText("the harbour board");
  await expect(main.locator("img")).toHaveCount(0);
  await expect(main.locator('a[href*="__beacon"], a[href^="javascript:"]')).toHaveCount(0);
  await expect(main.locator("script")).toHaveCount(0);
  expect(await page.title()).not.toBe("owned");
  const sent = await beacons();
  expect(sent.filter((path) => path.startsWith("/__beacon/creator"))).toEqual([]);
});

/** The brainstorm's status line, by its text. */
const ideasStatus = (page: Page, text: string | RegExp) =>
  page.getByRole("status").filter({ hasText: text });

test("Brainstorm: classified, adjusted, switched and picked into Describe, then written as a card", async ({
  page,
}) => {
  const base = canary("brainstorm");
  const request = brainstormRequest(base, { kind: "scenario" });
  await brainstorm(page, { request, model: "mock-fast" });
  const kinds = kindControl(page);
  const rows = ideaRows(page);
  await kinds.expectSelected("scenario");
  await expect(rows).toHaveCount(10);
  await expect(ideasStatus(page, BRAINSTORM_COPY.complete)).toBeVisible();
  const first = (n: number) => brainstormIdea("scenario", base, 1, n).pitch;
  await expect(rows.nth(2)).toContainText(first(3));
  await expect(rows.first()).toContainText(mark(base, "idea"));
  // The classifier and the list each got the request as it was typed.
  expect(await upstreamRecords(mark(base, "ask"))).toHaveLength(2);

  // Feedback keeps 3 and 7 word for word; the rest are fresh.
  const feedback = page.getByRole("textbox", { name: BRAINSTORM_COPY.feedback });
  await feedback.fill(`Keep 3 and 7 and make the rest darker. ${mark(base, "tune")}`);
  await page.getByRole("button", { name: BRAINSTORM_COPY.more }).click();
  await expect(rows.first()).toContainText(brainstormIdea("scenario", base, 2, 1).pitch);
  await expect(rows).toHaveCount(10);
  await expect(rows.nth(2)).toContainText(first(3));
  await expect(rows.nth(6)).toContainText(first(7));
  await expect(rows.nth(1)).toContainText(brainstormIdea("scenario", base, 2, 2).pitch);
  const tuned = await upstreamRecords(mark(base, "ask"));
  expect(tuned).toHaveLength(3);
  expect(JSON.stringify(tuned.at(-1)?.messages)).toContain(mark(base, "tune"));

  // Another kind brings ten of it.
  await kinds.choose("subject");
  await kinds.expectSelected("subject");
  const third = (n: number) => brainstormIdea("subject", base, 3, n).pitch;
  await expect(rows.first()).toContainText(third(1));
  await expect(rows).toHaveCount(10);
  await expect(ideasStatus(page, BRAINSTORM_COPY.complete)).toBeVisible();

  // Change to the tiles and back: the request, the kind and the list are where they were.
  await page.getByRole("button", { name: BRAINSTORM_COPY.change }).click();
  await expect(page.locator('[data-kind="subject"]')).toBeVisible();
  await page.locator('[data-stage="brainstorm"]').click();
  await expect(
    page.getByRole("button", { name: new RegExp(BRAINSTORM_COPY.requestPrefix) }),
  ).toContainText(mark(base, "ask"));
  await kinds.expectSelected("subject");
  await expect(rows).toHaveCount(10);
  await expect(rows.nth(4)).toContainText(third(5));

  // A pick opens Describe of its kind with the brief; Back to ideas marks the picked row.
  await rows
    .nth(2)
    .getByRole("button", { name: BRAINSTORM_COPY.row(3, third(3)) })
    .click();
  const describe = page.getByRole("textbox", { name: COPY.subject.field });
  await expect(describe).toHaveValue(brainstormIdea("subject", base, 3, 3).brief);
  await page.getByRole("button", { name: BRAINSTORM_COPY.back }).click();
  await expect(
    page.getByRole("list", { name: BRAINSTORM_COPY.list }).locator('[aria-current="true"]'),
  ).toContainText(third(3));

  await rows
    .nth(4)
    .getByRole("button", { name: BRAINSTORM_COPY.row(5, third(5)) })
    .click();
  await expect(describe).toHaveValue(brainstormIdea("subject", base, 3, 5).brief);
  await choose(page, "Model", "mock-fast");
  await page.getByRole("button", { name: COPY.subject.create }).click();
  await expect(heading(page, cardName("subject", base))).toBeVisible();
  await expect(page.locator("main")).toContainText(mark(base, "card"));

  await expectStorageEmpty(page);
  await expectUrlsClean(page);
});

test("Brainstorm: Stop keeps the ideas that arrived, and New ideas can follow", async ({
  page,
}) => {
  const base = canary("brainstorm-stop");
  await brainstorm(page, {
    request: brainstormRequest(base, { kind: "scenario" }),
    model: "mock-slow",
  });
  await expect(ideaRows(page).first()).toContainText(mark(base, "idea"));
  await page.getByRole("button", { name: BRAINSTORM_COPY.stop, exact: true }).click();
  await expect(ideasStatus(page, /Stopped\. \d+ ideas? so far\./)).toBeVisible();
  // The list call was cut off; the classifier had finished.
  await expect
    .poll(async () => (await upstreamRecords(mark(base, "ask"))).map((record) => record.aborted))
    .toEqual([false, true]);
  await expect(page.getByRole("button", { name: BRAINSTORM_COPY.more })).toBeEnabled();
});

test("Brainstorm: a short list says so, and a failed round leaves the list listed", async ({
  page,
}) => {
  const base = canary("brainstorm-short");
  await brainstorm(page, {
    request: brainstormRequest(base, { kind: "group", script: "short" }),
    model: "mock-fast",
  });
  const rows = ideaRows(page);
  // Seven, then eight when asked again: the best attempt is shown.
  await expect(ideasStatus(page, BRAINSTORM_COPY.short(8))).toBeVisible();
  await expect(rows).toHaveCount(8);

  await choose(page, "Model", "mock-error");
  await page.getByRole("button", { name: BRAINSTORM_COPY.more }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: BRAINSTORM_COPY.alerts.upstream }),
  ).toBeVisible();
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toContainText(brainstormIdea("group", base, 1, 1).pitch);
});

test("Brainstorm: leaving the screen mid-round drops the session", async ({ page }) => {
  const base = canary("brainstorm-leave");
  await brainstorm(page, {
    request: brainstormRequest(base, { kind: "subject" }),
    model: "mock-slow",
  });
  await expect(ideaRows(page).first()).toContainText(mark(base, "idea"));
  await page.getByRole("main").getByRole("link", { name: "Characters", exact: true }).click();
  await expect(page).toHaveURL(/\/characters$/);
  // The list call was cut off; the classifier had finished.
  await expect
    .poll(async () => (await upstreamRecords(mark(base, "ask"))).map((record) => record.aborted))
    .toEqual([false, true]);
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await expect(page.locator('[data-kind="subject"]')).toBeVisible();
  await page.locator('[data-stage="brainstorm"]').click();
  await expect(page.getByRole("textbox", { name: BRAINSTORM_COPY.field })).toHaveValue("");
  await expect(page.getByRole("list", { name: BRAINSTORM_COPY.list })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(mark(base, "idea"));
});
