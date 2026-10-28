import { readFile, rm } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { defaultPromptPreset } from "../packages/core/src/preset/prompt.ts";
import {
  browserStorage,
  chooseCharacter,
  chooseModel,
  clearChat,
  expectUpstreamAborted,
  lastReply,
  moreAction,
  openChat,
  replyActions,
  send,
  turns,
  upstreamRecords,
} from "./support/chat.ts";
import {
  choose,
  closeSession,
  createCharacterViaApi,
  createEventViaApi,
  createLorebookViaApi,
  createPersonaViaApi,
  createPresetViaApi,
  linkLorebookViaApi,
  loreEntry,
  openSession,
  setLorebookViaApi,
} from "./support/entities.ts";
import { APP_SERVERS, CANARY_MARKER, canary } from "./support/env.ts";
import {
  exchange,
  FOLDED_LINE,
  heldLine,
  rememberNow,
  seam,
  settledSeamLine,
  storedMemory,
} from "./support/memory.ts";
import { MEMORY_OPENING, MEMORY_OPENING_SCENE, MEMORY_TITLE } from "./support/memory-fixtures.ts";
import {
  expectUrlsClean,
  MATRIX_ROWS,
  matrixRow,
  openProfile,
  type Row,
  recordClass,
  serverHopsHolding,
} from "./support/retention.ts";
import { dataDirContaining, filesContaining } from "./support/scan.ts";
import { expire, notice, signInThroughPortal } from "./support/signin.ts";
import { appOrigin, expect, test, unsafe } from "./support/test.ts";

/*
 * Retention matrix, browser hops (docs/ARCHITECTURE.md § Retention
 * matrix): one test per row, each in its own persistent profile. A row first
 * proves its canary existed (on the page or at the mock upstream), then every
 * browser cell is a step; the server cells run in e2e/server-writes.check.ts
 * against the manifest each row writes when it ran.
 */

// The oversized row holds a megabyte message and sends a 9 MiB request; a trace would bloat.
test.use({ trace: "off" });

const composer = (page: Page) => page.getByLabel("Message", { exact: true });
const lastUser = (page: Page) => page.locator('[data-message][data-role="user"]').last();
/**
 * The server received `text`: a preview request carrying it, answered by
 * Ephemera. Rows whose content only a preview sends prove their server cells with it.
 */
const previewCarrying = (page: Page, text: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/chat/preview" &&
      (response.request().postData() ?? "").includes(text) &&
      response.ok(),
  );

/**
 * Clear also closes the character, and choosing it again empties the chat
 * once more; so before that, the first request after Clear must carry no
 * lorebook or event state, which shows Clear alone forgot it.
 */
async function expectNoStateSent(page: Page) {
  const line = `After Clear ${crypto.randomUUID()}`;
  const request = page.waitForRequest(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/chat" &&
      (candidate.postData() ?? "").includes(line),
  );
  await send(page, line);
  const body = (await request).postDataJSON() as { lorebookState?: unknown; eventsState?: unknown };
  expect(body.lorebookState).toBeUndefined();
  expect(body.eventsState).toBeUndefined();
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
}

matrixRow("in", async ({ context, page }) => {
  // Chatting as a persisted character and persona must not bring chat content near their rows.
  const character = `Retention ${crypto.randomUUID().slice(0, 6)}`;
  await createCharacterViaApi(context.request, character);
  const persona = `Retention persona ${crypto.randomUUID().slice(0, 6)}`;
  await createPersonaViaApi(context.request, persona, "Who I am.");
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  await openSession(page);
  await choose(page, "Persona", persona);
  await closeSession(page);
  const line = canary("in");
  await send(page, line);
  await expect(lastUser(page)).toContainText(line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(await upstreamRecords(line)).toHaveLength(1);
});

matrixRow("draft", async ({ page }) => {
  await openChat(page, "mock-fast");
  const draft = canary("draft");
  const previewed = previewCarrying(page, draft);
  await composer(page).fill(draft);
  await expect(composer(page)).toHaveValue(draft);
  await previewed;
});

matrixRow("out", async ({ page }) => {
  await openChat(page, "mock-fast");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page)).toContainText(`Reply: ${line.replace("-in-", "-out-")}`);
  await expect(composer(page)).toHaveValue("");
});

matrixRow("think", async ({ page }) => {
  await openChat(page, "mock-fast");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await lastReply(page).locator("summary").click();
  await expect(lastReply(page)).toContainText(line.replace("-in-", "-think-"));
});

