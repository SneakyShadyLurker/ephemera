import { readFile } from "node:fs/promises";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { CONTINUED_SCENE, NEW_SCENE, STORY_HEADING } from "../packages/core/src/memory/prompt.ts";
import { openSheet, uniqueName } from "./support/cards.ts";
import {
  chatMenuButton,
  chooseCharacter,
  chooseModel,
  clearChat,
  lastReply,
  moreAction,
  send,
  turns,
  upstreamRecords,
} from "./support/chat.ts";
import { createCharacterViaApi, patchSettings } from "./support/entities.ts";
import { APP_SERVERS } from "./support/env.ts";
import {
  backToChat,
  episodeRows,
  exchange,
  FOLDED_LINE,
  heldLine,
  memoryChat,
  memoryMark,
  openMemory,
  rememberNow,
  seam,
  settledSeamLine,
  storedMemory,
} from "./support/memory.ts";
import {
  CHAPTER_TITLE,
  MEMORY_CAST_NAME,
  MEMORY_FACT,
  MEMORY_OPENING,
  MEMORY_OPENING_SCENE,
  MEMORY_RELATIONSHIP,
  MEMORY_SITUATION,
  MEMORY_THREAD,
  MEMORY_TITLE,
  REGENERATED_OPENING,
} from "./support/memory-fixtures.ts";
import { expect, test, unsafe } from "./support/test.ts";

/*
 * Memory: a character with memory on remembers its story across chats. A
 * memory call folds the older turns of the open chat into an episode and
 * rewrites the character's notebook; both persist as character data, the
 * chat never does. Every test runs as a user of its own, with memory's
 * smallest sizes in their own settings, so no parallel spec meets them. The
 * mock upstream answers memory calls with fixed synthetic text
 * (e2e/support/memory-fixtures.ts). The retention rows are in
 * e2e/retention.spec.ts.
 */

const NOTHING_REMEMBERED = "Nothing remembered yet";

const prompt = (page: Page) => page.getByRole("dialog", { name: "Prompt" });
const folded = (page: Page) => page.locator("[data-message][data-folded]");
const unique = (text: string) => `${text} ${crypto.randomUUID().slice(0, 8)}`;
/** The fields a memory call's error line may carry (apps/server/src/log.ts). */
const OPERATIONAL = [
  "time",
  "level",
  "event",
  "model",
  "durationMs",
  "errorClass",
  "status",
  "finishReason",
  "attempt",
];

/** Two short exchanges: with one message kept out, three turns to remember. */
async function twoExchanges(page: Page) {
  const first = unique("We walked along the old road.");
  await exchange(page, first);
  await exchange(page, unique("The rain kept falling."));
  return first;
}

/** The upstream request a line went out in carries no memory of the character. */
async function sentWithoutMemory(line: string) {
  const [record] = await upstreamRecords(line);
  const contents = record?.messages.map((message) => message.content) ?? [];
  expect(contents.length).toBeGreaterThan(0);
  expect(contents.some((content) => content.startsWith(STORY_HEADING))).toBe(false);
}

/** About 850 tokens in the line and as many in its echo: two exchanges pass the smallest span. */
const longLine = () => `${unique("Long")} ${"Quiet rain fell on the old road. ".repeat(100)}`;

const main = (page: Page) => page.getByRole("navigation", { name: "Main" });

/**
 * Holds the requests `url` matches (with `method`, when given) in the
 * browser until `release`, then sends them on: what the page does
 * meanwhile happens before they arrive.
 */
async function hold(page: Page, url: string, method?: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route(url, async (route: Route) => {
    if (method !== undefined && route.request().method() !== method) return route.fallback();
    held++;
    await released;
    await route.continue();
  });
  return { release, held: () => held };
}

/**
 * Gives the character's notebook a unique situation and `MEMORY_OPENING`,
 * through the API, so Regenerate has something to write from; returns the
 * situation.
 */
async function rememberSituation(api: APIRequestContext, characterId: string): Promise<string> {
  const situation = unique(MEMORY_SITUATION);
  const revision = (await storedMemory(api, characterId)).state?.revision ?? 0;
  const remembered = await api.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: {
      notebook: { situation, relationships: [], facts: [], threads: [] },
      opening: MEMORY_OPENING,
      revision,
    },
  });
  expect(remembered.status()).toBe(200);
  return situation;
}

/** The memory's opening as a chat with `persona` opens on it. */
const filledOpening = (persona: string) => MEMORY_OPENING.replace("{{user}}", persona);

const greeting = (page: Page) => page.locator("[data-message][data-greeting]");

/** The chat opens on the memory's opening, its Location line set apart and `persona` filled in. */
async function expectOpening(page: Page, persona: string) {
  await expect(greeting(page)).toHaveCount(1);
  await expect(greeting(page).locator("blockquote")).toHaveText(
    "Location: The back room of the chandlery, after dark",
  );
  await expect(
    greeting(page).getByText(MEMORY_OPENING_SCENE.replace("{{user}}", persona), { exact: true }),
  ).toBeVisible();
}

const episodeEditor = (page: Page) => page.getByRole("dialog", { name: "Edit the memory" });

test("turning memory off in the sheet unfolds the chat and stops its injection and writes", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));

  // To the sheet through the navigation, so the chat stays in the tab.
  await openSheet(page, name, { navigate: true });
  const section = page.locator("#s-memory");
  const remember = section.getByRole("switch", { name: "Remember the story" });
  await expect(remember).toBeChecked();
  await remember.click();
  await expect(remember).not.toBeChecked();
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.enabled)
    .toBe(false);
  await main(page).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

  await expect(memoryMark(page)).toHaveCount(0);
  await expect(seam(page)).toHaveCount(0);
  await expect(turns(page)).toHaveCount(4);
  // Past the span, and nothing is remembered or sent of what was.
  const long = longLine();
  await exchange(page, long);
  const after = unique("After");
  await exchange(page, after);
  await sentWithoutMemory(after);
  expect(await upstreamRecords(long.slice(0, 20), "memory")).toEqual([]);
  expect((await storedMemory(request, characterId)).episodes).toHaveLength(1);
});

test("turning memory off on the memory screen shows the invitation and stops injection", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));

  await openMemory(page);
  const remember = page.getByRole("switch", { name: "Remember the story" });
  await expect(remember).toBeChecked();
  await remember.click();
  await expect(page.getByText(`Memory is off, so ${name} forgets each chat`)).toBeVisible();
  await expect(remember).not.toBeChecked();
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.enabled)
    .toBe(false);
  await page.goBack();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

  await expect(memoryMark(page)).toHaveCount(0);
  await expect(turns(page)).toHaveCount(4);
  const long = longLine();
  await exchange(page, long);
  const after = unique("After");
  await exchange(page, after);
  await sentWithoutMemory(after);
  expect(await upstreamRecords(long.slice(0, 20), "memory")).toEqual([]);
  expect((await storedMemory(request, characterId)).episodes).toHaveLength(1);
});

test("turning memory off right after a notebook edit saves the edit first", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto(`/characters/${characterId}/memory`);
  const situation = unique("They wait at the quay.");
  await page.getByRole("textbox", { name: "Situation" }).fill(situation);
  // Off at once, well inside the autosave's pause.
  await page.getByRole("switch", { name: "Remember the story" }).click();
  await expect(page.getByText(`Memory is off, so ${name} forgets each chat`)).toBeVisible();
  const stored = await storedMemory(request, characterId);
  expect(stored.state).toMatchObject({ enabled: false, notebook: { situation } });
});

test("the notebook takes no edits while memory turns off, so none typed meanwhile is lost", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto(`/characters/${characterId}/memory`);
  // The notebook's save and the switch's change wait in the browser.
  const patches = await hold(page, `**/api/memory/characters/${characterId}`, "PATCH");
  const field = page.getByRole("textbox", { name: "Situation" });
  const situation = unique("They wait at the quay.");
  await field.fill(situation);
  await page.getByRole("switch", { name: "Remember the story" }).click();
  await expect.poll(patches.held).toBeGreaterThan(0);
  // Typed while the save and the change are on their way: the notebook holds still.
  await expect(field).not.toBeEditable();
  await field.focus();
  await page.keyboard.type(" And then the ferry came.");
  await expect(field).toHaveValue(situation);
  patches.release();
  await expect(page.getByText(`Memory is off, so ${name} forgets each chat`)).toBeVisible();
  const stored = await storedMemory(request, characterId);
  expect(stored.state).toMatchObject({ enabled: false, notebook: { situation } });
});

