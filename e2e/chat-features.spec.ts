import type { Page } from "@playwright/test";
import { defaultPromptPreset } from "../packages/core/src/preset/prompt.ts";
import { uniqueName } from "./support/cards.ts";
import {
  beacons,
  chooseCharacter,
  chooseModel,
  clearChat,
  lastReply,
  messages,
  moreAction,
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
  FORM_FACTORS,
  openSession,
  patchSettings,
  seriousAxeViolations,
} from "./support/entities.ts";
import { canary, UPSTREAM_PORT } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

/** Markdown a hostile card could hold; every part must stay inert. */
const HOSTILE_GREETING = [
  `*She smiles.* Read [the board](http://127.0.0.1:${UPSTREAM_PORT}/__beacon/greeting-link) first.`,
  `![a lantern](http://127.0.0.1:${UPSTREAM_PORT}/__beacon/greeting.png)`,
  `<img src="http://127.0.0.1:${UPSTREAM_PORT}/__beacon/greeting-raw.png" onerror="document.title=1">`,
  "<script>document.title = 'owned'</script>",
].join("\n\n");

const composer = (page: Page) => page.getByLabel("Message", { exact: true });

for (const initial of ["length", "filter"] as const) {
  test(`a ${initial} finish is explained, and streamed Continue replaces then clears its reason`, async ({
    page,
  }) => {
    await openChat(page, "mock-fast");
    const line = `${canary("in")} [e2e-finish:${initial}]`;
    await send(page, line);
    const limited = "Cut off at the output limit. Continue writes on from here.";
    const filtered = "Stopped by the provider's content filter.";
    const first = initial === "length" ? limited : filtered;
    const second = initial === "length" ? filtered : limited;
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(lastReply(page).getByText(first, { exact: true })).toBeVisible();
    await expect(lastReply(page).locator("[data-prose]")).toContainText(
      line.replaceAll("-in-", "-out-"),
    );

    await replyActions(page).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
    await expect(lastReply(page).getByText(first, { exact: true })).toHaveCount(0);
    await expect(lastReply(page).getByText(second, { exact: true })).toBeVisible();
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(lastReply(page).locator("[data-prose]")).toContainText("First continuation.");

    await replyActions(page).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
    await expect(lastReply(page).getByText(second, { exact: true })).toHaveCount(0);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(lastReply(page).locator("[data-prose]")).toContainText("Finished continuation.");
    await expect(lastReply(page)).not.toContainText("Cut off at the output limit");
    await expect(lastReply(page)).not.toContainText("provider's content filter");
    expect(await upstreamRecords(line)).toHaveLength(3);
  });
}

for (const [fixture, notice] of [
  ["reasoning", "The output limit ran out while the model was reasoning, before any reply."],
  ["blocked", "The provider's content filter blocked this reply."],
] as const) {
  test(`a ${fixture} finish without visible output explains the empty reply`, async ({ page }) => {
    await openChat(page, "mock-fast");
    await send(page, `${canary("in")} [e2e-finish:${fixture}]`);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(lastReply(page).getByText(notice, { exact: true })).toBeVisible();
    await expect(lastReply(page).locator("[data-prose]")).toHaveText(notice);
  });
}

/** A character whose card opens on three greetings. */
async function greeter(page: Page) {
  const name = uniqueName("Greeter");
  await createCharacterViaApi(page.request, name, {
    firstMessage: "Hello, {{user}}. First greeting.",
    alternateGreetings: ["Second greeting for {{user}}.", "Third greeting."],
  });
  return name;
}

