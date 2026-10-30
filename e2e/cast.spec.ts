import type { APIRequestContext, Page, Request, Route } from "@playwright/test";
import { formatCount } from "../apps/web/src/lib/text.ts";
import { callAccountingSchema } from "../packages/core/src/usage.ts";
import { openSheet, uniqueName } from "./support/cards.ts";
import {
  castEntry,
  castPanel,
  castRecord,
  castStatus,
  castUpdating,
  chooseCastModel,
  editRecord,
  openRecord,
} from "./support/cast.ts";
import {
  DEVELOPED_HAIR,
  DEVELOPMENT_TURN,
  KEEPER_MAN,
  KEEPER_WOMAN_GIVEN,
  KEEPER_WOMAN_OUTFIT,
  keeperWoman,
  SHEET_MAN,
  SHEET_RETRY_EMPTY,
  SHEET_WOMAN,
} from "./support/cast-fixtures.ts";
import {
  chooseModel,
  clearChat,
  lastReply,
  moreAction,
  replyActions,
  replyCounter,
  send,
  upstreamRecords,
} from "./support/chat.ts";
import { createCharacterViaApi, patchSettings, readSettings, saved } from "./support/entities.ts";
import { expect, test } from "./support/test.ts";
import {
  MOCK_OUTPUT_TOKENS,
  MOCK_REASONING_TOKENS,
  type UpstreamRecordView,
} from "./support/upstream.ts";

/*
 * The cast register (docs/PRODUCT.md, Chat) against the
 * mock upstream's cast model, `mock-cast`, whose keeper names a woman from the newest turn's `-in-`
 * mark and marks a man present, and whose sheet call answers two fixed
 * principals (e2e/support/cast-fixtures.ts). The marks here are not
 * canaries; e2e/cast-retention.spec.ts holds the retention rows.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const FACTORS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 412, height: 915 },
] as const;

/** The woman the keeper seeds from a greeting, which carries no mark. */
const SEEDED = keeperWoman([]);
/** The status line while the shown reply has no snapshot and no call is writing one. */
const STALE = "As of the previous reply";

/** A mark the keeper names its woman after, `-in-` turned to `-cast-`; not a canary. */
function mark(): string {
  const id = crypto.randomUUID();
  return `k${id.slice(0, 6)}-in-${id.slice(9, 13)}`;
}

/** The woman the keeper names after the mark in `line`. */
const womanOf = (line: string) =>
  `${KEEPER_WOMAN_GIVEN} ${(/\w+-in-[\w-]+/.exec(line)?.[0] ?? "").replace("-in-", "-cast-")}`;

/** Sends `line` and waits out its reply, which turns its mark's `-in-` to `-out-`. */
async function exchange(page: Page, line: string) {
  await send(page, line);
  await expect(lastReply(page)).toContainText(`Reply: ${line.replace("-in-", "-out-")}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
}

/** The chat's own request carrying `text`, not a keeper call reading it. */
async function chatRecord(text: string): Promise<UpstreamRecordView | undefined> {
  return (await upstreamRecords(text))[0];
}

/** A message of a chat request: the `<cast>` block, or the `Cast now` state line. */
const castBlock = (record: UpstreamRecordView | undefined) =>
  record?.messages.find((message) => message.content.startsWith("<cast>"))?.content;
const stateLine = (record: UpstreamRecordView | undefined) =>
  record?.messages.find((message) => message.content.startsWith("[Cast now:"))?.content;

/**
 * The test's user chatting on mock-fast with a new character whose card
 * has a description and, unless `greeting` is false, a greeting; the cast
 * calls go to mock-cast.
 */
async function castChat(request: APIRequestContext, { greeting = true } = {}) {
  const name = uniqueName("Keeper");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse with her brother.`,
    ...(greeting ? { firstMessage: `The lamp room is warm. ${name} looks up from the log.` } : {}),
  });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-cast", characterId });
  return { name, characterId };
}

/** Opens the chat and waits for the seed: the keeper's woman in the roster. */
async function seeded(page: Page) {
  await page.goto("/");
  await expect(castEntry(page, SEEDED)).toBeVisible();
}

const inspector = (page: Page) => page.getByRole("dialog", { name: "Prompt" });

/** Holds every request to `url` until the returned release is called. */
async function hold(page: Page, url: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    url,
    async (route: Route) => {
      await released;
      await route.continue();
    },
    { times: 1 },
  );
  return release;
}