matrixRow("cnote", async ({ context, page }) => {
  const keeper = `Retention note ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createCharacterViaApi(context.request, keeper);
  // The note is card data and persists, so it holds no canary; the chat sent beside it does.
  const note = `Keep the lamp lit. ${crypto.randomUUID().slice(0, 6)}`;
  const { revision } = (await (await context.request.get(`/api/characters/${id}`)).json()) as {
    revision: number;
  };
  const saved = await context.request.patch(`/api/characters/${id}`, {
    headers: unsafe(),
    data: { characterNote: { prompt: note, depth: 0, role: "system" }, revision },
  });
  expect(saved.status()).toBe(200);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, keeper);
  const line = canary("cnote");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  // Depth 0: the note follows the line sent.
  expect(record?.messages.slice(-2)).toEqual([
    { role: "user", content: line },
    { role: "system", content: note },
  ]);
  const draft = canary("cnote");
  await composer(page).fill(draft);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Prompt" });
  await expect(inspector).toContainText("Character's Note");
  await page.keyboard.press("Escape");
});

matrixRow("prompt", async ({ page }) => {
  await openChat(page, "mock-fast");
  const sent = canary("prompt");
  await send(page, sent);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const draft = canary("prompt");
  await composer(page).fill(draft);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Prompt" });
  await expect(inspector).toContainText("Sent to mock-fast");
  await inspector.getByRole("button", { name: /Chat history/ }).click();
  await expect(inspector.getByText(sent, { exact: true })).toBeVisible();
  await inspector
    .getByRole("radio", { name: "Preview" })
    .or(inspector.getByRole("button", { name: "Preview" }))
    .click();
  await expect(inspector).toContainText("Preview for mock-fast.");
  await inspector.getByRole("button", { name: /Chat history/ }).click();
  await expect(inspector.getByText(draft, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

matrixRow("lore", async ({ context, page }) => {
  const keeper = `Retention lore ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createCharacterViaApi(context.request, keeper);
  // The keys are book data, so they hold no canary; the chat text they match does.
  const key = `/${CANARY_MARKER.slice(0, 4)}\\w+-lore-\\w+/`;
  await setLorebookViaApi(context.request, id, {
    entries: [
      loreEntry({ comment: "Canary lore", keys: [key], content: "Lore that a canary brings in." }),
    ],
  });
  // A linked library book is read with the card's own.
  const book = `Retention library ${crypto.randomUUID().slice(0, 6)}`;
  const bookId = await createLorebookViaApi(context.request, book, {
    entries: [
      loreEntry({
        comment: "Library lore",
        keys: [key],
        content: "Library lore that a canary brings in.",
      }),
    ],
  });
  await linkLorebookViaApi(context.request, bookId, id);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, keeper);
  const line = canary("lore");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  const prompt = JSON.stringify(record?.messages);
  expect(prompt).toContain("Lore that a canary brings in.");
  expect(prompt).toContain("Library lore that a canary brings in.");
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const lore = page.getByRole("dialog", { name: "Prompt" }).getByRole("region", {
    name: "Lorebook",
  });
  const sent = lore.getByRole("list", { name: "Lorebook entries sent" });
  await expect(sent.getByRole("listitem")).toHaveCount(2);
  for (const item of await sent.getByRole("listitem").all()) {
    await expect(item).toContainText(`matched ${line}`);
  }
  // The inspector's link opens the library book's entry; the chat stays in the tab's memory.
  await lore.getByRole("link", { name: `${book}: edit Library lore` }).click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Library lore");
  await page.goBack();
  await expect(lastReply(page)).toContainText(line);
});

