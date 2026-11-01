import type { APIRequestContext, Page } from "@playwright/test";
import { type CharacterMemory, characterMemorySchema } from "../../packages/core/src/responses.ts";
import { uniqueName } from "./cards.ts";
import { headerAction, lastReply, send } from "./chat.ts";
import { createCharacterViaApi, patchSettings } from "./entities.ts";
import { expect, unsafe } from "./test.ts";
import type { MockModel } from "./upstream.ts";

/**
 * Turns memory off for a character never touched (memory is on for every
 * character until then), as its sheet's switch does the first time.
 */
async function turnMemoryOff(request: APIRequestContext, characterId: string) {
  const response = await request.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: { enabled: false, revision: 0 },
  });
  expect(response.status()).toBe(200);
}

/** A character's memory as `GET /api/memory/characters/:id` answers it. */
export async function storedMemory(
  request: APIRequestContext,
  characterId: string,
): Promise<CharacterMemory> {
  const response = await request.get(`/api/memory/characters/${characterId}`);
  expect(response.status()).toBe(200);
  return characterMemorySchema.parse(await response.json());
}

/**
 * Memory's smallest sizes: a memory once about 1,500 tokens are unremembered,
 * only the newest message kept out of it, and a recap of four memories past
 * its budget (e2e/support/memory-fixtures.ts).
 */
const SMALL_MEMORY = {
  memorySpanTokens: 1_500,
  memoryKeepTurns: 1,
  memoryRecapTokens: 1_000,
} as const;

/**
 * The test's user chatting on `model` with a new character that has no
 * greeting unless `card` gives its greetings (or other card fields), memory
 * on as for every character unless `memory` is false (turned off), and
 * memory's smallest sizes.
 */
export async function memoryChat(
  request: APIRequestContext,
  {
    model = "mock-fast",
    memory = true,
    card = {},
  }: { model?: MockModel; memory?: boolean; card?: Record<string, unknown> } = {},
) {
  const name = uniqueName("Rememberer");
  const characterId = await createCharacterViaApi(request, name, card);
  if (!memory) await turnMemoryOff(request, characterId);
  await patchSettings(request, { model, characterId, ...SMALL_MEMORY });
  return { name, characterId };
}

/** Sends `line` and waits out its reply. */
export async function exchange(page: Page, line: string) {
  await send(page, line);
  await expect(lastReply(page)).toContainText(line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
}

export const seam = (page: Page) => page.locator("li[data-memory-seam]");
export const memoryMark = (page: Page) => page.locator("[data-memory-mark]");
/** The episodes and chapters on the memory screen, members of a chapter included. */
export const episodeRows = (page: Page) =>
  page.getByRole("list", { name: "Memories" }).locator("button[data-episode]");

/**
 * The seam's line once it has settled in one place: no memory being written,
 * and the seam that moved on gone from where it stood.
 */
export async function settledSeamLine(page: Page): Promise<string> {
  await expect(page.locator('li[data-memory-seam][data-status="remembering"]')).toHaveCount(0);
  await expect(seam(page)).toHaveCount(1);
  return (await seam(page).getByRole("status").textContent()) ?? "";
}

/** The seam's line once memories hold `count` turns, still sent, none folded. */
export const heldLine = (count: number) => `Remembered. ${count} turns still sent.`;

/** The seam's line once some remembered turns folded, with or without others still sent. */
export const FOLDED_LINE = /^Remembered\. \d+ turns? folded(, \d+ still sent)?\.$/;

/**
 * Opens the chat character's memory screen from the mark in the chat's
 * header; the chat stays in the tab's memory, and the screen knows it came
 * from the chat (`from=chat`), so its Back returns there.
 */
export async function openMemory(page: Page) {
  await headerAction(page, "Memory");
  await expect(page).toHaveURL((url) => /^\/characters\/[^/]+\/memory$/.test(url.pathname));
  await expect(page).toHaveURL((url) => url.searchParams.get("from") === "chat");
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
}

/** The memory screen's back control while the chat opened it. */
export const backToChat = (page: Page) =>
  page.getByRole("link", { name: "Back to chat", exact: true });

/**
 * Remember now on the memory screen, then back to the chat. The memory call
 * may still be running when the chat shows again.
 */
export async function rememberNow(page: Page) {
  await openMemory(page);
  const button = page.getByRole("button", { name: "Remember now" });
  await expect(button).toBeEnabled();
  await button.click();
  await page.goBack();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}
