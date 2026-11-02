import { randomBytes } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { EVENT_DIRECTION, type StoredEvent } from "../packages/core/src/events/event.ts";
import { eventsResponseSchema } from "../packages/core/src/responses.ts";
import { uniqueName } from "./support/cards.ts";
import { chooseCharacter, lastReply, send, upstreamRecords } from "./support/chat.ts";
import { createCharacterViaApi, createEventViaApi, patchSettings } from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test, unsafe } from "./support/test.ts";

/*
 * Events: one-line instructions on the Lorebooks screen, rolled on every
 * reply and injected, at most one at a time, as a direction after the latest
 * turn. Events are per user, and every test signs in as a user of its own,
 * so no other test meets these events. Chance 100 always fires and 0 never
 * does, so the tests are deterministic.
 */

const { lead: LEAD, close: CLOSE } = EVENT_DIRECTION;

/** The Events row on the Lorebooks screen arrives closed: open it. */
async function openEvents(page: Page) {
  const row = page.getByRole("button", { name: "Events", exact: true });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
}

async function storedEvents(request: APIRequestContext): Promise<StoredEvent[]> {
  const response = await request.get("/api/events");
  expect(response.status()).toBe(200);
  return eventsResponseSchema.parse(await response.json()).events;
}

/** The test's user chatting with a new character on mock-fast. */
async function freshChat(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  const name = uniqueName("Eventful");
  const characterId = await createCharacterViaApi(request, name, fields);
  await patchSettings(request, { model: "mock-fast", characterId });
  return { name, characterId };
}

/** The directions the mock upstream received with `line`, one list per request. */
async function directionsFor(line: string): Promise<string[][]> {
  const records = await upstreamRecords(line);
  expect(records.length).toBeGreaterThan(0);
  return records.map((record) =>
    record.messages.map((message) => message.content).filter((content) => content.startsWith(LEAD)),
  );
}

/** Sends `line`, waits out the reply and returns the directions its one request carried. */
async function exchange(page: Page, line: string): Promise<string[]> {
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [directions] = await directionsFor(line);
  return directions ?? [];
}

const prompt = (page: Page) => page.getByRole("dialog", { name: "Prompt" });

/** A link of the main navigation. */
const mainLink = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });

/** The inspector's chat history, opened: the event sits among the chat's messages. */
async function openHistory(page: Page) {
  await prompt(page)
    .getByRole("button", { name: /Chat history/ })
    .click();
  return prompt(page).getByRole("list", { name: "Chat history as sent" });
}

test("an event made on the Lorebooks screen survives a reload and shows in the inspector", async ({
  page,
  request,
}) => {
  await freshChat(request);
  const text = "A storm breaks over the harbour";
  await page.goto("/lorebooks");
  await openEvents(page);
  await page.getByRole("button", { name: "New event" }).click();
  const instruction = page.getByRole("textbox", { name: "Instruction" });
  await expect(instruction).toBeFocused();
  await instruction.fill(text);
  const chance = page.getByRole("textbox", { name: "Chance per reply in percent" });
  await chance.fill("100");
  await chance.press("Tab");
  const quiet = page.getByRole("textbox", { name: "Quiet afterwards in replies" });
  await quiet.fill("3");
  await quiet.press("Tab");
  const appliesTo = page.getByRole("radiogroup", { name: "Applies to" });
  await appliesTo.getByRole("radio", { name: "All characters" }).click();
  await expect(appliesTo.getByRole("radio", { name: "All characters" })).toBeChecked();
  await expect
    .poll(async () => storedEvents(request), { timeout: 15_000 })
    .toMatchObject([{ text, chance: 100, cooldown: 3, enabled: true, scope: { kind: "all" } }]);

  await page.reload();
  // A reload closes the Events row again.
  await openEvents(page);
  const events = page.getByRole("list", { name: "Events" });
  await expect(events.locator("li[data-event]")).toHaveCount(1);
  await expect(events.getByRole("button", { name: text })).toBeVisible();
  await expect(events.getByRole("button", { name: text })).toContainText(
    "100% per reply, then quiet for 3.",
  );
  await expect(events.getByRole("button", { name: text })).toContainText("All characters");
  await expect(page.getByRole("switch", { name: `Enable ${text}` })).toBeChecked();

  await page.goto("/");
  const line = canary("in");
  const direction = `${LEAD}${text}.${CLOSE}`;
  expect(await exchange(page, line)).toEqual([direction]);
  // The chat itself shows nothing of it; the inspector does.
  await expect(page.locator("[data-message]").getByText(text)).toHaveCount(0);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(prompt(page)).toContainText("Sent to mock-fast");
  const history = await openHistory(page);
  const item = history.getByRole("listitem").filter({ hasText: LEAD });
  await expect(item).toHaveCount(1);
  await expect(item.getByText("Event", { exact: true })).toBeVisible();
  await expect(item.getByText(direction, { exact: true })).toBeVisible();
});