test("a fresh character shows the mark and remembers by itself past the span: the remembered turns stay sent until the window fills, then fold", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  // Memory is on for a character never touched: nothing turns it on. mock-fold's window is small
  // enough for a few long exchanges to fill it.
  const { characterId } = await memoryChat(request, { model: "mock-fold" });
  await page.goto("/");
  await expect(memoryMark(page)).toBeVisible();
  await expect(memoryMark(page)).toHaveAccessibleName("Memory");
  expect((await storedMemory(request, characterId)).state).toBeNull();
  // About 1,240 estimated tokens in the line and as many in its echo: one exchange stays under
  // the span.
  const long = `${unique("First")} ${"Quiet rain fell on the old road. ".repeat(150)}`;
  await exchange(page, long);
  await expect(seam(page)).toHaveCount(0);
  // The second passes it: the line, its echo and the next line are remembered, its reply kept.
  await exchange(page, unique("Second"));
  await expect(seam(page)).toContainText(MEMORY_TITLE);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  await expect(memoryMark(page)).toContainText("3");
  // Held, the remembered turns stay in the thread, and nothing is folded to show.
  await expect(turns(page)).toHaveCount(4);
  await expect(folded(page)).toHaveCount(0);
  await expect(seam(page).getByRole("button", { name: "Show the folded turns" })).toHaveCount(0);
  const [call] = await upstreamRecords(long.slice(0, 20), "memory");
  expect(call?.messages.at(-1)?.content).toContain(long.trim());

  // The next request still sends the held turns whole, and tells their memory nowhere.
  const third = unique("Third");
  await exchange(page, third);
  const [record] = await upstreamRecords(third);
  const contents = record?.messages.map((message) => message.content) ?? [];
  const story = contents.findIndex((content) => content.startsWith(STORY_HEADING));
  expect(story).toBeGreaterThanOrEqual(0);
  expect(contents[story]).toContain(MEMORY_SITUATION);
  expect(contents.join("\n")).not.toContain(MEMORY_TITLE);
  expect(contents.some((content) => content.includes(long.slice(0, 20)))).toBe(true);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(prompt(page)).toContainText("Sent to mock-fold");
  await expect(prompt(page).getByRole("button", { name: /Chat history/ })).toContainText(
    "5 messages sent",
  );
  await expect(prompt(page)).not.toContainText("folded for this prompt");
  await prompt(page).getByRole("button", { name: "Close prompt" }).click();

  // Long exchanges fill the window: a request folds the oldest memories in place of their turns.
  let last = third;
  for (let sent = 0; sent < 10; sent++) {
    last = `${unique("Onward")} ${"Quiet rain fell on the old road. ".repeat(150)}`;
    await exchange(page, last);
    if ((await settledSeamLine(page)).includes("folded")) break;
  }
  await expect(seam(page).getByRole("status")).toHaveText(FOLDED_LINE);
  await expect(seam(page).getByRole("button", { name: "Show the folded turns" })).toBeVisible();
  const [folding] = await upstreamRecords(last.slice(0, 20));
  const sent = folding?.messages.map((message) => message.content) ?? [];
  expect(sent.some((content) => content.includes(long.slice(0, 20)))).toBe(false);
  const told = sent.find((content) => content.startsWith(STORY_HEADING));
  expect(told).toContain(MEMORY_TITLE);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(prompt(page)).toContainText(/memor(y|ies) folded for this prompt/);
  await prompt(page).getByRole("button", { name: "Close prompt" }).click();

  await openMemory(page);
  await expect(episodeRows(page).first()).toContainText(MEMORY_TITLE);
  await expect(page.getByRole("textbox", { name: "Situation" })).toHaveValue(MEMORY_SITUATION);
  await expect(page.getByRole("textbox", { name: "Facts, line 1" })).toHaveValue(MEMORY_FACT);
  await expect(page.getByRole("textbox", { name: "Open threads, line 1" })).toHaveValue(
    MEMORY_THREAD,
  );
});

test("Remember now writes a memory of a chat below the span", async ({ page, request }) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  const first = await twoExchanges(page);
  await expect(seam(page)).toHaveCount(0);
  await openMemory(page);
  await page.getByRole("button", { name: "Remember now" }).click();
  await expect(episodeRows(page)).toHaveCount(1);
  await expect(episodeRows(page)).toContainText(MEMORY_TITLE);
  const calls = await upstreamRecords(first, "memory");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.answer).not.toContain(first);
  expect((await storedMemory(request, characterId)).episodes).toMatchObject([
    { title: MEMORY_TITLE, turns: 3 },
  ]);
  await page.goBack();
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
});

test("Remember now waits for a message edit open in its span, then remembers the saved correction", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  const first = await twoExchanges(page);
  // The first line is in Remember now's span; its correction is typed, not saved.
  await moreAction(page, turns(page).first(), "Edit");
  const field = page.getByRole("textbox", { name: "Edit your message" });
  const corrected = unique("We walked along the new road.");
  await field.fill(corrected);

  await openMemory(page);
  const button = page.getByRole("button", { name: "Remember now" });
  await expect(button).toBeDisabled();
  await button.hover();
  await expect(page.getByText("Save or cancel the message edit in Chat first.")).toBeVisible();
  expect(await upstreamRecords(first, "memory")).toEqual([]);

  // The draft waits in the chat as it was left; saved, the span takes it.
  await backToChat(page).click();
  await expect(field).toHaveValue(corrected);
  await turns(page).first().getByRole("button", { name: "Save", exact: true }).click();
  await expect(turns(page).first()).toContainText(corrected);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  expect(await upstreamRecords(corrected, "memory")).toHaveLength(1);
  expect((await storedMemory(request, characterId)).episodes).toMatchObject([
    { title: MEMORY_TITLE, turns: 3 },
  ]);
});

test("Remember and start new writes the ending, newest turns included, and the next chat begins after it", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  const other = uniqueName("Stranger");
  await createCharacterViaApi(request, other);
  await page.goto("/");
  const first = await twoExchanges(page);
  const newest = unique("The lamps went out.");
  await exchange(page, newest);
  await expect(memoryMark(page)).toBeVisible();
  // Below the span: nothing is remembered yet.
  expect(await upstreamRecords(first, "memory")).toEqual([]);

  await page.getByRole("button", { name: "Session", exact: true }).click();
  await page.getByRole("combobox", { name: "Character" }).click();
  await page.getByRole("option", { name: other, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: `Start a new chat with ${other}?` });
  await expect(dialog).toContainText(`as a memory of ${name}`);
  await expect(dialog.getByRole("button", { name: "Start new without remembering" })).toBeVisible();
  await dialog.getByRole("button", { name: "Remember and start new" }).click();
  await expect(dialog).toHaveCount(0);
  const sheet = page.getByRole("dialog", { name: "Session" });
  if (await sheet.isVisible()) await page.keyboard.press("Escape");
  await expect(turns(page)).toHaveCount(0);

  // One memory of the whole chat, its newest exchange included.
  const [call] = await upstreamRecords(first, "memory");
  expect(call?.messages.at(-1)?.content).toContain(newest);
  expect((await storedMemory(request, characterId)).episodes).toMatchObject([
    { title: MEMORY_TITLE, turns: 6 },
  ]);

  // Back with the first character, a new chat opens where the last one ended, its persona filled in.
  await chooseCharacter(page, name);
  await expectOpening(page, "User");
  // And it is told the story before it, as the scene going on.
  const opening = unique("Morning again.");
  await exchange(page, opening);
  const [record] = await upstreamRecords(opening);
  expect(record?.messages.find((message) => message.role === "assistant")?.content).toBe(
    filledOpening("User"),
  );
  const story = record?.messages.find((message) => message.content.startsWith(STORY_HEADING));
  expect(story?.content).toContain(CONTINUED_SCENE);
  expect(story?.content).not.toContain(NEW_SCENE);
  expect(story?.content).toContain(`Before this chat\n${MEMORY_TITLE}.`);
  expect(story?.content).toContain(`Relationships\n- ${MEMORY_RELATIONSHIP}`);
});