matrixRow("timed", async ({ context, page }) => {
  // Eight exchanges, a reload and three inspections.
  test.setTimeout(90_000);
  const keeper = `Retention timed ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createCharacterViaApi(context.request, keeper, { firstMessage: "Welcome in." });
  const lore = "Lore that stays a while.";
  const libraryLore = "Library lore that stays a while.";
  // The keys and sticky settings are persistent book data and hold no chat canary.
  const timed = (comment: string, content: string) =>
    loreEntry({
      comment,
      keys: [`/${CANARY_MARKER.slice(0, 4)}\\w+-timed-\\w+/`],
      content,
      settings: { sticky: 6 },
    });
  await setLorebookViaApi(context.request, id, { entries: [timed("Timed lore", lore)] });
  // A linked library book's sticky entry keeps its state beside the card's, in the tab alone.
  const bookId = await createLorebookViaApi(
    context.request,
    `Retention timed library ${crypto.randomUUID().slice(0, 6)}`,
    { entries: [timed("Library timed lore", libraryLore)] },
  );
  await linkLorebookViaApi(context.request, bookId, id);
  const greeting = page.locator("[data-message][data-greeting]");
  /** Sends `line` and returns the messages the mock upstream received for it, as JSON. */
  const exchange = async (line: string) => {
    await send(page, line);
    await expect(lastReply(page)).toContainText(line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const [record] = await upstreamRecords(line);
    expect(record).toBeDefined();
    return JSON.stringify(record?.messages);
  };
  /** Checks the inspector's lorebook section for the last request. */
  const inspect = async (check: (section: Locator) => Promise<void>) => {
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    await check(
      page.getByRole("dialog", { name: "Prompt" }).getByRole("region", { name: "Lorebook" }),
    );
    await page.keyboard.press("Escape");
  };
  /**
   * The state exists: without the greeting the canary goes at length 1 and
   * brings the entry in, which starts its sticky effect at 1; the next
   * message carries no canary and the entry still goes in (length 3 < 1 + 6).
   */
  const startSticky = async () => {
    await expect(greeting).toHaveCount(1);
    // A single greeting's actions are its own, in its More menu.
    await moreAction(page, greeting, "Delete");
    await expect(greeting).toHaveCount(0);
    const line = canary("timed");
    const first = await exchange(line);
    expect(first).toContain(lore);
    expect(first).toContain(libraryLore);
    await inspect((section) => expect(section).toContainText(`matched ${line}`));
    const next = await exchange(`Still here ${crypto.randomUUID()}`);
    expect(next).toContain(lore);
    expect(next).toContain(libraryLore);
    await inspect(async (section) => {
      const sent = section.getByRole("list", { name: "Lorebook entries sent" });
      await expect(sent.getByRole("listitem")).toHaveCount(2);
      for (const item of await sent.getByRole("listitem").all()) {
        await expect(item).toContainText(/stays in, \d+ more messages/);
      }
    });
  };
  /**
   * The state is gone: on the card's greeting, a message without the canary
   * goes at length 2, inside the span of the effect started at 1 (2 < 1 + 6),
   * so a surviving state would bring the entry in.
   */
  const expectForgotten = async () => {
    await expect(greeting).toHaveCount(1);
    await expect(turns(page)).toHaveCount(0);
    const sent = await exchange(`Nothing timed ${crypto.randomUUID()}`);
    expect(sent).not.toContain(lore);
    expect(sent).not.toContain(libraryLore);
    await inspect(async (section) => {
      await expect(section).toContainText("0 entries went in");
      await expect(section).not.toContainText("stays in");
    });
  };

  await openChat(page, "mock-fast");
  await chooseCharacter(page, keeper);
  await test.step("timed: a preview does not commit the state", async () => {
    // The draft starts both effects in the preview's copy alone, at length 1 without the greeting.
    await moreAction(page, greeting, "Delete");
    await expect(greeting).toHaveCount(0);
    const draft = canary("timed");
    const previewed = previewCarrying(page, draft);
    await composer(page).fill(draft);
    expect(await (await previewed).text()).toContain(libraryLore);
    await composer(page).fill("");
    // Sent at length 1, inside the span a committed state would hold.
    const sent = await exchange(`Not previewed ${crypto.randomUUID()}`);
    expect(sent).not.toContain(lore);
    expect(sent).not.toContain(libraryLore);
    await clearChat(page);
    await chooseCharacter(page, keeper);
  });
  await startSticky();
  // The state is numbers, not text: the browser cells cannot see it, so its absence is shown by behavior.
  await test.step("timed: Clear forgets the state", async () => {
    await clearChat(page);
    await expectNoStateSent(page);
    await chooseCharacter(page, keeper, { confirm: true });
    await expectForgotten();
  });
  await test.step("timed: a reload forgets the state", async () => {
    await clearChat(page);
    await chooseCharacter(page, keeper);
    await startSticky();
    await page.reload();
    await chooseModel(page, "mock-fast");
    await chooseCharacter(page, keeper);
    await expectForgotten();
  });
  await test.step("timed: pagehide forgets the state", async () => {
    await clearChat(page);
    await chooseCharacter(page, keeper);
    await startSticky();
    // chat.spec.ts's pattern: the event as the browser fires it on leaving.
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expectForgotten();
  });
});

matrixRow("event", async ({ context, page }) => {
  // Seven exchanges, a reload and an inspection.
  test.setTimeout(90_000);
  const keeper = `Retention event ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createCharacterViaApi(context.request, keeper);
  // The template is the owner's data and persists; what it expands to is chat content.
  const template = "Keep {{lastUserMessage}} in mind";
  await createEventViaApi(context.request, template, {
    cooldown: 1_000,
    scope: { kind: "selected", characters: [id], tags: [] },
  });
  const stored = await (await context.request.get("/api/events")).text();
  expect(stored).toContain(template);
  expect(stored).not.toContain(CANARY_MARKER);
  const lead = "[Direction for your next reply: ";
  /** The event state the tab sends to Ephemera with the generation carrying `line`, if any. */
  const carriedWith = async (line: string) => {
    const request = await page.waitForRequest(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/chat" &&
        (candidate.postData() ?? "").includes(line),
    );
    return (request.postDataJSON() as { eventsState?: unknown }).eventsState;
  };
  /**
   * Sends `line`; returns the event the mock upstream received with it, if
   * any, and the event state the tab's request carried.
   */
  const exchange = async (line: string) => {
    const carried = carriedWith(line);
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const [record] = await upstreamRecords(line);
    expect(record).toBeDefined();
    return {
      event: record?.messages.find((message) => message.content.startsWith(lead))?.content,
      carried: await carried,
    };
  };
  const expanded = (line: string) =>
    `${lead}Keep ${line} in mind. Work it into the scene naturally and do not mention this note.]`;
  /**
   * The state is gone: the first request carries none, so a 100% event
   * resting for a thousand replies fires again, and the next reply goes
   * without it.
   */
  const expectForgotten = async () => {
    await expect(turns(page)).toHaveCount(0);
    const line = canary("event");
    expect(await exchange(line)).toEqual({ event: expanded(line), carried: undefined });
    expect((await exchange(`Resting ${crypto.randomUUID()}`)).event).toBeUndefined();
  };

  await openChat(page, "mock-fast");
  await chooseCharacter(page, keeper);
  await test.step("event: a preview does not commit the state", async () => {
    // A preview never rolls: a fired event in its copy would rest the one the send rolls.
    const draft = canary("event");
    const previewed = previewCarrying(page, draft);
    await composer(page).fill(draft);
    expect(await (await previewed).text()).not.toContain(lead);
    // The send after the preview carries no state: the preview committed none.
    const carried = carriedWith(draft);
    await composer(page).press("Enter");
    expect(await carried).toBeUndefined();
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const [record] = await upstreamRecords(draft);
    expect(record?.messages.map((message) => message.content)).toContain(expanded(draft));
    // The inspector shows the event the last request carried, expanded.
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    const inspector = page.getByRole("dialog", { name: "Prompt" });
    await expect(inspector).toContainText("Sent to mock-fast");
    await inspector.getByRole("button", { name: /Chat history/ }).click();
    await expect(inspector.getByText(expanded(draft), { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await exchange(`Resting ${crypto.randomUUID()}`)).event).toBeUndefined();
  });
  // The state is ids and numbers, not text: its absence shows in the request the tab sends
  // next, which carries none, and in behaviour.
  await test.step("event: Clear forgets the state", async () => {
    await clearChat(page);
    await expectNoStateSent(page);
    await chooseCharacter(page, keeper, { confirm: true });
    await expectForgotten();
  });
  await test.step("event: a reload forgets the state", async () => {
    await page.reload();
    const session = page.getByRole("button", { name: "Session", exact: true });
    if ((await session.getAttribute("aria-pressed")) === "true") await session.click();
    await chooseModel(page, "mock-fast");
    await chooseCharacter(page, keeper);
    await expectForgotten();
  });
  await test.step("event: pagehide forgets the state", async () => {
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expectForgotten();
  });
});

matrixRow("macro", async ({ context, page }) => {
  test.setTimeout(90_000);
  const suffix = crypto.randomUUID().slice(0, 6);
  const character = `Retention variables ${suffix}`;
  const preset = `Retention variables ${suffix}`;
  await createCharacterViaApi(context.request, character, { firstMessage: "Welcome." });
  const prompt = defaultPromptPreset();
  const at = prompt.blocks.findIndex((block) => block.kind === "chatHistory");
  prompt.blocks.splice(at, 0, {
    kind: "custom",
    id: crypto.randomUUID(),
    name: "Variables",
    role: "system",
    enabled: true,
    depth: null,
    content: "LOCAL=[{{getvar::retention-local}}] GLOBAL=[{{getglobalvar::retention-global}}]",
  });
  // Persist only the generic template and variable keys. Canary values originate in chat.
  await createPresetViaApi(context.request, "prompt", { ...prompt, name: preset });
  const select = async () => {
    await openSession(page);
    await choose(page, "Prompt preset", preset);
    await closeSession(page);
  };
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  await select();
  const exchange = async (line: string) => {
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const [record] = await upstreamRecords(line);
    expect(record).toBeDefined();
    return record?.messages.find((message) => message.content.startsWith("LOCAL=["))?.content;
  };
  const start = async () => {
    const local = canary("macro");
    const global = canary("macro");
    const marker = `Store ${crypto.randomUUID()}`;
    await send(
      page,
      `{{setvar::retention-local::${local}}}{{setglobalvar::retention-global::${global}}}${marker}`,
    );
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const records = await upstreamRecords(marker);
    expect(
      records
        .at(-1)
        ?.messages.some((message) => message.content === `LOCAL=[${local}] GLOBAL=[${global}]`),
    ).toBe(true);
    return { local, global };
  };
  const forgotten = async () => {
    expect(await exchange(`Forgotten ${crypto.randomUUID()}`)).toBe("LOCAL=[] GLOBAL=[]");
  };
  const initial = await start();
  const previewValue = canary("macro");
  const previewed = previewCarrying(page, previewValue);
  await composer(page).fill(
    `{{setvar::retention-local::${previewValue}}}{{setglobalvar::retention-global::${previewValue}}}Preview`,
  );
  const response = await previewed;
  // The transient response proves the preview evaluated the setters on a copy.
  expect(await response.text()).toContain(previewValue);
  await composer(page).fill("");
  expect(await exchange(`After preview ${crypto.randomUUID()}`)).toBe(
    `LOCAL=[${initial.local}] GLOBAL=[${initial.global}]`,
  );
  // Clear also closes the character; the preset reads both namespaces without one.
  await test.step("macro: Clear forgets both namespaces", async () => {
    await clearChat(page);
    await forgotten();
  });
  await test.step("macro: reload forgets both namespaces", async () => {
    await start();
    await page.reload();
    const session = page.getByRole("button", { name: "Session", exact: true });
    if ((await session.getAttribute("aria-pressed")) === "true") await session.click();
    await chooseModel(page, "mock-fast");
    await chooseCharacter(page, character);
    await select();
    await forgotten();
  });
  await test.step("macro: pagehide forgets both namespaces", async () => {
    await start();
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await forgotten();
  });
});

matrixRow("swipe", async ({ page }) => {
  await openChat(page, "mock-fast");
  const line = canary("swipe");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(replyActions(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toContainText(line);
});

matrixRow("edit", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const user = lastUser(page);
  const edit = canary("edit");
  await moreAction(page, user, "Edit");
  await page.getByRole("textbox", { name: "Edit your message" }).fill(edit);
  const previewed = previewCarrying(page, edit);
  await page.keyboard.press("Control+Enter");
  await expect(user).toContainText(edit);
  await previewed;
  // A deletion keeps the turn for Undo, in memory only.
  await moreAction(page, user, "Delete");
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
});

matrixRow("cont", async ({ page }) => {
  await openChat(page, "mock-fast");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await replyActions(page).getByRole("button", { name: "Continue" }).click();
  await expect(lastReply(page)).toContainText(line.replace("-in-", "-cont-"));
});

matrixRow("imp", async ({ page }) => {
  await openChat(page, "mock-fast");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await page.getByRole("button", { name: "Write for me" }).click();
  await expect(composer(page)).toHaveValue(new RegExp(line.replace("-in-", "-imp-")));
});

matrixRow("err", async ({ page }) => {
  // The mock's error body echoes the prompt; the app must not pass it on anywhere.
  await openChat(page, "mock-error");
  const line = canary("err");
  await send(page, line);
  await expect(lastUser(page)).toContainText(line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "failed");
  expect(await upstreamRecords(line)).toHaveLength(1);
});

matrixRow("stop", async ({ page }) => {
  await openChat(page, "mock-slow");
  const line = canary("stop");
  await send(page, line);
  await expect(lastReply(page)).toContainText(line);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "stopped");
  // The partial reply stays.
  await expect(lastReply(page)).toContainText(line);
  await expectUpstreamAborted(line);
});

matrixRow("clear", async ({ page }) => {
  await openChat(page, "mock-slow");
  await expect(turns(page)).toHaveCount(0);
  const line = canary("clear");
  await send(page, line);
  await expect(lastReply(page)).toContainText(line);
  await clearChat(page);
  await expect(turns(page)).toHaveCount(0);
  await expectUpstreamAborted(line);
  // A late chunk of the aborted stream must not bring the reply back.
  await page.waitForTimeout(500);
  await expect(turns(page)).toHaveCount(0);

  // The variables a message sets are the chat's: Clear takes local and global ones alike.
  const generation = () =>
    page.waitForRequest((candidate) => new URL(candidate.url()).pathname === "/api/chat");
  const variable = canary("clear");
  const setting = generation();
  await send(page, `{{setvar::kept::${variable}}}{{setglobalvar::shared::${variable}}}Set.`);
  expect((await setting).postData() ?? "").toContain(variable);
  await expect(lastUser(page)).toContainText("Set.");
  await expect(lastUser(page)).not.toContainText(variable);
  await clearChat(page);
  await expect(turns(page)).toHaveCount(0);
  const after = generation();
  await send(page, "After the variables.");
  expect((await after).postData() ?? "").not.toContain(variable);
  await clearChat(page);
  await expect(turns(page)).toHaveCount(0);

  // Clear during a swipe, a continue and Write for me aborts each and restores nothing.
  const lastAborted = async (text: string) =>
    await expect.poll(async () => (await upstreamRecords(text)).at(-1)?.aborted).toBe(true);
  for (const action of ["New reply", "Continue", "Write for me"] as const) {
    const next = canary("clear");
    await send(page, next);
    await expect(lastReply(page)).toContainText(next);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(lastReply(page)).toHaveAttribute("data-status", "stopped");
    const scope = action === "Write for me" ? page : replyActions(page);
    await scope.getByRole("button", { name: action }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await clearChat(page);
    await lastAborted(next);
    await expect(turns(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue("");
  }
  expect(await page.content()).not.toContain(CANARY_MARKER);
});

matrixRow("big", async ({ page }) => {
  // Its two waits below may each take 30 s on a loaded machine.
  test.setTimeout(90_000);
  await openChat(page, "mock-fast");
  // A request over the 8 MiB chat body limit, sent by the page: answered 413, without echo.
  const oversized = canary("big");
  const request = page.waitForRequest(
    (candidate) => new URL(candidate.url()).pathname === "/api/chat",
  );
  const answer = await page.evaluate(async (text) => {
    const content = `${text} ${"x".repeat(9 * 1024 * 1024)}`;
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock-fast", messages: [{ role: "user", content }] }),
    });
    return { status: response.status, body: await response.text() };
  }, oversized);
  expect((await request).postDataBuffer()?.includes(oversized)).toBe(true);
  expect(answer).toEqual({ status: 413, body: JSON.stringify({ error: "payload_too_large" }) });

  // A message past the model's window: refused before anything goes upstream.
  const long = canary("big");
  await send(page, `${long} ${"word ".repeat(200_000)}`);
  await expect(lastUser(page)).toContainText(long, { timeout: 30_000 });
  // The server counts a megabyte of text; generous for a loaded machine.
  await expect(lastReply(page)).toContainText("don't fit the model's context window", {
    timeout: 30_000,
  });
  expect(await upstreamRecords(long)).toEqual([]);
});

matrixRow(
  "bf",
  async ({ page }) => {
    // The B-bf cell is this row's path: leave a chat with a reply and a draft, and come back.
    await openChat(page, "mock-fast");
    const line = canary("bf");
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(lastReply(page)).toContainText(line);
    const draft = canary("bf");
    await composer(page).fill(draft);
    await expect(composer(page)).toHaveValue(draft);
  },
  { skip: { clip: true } },
);

matrixRow(
  "reload",
  async ({ page }) => {
    await openChat(page, "mock-fast");
    const line = canary("reload");
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(lastReply(page)).toContainText(line);
    await composer(page).fill(canary("reload"));
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(turns(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue("");
    expect(await page.content()).not.toContain(CANARY_MARKER);
  },
  { skip: { bf: true } },
);

matrixRow("expiry", async ({ context, page }) => {
  await openChat(page, "mock-fast");
  const routes = await expire(context);
  const line = canary("expiry");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "waiting");
  await expect(notice(page)).toContainText("Your sign-in has expired");
  await composer(page).fill(canary("expiry"));
  await signInThroughPortal(page, context);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page)).toContainText(line);
  expect(routes.chat()).toBe(1);
  expect(await upstreamRecords(line)).toHaveLength(1);
});

/**
 * A chat with a character whose memory is on (every character's is, by
 * default), three exchanges long, the
 * first carrying `line`: with the four newest messages kept out (the
 * default), the memory call's span is that line and its reply. Returns the
 * character's id and name.
 */
async function memoryRow({ context, page }: Row, line: string) {
  const keeper = `Retention memory ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createCharacterViaApi(context.request, keeper);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, keeper);
  await exchange(page, line);
  await exchange(page, `Onward ${crypto.randomUUID()}`);
  await exchange(page, `Further ${crypto.randomUUID()}`);
  return { id, keeper };
}

matrixRow("mem", async (row) => {
  const line = canary("mem");
  const { id, keeper } = await memoryRow(row, line);
  await rememberNow(row.page);
  await expect(seam(row.page).getByRole("status")).toHaveText(heldLine(2));
  // The span reached the memory call; its answer holds nothing of it.
  const [call, ...more] = await upstreamRecords(line, "memory");
  expect(more).toEqual([]);
  expect(call?.messages.at(-1)?.content).toContain(line);
  expect(call?.answer).not.toContain(CANARY_MARKER);
  // Positive control: the memory the call wrote is found, in the server's data only.
  const [episode] = (await storedMemory(row.context.request, id)).episodes;
  expect(episode?.summary).not.toContain(CANARY_MARKER);
  await expect.poll(() => serverHopsHolding(episode?.summary ?? "")).toEqual(["S-data"]);
  // The next chat's opening is memory data: stored as written, its persona a macro, in the server's data only.
  expect((await storedMemory(row.context.request, id)).state?.opening).toBe(MEMORY_OPENING);
  await expect
    .poll(() => serverHopsHolding("{{user}} waits by the shuttered window"))
    .toEqual(["S-data"]);
  // Cleared without remembering, the next chat opens on it, filled for the persona in play:
  // chat content, which reaches the server in a request and persists nowhere.
  await clearChat(row.page);
  await chooseCharacter(row.page, keeper);
  const filled = MEMORY_OPENING_SCENE.replace("{{user}}", "User");
  row.chatContent.push(filled);
  const greeting = row.page.locator("[data-message][data-greeting]");
  await expect(greeting.locator("blockquote")).toHaveText(
    "Location: The back room of the chandlery, after dark",
  );
  await expect(greeting.getByText(filled, { exact: true })).toBeVisible();
  const after = `After the opening ${crypto.randomUUID()}`;
  await exchange(row.page, after);
  const [sent] = await upstreamRecords(after);
  expect(sent?.messages.some((message) => message.content.includes(filled))).toBe(true);
  expect(await serverHopsHolding(filled)).toEqual([]);
});

matrixRow("memerr", async (row) => {
  const line = canary("memerr");
  const { id } = await memoryRow(row, line);
  // The mock's error body echoes the span; the app must not pass it on anywhere.
  await chooseModel(row.page, "mock-error");
  await rememberNow(row.page);
  // The seam moves from the span's end to the top of the chat, the old one leaving as it goes.
  await expect(
    seam(row.page).filter({
      hasText: "The memory was not written: the memory model's answer failed.",
    }),
  ).not.toHaveCount(0);
  await expect(seam(row.page)).toHaveCount(1);
  expect(await upstreamRecords(line, "memory")).toHaveLength(1);
  expect((await storedMemory(row.context.request, id)).episodes).toEqual([]);
});

matrixRow("memclear", async (row) => {
  const line = canary("memclear");
  const { id } = await memoryRow(row, line);
  // mock-slow holds the memory answer until the caller leaves.
  await chooseModel(row.page, "mock-slow");
  await rememberNow(row.page);
  await expect(seam(row.page)).toHaveAttribute("data-status", "remembering");
  await expect.poll(async () => (await upstreamRecords(line, "memory")).length).toBe(1);
  await clearChat(row.page);
  await expect(turns(row.page)).toHaveCount(0);
  await expect(seam(row.page)).toHaveCount(0);
  // Clear aborted the call: the server's call left the mock, which never answered.
  await expect
    .poll(async () => (await upstreamRecords(line, "memory")).map((call) => call.aborted))
    .toEqual([true]);
  expect((await upstreamRecords(line, "memory"))[0]?.answer).toBeNull();
  expect((await storedMemory(row.context.request, id)).episodes).toEqual([]);
});

matrixRow("memfold", async ({ context, page }) => {
  // Several long exchanges and memory calls before a request folds.
  test.setTimeout(120_000);
  // mock-fold's window fills after a few long exchanges; filler carries no canary.
  const filler = () => `${crypto.randomUUID()} ${"Quiet rain fell on the old road. ".repeat(150)}`;
  const line = `${canary("memfold")} ${filler()}`;
  const keeper = `Retention fold ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createCharacterViaApi(context.request, keeper);
  await openChat(page, "mock-fold");
  await chooseCharacter(page, keeper);
  await exchange(page, line);
  await exchange(page, `Onward ${crypto.randomUUID()}`);
  await exchange(page, `Further ${crypto.randomUUID()}`);
  // With the four newest messages kept out, the span is the canary's line and its reply: held.
  await rememberNow(page);
  await expect(seam(page).getByRole("status")).toHaveText(heldLine(2));
  const [episode] = (await storedMemory(context.request, id)).episodes;
  expect(episode?.title).toBe(MEMORY_TITLE);
  // Held, its turns still reach the upstream.
  const still = `Still ${crypto.randomUUID()}`;
  await exchange(page, still);
  const [held] = await upstreamRecords(still);
  expect(held?.messages.some((message) => message.content.includes(line.slice(0, 40)))).toBe(true);

  // Until a request folds it: the memory in the story block, the canary in no message.
  let last = still;
  for (let sent = 0; sent < 10; sent++) {
    last = filler();
    await exchange(page, last);
    if ((await settledSeamLine(page)).includes("folded")) break;
  }
  await expect(seam(page).getByRole("status")).toHaveText(FOLDED_LINE);
  const [folding] = await upstreamRecords(last.slice(0, 36));
  const contents = folding?.messages.map((message) => message.content) ?? [];
  expect(contents.join("\n")).not.toContain(CANARY_MARKER);
  expect(contents.find((content) => content.includes("Earlier in this chat"))).toContain(
    MEMORY_TITLE,
  );
  // The held memory's id lives where its episode does, in the server's data only.
  await expect.poll(() => serverHopsHolding(episode?.id ?? "")).toEqual(["S-data"]);
});

