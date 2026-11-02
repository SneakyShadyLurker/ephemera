import { rm } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { upstreamRecords } from "./support/chat.ts";
import {
  ART_TIMEOUT,
  expectBatch,
  listCharacters,
  portraits,
  recordArt,
} from "./support/creator.ts";
import { keptBase, mark } from "./support/creator-fixtures.ts";
import { choose, patchSettings } from "./support/entities.ts";
import { openProfile, serverHopsHolding } from "./support/retention.ts";
import { FRAGMENT_OFFSETS, filesContaining, imageFragments } from "./support/scan.ts";
import {
  artName,
  asStoredPortrait,
  createArtCharacter,
  footerClose,
  newArt,
  openStudio,
  sheetNewArt,
  sheetPortrait,
  storedPortrait,
  studio,
  useAsPortrait,
} from "./support/sheet-art.ts";
import { expire, signInThroughPortal } from "./support/signin.ts";
import { appOrigin, expect, test } from "./support/test.ts";

/*
 * New art for a saved character (docs/PRODUCT.md, Characters) against the
 * mock upstream and the mock ComfyUI (e2e/support/mock-comfyui.ts). Each
 * test saves the model the image prompt defaults to. The saved characters and
 * their kept portraits are character data, so their marks are not retention
 * canaries; the candidates left behind are scanned for here, and the drafts'
 * canaries in e2e/sheet-art-retention.spec.ts.
 */

test.beforeEach(async ({ request }) => {
  await patchSettings(request, { model: "mock-fast" });
});

/** The next art request the page sends. */
const artRequest = (page: Page) =>
  page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/creator/art" && sent.method() === "POST",
  );

test("New art paints four, the one picked becomes the portrait, and the other three persist nowhere", async ({
  browserName,
  comfy,
  playwright,
  request,
  user,
}) => {
  // A persistent profile, then scans of every server directory and of the profile.
  test.setTimeout(90_000);
  const scope = await comfy({ mode: "plain", distinct: true });
  const base = keptBase();
  const id = await createArtCharacter(request, base, { portrait: "plain" });
  const before = await storedPortrait(request, id);
  const profile = await openProfile(playwright[browserName], appOrigin(), user);
  const { context, page } = profile;
  try {
    const art = await recordArt(page);
    await openStudio(page, id);
    await newArt(page).click();
    await art.expectPortraits(base);
    await expectBatch(page);
    const radios = portraits(page).getByRole("radio");
    await expect(radios.nth(2)).toHaveAccessibleName(`Portrait of ${artName(base)}, option 3 of 4`);
    await radios.nth(2).click();
    await expect(radios.nth(2)).toHaveAttribute("aria-checked", "true");
    const candidates = art.images();
    // Four different paintings, so the portrait kept says which one was sent.
    expect(new Set(candidates.map((png) => png.toString("base64"))).size).toBe(4);

    await useAsPortrait(page);
    await expect(sheetNewArt(page)).toBeFocused();
    const after = await storedPortrait(request, id);
    expect(after.version).not.toBe(before.version);
    await expect(sheetPortrait(page)).toHaveAttribute("src", new RegExp(`v=${after.version}$`));
    // Byte for byte what the server makes of candidate 3: it, and nothing else, was uploaded.
    const kept = await asStoredPortrait(candidates[2] ?? Buffer.alloc(0));
    expect(after.png.equals(kept)).toBe(true);
    expect(
      (await listCharacters(request)).filter((character) => character.name === artName(base)),
    ).toHaveLength(1);
    await scope.expectClean();
    await context.close();
    expect(profile.policyViolations, "Content Security Policy violations").toEqual([]);

    // Positive control: the kept portrait is character data, in the database only.
    expect(await serverHopsHolding(await imageFragments(kept, FRAGMENT_OFFSETS.png))).toEqual([
      "S-data",
    ]);
    const others = [0, 1, 3].map((index) => candidates[index] ?? Buffer.alloc(0));
    const fragments = (
      await Promise.all(others.map((png) => imageFragments(png, FRAGMENT_OFFSETS.png)))
    ).flat();
    expect(await serverHopsHolding(fragments)).toEqual([]);
    const scan = await filesContaining(profile.dir, fragments);
    expect(scan.scanned).toBeGreaterThan(0);
    expect(scan).toMatchObject({ hits: [], unreadable: [] });
  } finally {
    await context.close();
    await rm(profile.dir, { recursive: true, force: true });
  }
});

