import type { Page } from "@playwright/test";
import { beacons, expectUpstreamAborted, upstreamRecords } from "./support/chat.ts";
import { portraitPng } from "./support/creator-fixtures.ts";
import {
  choose,
  createCharacterViaApi,
  seriousAxeViolations,
  setLorebookViaApi,
  tabTo,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import {
  changes,
  chooseReworkModel,
  composer,
  createReworkCharacter,
  dock,
  openRework,
  submitRework,
} from "./support/rework.ts";
import { ANCHOR_ONE, ANCHOR_TWO, ownerRequest, reworkBook } from "./support/rework-fixtures.ts";
import { expect, test } from "./support/test.ts";

/** Opens a character's sheet and waits for its fields. */
async function openSheet(page: Page, id: string) {
  await page.goto(`/characters/${id}`);
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
}

test("reasoning follows the model's offered levels and is sent with the rework", async ({
  page,
}) => {
  const base = canary("rweffort");
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  const panel = composer(page);
  const reasoning = panel.getByRole("combobox", { name: "Reasoning", exact: true });
  await expect(reasoning).toHaveText("Model default");
  await chooseReworkModel(page, "mock-fast");
  await choose(panel, "Reasoning", "Extra high");
  await chooseReworkModel(page, "mock-lowonly");
  await expect(reasoning).toHaveText("Model default");
  await reasoning.click();
  await expect(page.getByRole("option")).toHaveText(["Model default", "Low"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  const fallback = page.waitForRequest("**/api/creator/rework");
  await submitRework(page, { request: ownerRequest(base, "kept-default"), model: "mock-lowonly" });
  const fallbackRequest = (await fallback).postDataJSON();
  expect(fallbackRequest).toMatchObject({ model: "mock-lowonly" });
  expect(fallbackRequest).not.toHaveProperty("reasoning");
  await expect(dock(page)).toContainText("3 changes in 2 fields");
  await dock(page).getByRole("button", { name: "Discard", exact: true }).click();

  await openRework(page);
  await chooseReworkModel(page, "mock-fast");
  await expect(reasoning).toHaveText("Extra high");
  const selected = page.waitForRequest("**/api/creator/rework");
  await submitRework(page, { request: ownerRequest(base, "kept-effort"), model: "mock-fast" });
  expect((await selected).postDataJSON()).toMatchObject({ model: "mock-fast", reasoning: "xhigh" });
  await expect(dock(page)).toContainText("3 changes in 2 fields");
  await dock(page).getByRole("button", { name: "Discard", exact: true }).click();

  // Leaving the sheet drops the composer's tab-memory choice.
  await page.goto("/characters");
  await openSheet(page, id);
  await openRework(page);
  await expect(reasoning).toHaveText("Model default");
});

test("compose, stream and review: the dock counts the changes and the fields are read-only", async ({
  page,
}) => {
  const base = canary("rwflow");
  const id = await createReworkCharacter(page.request, base, { portrait: true });
  await openSheet(page, id);

  await openRework(page);
  const panel = composer(page);
  await expect(panel.getByRole("switch", { name: "Include portrait" })).toBeVisible();
  await submitRework(page, { request: ownerRequest(base, "kept-flow"), model: "mock-fast" });

  const bar = dock(page);
  await expect(bar).toContainText("3 changes in 2 fields");
  await expect(bar.getByText("1 change could not be matched. It won't be applied.")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Apply 3 changes" })).toBeEnabled();
  // The changed field shows its tracked view; the others stay, read-only.
  await expect(page.getByRole("group", { name: "Description, under review" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Personality", exact: true })).toHaveAttribute(
    "aria-readonly",
    "true",
  );
  // The model read the portrait: mock-fast reads images, so the switch was on.
  const [record] = await upstreamRecords(`${base}-req`);
  expect(record?.image).toBe(true);

  // `pagehide` empties the session and the DOM in the same task: the dock leaves no draft
  // behind for its leave, neither the unmatched change nor the review.
  const after = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    return {
      dock: document.querySelector('[role="region"][aria-label="AI Rework"]') !== null,
      html: document.body.innerHTML,
    };
  });
  expect(after.dock).toBe(false);
  expect(after.html).not.toContain("could not be matched");
  expect(after.html).not.toContain(`${base}-rej`);
  expect(after.html).not.toContain(`${base}-why`);
});

test("review in place: a folded run opens, Reject hands focus to Restore, Apply writes the entry", async ({
  page,
}) => {
  const base = canary("rwreview");
  const kept = "kept-review";
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, kept), model: "mock-fast" });
  await expect(dock(page)).toContainText("3 changes in 2 fields");

  const description = page.getByRole("group", { name: "Description, under review" });
  await expect(description.locator("ins").first()).toContainText(`Replaced one ${kept}-acc.`);
  await expect(description.locator("del").first()).toContainText(ANCHOR_ONE);

  // Long unchanged runs are folded; opening one reveals its words in place and keeps it open.
  const folds = description.getByText(/^Show \d+ unchanged words$/);
  await expect(folds).toHaveCount(2);
  await expect(description.getByText(/Visitors come for maps/).first()).toBeHidden();
  await folds.first().click();
  await expect(folds).toHaveCount(1);
  await expect(description.locator("[data-revealed]")).toBeFocused();
  await expect(description.locator("[data-revealed]")).toContainText("Visitors come for maps");

  // Reject moves focus to Restore; Restore puts it back; Apply follows the decisions.
  await page.getByRole("button", { name: "Reject change 2 of 3" }).click();
  await expect(page.getByRole("button", { name: "Restore change 2 of 3" })).toBeFocused();
  await expect(dock(page).getByRole("button", { name: "Apply 2 changes" })).toBeEnabled();
  await page.getByRole("button", { name: "Restore change 2 of 3" }).click();
  await expect(page.getByRole("button", { name: "Reject change 2 of 3" })).toBeFocused();
  await expect(dock(page).getByRole("button", { name: "Apply 3 changes" })).toBeEnabled();
  await page.getByRole("button", { name: "Reject change 2 of 3" }).click();

  // The lorebook's entry under review, above its summary; the screen stays closed meanwhile.
  const lorebook = page.locator("#s-lorebook");
  await expect(
    lorebook.getByRole("group", { name: "Change 3 of 3 in Entry 1: The harbour ledger" }),
  ).toContainText(`${kept}-lore`);
  await expect(lorebook).toContainText("1 entry, 1 enabled");
  await expect(lorebook.getByRole("button", { name: "Open lorebook" })).toBeDisabled();

  await dock(page).getByRole("button", { name: "Apply 2 changes" }).click();
  await expect(dock(page)).toContainText("Applied 2 changes.");
  const field = page.getByRole("textbox", { name: "Description", exact: true });
  await expect(field).toHaveValue(new RegExp(`Replaced one ${kept}-acc\\.`));
  await expect(field).toHaveValue(new RegExp(ANCHOR_TWO.replaceAll(".", "\\.")));
  await expect
    .poll(
      async () => {
        const stored = (await (await page.request.get(`/api/characters/${id}`)).json()) as {
          card: { lorebook?: { entries: { content: string }[] } };
        };
        return stored.card.lorebook?.entries[0]?.content ?? "";
      },
      { timeout: 15_000 },
    )
    .toContain(`${kept}-lore`);
  await expect(lorebook.getByRole("link", { name: "Open lorebook" })).toBeVisible();
});

test("a model without a context window reopens the composer with what to do", async ({ page }) => {
  const base = canary("rwnowin");
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, {
    request: ownerRequest(base, "kept-nowin"),
    model: "mock-nowindow",
    refused: true,
  });
  await expect(composer(page)).toContainText(
    "mock-nowindow reports no context window. Set one in Settings.",
  );
  await expect(composer(page).getByRole("textbox", { name: "What should change?" })).toHaveValue(
    ownerRequest(base, "kept-nowin"),
  );
  await expect(dock(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).not.toHaveAttribute(
    "aria-readonly",
  );
  // Settings opens on that model's window field.
  await composer(page).getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Context window for mock-nowindow", exact: true }),
  ).toBeFocused();
});

