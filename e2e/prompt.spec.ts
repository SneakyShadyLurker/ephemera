import type { Page } from "@playwright/test";
import { DEFAULT_AUTHORS_NOTE, defaultPromptPreset } from "../packages/core/src/preset/prompt.ts";
import { uniqueName } from "./support/cards.ts";
import {
  chooseCharacter,
  chooseModel,
  clearChat,
  headerAction,
  lastReply,
  openChat,
  send,
  upstreamRecords,
} from "./support/chat.ts";
import {
  choose,
  closeSession,
  createCharacterViaApi,
  createPersonaViaApi,
  createPresetViaApi,
  expectNoOverflow,
  openSession,
  seriousAxeViolations,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";
import { MOCK_OUTPUT_TOKENS, MOCK_REASONING_TOKENS } from "./support/upstream.ts";

const inspector = (page: Page) => page.getByRole("dialog", { name: "Prompt" });
const sentList = (page: Page) =>
  inspector(page).getByRole("list", { name: "Prompt in send order" });

async function openInspector(page: Page) {
  await headerAction(page, "Prompt");
  await expect(inspector(page)).toBeVisible();
}

/** Every message the inspector lists, band included, as its full text. */
async function shownContents(page: Page): Promise<string[]> {
  const band = inspector(page).getByRole("button", { name: /Chat history/ });
  if ((await band.getAttribute("aria-expanded")) !== "true") await band.click();
  // Each opened message loses its button, so always open the first one left.
  const more = inspector(page).getByRole("button", { name: "Show all" });
  while ((await more.count()) > 0) await more.first().click();
  return await sentList(page).locator("p.font-mono").allTextContents();
}

test("the inspector shows exactly the prompt the model received, labelled by source", async ({
  page,
}) => {
  const character = uniqueName("Inspected");
  const persona = uniqueName("Inspector");
  await createCharacterViaApi(page.request, character);
  await createPersonaViaApi(page.request, persona, `${persona} keeps a ledger.`);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  await openSession(page);
  await choose(page, "Persona", persona);
  await closeSession(page);

  const first = canary("in");
  await send(page, first);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const second = canary("in");
  await send(page, second);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  await openInspector(page);
  await expect(inspector(page)).toContainText("Sent to mock-fast at");
  await expect(inspector(page).getByText("Main prompt", { exact: true })).toBeVisible();
  await expect(inspector(page).getByText("Persona description", { exact: true })).toBeVisible();
  const [record] = await upstreamRecords(second);
  expect(await shownContents(page)).toEqual(record?.messages.map((message) => message.content));
  await expect(inspector(page).getByText(`${persona} keeps a ledger.`)).toBeVisible();
  // The model's own count arrives with the finished reply.
  await expect(inspector(page)).toContainText("the model counted");

  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prompt", exact: true })).toBeFocused();
});

test("the preview is labelled, includes the draft and follows its edits", async ({ page }) => {
  await openChat(page, "mock-fast");
  const draft = canary("draft");
  await page.getByLabel("Message", { exact: true }).fill(draft);
  await openInspector(page);
  // Nothing sent yet: the preview is what there is.
  await expect(inspector(page).getByRole("button", { name: "Last sent" })).toBeDisabled();
  await expect(inspector(page)).toContainText("Preview for mock-fast.");
  await expect(inspector(page)).toContainText("can change what goes out");
  expect(await shownContents(page)).toContain(draft);
  await expect(
    inspector(page)
      .getByRole("list", { name: "Chat history as sent" })
      .getByText("Your draft", { exact: true }),
  ).toBeVisible();

  // The inspector is modal; edits made after closing it show when it opens again.
  await page.keyboard.press("Escape");
  const edited = canary("draft");
  await page.getByLabel("Message", { exact: true }).fill(edited);
  await openInspector(page);
  await expect.poll(async () => await shownContents(page)).toContain(edited);
});

test("Clear empties the inspector, and nothing sent comes back", async ({ page }) => {
  await openChat(page, "mock-fast");
  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await clearChat(page);
  await openInspector(page);
  await expect(inspector(page).getByRole("button", { name: "Last sent" })).toBeDisabled();
  await expect(inspector(page)).not.toContainText(text);
  await expect(inspector(page)).toContainText("No messages yet");
});

test("a reasoning effort the model does not offer is not sent, and the sheet says so", async ({
  page,
}) => {
  const name = uniqueName("Deep thought");
  const id = await createPresetViaApi(page.request, "sampler", {
    name,
    values: {
      model: "mock-lowonly",
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      reasoning: "high",
    },
  });
  await page.goto(`/presets/sampler/${id}`);
  await expect(page.getByText("mock-lowonly doesn't offer high")).toBeVisible();
  await page.getByRole("combobox", { name: "Reasoning" }).click();
  const options = page.getByRole("listbox", { name: "Reasoning effort" }).getByRole("option");
  await expect(options).toHaveText(["Model default", "Low", "High"]);
  await page.keyboard.press("Escape");

  await openChat(page, "mock-lowonly");
  await openSession(page);
  await choose(page, "Sampler preset", name);
  await expect(
    page.getByText(/asks for high reasoning; mock-lowonly doesn't offer it/),
  ).toBeVisible();
  await closeSession(page);
  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(text);
  expect(record?.sampling).not.toHaveProperty("reasoning_effort");
  await openInspector(page);
  await expect(inspector(page)).toContainText(
    "High reasoning was not sent: mock-lowonly doesn't offer it.",
  );
});

const CACHE_RULE = "Unchanged since the last prompt above this line";

async function showPreview(page: Page) {
  await inspector(page)
    .getByRole("radio", { name: "Preview" })
    .or(inspector(page).getByRole("button", { name: "Preview" }))
    .click();
  await expect(inspector(page)).toContainText("Preview for mock-fast.");
}

test("the inspector shows the cached share and where the next prompt stops matching, until Clear", async ({
  page,
}) => {
  // A note after the main prompt sits early in the prompt: changing it breaks the shared start.
  // The note is preset text and persists, so it carries no canary.
  const name = uniqueName("Cached");
  await createPresetViaApi(page.request, "prompt", {
    name,
    blocks: defaultPromptPreset().blocks,
    authorsNote: {
      ...DEFAULT_AUTHORS_NOTE,
      position: "afterMain",
      text: `Keep the fog thick. ${uniqueName("note")}`,
    },
  });
  await openChat(page, "mock-fast");
  await openSession(page);
  await choose(page, "Prompt preset", name);
  await closeSession(page);
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

  // The mock serves half of its count from its cache.
  const [record] = await upstreamRecords(line);
  const chars = (record?.messages ?? []).reduce((total, { content }) => total + content.length, 0);
  const cached = Math.floor(Math.max(1, Math.round(chars / 5)) / 2);
  await openInspector(page);
  // The inspector groups digits as it does every count, then says what the model wrote.
  await expect(inspector(page)).toContainText(
    `of which ${new Intl.NumberFormat("en").format(cached)} were cached; it wrote ${MOCK_OUTPUT_TOKENS}, ${MOCK_REASONING_TOKENS} of them reasoning.`,
  );
  await page.keyboard.press("Escape");

  // Edited in the preset editor, the note reaches the open chat's next prompt by itself.
  const changed = `Keep the lamp lit. ${uniqueName("note")}`;
  await openSession(page);
  await page.getByRole("link", { name: `Edit ${name}` }).click();
  await page.getByRole("textbox", { name: "Author's Note" }).fill(changed);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chat" }).click();
  // Session comes back open, as it was left.
  await expect(page.getByRole("dialog", { name: "Session" })).toBeVisible();
  await closeSession(page);
  await openInspector(page);
  await showPreview(page);
  await expect(inspector(page)).toContainText(changed);
  await expect(inspector(page)).toContainText(
    /The next prompt matches the last prompt sent up to about [\d,]+ tokens; it first differs at “Author's Note, after the main prompt”, before the chat\./,
  );
  await expect(inspector(page).getByText(CACHE_RULE, { exact: true })).toHaveCount(1);
  await page.keyboard.press("Escape");

  await clearChat(page);
  await openInspector(page);
  await expect(inspector(page).getByRole("button", { name: "Last sent" })).toBeDisabled();
  await expect(inspector(page)).toContainText("Preview for mock-fast.");
  await expect(inspector(page)).not.toContainText("cached");
  await expect(inspector(page)).not.toContainText("the last prompt sent");
  await expect(inspector(page).getByText(CACHE_RULE, { exact: true })).toHaveCount(0);
});

test("a next prompt that only adds to the last one sent says the provider decides the rest", async ({
  page,
}) => {
  // An in-chat Author's Note moves with the chat, so the next prompt only adds when it is off.
  const name = uniqueName("Appending");
  await createPresetViaApi(page.request, "prompt", {
    name,
    blocks: defaultPromptPreset().blocks,
    authorsNote: { ...DEFAULT_AUTHORS_NOTE, enabled: false },
  });
  await openChat(page, "mock-fast");
  await openSession(page);
  await choose(page, "Prompt preset", name);
  await closeSession(page);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await page.getByLabel("Message", { exact: true }).fill(canary("draft"));
  await openInspector(page);
  await showPreview(page);
  await expect(inspector(page)).toContainText(
    "The next prompt only adds to the last one sent; whether the provider still has it cached depends on the provider.",
  );
  await expect(inspector(page).getByText(CACHE_RULE, { exact: true })).toHaveCount(0);
});

for (const { name, width, height, dark } of [
  { name: "desktop light", width: 1440, height: 900, dark: false },
  { name: "tablet dark", width: 820, height: 1180, dark: true },
  { name: "phone dark", width: 390, height: 844, dark: true },
]) {
  test(`the inspector fits and passes axe: ${name}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await chooseModel(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await openInspector(page);
    await inspector(page)
      .getByRole("button", { name: /Chat history/ })
      .click();
    await expect(inspector(page).getByText("Sent with", { exact: true })).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await inspector(page)
      .getByRole("radio", { name: "Preview" })
      .or(inspector(page).getByRole("button", { name: "Preview" }))
      .click();
    await expect(inspector(page)).toContainText("Preview for mock-fast.");
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}