test("Match current portrait sends the stored portrait to a model that reads images, and only then", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const id = await createArtCharacter(request, base, { portrait: "noisy" });
  await openStudio(page, id);
  const match = studio(page).getByRole("switch", { name: "Match current portrait" });
  await expect(match).toBeChecked();
  await expect(match).toHaveAccessibleDescription("Uses the portrait as a visual reference");
  await newArt(page).click();
  await expectBatch(page);
  const [sent] = await upstreamRecords(mark(base, "card"));
  expect(sent?.image).toBe(true);
  // The model's JPEG copy of the stored portrait was a draft of the request: it persisted nowhere.
  const url = sent?.imageData ?? "";
  expect(url).toMatch(/^data:image\/jpeg;base64,/);
  const jpeg = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const fragments = await imageFragments(jpeg, FRAGMENT_OFFSETS.jpeg, {
    "sent.json": JSON.stringify({ image_url: { url } }),
  });
  expect(await serverHopsHolding(fragments)).toEqual([]);

  await match.click();
  await expect(match).not.toBeChecked();
  await newArt(page).click();
  await expect.poll(async () => (await upstreamRecords(mark(base, "card"))).length).toBe(2);
  expect((await upstreamRecords(mark(base, "card")))[1]?.image).toBe(false);
  await expect(newArt(page)).toBeEnabled({ timeout: ART_TIMEOUT });

  // A model that reads text only cannot match.
  await choose(page, "Prompt model", "mock-textonly");
  await expect(match).toBeDisabled();
  await expect(match).not.toBeChecked();
  await expect(match).toHaveAccessibleDescription("This model reads text only");
  await scope.expectClean();
});

test("the studio's Look sends the chosen look for a saved Subject", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const id = await createArtCharacter(request, base);
  await openStudio(page, id);
  await expect(studio(page).getByRole("combobox", { name: "Look", exact: true })).toHaveText(
    "Auto",
  );
  await choose(studio(page), "Look", "Mirror selfie");
  const sent = artRequest(page);
  await newArt(page).click();
  expect((await sent).postDataJSON()).toMatchObject({ kind: "subject", look: "selfie" });
  await expect(newArt(page)).toBeEnabled({ timeout: ART_TIMEOUT });
  await scope.expectClean();
});

test("Settings' image prompt model alone lets the studio paint, without a chat model", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  await patchSettings(request, { model: null, imagePromptModel: "mock-lowonly" });
  const id = await createArtCharacter(request, keptBase());
  await openStudio(page, id);
  await expect(newArt(page)).toBeEnabled();
  const sent = artRequest(page);
  await newArt(page).click();
  expect((await sent).postDataJSON()).toMatchObject({ model: "mock-lowonly" });
  await expect(newArt(page)).toBeEnabled({ timeout: ART_TIMEOUT });
  await scope.expectClean();
});