test("a rework started after the saved book changed elsewhere builds on the newer book", async ({
  page,
}) => {
  // The applied changes and the newer entry persist by design: a plain unique base.
  const base = `rwbook-${crypto.randomUUID().slice(0, 8)}`;
  const newer = `${base}-newer-entry`;
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  const lorebook = page.locator("#s-lorebook");
  await expect(lorebook).toContainText("1 entry, 1 enabled");

  // Another tab adds an entry; this tab's saved copy catches up when the page is shown again.
  const entries = reworkBook().entries;
  await setLorebookViaApi(page.request, id, {
    entries: [
      ...entries,
      ...entries.map((entry) => ({ ...entry, content: `${newer} lies on the quay.` })),
    ],
  });
  const refetched = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && response.url().endsWith(`/api/characters/${id}`),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await refetched;

  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-book"), model: "mock-fast" });
  await expect(dock(page)).toContainText("3 changes in 2 fields");
  // The model read the newer book, and the sheet shows it.
  expect(await upstreamRecords(newer)).toHaveLength(1);
  await expect(lorebook).toContainText("2 entries, 2 enabled");

  // The other tab's save came after this sheet's revision: the save waits, and the dock says so.
  await dock(page).getByRole("button", { name: "Apply 3 changes" }).click();
  await expect(dock(page)).toContainText("Applied 3 changes. Not saved: changed in another tab.", {
    timeout: 15_000,
  });
  await page.locator("[data-conflict]").getByRole("button", { name: "Keep mine" }).click();
  await expect
    .poll(
      async () => {
        const stored = (await (await page.request.get(`/api/characters/${id}`)).json()) as {
          card: { lorebook?: { entries: { content: string }[] } };
        };
        return stored.card.lorebook?.entries.map((entry) => entry.content) ?? [];
      },
      { timeout: 15_000 },
    )
    .toEqual([expect.stringContaining("kept-book-lore"), `${newer} lies on the quay.`]);
  await expect(dock(page)).toContainText("Applied 3 changes.");
  await expect(dock(page)).not.toContainText(/Not saved|Saving/);
});