/** A card with a first message and one alternate greeting. */
const GREETED = {
  firstMessage: "The shop bell rings as {{user}} comes in from the rain.",
  alternateGreetings: ["The quay lies quiet under the morning fog."],
};

/** The card's greetings as its JSON export carries them. */
async function exportedGreetings(api: APIRequestContext, characterId: string) {
  const response = await api.get(`/api/characters/${characterId}/export.json`);
  expect(response.status()).toBe(200);
  const { data } = (await response.json()) as {
    data: { firstMessage: string; alternateGreetings: string[] };
  };
  return { firstMessage: data.firstMessage, alternateGreetings: data.alternateGreetings };
}

/** Writes the character's next chat opening straight into its memory, with no memory call. */
async function setOpening(api: APIRequestContext, characterId: string, opening: string) {
  const revision = (await storedMemory(api, characterId)).state?.revision ?? 0;
  const response = await api.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: { opening, revision },
  });
  expect(response.status()).toBe(200);
}

/** The story block of the request `line` went out in. */
async function storySent(line: string) {
  const [record] = await upstreamRecords(line);
  return record?.messages.find((message) => message.content.startsWith(STORY_HEADING))?.content;
}

/** The chat shows the card's first message as its greeting, and nothing of the memory's opening. */
async function expectCardGreeting(page: Page) {
  await expect(greeting(page)).toHaveCount(1);
  await expect(greeting(page)).toContainText("The shop bell rings as User comes in from the rain.");
  await expect(greeting(page)).not.toContainText("The chandler stands");
  await expect(page.getByRole("button", { name: "Greeting 1 of 2" })).toBeVisible();
}

test("a remembered character's next chat opens on the memory's opening, the card's greetings as swipes, and the model hears which scene goes on", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request, { card: GREETED });
  const before = await exportedGreetings(request, characterId);
  expect(before).toEqual(GREETED);
  await page.goto("/");
  await expect(greeting(page)).toContainText("The shop bell rings");
  await twoExchanges(page);
  await rememberNow(page);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.opening)
    .toBe(MEMORY_OPENING);

  // Cleared without remembering, the chat with the character starts again on the opening.
  await clearChat(page);
  await chooseCharacter(page, name);
  await expectOpening(page, "User");
  await expect(page.getByRole("button", { name: "Greeting 1 of 3" })).toBeVisible();
  // The card's first message and its alternate follow as swipes.
  await page.getByRole("button", { name: "Next greeting" }).click();
  await expect(lastReply(page)).toContainText(
    "The shop bell rings as User comes in from the rain.",
  );
  await page.getByRole("button", { name: "Next greeting" }).click();
  await expect(lastReply(page)).toContainText("The quay lies quiet under the morning fog.");
  await expect(page.getByRole("button", { name: "Next greeting" })).toBeDisabled();
  // Back on the opening, the chat goes on from the last scene.
  await page.getByRole("button", { name: "Previous greeting" }).click();
  await page.getByRole("button", { name: "Previous greeting" }).click();
  await expectOpening(page, "User");
  const continued = unique("Still by the window.");
  await exchange(page, continued);
  expect(await storySent(continued)).toContain(CONTINUED_SCENE);
  expect(await storySent(continued)).not.toContain(NEW_SCENE);

  // On the card's greeting instead, it is a new scene.
  await clearChat(page);
  await chooseCharacter(page, name);
  await expectOpening(page, "User");
  await page.getByRole("button", { name: "Next greeting" }).click();
  await expect(lastReply(page)).toContainText(
    "The shop bell rings as User comes in from the rain.",
  );
  const fresh = unique("Out of the rain.");
  await exchange(page, fresh);
  const [record] = await upstreamRecords(fresh);
  expect(record?.messages.find((message) => message.role === "assistant")?.content).toBe(
    "The shop bell rings as User comes in from the rain.",
  );
  expect(await storySent(fresh)).toContain(NEW_SCENE);
  expect(await storySent(fresh)).not.toContain(CONTINUED_SCENE);

  // The card itself never changed.
  expect(await exportedGreetings(request, characterId)).toEqual(before);
});

test("with the setting off, or memory off for the character, the card's greeting opens the chat and the card stays as it was", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request, { card: GREETED });
  await setOpening(request, characterId, MEMORY_OPENING);
  const before = await exportedGreetings(request, characterId);
  expect(before).toEqual(GREETED);
  await page.goto("/");
  await expectOpening(page, "User");

  // Off in Settings, on by default; the choice is kept.
  await page.goto("/settings?section=memory");
  const opening = page.getByRole("switch", { name: "Open new chats where the story left off" });
  await expect(opening).toBeChecked();
  await opening.click();
  await expect(opening).not.toBeChecked();
  const saved = async () =>
    (
      (await (await request.get("/api/settings")).json()) as {
        settings: { memoryOpening: boolean };
      }
    ).settings.memoryOpening;
  await expect.poll(saved).toBe(false);
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Open new chats where the story left off" }),
  ).not.toBeChecked();
  await page.goto("/");
  await expectCardGreeting(page);

  // On again, but memory off for the character: the card's greeting still.
  await patchSettings(request, { memoryOpening: true });
  const revision = (await storedMemory(request, characterId)).state?.revision ?? 0;
  const off = await request.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: { enabled: false, revision },
  });
  expect(off.status()).toBe(200);
  await page.goto("/");
  await expectCardGreeting(page);

  // The opening stayed memory data: the card never carried it.
  const after = await exportedGreetings(request, characterId);
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toContain("The chandler stands");
});

test("the memory screen edits the next chat's opening, and Forget everything empties it", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request, { card: GREETED });
  await setOpening(request, characterId, MEMORY_OPENING);
  await page.goto(`/characters/${characterId}/memory`);
  const field = page.getByRole("textbox", { name: "Next chat opens with" });
  await expect(field).toHaveValue(MEMORY_OPENING);
  const opening = async () => (await storedMemory(request, characterId)).state?.opening;

  const edited = unique("The ferry is due within the hour.");
  await field.fill(edited);
  await expect.poll(opening).toBe(edited);
  await field.fill("");
  await expect.poll(opening).toBe("");
  // An opening alone is something remembered, which Forget everything forgets.
  await field.fill(edited);
  await expect.poll(opening).toBe(edited);
  await page.getByRole("button", { name: "Memory actions" }).click();
  await page.getByRole("menuitem", { name: "Forget everything" }).click();
  await page
    .getByRole("alertdialog", { name: /^Forget everything/ })
    .getByRole("button", { name: "Forget everything" })
    .click();
  await expect(field).toHaveValue("");
  await expect.poll(opening).toBe("");

  await page.goto("/");
  await expectCardGreeting(page);
});