test("cooldown keeps an event out of the next replies, and a new reply rolls again", async ({
  page,
  request,
}) => {
  await freshChat(request);
  const text = "The lights flicker.";
  await createEventViaApi(request, text, { cooldown: 2 });
  const direction = `${LEAD}${text}${CLOSE}`;
  await page.goto("/");
  expect(await exchange(page, canary("in"))).toEqual([direction]);
  // Quiet for the two replies after the one it fired on.
  expect(await exchange(page, canary("in"))).toEqual([]);
  expect(await exchange(page, canary("in"))).toEqual([]);
  const fourth = canary("in");
  expect(await exchange(page, fourth)).toEqual([direction]);

  // A new reply for the reply it fired on is a new roll, and at 100% it fires again.
  await page.locator("[data-reply-actions]").getByRole("button", { name: "New reply" }).click();
  await expect(page.locator("[data-reply-actions]")).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect.poll(async () => (await directionsFor(fourth)).length).toBe(2);
  expect(await directionsFor(fourth)).toEqual([[direction], [direction]]);
});

test("an event chosen for a tag fires for a character with it, not for one without", async ({
  page,
  request,
}) => {
  const tag = `harbour-${randomBytes(3).toString("hex")}`;
  await freshChat(request, { tags: [tag] });
  const plain = uniqueName("Untagged");
  await createCharacterViaApi(request, plain);
  const text = "A bell tolls in the fog";
  await createEventViaApi(request, text);

  await page.goto("/lorebooks");
  await openEvents(page);
  const events = page.getByRole("list", { name: "Events" });
  await events.getByRole("button", { name: text }).click();
  await page.getByRole("radio", { name: "Chosen characters and tags" }).click();
  await expect(events.getByRole("button", { name: text })).toContainText("Applies to no one yet.");
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Tags this event applies to" });
  await picker.getByRole("checkbox", { name: tag }).click();
  await expect(picker.getByRole("checkbox", { name: tag })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(events.getByRole("button", { name: text })).toContainText(`cards tagged "${tag}"`);
  await expect
    .poll(async () => (await storedEvents(request))[0]?.scope, { timeout: 15_000 })
    .toEqual({ kind: "selected", characters: [], tags: [tag] });

  await page.goto("/");
  const direction = `${LEAD}${text}.${CLOSE}`;
  expect(await exchange(page, canary("in"))).toEqual([direction]);
  await chooseCharacter(page, plain, { confirm: true });
  expect(await exchange(page, canary("in"))).toEqual([]);
});

test("of two events that both fire, exactly one goes into the prompt", async ({
  page,
  request,
}) => {
  await freshChat(request);
  const texts = ["A stranger knocks.", "The ground shakes."];
  for (const text of texts) await createEventViaApi(request, text);
  await page.goto("/");
  const directions = await exchange(page, canary("in"));
  expect(directions).toHaveLength(1);
  expect(texts.map((text) => `${LEAD}${text}${CLOSE}`)).toContain(directions[0]);
});

test("a switched-off event never fires, and the draft's preview rolls no event", async ({
  page,
  request,
}) => {
  await freshChat(request);
  const text = "A rival appears.";
  const id = await createEventViaApi(request, text);
  await page.goto("/lorebooks");
  await openEvents(page);
  const toggle = page.getByRole("switch", { name: `Enable ${text}` });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByRole("list", { name: "Events" }).getByRole("button", { name: text }),
  ).toContainText("Off. 100% per reply.");
  await expect
    .poll(async () => (await storedEvents(request))[0]?.enabled, { timeout: 15_000 })
    .toBe(false);

  await page.goto("/");
  expect(await exchange(page, canary("in"))).toEqual([]);
  expect(await exchange(page, canary("in"))).toEqual([]);

  // Switched on again elsewhere: the next reply would fire, but a preview never rolls.
  const [stored] = await storedEvents(request);
  const response = await request.patch(`/api/events/${id}`, {
    headers: unsafe(),
    data: { enabled: true, revision: stored?.revision },
  });
  expect(response.status()).toBe(200);
  const draft = canary("draft");
  await page.getByLabel("Message", { exact: true }).fill(draft);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await prompt(page)
    .getByRole("radio", { name: "Preview" })
    .or(prompt(page).getByRole("button", { name: "Preview" }))
    .click();
  await expect(prompt(page)).toContainText("Preview for mock-fast.");
  const history = await openHistory(page);
  await expect(history.getByText(draft, { exact: true })).toBeVisible();
  await expect(prompt(page).getByText("Event", { exact: true })).toHaveCount(0);
  await expect(prompt(page).getByText(LEAD)).toHaveCount(0);
  await prompt(page).getByRole("button", { name: "Close prompt" }).click();
  await expect(prompt(page)).toHaveCount(0);

  // Sent, the same draft rolls, and the event is on again.
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(await directionsFor(draft)).toEqual([[`${LEAD}${text}${CLOSE}`]]);
});

