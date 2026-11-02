import type { Page } from "@playwright/test";
import type { CastSheetResponse } from "../packages/core/src/cast/index.ts";
import { castEntry, castPanel, castStatus, chooseCastModel, editRecord } from "./support/cast.ts";
import { KEEPER_WOMAN_GIVEN, keeperWoman, SHEET_WOMAN } from "./support/cast-fixtures.ts";
import {
  chooseCharacter,
  clearChat,
  lastReply,
  openChat,
  send,
  turns,
  upstreamRecords,
} from "./support/chat.ts";
import { createCharacterViaApi, patchSettings } from "./support/entities.ts";
import { CANARY_MARKER, canary } from "./support/env.ts";
import { exchange, storedMemory } from "./support/memory.ts";
import { matrixRow, type Row, serverHopsHolding } from "./support/retention.ts";
import { expect, unsafe } from "./support/test.ts";
import type { MockModel, UpstreamRecordView } from "./support/upstream.ts";

/*
 * Retention matrix, the cast register's rows (docs/ARCHITECTURE.md §
 * Retention matrix, CA): one test per row, each in its own persistent
 * profile through `matrixRow`. A row first proves its canary existed (on
 * the page or at the mock upstream's keeper call), then every browser cell
 * is a step; the server cells run in e2e/server-writes.check.ts. The mock
 * keeper names a woman after the newest turn's canary, `-in-` turned to
 * `-cast-` (e2e/support/cast-fixtures.ts) when the cast model is `mock-cast`.
 */

/** The woman the keeper seeds or adds from turns without a canary. */
const UNMARKED = keeperWoman([]);
/** Every panel on the page, shown or not. */
const anyPanel = (page: Page) => page.locator("[data-cast]");

/** The chat's own request carrying `text`, not a keeper call reading it. */
async function chatRecord(text: string): Promise<UpstreamRecordView | undefined> {
  return (await upstreamRecords(text))[0];
}

const castBlock = (record: UpstreamRecordView | undefined) =>
  record?.messages.find((message) => message.content.startsWith("<cast>"))?.content;

/**
 * A chat on mock-fast with a new character of the row's, whose card has a
 * description; the cast calls go to `castModel`.
 */
