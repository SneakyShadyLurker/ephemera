import type { Route } from "@playwright/test";
import { pngText } from "../apps/server/test/image-fixtures.ts";
import { defaultPromptPreset, type PromptBlock } from "../packages/core/src/preset/prompt.ts";
import { EXAMPLE_SEPARATOR } from "../packages/core/src/prompt/examples.ts";
import corpusV3 from "../packages/core/test-fixtures/imports/v3-full.json" with { type: "json" };
import { importCards, pngCard } from "./support/cards.ts";
import {
  chooseCharacter,
  clearChat,
  lastReply,
  messages,
  openChat,
  replyActions,
  scriptReplies,
  send,
  upstreamRecords,
} from "./support/chat.ts";
import {
  choose,
  closeSession,
  createCharacterViaApi,
  createPersonaViaApi,
  createPresetViaApi,
  openSession,
  patchSettings,
} from "./support/entities.ts";
import { expect, test } from "./support/test.ts";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

test("native example passages written in the editor persist and reach the model separately", async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const name = `Archivist ${suffix}`;
  const id = await createCharacterViaApi(page.request, name);
  await page.goto(`/characters/${id}`);
  await expect(
    page.getByText(
      "Example dialogue. Separate passages with --- on its own line, with a blank line on either side.",
      { exact: true },
    ),
  ).toBeVisible();
  const passages = [`${name}: The lamp is lit.`, `${name}: The archive is quiet.`];
  const examples = passages.join(EXAMPLE_SEPARATOR);
  await page.getByLabel("Examples", { exact: true }).fill(examples);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/characters/${id}`)).json()).card.exampleDialogue,
      { timeout: 10_000 },
    )
    .toBe(examples);
  await page.reload();
  await expect(page.getByLabel("Examples", { exact: true })).toHaveValue(examples);

  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  const marker = `Native example request ${suffix}`;
  await send(page, marker);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const sent = (await upstreamRecords(marker)).at(-1)?.messages ?? [];
  expect(
    sent.filter((message) => passages.some((passage) => message.content.includes(passage))),
  ).toEqual(passages.map((content) => ({ role: "system", content })));
  expect(sent.some((message) => message.content.includes("<START>"))).toBe(false);
});

test("a foreign corpus card transforms to native JSON and PNG and chats with native actions", async ({
  page,
}) => {
  const name = corpusV3.data.name;
  await importCards(page, [await pngCard("corpus-v3.png", corpusV3)]);
  const listed = (await (await page.request.get("/api/characters")).json()).characters as {
    id: string;
    name: string;
  }[];
  const id = listed.find((character) => character.name === name)?.id ?? "";
  const before = await (await page.request.get(`/api/characters/${id}`)).json();
  expect(before.card).toHaveProperty("firstMessage");
  expect(before.card).not.toHaveProperty("extensions");
  for (const format of ["json", "png"]) {
    const bytes = Buffer.from(
      await (await page.request.get(`/api/characters/${id}/export.${format}`)).body(),
    );
    const chunks = format === "png" ? pngText(bytes) : undefined;
    if (chunks) {
      expect(chunks).not.toHaveProperty("ccv3");
      expect(chunks).not.toHaveProperty("chara");
    }
    const exported = JSON.parse(
      format === "png"
        ? Buffer.from(chunks?.ephemera ?? "", "base64").toString("utf8")
        : bytes.toString("utf8"),
    );
    expect(exported).toEqual({ format: "ephemera.character", version: 1, data: before.card });
    await importCards(page, [
      {
        name: `native.${format}`,
        mimeType: format === "png" ? "image/png" : "application/json",
        buffer: bytes,
      },
    ]);
  }
  const copies = (await (await page.request.get("/api/characters")).json()).characters.filter(
    (row: { name: string }) => row.name === name,
  );
  expect(copies).toHaveLength(3);
  for (const copy of copies)
    expect((await (await page.request.get(`/api/characters/${copy.id}`)).json()).card).toEqual(
      before.card,
    );
  await patchSettings(page.request, { characterId: id });
  await openChat(page, "mock-scripted");
  await scriptReplies(["She waits", "for the tide."]);
  await send(page, "Native harbour scene");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await replyActions(page).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page)).toContainText("She waits for the tide.");
});

/** The default blocks with `extra` just above the chat history. */
function blocksWith(...extra: PromptBlock[]): PromptBlock[] {
  const blocks = defaultPromptPreset().blocks;
  const at = blocks.findIndex((block) => block.kind === "chatHistory");
  return [...blocks.slice(0, at), ...extra, ...blocks.slice(at)];
}

/** The system message a request carried for the "Mood" block, as the server filled it. */
async function moodSent(marker: string): Promise<string | undefined> {
  const records = await upstreamRecords(marker);
  return records.at(-1)?.messages.find((message) => message.content.startsWith("Mood "))?.content;
}

test("macro variables live in the tab: the greeting, sent messages and Clear, never a preview", async ({
  page,
}) => {
  // Synthetic entities; the macros are native variable macros.
  const suffix = crypto.randomUUID().slice(0, 6);
  const character = `Lamplighter ${suffix}`;
  const persona = `Wren ${suffix}`;
  const preset = `Macro state ${suffix}`;
  await createCharacterViaApi(page.request, character, {
    firstMessage: "{{setvar::mood::calm}}The lamp is lit.",
  });
  await createPersonaViaApi(page.request, persona);
  await createPresetViaApi(page.request, "prompt", {
    name: preset,
    blocks: blocksWith({
      kind: "custom",
      id: crypto.randomUUID(),
      name: "Mood",
      role: "system",
      content: "Mood {{getvar::mood}}, seen {{getglobalvar::seen}}.",
      enabled: true,
      depth: null,
    }),
  });

  await openChat(page, "mock-scripted");
  await chooseCharacter(page, character);
  await openSession(page);
  await choose(page, "Persona", persona);
  await choose(page, "Prompt preset", preset);
  await closeSession(page);
  // The greeting shows filled; its variable is the chat's from now on.
  await expect(messages(page).first()).toHaveText(/The lamp is lit\./);
  await expect(messages(page).first()).not.toContainText("setvar");

  await scriptReplies(["First reply.", "Second reply.", "Third reply.", "Fourth reply."]);
  await send(page, `{{setglobalvar::seen::yes}}Hello {{user}} ${suffix}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(messages(page).nth(1)).toContainText(`Hello ${persona} ${suffix}`);
  expect(await moodSent(`Hello ${persona} ${suffix}`)).toBe("Mood calm, seen yes.");

  // A draft's preview fills its macros on a copy: the next send never sees them.
  const field = page.getByLabel("Message", { exact: true });
  const previewed = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat/preview"),
  );
  await field.fill("{{setvar::mood::stormy}}");
  await previewed;
  await field.fill("");
  await send(page, `Second ${suffix}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(await moodSent(`Second ${suffix}`)).toBe("Mood calm, seen yes.");

  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

  // Clear takes the chat's local and global variables, and closes the character.
  await clearChat(page);
  await send(page, `After clear ${suffix}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(await moodSent(`After clear ${suffix}`)).toBe("Mood , seen .");
  // The character's new chat brings back only its greeting's variable.
  await chooseCharacter(page, character, { confirm: true });
  await expect(messages(page).first()).toHaveText(/The lamp is lit\./);
  await send(page, `Greeted again ${suffix}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(await moodSent(`Greeted again ${suffix}`)).toBe("Mood calm, seen .");
});

for (const failingRead of ["sampler", "character"] as const) {
  test(`the greeting reads the chosen model's runtime and counts once, after Try again for a failed ${failingRead} load; requests send it as shown`, async ({
    page,
  }) => {
    // Synthetic entities; the macros are native runtime and variable macros.
    const suffix = crypto.randomUUID().slice(0, 6);
    const character = `Clockmaker ${suffix}`;
    const sampler = `Short replies ${suffix}`;
    await createCharacterViaApi(page.request, character, {
      firstMessage:
        "Hello{{incvar::n}} from {{model}}: {{maxContextTokens}}/{{maxResponseTokens}}/{{maxPrompt}}.",
    });
    await createPresetViaApi(page.request, "sampler", {
      name: sampler,
      values: {
        model: null,
        maxOutputTokens: 1_024,
        temperature: null,
        topP: null,
        frequencyPenalty: null,
        presencePenalty: null,
        seed: null,
        reasoning: "provider-default",
      },
    });

    await openChat(page, "mock-scripted");
    // A required entity does not load at first: the greeting is never partly filled.
    const failedRoute =
      failingRead === "sampler" ? "**/api/presets/sampler/*" : "**/api/characters/*";
    const unavailable = (route: Route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 503 }) : route.fallback();
    await page.route(failedRoute, unavailable);
    await openSession(page);
    await choose(page, "Sampler preset", sampler);
    await closeSession(page);
    await chooseCharacter(page, character);
    // Once its retries end, the chat says so, without any of the greeting's text.
    const failed = page.getByRole("status").filter({ hasText: "The greeting didn't load" });
    await expect(failed).toBeVisible({ timeout: 15_000 });
    await expect(messages(page)).toHaveCount(0);
    // Try again loads it and fills the greeting once.
    await page.unroute(failedRoute, unavailable);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    // The mock catalog's window for every model but mock-nowindow, less the preset's reply length.
    const greeting = "Hello1 from mock-scripted: 131072/1024/130048.";
    await expect(messages(page).first()).toContainText(greeting);
    await expect(failed).toHaveCount(0);
    await expect(messages(page)).toHaveCount(1);

    await scriptReplies(["First reply.", "Second reply."]);
    await send(page, `Count {{getvar::n}} ${suffix}`);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(messages(page).nth(1)).toContainText(`Count 1 ${suffix}`);
    await send(page, `Again {{getvar::n}} ${suffix}`);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(messages(page).nth(3)).toContainText(`Again 1 ${suffix}`);
    // Each request carries the greeting as it was shown, never its macros to fill again.
    for (const marker of [`Count 1 ${suffix}`, `Again 1 ${suffix}`]) {
      const sent = (await upstreamRecords(marker)).at(-1)?.messages ?? [];
      expect(sent.find((message) => message.role === "assistant")?.content).toContain(greeting);
    }
  });
}

