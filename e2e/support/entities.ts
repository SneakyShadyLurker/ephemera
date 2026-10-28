import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { DEFAULT_NOTE_PROMPT } from "../../packages/core/src/preset/defaults.ts";
import {
  DEFAULT_PROMPT_ACTIONS,
  DEFAULT_PROMPT_REASONING,
} from "../../packages/core/src/preset/prompt.ts";
import type { Settings } from "../../packages/core/src/settings.ts";
import { appOrigin, unsafe } from "./test.ts";

/** Saves `patch` to the test user's settings, as Settings and Session do; `origin` names the app server. */
export async function patchSettings(
  request: APIRequestContext,
  patch: Partial<Settings>,
  origin = appOrigin(),
) {
  const response = await request.patch(`${origin}/api/settings`, {
    headers: { Origin: origin },
    data: patch,
  });
  expect(response.status()).toBe(200);
}

/** The settings the server holds for the client's user. */
export async function readSettings(request: APIRequestContext): Promise<Settings> {
  const response = await request.get("/api/settings");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { settings: Settings }).settings;
}

export async function createCharacterViaApi(
  request: APIRequestContext,
  name: string,
  /** Card fields besides the name, such as greetings. */
  fields: Record<string, unknown> = {},
) {
  const id = crypto.randomUUID();
  const response = await request.post("/api/characters", {
    headers: unsafe(),
    data: {
      id,
      fields: {
        name,
        nickname: "",
        description: "",
        personality: "",
        scenario: "",
        firstMessage: "",
        alternateGreetings: [],
        exampleDialogue: "",
        systemPrompt: "",
        postHistoryInstructions: "",
        creatorNotes: "",
        tags: [],
        creator: "",
        characterVersion: "",
        ...fields,
      },
    },
  });
  expect(response.status()).toBe(201);
  return id;
}

/** Stores `png` as the character's portrait, as its sheet uploads one; returns the new version. */
export async function setPortraitViaApi(
  request: APIRequestContext,
  id: string,
  png: Buffer,
): Promise<number> {
  const response = await request.put(`/api/characters/${id}/portrait`, {
    headers: { Origin: appOrigin() },
    multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: png } },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { portrait: number }).portrait;
}

export async function createPersonaViaApi(
  request: APIRequestContext,
  name: string,
  description = "",
) {
  const id = crypto.randomUUID();
  const response = await request.post("/api/personas", {
    headers: unsafe(),
    data: { id, fields: { name, description } },
  });
  expect(response.status()).toBe(201);
  return id;
}

/** The default action instructions, which a prompt preset carries unless a test gives its own. */
export const DEFAULT_ACTIONS = DEFAULT_PROMPT_ACTIONS;

export async function createPresetViaApi(
  request: APIRequestContext,
  kind: "prompt" | "sampler",
  preset: object,
) {
  const id = crypto.randomUUID();
  const response = await request.post(`/api/presets/${kind}`, {
    headers: unsafe(),
    data: {
      id,
      preset:
        kind === "prompt"
          ? { actions: DEFAULT_ACTIONS, reasoning: DEFAULT_PROMPT_REASONING, ...preset }
          : preset,
    },
  });
  expect(response.status()).toBe(201);
  return id;
}

/** The default preset's Author's Note as sent while the user is "You (no persona)". */
export const DEFAULT_NOTE_SENT = DEFAULT_NOTE_PROMPT.replaceAll("{{user}}", "User");

/** Patches a stored prompt preset, as its editor saves: against its current revision. */
export async function patchPromptPresetViaApi(
  request: APIRequestContext,
  id: string,
  patch: object,
) {
  const current = await request.get(`/api/presets/prompt/${id}`);
  expect(current.status()).toBe(200);
  const { revision } = ((await current.json()) as { preset: { revision: number } }).preset;
  const response = await request.patch(`/api/presets/prompt/${id}`, {
    headers: unsafe(),
    data: { ...patch, revision },
  });
  expect(response.status()).toBe(200);
}

