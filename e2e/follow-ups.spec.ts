import type { Page } from "@playwright/test";
import { defaultPromptPreset } from "../packages/core/src/preset/prompt.ts";
import { uniqueName } from "./support/cards.ts";
import {
  chooseCharacter,
  chooseModel,
  lastReply,
  messages,
  openChat,
  replyActions,
  replyCounter,
  send,
  upstreamRecords,
} from "./support/chat.ts";
import {
  choose,
  closeSession,
  createCharacterViaApi,
  createPresetViaApi,
  DEFAULT_NOTE_SENT,
  expectNoOverflow,
  openSession,
  seriousAxeViolations,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

async function reasoningPreset(page: Page, change: object) {
  const preset = defaultPromptPreset();
  const name = uniqueName("Reasoning");
  await createPresetViaApi(page.request, "prompt", {
    name,
    blocks: preset.blocks,
    reasoning: { ...preset.reasoning, ...change },
  });
  return name;
}

async function usePromptPreset(page: Page, name: string) {
  await openSession(page);
  await choose(page, "Prompt preset", name);
  await closeSession(page);
}

test("delete from a message on, and delete one alternate, each with Undo", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(messages(page)).toHaveCount(4);

  const firstReply = messages(page).nth(1);
  await firstReply.hover();
  await firstReply.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: "Delete from here" }).click();
  await expect(messages(page)).toHaveCount(1);
  await expect(
    page.getByRole("status").filter({ hasText: "3 messages were deleted." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(messages(page)).toHaveCount(4);

  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await replyActions(page).getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete this alternate" }).click();
  // One reply left: the pager goes.
  await expect(replyCounter(page)).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "alternate replies was deleted" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
});

test("reasoning is edited in place and, when the preset says so, sent back", async ({ page }) => {
  const preset = await reasoningPreset(page, { addToPrompts: true });
  await openChat(page, "mock-fast");
  await usePromptPreset(page, preset);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await lastReply(page).locator("summary").click();
  await lastReply(page).getByRole("button", { name: "Edit reasoning" }).click();
  const field = page.getByRole("textbox", { name: "Edit reasoning" });
  await expect(field).toBeFocused();
  const edited = canary("think");
  await field.fill(edited);
  await field.press("Control+Enter");
  await expect(lastReply(page)).toContainText(edited);

  const next = canary("in");
  await send(page, next);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(next);
  expect(record?.messages.map((message) => message.content).join("\n")).toContain(
    `<think>${edited}</think>\n`,
  );
});

test("reasoning written inside a reply is read out of it when the preset says so", async ({
  page,
}) => {
  const preset = await reasoningPreset(page, { autoParse: true });
  await openChat(page, "mock-inline");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const prose = lastReply(page).locator("[data-prose]");
  await expect(prose).toContainText("<think>");

  await usePromptPreset(page, preset);
  const parsed = canary("in");
  await send(page, parsed);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page).locator("[data-prose]")).not.toContainText("<think>");
  await expect(lastReply(page).locator("[data-prose]")).toContainText(
    parsed.replace("-in-", "-out-"),
  );
  await lastReply(page).locator("summary").click();
  await expect(lastReply(page)).toContainText(parsed.replace("-in-", "-think-"));
});

test("a character's Character's Note is edited on its sheet, sent at its depth and exported", async ({
  page,
}) => {
  const character = uniqueName("Deep");
  const id = await createCharacterViaApi(page.request, character);
  await page.goto(`/characters/${id}`);
  const section = page.getByRole("region", { name: "Character's Note" });
  await expect(section).toContainText("Empty, nothing is sent.");
  // Card text persists, so it carries no canary (the server-writes check scans for them).
  const note = `Speak softly. ${uniqueName("depth")}`;
  await section.getByRole("textbox", { name: "Character's Note" }).fill(note);
  await section.getByRole("textbox", { name: "Depth" }).fill("1");
  await section.getByRole("textbox", { name: "Depth" }).blur();
  await choose(page, "Role", "User");
  await expect(section).toContainText("1 message from the end, as a user message");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expectNoOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);

  await page.reload();
  await expect(section.getByRole("textbox", { name: "Character's Note" })).toHaveValue(note);
  await expect(section.getByRole("textbox", { name: "Depth" })).toHaveValue("1");

  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  // Depth 1: one message from the end, just before the line sent, sharing its message with
  // the preset's Author's Note at the same depth and role.
  expect(record?.messages.slice(-2)).toEqual([
    { role: "user", content: `${DEFAULT_NOTE_SENT}\n${note}` },
    { role: "user", content: line },
  ]);

  const exported = (await (await page.request.get(`/api/characters/${id}/export.json`)).json()) as {
    data: { characterNote: { prompt: string; depth: number; role: string } };
  };
  expect(exported.data.characterNote).toEqual({ prompt: note, depth: 1, role: "user" });
});

test("Up edits the last message and Ctrl+Up your last one, only from an empty composer", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const first = canary("in");
  await send(page, first);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const composer = page.getByLabel("Message", { exact: true });
  const replyField = page.getByRole("textbox", { name: /^Edit .*'s reply$/ });
  const mineField = page.getByRole("textbox", { name: "Edit your message" });

  await composer.press("ArrowUp");
  await expect(replyField).toBeFocused();
  await expect(replyField).not.toHaveValue("");
  await replyField.press("Escape");
  await expect(replyField).toHaveCount(0);
  // An edit a key opened in the composer hands focus back to it.
  await expect(composer).toBeFocused();

  await composer.press("ControlOrMeta+ArrowUp");
  await expect(mineField).toBeFocused();
  await expect(mineField).toHaveValue(first);
  await mineField.press("ControlOrMeta+Enter");
  await expect(mineField).toHaveCount(0);
  await expect(composer).toBeFocused();

  // Closing one field and opening another within a frame: the new field keeps focus.
  await composer.press("ArrowUp");
  await expect(replyField).toBeFocused();
  await page.evaluate(() => {
    const key = (target: Element | null, init: KeyboardEventInit) =>
      target?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    key(document.activeElement, { key: "Escape" });
    const message = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    message?.focus();
    key(message, { key: "ArrowUp", ctrlKey: true });
  });
  await expect(mineField).toBeFocused();
  // Two frames: any focus return the closed field queued has run.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await expect(mineField).toBeFocused();
  await mineField.press("Escape");

  // With a draft, Up moves the caret as usual.
  await composer.fill("A draft");
  await composer.press("ArrowUp");
  await expect(composer).toBeFocused();
  await expect(replyField).toHaveCount(0);
  await composer.fill("");

  // Nothing is edited while a reply is written.
  await chooseModel(page, "mock-slow");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await composer.press("ArrowUp");
  await composer.press("ControlOrMeta+ArrowUp");
  await expect(composer).toBeFocused();
  await expect(mineField).toHaveCount(0);
  await page.getByRole("button", { name: "Stop" }).click();
});
