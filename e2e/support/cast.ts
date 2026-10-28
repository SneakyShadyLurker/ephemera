import { expect, type Locator, type Page } from "@playwright/test";
import type { CastAnchorField, CastStateField } from "../../packages/core/src/cast/index.ts";
import { choose } from "./entities.ts";

/*
 * Drive the cast panel as the owner does, through its test hooks
 * (apps/web/src/chat/Cast.tsx): `data-cast` on the panel,
 * `data-cast-status` on its status line, `data-cast-entry` (with
 * `data-present`) on each roster entry, `data-cast-field="<field>"` on a
 * record's field and `data-cast-corrected` on a corrected one. The panel
 * lists women only; a man the register holds has no entry.
 */

/** A field of a record: an anchor or state text field. */
export type CastField = CastAnchorField | CastStateField;

/** The cast panel on screen: the float's roster, or the phone band's. */
export const castPanel = (page: Page) => page.locator("[data-cast]").filter({ visible: true });

/** The panel's status line ("Reading the card", "Cast couldn't update.", ...). */
export const castStatus = (page: Page) => castPanel(page).locator("[data-cast-status]");

/** The roster entry of the NPC named `name`, present or away. */
export const castEntry = (page: Page, name: string) =>
  castPanel(page).locator("[data-cast-entry]").filter({ hasText: name });

/** The open record surface (popover or drawer) whose heading names `name`. */
export const castRecord = (page: Page, name: string) =>
  page.getByRole("dialog").filter({ has: page.getByRole("heading", { name }) });

/** Opens the record of the entry named `name` from the roster; returns its surface. */
export async function openRecord(page: Page, name: string): Promise<Locator> {
  await castEntry(page, name).click();
  const record = castRecord(page, name);
  await expect(record).toBeVisible();
  return record;
}

/**
 * Opens the record of `name`, switches it to edit mode, fills `fields` and
 * saves; returns the record, back in reading mode.
 */
export async function editRecord(
  page: Page,
  name: string,
  fields: Partial<Record<CastField, string>>,
): Promise<Locator> {
  const record = await openRecord(page, name);
  await record.getByRole("button", { name: "Edit record", exact: true }).click();
  for (const [field, value] of Object.entries(fields)) {
    await record
      .locator(`textarea[data-cast-field="${field}"], [data-cast-field="${field}"] textarea`)
      .fill(value);
  }
  await record.getByRole("button", { name: "Save", exact: true }).click();
  await expect(record.getByRole("button", { name: "Save", exact: true })).toBeHidden();
  return record;
}

/**
 * Chooses the cast model in Settings (`label`: a model, or "Memory's model")
 * and comes back, through the main navigation, so the open chat stays in the tab.
 */
export async function chooseCastModel(page: Page, label: string) {
  const main = page.getByRole("navigation", { name: "Main" });
  await main.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/settings" &&
      response.request().method() === "PATCH" &&
      response.ok(),
  );
  await choose(page, "Cast model", label);
  await saved;
  await main.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}