for (const factor of FACTORS) {
  test(`the cast seeds from the card's sheet and the greeting, lists women only, and opens each record (${factor.name})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(factor);
    const { name } = await castChat(request);
    await seeded(page);
    await expect(castEntry(page, SEEDED)).toHaveAttribute("data-present", "true");
    // One sheet call over the card, one seed call over the greeting.
    expect(await upstreamRecords(name, "castSheet")).toHaveLength(1);
    const [seed, ...others] = await upstreamRecords(name, "cast");
    expect(others).toEqual([]);
    expect(seed?.messages.at(-1)?.content).toContain("This is the opening.");
    // The men, the sheet's and the keeper's, are tracked but never listed.
    await expect(castPanel(page)).not.toContainText(KEEPER_MAN);
    await expect(castPanel(page)).not.toContainText(SHEET_MAN);

    if (factor.name === "phone") {
      // The band's tail opens the roster: the sheet's woman, away.
      await castPanel(page)
        .getByRole("button", { name: `and ${SHEET_WOMAN} away` })
        .click();
      const roster = castRecord(page, "Cast");
      await expect(roster).toBeVisible();
      await expect(roster.getByRole("region", { name: "Away" })).toContainText(SHEET_WOMAN);
      await expect(roster).not.toContainText(KEEPER_MAN);
      // A name opens her record in the drawer; Back returns to the roster.
      await roster.getByRole("list", { name: "Present" }).getByText(SEEDED).click();
      const record = castRecord(page, SEEDED);
      await expect(record).toContainText(KEEPER_WOMAN_OUTFIT);
      await record.getByRole("button", { name: "Back to the cast" }).click();
      await expect(castRecord(page, "Cast").getByRole("list", { name: "Present" })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The header's control and the latest reply's More menu open the roster too.
      await page.getByRole("button", { name: "Show the cast", exact: true }).click();
      await expect(castRecord(page, "Cast")).toContainText(SEEDED);
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // The greeting, the latest reply here, carries its More itself.
      await moreAction(page, lastReply(page), "Cast");
      await expect(castRecord(page, "Cast")).toContainText(SHEET_WOMAN);
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // A roster entry on the band opens her record straight away.
      await castEntry(page, SEEDED).click();
      await expect(castRecord(page, SEEDED)).toBeVisible();
      await expect(castRecord(page, SEEDED).getByRole("heading", { name: SEEDED })).toBeFocused();
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      return;
    }

    // The column: the away disclosure names her (or counts her where it is narrow).
    await castPanel(page)
      .locator("summary")
      .filter({ hasText: factor.name === "tablet" ? "1 away" : `and ${SHEET_WOMAN} away` })
      .click();
    await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "false");
    // The record opens in a popover beside the entry, its heading focused, and Escape returns.
    const record = await openRecord(page, SEEDED);
    await expect(record.getByRole("heading", { name: SEEDED })).toBeFocused();
    await expect(record).toContainText(KEEPER_WOMAN_OUTFIT);
    await expect(record.getByRole("button", { name: "Edit record", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(record).toHaveCount(0);
    await expect(castEntry(page, SEEDED)).toBeFocused();
  });
}

test("an update starting under the phone's band lights its hairline and says Updating until it lands", async ({
  page,
  request,
}) => {
  await page.setViewportSize(FACTORS[2]);
  await castChat(request);
  await seeded(page);
  const release = await hold(page, "**/api/cast/update");
  await send(page, `Lamp ${mark()}`);
  // The band sits outside the thread's motion: the light fades in all the same.
  const drift = castPanel(page).locator("[data-cast-drift]");
  await expect(drift).toHaveCSS("opacity", "1");
  await expect(castUpdating(page)).toHaveText("Updating…");
  release();
  await expect(drift).toHaveCount(0);
  await expect(castUpdating(page)).toHaveCount(0);
});

test("the narrator is sent the whole cast, and the inspector shows its block, its state line, the counts and the keeper", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const line = `Up the stairs ${mark()}`;
  await exchange(page, line);
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  const next = `Onward ${crypto.randomUUID()} [e2e-usage:zero-cache]`;
  const narrated = Promise.withResolvers<{ body: string }>();
  // Buffer this accounting observation outside Chromium's response-body cache,
  // forwarding the real endpoint's status, headers and unchanged response bytes.
  await page.route(
    "**/api/chat",
    async (route) => {
      try {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const body = await response.body();
        await route.fulfill({ response, body });
        narrated.resolve({ body: body.toString("utf8") });
      } catch (error) {
        narrated.reject(error);
      }
    },
    { times: 1 },
  );
  const kept = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/cast/update" &&
      (response.request().postData() ?? "").includes(next) &&
      response.ok(),
  );
  const [{ body: narrationBody }, keeperResponse] = await Promise.all([
    narrated.promise,
    kept,
    exchange(page, next),
  ]);
  // The next request: everyone in the block, the man present on the state line.
  const sent = await chatRecord(next);
  const block = castBlock(sent);
  for (const person of [SEEDED, womanOf(line), KEEPER_MAN, SHEET_WOMAN, SHEET_MAN]) {
    expect(block).toContain(person);
  }
  expect(stateLine(sent)).toContain(`${KEEPER_MAN}: present`);
  expect(stateLine(sent)).toContain(`Away: ${SHEET_WOMAN}`);
  await expect(castPanel(page)).not.toContainText(KEEPER_MAN);
  // The keeper read the newest turns once they were written.
  await expect
    .poll(async () => (await upstreamRecords(next, "cast")).map((call) => call.completed))
    .toEqual([true]);

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByText("Cast", { exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText(KEEPER_MAN);
  await inspector(page)
    .getByRole("button", { name: /Chat history/ })
    .click();
  await expect(inspector(page).getByText(/^Cast state, /)).toBeVisible();
  // Rows are the actual receipts for this narration and its keeper,
  // not earlier sheet/seed calls or the preceding narration.
  const parts = narrationBody
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; data?: unknown });
  const narration = callAccountingSchema.parse(
    parts.find((part) => part.type === "data-usage")?.data,
  ).calls;
  const keeperBody = (await keeperResponse.json()) as { accounting?: unknown };
  const keeper = callAccountingSchema.parse(keeperBody.accounting).calls;
  expect(narration.map((call) => call.purpose)).toEqual(["narration"]);
  expect(keeper.map((call) => call.purpose)).toEqual(["cast.update"]);
  expect(narration[0]?.usage.cachedTokens).toBe(0);
  expect(keeper[0]?.usage.cachedTokens).toBeUndefined();

  const usage = inspector(page).getByRole("region", { name: "Usage", exact: true });
  await usage.getByRole("button", { name: /^This request/ }).click();
  const requestTable = usage.getByRole("table", { name: "This request usage", exact: true });
  const rows = requestTable.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("1. Narration");
  await expect(rows.nth(0)).toContainText("mock-fast");
  await expect(rows.nth(1)).toContainText("2. Cast keeper");
  await expect(rows.nth(1)).toContainText("mock-cast");
  for (const [index, receipt] of [...narration, ...keeper].entries()) {
    await expect(rows.nth(index).getByRole("cell").nth(0)).toHaveText(
      new Intl.NumberFormat("en").format(receipt.usage.inputTokens ?? Number.NaN),
    );
  }
  await expect(
    requestTable.getByRole("columnheader", { name: "Cached", exact: true }),
  ).toBeVisible();
  await expect(rows.nth(0).getByRole("cell").nth(1)).toHaveText("0");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toContainText("not reported");
  await expect(rows.nth(0).getByRole("cell").nth(2)).toContainText(`${MOCK_OUTPUT_TOKENS}`);
  await expect(rows.nth(0).getByRole("cell").nth(2)).toContainText(
    `${MOCK_REASONING_TOKENS} reasoning`,
  );
  await expect(rows.nth(1).getByRole("cell").nth(2)).toHaveText(
    formatCount(keeper[0]?.usage.outputTokens ?? 0),
  );
  await usage.getByRole("button", { name: /^This session/ }).click();
  const sessionTable = usage.getByRole("table", { name: "This session usage", exact: true });
  await expect(sessionTable.getByRole("row", { name: /Narration/ })).toContainText("(2)");
  await expect(sessionTable.getByRole("row", { name: /Cast keeper/ })).toContainText("(3)");
  await expect(sessionTable.getByRole("row", { name: /Cast sheet/ })).toContainText("(1)");
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveCount(0);

  await clearChat(page);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(
    inspector(page).getByRole("button", { name: "Last sent", exact: true }),
  ).toBeDisabled();
  await expect(inspector(page).getByRole("region", { name: "Usage", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await exchange(page, `Fresh ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await usage.getByRole("button", { name: /^This session/ }).click();
  await expect(sessionTable.getByRole("row", { name: /Narration/ })).toContainText("(1)");
  await expect(sessionTable.getByRole("row", { name: /Cast keeper/ })).toContainText("(1)");
  await expect(sessionTable.getByRole("row", { name: /Cast sheet/ })).toHaveCount(0);
});