async function castRow(
  { context, page, request }: Row,
  label: string,
  castModel: MockModel = "mock-cast",
) {
  const name = `Retention ${label} ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createCharacterViaApi(context.request, name, {
    description: `${name} keeps the ferry.`,
  });
  await patchSettings(request, { castModel });
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  return { name, id };
}

/** The server received `text` in a preview request, answered by Ephemera. */
const previewCarrying = (page: Page, text: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/chat/preview" &&
      (response.request().postData() ?? "").includes(text) &&
      response.ok(),
  );

matrixRow("cast", async (row) => {
  const { page } = row;
  await castRow(row, "cast");
  const line = canary("in");
  const woman = `${KEEPER_WOMAN_GIVEN} ${line.replace("-in-", "-cast-")}`;
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  // The keeper read the turn and answered her, named after its canary; the panel lists her.
  await expect(castEntry(page, woman)).toBeVisible();
  const [call, ...more] = await upstreamRecords(line, "cast");
  expect(more).toEqual([]);
  expect(call?.answer).toContain(woman);
  // The next generation sends her in the <cast> block; the inspector shows the block.
  const next = `Onward ${crypto.randomUUID()}`;
  await exchange(page, next);
  expect(castBlock(await chatRecord(next))).toContain(woman);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Prompt" });
  await expect(inspector.getByText("Cast", { exact: true })).toBeVisible();
  await expect(inspector).toContainText(woman);
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  // Clear takes the register: nothing of her shows or stays.
  await clearChat(page);
  await expect(turns(page)).toHaveCount(0);
  await expect(anyPanel(page)).toHaveCount(0);
  expect(await page.content()).not.toContain(CANARY_MARKER);
});

matrixRow("casterr", async (row) => {
  const { page } = row;
  await castRow(row, "casterr");
  await exchange(page, `Before the error ${crypto.randomUUID()}`);
  await expect(castEntry(page, UNMARKED)).toBeVisible();
  // The mock's error body echoes the keeper's turns; the app must not pass it on anywhere.
  await chooseCastModel(page, "mock-error");
  const line = canary("casterr");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(castStatus(page)).toHaveText("Cast couldn't update.");
  await expect(
    castPanel(page).getByRole("button", { name: "Try again to update the cast" }),
  ).toBeVisible();
  const [call, ...more] = await upstreamRecords(line, "cast");
  expect(more).toEqual([]);
  expect(call?.model).toBe("mock-error");
  expect(call?.answer).toBeNull();
  // The last good cast stays, and nothing of the error body shows.
  await expect(castEntry(page, UNMARKED)).toBeVisible();
  expect(await page.content()).not.toContain(`failed on`);
});

matrixRow("castclear", async (row) => {
  const { page } = row;
  // Read and introduce the sheet first, then hold the keeper's answer until the caller leaves.
  await castRow(row, "castclear");
  await exchange(page, `Introduce the sheet ${crypto.randomUUID()}`);
  await expect(castPanel(page)).toContainText(SHEET_WOMAN);
  await chooseCastModel(page, "mock-slow");
  const line = canary("castclear");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect.poll(async () => (await upstreamRecords(line, "cast")).length).toBe(1);
  await clearChat(page);
  await expect(turns(page)).toHaveCount(0);
  await expect(anyPanel(page)).toHaveCount(0);
  // Clear aborted the call: the server's call left the mock, which never answered.
  await expect
    .poll(async () => (await upstreamRecords(line, "cast")).map((call) => call.aborted))
    .toEqual([true]);
  expect((await upstreamRecords(line, "cast"))[0]?.answer).toBeNull();
  // No late answer brings the cast back.
  await page.waitForTimeout(500);
  await expect(anyPanel(page)).toHaveCount(0);
});

matrixRow("memcast", async (row) => {
  const { page, request } = row;
  const { id } = await castRow(row, "memcast");
  const source = canary("memcast");
  await exchange(page, source);
  const woman = keeperWoman([{ role: "user", content: source }]);
  await expect(castEntry(page, woman)).toBeVisible();
  const sceneState = canary("memcast");
  const record = await editRecord(page, woman, { hair: sceneState });
  await expect(record).toContainText(sceneState);
  await page.keyboard.press("Escape");
  const result = await request.post("/api/memory/remember", {
    headers: unsafe(),
    data: {
      characterId: id,
      model: "mock-fast",
      turns: [
        { role: "user", content: source },
        { role: "assistant", content: sceneState },
      ],
      episodes: [],
      held: [],
      attempt: crypto.randomUUID(),
    },
  });
  expect(result.status()).toBe(200);
  await result.json();
  const memory = await storedMemory(request, id);
  expect(memory.state?.notebook.cast).toHaveLength(1);
  const line = memory.state?.notebook.cast[0] ?? "";
  const anchor = JSON.parse(line) as { hair: string };
  for (const field of ["id", "aka", "state", "present", "outfit", "activity"])
    expect(anchor).not.toHaveProperty(field);
  row.chatContent.push(anchor.hair);
  expect(JSON.stringify(memory)).not.toContain(CANARY_MARKER);
  // Derived notebook anchors are permitted character data; source and corrections are not.
  await expect.poll(() => serverHopsHolding(anchor.hair)).toEqual(["S-data"]);
  expect(await serverHopsHolding([source, sceneState])).toEqual([]);
  await clearChat(page);
});

matrixRow("castedit", async (row) => {
  const { page } = row;
  await castRow(row, "castedit");
  await exchange(page, `Before the edit ${crypto.randomUUID()}`);
  await expect(castEntry(page, UNMARKED)).toBeVisible();
  const hair = canary("castedit");
  const record = await editRecord(page, UNMARKED, { hair });
  const field = record.locator('[data-cast-field="hair"]');
  await expect(field).toContainText(hair);
  await expect(field).toHaveAttribute("data-cast-corrected", "");
  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);
  // The correction goes out in the preview and in the next request.
  const draft = `After the edit ${crypto.randomUUID()}`;
  const previewed = previewCarrying(page, hair);
  await page.getByLabel("Message", { exact: true }).fill(draft);
  await previewed;
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(lastReply(page)).toContainText(draft);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(castBlock(await chatRecord(draft))).toContain(hair);
});

matrixRow(
  "castsheet",
  async (row) => {
    const { page, request } = row;
    const name = `Retention castsheet ${crypto.randomUUID().slice(0, 6)}`;
    const id = await createCharacterViaApi(request, name, {
      description: `${name} keeps the ferry.`,
    });
    // A caller that leaves mid-job: mock-slow holds the sheet's answer for its fifteen seconds.
    const left = await request
      .post(`/api/cast/sheets/${id}`, {
        headers: unsafe(),
        data: { model: "mock-slow" },
        timeout: 2_000,
      })
      .then(
        () => false,
        () => true,
      );
    expect(left).toBe(true);
    // The job outlives it and stores the sheet.
    const stored = async () => {
      const response = await request.get(`/api/cast/sheets/${id}`);
      expect(response.status()).toBe(200);
      return (await response.json()) as CastSheetResponse;
    };
    await expect.poll(async () => (await stored()).sheet !== null, { timeout: 30_000 }).toBe(true);
    // The mock may mark its answer sent after the server stored it: wait for the mark.
    await expect
      .poll(async () =>
        (await upstreamRecords(name, "castSheet")).map(({ aborted, completed }) => ({
          aborted,
          completed,
        })),
      )
      .toEqual([{ aborted: false, completed: true }]);
    const { sheet, current } = await stored();
    expect(current).toBe(true);
    expect(JSON.stringify(sheet)).not.toContain(CANARY_MARKER);
    // Positive control: the sheet is character data, found in the server's data only.
    const entryId = sheet?.entries[0]?.id ?? "";
    expect(entryId).not.toBe("");
    await expect.poll(() => serverHopsHolding(entryId)).toEqual(["S-data"]);

    // The caller's next request gets the stored sheet, with no new call.
    const again = await request.post(`/api/cast/sheets/${id}`, {
      headers: unsafe(),
      data: { model: "mock-fast" },
    });
    expect(again.status()).toBe(200);
    expect(((await again.json()) as CastSheetResponse).sheet?.fingerprint).toBe(sheet?.fingerprint);
    expect(await upstreamRecords(name, "castSheet")).toHaveLength(1);

    // A chat on it: its canary reaches the keeper, beside the sheet, and never the sheet.
    await patchSettings(request, { castModel: "mock-cast" });
    await openChat(page, "mock-fast");
    await chooseCharacter(page, name);
    // Canon stays private until the keeper grounds her introduction in play.
    await expect(castPanel(page)).toHaveCount(0);
    const line = canary("castsheet");
    await exchange(page, line);
    await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "false");
    await expect(castEntry(page, UNMARKED)).toBeVisible();
    await expect.poll(async () => (await upstreamRecords(line, "cast")).length).toBe(1);
    expect(castBlock(await chatRecord(line))).toContain(SHEET_WOMAN);
    expect(await upstreamRecords(name, "castSheet")).toHaveLength(1);
    expect(JSON.stringify((await stored()).sheet)).not.toContain(CANARY_MARKER);
    expect(await serverHopsHolding(line)).toEqual([]);
  },
  { timeout: 90_000 },
);