test("after typing in an applied field, Undo leaves it and says so", async ({ page }) => {
  // Every change is applied and the typed field keeps them, so its marks persist by design:
  // a plain unique base, not a canary.
  const base = `rwundo-${crypto.randomUUID().slice(0, 8)}`;
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-undo"), model: "mock-fast" });
  await dock(page).getByRole("button", { name: "Apply 3 changes" }).click();
  await expect(dock(page).getByRole("button", { name: "Undo", exact: true })).toBeFocused();
  const description = page.getByRole("textbox", { name: "Description", exact: true });
  // The field is the editor again, newly shown: the caret goes to the end before typing.
  await description.evaluate((field: HTMLTextAreaElement) =>
    field.setSelectionRange(field.value.length, field.value.length),
  );
  await description.pressSequentially(" More.");
  await dock(page).getByRole("button", { name: "Undo untouched fields" }).click();
  await expect(dock(page)).toContainText(
    "Undo restored 1 of 3 changes. Description was edited since.",
  );
  await expect(page.getByRole("button", { name: "AI Rework", exact: true })).toBeFocused();
  await expect(description).toHaveValue(/kept-undo-acc.* More\.$/s);
});

test("the portrait switch follows what the model reads", async ({ page }) => {
  const base = canary("rwportrait");
  const id = await createReworkCharacter(page.request, base, { portrait: true });
  await openSheet(page, id);
  await openRework(page);
  const toggle = composer(page).getByRole("switch", { name: "Include portrait" });

  // Not reported: off, but the owner may try it.
  await chooseReworkModel(page, "mock-unreported");
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  // Reads images: on.
  await chooseReworkModel(page, "mock-fast");
  await expect(toggle).toBeChecked();
  // Reads text only: off and disabled, and the upstream gets no image.
  await chooseReworkModel(page, "mock-textonly");
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await submitRework(page, {
    request: ownerRequest(base, "kept-portrait"),
    model: "mock-textonly",
  });
  await expect(dock(page)).toContainText("3 changes in 2 fields");
  const [record] = await upstreamRecords(`${base}-req`);
  expect(record?.model).toBe("mock-textonly");
  expect(record?.image).toBe(false);
});

