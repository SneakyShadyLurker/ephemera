import type { Page } from "@playwright/test";
import {
  defaultPromptPreset,
  defaultSamplerPreset,
  PRESET_LIMITS,
} from "../packages/core/src/index.ts";
import { uniqueName } from "./support/cards.ts";
import { createPresetViaApi, expectNoOverflow, seriousAxeViolations } from "./support/entities.ts";
import { expect, test } from "./support/test.ts";

/** A SillyTavern Chat Completion preset, synthetic, from the documented field names. */
function sillyTavernPreset(mainPrompt = "Write {{char}}'s next reply.") {
  return {
    temperature: 0.85,
    top_p: 0.95,
    top_k: 40,
    openai_max_context: 32_768,
    openai_max_tokens: 900,
    reasoning_effort: "max",
    stream_openai: true,
    personality_format: "[{{char}}'s personality: {{personality}}]",
    prompts: [
      {
        identifier: "main",
        name: "Main Prompt",
        system_prompt: true,
        role: "system",
        content: mainPrompt,
      },
      {
        identifier: "nsfw",
        name: "Auxiliary Prompt",
        system_prompt: true,
        role: "system",
        content: "Stay grounded.",
      },
      { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
      {
        identifier: "a1",
        name: "Stay in scene",
        system_prompt: false,
        role: "system",
        content: "Keep the storm present.",
        injection_position: 1,
        injection_depth: 4,
      },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "nsfw", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "a1", enabled: true },
        ],
      },
    ],
  };
}

const file = (name: string, content: unknown) => ({
  name,
  mimeType: "application/json",
  buffer: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)),
});

async function importFile(page: Page, name: string, content: unknown) {
  await page.locator('input[type="file"]').setInputFiles(file(name, content));
}

test("a SillyTavern preset imports as a prompt and a sampler preset, with a report", async ({
  page,
}) => {
  const name = uniqueName("Harbourlight");
  await page.goto("/presets");
  await importFile(page, `${name}.json`, sillyTavernPreset());
  const report = page.getByRole("status").filter({ hasText: `Imported ${name}` });
  await expect(report).toContainText("as a prompt preset and a sampler preset");
  await report.getByRole("button", { name: "Show details" }).click();
  await expect(report.getByRole("heading", { name: "Left out" })).toBeVisible();
  await expect(report).toContainText("Top K");
  await expect(report).toContainText("Context size: each model's own window is used instead.");
  await expect(report).toContainText("stream_openai");
  await expect(report).toContainText("The auxiliary prompt became the custom block");
  await expectNoOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);

  for (const list of ["Sampler presets", "Prompt presets"]) {
    const row = page
      .getByRole("region", { name: list })
      .getByRole("link", { name: new RegExp(name) });
    await expect(row).toContainText("Imported");
  }

  await page
    .getByRole("region", { name: "Prompt presets" })
    .getByRole("link", { name: new RegExp(name) })
    .click();
  await expect(page.getByText("Stay in scene", { exact: false }).first()).toBeVisible();
  const personality = page.locator('[data-block="charPersonality"]');
  await personality.locator("[aria-expanded]").click();
  await expect(personality.getByRole("textbox", { name: "Template" })).toHaveValue(
    "[{{char}}'s personality: {{content}}]",
  );
});

