import { expect, type Page } from "@playwright/test";
import { cardChunk, plainPng, pngWithText } from "../../apps/server/test/image-fixtures.ts";

/** Card files for e2e flows, built in memory. */
export interface CardFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export const uniqueName = (base: string) => `${base} ${crypto.randomUUID().slice(0, 6)}`;

export function v3(data: Record<string, unknown>) {
  return { spec: "chara_card_v3", spec_version: "3.0", data };
}

export async function pngCard(
  file: string,
  card: unknown,
  width = 60,
  height = 90,
): Promise<CardFile> {
  // A real image with the card in its ccv3 chunk, as SillyTavern writes it.
  const base = pngWithText({ ccv3: cardChunk(card) }, width, height);
  return { name: file, mimeType: "image/png", buffer: Buffer.from(base) };
}

export function jsonCard(file: string, card: unknown): CardFile {
  return { name: file, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(card)) };
}

export async function imageFile(file: string): Promise<CardFile> {
  return { name: file, mimeType: "image/png", buffer: await plainPng(60, 90) };
}

/** Imports through the gallery's file picker, as the owner would. */
export async function importCards(page: Page, files: CardFile[]) {
  if (!page.url().endsWith("/characters")) await page.goto("/characters");
  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
}

export const tile = (page: Page, name: string) =>
  page.getByRole("list", { name: "Characters" }).getByRole("link", { name, exact: false });

/**
 * Opens the character's sheet from the gallery's search. `navigate` reaches
 * the gallery through the main navigation, which keeps the open chat in the
 * tab; otherwise the gallery is loaded anew.
 */
export async function openSheet(page: Page, name: string, { navigate = false } = {}) {
  if (navigate) {
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Characters", exact: true })
      .click();
  } else {
    await page.goto("/characters");
  }
  await page.getByRole("searchbox", { name: "Search characters" }).fill(name);
  await tile(page, name).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
}