/**
 * Holds the character's portrait uploads and removals in the browser once
 * `hold` arms it, until `release` sends one on or `refuse` answers it as an
 * image the server cannot read.
 */
async function portraitWrites(page: Page, id: string) {
  let answer: (refused: boolean) => void = () => {};
  let held: Promise<boolean> = Promise.resolve(false);
  await page.route(`**/api/characters/${id}/portrait`, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    if (await held) {
      await route.fulfill({ status: 415, contentType: "application/json", body: "{}" });
    } else {
      await route.continue();
    }
  });
  return {
    hold: () => {
      held = new Promise((resolve) => {
        answer = resolve;
      });
    },
    release: () => answer(false),
    refuse: () => answer(true),
  };
}

test("a portrait change under way holds AI Rework until it ends, an open composer's Rework included", async ({
  page,
}) => {
  const base = canary("rwportraitheld");
  const id = await createReworkCharacter(page.request, base, { portrait: true });
  const writes = await portraitWrites(page, id);
  let reworks = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/creator/rework")) reworks += 1;
  });
  await openSheet(page, id);
  const button = page.getByRole("button", { name: "AI Rework", exact: true });
  const identity = page.locator("#s-identity");
  const picker = identity.locator('input[type="file"]');
  const image = (marker: string) => ({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: portraitPng(marker),
  });

  // An upload under way: the composer does not open; refused, Rework is back.
  writes.hold();
  await picker.setInputFiles(image(`${base}-refused`));
  await expect(identity.getByText("Saving the portrait", { exact: true })).toBeVisible();
  await expect(identity.getByRole("button", { name: "Portrait actions" })).toBeDisabled();
  await expect(button).toBeDisabled();
  writes.refuse();
  await expect(identity.getByRole("alert")).toHaveText("Use a PNG, JPEG or WebP image.");
  await expect(button).toBeEnabled();

  // A removal under way holds it too, until it lands.
  writes.hold();
  await identity.getByRole("button", { name: "Portrait actions" }).click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(button).toBeDisabled();
  writes.release();
  await expect(identity.getByRole("button", { name: "Add portrait" })).toBeEnabled();
  await expect(button).toBeEnabled();

  // An upload begun with the composer open: Rework waits, by its button or the keyboard.
  await openRework(page);
  const panel = composer(page);
  const field = panel.getByRole("textbox", { name: "What should change?" });
  await field.fill(ownerRequest(base, "kept-held"));
  await chooseReworkModel(page, "mock-fast");
  const rework = panel.getByRole("button", { name: "Rework", exact: true });
  await expect(rework).toBeEnabled();
  writes.hold();
  await picker.setInputFiles(image(`${base}-next`));
  await expect(rework).toBeDisabled();
  await expect(panel).toContainText("Rework waits until the portrait change is saved.");
  await field.press("Control+Enter");
  await expect(panel).toBeVisible();
  await expect(dock(page)).toHaveCount(0);
  expect(reworks).toBe(0);

  // Once the portrait lands, the same composer sends.
  writes.release();
  await expect(identity.getByRole("button", { name: "Portrait actions" })).toBeEnabled();
  await expect(rework).toBeEnabled();
  await field.press("Control+Enter");
  await expect(composer(page)).toHaveCount(0);
  await expect(dock(page)).toContainText("3 changes in 2 fields");
  expect(reworks).toBe(1);
});

test("Stop keeps what arrived and aborts the upstream", async ({ page }) => {
  const base = canary("rwstopflow");
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-stop"), model: "mock-slow" });
  await expect(dock(page)).toContainText("Reworking with mock-slow");
  await expect(changes(page)).toHaveCount(1, { timeout: 15_000 });
  await dock(page).getByRole("button", { name: "Stop" }).click();
  await expect(dock(page)).toContainText("Stopped. 1 change arrived.");
  // What arrived stays reviewable.
  await expect(dock(page).getByRole("button", { name: "Apply 1 change" })).toBeEnabled();
  await expectUpstreamAborted(`${base}-req`);
});