test("a blank new event never holds leaving; a cleared instruction stays not saved while closed", async ({
  page,
  request,
}) => {
  const text = "The lights go out.";
  await createEventViaApi(request, text);
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await page.goto("/lorebooks");
  await openEvents(page);

  // A new event with its numbers changed and no instruction: nothing to keep.
  await page.getByRole("button", { name: "New event" }).click();
  const fresh = page.locator("li[data-event]").first();
  const chance = fresh.getByRole("textbox", { name: "Chance per reply in percent" });
  await chance.fill("70");
  await chance.press("Tab");
  const quiet = fresh.getByRole("textbox", { name: "Quiet afterwards in replies" });
  await quiet.fill("0");
  await quiet.press("Tab");
  await expect(fresh.getByRole("button", { name: "New event" })).toContainText(
    "70% per reply. About once in 1.4 replies.",
  );
  await expect(fresh.getByText("Write the instruction to save this event.")).toBeVisible();
  // Neither the reload warning nor the leave dialog holds it.
  await page.reload();
  expect(dialogs).toBe(0);
  await openEvents(page);
  await page.getByRole("button", { name: "New event" }).click();
  const again = page
    .locator("li[data-event]")
    .first()
    .getByRole("textbox", { name: "Chance per reply in percent" });
  await again.fill("70");
  await again.press("Tab");
  await mainLink(page, "Characters").click();
  await expect(page).toHaveURL(/\/characters/);
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toHaveCount(0);
  expect(dialogs).toBe(0);
  expect(await storedEvents(request)).toHaveLength(1);

  // An existing event whose instruction is cleared is not saved, and the closed row says so.
  await page.goto("/lorebooks");
  await openEvents(page);
  const events = page.getByRole("list", { name: "Events" });
  await events.getByRole("button", { name: text }).click();
  await events.getByRole("textbox", { name: "Instruction" }).fill("");
  await expect(events.getByText("Write the instruction to save this event.")).toBeVisible();
  const section = page.getByRole("button", { name: "Events", exact: true });
  await section.click();
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await expect(section).toHaveAccessibleDescription("1 event, all on. 1 not saved");
  await expect(page.getByRole("alert").filter({ hasText: "Open Events" })).toHaveText(
    "1 event is not saved. Open Events to retry.",
  );
  // Leaving asks.
  await mainLink(page, "Characters").click();
  const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/lorebooks/);
  expect((await storedEvents(request))[0]?.text).toBe(text);
});