test("Kind starts from the card's tags and shapes the next image prompt", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const id = await createArtCharacter(request, base, { tags: ["Scenario"] });
  await openStudio(page, id);
  const kind = studio(page).getByRole("group", { name: "Kind" });
  await expect(kind.getByRole("button", { name: "Scenario still" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const first = artRequest(page);
  await newArt(page).click();
  const initial = (await first).postDataJSON();
  expect(initial).toMatchObject({ kind: "scenario" });
  expect(initial).not.toHaveProperty("composition");
  const composition = studio(page).getByRole("group", { name: "Composition", exact: true });
  await expect(composition).toHaveCount(0);
  await expectBatch(page);

  await kind.getByRole("button", { name: "Subject" }).click();
  await expect(kind.getByRole("button", { name: "Subject" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(composition.getByRole("button", { name: "Regular", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await composition.getByRole("button", { name: "Diptych", exact: true }).click();
  const next = artRequest(page);
  await newArt(page).click();
  expect((await next).postDataJSON()).toMatchObject({ kind: "subject", composition: "diptych" });
  await expect(newArt(page)).toBeEnabled({ timeout: ART_TIMEOUT });
  await kind.getByRole("button", { name: "Group photo" }).click();
  await expect(composition).toHaveCount(0);
  const group = artRequest(page);
  await newArt(page).click();
  const grouped = (await group).postDataJSON();
  expect(grouped).toMatchObject({ kind: "group" });
  expect(grouped).not.toHaveProperty("composition");
  await expect(newArt(page)).toBeEnabled({ timeout: ART_TIMEOUT });
  // The card's tags are unchanged.
  const stored = (await (await request.get(`/api/characters/${id}`)).json()) as {
    card: { tags: string[] };
  };
  expect(stored.card.tags).toEqual(["Scenario"]);
  await scope.expectClean();
});

test("a ComfyUI failure keeps the studio open with the reason and New art as the one retry", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain", fail: true });
  const id = await createArtCharacter(request, keptBase());
  await openStudio(page, id);
  await newArt(page).click();
  await expect(studio(page).getByText("Portraits unavailable.")).toBeVisible({
    timeout: ART_TIMEOUT,
  });
  await expect(portraits(page)).toHaveCount(0);
  // The footer's New art is the retry; the status says why and offers no second one.
  await expect(newArt(page)).toHaveCount(1);
  await expect(newArt(page)).toBeEnabled();
  await expect(studio(page).getByRole("button", { name: /^Try/ })).toHaveCount(0);
  await scope.expectClean();
});

test("Stop and closing the studio while it paints both interrupt the ComfyUI run", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain", stall: true });
  const base = keptBase();
  const id = await createArtCharacter(request, base);
  const sampling = () =>
    expect.poll(async () => (await scope.state()).running, { timeout: ART_TIMEOUT }).toBe(true);
  await openStudio(page, id);
  await newArt(page).click();
  await sampling();
  await expect(studio(page)).toHaveAttribute("data-writing", "");
  await studio(page).getByRole("button", { name: "Stop" }).click();
  await expect(studio(page).getByText("Art stopped.")).toBeVisible();
  // Stop hands focus to the footer's New art, the one way to paint again.
  await expect(newArt(page)).toBeFocused();
  await scope.expectClean();
  expect((await scope.state()).interrupted).toBe(1);

  await newArt(page).click();
  await sampling();
  await page.keyboard.press("Escape");
  await expect(studio(page)).toHaveCount(0);
  await expect(sheetNewArt(page)).toBeFocused();
  await scope.expectClean();
  expect((await scope.state()).interrupted).toBe(2);
});

test("Stop while New art waits for the sign-in sends nothing once signed in again", async ({
  comfy,
  context,
  page,
  request,
}) => {
  await page.clock.install();
  const scope = await comfy({ mode: "plain" });
  const id = await createArtCharacter(request, keptBase());
  let arts = 0;
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/creator/art" && sent.method() === "POST") arts++;
  });
  await openStudio(page, id);
  await expire(context, appOrigin());
  await newArt(page).click();
  await expect(studio(page)).toContainText("Waiting for you to sign in");
  await studio(page).getByRole("button", { name: "Stop" }).click();
  await expect(studio(page).getByText("Art stopped.")).toBeVisible();
  await signInThroughPortal(page, context, {
    from: studio(page).locator("[data-signin]"),
    origin: appOrigin(),
  });
  await expect(studio(page).locator("[data-signin]")).toContainText("Signed in again");
  // A renewal resends only what still waits; the stopped run does not, however long the
  // renewal waits for what it resumes (RENEWAL_PASS_MS, 15 s).
  await page.clock.runFor(16_000);
  expect(arts).toBe(0);
  await expect(studio(page).getByText("Art stopped.")).toBeVisible();
  expect((await scope.state()).prompts).toBe(0);
});

test("Close keeps the candidates without a second reveal; after Use and after a back/forward return the studio starts empty", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const id = await createArtCharacter(request, base);
  const radios = portraits(page).getByRole("radio");
  await openStudio(page, id);
  await newArt(page).click();
  await expectBatch(page);
  await expect(studio(page).locator("canvas.develop-in")).toHaveCount(1);
  await radios.nth(2).click();
  await footerClose(page).click();
  await expect(studio(page)).toHaveCount(0);
  await expect(sheetNewArt(page)).toBeFocused();

  // Reopened: the same four and the choice, and no reveal played again. The four decode
  // after the studio opens, so focus starts on the footer's action.
  await sheetNewArt(page).click();
  await expectBatch(page);
  await expect(radios.nth(2)).toHaveAttribute("aria-checked", "true");
  await expect(studio(page).getByRole("button", { name: "Use as portrait" })).toBeFocused();
  await expect(studio(page).locator("canvas.develop-in")).toHaveCount(0);

  // A first portrait: New art stays the same button, so focus comes back to it.
  await useAsPortrait(page);
  await expect(sheetPortrait(page)).toBeVisible();
  await expect(sheetNewArt(page)).toBeFocused();
  await sheetNewArt(page).click();
  await expect(studio(page)).toBeVisible();
  await expect(portraits(page)).toHaveCount(0);
  await expect(newArt(page)).toBeFocused();
  await footerClose(page).click();

  // Back on the sheet after leaving the page: a new session paints.
  await page.goto("about:blank");
  await page.goBack();
  await sheetNewArt(page).click();
  await expect(portraits(page)).toHaveCount(0);
  await newArt(page).click();
  await expectBatch(page);
  await scope.expectClean();
});

test("pagehide over an open studio with four on show closes it empty; reopened, a new session paints", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  const id = await createArtCharacter(request, keptBase());
  await openStudio(page, id);
  await newArt(page).click();
  await expectBatch(page);
  await expect(studio(page).locator("canvas.develop-in")).toHaveCount(1);

  // The page as the back/forward cache would keep it: pagehide alone, the page stays.
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
  );
  await expect(studio(page)).toHaveCount(0);
  await expect(portraits(page)).toHaveCount(0);
  await expect(sheetNewArt(page)).toBeFocused();

  // Reopened: nothing of the old session, and a new batch paints and reveals.
  await sheetNewArt(page).click();
  await expect(studio(page)).toBeVisible();
  await expect(portraits(page)).toHaveCount(0);
  await expect(newArt(page)).toBeFocused();
  await newArt(page).click();
  await expectBatch(page);
  await expect(studio(page).locator("canvas.develop-in")).toHaveCount(1);
  await scope.expectClean();
});

test("the studio is worked with the keyboard: Tab order, arrows, Enter in Direction and Escape over the viewer", async ({
  comfy,
  page,
  request,
}) => {
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const name = artName(base);
  const id = await createArtCharacter(request, base, { portrait: "plain" });
  const radios = portraits(page).getByRole("radio");
  await openStudio(page, id);
  await newArt(page).click();
  await expectBatch(page);
  await radios.nth(0).focus();

  // One stop per control, in the order the body reads, then the footer.
  const stops: string[] = [];
  for (let step = 0; step < 13; step++) {
    stops.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        const by = active?.getAttribute("aria-labelledby");
        return (
          active?.getAttribute("aria-label") ??
          (by ? document.getElementById(by.split(" ")[0] ?? "")?.textContent?.trim() : null) ??
          active?.textContent?.trim() ??
          ""
        );
      }),
    );
    await page.keyboard.press("Tab");
  }
  expect(stops).toEqual([
    `Portrait of ${name}, option 1 of 4`,
    "Subject",
    "Match current portrait",
    `Current portrait of ${name}: show larger`,
    "Regular",
    "Look",
    "Workflow",
    "Prompt model",
    "Reasoning",
    "Direction for the next art",
    "New art",
    "Close",
    "Use as portrait",
  ]);

  // The last stop wraps to the header's Close, the dialog's first.
  await expect(
    studio(page).getByRole("button", { name: "Close", exact: true }).first(),
  ).toBeFocused();

  // Arrows move the choice within the four.
  await radios.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(radios.nth(1)).toBeFocused();

  // Enter in Direction paints with it.
  const direction = studio(page).getByRole("textbox", { name: "Direction for the next art" });
  await direction.fill(`Golden hour ${mark(base, "steer")}`);
  const painted = artRequest(page);
  await direction.press("Enter");
  expect((await painted).postDataJSON()).toMatchObject({
    direction: `Golden hour ${mark(base, "steer")}`,
  });
  await expect(newArt(page)).toBeEnabled({ timeout: ART_TIMEOUT });

  // Escape over the viewer closes the viewer only; the next one closes the studio.
  const label = `Portrait of ${name}, option 1 of 4`;
  const frame = page.locator(`button[aria-label="${label}: show larger"]`);
  await frame.click();
  const viewer = page.getByRole("dialog", { name: label });
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(studio(page)).toBeVisible();
  await expect(frame).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(studio(page)).toHaveCount(0);
  await scope.expectClean();
});