test("Regenerate writes the next chat's opening from what is remembered, saved by the notebook, and Undo restores the last one", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request, { card: GREETED });
  const situation = await rememberSituation(request, characterId);
  await page.goto(`/characters/${characterId}/memory`);
  const field = page.getByRole("textbox", { name: "Next chat opens with" });
  await expect(field).toHaveValue(MEMORY_OPENING);
  const opening = async () => (await storedMemory(request, characterId)).state?.opening;

  await page.getByRole("button", { name: "Regenerate" }).click();
  // Written as stored: the persona as {{user}}, the Location line set apart.
  await expect(field).toHaveValue(REGENERATED_OPENING);
  await expect.poll(opening).toBe(REGENERATED_OPENING);
  // One opening call, on the reply's model while no memory model is chosen, reading the notebook.
  const calls = await upstreamRecords(situation, "opening");
  expect(calls.map((call) => call.model)).toEqual(["mock-fast"]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(field).toHaveValue(MEMORY_OPENING);
  await expect.poll(opening).toBe(MEMORY_OPENING);
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("the notebook holds still while Regenerate writes, and takes edits again once it is written", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request, { card: GREETED });
  await rememberSituation(request, characterId);
  await page.goto(`/characters/${characterId}/memory`);
  const calls = await hold(page, `**/api/memory/characters/${characterId}/opening`, "POST");
  const situation = page.getByRole("textbox", { name: "Situation" });
  const field = page.getByRole("textbox", { name: "Next chat opens with" });
  const addFact = page.getByRole("button", { name: "Add a fact" });
  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect.poll(calls.held).toBe(1);
  // An edit made now could be saved under an answer written from the notebook before it.
  await expect(situation).not.toBeEditable();
  await expect(field).not.toBeEditable();
  await expect(addFact).toBeDisabled();
  calls.release();
  await expect(field).toHaveValue(REGENERATED_OPENING);
  await expect(situation).toBeEditable();
  await expect(addFact).toBeEnabled();
});

