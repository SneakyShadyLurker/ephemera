import { importCards, jsonCard, tile, uniqueName, v3 } from "./support/cards.ts";
import { chooseCharacter, chooseModel, clearChat, lastReply, send } from "./support/chat.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

// The tracer snapshots the DOM on every action; 5,000 rows would time it, not the app.
test.use({ trace: "off", screenshot: "only-on-failure" });

test("a book of 5,000 entries opens, finds, and is scanned within its bound", async ({ page }) => {
  // A 6 MB card is imported, fetched twice and scanned against a 130 KB message.
  // Generous: this machine runs other workloads; the test guards against hangs, not speed.
  test.setTimeout(90_000);
  const name = uniqueName("Vast lore");
  const key = (i: number, k: number) => `k${i}x${k}y${"q".repeat(10)}`;
  // A chain: each entry's text names the next entry's first keyword.
  const entries = Array.from({ length: 5_000 }, (_, i) => ({
    keys: Array.from({ length: 50 }, (_, k) => key(i, k)),
    content: `Entry ${i}. ${key(i + 1, 0)}`,
    comment: `Entry ${i}`,
    extensions: {},
    enabled: true,
    insertion_order: i,
    use_regex: false,
  }));
  await importCards(page, [
    jsonCard(
      "vast.json",
      v3({ name, character_book: { extensions: {}, recursive_scanning: true, entries } }),
    ),
  ]);
  await expect(page.getByRole("status").filter({ hasText: `Imported ${name}.` })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search characters" }).fill(name);
  await tile(page, name).click();
  await expect(page.locator("#s-lorebook")).toContainText("5,000 entries");
  const opened = Date.now();
  await page.getByRole("link", { name: "Open lorebook" }).click();
  // Attribute locators: matching text or roles across 5,000 rows would time the test, not the app.
  await expect(page.locator('[data-entry="4999"]')).toBeAttached({ timeout: 30_000 });
  // Find matches every word anywhere: entry 4998's text names k4999x0y..., so the full stop
  // keeps the query to entry 4999's own text.
  await page.getByPlaceholder("Find by title, keyword or text").fill("Entry 4999.");
  await expect(page.locator("[data-entry]")).toHaveCount(1);
  // A 6 MB card is fetched and 5,000 rows rendered.
  expect(Date.now() - opened).toBeLessThan(30_000);

  // Typing in an entry beside the full list keeps up: the list follows the book deferred.
  await page.getByPlaceholder("Find by title, keyword or text").fill("");
  await expect(page.locator('[data-entry="4999"]')).toBeAttached({ timeout: 30_000 });
  await page.locator('[data-entry="4999"] [data-row]').click();
  const text = page.getByLabel("Text", { exact: true });
  await expect(text).toHaveValue(/^Entry 4999\./);
  const typing = Date.now();
  await text.pressSequentially("The bells ring on. ", { delay: 0 });
  await expect(text).toHaveValue(/The bells ring on\. /);
  // 19 keystrokes; the bound only catches a list that re-renders under every key.
  expect(Date.now() - typing).toBeLessThan(10_000);

  // A long message makes the scan outgrow its bound: the rest is reported, not stalled on.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chat" }).click();
  await chooseModel(page, "mock-fast");
  await chooseCharacter(page, name);
  const started = Date.now();
  await send(page, `${"word ".repeat(26_000)}${canary("in")}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(Date.now() - started).toBeLessThan(15_000);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  const lore = page
    .getByRole("dialog", { name: "Prompt" })
    .getByRole("region", { name: "Lorebook" });
  await expect(lore).toContainText(/not scanned/);
  await page.keyboard.press("Escape");

  // A short message starts the chain: entries bring in entries until the bound, then the rest is reported.
  await clearChat(page);
  await chooseCharacter(page, name);
  const chained = Date.now();
  await send(page, `Start with ${key(0, 0)} ${canary("in")}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  expect(Date.now() - chained).toBeLessThan(15_000);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(lore).toContainText(/Entries' text was read [\d,]+ more times/);
  await expect(lore).toContainText(/[\d,]+ not scanned/);
});
