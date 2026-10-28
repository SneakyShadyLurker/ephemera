import type { Page } from "@playwright/test";
import { PRESET_LIMITS } from "../packages/core/src/preset/prompt.ts";
import { uniqueName } from "./support/cards.ts";
import {
  createPresetViaApi,
  expectNoOverflow,
  saved,
  seriousAxeViolations,
} from "./support/entities.ts";
import { expect, test, unsafe } from "./support/test.ts";

const DEFAULT_BLOCKS = [
  { kind: "text", id: "main", enabled: true, content: "Write the next reply." },
  { kind: "source", id: "lorebookBefore", enabled: true },
  { kind: "source", id: "personaDescription", enabled: true },
  { kind: "source", id: "charDescription", enabled: true },
  { kind: "source", id: "charPersonality", enabled: true },
  { kind: "source", id: "scenario", enabled: true },
  { kind: "source", id: "lorebookAfter", enabled: true },
  { kind: "source", id: "dialogueExamples", enabled: true },
  { kind: "chatHistory", id: "chatHistory" },
  { kind: "text", id: "postHistory", enabled: true, content: "" },
];

const MODEL_DEFAULTS = {
  model: null,
  maxOutputTokens: null,
  temperature: null,
  topP: null,
  frequencyPenalty: null,
  presencePenalty: null,
  seed: null,
  reasoning: "provider-default",
};

const blocks = (page: Page) => page.getByRole("list", { name: "Blocks in send order" });
const band = (page: Page) => page.getByRole("list", { name: "Blocks inside the chat" });
const rowNames = (page: Page) =>
  blocks(page)
    .locator(":scope > li")
    .evaluateAll((items) =>
      items.map(
        (item) =>
          item.getAttribute("data-block") ??
          item.querySelector("[data-block]")?.getAttribute("data-block"),
      ),
    );
/** The row named `id` and the one after it, wherever the preset's own blocks put them. */
const rowsFrom = async (page: Page, id: string) => {
  const names = await rowNames(page);
  const at = names.indexOf(id);
  return names.slice(at, at + 2);
};