test("native placement and persona-switch attribution reach the request", async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const persona = `Ash ${suffix}`;
  const preset = `Placement ${suffix}`;
  const nextPersona = `Wren ${suffix}`;
  await createPersonaViaApi(page.request, persona);
  await createPersonaViaApi(page.request, nextPersona);
  // As an imported preset carries it: the main prompt inside the chat, after the latest message.
  const blocks = defaultPromptPreset().blocks.map((block): PromptBlock => {
    if (block.kind !== "text" || block.id !== "main") return block;
    const placed = { ...block };
    placed.content = `Marker ${suffix}: write as {{char}}.`;
    placed.role = "user";
    placed.depth = 0;
    placed.order = 50;
    placed.forbidOverrides = true;
    return placed;
  });
  const id = await createPresetViaApi(page.request, "prompt", { name: preset, blocks });

  await page.goto(`/presets/prompt/${id}`);
  const main = page.getByRole("button", { name: /^Main prompt: User, after the latest message/ });
  await expect(main).toBeVisible();
  const saved = async () =>
    (await (await page.request.get(`/api/presets/prompt/${id}`)).json()) as {
      preset: { blocks: PromptBlock[] };
    };
  // Every imported placement survives the save.
  expect((await saved()).preset.blocks.find((block) => block.id === "main")).toMatchObject({
    role: "user",
    depth: 0,
    order: 50,
    forbidOverrides: true,
  });

  await openChat(page, "mock-scripted");
  await openSession(page);
  await choose(page, "Persona", persona);
  await choose(page, "Prompt preset", preset);
  await closeSession(page);
  await scriptReplies(["Placed.", "Placed again."]);
  await send(page, `Wire ${suffix}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const records = await upstreamRecords(`Marker ${suffix}`);
  expect(records).toHaveLength(1);
  const sent = records.at(-1)?.messages ?? [];
  expect(sent.at(-2)).toEqual({ role: "user", content: `Wire ${suffix}` });
  expect(sent.at(-1)).toEqual({ role: "user", content: `Marker ${suffix}: write as Assistant.` });
  await openSession(page);
  await choose(page, "Persona", nextPersona);
  await closeSession(page);
  await send(page, `New voice ${suffix}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  // Records are keyed by the final user-role message, still the depth-zero main block.
  const switchedRecords = await upstreamRecords(`Marker ${suffix}`);
  expect(switchedRecords).toHaveLength(2);
  const switched = switchedRecords.at(-1)?.messages ?? [];
  expect(switched).toContainEqual({ role: "user", content: `${persona}: Wire ${suffix}` });
  expect(switched.at(-2)).toEqual({ role: "user", content: `New voice ${suffix}` });
  expect(switched.at(-1)).toEqual({
    role: "user",
    content: `Marker ${suffix}: write as Assistant.`,
  });
  expect(switched.some((message) => "name" in message)).toBe(false);
});