test("a grounded development reaches the record and dynamic prompt while its baseline stays stable", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  await exchange(page, DEVELOPMENT_TURN);
  await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "true");
  const record = await openRecord(page, SHEET_WOMAN);
  await expect(record.locator('[data-cast-field="hair"]')).toContainText(DEVELOPED_HAIR);
  await expect(record.locator('[data-cast-field="hair"]')).not.toContainText("dark brown");
  await expect(record).not.toContainText("ungrounded personality fixture");
  await page.keyboard.press("Escape");

  const next = `Look again ${crypto.randomUUID()}`;
  await exchange(page, next);
  const sent = await chatRecord(next);
  expect(castBlock(sent)).toContain("shoulder-length dark brown hair in loose waves");
  expect(castBlock(sent)).not.toContain(DEVELOPED_HAIR);
  expect(stateLine(sent)).toContain(`hair: ${DEVELOPED_HAIR}`);
  expect(stateLine(sent)).toContain("authoritative over <cast> baseline");
  expect(stateLine(sent)).not.toContain("ungrounded personality fixture");
});

test("a swipe shows its own snapshot, an alternate without one shows the previous marked stale", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const first = `First ${mark()}`;
  await exchange(page, first);
  await expect(castEntry(page, womanOf(first))).toBeVisible();
  const second = `Second ${mark()}`;
  await exchange(page, second);
  await expect(castEntry(page, womanOf(second))).toBeVisible();

  // The new alternate's keeper call is held: the roster shows the previous snapshot, updating.
  const release = await hold(page, "**/api/cast/update");
  const drift = castPanel(page).locator("[data-cast-drift]");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(drift).toHaveCount(1);
  await expect(castUpdating(page)).toHaveText("Updating…");
  await expect(castEntry(page, womanOf(second))).toHaveCount(0);
  await expect(castEntry(page, womanOf(first))).toBeVisible();

  // The first alternate brings its own snapshot back.
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(replyCounter(page)).toContainText("1 / 2");
  await expect(castEntry(page, womanOf(second))).toBeVisible();
  // The held answer lands for an alternate no longer shown: dropped.
  release();
  await expect(drift).toHaveCount(0);
  await expect(castUpdating(page)).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");

  // The second alternate has no snapshot: the previous one, marked stale.
  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(castStatus(page)).toHaveText(STALE);
  await expect(castEntry(page, womanOf(second))).toHaveCount(0);
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(castStatus(page)).toHaveText("");
  await expect(castEntry(page, womanOf(second))).toBeVisible();

  // A swipe past the end writes the new alternate's snapshot.
  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("3 / 3");
  await expect(castEntry(page, womanOf(second))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
  await expect.poll(async () => (await upstreamRecords(second, "cast")).length).toBe(3);
});