test("foreign placement and triggers survive native edits, with no retired controls", async ({
  page,
}) => {
  const name = uniqueName("Lanternfall");
  const source = sillyTavernPreset();
  const [main, ...rest] = source.prompts;
  await page.goto("/presets");
  await importFile(page, `${name}.json`, {
    ...source,
    names_behavior: 2,
    send_if_empty: "Go on.",
    squash_system_messages: true,
    continue_prefill: true,
    prompts: [
      {
        ...main,
        role: "user",
        injection_position: 1,
        injection_depth: 1,
        injection_order: 50,
        injection_trigger: ["normal", "swipe"],
        forbid_overrides: true,
      },
      ...rest,
    ],
  });
  await page
    .getByRole("region", { name: "Prompt presets" })
    .getByRole("link", { name: new RegExp(name) })
    .click();
  for (const label of ["Send if empty", "Speaker names", "Continue joins with"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Wrappers" })).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: /Join system messages|Continue from the reply itself/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Main prompt: User, 1 message from the end/ }).click();
  await expect(page.getByRole("switch", { name: /Keep it over the character's/ })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Order", exact: true })).toHaveValue("50");
  for (const [trigger, pressed] of [
    ["Send", true],
    ["Swipe", true],
    ["Continue", false],
  ] as const)
    await expect(page.getByRole("button", { name: trigger, exact: true, pressed })).toBeVisible();
  await page.getByRole("textbox", { name: "Continue", exact: true }).fill("Continue in the rain.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const id = page.url().split("/").at(-1);
  const { preset } = await (await page.request.get(`/api/presets/prompt/${id}`)).json();
  expect(preset).not.toHaveProperty("formats");
  expect(preset.actions.continue).toBe("Continue in the rain.");
  expect(preset.blocks.find((block: { id: string }) => block.id === "main")).toMatchObject({
    role: "user",
    depth: 1,
    order: 50,
    triggers: ["normal", "swipe"],
    forbidOverrides: true,
  });
});

test.describe("refused files", () => {
  for (const [label, content, reason] of [
    ["not JSON", "{not json", "it isn't valid JSON"],
    [
      "a character card",
      { spec: "chara_card_v2", data: { name: "Mara" } },
      "it isn't an Ephemera preset or a SillyTavern Chat Completion preset",
    ],
  ] as const) {
    test(`${label} is not imported, and says why`, async ({ page }) => {
      await page.goto("/presets");
      await importFile(page, "lore-notes.json", content);
      await expect(page.getByText(`lore-notes.json was not imported: ${reason}.`)).toBeVisible();
    });
  }
});

test("imported text stays inert", async ({ page }) => {
  const hostile =
    '<img src="/__beacon/import.png" onerror="document.title=1"> <script>document.title=2</script>';
  await page.goto("/presets");
  await importFile(page, "hostile <b>preset</b>.json", sillyTavernPreset(hostile));
  await expect(page.getByText("Imported hostile <b>preset</b>")).toBeVisible();
  const link = page
    .getByRole("region", { name: "Prompt presets" })
    .getByRole("link", { name: /hostile <b>preset<\/b>/ });
  await link.click();
  await expect(page.getByText(hostile).first()).toBeVisible();
  expect(await page.locator("main img, main script").count()).toBe(0);
  expect(await page.title()).not.toMatch(/^[12]$/);
});

for (const kind of ["prompt", "sampler"] as const) {
  test(`a native ${kind} preset exports independently and reimports under its own name`, async ({
    page,
  }) => {
    const name = uniqueName(`Native ${kind}`);
    const preset =
      kind === "prompt"
        ? {
            ...defaultPromptPreset(name),
            actions: { continue: "Continue gently.", writeForMe: "Write a short response." },
            authorsNote: { ...defaultPromptPreset().authorsNote, text: "Keep the fog thick." },
            blocks: defaultPromptPreset().blocks.map((block) =>
              block.kind === "source" ? { ...block, template: "[Context: {{content}}]" } : block,
            ),
          }
        : defaultSamplerPreset(name);
    const id = await createPresetViaApi(page.request, kind, preset);
    await page.goto(`/presets/${kind}/${id}`);
    await page.getByRole("button", { name: "More actions" }).click();
    const item = page.getByRole("menuitem", { name: "Export as JSON" });
    const href = (await item.getAttribute("href")) ?? "";
    const downloading = page.waitForEvent("download");
    await item.click();
    expect((await downloading).suggestedFilename()).toBe(`${name}.json`);
    expect(href).toContain(`/api/presets/${kind}/${id}/export`);
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    const exported = await response.json();
    expect(exported).toEqual({ format: `ephemera.${kind}-preset`, version: 1, data: preset });
    await page.goto("/presets");
    await importFile(page, "a-different-filename.json", exported);
    const report = page.getByRole("status").filter({ hasText: `Imported ${name}` });
    await expect(report).toContainText(`as a ${kind} preset`);
    await expect(report).not.toContainText("and a");
    const list = (await (await page.request.get(`/api/presets/${kind}`)).json()).presets;
    const copy = list.find(
      (row: { id: string; name: string }) => row.id !== id && row.name === name,
    );
    const { preset: actual } = await (
      await page.request.get(`/api/presets/${kind}/${copy.id}`)
    ).json();
    const {
      id: _id,
      revision: _revision,
      createdAt: _created,
      updatedAt: _updated,
      ...data
    } = actual;
    expect(data).toEqual(preset);
  });
}

test("source templates validate before autosave and survive reload, including lorebooks and examples", async ({
  page,
}) => {
  const id = await createPresetViaApi(
    page.request,
    "prompt",
    defaultPromptPreset(uniqueName("Templates")),
  );
  await page.goto(`/presets/prompt/${id}`);
  for (const source of ["scenario", "lorebookBefore", "dialogueExamples"]) {
    const row = page.locator(`[data-block="${source}"]`);
    await row.locator("[aria-expanded]").click();
    const field = row.getByRole("textbox", { name: "Template", exact: true });
    const before = (await (await page.request.get(`/api/presets/prompt/${id}`)).json()).preset
      .revision;
    await field.fill("Missing placeholder");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(row.getByText("Add {{content}} to keep this block's text.")).toBeVisible();
    await field.press("Tab");
    expect(
      (await (await page.request.get(`/api/presets/prompt/${id}`)).json()).preset.revision,
    ).toBe(before);
    await field.fill("[Scene: {{content}}]");
    await field.press("Tab");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/presets/prompt/${id}`)).json()).preset.blocks.find(
            (block: { id: string }) => block.id === source,
          ).template,
      )
      .toBe("[Scene: {{content}}]");
  }
  await page.reload();
  for (const source of ["scenario", "lorebookBefore", "dialogueExamples"])
    await expect(page.locator(`[data-block="${source}"]`)).toContainText("in a template");
});

for (const [label, content] of [
  [
    "unsupported native version",
    { format: "ephemera.prompt-preset", version: 2, data: defaultPromptPreset() },
  ],
  ["wrong native kind", { format: "ephemera.character", version: 1, data: { name: "Mara" } }],
  [
    "mixed native and foreign",
    { format: "ephemera.prompt-preset", version: 1, data: defaultPromptPreset(), prompts: [] },
  ],
] as const)
  test(`${label} refuses import without creating a preset`, async ({ page }) => {
    await page.goto("/presets");
    const before = (await (await page.request.get("/api/presets/prompt")).json()).presets.length;
    await importFile(page, "invalid.json", content);
    await expect(
      page.getByRole("status").filter({ hasText: "invalid.json was not imported" }),
    ).toBeVisible();
    expect((await (await page.request.get("/api/presets/prompt")).json()).presets).toHaveLength(
      before,
    );
  });

test("export failures stay inline and unsaved edits cannot be exported", async ({ page }) => {
  const id = await createPresetViaApi(
    page.request,
    "prompt",
    defaultPromptPreset(uniqueName("Export refusal")),
  );
  await page.goto(`/presets/prompt/${id}`);
  await page.route(`**/api/presets/prompt/${id}/export`, (route) =>
    route.fulfill({ status: 413, json: { error: "payload_too_large" } }),
  );
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Export as JSON" }).click();
  await expect(
    page.getByText(
      "Not exported: this saved item exceeds the file limits. Shorten its text, then try again.",
    ),
  ).toBeVisible();
  await page.route(`**/api/presets/prompt/${id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 409, json: { error: "conflict" } })
      : route.fallback(),
  );
  await page.getByRole("textbox", { name: "Continue", exact: true }).fill("Unsaved change.");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Export as JSON" }).click();
  await expect(page.getByText("Not exported: the latest edits are not saved yet.")).toBeVisible();
});

test("wider saved action text stays visible and can be reduced to public bounds", async ({
  page,
}) => {
  const id = await createPresetViaApi(
    page.request,
    "prompt",
    defaultPromptPreset(uniqueName("Legacy read")),
  );
  const wider = "x".repeat(PRESET_LIMITS.blockText + 1);
  await page.route(`**/api/presets/prompt/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.preset.actions.continue = wider;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/presets/prompt/${id}`);
  const action = page.getByRole("textbox", { name: "Continue", exact: true });
  await expect(action).toHaveValue(wider);
  await action.fill("Reduced instruction.");
  await action.press("Tab");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/presets/prompt/${id}`)).json()).preset.actions
          .continue,
    )
    .toBe("Reduced instruction.");
});
