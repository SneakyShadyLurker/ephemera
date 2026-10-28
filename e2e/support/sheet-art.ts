import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import { toPortrait } from "../../apps/server/src/images.ts";
import { mark, noisyPortraitPng, portraitPng } from "./creator-fixtures.ts";
import { createCharacterViaApi, setPortraitViaApi } from "./entities.ts";

/*
 * New art for a saved character as the owner drives it (e2e/sheet-art.spec.ts,
 * e2e/sheet-art-retention.spec.ts): a character whose description carries
 * `<base>-card`, so the image prompt and the portraits follow from that base
 * (e2e/support/creator-fixtures.ts), unless a direction typed in the studio
 * carries a `-steer` mark of its own, which outranks it.
 */

/** The saved character's name: the base's last eight characters keep it unique. */
export const artName = (base: string) => `Ada Reed ${base.slice(-8)}`;

/**
 * A saved character to paint, its description plain prose marked from
 * `base`, with `portrait` a stored portrait: "noisy" ones are unique to the
 * call, so fragments of them mark the image. Returns its id.
 */
export async function createArtCharacter(
  request: APIRequestContext,
  base: string,
  { portrait, tags = [] }: { portrait?: "plain" | "noisy"; tags?: string[] } = {},
): Promise<string> {
  const id = await createCharacterViaApi(request, artName(base), {
    description: `A placeholder archivist with grey eyes and short dark hair who keeps a quiet ledger in a slate town. ${mark(base, "card")}`,
    personality: "Calm, curious and exact.",
    firstMessage: "Location: the archive, dusk.\nRain ticks on the roof.",
    tags,
  });
  if (portrait !== undefined) {
    const png = portrait === "noisy" ? noisyPortraitPng(base) : portraitPng(base);
    await setPortraitViaApi(request, id, png);
  }
  return id;
}

/** The studio, a dialog on tablet and desktop and a drawer on phones. */
export const studio = (page: Page) => page.getByRole("dialog", { name: /^New art for / });

/** New art under the sheet's portrait. */
export const sheetNewArt = (page: Page) =>
  page.getByRole("form", { name: "Character sheet" }).getByRole("button", { name: "New art" });

/** The studio's New art: the footer's primary before a batch, the quiet one beside the direction after. */
export const newArt = (page: Page) =>
  studio(page).getByRole("button", { name: "New art", exact: true });

/** The footer's Close; the header's icon button carries the same name. */
export const footerClose = (page: Page) =>
  studio(page).getByRole("button", { name: "Close", exact: true }).last();

/** The sheet's portrait, as the field shows it. */
export const sheetPortrait = (page: Page) =>
  page.getByRole("form", { name: "Character sheet" }).locator('img[src*="/portrait/image"]');

/** Opens the character's sheet and its studio from New art under the portrait. */
export async function openStudio(page: Page, id: string): Promise<Locator> {
  await page.goto(`/characters/${id}`);
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  await sheetNewArt(page).click();
  await expect(studio(page)).toBeVisible();
  return studio(page);
}

/** Use as portrait: the studio closes once the upload answered. */
export async function useAsPortrait(page: Page) {
  await studio(page).getByRole("button", { name: "Use as portrait" }).click();
  await expect(studio(page)).toHaveCount(0, { timeout: 30_000 });
}

/** The character's stored portrait version and its full PNG. */
export async function storedPortrait(
  request: APIRequestContext,
  id: string,
): Promise<{ version: number | null; png: Buffer }> {
  const character = await request.get(`/api/characters/${id}`);
  expect(character.status()).toBe(200);
  const { portrait } = (await character.json()) as { portrait: number | null };
  const image = await request.get(`/api/characters/${id}/portrait/image?size=full`);
  return { version: portrait, png: image.ok() ? await image.body() : Buffer.alloc(0) };
}

/**
 * The stored portrait a candidate becomes through Use as portrait, rebuilt
 * here by the server's own pipeline: byte for byte what the server keeps
 * when that candidate, and only it, was uploaded.
 */
export async function asStoredPortrait(candidate: Buffer): Promise<Buffer> {
  return Buffer.from((await toPortrait(new Uint8Array(candidate))).png);
}
