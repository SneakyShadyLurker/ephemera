import type { Page } from "@playwright/test";
import type { Section } from "../../apps/web/src/settings/sections.ts";
import { expect } from "./test.ts";

/** Opens Settings on `section`, or as it opens by default (Appearance from tablet up). */
export async function openSettings(page: Page, section?: Section) {
  await page.goto(section === undefined ? "/settings" : `/settings?section=${section}`);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

/** A Settings category in the index, by its name. */
export const settingsTab = (page: Page, name: string) =>
  page.getByRole("tab", { name, exact: true });