test(`retention matrix: ${MATRIX_ROWS.bad.row}`, async ({ request }) => {
  // Server cells only: a malformed request never comes from the page.
  for (const path of ["/api/chat", "/api/chat/preview"]) {
    const cases = [
      {
        name: "invalid JSON",
        type: "application/json",
        body: `{"model":"mock-fast","messages":[{"role":"user","content":"${canary("bad")}"`,
        status: 400,
      },
      {
        name: "schema-invalid JSON",
        type: "application/json",
        body: JSON.stringify({ model: 42, messages: canary("bad") }),
        status: 400,
      },
      { name: "wrong content type", type: "text/plain", body: canary("bad"), status: 415 },
    ];
    for (const { name, type, body, status } of cases) {
      await test.step(`${path}: ${name}`, async () => {
        expect(body).toContain(`${CANARY_MARKER}-bad-`);
        const response = await request.post(path, {
          headers: { ...unsafe(), "Content-Type": type },
          data: body,
        });
        expect(response.status()).toBe(status);
        expect(await response.text()).not.toContain(CANARY_MARKER);
      });
    }
  }
  await recordClass("bad");
});

/*
 * The chat's cache affinity id is chat metadata, not content: it has no
 * canary, so it is checked here by value, outside the matrix rows.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
test("the cache affinity id stays in the tab and the request", async ({
  browserName,
  playwright,
  user,
}) => {
  const profile = await openProfile(playwright[browserName], appOrigin(), user);
  const { context, page } = profile;
  try {
    const previews: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/chat/preview") {
        previews.push(request.postData() ?? "");
      }
    });
    await page.goto("/");
    await openChat(page, "mock-fast");
    const tag = crypto.randomUUID().slice(0, 8);
    const sendAndWait = async (line: string) => {
      await send(page, line);
      await expect(lastReply(page)).toContainText(line);
      await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
      const [record] = await upstreamRecords(line);
      expect(record).toBeDefined();
      return record;
    };

    const first = await sendAndWait(`affinity-first-${tag}`);
    const second = await sendAndWait(`affinity-second-${tag}`);
    const key = first?.cacheKey ?? "";
    expect(key).toMatch(UUID);
    expect(first?.affinity).toBe(key);
    expect(second).toMatchObject({ cacheKey: key, affinity: key });

    const draft = `affinity-draft-${tag}`;
    const previewed = previewCarrying(page, draft);
    await composer(page).fill(draft);
    await previewed;

    await clearChat(page);
    const third = await sendAndWait(`affinity-third-${tag}`);
    const next = third?.cacheKey ?? "";
    expect(next).toMatch(UUID);
    expect(next).not.toBe(key);
    expect(third?.affinity).toBe(next);

    const ids = [key, next];
    expect(previews.length).toBeGreaterThan(0);
    for (const body of previews) for (const id of ids) expect(body).not.toContain(id);
    const storage = JSON.stringify(await browserStorage(page));
    for (const id of ids) expect(storage).not.toContain(id);
    await expectUrlsClean(page, ids);

    await context.close();
    expect(profile.policyViolations, "Content Security Policy violations").toEqual([]);
    for (const id of ids) {
      for (const scan of [
        await filesContaining(profile.dir, id),
        await dataDirContaining(APP_SERVERS.main.data, id),
      ]) {
        expect(scan.scanned).toBeGreaterThan(0);
        expect(scan).toMatchObject({ hits: [], unreadable: [] });
      }
    }
    const log = await readFile(APP_SERVERS.main.log, "utf8");
    for (const id of ids) expect(log).not.toContain(id);
  } finally {
    await context.close();
    await rm(profile.dir, { recursive: true, force: true });
  }
});