/** Opens Session (a docked panel stays open; a sheet is closed again by `closeSession`). */
export async function openSession(page: Page) {
  const toggle = page.getByRole("button", { name: "Session", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
}

export async function closeSession(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Session" });
  if (await sheet.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
}

/**
 * Chooses `option` in the Base UI select labelled `label` within `scope`;
 * the trigger then shows `shown`.
 */
export async function choose(scope: Page | Locator, label: string, option: string, shown = option) {
  const page = "page" in scope ? scope.page() : scope;
  const combobox = scope.getByRole("combobox", { name: label, exact: true });
  await combobox.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(combobox).toContainText(shown);
  // A closing list still holds its options; the next choice must not find this one's.
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** The form factors a layout is checked at, each in the scheme it is most often seen in. */
export const FORM_FACTORS = [
  { name: "phone", width: 390, height: 844, scheme: "dark" },
  { name: "tablet", width: 820, height: 1180, scheme: "dark" },
  { name: "desktop", width: 1440, height: 900, scheme: "light" },
] as const;

/** An autosave landed. Saves wait out a 600 ms pause and queue behind each other, so a loaded machine gets time. */
export const saved = (page: Page) =>
  expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

/**
 * Moves focus with Tab (Shift+Tab with `backward`) until `target` has it, at
 * most `limit` times: proof it is in the tab order.
 */
export async function tabTo(
  page: Page,
  target: Locator,
  { backward = false, limit = 120 }: { backward?: boolean; limit?: number } = {},
) {
  for (let pressed = 0; pressed < limit; pressed++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(backward ? "Shift+Tab" : "Tab");
  }
  await expect(target).toBeFocused();
}

/** Waits for CSS transitions to settle, then reports serious or critical axe violations. */
export async function seriousAxeViolations(page: Page): Promise<string[]> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.getAnimations().filter((a) => a instanceof CSSTransition).length,
      ),
    )
    .toBe(0);
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`,
    );
}

/** The page is no wider than the viewport. */
export async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A lorebook entry with the card spec's required fields; the rest from `overrides`. */
export function loreEntry(overrides: Record<string, unknown>) {
  return {
    keys: [],
    content: "",
    enabled: true,
    insertionOrder: 100,
    useRegex: false,
    ...overrides,
  };
}

/** A library lorebook under a client-chosen id, as New lorebook makes one; its entries from `book`. */
export async function createLorebookViaApi(
  request: APIRequestContext,
  name: string,
  book: { entries: object[]; [key: string]: unknown } = { entries: [] },
) {
  const id = crypto.randomUUID();
  const response = await request.post("/api/lorebooks", {
    headers: unsafe(),
    data: { id, name, book: { name, ...book } },
  });
  expect(response.status()).toBe(201);
  return id;
}

/** Links a library lorebook to a character, as the pickers do. */
export async function linkLorebookViaApi(
  request: APIRequestContext,
  lorebookId: string,
  characterId: string,
) {
  const response = await request.put(`/api/lorebooks/${lorebookId}/characters/${characterId}`, {
    headers: unsafe(),
  });
  expect(response.status()).toBe(204);
}

/**
 * An event under a client-chosen id, as New event makes one: 100% per
 * reply, never quiet, for every card, on, unless `fields` says otherwise.
 */
export async function createEventViaApi(
  request: APIRequestContext,
  text: string,
  fields: Record<string, unknown> = {},
) {
  const id = crypto.randomUUID();
  const response = await request.post("/api/events", {
    headers: unsafe(),
    data: { id, text, chance: 100, cooldown: 0, enabled: true, scope: { kind: "all" }, ...fields },
  });
  expect(response.status()).toBe(201);
  return id;
}

/** Saves a character's whole lorebook, as the lorebook screen does: against its current revision. */
export async function setLorebookViaApi(
  request: APIRequestContext,
  characterId: string,
  book: { entries: object[]; [key: string]: unknown },
) {
  const current = await request.get(`/api/characters/${characterId}`);
  expect(current.status()).toBe(200);
  const { revision } = (await current.json()) as { revision: number };
  const response = await request.patch(`/api/characters/${characterId}`, {
    headers: unsafe(),
    data: { lorebook: { ...book }, revision },
  });
  expect(response.status()).toBe(200);
}

/** Replaces a library book's entries, as another tab's edit would. */
export async function setLibraryEntriesViaApi(
  request: APIRequestContext,
  lorebookId: string,
  entries: object[],
) {
  const stored = await (await request.get(`/api/lorebooks/${lorebookId}`)).json();
  const response = await request.patch(`/api/lorebooks/${lorebookId}`, {
    headers: unsafe(),
    data: { revision: stored.revision, book: { ...stored.book, entries } },
  });
  expect(response.status()).toBe(200);
}