test("an upstream error ends the run in ember and echoes nothing", async ({ page }) => {
  // The mock's error body echoes the request; the app must not pass it on.
  const base = canary("rwerrflow");
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-error"), model: "mock-error" });
  // The visible line comes first; the alert that announces it is visually hidden.
  const line = dock(page).getByText("The model stopped before it finished.").first();
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-ember/);
  expect(await upstreamRecords(`${base}-req`)).toHaveLength(1);
  expect(await page.content()).not.toContain(`${base}-req`);
});

for (const size of [
  { name: "phone", width: 390, height: 844, drawer: true },
  { name: "tablet", width: 820, height: 1180, drawer: false },
] as const) {
  test(`${size.name} layout: the composer, the dock above the bottom edge, no serious axe violations`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const base = canary(`rw${size.name}`);
    const id = await createReworkCharacter(page.request, base, { portrait: true });
    await openSheet(page, id);
    await openRework(page);
    // A drawer on phones (with its own close button), a popover beside the button elsewhere.
    await expect(page.locator('[data-slot="drawer-popup"]')).toHaveCount(size.drawer ? 1 : 0);
    await expect(composer(page).getByRole("button", { name: "Close AI Rework" })).toHaveCount(
      size.drawer ? 1 : 0,
    );
    expect(await seriousAxeViolations(page)).toEqual([]);
    await submitRework(page, { request: ownerRequest(base, "kept-layout"), model: "mock-fast" });

    const bar = dock(page);
    await expect(bar).toContainText("3 changes in 2 fields");
    // The unmatched change waits behind its disclosure, closed, on every form factor.
    const unmatched = bar.locator("details");
    await expect(unmatched).toHaveCount(1);
    await expect(unmatched).not.toHaveAttribute("open");
    // Measured once the dock's rise has settled; half a pixel covers subpixel layout.
    expect(await seriousAxeViolations(page)).toEqual([]);
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size.height + 0.5);
  });
}

test.describe("on a short touch phone", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 560 } });

  test("the composer sheet keeps its fields in reach above Rework, and Close dismisses it", async ({
    page,
  }) => {
    const base = canary("rwshort");
    const id = await createReworkCharacter(page.request, base, { portrait: true });
    await openSheet(page, id);
    await openRework(page);
    const panel = composer(page);
    const field = panel.getByRole("textbox", { name: "What should change?" });
    const send = panel.getByRole("button", { name: "Rework", exact: true });
    // The sheet fits the window; its body scrolls down to its last control above the footer.
    const popup = page.locator('[data-slot="drawer-popup"]');
    await expect
      .poll(async () => {
        const box = await popup.boundingBox();
        return (box?.y ?? 0) + (box?.height ?? Infinity);
      })
      .toBeLessThanOrEqual(560.5);
    expect((await popup.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
    await expect(send).toBeInViewport();
    const last = panel.getByRole("switch", { name: "Include portrait" });
    await last.scrollIntoViewIfNeeded();
    await last.focus();
    await expect(last).toBeInViewport();
    await expect(send).toBeInViewport();

    // A tap back on the request takes focus from there, and the request is typed into it.
    await field.tap();
    await expect(field).toBeFocused();
    await page.keyboard.type("Older by a decade");
    await expect(field).toHaveValue("Older by a decade");

    await panel.getByRole("button", { name: "Close AI Rework" }).tap();
    await expect(composer(page)).toHaveCount(0);
    await expect(page.locator('[data-slot="drawer-popup"]')).toHaveCount(0);
  });
});

test("the keyboard alone opens, sends, navigates, rejects and reaches Apply", async ({ page }) => {
  const base = canary("rwkeys");
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  // The model is picked once; closing the composer keeps it for this sheet.
  await openRework(page);
  await chooseReworkModel(page, "mock-fast");
  await page.keyboard.press("Escape");
  const button = page.getByRole("button", { name: "AI Rework", exact: true });
  await expect(button).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "What should change?" })).toBeFocused();
  await page.keyboard.type(ownerRequest(base, "kept-keys"));
  await page.keyboard.press("Control+Enter");
  await expect(composer(page)).toHaveCount(0);
  const bar = dock(page);
  await expect(bar).toContainText("3 changes in 2 fields");

  const next = bar.getByRole("button", { name: "Next change" });
  await tabTo(page, next);
  await page.keyboard.press("Enter");
  const first = page.getByRole("group", { name: "Change 1 of 3 in Description" });
  await expect(first).toBeFocused();
  await expect(bar).toContainText("Change 1 of 3, Description");
  const reject = page.getByRole("button", { name: "Reject change 1 of 3" });
  await tabTo(page, reject, { limit: 3 });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Restore change 1 of 3" })).toBeFocused();
  await expect(first).toHaveAttribute("data-decision", "rejected");
  await tabTo(page, bar.getByRole("button", { name: "Apply 2 changes" }));
});

