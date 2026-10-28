import { beacons, lastReply, messages, openChat, send } from "./support/chat.ts";
import {
  choose,
  closeSession,
  createPersonaViaApi,
  createPresetViaApi,
  openSession,
} from "./support/entities.ts";
import { canary, UPSTREAM_PORT } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

/*
 * Persona and preset text and the model's replies are untrusted like card
 * fields (PRINCIPLES.md 3): markup in names, descriptions, block text and
 * replies renders as text everywhere, requests nothing and runs nothing.
 */

const tag = crypto.randomUUID().slice(0, 6);
const HOSTILE_NAME = `<img src="http://127.0.0.1:${UPSTREAM_PORT}/__beacon/persona-${tag}.png" onerror="document.title='owned'">Mallory ${tag}`;
const HOSTILE_TEXT = [
  `<script>document.title = 'owned'</script>`,
  `[harbour](http://127.0.0.1:${UPSTREAM_PORT}/__beacon/link-${tag})`,
  `![map](/__beacon/relative-${tag}.png)`,
  `<style>body { display: none }</style>`,
].join("\n");

const BLOCKS = [
  { kind: "text", id: "main", enabled: true, content: HOSTILE_TEXT },
  { kind: "source", id: "lorebookBefore", enabled: true },
  { kind: "source", id: "personaDescription", enabled: true },
  { kind: "source", id: "charDescription", enabled: true },
  { kind: "source", id: "charPersonality", enabled: true },
  { kind: "source", id: "scenario", enabled: true },
  { kind: "source", id: "lorebookAfter", enabled: true },
  { kind: "source", id: "dialogueExamples", enabled: true },
  { kind: "chatHistory", id: "chatHistory" },
  { kind: "text", id: "postHistory", enabled: true, content: "" },
  {
    kind: "custom",
    id: crypto.randomUUID(),
    name: HOSTILE_NAME,
    role: "user",
    content: HOSTILE_TEXT,
    enabled: true,
    depth: 2,
  },
];

test("hostile persona and preset text stays inert in every place it shows", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const personaId = await createPersonaViaApi(page.request, HOSTILE_NAME, HOSTILE_TEXT);
  const promptId = await createPresetViaApi(page.request, "prompt", {
    name: HOSTILE_NAME,
    blocks: BLOCKS,
  });

  await page.goto("/personas");
  await expect(page.getByRole("list", { name: "Personas" })).toContainText(`Mallory ${tag}`);
  await expect(page.getByRole("list", { name: "Personas" })).toContainText("<img");

  await page.goto(`/personas/${personaId}`);
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(HOSTILE_NAME);
  await expect(page.getByLabel("Description")).toHaveValue(HOSTILE_TEXT);

  await page.goto("/presets");
  await expect(page.getByRole("region", { name: "Prompt presets" })).toContainText(
    `Mallory ${tag}`,
  );
  await page.goto(`/presets/prompt/${promptId}`);
  await expect(page.getByRole("button", { name: /^Main prompt:/ })).toContainText("<script>");
  await expect(page.getByRole("list", { name: "Blocks inside the chat" })).toContainText(
    `Mallory ${tag}`,
  );

  await openChat(page, "mock-fast");
  await openSession(page);
  await choose(page, "Persona", HOSTILE_NAME);
  await expect(page.getByRole("combobox", { name: "Persona" })).toContainText("<img");
  await closeSession(page);
  await send(page, canary("in"));
  await expect(messages(page).first()).toContainText(`Mallory ${tag}`);

  // Nothing ran, rendered as markup, or reached the network.
  expect(await page.title()).toBe("Ephemera");
  await expect(page.locator(`img[src*="__beacon"], script:not([src]), style`)).toHaveCount(0);
  expect(requested.filter((url) => url.includes("__beacon"))).toEqual([]);
  const sent = await beacons();
  expect(sent.filter((beacon) => beacon.includes(tag))).toEqual([]);
});

test("a hostile reply stays inert: no links, images, requests or script", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await openChat(page, "mock-hostile");
  await send(page, canary("in"));
  const reply = lastReply(page);
  await expect(reply).toHaveAttribute("data-status", "complete");

  // The reply's prose is the untrusted part.
  await expect(reply.locator("[data-prose]").locator("a, img, script, iframe, style")).toHaveCount(
    0,
  );
  await expect(reply).toContainText(
    `the harbour board (http://127.0.0.1:${UPSTREAM_PORT}/__beacon/link)`,
  );
  await expect(reply).toContainText("[image: a lantern]");
  await expect(reply).toContainText("[image: a map] (/__beacon/relative.png)");
  // Named entities decode as text; the parser's browser build would need an HTML sink.
  await expect(reply).toContainText("Tom & Jerry \u2014 fin");
  await expect(reply.locator("em")).toHaveText("She smiles.");
  expect(await page.title()).toBe("Ephemera");

  // Neither the page (same-origin paths included) nor the mock saw a hostile URL.
  expect(requested.filter((url) => url.includes("__beacon"))).toEqual([]);
  const sent = await beacons();
  expect(sent).toEqual([]);
});
