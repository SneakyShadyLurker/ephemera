import type { Page } from "@playwright/test";
import { expectUpstreamAborted, upstreamRecords } from "./support/chat.ts";
import { CANARY_MARKER, canary } from "./support/env.ts";
import { matrixRow, type RowLabel } from "./support/retention.ts";
import {
  changes,
  composer,
  createReworkCharacter,
  dock,
  openRework,
  submitRework,
} from "./support/rework.ts";
import { ownerRequest } from "./support/rework-fixtures.ts";
import { expect } from "./support/test.ts";

/*
 * Retention matrix, rework drafts (docs/ARCHITECTURE.md § Retention
 * matrix): the owner's request, the model's answer, the changes it proposes
 * and the review, along each path a rework can take. Every mark that must
 * not persist derives from one canary of the row's label
 * (e2e/support/rework-fixtures.ts: `-req`, `-rej`, `-why`, `-sum`), so the
 * server cells in e2e/server-writes.check.ts find any of them; an accepted
 * change writes a `kept-` text, which persists by design. A row proves the
 * request reached the upstream and the proposal reached the tab, then runs
 * the browser cells.
 */

/** A sheet shows nothing a rework held: no dock, no canary in any field. */
async function expectReworkEmpty(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  await expect(dock(page)).toHaveCount(0);
  const values = await page
    .locator("textarea, input")
    .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value));
  expect(values.filter((value) => value.includes(CANARY_MARKER))).toEqual([]);
}

/** Where every row starts, what B-bf finds once back, and the time a row may take. */
const REWORK = { start: "/characters", expectEmpty: expectReworkEmpty, timeout: 60_000 };

/** The text an accepted change writes: not a canary, as it persists by design. */
const keptBase = (label: RowLabel) => `kept-${label}`;

/**
 * A saved character marked from a canary of `label`, its sheet open and a
 * rework sent to `model`; the request reached the upstream. Returns the
 * canary and the character.
 */
async function sendRework(
  page: Page,
  label: RowLabel,
  model: "mock-fast" | "mock-slow" | "mock-error",
) {
  const base = canary(label);
  const id = await createReworkCharacter(page.request, base);
  await page.goto(`/characters/${id}`);
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, keptBase(label)), model });
  await expect.poll(async () => (await upstreamRecords(`${base}-req`)).length).toBe(1);
  return { base, id };
}

/**
 * A rework answered in full and under review: the rejected-to-be change, the
 * reasons on the page and the summary in the stream the tab read.
 */
async function review(page: Page, label: RowLabel) {
  // The summary is not shown while there are changes: the stream the tab reads is the proof.
  // The DevTools protocol does not keep a streamed body reliably, so the route reads it whole.
  let stream = "";
  await page.route("**/api/creator/rework", async (route) => {
    const response = await route.fetch();
    stream = await response.text();
    await route.fulfill({ response, body: stream });
  });
  const sent = await sendRework(page, label, "mock-fast");
  const { base } = sent;
  await expect(dock(page)).toContainText("3 changes in 2 fields");
  await expect(page.locator("main")).toContainText(`${base}-rej`);
  await expect(page.locator("main")).toContainText(`${base}-why`);
  expect(stream).toContain(`${base}-sum`);
  return sent;
}

matrixRow(
  "rwok",
  async ({ page }) => {
    await review(page, "rwok");
  },
  REWORK,
);

matrixRow(
  "rwdiscard",
  async ({ page }) => {
    const { base } = await review(page, "rwdiscard");
    await dock(page).getByRole("button", { name: "Discard" }).click();
    await expect(dock(page)).toHaveCount(0);
    expect(await page.content()).not.toContain(`${base}-rej`);
    expect(await page.content()).not.toContain(`${base}-why`);
    // The request stays in tab memory while the sheet is shown: the one draft Discard keeps.
    await openRework(page);
    await expect(composer(page).getByRole("textbox", { name: "What should change?" })).toHaveValue(
      ownerRequest(base, keptBase("rwdiscard")),
    );
  },
  REWORK,
);

matrixRow(
  "rwstop",
  async ({ page }) => {
    const { base } = await sendRework(page, "rwstop", "mock-slow");
    await expect(changes(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("main")).toContainText(`${base}-why`);
    await dock(page).getByRole("button", { name: "Stop" }).click();
    await expect(dock(page)).toContainText("Stopped. 1 change arrived.");
    await expectUpstreamAborted(`${base}-req`);
  },
  REWORK,
);

matrixRow(
  "rwerr",
  async ({ page }) => {
    // The mock's error body echoes the request; the app must not pass it on anywhere.
    const { base } = await sendRework(page, "rwerr", "mock-error");
    // The line, then the alert that announces it.
    await expect(
      dock(page).getByText("The model stopped before it finished.").first(),
    ).toBeVisible();
    expect(await page.content()).not.toContain(`${base}-req`);
  },
  REWORK,
);

matrixRow(
  "rwnav",
  async ({ page }) => {
    const { base } = await review(page, "rwnav");
    await page.getByRole("link", { name: "Characters" }).first().click();
    await expect(page).toHaveURL(/\/characters$/);
    // The gallery has replaced the sheet, so the sheet was left, not only the URL.
    await expect(page.getByRole("heading", { level: 1, name: "Characters" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Character sheet" })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
    // Leaving the sheet ended the review: nothing of it comes back with the sheet.
    await expect(dock(page)).toHaveCount(0);
    await expect(page.locator("[data-change-at]")).toHaveCount(0);
    for (const mark of ["req", "rej", "why", "sum"]) {
      expect(await page.content()).not.toContain(`${base}-${mark}`);
    }
  },
  REWORK,
);

matrixRow(
  "rwreload",
  async ({ page }) => {
    const { base } = await review(page, "rwreload");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
    await expect(dock(page)).toHaveCount(0);
    expect(await page.content()).not.toContain(base);
  },
  { ...REWORK, skip: { bf: true } },
);

matrixRow(
  "rwapply",
  async ({ page }) => {
    const { base, id } = await review(page, "rwapply");
    await page.getByRole("button", { name: "Reject change 2 of 3" }).click();
    await dock(page).getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(dock(page)).toContainText("Applied 2 changes.");
    await expect(dock(page)).not.toContainText("Saving");
    // Positive control: what was accepted persisted; what was rejected did not.
    const kept = keptBase("rwapply");
    await expect
      .poll(async () => {
        const stored = (await (await page.request.get(`/api/characters/${id}`)).json()) as {
          card: { description: string; lorebook?: { entries: { content: string }[] } };
        };
        return `${stored.card.description}\n${stored.card.lorebook?.entries[0]?.content ?? ""}`;
      })
      .toMatch(new RegExp(`${kept}-acc[\\s\\S]*${kept}-lore`));
    const stored = await (await page.request.get(`/api/characters/${id}`)).text();
    expect(stored).not.toContain(CANARY_MARKER);
    expect(stored).not.toContain(`${base}-rej`);
  },
  REWORK,
);