test("Continue runs the keeper again over the whole continued reply", async ({ page, request }) => {
  await castChat(request);
  await seeded(page);
  const line = `At the rail ${mark()}`;
  await exchange(page, line);
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  expect(await upstreamRecords(line, "cast")).toHaveLength(1);
  await replyActions(page).getByRole("button", { name: "Continue" }).click();
  // The mock continues with "and on" and the last user-role message, here the cast's state line.
  await expect(lastReply(page)).toContainText(" and on ");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect.poll(async () => (await upstreamRecords(line, "cast")).length).toBe(2);
  const [, again] = await upstreamRecords(line, "cast");
  expect(again?.messages.at(-1)?.content).toContain(" and on ");
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
});

test("editing the newest reply drops its snapshot, and the next keeper call catches up from the last good one", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const line = `By the door ${mark()}`;
  await exchange(page, line);
  await expect(castEntry(page, womanOf(line))).toBeVisible();

  const rewritten = `She came back later ${mark()}`;
  await moreAction(page, replyActions(page), "Edit");
  await lastReply(page)
    .getByRole("textbox", { name: /^Edit / })
    .fill(rewritten);
  await page.keyboard.press("Control+Enter");
  await expect(lastReply(page)).toContainText(rewritten);
  // The edited reply's snapshot went with its old text: the greeting's shows, stale.
  await expect(castStatus(page)).toHaveText(STALE);
  await expect(castEntry(page, womanOf(line))).toHaveCount(0);
  await expect(castEntry(page, SEEDED)).toBeVisible();

  // The next call reads every turn since the greeting's snapshot, the edit included.
  const next = `Quiet now ${crypto.randomUUID()}`;
  await exchange(page, next);
  await expect(castEntry(page, womanOf(rewritten))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
  const [call, ...more] = await upstreamRecords(next, "cast");
  expect(more).toEqual([]);
  const turns = call?.messages.at(-1)?.content ?? "";
  expect(turns).toContain(line);
  expect(turns).toContain(rewritten);
});