test("Regenerate writes nothing while the notebook's edits cannot be saved, and says so", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request, { card: GREETED });
  await rememberSituation(request, characterId);
  await page.goto(`/characters/${characterId}/memory`);
  // Another tab saved first: every save of this one meets a conflict.
  await page.route(`**/api/memory/characters/${characterId}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 409, json: { error: "conflict", revision: 1_000 } })
      : route.fallback(),
  );
  let calls = 0;
  await page.route(`**/api/memory/characters/${characterId}/opening`, (route) => {
    calls++;
    return route.fallback();
  });
  const situation = page.getByRole("textbox", { name: "Situation" });
  const field = page.getByRole("textbox", { name: "Next chat opens with" });
  await situation.fill(unique("They wait at the quay."));
  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(
    page.getByText("The opening was not written: the notebook's edits must be saved first."),
  ).toBeVisible();
  await expect(field).toHaveValue(MEMORY_OPENING);
  await expect(situation).toBeEditable();
  expect(calls).toBe(0);
});

test("while memory turns off, Regenerate's answer is not applied and Undo waits", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request, { card: GREETED });
  await rememberSituation(request, characterId);
  await page.goto(`/characters/${characterId}/memory`);
  const field = page.getByRole("textbox", { name: "Next chat opens with" });
  const regenerate = page.getByRole("button", { name: "Regenerate" });
  const undo = page.getByRole("button", { name: "Undo" });
  const remember = page.getByRole("switch", { name: "Remember the story" });
  await regenerate.click();
  await expect(field).toHaveValue(REGENERATED_OPENING);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.opening)
    .toBe(REGENERATED_OPENING);
  // Memory turning off holds the notebook: Undo and Regenerate wait with it.
  const patches = await hold(page, `**/api/memory/characters/${characterId}`, "PATCH");
  await remember.click();
  await expect.poll(patches.held).toBeGreaterThan(0);
  await expect(undo).toBeDisabled();
  await expect(regenerate).toBeDisabled();
  await undo.click({ force: true });
  await expect(field).toHaveValue(REGENERATED_OPENING);
  patches.release();
  await expect(page.getByText(`Memory is off, so ${name} forgets each chat`)).toBeVisible();
  expect((await storedMemory(request, characterId)).state).toMatchObject({
    enabled: false,
    opening: REGENERATED_OPENING,
  });
  await page.unroute(`**/api/memory/characters/${characterId}`);

  // On again, a write under way when memory turns off ends, its answer applied nowhere.
  await remember.click();
  await expect(regenerate).toBeEnabled();
  const typed = unique("> Location: The quay\n\nThey wait.");
  await field.fill(typed);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.opening)
    .toBe(typed);
  let releaseCall = () => {};
  const callHeld = new Promise<void>((resolve) => {
    releaseCall = resolve;
  });
  let calls = 0;
  await page.route(`**/api/memory/characters/${characterId}/opening`, async (route) => {
    calls++;
    await callHeld;
    // Ended in the page meanwhile, the request may be gone.
    await route.continue().catch(() => {});
  });
  const offing = await hold(page, `**/api/memory/characters/${characterId}`, "PATCH");
  await regenerate.click();
  await expect.poll(() => calls).toBe(1);
  await remember.click();
  await expect.poll(offing.held).toBeGreaterThan(0);
  releaseCall();
  // The write ended: Regenerate is back, held with the notebook.
  await expect(regenerate).toBeDisabled();
  await expect(field).toHaveValue(typed);
  await expect(undo).toHaveCount(0);
  offing.release();
  await expect(page.getByText(`Memory is off, so ${name} forgets each chat`)).toBeVisible();
  expect((await storedMemory(request, characterId)).state?.opening).toBe(typed);
});

test("an opening too long for the memory model links to Memory & cast", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request, { card: GREETED });
  await rememberSituation(request, characterId);
  await page.goto(`/characters/${characterId}/memory`);
  await page.route(`**/api/memory/characters/${characterId}/opening`, (route) =>
    route.fulfill({ status: 422, json: { error: "prompt_too_long" } }),
  );
  await page.getByRole("button", { name: "Regenerate" }).click();
  await page.getByRole("link", { name: "Memory settings" }).click();
  await expect(page).toHaveURL(/\/settings\?section=memory$/);
  await expect(page.getByRole("tab", { name: "Memory & cast", selected: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Remember every", exact: true })).toBeVisible();
});

test("Regenerate waits, saying why, while the character remembers nothing", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto(`/characters/${characterId}/memory`);
  const regenerate = page.getByRole("button", { name: "Regenerate" });
  await expect(regenerate).toBeDisabled();
  await regenerate.hover();
  await expect(page.getByText("Nothing is remembered yet to write it from.")).toBeVisible();
});

test("an ending written but whose answer was lost keeps its turns read-only, and Try again holds that one memory over them", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  const first = await twoExchanges(page);
  // The first memory call reaches Ephemera, which writes it; its answer never reaches the tab.
  const attempts: string[] = [];
  await page.route("**/api/memory/remember", async (route) => {
    attempts.push((route.request().postDataJSON() as { attempt: string }).attempt);
    if (attempts.length > 1) return route.fallback();
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: /^Clear/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Clear this chat?" });
  await dialog.getByRole("button", { name: "Remember and clear" }).click();
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText("Could not confirm the memory was written");
  await expect(failure).toContainText("Those turns stay read-only until confirmed.");
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Clear without remembering" })).toBeVisible();
  expect(attempts).toHaveLength(1);
  expect((await storedMemory(request, characterId)).episodes).toMatchObject([
    { title: MEMORY_TITLE, turns: 4 },
  ]);

  // Kept chatting: the turns it was written from offer no Edit, Delete, Regenerate or swipe.
  await dialog.getByRole("button", { name: "Keep chatting" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(turns(page)).toHaveCount(4);
  for (const turn of await turns(page).all()) {
    await turn.hover();
    await expect(turn.getByRole("button", { name: /^More actions/ })).toHaveCount(0);
  }
  await expect(page.locator("[data-reply-actions]")).toHaveCount(0);
  await expect(turns(page).first()).toContainText(first);
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable();

  // Try again sends the same attempt over the same turns: the memory written is answered.
  await seam(page).getByRole("button", { name: "Try again" }).click();
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(4));
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  expect(await upstreamRecords(first, "memory")).toHaveLength(1);
  expect((await storedMemory(request, characterId)).episodes).toMatchObject([
    { title: MEMORY_TITLE, turns: 4 },
  ]);

  // The chat goes on: a newer turn is open, the remembered ones stay as they were written.
  const newer = unique("The lamps went out.");
  await exchange(page, newer);
  await expect(turns(page)).toHaveCount(6);
  await turns(page).nth(4).hover();
  await expect(
    turns(page)
      .nth(4)
      .getByRole("button", { name: /^More actions/ }),
  ).toHaveCount(1);
  await turns(page).first().hover();
  await expect(
    turns(page)
      .first()
      .getByRole("button", { name: /^More actions/ }),
  ).toHaveCount(0);
  await expect(turns(page).first()).toContainText(first);
  expect((await storedMemory(request, characterId)).episodes).toHaveLength(1);
});

test("a reload keeps the notebook and the memories, and the chat is gone", async ({
  page,
  request,
}) => {
  await memoryChat(request);
  // Leaving a chat asks first; the owner confirms.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  await openMemory(page);
  await page.reload();
  await expect(episodeRows(page)).toHaveCount(1);
  await expect(episodeRows(page)).toContainText(MEMORY_TITLE);
  await expect(page.getByRole("textbox", { name: "Situation" })).toHaveValue(MEMORY_SITUATION);
  await page.goto("/");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(memoryMark(page)).toBeVisible();
  await expect(turns(page)).toHaveCount(0);
  await expect(seam(page)).toHaveCount(0);
});

test("a title edited on the memory screen shows on the seam and survives a reload", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page)).toContainText(MEMORY_TITLE);
  await openMemory(page);
  await episodeRows(page).click();
  const editor = page.getByRole("dialog", { name: "Edit the memory" });
  const title = unique("The quay at dusk");
  await editor.getByRole("textbox", { name: "Title" }).fill(title);
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(editor).toHaveCount(0);
  await expect(episodeRows(page)).toContainText(title);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).episodes[0]?.title)
    .toBe(title);
  await page.goBack();
  await expect(seam(page)).toContainText(title);
  await expect(seam(page)).not.toContainText(MEMORY_TITLE);
  await page.goto(`/characters/${characterId}/memory`);
  await expect(episodeRows(page)).toContainText(title);
});

test("Forget on the seam frees the held turns and deletes the memory", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  const line = seam(page).getByRole("status");
  await expect(line).toHaveText(heldLine(3));
  await expect(turns(page)).toHaveCount(4);
  // The line stands centred under the title: Edit and Forget take no room from it.
  const offCentre = await seam(page).evaluate((li) => {
    const centre = (box: DOMRect) => box.x + box.width / 2;
    const title = li.querySelector("p:not([role])")?.getBoundingClientRect();
    const status = li.querySelector("[role=status]")?.getBoundingClientRect();
    return title && status ? Math.abs(centre(title) - centre(status)) : Infinity;
  });
  expect(offCentre).toBeLessThan(1);
  await seam(page).hover();
  await seam(page).getByRole("button", { name: "Forget", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Forget this memory?" });
  await confirm.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(seam(page)).toHaveCount(0);
  await expect(turns(page)).toHaveCount(4);
  await expect(folded(page)).toHaveCount(0);
  expect((await storedMemory(request, characterId)).episodes).toEqual([]);
});

test("deleting the last memory in its editor leaves focus on the list's heading", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  await openMemory(page);
  await episodeRows(page).click();
  await episodeEditor(page).getByRole("button", { name: "Delete this memory" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete this memory?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(episodeEditor(page)).toHaveCount(0);
  await expect(episodeRows(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Memories", level: 2 })).toBeFocused();
  expect((await storedMemory(request, characterId)).episodes).toEqual([]);
});

test("on a phone, a memory with a long cue keeps the screen to its width, and its editor is the shared sheet that keeps Done in view and guards unsaved edits", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  // A long unbroken cue and a long summary, as a model may write them.
  const [episode] = (await storedMemory(request, characterId)).episodes;
  const cue = "x".repeat(60);
  const saved = await request.patch(`/api/memory/episodes/${episode?.id}`, {
    headers: unsafe(),
    data: {
      cues: [cue, "the quay"],
      summary: "The rain kept falling on the old road. ".repeat(60),
      revision: episode?.revision,
    },
  });
  expect(saved.status()).toBe(200);
  await openMemory(page);
  const row = episodeRows(page);
  await expect(row).toContainText(cue.slice(0, 10));
  const width = await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll<HTMLElement>("main [data-skip-target]")];
    return {
      page: document.documentElement.scrollWidth,
      scrollers: scrollers.map((scroller) => scroller.scrollWidth - scroller.clientWidth),
    };
  });
  expect(width.page).toBeLessThanOrEqual(393);
  for (const overflow of width.scrollers) expect(overflow).toBeLessThanOrEqual(0);
  const box = await row.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(393);

  // The editor: its title and close above, Delete and Done in view below the long summary.
  await row.click();
  const editor = episodeEditor(page);
  await expect(editor.getByRole("button", { name: "Close the memory" })).toBeInViewport();
  await expect(editor.getByRole("button", { name: "Done" })).toBeInViewport();
  await expect(editor.getByRole("button", { name: "Delete this memory" })).toBeInViewport();
  // The phone sheet is the app's shared drawer, and its guard holds: an edit that cannot be
  // saved keeps it open on the first close and lets the second leave without it.
  await expect(editor).toHaveAttribute("data-slot", "drawer-popup");
  await page.route("**/api/memory/episodes/**", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.fallback(),
  );
  await editor.getByRole("textbox", { name: "Title" }).fill(unique("The pier"));
  await page.keyboard.press("Escape");
  await expect(editor.getByText(/Close again to leave without saving\./)).toBeVisible();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Close the memory" }).click();
  await expect(editor).toHaveCount(0);
});

test("notebook edits stay, and are saved, when memory is turned off in another tab", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto(`/characters/${characterId}/memory`);
  await expect(page.getByRole("switch", { name: "Remember the story" })).toBeChecked();
  // The notebook's save waits in the browser.
  const patches = await hold(page, `**/api/memory/characters/${characterId}`, "PATCH");
  const field = page.getByRole("textbox", { name: "Situation" });
  const situation = unique("They wait at the quay.");
  await field.fill(situation);
  await expect.poll(patches.held).toBeGreaterThan(0);
  // Another tab turns memory off; this tab hears of it when it is looked at again.
  const revision = (await storedMemory(request, characterId)).state?.revision ?? 0;
  const off = await request.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: { enabled: false, revision },
  });
  expect(off.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText(`Memory is off, so ${name} forgets each chat`)).toBeVisible();
  await expect(page.getByText("Memory was turned off elsewhere.")).toBeVisible();
  await expect(field).toHaveValue(situation);

  // The held save meets the other tab's change; Keep mine saves the edits over it.
  patches.release();
  await page.getByRole("button", { name: "Keep mine" }).click();
  await expect(field).toHaveCount(0);
  await expect(page.getByText(`Memory is off, so ${name} forgets each chat`)).toBeVisible();
  const stored = await storedMemory(request, characterId);
  expect(stored.state).toMatchObject({ enabled: false, notebook: { situation } });
});

test("Forget everything empties the memory screen, keeps memory on and unfolds the open chat whole", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  const first = await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  await openMemory(page);
  await expect(episodeRows(page)).toHaveCount(1);
  const situation = page.getByRole("textbox", { name: "Situation" });
  await expect(situation).toHaveValue(MEMORY_SITUATION);
  // The memory's reload after Forget waits: the screen empties on Forget's answer alone.
  const reload = await hold(page, `**/api/memory/characters/${characterId}`, "GET");
  await page.getByRole("button", { name: "Memory actions" }).click();
  await page.getByRole("menuitem", { name: "Forget everything" }).click();
  await page
    .getByRole("alertdialog", { name: /^Forget everything/ })
    .getByRole("button", { name: "Forget everything" })
    .click();
  await expect(episodeRows(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: NOTHING_REMEMBERED })).toBeVisible();
  // The menu that held focus went with what it forgot: the screen's title takes it.
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeFocused();
  await expect(page.getByRole("switch", { name: "Remember the story" })).toBeChecked();
  await expect(situation).toHaveValue("");
  await expect(page.getByRole("textbox", { name: /^Facts, line/ })).toHaveCount(0);
  await expect.poll(reload.held).toBeGreaterThan(0);
  reload.release();
  const forgotten = await storedMemory(request, characterId);
  expect(forgotten.episodes).toEqual([]);
  expect(forgotten.state).toMatchObject({
    enabled: true,
    notebook: { situation: "", relationships: [], facts: [], threads: [] },
  });
  await page.goBack();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(seam(page)).toHaveCount(0);
  await expect(memoryMark(page)).toBeVisible();
  await expect(turns(page)).toHaveCount(4);
  // The next request carries the whole history again, and no memory.
  const next = unique("Next");
  await exchange(page, next);
  const [record] = await upstreamRecords(next);
  const contents = record?.messages.map((message) => message.content) ?? [];
  expect(contents.some((content) => content.includes(first))).toBe(true);
  await sentWithoutMemory(next);
});

for (const { width, height, form } of [
  { width: 1440, height: 900, form: "desktop" },
  { width: 390, height: 844, form: "phone" },
]) {
  test(`on a ${form}, the memory screen's back control returns to the same chat with its turns`, async ({
    page,
    request,
  }) => {
    await memoryChat(request);
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const first = await twoExchanges(page);
    await rememberNow(page);
    await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
    // On a phone the mark is in the chat menu; its count shows on the menu's button.
    if (form === "phone") {
      await expect(chatMenuButton(page).locator("[data-remembered-count]")).toHaveText("3");
    }
    await openMemory(page);
    // Labelled on every width: on a phone too, the word says where it goes.
    await expect(backToChat(page)).toHaveText("Chat");
    await backToChat(page).click();
    await expect(page).toHaveURL((url) => url.pathname === "/" && url.search === "");
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
    await expect(turns(page)).toHaveCount(4);
    await expect(turns(page).first()).toContainText(first);
  });
}

