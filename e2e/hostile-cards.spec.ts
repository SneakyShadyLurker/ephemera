import type { Page } from "@playwright/test";
import {
  bombCardPng,
  cardChunk,
  imageMetadata,
  jpegWithMetadata,
  pngClaiming,
  pngWithText,
  svg,
} from "../apps/server/test/image-fixtures.ts";
import { blankCard, CARD_LIMITS } from "../packages/core/src/index.ts";
import { importCards, jsonCard, pngCard, tile, uniqueName, v3 } from "./support/cards.ts";
import { beacons, chooseCharacter, chooseModel, lastReply, send } from "./support/chat.ts";
import { loreEntry } from "./support/entities.ts";
import { canary, UPSTREAM_PORT } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

const BEACON = `http://127.0.0.1:${UPSTREAM_PORT}/__beacon`;

/** Markup, script and remote URLs a hostile card can carry in any text field. */
const payload = (field: string) =>
  [
    `<script>document.title='owned-${field}'</script>`,
    `<img src="${BEACON}/img-${field}.png" onerror="document.title='owned'">`,
    `![x](${BEACON}/md-${field}.png) [link](${BEACON}/link-${field})`,
    `<style>body{background:url(${BEACON}/css-${field})}</style>`,
    "javascript:alert(1) {{char}} &lt;b&gt;",
  ].join(" ");

/** Catastrophic backtracking patterns, for keys, and the text they backtrack on. */
const HOSTILE_PATTERNS = ["/(a+)+$/", "/(x+x+)+y/"];
const BACKTRACKED = `${"a".repeat(5_000)}x${"x".repeat(5_000)}`;

test("a hostile card stays inert text everywhere and fetches nothing", async ({ page }) => {
  const marker = uniqueName("Hostile");
  const name = `${marker} <img src="${BEACON}/name.png"><script>alert(1)</script>`;
  const fields = [
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
  ];
  // Short identity fields have a 200-character limit; their payload fits it.
  const short = `<img src="${BEACON}/short.png" onerror="alert(1)"><script>alert(1)</script>`;
  const card = v3({
    name,
    ...Object.fromEntries(fields.map((field) => [field, payload(field)])),
    nickname: short,
    creator: short,
    character_version: short,
    alternate_greetings: [payload("alt-1"), payload("alt-2")],
    tags: [`<b>tag</b>`, `${BEACON}/tag`],
    source: [`${BEACON}/source`],
    assets: [{ type: "icon", uri: `${BEACON}/asset.png`, name: "main", ext: "png" }],
    extensions: { html: payload("ext") },
    character_book: {
      extensions: {},
      entries: [
        {
          keys: ["x"],
          content: payload("lore"),
          extensions: {},
          enabled: true,
          insertion_order: 1,
          use_regex: false,
        },
      ],
    },
  });
  const before = await beacons();
  await importCards(page, [await pngCard("hostile.png", card)]);

  // Gallery: the name is text, not markup.
  await page.getByRole("searchbox", { name: "Search characters" }).fill(marker);
  await expect(tile(page, marker)).toContainText("<script>alert(1)</script>");

  // Sheet: every field holds its text exactly.
  await tile(page, marker).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(payload("description"));
  await expect(page.getByLabel("First message", { exact: true })).toHaveValue(payload("first_mes"));

  // Chat: the header, the speaker line and Session show the name as text.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chat" }).click();
  await chooseModel(page, "mock-fast");
  await chooseCharacter(page, name);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("<script>alert(1)</script>");
  await expect(lastReply(page).locator("[data-speaker]")).toContainText(
    "<script>alert(1)</script>",
  );

  const dom = await page.evaluate(() => ({
    title: document.title,
    scripts: [...document.scripts].filter((s) => !s.src).length,
    images: [...document.images].map((img) => img.getAttribute("src") ?? ""),
    styles: document.querySelectorAll("body style").length,
  }));
  expect(dom.title).toBe("Ephemera");
  expect(dom.scripts).toBe(0);
  expect(dom.styles).toBe(0);
  expect(dom.images.every((src) => src.startsWith("/api/characters/"))).toBe(true);
  await page.waitForTimeout(300);
  expect(await beacons()).toEqual(before);
});