test("a message sent before the sheet lands goes without it; the sheet then joins every base, with no seed", async ({
  page,
  request,
}) => {
  const { name } = await castChat(request);
  const release = await hold(page, "**/api/cast/sheets/**");
  await page.goto("/");
  await expect(castStatus(page)).toHaveText("Reading the card");
  // A model-derived sheet stays in the background while the narrator and keeper run.
  await expect(page.locator("[data-greeting]")).toContainText("The lamp room is warm.");

  const first = `Early ${mark()}`;
  const firstUpdate = page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/cast/update",
  );
  await exchange(page, first);
  expect((await firstUpdate).postDataJSON()).toMatchObject({
    mode: "update",
    sheetFingerprint: null,
  });
  await expect(castEntry(page, womanOf(first))).toBeVisible();
  expect(castBlock(await chatRecord(first)) ?? "").not.toContain(SHEET_WOMAN);
  // The keeper caught up from the start: the greeting and the first exchange.
  const [call] = await upstreamRecords(first, "cast");
  expect(call?.messages.at(-1)?.content).toContain("The lamp room is warm.");

  release();
  await castPanel(page)
    .locator("summary")
    .filter({ hasText: `and ${SHEET_WOMAN} away` })
    .click();
  await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "false");

  const second = `Later ${crypto.randomUUID()}`;
  const secondUpdate = page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/cast/update",
  );
  await exchange(page, second);
  const body = (await secondUpdate).postDataJSON() as { sheetFingerprint: unknown };
  expect(typeof body.sheetFingerprint).toBe("string");
  expect(castBlock(await chatRecord(second))).toContain(SHEET_WOMAN);
  // The greeting was no longer the newest reply: never seeded.
  await expect.poll(async () => (await upstreamRecords(name, "cast")).length).toBe(2);
  const calls = await upstreamRecords(name, "cast");
  expect(calls.some((one) => one.messages.at(-1)?.content.includes("This is the opening."))).toBe(
    false,
  );
});

test("a failed keeper call says so and Try again runs it with the cast model Settings chose", async ({
  page,
  request,
}) => {
  await castChat(request);
  // Memory's model, which Try again falls back to below, is the cast one too.
  await patchSettings(request, { memoryModel: "mock-cast" });
  await seeded(page);
  await chooseCastModel(page, "mock-error");
  expect((await readSettings(request)).castModel).toBe("mock-error");

  const line = `Out in the rain ${mark()}`;
  await exchange(page, line);
  await expect(castStatus(page)).toHaveText("Cast couldn't update.");
  const again = castPanel(page).getByRole("button", { name: "Try again to update the cast" });
  await expect(again).toBeVisible();
  // The last good cast still shows.
  await expect(castEntry(page, SEEDED)).toBeVisible();
  await expect(castEntry(page, womanOf(line))).toHaveCount(0);
  const [failed] = await upstreamRecords(line, "cast");
  expect(failed?.model).toBe("mock-error");

  // Back to memory's model.
  await chooseCastModel(page, "Memory's model");
  expect((await readSettings(request)).castModel).toBeNull();
  await again.click();
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
  await expect(again).toHaveCount(0);
  const [, retried] = await upstreamRecords(line, "cast");
  expect(retried?.model).toBe("mock-cast");
});