test("from the character's sheet, the memory screen's back control returns to the sheet", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto(`/characters/${characterId}`);
  await page.locator("#s-memory").getByRole("link", { name: "Open memory" }).click();
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
  await expect(page).toHaveURL((url) => url.searchParams.get("from") === null);
  await expect(backToChat(page)).toHaveCount(0);
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/characters/${characterId}`);
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
});

test("the navigation marks Chat while the chat's memory screen is open, Characters from the sheet", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openMemory(page);
  const chat = main(page).getByRole("link", { name: "Chat", exact: true });
  const characters = main(page).getByRole("link", { name: "Characters", exact: true });
  await expect(chat).toHaveAttribute("aria-current", "page");
  await expect(characters).not.toHaveAttribute("aria-current", "page");
  await page.goto(`/characters/${characterId}/memory`);
  await expect(page.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
  await expect(characters).toHaveAttribute("aria-current", "page");
  await expect(chat).not.toHaveAttribute("aria-current", "page");
});

test("removing the last fact or thread leaves focus on its Add button", async ({
  page,
  request,
}) => {
  await memoryChat(request);
  await page.goto("/");
  await openMemory(page);
  for (const [label, item] of [
    ["Facts", "fact"],
    ["Open threads", "thread"],
  ] as const) {
    const add = page.getByRole("button", { name: `Add a ${item}`, exact: true });
    await add.click();
    await expect(page.getByRole("textbox", { name: `${label}, line 1` })).toBeFocused();
    await page.getByRole("button", { name: `Remove this ${item}`, exact: true }).click();
    await expect(page.getByRole("textbox", { name: `${label}, line 1` })).toHaveCount(0);
    await expect(add).toBeFocused();
  }
});

test("remembered NPC anchors seed the next chat and notebook edits replace or remove seed-only people", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast.length)
    .toBe(1);
  const line = (await storedMemory(request, characterId)).state?.notebook.cast[0] ?? "";
  await clearChat(page);
  await chooseCharacter(page, name);
  const next = unique("The next morning");
  await exchange(page, next);
  const [sent] = await upstreamRecords(next);
  expect(sent?.messages.find((message) => message.content.startsWith("<cast>"))?.content).toContain(
    MEMORY_CAST_NAME,
  );
  expect(
    sent?.messages.find((message) => message.content.startsWith(STORY_HEADING))?.content,
  ).not.toContain(line);
  await openMemory(page);
  // The stored line reads as a person: the name, then the fixed details.
  const person = page.getByRole("button", { name: new RegExp(`^${MEMORY_CAST_NAME}`) });
  await expect(person).toContainText("Female, age 31, hair black bob");
  expect(JSON.parse(line)).toMatchObject({ name: MEMORY_CAST_NAME, age: "31" });
  await person.click();
  // Edited through the same details, it is stored in the same shape.
  const renamed = JSON.stringify({
    name: "Noor Haddad",
    gender: "female",
    age: "32",
    hair: "silver",
  });
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Noor Haddad");
  await page.getByRole("textbox", { name: "Age", exact: true }).fill("32");
  await page.getByRole("textbox", { name: "Hair", exact: true }).fill("silver");
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([renamed]);
  await backToChat(page).click();
  const afterEdit = unique("After the notebook edit");
  await exchange(page, afterEdit);
  const [edited] = await upstreamRecords(afterEdit);
  const cast = edited?.messages.find((message) => message.content.startsWith("<cast>"))?.content;
  expect(cast).toContain("Noor Haddad");
  expect(cast).not.toContain(MEMORY_CAST_NAME);
  await openMemory(page);
  await page.getByRole("button", { name: "Remove this cast line", exact: true }).click();
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([]);
  await backToChat(page).click();
  const afterDelete = unique("After removing the anchor");
  await exchange(page, afterDelete);
  const [removed] = await upstreamRecords(afterDelete);
  expect(removed?.messages.some((message) => message.content.startsWith("<cast>"))).toBe(false);
});

test("a person's gender chosen before their name is kept, and saved with the name", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await openMemory(page);
  await page.getByRole("button", { name: "Add a person", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  const gender = page.getByRole("combobox", { name: "Gender", exact: true });
  await expect(name).toBeFocused();
  await gender.click();
  await page.getByRole("option", { name: "Male", exact: true }).click();
  await expect(gender).toHaveText("Male");
  await name.fill("Tomas Weller");
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([JSON.stringify({ name: "Tomas Weller", gender: "male" })]);
  // Cleared again, the name leaves nothing to keep, and the form still holds the gender.
  await name.fill("");
  await expect(gender).toHaveText("Male");
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([]);
  // Another person opened meanwhile, the nameless one keeps their gender and details.
  await page.getByRole("textbox", { name: "Age", exact: true }).fill("40");
  await page.getByRole("button", { name: "Add a person", exact: true }).click();
  await expect(name).toBeFocused();
  const nameless = page.getByRole("button", { name: /^Unnamed/ });
  await expect(nameless).toContainText("Male, age 40");
  await nameless.click();
  await expect(gender).toHaveText("Male");
  await expect(page.getByRole("textbox", { name: "Age", exact: true })).toHaveValue("40");
  await name.fill("Tomas Weller");
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([JSON.stringify({ name: "Tomas Weller", gender: "male", age: "40" })]);
});

test("a raw cast line repaired into a person opens their form, and focus stays in it", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  const revision = (await storedMemory(request, characterId)).state?.revision ?? 0;
  const line = JSON.stringify({ name: "Ilse", gender: "woman" });
  const seeded = await request.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: {
      notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [line] },
      revision,
    },
  });
  expect(seeded.status()).toBe(200);
  await page.goto("/");
  await openMemory(page);
  const raw = page.getByRole("textbox", { name: "Cast, line 1", exact: true });
  await expect(raw).toHaveValue(line);
  await raw.focus();
  // The caret at the line's end, as a click there leaves it.
  await raw.evaluate((field: HTMLTextAreaElement) =>
    field.setSelectionRange(field.value.length, field.value.length),
  );
  for (const _ of 'woman"}') await page.keyboard.press("Backspace");
  await page.keyboard.type('female"}');
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Ilse");
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([JSON.stringify({ name: "Ilse", gender: "female" })]);
});

test("an open memory panel clips nothing once it has unfolded, so rows past its edge keep their tint and ring", async ({
  page,
  request,
}) => {
  await memoryChat(request);
  await page.goto("/");
  await openMemory(page);
  // Phone width, where the rows reach furthest past the panel's edge.
  await page.setViewportSize({ width: 390, height: 844 });
  // Off, then on again: the panel folds away and unfolds, so the clip has to lift after the growth.
  const remember = page.getByRole("switch", { name: "Remember the story" });
  await remember.click();
  await expect(remember).not.toBeChecked();
  await remember.click();
  await expect(remember).toBeChecked();
  const panel = page
    .locator(".unfold")
    .filter({ has: page.getByRole("textbox").first() })
    .first();
  await expect(panel).toBeVisible();
  await expect
    .poll(() => panel.evaluate((node) => getComputedStyle(node).overflow))
    .toBe("visible");
});

test("a raw cast line cleared to start over opens an empty person's form, and focus stays in it", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  const revision = (await storedMemory(request, characterId)).state?.revision ?? 0;
  const line = JSON.stringify({ name: "Ilse", gender: "woman" });
  const seeded = await request.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: {
      notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [line] },
      revision,
    },
  });
  expect(seeded.status()).toBe(200);
  await page.goto("/");
  await openMemory(page);
  const raw = page.getByRole("textbox", { name: "Cast, line 1", exact: true });
  await expect(raw).toHaveValue(line);
  await raw.focus();
  await raw.evaluate((field: HTMLTextAreaElement) => field.select());
  await page.keyboard.press("Backspace");
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("");
});

test("a cast line at its limit cannot grow past it, says why, and the notebook still saves", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  const words = (length: number) => "w".repeat(length);
  const fixed = {
    name: "Vera Lind",
    gender: "female",
    skin: words(240),
    face: "",
    build: words(240),
    hair: words(240),
    eyes: words(240),
  };
  const atLimit = { ...fixed, face: words(1_200 - JSON.stringify(fixed).length) };
  const line = JSON.stringify(atLimit);
  expect(line).toHaveLength(1_200);
  const revision = (await storedMemory(request, characterId)).state?.revision ?? 0;
  const seeded = await request.patch(`/api/memory/characters/${characterId}`, {
    headers: unsafe(),
    data: {
      notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [line] },
      revision,
    },
  });
  expect(seeded.status()).toBe(200);
  const { name, gender, ...details } = fixed;
  await page.goto("/");
  await openMemory(page);
  await page.getByRole("button", { name: /^Vera Lind/ }).click();
  const age = page.getByRole("textbox", { name: "Age", exact: true });
  await age.pressSequentially("31");
  await expect(age).toHaveValue("");
  await expect(
    page.getByRole("status").filter({ hasText: "a cast line holds. Shorten one to add more." }),
  ).toContainText("at the 1,200 characters");
  // Shortened, the line takes the age, and the notebook saves it.
  await page.getByRole("textbox", { name: "Face", exact: true }).fill("round");
  await age.fill("31");
  await expect(age).toHaveValue("31");
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([JSON.stringify({ name, gender, age: "31", ...details, face: "round" })]);
});

test("memory off and Forget prevent notebook cast from seeding another chat", async ({
  page,
  request,
}) => {
  const { name, characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast.length)
    .toBe(1);
  await openMemory(page);
  await page.getByRole("switch", { name: "Remember the story" }).click();
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.enabled)
    .toBe(false);
  await backToChat(page).click();
  await clearChat(page);
  await chooseCharacter(page, name);
  const off = unique("Without remembered people");
  await exchange(page, off);
  expect(
    (await upstreamRecords(off))[0]?.messages.some((message) =>
      message.content.startsWith("<cast>"),
    ),
  ).toBe(false);
  await page.goto(`/characters/${characterId}/memory?from=chat`);
  await page.getByRole("switch", { name: "Remember the story" }).click();
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.enabled)
    .toBe(true);
  await page.getByRole("button", { name: "Memory actions" }).click();
  await page.getByRole("menuitem", { name: "Forget everything" }).click();
  await page
    .getByRole("alertdialog", { name: /^Forget everything/ })
    .getByRole("button", { name: "Forget everything" })
    .click();
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.notebook.cast)
    .toEqual([]);
  await backToChat(page).click();
  // The navigation to this memory screen reloaded the page and already emptied the chat.
  await expect(turns(page)).toHaveCount(0);
  await chooseCharacter(page, name);
  const forgotten = unique("After forgetting");
  await exchange(page, forgotten);
  expect(
    (await upstreamRecords(forgotten))[0]?.messages.some((message) =>
      message.content.startsWith("<cast>"),
    ),
  ).toBe(false);
});

test("an open prompt preview follows a notebook saved in another tab", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  const notebook = (situation: string, revision: number) =>
    request.patch(`/api/memory/characters/${characterId}`, {
      headers: unsafe(),
      data: { notebook: { situation, relationships: [], facts: [], threads: [] }, revision },
    });
  const before = unique("The tide was out at the quay.");
  expect((await notebook(before, 0)).status()).toBe(200);
  await page.goto("/");
  await expect(memoryMark(page)).toBeVisible();
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(prompt(page)).toContainText(before);

  // Another tab saves a newer notebook; this tab hears of it when it is looked at again.
  const after = unique("The tide came in over the steps.");
  const revision = (await storedMemory(request, characterId)).state?.revision ?? 0;
  expect((await notebook(after, revision)).status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(prompt(page)).toContainText(after);
  await expect(prompt(page)).not.toContainText(before);
});

test("leaving with the notebook and a memory both unsaved asks once", async ({ page, request }) => {
  await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  await openMemory(page);
  // Neither save reaches Ephemera now.
  await page.route("**/api/memory/**", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.fallback(),
  );
  await page.getByRole("textbox", { name: "Situation" }).fill(unique("Rain on the quay."));
  await episodeRows(page).click();
  await episodeEditor(page).getByRole("textbox", { name: "Title" }).fill(unique("The pier"));
  await page.goBack();
  const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(leave).toHaveCount(1);
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(leave).toHaveCount(0);
});

test("a memory's edit still unsaved when the owner goes back is saved first", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page)).toContainText(MEMORY_TITLE);
  await openMemory(page);
  await episodeRows(page).click();
  const title = unique("The lantern on the pier");
  await episodeEditor(page).getByRole("textbox", { name: "Title" }).fill(title);
  // Back at once, well inside the autosave's pause.
  await page.goBack();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(seam(page)).toContainText(title);
  expect((await storedMemory(request, characterId)).episodes[0]?.title).toBe(title);
});

test("an open memory editor keeps its text while a new memory lands on the memory screen", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  await twoExchanges(page);
  const [opened] = (await storedMemory(request, characterId)).episodes;
  const before = (await storedMemory(request, characterId)).state?.revision ?? 0;

  await openMemory(page);
  const remember = await hold(page, "**/api/memory/remember");
  await page.getByRole("button", { name: "Remember now" }).click();
  await expect.poll(remember.held).toBe(1);
  await episodeRows(page).click();
  const title = unique("The ferry before the fog");
  const field = episodeEditor(page).getByRole("textbox", { name: "Title" });
  await field.fill(title);

  // The new memory brings a newer notebook: the notebook alone takes it.
  remember.release();
  await expect(page.locator("button[data-episode]")).toHaveCount(2);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).state?.revision ?? 0)
    .toBeGreaterThan(before);
  await expect(episodeEditor(page)).toBeVisible();
  await expect(field).toHaveValue(title);
  await episodeEditor(page).getByRole("button", { name: "Done" }).click();
  await expect(episodeEditor(page)).toHaveCount(0);
  const episodes = (await storedMemory(request, characterId)).episodes;
  expect(episodes.find((episode) => episode.id === opened?.id)?.title).toBe(title);
  expect(episodes.filter((episode) => episode.title === MEMORY_TITLE)).toHaveLength(1);
});

test("an open memory editor whose memory is deleted elsewhere keeps its unsaved text until discarded", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  await twoExchanges(page);
  const [opened] = (await storedMemory(request, characterId)).episodes;

  await openMemory(page);
  // The screen learns of the deletion when the new memory lands and the book reloads.
  const remember = await hold(page, "**/api/memory/remember");
  await page.getByRole("button", { name: "Remember now" }).click();
  await expect.poll(remember.held).toBe(1);
  await episodeRows(page).click();
  // Another tab deletes the memory open here.
  const removed = await request.delete(`/api/memory/episodes/${opened?.id}`, {
    headers: unsafe(),
  });
  expect(removed.status()).toBe(204);
  const title = unique("The quay at dusk");
  const field = episodeEditor(page).getByRole("textbox", { name: "Title" });
  await field.fill(title);

  remember.release();
  const notice = episodeEditor(page).getByRole("alert").filter({ hasText: "Deleted elsewhere" });
  await expect(notice).toBeVisible();
  await expect(field).toHaveValue(title);
  await notice.getByRole("button", { name: "Discard and close" }).click();
  await expect(episodeEditor(page)).toHaveCount(0);
  const episodes = (await storedMemory(request, characterId)).episodes;
  expect(episodes.some((episode) => episode.id === opened?.id)).toBe(false);
});

test("an open memory editor stays on its memory while a new one moves the seam in the chat", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  const [opened] = (await storedMemory(request, characterId)).episodes;

  // The reply waits until the editor is open; once it lands, the chat is past the span.
  const reply = await hold(page, "**/api/chat");
  await send(page, `${longLine()} ${longLine()}`);
  await expect.poll(reply.held).toBe(1);
  await seam(page).hover();
  await seam(page).getByRole("button", { name: "Edit", exact: true }).click();
  const title = unique("The road in the rain");
  const field = episodeEditor(page).getByRole("textbox", { name: "Title" });
  await field.fill(title);

  reply.release();
  await expect
    .poll(async () => (await storedMemory(request, characterId)).episodes.length, {
      timeout: 15_000,
    })
    .toBe(2);
  await expect(page.locator("li[data-memory-seam]")).toHaveCount(1);
  await expect(episodeEditor(page)).toBeVisible();
  await expect(field).toHaveValue(title);
  await episodeEditor(page).getByRole("button", { name: "Done" }).click();
  await expect(episodeEditor(page)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await storedMemory(request, characterId)).episodes.map((episode) => [
        episode.id === opened?.id,
        episode.title,
      ]),
    )
    .toEqual([
      [true, title],
      [false, MEMORY_TITLE],
    ]);
});

test("an open memory editor and its text survive a failed background load of the character", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  await twoExchanges(page);
  await rememberNow(page);
  await openMemory(page);
  await episodeRows(page).click();
  const title = unique("The quay in the dark");
  const field = episodeEditor(page).getByRole("textbox", { name: "Title" });
  await field.fill(title);

  // Shown again, the page reloads its data in the background; the character's fails each time.
  let failed = 0;
  await page.route(`**/api/characters/${characterId}`, async (route) => {
    failed++;
    await route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  // The first load and its two retries.
  await expect.poll(() => failed, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.getByRole("alert").filter({ hasText: "could not be" })).toHaveCount(0);
  await expect(episodeEditor(page)).toBeVisible();
  await expect(field).toHaveValue(title);
  await episodeEditor(page).getByRole("button", { name: "Done" }).click();
  await expect(episodeEditor(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Situation" })).toHaveValue(MEMORY_SITUATION);
  await expect
    .poll(async () => (await storedMemory(request, characterId)).episodes[0]?.title)
    .toBe(title);
});

test("past the recap budget, the oldest folded memories roll up into a chapter", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // Only folded memories roll up: mock-fold's small window folds them as long exchanges go on.
  const { characterId } = await memoryChat(request, { model: "mock-fold" });
  await page.goto("/");
  const chapterOf = async () =>
    (await storedMemory(request, characterId)).episodes.find(
      (episode) => episode.kind === "chapter",
    );
  for (let sent = 0; sent < 16 && (await chapterOf()) === undefined; sent++) {
    await exchange(
      page,
      `${unique("On we went.")} ${"Quiet rain fell on the old road. ".repeat(150)}`,
    );
    if ((await seam(page).count()) > 0) await settledSeamLine(page);
  }
  // Four folded memories pass the smallest recap budget: the oldest half merges, the newest
  // two stay.
  const { episodes } = await storedMemory(request, characterId);
  const chapter = episodes.find((episode) => episode.kind === "chapter");
  expect(chapter?.title).toBe(CHAPTER_TITLE);
  const members = episodes.filter((episode) => episode.chapterId === chapter?.id);
  expect(members.length).toBeGreaterThanOrEqual(2);
  expect(await settledSeamLine(page)).toMatch(FOLDED_LINE);

  await openMemory(page);
  const rows = page.getByRole("list", { name: "Memories" });
  await expect(rows.getByRole("button", { name: CHAPTER_TITLE })).toContainText(
    `A chapter of ${members.length} memories`,
  );
  await expect(episodeRows(page).filter({ visible: true })).toHaveCount(
    episodes.length - members.length,
  );
  await rows.getByText(`Show the ${members.length} memories it gathers`).click();
  await expect(episodeRows(page).filter({ visible: true })).toHaveCount(episodes.length);
  await page.goBack();

  // The next prompt tells the chapter in place of its members.
  const next = unique("And the road went on.");
  await exchange(page, next);
  const [record] = await upstreamRecords(next);
  const story = record?.messages.find((message) =>
    message.content.includes("Earlier in this chat"),
  );
  expect(story?.content).toContain(CHAPTER_TITLE);
});

test("an answer wrapped in prose and a code fence still becomes a memory", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request, {
    model: "mock-memory-prose",
  });
  await page.goto("/");
  const first = await twoExchanges(page);
  await rememberNow(page);
  await expect(seam(page)).toContainText(MEMORY_TITLE);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(3));
  const [call] = await upstreamRecords(first, "memory");
  expect(call?.answer).toContain("```json");
  expect((await storedMemory(request, characterId)).episodes).toHaveLength(1);
});