test("under reduced motion the review arrives without movement", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const base = canary("rwmotion");
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-motion"), model: "mock-slow" });
  // Sampled as the first change appears: nothing slides, the dock included.
  await expect(changes(page)).toHaveCount(1, { timeout: 15_000 });
  const moved = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-change-at], [data-reason-for], [data-tracked]")]
        .map((element) => getComputedStyle(element))
        .filter(
          (style) =>
            (style.translate !== "none" && style.translate !== "0px") || style.transform !== "none",
        ).length,
  );
  expect(moved).toBe(0);
  await expect(dock(page)).toContainText("3 changes in 2 fields", { timeout: 20_000 });
  await expect(dock(page).getByRole("button", { name: "Apply 3 changes" })).toBeEnabled();
});

test("a hostile replacement shows as text: no image, link or script, no request out", async ({
  page,
}) => {
  const base = canary("rwhostile");
  const id = await createReworkCharacter(page.request, base);
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-hostile"), model: "mock-hostile" });
  await expect(dock(page)).toContainText("3 changes in 2 fields");
  const view = page.getByRole("group", { name: "Description, under review" });
  await expect(view).toContainText("Read [the harbour board](");
  await expect(view).toContainText("<script>document.title = 'owned'</script>");
  const tracked = page.locator("[data-tracked]");
  await expect(tracked.locator("img")).toHaveCount(0);
  await expect(tracked.locator("a[href]")).toHaveCount(0);
  await expect(tracked.locator("script")).toHaveCount(0);
  expect(await page.title()).not.toBe("owned");
  const sent = await beacons();
  expect(sent.filter((path) => path.startsWith("/__beacon/rework"))).toEqual([]);
});

/*
 * Screenshots for design review, written outside the repository: set
 * REWORK_SHOTS to a directory to take them (`REWORK_SHOTS=/tmp/rework-shots`).
 */
const SHOTS = process.env.REWORK_SHOTS;
const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

/** A shot once popovers, drawers, disclosures and arrivals have settled. */
const shooter = (page: Page, prefix: string) => async (step: string) => {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a instanceof CSSTransition || a instanceof CSSAnimation)
            // Ambient loops (the lamp) never end and scroll-driven ones follow the scroller:
            // only finite, time-driven motion is waited out.
            .filter(
              (a) =>
                a.playState === "running" &&
                a.timeline instanceof DocumentTimeline &&
                a.effect?.getTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
  await page.screenshot({ path: `${SHOTS}/${prefix}-${step}.png` });
};

/** Scrolls an element to the top of the sheet's scroller, under the header. */
const toTop = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      element.scrollIntoView({ block: "start" });
    });

/** A card with every kind of field a rework can change, for the rich review's shots. */
const RICH_SCENARIO =
  "Mara waits for {{user}} in the reading room after closing time. The lamps are low, the tide is out, and the harbour bell has just rung nine. She has a question she has not asked anyone in years, and a ledger open at a page she would rather not explain.";
const RICH_SCENARIO_NEW =
  "{{user}} arrives at the archive on the morning the customs men come. Boxes stand open on every table, a clerk is counting maps aloud, and Mara, pale and very polite, asks {{user}} to carry one ledger out through the back door before anyone thinks to look for it.";

const richBlock = (field: string, why: string, find: string, replace: string) =>
  `<change>\n<field>${field}</field>\n<why>${why}</why>\n<find>${find}</find>\n<replace>${replace}</replace>\n</change>`;