test("retrying an unread empty sheet queues reselected B1 behind the running keeper once", async ({
  page,
  request,
}) => {
  const name = uniqueName("Empty sheet retry");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse. ${SHEET_RETRY_EMPTY}`,
  });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-cast", characterId });
  const sheetFailed = Promise.withResolvers<void>();
  const sheetRetried = Promise.withResolvers<unknown>();
  const releaseSheet = Promise.withResolvers<void>();
  let sheetRequests = 0;
  await page.route("**/api/cast/sheets/**", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const attempt = ++sheetRequests;
    const response = await route.fetch();
    const body = await response.body();
    if (attempt === 1) {
      expect(JSON.parse(body.toString("utf8"))).toMatchObject({ error: "cast_failed" });
      sheetFailed.resolve();
      await releaseSheet.promise;
    }
    await route.fulfill({ response, body });
    if (attempt === 2) sheetRetried.resolve(JSON.parse(body.toString("utf8")));
  });
  const kept = Promise.withResolvers<Request>();
  const releaseKeeper = Promise.withResolvers<void>();
  const keeperDelivered = Promise.withResolvers<void>();
  const keeperRequests: Request[] = [];
  const failedRequests: Request[] = [];
  page.on("requestfailed", (sent) => failedRequests.push(sent));
  // Buffer only this real keeper endpoint in memory, leaving its browser request in flight.
  await page.route("**/api/cast/update", async (route) => {
    keeperRequests.push(route.request());
    const first = keeperRequests.length === 1;
    const response = await route.fetch();
    const body = await response.body();
    expect(response.ok()).toBe(true);
    if (first) {
      kept.resolve(route.request());
      await releaseKeeper.promise;
    }
    await route.fulfill({ response, body });
    if (first) keeperDelivered.resolve();
  });

  await page.goto("/");
  await sheetFailed.promise;
  const line = `Before anyone is known ${mark()}`;
  await exchange(page, line);
  const keeperRequest = await kept.promise;
  expect(keeperRequest.postDataJSON()).toMatchObject({ sheetFingerprint: null, mode: "update" });
  const newer = `Queued newer reply ${mark()}`;
  await exchange(page, newer);
  const baseline = await chatRecord(newer);
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(replyCounter(page)).toContainText("1 / 2");
  expect(keeperRequests).toHaveLength(1);
  const narration = await upstreamRecords(newer);
  expect(narration.map((one) => one.model)).toEqual(["mock-fast", "mock-fast"]);
  expect(castBlock(narration[1])).toBe(castBlock(baseline));
  expect(stateLine(narration[1])).toBe(stateLine(baseline));
  await expect(castPanel(page).locator("[data-cast-entry]")).toHaveCount(0);
  releaseSheet.resolve();
  const again = castPanel(page).getByRole("button", {
    name: "Try again to read the cast from the card",
  });
  await expect(again).toBeVisible();
  await expect(castStatus(page)).toHaveText("Couldn't read the cast from the card.");
  await again.click();
  expect(await sheetRetried.promise).toMatchObject({ sheet: { entries: [] }, current: true });
  await expect(again).toHaveCount(0);
  await expect(castPanel(page)).toHaveCount(0);
  expect(failedRequests).not.toContain(keeperRequest);
  expect(await upstreamRecords(line, "cast")).toHaveLength(1);
  expect(keeperRequests).toHaveLength(1);
  expect(await upstreamRecords(newer, "cast")).toHaveLength(0);

  releaseKeeper.resolve();
  await keeperDelivered.promise;
  await expect(castEntry(page, womanOf(newer))).toBeVisible();
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await expect(castPanel(page).locator("[data-cast-drift]")).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");
  expect(failedRequests).not.toContain(keeperRequest);
  expect(await upstreamRecords(name, "castSheet")).toHaveLength(2);
  expect(
    (await upstreamRecords(line, "cast")).map(({ completed, aborted }) => ({ completed, aborted })),
  ).toEqual([{ completed: true, aborted: false }]);
  expect(keeperRequests).toHaveLength(2);
  expect(keeperRequests[1]?.postDataJSON()).toMatchObject({
    model: "mock-cast",
    turns: [
      { role: "user", content: newer },
      { role: "assistant", content: `Reply: ${newer.replace("-in-", "-out-")}` },
    ],
  });
  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(castEntry(page, womanOf(newer))).toHaveCount(0);
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(castEntry(page, womanOf(newer))).toBeVisible();
  expect((await upstreamRecords(newer, "cast")).map((one) => one.model)).toEqual(["mock-cast"]);
  expect(await upstreamRecords(line, "cast")).toHaveLength(1);
});

test("a joined retry waits for the failed sheet reload before spending on the newly selected cast model", async ({
  page,
  request,
}) => {
  const name = uniqueName("Joined sheet retry");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse. ${SHEET_RETRY_EMPTY}`,
  });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-fast", characterId });
  const sheetFailed = Promise.withResolvers<void>();
  const releaseFailure = Promise.withResolvers<void>();
  const reloadSeen = Promise.withResolvers<void>();
  const releaseReload = Promise.withResolvers<void>();
  let sheets = 0;
  await page.route("**/api/cast/sheets/**", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const first = ++sheets === 1;
    const response = await route.fetch();
    const body = await response.body();
    if (first) {
      expect(JSON.parse(body.toString("utf8"))).toMatchObject({ error: "cast_failed" });
      sheetFailed.resolve();
      await releaseFailure.promise;
    } else {
      expect(JSON.parse(body.toString("utf8"))).toMatchObject({ sheet: { entries: [] } });
      reloadSeen.resolve();
      await releaseReload.promise;
    }
    await route.fulfill({ response, body });
  });
  const keeperSeen = Promise.withResolvers<void>();
  const releaseKeeper = Promise.withResolvers<void>();
  const keeperDelivered = Promise.withResolvers<void>();
  const keeperRequests: Request[] = [];
  await page.route("**/api/cast/update", async (route) => {
    const first = keeperRequests.push(route.request()) === 1;
    const response = await route.fetch();
    const body = await response.body();
    expect(response.ok()).toBe(true);
    if (first) {
      keeperSeen.resolve();
      await releaseKeeper.promise;
    }
    await route.fulfill({ response, body });
    if (first) keeperDelivered.resolve();
  });
  await page.goto("/");
  await sheetFailed.promise;
  const line = `New keeper model ${mark()}`;
  await exchange(page, line);
  await keeperSeen.promise;
  releaseFailure.resolve();
  const again = castPanel(page).getByRole("button", {
    name: "Try again to read the cast from the card",
  });
  await expect(again).toBeVisible();
  await chooseCastModel(page, "mock-cast");
  await again.click();
  await reloadSeen.promise;
  await expect(again).toHaveCount(0);
  expect(keeperRequests).toHaveLength(1);
  expect((await upstreamRecords(line, "cast")).map((one) => one.model)).toEqual(["mock-fast"]);
  releaseReload.resolve();
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  expect(keeperRequests).toHaveLength(2);
  expect(keeperRequests[1]?.postDataJSON()).toMatchObject({ model: "mock-cast" });
  releaseKeeper.resolve();
  await keeperDelivered.promise;
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  expect((await upstreamRecords(line, "cast")).map((one) => one.model)).toEqual([
    "mock-fast",
    "mock-cast",
  ]);
  expect(await upstreamRecords(name, "castSheet")).toHaveLength(2);
});

