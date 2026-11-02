import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { portraitPng } from "./creator-fixtures.ts";
import { choose, createCharacterViaApi, setLorebookViaApi, setPortraitViaApi } from "./entities.ts";
import { reworkBook, reworkCharacter } from "./rework-fixtures.ts";
import type { MockModel } from "./upstream.ts";

/** AI Rework as the owner drives it (e2e/rework.spec.ts). */

/**
 * A saved character to rework: the fixture card marked from `base`, its
 * lorebook, and with `portrait` a stored portrait. Returns its id.
 */
export async function createReworkCharacter(
  request: APIRequestContext,
  base: string,
  { portrait = false }: { portrait?: boolean } = {},
): Promise<string> {
  const { name, ...fields } = reworkCharacter(base);
  const id = await createCharacterViaApi(request, name, fields);
  await setLorebookViaApi(request, id, reworkBook());
  if (portrait) await setPortraitViaApi(request, id, portraitPng(base));
  return id;
}

/** The composer, as a popover on tablet and desktop or a drawer on phones. */
export const composer = (page: Page) => page.getByRole("dialog", { name: "AI Rework" });

/** The bar under the sheet's scroller. */
export const dock = (page: Page) => page.getByRole("region", { name: "AI Rework" });

/** Opens the composer from the sheet header; the request field has focus. */
export async function openRework(page: Page) {
  await page.getByRole("button", { name: "AI Rework", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "What should change?" })).toBeFocused();
}

/** Every change under review in the sheet, in document order: what Previous and Next move through. */
export const changes = (page: Page) => page.locator("[data-change-at]");

/** Picks the composer's model. */
export const chooseReworkModel = (page: Page, model: MockModel) =>
  choose(composer(page), "Model", model);

/**
 * Writes the request, picks the model and sends it; the composer closes,
 * unless `refused`: a run the server refuses reopens it at once.
 */
export async function submitRework(
  page: Page,
  { request, model, refused = false }: { request: string; model: MockModel; refused?: boolean },
) {
  const panel = composer(page);
  await panel.getByRole("textbox", { name: "What should change?" }).fill(request);
  await chooseReworkModel(page, model);
  await panel.getByRole("button", { name: "Rework", exact: true }).click();
  if (!refused) await expect(composer(page)).toHaveCount(0);
}