const RICH_ANSWER = [
  richBlock("name", "The request names her family.", "Mara Voss", "Mara Ilse Voss"),
  richBlock(
    "tags",
    "Tags follow the new direction.",
    "",
    "drama, harbour town, mystery, slow burn",
  ),
  richBlock("scenario", "The scenario opens on the customs raid.", "", RICH_SCENARIO_NEW),
  richBlock("entry_1_name", "The ledger is a customs record now.", "", "The customs ledger"),
  richBlock("entry_1_keys", "Keywords follow the new name.", "", "ledger, customs"),
  richBlock(
    "entry_1",
    "Cargo matters to the raid.",
    "every ship that left",
    "every ship and cargo that left",
  ),
  richBlock("entry_2", "The lighthouse no longer fits the story.", "", ""),
  richBlock("entry_new_1_name", "The raid needs a harbour master.", "", "Harbour master"),
  richBlock("entry_new_1_keys", "", "", "harbour master, Teodor"),
  richBlock("entry_new_1", "", "", "Teodor runs the harbour office and owes Mara a favour."),
  richBlock("alternate_greeting_1", "A quieter greeting.", "and smiles", "and nods once"),
  richBlock("alternate_greeting_2", "It contradicts the raid.", "", ""),
  richBlock(
    "alternate_greeting_new",
    "A greeting for the raid.",
    "",
    "Rain drums on the archive roof as Mara lights the lamp and slides a ledger toward {{user}}.",
  ),
  "<summary>Reworked for the customs raid.</summary>",
].join("\n");

async function createRichCharacter(page: Page) {
  const id = await createCharacterViaApi(page.request, "Mara Voss", {
    description:
      "Mara keeps the harbour archive. She is exact, patient and quietly stubborn, and she remembers every visitor by the map they asked for.",
    personality: "Calm, curious and exact.",
    scenario: RICH_SCENARIO,
    firstMessage: "Mara looks up from the ledger.",
    alternateGreetings: [
      "Mara looks up from the ledger and smiles.",
      "The archive door creaks open, and Mara does not look up.",
    ],
    tags: ["drama", "harbour", "mystery"],
  });
  await setLorebookViaApi(page.request, id, {
    entries: [
      {
        keys: ["ledger", "harbour"],
        content: "The ledger lists every ship that left the harbour. It is kept in the back room.",
        enabled: true,
        insertionOrder: 100,
        useRegex: false,
        comment: "The harbour ledger",
      },
      {
        keys: ["lighthouse"],
        content: "The lighthouse at the end of the quay has been dark for a decade.",
        enabled: true,
        constant: true,
        insertionOrder: 100,
        useRegex: false,
        comment: "The lighthouse",
      },
    ],
  });
  return id;
}