test("a prompt preset's blocks are toggled, moved, added, placed in the chat, removed and restored", async ({
  page,
}) => {
  await page.goto("/presets");
  await page.getByRole("button", { name: "New prompt preset" }).click();
  await expect(page).toHaveURL(/\/presets\/prompt\/[0-9a-f-]{36}$/);
  // A new preset opens with its placeholder name selected, ready to be typed over.
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toBeFocused();
  const presetName = uniqueName("Slow burn");
  await page.keyboard.type(presetName);
  await expect(name).toHaveValue(presetName);

  await page.getByRole("switch", { name: "Send Scenario" }).click();
  await expect(page.getByRole("button", { name: /^Scenario: off/ })).toBeVisible();

  await page.getByRole("button", { name: /^Example dialogue:/ }).click();
  await page.getByRole("button", { name: "Move Example dialogue earlier" }).click();
  await expect
    .poll(() => rowsFrom(page, "dialogueExamples"))
    .toEqual(["dialogueExamples", "lorebookAfter"]);

  await page.getByRole("button", { name: "Add block" }).click();
  const blockName = page.locator('input[name="block-name"]');
  await blockName.fill("Stay in scene");
  await page.getByRole("button", { name: "Inside the chat" }).click();
  await expect(band(page)).toContainText("Stay in scene");
  await expect(page.getByRole("status").filter({ hasText: "is now inside the chat" })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Send Stay in scene one message later" }).click();
  await expect(
    band(page).getByRole("textbox", { name: "Messages from the end", exact: true }),
  ).toHaveValue("3");

  await page.getByRole("button", { name: "More for Stay in scene" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await expect(band(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(band(page)).toContainText("Stay in scene");
  await saved(page);

  await page.reload();
  await expect(page.getByRole("button", { name: /^Scenario: off/ })).toBeVisible();
  await expect(band(page)).toContainText("System, 3 messages from the end");
  await expect
    .poll(() => rowsFrom(page, "dialogueExamples"))
    .toEqual(["dialogueExamples", "lorebookAfter"]);
});

test("a New preset whose answer was lost is sent again under its id, New waits for it, and each kind keeps its own", async ({
  page,
}) => {
  type Kind = "prompt" | "sampler";
  const ids = async (kind: Kind) => {
    const response = await page.request.get(`/api/presets/${kind}`);
    expect(response.status()).toBe(200);
    return ((await response.json()) as { presets: { id: string }[] }).presets.map(
      (preset) => preset.id,
    );
  };
  // Each kind's first create is stored as sent while its answer never reaches the tab;
  // the prompt preset's second waits until released.
  const bodies: Record<Kind, { id: string; preset: Record<string, unknown> }[]> = {
    prompt: [],
    sampler: [],
  };
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/presets\/(prompt|sampler)$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const kind: Kind = new URL(request.url()).pathname.endsWith("/prompt") ? "prompt" : "sampler";
    const body = request.postDataJSON() as (typeof bodies)[Kind][number];
    bodies[kind].push(body);
    if (bodies[kind].length === 1) {
      await page.request.post(`/api/presets/${kind}`, { headers: unsafe(), data: body });
      return route.abort();
    }
    if (kind === "prompt") await held;
    return route.continue();
  });
  try {
    await page.goto("/presets");
    const before = { prompt: await ids("prompt"), sampler: await ids("sampler") };
    const notCreated = page.getByRole("alert").filter({ hasText: "Not created:" });
    await page.getByRole("button", { name: "New sampler preset" }).click();
    await expect(notCreated).toHaveCount(1);
    const newPrompt = page.getByRole("button", { name: "New prompt preset" });
    await newPrompt.click();
    await expect(notCreated).toHaveCount(2);

    await newPrompt.click();
    await expect(newPrompt).toBeDisabled();
    await newPrompt.click({ force: true });
    release();
    await expect(page).toHaveURL(new RegExp(`/presets/prompt/${bodies.prompt[0]?.id}$`));
    expect(bodies.prompt).toHaveLength(2);
    expect(bodies.prompt[1]).toEqual(bodies.prompt[0]);
    expect(bodies.prompt[0]?.preset).toHaveProperty("blocks");
    // The sampler preset's create was its own, under its own id.
    expect(bodies.sampler).toHaveLength(1);
    expect(bodies.sampler[0]?.id).not.toBe(bodies.prompt[0]?.id);
    expect(bodies.sampler[0]?.preset).toHaveProperty("values");
    expect(await ids("prompt")).toHaveLength(before.prompt.length + 1);
    expect(await ids("sampler")).toHaveLength(before.sampler.length + 1);
  } finally {
    release();
  }
});

test("the block list works by keyboard alone", async ({ page }) => {
  const id = await createPresetViaApi(page.request, "prompt", {
    name: uniqueName("Keys"),
    blocks: DEFAULT_BLOCKS,
  });
  await page.goto(`/presets/prompt/${id}`);
  const toggle = page.getByRole("switch", { name: "Send Main prompt" });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /^Main prompt:/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Move Main prompt later" })).toBeVisible();
  await page.getByRole("button", { name: "Move Main prompt later" }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await rowNames(page)).slice(0, 2))
    .toEqual(["lorebookBefore", "main"]);
  // The row stays open and the move keeps focus where the owner left it.
  await expect(page.getByRole("button", { name: "Move Main prompt later" })).toBeFocused();
});

test("editors are their own chunks, out of the first paint, loaded after it", async ({ page }) => {
  // The first paint needs only what the HTML entry names; the editor is not among it.
  const shell = await (await page.request.get("/presets")).text();
  expect(shell).not.toMatch(/presets\.prompt\._id-/);
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  const promptId = await createPresetViaApi(page.request, "prompt", {
    name: uniqueName("Chunk"),
    blocks: DEFAULT_BLOCKS,
  });
  await page.goto("/presets");
  await expect(page.getByRole("heading", { name: "Prompt presets" })).toBeVisible();
  const editor = (path: string) => /presets\.prompt\._id-.*\.js$/.test(path);
  // Loaded once after the first paint (app/preload.ts), so an expired session cannot strand it.
  await expect.poll(() => scripts.filter(editor)).toHaveLength(1);
  await page.goto(`/presets/prompt/${promptId}`);
  await expect(blocks(page)).toBeVisible();
});

for (const { name, width, height, scheme } of [
  { name: "desktop dark", width: 1440, height: 900, scheme: "dark" },
  { name: "tablet light", width: 820, height: 1180, scheme: "light" },
  { name: "phone light", width: 390, height: 844, scheme: "light" },
] as const) {
  test(`preset screens fit and pass axe: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const promptId = await createPresetViaApi(page.request, "prompt", {
      name: uniqueName("Layout"),
      blocks: [
        ...DEFAULT_BLOCKS,
        {
          kind: "custom",
          id: crypto.randomUUID(),
          name: "Stay in scene",
          role: "system",
          content: "Remember the room.",
          enabled: true,
          depth: 4,
        },
      ],
    });
    const samplerId = await createPresetViaApi(page.request, "sampler", {
      name: uniqueName("Layout"),
      values: { ...MODEL_DEFAULTS, temperature: 0.9, presencePenalty: -0.5 },
    });
    for (const path of [
      "/presets",
      `/presets/prompt/${promptId}`,
      `/presets/sampler/${samplerId}`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoOverflow(page);
      expect(await seriousAxeViolations(page), path).toEqual([]);
    }
  });
}

test("the formatting key draws each mark as the chat does, beside the form when wide", async ({
  page,
}) => {
  const id = await createPresetViaApi(page.request, "prompt", {
    name: uniqueName("Key"),
    blocks: DEFAULT_BLOCKS,
  });
  for (const { width, inForm } of [
    { width: 1440, inForm: false },
    { width: 820, inForm: true },
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/presets/prompt/${id}`);
    const marks = page
      .getByRole("region", { name: "Formatting" })
      .getByRole("list", { name: "Marks, as written and as the chat shows them" });
    await expect(marks.locator('[data-tone="rose"]')).toHaveText("rose");
    await expect(marks.locator('[data-voice="thought"]')).toHaveText("a thought");
    await expect(marks.getByText(":rose[rose]", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("form", { name: "Prompt preset" }).getByRole("region", { name: "Formatting" }),
    ).toHaveCount(inForm ? 1 : 0);
  }
});

test("reduced motion keeps switches and moves to fades, and brings a moved row into view at once", async ({
  page,
}) => {
  // Each moved row brought into view, with how the scroll moved.
  await page.addInitScript(() => {
    const scrolls: string[] = [];
    (window as unknown as { __scrolls: string[] }).__scrolls = scrolls;
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (
      this: Element,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      const block = this.getAttribute("data-block");
      if (block !== null && typeof options === "object") {
        scrolls.push(`${block} ${options.behavior}`);
      }
      return scrollIntoView.call(this, options);
    };
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const id = await createPresetViaApi(page.request, "prompt", {
    name: uniqueName("Still"),
    blocks: DEFAULT_BLOCKS,
  });
  await page.goto(`/presets/prompt/${id}`);
  const thumb = page
    .getByRole("switch", { name: "Send Main prompt" })
    .locator("[data-slot='switch-thumb']");
  const property = await thumb.evaluate((node) => getComputedStyle(node).transitionProperty);
  expect(property).not.toContain("translate");

  const scrolls = () =>
    page.evaluate(() => (window as unknown as { __scrolls: string[] }).__scrolls);
  await page.getByRole("button", { name: /^Main prompt:/ }).click();
  await page.getByRole("button", { name: "Move Main prompt later" }).click();
  await expect.poll(scrolls).toEqual(["main instant"]);
  // Read as each move starts: with motion back, the next one glides.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Move Main prompt earlier" }).click();
  await expect.poll(scrolls).toEqual(["main instant", "main smooth"]);
  await expect
    .poll(async () => (await rowNames(page)).slice(0, 2))
    .toEqual(["main", "lorebookBefore"]);
});

test("a failed background refetch keeps the editor and its unsaved edits", async ({ page }) => {
  await page.clock.install();
  const id = await createPresetViaApi(page.request, "sampler", {
    name: uniqueName("Offline"),
    values: MODEL_DEFAULTS,
  });
  await page.goto(`/presets/sampler/${id}`);
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toBeVisible();
  await page.route("**/api/presets/**", (route) => route.abort());
  await name.fill("Edited while offline");
  await expect(page.getByText("Not saved: can't reach Ephemera. Retrying").first()).toBeVisible();
  // Coming back to the tab refetches in the background; that fails too.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Past every retry of the failed refetch: three, a second apart and doubling.
  await page.clock.runFor(10_000);
  await expect(name).toHaveValue("Edited while offline");
  await expect(page.getByText("This preset could not be loaded.")).toHaveCount(0);
});

test("a copy that would pass the custom block limit is not offered", async ({ page }) => {
  const custom = Array.from({ length: PRESET_LIMITS.customBlocks }, (_, index) => ({
    kind: "custom",
    id: crypto.randomUUID(),
    name: `Block ${index + 1}`,
    role: "system",
    content: "",
    enabled: true,
    depth: null,
  }));
  const id = await createPresetViaApi(page.request, "prompt", {
    name: uniqueName("Full"),
    blocks: [...DEFAULT_BLOCKS.slice(0, 8), ...custom, ...DEFAULT_BLOCKS.slice(8)],
  });
  await page.goto(`/presets/prompt/${id}`);
  await expect(page.getByRole("button", { name: "Add block" })).toBeDisabled();
  await page.getByRole("button", { name: /^Block 1:/ }).click();
  await page.getByRole("button", { name: "More for Block 1" }).click();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