test("an empty failed alternate hides an older keeper failure over covered cast, and reselecting it recovers once", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const covered = `Covered reply ${mark()}`;
  await exchange(page, covered);
  await expect(castEntry(page, womanOf(covered))).toBeVisible();

  await chooseCastModel(page, "mock-error");
  const uncovered = `Uncovered reply ${mark()}`;
  await exchange(page, uncovered);
  const again = castPanel(page).getByRole("button", { name: "Try again to update the cast" });
  await expect(again).toBeVisible();
  await expect(castStatus(page)).toHaveText("Cast couldn't update.");
  expect((await upstreamRecords(uncovered, "cast")).map((one) => one.model)).toEqual([
    "mock-error",
  ]);
  const baseline = await chatRecord(uncovered);
  expect(stateLine(baseline)).toContain(womanOf(covered));

  await chooseCastModel(page, "mock-cast");
  await chooseModel(page, "mock-error");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "failed");
  await expect(lastReply(page).locator("[data-prose]")).toHaveText("Reply interrupted.");
  await expect(again).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");
  await expect(castEntry(page, womanOf(covered))).toBeVisible();
  await expect(castEntry(page, womanOf(uncovered))).toHaveCount(0);
  const narration = await upstreamRecords(uncovered);
  expect(narration.map((one) => one.model)).toEqual(["mock-fast", "mock-error"]);
  expect(castBlock(narration[1])).toBe(castBlock(baseline));
  expect(stateLine(narration[1])).toBe(stateLine(baseline));
  expect(await upstreamRecords(covered, "cast")).toHaveLength(1);
  expect(await upstreamRecords(uncovered, "cast")).toHaveLength(1);

  // The failure belongs to C1: selecting it exposes recovery without automatically spending a call.
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(replyCounter(page)).toContainText("1 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page)).toContainText(uncovered.replace("-in-", "-out-"));
  await expect(again).toBeVisible();
  expect(await upstreamRecords(uncovered, "cast")).toHaveLength(1);
  await again.click();
  await expect(castEntry(page, womanOf(uncovered))).toBeVisible();
  await expect(again).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");
  expect((await upstreamRecords(uncovered, "cast")).map((one) => one.model)).toEqual([
    "mock-error",
    "mock-cast",
  ]);

  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "failed");
  await expect(lastReply(page).locator("[data-prose]")).toHaveText("Reply interrupted.");
  await expect(castEntry(page, womanOf(covered))).toBeVisible();
  await expect(castEntry(page, womanOf(uncovered))).toHaveCount(0);
  await expect(again).toHaveCount(0);
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(castEntry(page, womanOf(uncovered))).toBeVisible();
  expect(await upstreamRecords(uncovered, "cast")).toHaveLength(2);
  expect(await upstreamRecords(covered, "cast")).toHaveLength(1);
});

test("edit mode saves, cancels by button and by Escape without closing, and Revert takes a correction back", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const record = await openRecord(page, SEEDED);
  const field = (name: string) => record.locator(`[data-cast-field="${name}"]`);
  const edit = record.getByRole("button", { name: "Edit record", exact: true });
  const save = record.getByRole("button", { name: "Save", exact: true });

  // Escape leaves edit mode, not the record.
  await edit.click();
  await expect(record.getByRole("textbox", { name: "Outfit" })).toHaveValue(KEEPER_WOMAN_OUTFIT);
  await record.getByRole("textbox", { name: "Outfit" }).fill("a red scarf");
  await page.keyboard.press("Escape");
  await expect(save).toHaveCount(0);
  await expect(record).toBeVisible();
  await expect(edit).toBeFocused();
  await expect(field("outfit")).toContainText(KEEPER_WOMAN_OUTFIT);

  // Cancel too.
  await edit.click();
  await record.getByRole("textbox", { name: "Outfit" }).fill("a red scarf");
  await record.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(save).toHaveCount(0);
  await expect(field("outfit")).toContainText(KEEPER_WOMAN_OUTFIT);
  await expect(field("outfit")).not.toHaveAttribute("data-cast-corrected");

  // Save: a look that holds for the chat, a state the next update takes over.
  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);
  await editRecord(page, SEEDED, { hair: "short silver hair", outfit: "a red scarf" });
  await expect(field("hair")).toContainText("short silver hair");
  await expect(field("hair")).toHaveAttribute("data-cast-corrected", "");
  await expect(field("outfit")).toContainText("a red scarf");
  await expect(field("outfit")).toHaveAttribute("data-cast-corrected", "");
  await expect(record.getByRole("button", { name: "Revert hair" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);

  // Both go out in the next request. Its keeper call names her again: it takes the state over,
  // and the look holds against it.
  const line = `The lamp turns ${crypto.randomUUID()}`;
  await exchange(page, line);
  const sent = await chatRecord(line);
  expect(castBlock(sent)).toContain("short silver hair");
  expect(stateLine(sent)).toContain("a red scarf");
  await expect
    .poll(async () => (await upstreamRecords(line, "cast")).map((call) => call.completed))
    .toEqual([true]);
  await openRecord(page, SEEDED);
  await expect(field("hair")).toHaveAttribute("data-cast-corrected", "");
  await expect(field("hair")).toContainText("short silver hair");
  await expect(field("outfit")).toContainText(KEEPER_WOMAN_OUTFIT);
  await expect(field("outfit")).not.toHaveAttribute("data-cast-corrected");

  await record.getByRole("button", { name: "Revert hair" }).click();
  await expect(field("hair")).toContainText("long copper-red hair in a braid");
  await expect(field("hair")).not.toHaveAttribute("data-cast-corrected");
  await expect(record.getByRole("button", { name: "Revert hair" })).toHaveCount(0);
});