test.describe("on a short touch phone", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 600 } });

  test("the studio sheet takes a typed direction by touch, keeps its footer in view and closes", async ({
    comfy,
    page,
    request,
  }) => {
    const scope = await comfy({ mode: "plain" });
    const id = await createArtCharacter(request, keptBase());
    const sheet = await openStudio(page, id);
    const popup = page.locator('[data-slot="drawer-popup"]');
    await expect
      .poll(async () => {
        const box = await popup.boundingBox();
        return (box?.y ?? 0) + (box?.height ?? Infinity);
      })
      .toBeLessThanOrEqual(600.5);
    expect((await popup.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);

    // The direction, low in the scrolling body, is reached and typed into by touch.
    const direction = sheet.getByRole("textbox", { name: "Direction for the next art" });
    await direction.tap();
    await expect(direction).toBeFocused();
    await page.keyboard.type("Soft rain at the window");
    await expect(direction).toHaveValue("Soft rain at the window");
    await expect(direction).toBeInViewport();
    await expect(footerClose(page)).toBeInViewport();
    await expect(newArt(page)).toBeInViewport();

    await footerClose(page).tap();
    await expect(studio(page)).toHaveCount(0);
    await scope.expectClean();
  });
});

test("under reduced motion the reveal completes", async ({ comfy, page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await comfy({ mode: "plain" });
  const id = await createArtCharacter(request, keptBase());
  await openStudio(page, id);
  await newArt(page).click();
  await expectBatch(page);
  const frame = studio(page).locator("canvas.develop-in");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveCSS("filter", "none");
  await expect(frame).toHaveCSS("opacity", "1");
  await expect(portraits(page)).toHaveCSS("opacity", "1");
});