test("after Apply adds an alternate, Remove takes it out and Add opens the next one", async ({
  page,
}) => {
  const id = await createCharacterViaApi(page.request, "Mara Voss", {
    firstMessage: "Mara looks up from the ledger.",
    alternateGreetings: ["Rain on the archive roof."],
  });
  const answer = [
    richBlock("alternate_greeting_new", "A greeting for the morning.", "", "Morning at the mill."),
    "<summary>One greeting added.</summary>",
  ].join("\n");
  await page.route("**/api/creator/rework", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "delta", text: answer })}\n${JSON.stringify({ type: "result", problems: [] })}\n`,
    }),
  );
  await openSheet(page, id);
  await openRework(page);
  await submitRework(page, { request: "Add a morning greeting.", model: "mock-fast" });
  await dock(page).getByRole("button", { name: "Apply 1 change" }).click();
  await expect(dock(page)).toContainText("Applied 1 change.");

  const greetings = page.locator("#s-greetings");
  await greetings.getByRole("button", { name: "Alternate 2: Morning at the mill." }).click();
  await greetings.getByRole("button", { name: "More for Alternate 2" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await expect(greetings).toContainText("Alternate 2 removed.");
  await expect(greetings.getByRole("button", { name: /^Alternate 2/ })).toHaveCount(0);
  await expect(greetings.getByRole("textbox", { name: "Alternate 2" })).toHaveCount(0);

  await greetings.getByRole("button", { name: "Add alternate" }).click();
  await expect(greetings.getByRole("textbox", { name: "Alternate 2" })).toBeFocused();
});

for (const size of SHOTS === undefined ? [] : SIZES) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshots: ${size.name}, ${scheme}`, async ({ page }) => {
      const shot = shooter(page, `${size.name}-${scheme}`);
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.emulateMedia({ colorScheme: scheme });
      const base = canary(`rwshot${size.name}${scheme}`);
      const id = await createReworkCharacter(page.request, base, { portrait: true });
      await openSheet(page, id);

      await openRework(page);
      await composer(page).getByRole("textbox", { name: "What should change?" }).fill("x");
      await composer(page).getByRole("textbox", { name: "What should change?" }).fill("");
      await shot("01-composer-empty");

      // Working, then stopped.
      await submitRework(page, { request: ownerRequest(base, "kept-shot"), model: "mock-slow" });
      await expect(dock(page)).toContainText("so far", { timeout: 15_000 });
      await shot("02-working");
      await dock(page).getByRole("button", { name: "Stop" }).click();
      await expect(dock(page)).toContainText("Stopped.");
      await shot("03-stopped");

      // Try again reopens the composer with the request; the review follows.
      await dock(page).getByRole("button", { name: "Try again" }).click();
      await expect(
        composer(page).getByRole("textbox", { name: "What should change?" }),
      ).toHaveValue(ownerRequest(base, "kept-shot"));
      await shot("04-composer-filled");
      await submitRework(page, { request: ownerRequest(base, "kept-shot"), model: "mock-fast" });
      await expect(dock(page)).toContainText("3 changes in 2 fields");
      await shot("05-review-arrived");
      await dock(page).getByText("1 change could not be matched").click();
      await shot("06-review-unmatched");
      await dock(page).getByRole("button", { name: "Next change" }).click();
      await expect(dock(page)).toContainText("Change 1 of 3, Description");
      await shot("07-review-navigated");

      // A folded run opened, a change rejected: Restore takes its place.
      const description = page.getByRole("group", { name: "Description, under review" });
      await description
        .getByText(/^Show \d+ unchanged words$/)
        .first()
        .click();
      await page.getByRole("button", { name: "Reject change 2 of 3" }).click();
      await expect(page.getByRole("button", { name: "Restore change 2 of 3" })).toBeFocused();
      await toTop(page, "#s-description");
      await shot("08-tracked-rejected");
      await toTop(page, "#s-lorebook");
      await shot("09-lorebook");

      await dock(page).getByRole("button", { name: "Apply 2 changes" }).click();
      await expect(dock(page)).toContainText("Applied 2 changes.");
      await expect(dock(page).getByRole("button", { name: "Undo" })).toBeFocused();
      await shot("10-applied");
      await dock(page).getByRole("button", { name: "Undo" }).click();
      await expect(dock(page)).toContainText("Undo restored 2 changes.");
      await shot("11-undone");
    });

    test(`screenshots, every kind of change: ${size.name}, ${scheme}`, async ({ page }) => {
      const shot = shooter(page, `${size.name}-${scheme}-rich`);
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.emulateMedia({ colorScheme: scheme });
      const id = await createRichCharacter(page);
      // The answer comes from here rather than the mock upstream, so it can touch every field.
      await page.route("**/api/creator/rework", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/x-ndjson; charset=utf-8",
          body: `${JSON.stringify({ type: "delta", text: RICH_ANSWER })}\n${JSON.stringify({ type: "result", problems: [] })}\n`,
        }),
      );
      await openSheet(page, id);
      await openRework(page);
      await submitRework(page, { request: "Rework her for the customs raid.", model: "mock-fast" });
      await expect(dock(page)).toContainText("13 changes in");
      await toTop(page, "#s-identity");
      await shot("1-identity");
      await toTop(page, "#s-scenario");
      await shot("2-scenario-passage");
      await page.getByText("Show original (", { exact: false }).click();
      await shot("3-scenario-original");
      await toTop(page, "#s-lorebook");
      await shot("4-lorebook");
      await page.getByRole("button", { name: "Reject new entry: Harbour master" }).click();
      await expect(
        page.getByRole("button", { name: "Restore new entry: Harbour master" }),
      ).toBeFocused();
      await page.getByRole("button", { name: /^Reject removed entry/ }).click();
      await shot("5-lorebook-rejected");
      await toTop(page, "#s-greetings");
      await shot("6-greetings");
    });
  }
}