test("personality keywords, a repeated one included, revert to exactly the recorded ones", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const record = await editRecord(page, SEEDED, { personality: "shy, shy, curious, kind" });
  const personality = record.locator('[data-cast-field="personality"]');
  const words = personality.locator("[data-tone]");
  await expect(words).toHaveCount(4);
  await expect(personality).toHaveText("shy, shy, curious, kind");
  await record.getByRole("button", { name: "Revert personality" }).click();
  await expect(personality).not.toHaveAttribute("data-cast-corrected");
  await expect(words).toHaveCount(3);
  await expect(personality).toHaveText("curious, quick, teasing personality");
});

test("Remove from cast leaves her out of the panel and the requests, and Undo brings her back", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const remove = async () => {
    const record = await openRecord(page, SEEDED);
    await record.getByRole("button", { name: "Remove from cast", exact: true }).click();
    await expect(record).toHaveCount(0);
    await expect(castPanel(page)).toContainText(`${SEEDED} removed.`);
    await expect(castEntry(page, SEEDED)).toHaveCount(0);
  };
  await remove();
  const undo = castPanel(page).getByRole("button", { name: `Undo removing ${SEEDED}` });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(castEntry(page, SEEDED)).toBeVisible();
  await expect(castPanel(page)).not.toContainText("removed.");

  await remove();
  const line = `Without her ${crypto.randomUUID()}`;
  await exchange(page, line);
  const block = castBlock(await chatRecord(line));
  expect(block).toContain(KEEPER_MAN);
  expect(block).not.toContain(SEEDED);
  // The keeper call follows the reply's end; nothing on the page waits for it here.
  await expect.poll(async () => (await upstreamRecords(line, "cast")).length).toBe(1);
  const [call] = await upstreamRecords(line, "cast");
  expect(call?.messages.at(-1)?.content).not.toContain(SEEDED);
  await expect(castEntry(page, SEEDED)).toHaveCount(0);
});

test("the character sheet reads the cast now, marks it stale after a description edit and regenerates it", async ({
  page,
  request,
}) => {
  const name = uniqueName("Sheet cast");
  await createCharacterViaApi(request, name, { description: `${name} tends the lamp.` });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-cast" });
  await openSheet(page, name);
  const section = page.locator("#s-cast");
  await expect(section).toContainText(
    "No cast sheet yet. One is read from the card when a chat starts.",
  );
  await section.getByRole("button", { name: "Read the cast now", exact: true }).click();
  await expect(section.getByRole("listitem")).toHaveText([
    `${SHEET_WOMAN} (29)`,
    `${SHEET_MAN} (34)`,
  ]);
  await expect(section.getByRole("button", { name: "Regenerate the cast" })).toBeVisible();
  expect(await upstreamRecords(name, "castSheet")).toHaveLength(1);

  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill(`${name} tends the lamp and mends the nets.`);
  await saved(page);
  await expect(section).toContainText("The card changed since this was read.");
  await section.getByRole("button", { name: "Regenerate the cast", exact: true }).click();
  await expect(section).not.toContainText("The card changed since this was read.");
  await expect(section.getByRole("listitem")).toHaveText([
    `${SHEET_WOMAN} (29)`,
    `${SHEET_MAN} (34)`,
  ]);
  // The section shows the same names while the new read runs: wait for the second call itself.
  await expect.poll(async () => (await upstreamRecords(name, "castSheet")).length).toBe(2);
  const [, regenerated] = await upstreamRecords(name, "castSheet");
  expect(regenerated?.messages.at(-1)?.content).toContain("mends the nets");
});