/** Counts the page's requests to the events API by method, from now on. */
function eventRequests(page: Page) {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/events")) sent.push(request.method());
  });
  return (method: string) => sent.filter((sentMethod) => sentMethod === method).length;
}

/**
 * Holds the answer to the page's first `method` request for the event `id`:
 * Ephemera carries it out (`committed`), and the page hears back only on
 * `release`, or never when the answer is `lost`.
 */
async function holdAnswer(page: Page, id: string, method: string, { lost = false } = {}) {
  let reached = () => {};
  const committed = new Promise<void>((resolve) => {
    reached = () => resolve();
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let taken = false;
  await page.route(`**/api/events/${id}`, async (route) => {
    if (taken || route.request().method() !== method) return route.fallback();
    taken = true;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    reached();
    await held;
    await (lost ? route.abort() : route.fulfill({ response }));
  });
  return { committed, release };
}

/** The tab is looked at again: its event list reloads. */
const lookAgain = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

test("a saved event whose instruction is cleared stays when its row closes, and leaving asks", async ({
  page,
  request,
}) => {
  const text = "The tide turns.";
  await createEventViaApi(request, text);
  const sent = eventRequests(page);
  await page.goto("/lorebooks");
  await openEvents(page);
  const events = page.getByRole("list", { name: "Events" });
  await events.getByRole("button", { name: text }).click();
  await events.getByRole("textbox", { name: "Instruction" }).fill("");
  // Blank, the row's disclosure reads New event, as the section's button does: reached by the row.
  const row = events.locator("li[data-event]");
  const disclosure = row.locator("[data-disclosure]");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Write the instruction to save this event.")).toBeVisible();

  await mainLink(page, "Characters").click();
  const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/lorebooks/);
  await expect(row).toHaveCount(1);
  expect(sent("DELETE")).toBe(0);
  expect(await storedEvents(request)).toMatchObject([{ text }]);
});

test("events deleted in another tab: a clean row goes, one with unsaved edits stays until discarded", async ({
  page,
  request,
}) => {
  const clean = "A gull cries overhead.";
  const edited = "The lamp gutters.";
  const cleanId = await createEventViaApi(request, clean);
  const editedId = await createEventViaApi(request, edited);
  const sent = eventRequests(page);
  await page.goto("/lorebooks");
  await openEvents(page);
  const events = page.getByRole("list", { name: "Events" });
  const rows = events.locator("li[data-event]");
  await expect(rows).toHaveCount(2);

  // The edit cannot reach Ephemera, so it stays unsaved here.
  await page.route("**/api/events/*", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.fallback(),
  );
  await events.getByRole("button", { name: edited }).click();
  const instruction = events.getByRole("textbox", { name: "Instruction" });
  const unsaved = "The lamp gutters and goes out.";
  await instruction.fill(unsaved);
  await expect(events.getByText("Not saved: can't reach Ephemera. Retrying")).toBeVisible({
    timeout: 15_000,
  });

  // Another tab deletes both; this tab hears of it when it is looked at again.
  for (const id of [cleanId, editedId]) {
    const response = await request.delete(`/api/events/${id}`, {
      headers: unsafe(),
    });
    expect(response.ok()).toBe(true);
  }
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  const orphan = rows.filter({ has: page.locator("[data-orphaned]") });
  await expect(orphan).toHaveCount(1);
  await expect(orphan.getByRole("alert")).toContainText("Deleted elsewhere");
  await expect(events.getByRole("button", { name: clean })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  // The edits stay, to copy.
  await expect(instruction).toHaveValue(unsaved);

  // Leaving asks.
  await mainLink(page, "Characters").click();
  const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(leave).toContainText("Not saved: this event was deleted");
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/lorebooks/);

  // Discarded, the row goes, and nothing was made again or deleted from here.
  await orphan.getByRole("button", { name: "Discard edits" }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New event" })).toBeFocused();
  expect(sent("POST")).toBe(0);
  expect(sent("DELETE")).toBe(0);
  expect(await storedEvents(request)).toEqual([]);
  await mainLink(page, "Characters").click();
  await expect(page).toHaveURL(/\/characters/);
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toHaveCount(0);
});

test("an event deleted in another tab while its last edit was on its way goes once that save lands", async ({
  page,
  request,
}) => {
  let held: Awaited<ReturnType<typeof holdAnswer>> | undefined;
  try {
    const text = "Rain drums on the roof";
    const id = await createEventViaApi(request, text);
    const sent = eventRequests(page);
    held = await holdAnswer(page, id, "PATCH");
    await page.goto("/lorebooks");
    await openEvents(page);
    const section = page.getByRole("button", { name: "Events", exact: true });
    const events = page.getByRole("list", { name: "Events" });
    const rows = events.locator("li[data-event]");
    await events.getByRole("button", { name: text }).click();
    await events.getByRole("textbox", { name: "Instruction" }).fill(`${text} all night`);
    await held.committed;

    // Another tab deletes it after the edit was saved; this tab hears of that before the save's answer.
    const response = await request.delete(`/api/events/${id}`, {
      headers: unsafe(),
    });
    expect(response.ok()).toBe(true);
    await lookAgain(page);
    await expect(rows.locator("[data-orphaned]")).toHaveCount(1);
    await expect(section).toHaveAccessibleDescription("None yet. 1 not saved");

    // The answer says saved: nothing is left unsaved here, so the row and its notice go.
    held.release();
    await expect(rows).toHaveCount(0);
    await expect(section).toHaveAccessibleDescription("None yet");
    expect(sent("PATCH")).toBe(1);
    await mainLink(page, "Characters").click();
    await expect(page).toHaveURL(/\/characters/);
    await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toHaveCount(0);
    expect(await storedEvents(request)).toEqual([]);
  } finally {
    held?.release();
  }
});

test("an event deleted here whose list reloads before the deletion's answer still goes with Undo", async ({
  page,
  request,
}) => {
  let held: Awaited<ReturnType<typeof holdAnswer>> | undefined;
  try {
    const text = "A door creaks open";
    const id = await createEventViaApi(request, text);
    held = await holdAnswer(page, id, "DELETE");
    await page.goto("/lorebooks");
    await openEvents(page);
    const section = page.getByRole("button", { name: "Events", exact: true });
    const events = page.getByRole("list", { name: "Events" });
    const rows = events.locator("li[data-event]");
    await events.getByRole("button", { name: text }).click();
    await events.getByRole("button", { name: "Delete event" }).click();
    await held.committed;
    expect(await storedEvents(request)).toEqual([]);

    // The list reloads without it while the answer is on its way: the row waits for its deletion.
    await lookAgain(page);
    await expect(section).toHaveAccessibleDescription("None yet");
    await expect(rows).toHaveCount(1);
    await expect(page.locator("[data-orphaned]")).toHaveCount(0);
    await expect(page.locator("[data-removed]")).toHaveCount(0);

    held.release();
    const undo = page.getByRole("button", { name: "Undo" });
    await expect(undo).toBeFocused();
    await expect(page.locator("[data-removed]").getByRole("status")).toHaveText(`Deleted ${text}.`);
    await expect(rows).toHaveCount(0);
    await expect(page.locator("[data-orphaned]")).toHaveCount(0);
    await undo.click();
    await expect(events.getByRole("button", { name: text })).toBeFocused();
    expect(await storedEvents(request)).toMatchObject([{ text }]);
  } finally {
    held?.release();
  }
});

test("a deletion here whose answer is lost after its event went keeps the edits, saving nothing", async ({
  page,
  request,
}) => {
  let held: Awaited<ReturnType<typeof holdAnswer>> | undefined;
  try {
    await page.clock.install();
    const text = "The well runs dry";
    const id = await createEventViaApi(request, text);
    const sent = eventRequests(page);
    // The edit cannot reach Ephemera, so it stays unsaved here.
    await page.route("**/api/events/*", (route) =>
      route.request().method() === "PATCH" ? route.abort() : route.fallback(),
    );
    held = await holdAnswer(page, id, "DELETE", { lost: true });
    await page.goto("/lorebooks");
    await openEvents(page);
    const section = page.getByRole("button", { name: "Events", exact: true });
    const events = page.getByRole("list", { name: "Events" });
    const rows = events.locator("li[data-event]");
    await events.getByRole("button", { name: text }).click();
    const instruction = events.getByRole("textbox", { name: "Instruction" });
    const unsaved = `${text} at dusk`;
    await instruction.fill(unsaved);
    await expect(events.getByText("Not saved: can't reach Ephemera. Retrying")).toBeVisible({
      timeout: 15_000,
    });

    await events.getByRole("button", { name: "Delete event" }).click();
    await held.committed;
    await lookAgain(page);
    await expect(section).toHaveAccessibleDescription("None yet. 1 not saved");
    await expect(rows).toHaveCount(1);
    await expect(rows.locator("[data-orphaned]")).toHaveCount(0);

    // The answer is lost: the edits stay, said deleted elsewhere, and nothing tries to save them.
    held.release();
    await expect(events.getByText("Not deleted: Ephemera could not be reached.")).toBeVisible();
    await expect(rows.locator("[data-orphaned]")).toHaveCount(1);
    await expect(instruction).toHaveValue(unsaved);
    const patches = sent("PATCH");
    // Past the longest autosave retry (30 s): nothing tries again.
    await page.clock.runFor(31_000);
    expect(sent("PATCH")).toBe(patches);

    await rows.getByRole("button", { name: "Discard edits" }).click();
    await expect(rows).toHaveCount(0);
    expect(sent("DELETE")).toBe(1);
    expect(await storedEvents(request)).toEqual([]);
  } finally {
    held?.release();
  }
});

test("a migrated blank event stays disabled and editable until it has instructions", async ({
  page,
}) => {
  const id = await createEventViaApi(page.request, "Before conversion", { enabled: false });
  // Model the stored-read response of the startup upgrade; public writes cannot create a blank event.
  await page.route("**/api/events", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.events = body.events.map((event: { id: string }) =>
      event.id === id ? { ...event, text: "", enabled: false } : event,
    );
    await route.fulfill({ response, json: body });
  });
  await page.goto("/lorebooks");
  await openEvents(page);
  const toggle = page.getByRole("switch", { name: "Enable No instructions", exact: true });
  await expect(toggle).toBeDisabled();
  await page.getByRole("button", { name: "No instructions", exact: true }).click();
  const instruction = page.getByRole("textbox", { name: "Instruction", exact: true });
  await expect(instruction).toHaveValue("");
  await instruction.fill("The lamp flickers.");
  await expect(
    page.getByRole("switch", { name: "Enable The lamp flickers.", exact: true }),
  ).toBeEnabled();
  await instruction.press("Tab");
  await expect
    .poll(async () => (await storedEvents(page.request)).find((event) => event.id === id)?.text)
    .toBe("The lamp flickers.");
});