test("a character's greetings open the chat, switch by arrows and picker, and the chosen one is sent", async ({
  page,
}) => {
  const name = await greeter(page);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  await expect(messages(page)).toHaveCount(1);
  await expect(lastReply(page)).toContainText("Hello, User. First greeting.");
  // A greeting nobody touched is the card's, but Clear also closes the character.
  await expect(page.getByRole("button", { name: /^Clear/ })).toBeEnabled();

  await page.getByRole("button", { name: "Next greeting" }).click();
  await expect(lastReply(page)).toContainText("Second greeting for User.");
  await page.getByRole("button", { name: "Greeting 2 of 3" }).click();
  await page.getByRole("menuitemradio", { name: /Third greeting/ }).click();
  await expect(lastReply(page)).toContainText("Third greeting.");
  await expect(page.getByRole("button", { name: "Next greeting" })).toBeDisabled();

  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  expect(record?.messages.slice(-3)).toEqual([
    { role: "assistant", content: "Third greeting." },
    { role: "user", content: DEFAULT_NOTE_SENT },
    { role: "user", content: line },
  ]);
  // Clear closes the character, back to the chat without one; choosing it again restarts on the first greeting.
  await clearChat(page);
  await expect(messages(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a character" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Clear/ })).toBeDisabled();
  await chooseCharacter(page, name);
  await expect(lastReply(page)).toContainText("Hello, User. First greeting.");
});

test("Clear on a chat with only its untouched greeting closes it without asking", async ({
  page,
}) => {
  const name = await greeter(page);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  await page.getByRole("button", { name: "Next greeting" }).click();
  await expect(lastReply(page)).toContainText("Second greeting for User.");

  // An open edit of the greeting is the user's: Clear asks, and keeping it keeps the edit.
  await moreAction(page, replyActions(page), "Edit");
  const field = lastReply(page).getByRole("textbox", { name: /^Edit / });
  const rewritten = canary("in");
  await field.fill(rewritten);
  await clearChat(page, false);
  await expect(field).toHaveValue(rewritten);
  await lastReply(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(field).toHaveCount(0);

  await page.getByRole("button", { name: /^Clear/ }).click();
  await expect(messages(page)).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a character" })).toBeVisible();
  await expect(composer(page)).toBeFocused();
});

test("a greeting's unquoted Location line shows quoted, apart from the scene", async ({ page }) => {
  const name = uniqueName("Locator");
  await createCharacterViaApi(page.request, name, {
    firstMessage: "Location: the archive, dusk\nRain ticks on the roof.",
  });
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  const quote = lastReply(page).locator("blockquote");
  await expect(quote).toHaveText("Location: the archive, dusk");
  await expect(quote).not.toContainText("Rain");
  await expect(lastReply(page).getByText("Rain ticks on the roof.")).toBeVisible();
});

test("a character chosen while the persona list loads gives way to a later choice, an edit, or Clear", async ({
  page,
  request,
}) => {
  const [first, second, third] = [uniqueName("Ash"), uniqueName("Birch"), uniqueName("Cedar")];
  const ids: string[] = [];
  for (const name of [first, second, third]) {
    ids.push(await createCharacterViaApi(request, name, { firstMessage: `${name} waits.` }));
  }
  await patchSettings(request, { model: "mock-fast", characterId: ids[0] ?? null });

  // The persona list answers only once let through.
  let open = () => {};
  let gate = Promise.resolve();
  const hold = () => {
    gate = new Promise((resolve) => {
      open = resolve;
    });
  };
  await page.route("**/api/personas", async (route) => {
    await gate;
    await route.continue();
  });
  const heading = page.getByRole("heading", { level: 1 });

  // Two choices before the list arrives: the later one stands.
  hold();
  await page.goto("/");
  await expect(heading).toHaveText(first);
  await chooseCharacter(page, second);
  await chooseCharacter(page, third);
  open();
  await expect(heading).toHaveText(third);
  await expect(lastReply(page)).toContainText(`${third} waits.`);

  // An edit of the greeting begun while a choice waits stands: the choice does not discard it.
  hold();
  await page.reload();
  await expect(heading).toHaveText(third);
  await chooseCharacter(page, second);
  await lastReply(page)
    .getByRole("button", { name: /^More actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const field = page.getByRole("textbox", { name: /^Edit .*'s greeting$/ });
  await field.fill("A scene of my own.");
  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/personas",
  );
  open();
  await listed;
  // Long enough for the waiting choice to have gone through, had it still been taken.
  await page.waitForTimeout(500);
  await expect(heading).toHaveText(third);
  await expect(field).toHaveValue("A scene of my own.");
  await page.keyboard.press("Escape");
  await expect(field).toBeHidden();

  // A Clear while a choice waits stands: the choice does not bring a character back.
  hold();
  await page.reload();
  await expect(heading).toHaveText(third);
  await chooseCharacter(page, first);
  // Only the greeting is there, so Clear does not ask.
  await page.getByRole("button", { name: /^Clear/ }).click();
  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/personas",
  );
  open();
  await answered;
  // Long enough for the waiting choice to have gone through, had it still been taken.
  await page.waitForTimeout(500);
  await expect(heading).toHaveText("Chat");
  await expect(messages(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a character" })).toBeVisible();
});

test("swipes: New reply writes another, arrows and keys step, Replace swaps only the shown one", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  // One reply: no pager.
  await expect(replyCounter(page)).toHaveCount(0);

  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const records = await upstreamRecords(line);
  expect(records).toHaveLength(2);
  expect(records[1]?.messages.at(-1)).toEqual({ role: "user", content: line });

  await replyActions(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(replyCounter(page)).toContainText("1 / 2");
  // Left and Right swipe while the composer is empty.
  await composer(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(replyCounter(page)).toContainText("2 / 2");
  await page.keyboard.press("ArrowLeft");
  await expect(replyCounter(page)).toContainText("1 / 2");

  await moreAction(page, replyActions(page), "Replace this reply");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(replyCounter(page)).toContainText("1 / 2");
  expect(await upstreamRecords(line)).toHaveLength(3);
});

test("edit by keyboard reaches the next request; delete leaves an Undo in its place", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const first = canary("in");
  await send(page, first);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  const user = messages(page).first();
  await moreAction(page, user, "Edit");
  const field = page.getByRole("textbox", { name: "Edit your message" });
  await expect(field).toBeFocused();
  // A keyboard says its keys; a touch screen does not (below).
  await expect(page.getByText("Ctrl Enter saves. Esc cancels.")).toBeVisible();
  const edited = canary("in");
  await field.fill(edited);
  await field.press("Control+Enter");
  await expect(user).toContainText(edited);
  // Focus returns to the More button the edit began from.
  await expect(user.getByRole("button", { name: /^More actions/ })).toBeFocused();

  // Esc cancels an edit.
  await moreAction(page, user, "Edit");
  await page.getByRole("textbox", { name: "Edit your message" }).fill("never saved");
  await page.keyboard.press("Escape");
  await expect(user).toContainText(edited);

  await moreAction(page, replyActions(page), "Delete");
  await expect(messages(page)).toHaveCount(1);
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(page.getByRole("status").filter({ hasText: "reply was deleted" })).toBeVisible();
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(messages(page)).toHaveCount(2);

  const next = canary("in");
  await send(page, next);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(next);
  expect(record?.messages.map((m) => m.content)).toContain(edited);
  expect(JSON.stringify(record?.messages)).not.toContain(first);
});

test("Continue extends the reply; Write for me fills the composer and sends as the user", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  await replyActions(page).getByRole("button", { name: "Continue" }).click();
  await expect(lastReply(page)).toContainText(line.replace("-in-", "-cont-"));
  await expect(lastReply(page)).toContainText(line.replace("-in-", "-out-"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect((await upstreamRecords(line)).at(-1)?.messages.at(-2)?.role).toBe("assistant");

  // Alt+Enter continues too.
  await composer(page).focus();
  await page.keyboard.press("Alt+Enter");
  await expect.poll(async () => (await upstreamRecords(line)).length).toBe(3);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  await page.getByRole("button", { name: "Write for me" }).click();
  await expect(composer(page)).toHaveValue(new RegExp(line.replace("-in-", "-imp-")));
  await expect(composer(page)).toBeFocused();
  await expect(messages(page)).toHaveCount(2);
  await composer(page).press("Enter");
  await expect(messages(page)).toHaveCount(4);
  await expect(messages(page).nth(2)).toContainText(line.replace("-in-", "-imp-"));
});

test("the preset's Author's Note reaches the model at depth 1 as the user, is labelled in the inspector, and its switch takes it out", async ({
  page,
}) => {
  // The note is preset text and persists, so it stays the default, never a canary.
  const name = uniqueName("Noted");
  await createPresetViaApi(page.request, "prompt", {
    name,
    blocks: defaultPromptPreset().blocks,
  });
  await openChat(page, "mock-fast");
  await openSession(page);
  await choose(page, "Prompt preset", name);
  await closeSession(page);

  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  expect(record?.messages.slice(-2)).toEqual([
    { role: "user", content: DEFAULT_NOTE_SENT },
    { role: "user", content: line },
  ]);

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Prompt" });
  await inspector.getByRole("button", { name: /Chat history/ }).click();
  const row = inspector
    .getByRole("listitem")
    .filter({ hasText: "Author's Note, 1 message from the end", hasNotText: "Chat history" });
  await expect(row).toBeVisible();
  await expect(row.getByText("User", { exact: true }).filter({ visible: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await openSession(page);
  await page.getByRole("link", { name: `Edit ${name}` }).click();
  const sendNote = page.getByRole("switch", { name: "Send the Author's Note" });
  await expect(sendNote).toBeChecked();
  await sendNote.click();
  await expect(sendNote).toHaveAccessibleDescription(
    "Off: kept here and not placed in the prompt; {{authorsNote}} still reads it.",
  );
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chat" }).click();
  // Session comes back open, as it was left.
  await expect(page.getByRole("dialog", { name: "Session" })).toBeVisible();
  await closeSession(page);

  const next = canary("in");
  await send(page, next);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [after] = await upstreamRecords(next);
  expect(after?.messages.at(-1)).toEqual({ role: "user", content: next });
  expect(JSON.stringify(after?.messages)).not.toContain(DEFAULT_NOTE_SENT);
});

test("reasoning is collapsed by default, opens by keyboard, and is never sent back", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const summary = lastReply(page).locator("summary");
  await expect(summary).toHaveText(/Thought for \d+ seconds?/);
  const thought = lastReply(page).getByText(line.replace("-in-", "-think-"));
  await expect(thought).toBeHidden();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(thought).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(thought).toBeHidden();

  const next = canary("in");
  await send(page, next);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(next);
  expect(JSON.stringify(record?.messages)).not.toContain("-think-");
});

test("the context meter follows the next prompt and reads Full once history is left out", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const meter = page.getByRole("meter", { name: "Context" });
  const prompt = page.getByRole("button", { name: "Prompt", exact: true });
  const before = await prompt.boundingBox();
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(meter).toHaveAttribute("aria-valuetext", /^About [\d,]+ of 131,072 tokens/);

  // A turn this long, echoed by the mock, leaves no room for both it and its reply, even
  // once the estimate is calibrated by the mock's own count.
  const long = `${canary("in")} ${"word ".repeat(90_000)}`;
  await composer(page).fill(long);
  await composer(page).press("Enter");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
  await expect(meter).toHaveAttribute("aria-valuetext", /^Context window full/, {
    timeout: 10_000,
  });
  // "Full" shows before the header's actions, in the figures' reserved room, so nothing shifts.
  await expect(page.locator("header")).toContainText("Full", { useInnerText: true });
  expect(await prompt.boundingBox()).toEqual(before);
  await expect(page.locator("[data-trim-marker]")).toContainText("left out");
});

test("greetings and reasoning from hostile text stay inert", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const name = uniqueName("Hostile greeter");
  await createCharacterViaApi(page.request, name, {
    firstMessage: HOSTILE_GREETING,
    alternateGreetings: ["<img src=x onerror=alert(1)> second"],
  });
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  const greeting = lastReply(page);
  await expect(
    greeting.locator("[data-prose]").locator("a, img, script, iframe, style"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Greeting 1 of 2" }).click();
  await expect(page.getByRole("menuitemradio", { name: /second/ })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.title()).toBe("Ephemera");
  expect(requested.filter((url) => url.includes("__beacon"))).toEqual([]);
  const sent = await beacons();
  expect(sent).toEqual([]);
});

for (const { name: formFactor, width, height, scheme } of FORM_FACTORS) {
  test(`the ${formFactor} layout fits the new surfaces without serious axe violations`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const character = await greeter(page);
    await openChat(page, "mock-fast");
    await chooseCharacter(page, character);

    // The greeting picker: a menu, or a sheet on phones.
    await page.getByRole("button", { name: "Greeting 1 of 3" }).click();
    if (formFactor === "phone") {
      const sheet = page.getByRole("dialog", { name: "Greetings" });
      await expect(sheet).toBeVisible();
      expect(await seriousAxeViolations(page)).toEqual([]);
      await sheet.getByRole("button", { name: /Second greeting/ }).click();
      await expect(sheet).toHaveCount(0);
    } else {
      // Base UI honors the popup's explicit label.
      await expect(page.getByRole("menu", { name: "Greetings" })).toBeVisible();
      expect(await seriousAxeViolations(page)).toEqual([]);
      await page.getByRole("menuitemradio", { name: /Second greeting/ }).click();
    }
    await expect(lastReply(page)).toContainText("Second greeting");

    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await lastReply(page).locator("summary").click();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await replyActions(page).getByRole("button", { name: "Continue" }).click();
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expectNoOverflow(page);
  });
}

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("dragging the last reply sideways swipes it, and past the last writes another", async ({
    page,
  }) => {
    await openChat(page, "mock-fast");
    const line = canary("in");
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const prose = () => lastReply(page).locator("[data-prose] p").first();
    const drag = async (dx: number) => {
      // The thread scrolls to keep the latest line in view as the actions row appears:
      // measure once the reply has stopped moving.
      await expect(page.locator("[data-reply-actions]")).toBeVisible();
      let last = "";
      await expect
        .poll(async () => {
          const now = JSON.stringify(await prose().boundingBox());
          const settled = now === last;
          last = now;
          return settled;
        })
        .toBe(true);
      const box = await prose().boundingBox();
      if (box === null) throw new Error("no reply");
      const y = box.y + box.height / 2;
      const x = box.x + box.width / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (dx * step) / 8, y);
      await page.mouse.up();
    };
    await drag(-160);
    await expect(replyCounter(page)).toContainText("2 / 2");
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await drag(160);
    await expect(replyCounter(page)).toContainText("1 / 2");
    expect(await upstreamRecords(line)).toHaveLength(2);
  });

  test("no keyboard shortcut is shown: Replace and the edit field say only what to tap", async ({
    page,
  }) => {
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await replyActions(page)
      .getByRole("button", { name: /^More actions/ })
      .click();
    const replace = page.getByRole("menuitem", { name: "Replace this reply", exact: true });
    await expect(replace).toBeVisible();
    await expect(replace.getByText("Ctrl Enter")).toBeHidden();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const field = page.getByRole("textbox", { name: /^Edit .*reply$/ });
    await expect(field).toBeVisible();
    await expect(page.getByText("Ctrl Enter saves. Esc cancels.")).toBeHidden();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  });
});

test("the prompt preset's Continue instruction is edited in Actions and joins natively", async ({
  page,
}) => {
  const name = uniqueName("Continuing");
  const id = await createPresetViaApi(page.request, "prompt", {
    name,
    blocks: defaultPromptPreset().blocks,
  });
  await page.goto(`/presets/prompt/${id}`);
  // Preset text persists by design, so it carries no canary (the server-writes check scans for them).
  const nudge = `[Go on, {{char}}. ${uniqueName("nudge")}]`;
  const actions = page.getByRole("region", { name: "Actions", exact: true });
  await actions.getByRole("textbox", { name: "Continue", exact: true }).fill(nudge);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await openChat(page, "mock-fast");
  await openSession(page);
  await choose(page, "Prompt preset", name);
  await closeSession(page);
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const original = `Reply: ${line.replaceAll("-in-", "-out-")}`;
  const prose = lastReply(page).locator("[data-prose]");
  await expect(prose).toHaveText(original);
  await replyActions(page).getByRole("button", { name: "Continue" }).click();
  await expect.poll(async () => (await upstreamRecords(line)).length).toBe(2);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const sent = (await upstreamRecords(line)).at(-1)?.messages.at(-1);
  expect(sent).toEqual({ role: "system", content: nudge.replace("{{char}}", "Assistant") });
  // With a custom instruction, mock-fast echoes its first reply. Native joining drops that echo.
  await expect(prose).toHaveText(original);
  // A distinct continuation joins with a space, including after an edited reply.
  const edited = "The scene continues.";
  await moreAction(page, replyActions(page), "Edit");
  const field = page.getByRole("textbox", { name: /^Edit .*reply$/ });
  await field.fill(edited);
  await field.press("Control+Enter");
  await expect(prose).toHaveText(edited);
  await replyActions(page).getByRole("button", { name: "Continue" }).click();
  await expect.poll(async () => (await upstreamRecords(line)).length).toBe(3);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const joined = `${edited} ${original}`;
  await expect(prose).toHaveText(joined);
  // The next request carries exactly the joined text, without a repeated prefix or a forced newline.
  const next = canary("in");
  await send(page, next);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(next);
  const reply = record?.messages.findLast((message) => message.role === "assistant");
  expect(reply?.content).toBe(joined);
});

test("earlier turns' actions appear on keyboard focus with a visible ring", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const more = messages(page)
    .first()
    .getByRole("button", { name: /^More actions/ });
  await more.focus();
  // The reveal fades in; poll until it has.
  await expect
    .poll(() =>
      more.evaluate((node) => ({
        opacity: getComputedStyle(node.parentElement as Element).opacity,
        ring: `${getComputedStyle(node).outlineStyle} ${getComputedStyle(node).outlineWidth}`,
      })),
    )
    .toEqual({ opacity: "1", ring: "solid 2px" });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Edit your message" })).toBeFocused();
});

test("under reduced motion a new alternate fades in without moving", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  const transforms = await page.evaluate(async () => {
    const seen = new Set<string>();
    for (let frame = 0; frame < 20; frame += 1) {
      const node = document.querySelector(
        '[data-message][data-role="assistant"] [data-prose] > div',
      );
      if (node) seen.add(getComputedStyle(node).transform);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return [...seen];
  });
  expect(transforms).toEqual(["none"]);
});

test("a greeting that references a card field past the macro bound is skipped without breaking the chat", async ({
  page,
}) => {
  const name = `${uniqueName("Bound")} ${"x".repeat(180)}`;
  await createCharacterViaApi(page.request, name, {
    description: "{{char}}".repeat(6_000),
    firstMessage: "{{description}}",
  });
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(messages(page)).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
});

test("an edit in progress survives leaving the chat and coming back", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const user = messages(page).first();
  await moreAction(page, user, "Edit");
  const unsaved = canary("edit");
  await page.getByRole("textbox", { name: "Edit your message" }).fill(unsaved);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Characters" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Characters" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "Edit your message" })).toHaveValue(unsaved);
  await page.keyboard.press("Escape");
  // With the field closed, the chat's keys work again.
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await page.keyboard.press("ArrowLeft");
  await expect(replyCounter(page)).toContainText("1 / 2");
});

test("the meter hides for a model without a known window", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const meter = page.getByRole("meter", { name: "Context" });
  await expect(meter).toHaveCount(1);
  await chooseModel(page, "mock-nowindow");
  await expect(meter).toHaveCount(0);
  await chooseModel(page, "mock-fast");
});