test("malformed, oversized and disguised card files are refused with a reason", async ({
  page,
}) => {
  const oversized = JSON.stringify(
    v3({ name: "Big", description: "d".repeat(CARD_LIMITS.cardJsonBytes) }),
  );
  await importCards(page, [
    {
      name: "broken.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngWithText({ ccv3: "!!not base64!!" })),
    },
    { name: "garbage.json", mimeType: "application/json", buffer: Buffer.from("{nope") },
    { name: "big.json", mimeType: "application/json", buffer: Buffer.from(oversized) },
    { name: "huge.png", mimeType: "image/png", buffer: Buffer.from(pngClaiming(60_000, 60_000)) },
    { name: "vector.png", mimeType: "image/png", buffer: Buffer.from(svg) },
    jsonCard("long.json", v3({ name: "Long", scenario: "s".repeat(CARD_LIMITS.textLength + 1) })),
  ]);
  await page.getByRole("button", { name: "Show details" }).click();
  const details = page.getByRole("status").getByRole("list");
  await expect(details).toContainText("broken.png: it is not a character card.");
  await expect(details).toContainText("garbage.json: it is not a character card.");
  await expect(details).toContainText("big.json: it is larger than Ephemera accepts.");
  await expect(details).toContainText("huge.png: it is larger than Ephemera accepts.");
  await expect(details).toContainText("vector.png: it is not a character card.");
  await expect(details).toContainText("long.json: a field is over the size limit (scenario).");
});

test("a card whose image inflates to 300 MB imports without inflating it", async ({ page }) => {
  const name = uniqueName("Bomb");
  const started = Date.now();
  await importCards(page, [
    {
      name: "bomb.png",
      mimeType: "image/png",
      buffer: bombCardPng({ ccv3: cardChunk(v3({ name })) }),
    },
  ]);
  await expect(page.getByRole("status").filter({ hasText: `Imported ${name}.` })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("portraits are re-encoded without metadata and refuse SVG", async ({ page }) => {
  const name = uniqueName("Portrait");
  await importCards(page, [jsonCard("p.json", v3({ name }))]);
  await tile(page, name).click();
  const picker = page.locator('#s-identity input[type="file"]');

  await picker.setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: await jpegWithMetadata(),
  });
  const image = page.locator("#s-identity img");
  await expect(image).toHaveJSProperty("complete", true);
  const src = (await image.getAttribute("src")) ?? "";
  const bytes = Buffer.from(await (await page.request.get(src)).body());
  expect(bytes.includes("metadata-canary")).toBe(false);
  const meta = await imageMetadata(bytes);
  expect([meta.format, meta.exif, meta.xmp, meta.width, meta.height]).toEqual([
    "png",
    undefined,
    undefined,
    20,
    40,
  ]);

  await picker.setInputFiles({
    name: "vector.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(svg),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Use a PNG, JPEG or WebP image." }),
  ).toBeVisible();
  // The earlier portrait stays.
  await expect(image).toHaveAttribute("src", src);
});