test("an upstream error writes no memory, offers Try again and logs the class only", async ({
  page,
  request,
}) => {
  const { characterId } = await memoryChat(request);
  await page.goto("/");
  const first = await twoExchanges(page);
  // The mock's error body echoes the span; the server must not pass it on.
  await chooseModel(page, "mock-error");
  await rememberNow(page);
  // The seam moves from the span's end to the top of the chat, the old one leaving as it goes.
  const failed = "The memory was not written: the memory model's answer failed.";
  await expect(seam(page).filter({ hasText: failed })).not.toHaveCount(0);
  await expect(seam(page)).toHaveCount(1);
  await expect(seam(page)).toHaveAttribute("data-status", "failed");
  await expect(seam(page).getByRole("status")).toHaveText(failed);
  await expect(seam(page).getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(turns(page)).toHaveCount(4);
  // One call: an API error gets no second attempt (only an unusable answer does), and a 400 is not retried.
  expect(await upstreamRecords(first, "memory")).toHaveLength(1);
  expect((await storedMemory(request, characterId)).episodes).toEqual([]);

  // The call logged its class and status, never the span or the upstream's message.
  const errorLines = async () =>
    (await readFile(APP_SERVERS.main.log, "utf8"))
      .split("\n")
      .filter((line) => line.includes('"event":"memory.remember.error"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.model === "mock-error");
  await expect.poll(async () => (await errorLines()).length).toBeGreaterThanOrEqual(1);
  for (const line of await errorLines()) {
    expect(line).toMatchObject({ level: "error", errorClass: expect.any(String) });
    expect(OPERATIONAL).toEqual(expect.arrayContaining(Object.keys(line)));
  }
  expect(await readFile(APP_SERVERS.main.log, "utf8")).not.toContain(first);
  // Try again asks once more, and fails the same way.
  await seam(page).getByRole("button", { name: "Try again" }).click();
  await expect.poll(async () => (await upstreamRecords(first, "memory")).length).toBe(2);
  await expect(seam(page)).toHaveCount(1);
  await expect(seam(page)).toHaveAttribute("data-status", "failed");
  expect((await storedMemory(request, characterId)).episodes).toEqual([]);
});