test("a hostile lorebook stays inert in the sheet, the lorebook screen and the inspector", async ({
  page,
}) => {
  const marker = uniqueName("Hostile lore");
  const card = v3({
    name: marker,
    character_book: {
      extensions: {},
      entries: [
        {
          keys: [`<img src="${BEACON}/key.png">`, ...HOSTILE_PATTERNS, "lantern"],
          content: payload("lore"),
          comment: `<script>alert(1)</script> ${BEACON}/title`,
          extensions: {},
          enabled: true,
          insertion_order: 1,
          use_regex: false,
        },
      ],
    },
  });
  const before = await beacons();
  await importCards(page, [jsonCard("hostile-lore.json", card)]);
  await page.getByRole("searchbox", { name: "Search characters" }).fill(marker);
  await tile(page, marker).click();
  await page.getByRole("link", { name: "Open lorebook" }).click();
  await expect(page.getByRole("list", { name: "Entries in prompt order" })).toContainText(
    "<script>alert(1)</script>",
  );
  await page
    .getByRole("list", { name: "Entries in prompt order" })
    .getByRole("button")
    .first()
    .click();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue(payload("lore"));

  // Catastrophic patterns against a long run of the letters they backtrack on.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chat" }).click();
  await chooseModel(page, "mock-fast");
  await chooseCharacter(page, marker);
  const started = Date.now();
  await send(page, `${BACKTRACKED} lantern ${canary("in")}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(Date.now() - started).toBeLessThan(10_000);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const lore = page
    .getByRole("dialog", { name: "Prompt" })
    .getByRole("region", { name: "Lorebook" });
  await expect(lore).toContainText("<script>alert(1)</script>");

  const dom = await page.evaluate(() => ({
    title: document.title,
    scripts: [...document.scripts].filter((s) => !s.src).length,
    images: [...document.images].map((img) => img.getAttribute("src") ?? ""),
  }));
  expect(dom.title).toBe("Ephemera");
  expect(dom.scripts).toBe(0);
  expect(dom.images.every((src) => src.startsWith("/api/characters/"))).toBe(true);
  await page.waitForTimeout(300);
  expect(await beacons()).toEqual(before);
});

/**
 * Imports a book that chains entries, sends `message` to its character and
 * returns the inspector's lorebook section: the reply must complete within
 * the request's lifetime, however much the book asks to be read.
 */
async function chainedBook(page: Page, label: string, entries: object[], message: string) {
  const name = uniqueName(label);
  const book = { recursiveScanning: true, entries };
  await importCards(page, [
    jsonCard("chained.json", {
      format: "ephemera.character",
      version: 1,
      data: { ...blankCard(name), lorebook: book },
    }),
  ]);
  await expect(page.getByRole("status").filter({ hasText: `Imported ${name}.` })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chat" }).click();
  await chooseModel(page, "mock-fast");
  await chooseCharacter(page, name);
  const started = Date.now();
  // The canary first: a pattern anchored at the end must meet the message's own last word.
  await send(page, `${canary("in")} ${message}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(Date.now() - started).toBeLessThan(10_000);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  return page.getByRole("dialog", { name: "Prompt" }).getByRole("region", { name: "Lorebook" });
}

test.describe("recursion bombs stop within the work bound and report the rest", () => {
  test("entries whose text names every entry, itself included", async ({ page }) => {
    const names = Array.from({ length: 300 }, (_, i) => `mesh${i}q`);
    const text = `${"a".repeat(5_000)} ${names.join(" ")}`;
    const lore = await chainedBook(
      page,
      "Mesh",
      names.map((name, i) =>
        loreEntry({
          comment: `Mesh ${i}`,
          keys: [...HOSTILE_PATTERNS, `/(a+)+\\s(\\w+\\s)*${name}\\b/`],
          content: text,
        }),
      ),
      `Tell me of ${"a".repeat(50)} mesh0q.`,
    );
    await expect(lore).toContainText("Entries' text was read 1 more time");
    await expect(lore).toContainText(/[\d,]+ not scanned/);
  });

  test("a chain of 5,000 entries, each naming the next", async ({ page }) => {
    const lore = await chainedBook(
      page,
      "Chain",
      Array.from({ length: 5_000 }, (_, i) =>
        loreEntry({
          comment: `Link ${i}`,
          keys: [`link${i}q`, `/link${i}q\\b/`],
          content: `link${i + 1}q`,
        }),
      ),
      "Start at link0q.",
    );
    await expect(lore).toContainText(/Entries' text was read [\d,]+ more times/);
    await expect(lore).toContainText(/[\d,]+ not scanned/);
  });

  test("a chain whose secondary keys are hostile patterns", async ({ page }) => {
    const lore = await chainedBook(
      page,
      "Secondary",
      Array.from({ length: 1_000 }, (_, i) =>
        loreEntry({
          comment: `Link ${i}`,
          keys: [`link${i}q`],
          secondaryKeys: HOSTILE_PATTERNS,
          selective: true,
          // NOT ANY: every hostile pattern is tried against every scanned text.
          settings: { logic: "notAny" },
          content: `Then link${i + 1}q.`,
        }),
      ),
      `${BACKTRACKED} link0q`,
    );
    await expect(lore).toContainText(/Entries' text was read [\d,]+ more times/);
    await expect(lore).toContainText(/[\d,]+ not scanned/);
  });
});
