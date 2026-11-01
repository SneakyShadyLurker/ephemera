import {
  type CustomPaletteInput,
  PALETTE_ROLES,
  paletteSchemeSchema,
} from "../packages/core/src/palettes.ts";
import { defaultPromptPreset } from "../packages/core/src/preset/prompt.ts";
import { plainPromptPreset } from "../packages/core/test-fixtures/preset.ts";
import { uniqueName } from "./support/cards.ts";
import {
  browserStorage,
  chooseCharacter,
  chooseModel,
  lastReply,
  openChat,
  send,
  turns,
  upstreamRecords,
} from "./support/chat.ts";
import {
  choose,
  closeSession,
  createCharacterViaApi,
  createPersonaViaApi,
  createPresetViaApi,
  expectNoOverflow,
  loreEntry,
  openSession,
  patchSettings,
  seriousAxeViolations,
  setLorebookViaApi,
} from "./support/entities.ts";
import { boundHeaders, CANARY_MARKER, canary, UPSTREAM_PORT } from "./support/env.ts";
import { openSettings, settingsTab } from "./support/settings.ts";
import { expect, test, unsafe } from "./support/test.ts";

const canvas = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

/** Each Settings switch's short name (all in Chat), and its hint as its accessible description. */
const SWITCH_HELP = {
  "Prefer the character's system prompt":
    "Its own system prompt replaces the preset's main prompt.",
  "Prefer the character's post-history instructions":
    "Its own post-history instructions replace the preset's.",
  "Show reasoning open": "A reply's reasoning starts open instead of folded.",
  "Time hidden reasoning": "When a model keeps its reasoning to itself, say how long it thought.",
} as const;

/** A Settings switch found by its short name, once it is described by its help text. */
async function settingSwitch(
  page: import("@playwright/test").Page,
  name: keyof typeof SWITCH_HELP,
) {
  const control = page.getByRole("switch", { name, exact: true });
  await expect(control).toHaveAccessibleDescription(SWITCH_HELP[name]);
  return control;
}

/** Tokyo Night, the default palette: its canvas by day and by night. */
const LIGHT = "rgb(225, 226, 231)";
const DARK = "rgb(22, 22, 30)";

test("the theme follows the system unless overridden", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  expect(await canvas(page)).toBe(LIGHT);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => canvas(page)).toBe(DARK);

  await page.getByRole("button", { name: "Light" }).click();
  await expect.poll(() => canvas(page)).toBe(LIGHT);
  await expect(page.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Match system" }).click();
  await expect.poll(() => canvas(page)).toBe(DARK);
});

test("route and theme changes run as typed view transitions", async ({ page }) => {
  await page.addInitScript(() => {
    const record = window as unknown as { __transitions: string[] };
    record.__transitions = [];
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((
      update?: ViewTransitionUpdateCallback | StartViewTransitionOptions,
    ) => {
      const types = typeof update === "object" ? [...(update.types ?? [])] : [];
      record.__transitions.push(types.join(",") || "untyped");
      return start(update);
    }) as typeof document.startViewTransition;
  });
  await page.goto("/");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  // Only transitions caused by the actions below count, not the first load.
  await page.evaluate(() => {
    (window as unknown as { __transitions: string[] }).__transitions = [];
  });
  await page.getByRole("link", { name: "Presets" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Presets" })).toBeVisible();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const transitions = await page.evaluate(
    () => (window as unknown as { __transitions: string[] }).__transitions,
  );
  expect(transitions).toEqual(["route", "theme"]);
});

test("the saved theme is painted onto the app shell, before any script runs", async ({
  page,
  user,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  await page
    .getByRole("group", { name: "Theme" })
    .last()
    .getByRole("button", { name: "Dark" })
    .click();
  await expect(page.getByText("Saved on this server")).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get("/")).text()).includes('data-theme="dark"'))
    .toBe(true);

  // Scripts off: whatever the page shows now came with the HTML.
  const context = await page
    .context()
    .browser()
    ?.newContext({
      javaScriptEnabled: false,
      extraHTTPHeaders: boundHeaders(user),
      colorScheme: "light",
    });
  const bare = await context?.newPage();
  await bare?.goto(page.url());
  expect(await bare?.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await context?.close();

  await page.reload();
  expect(await canvas(page)).toBe(DARK);
  await page
    .getByRole("group", { name: "Theme" })
    .last()
    .getByRole("button", { name: "Match system" })
    .click();
  await expect
    .poll(async () => (await (await page.request.get("/")).text()).includes("data-theme"))
    .toBe(false);
});

test("a palette recolours the app in either scheme and is painted onto the app shell", async ({
  page,
}) => {
  const NORD_LIGHT = "rgb(229, 233, 240)";
  const NORD_DARK = "rgb(46, 52, 64)";
  const shellPalette = async () =>
    (await (await page.request.get("/")).text()).includes("data-palette");
  const palettes = () => page.getByRole("radiogroup", { name: "Palette", exact: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  await expect(palettes().getByRole("radio", { name: "Tokyo Night" })).toBeChecked();

  await palettes().getByRole("radio", { name: "Nord" }).click();
  await expect.poll(() => canvas(page)).toBe(NORD_LIGHT);
  await expect.poll(shellPalette).toBe(true);
  // The theme still picks the scheme within the palette.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => canvas(page)).toBe(NORD_DARK);

  await page.reload();
  expect(await canvas(page)).toBe(NORD_DARK);
  await expect(palettes().getByRole("radio", { name: "Nord" })).toBeChecked();

  await palettes().getByRole("radio", { name: "Tokyo Night" }).click();
  await expect.poll(() => canvas(page)).toBe(DARK);
  await expect.poll(shellPalette).toBe(false);
});

test("each palette's swatch shows its day scheme beside its night scheme, whatever the window's", async ({
  page,
}) => {
  const tiles = page.getByRole("radiogroup", { name: "Palette", exact: true }).locator("label");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/settings");
    await expect(tiles).toHaveCount(6);
    const halves = await tiles.evaluateAll((labels) =>
      labels.map((label) => {
        const [day, night] = [...(label.querySelector('[aria-hidden="true"]')?.children ?? [])];
        const lightness = (half: Element | undefined) => {
          if (half === undefined) return Number.NaN;
          const probe = document.createElement("span");
          probe.style.color = `oklch(from ${getComputedStyle(half).backgroundColor} l 0 0)`;
          document.body.append(probe);
          const value = Number.parseFloat(getComputedStyle(probe).color.replace(/^oklch\(/, ""));
          probe.remove();
          return value;
        };
        return { name: label.textContent, day: lightness(day), night: lightness(night) };
      }),
    );
    for (const { name, day, night } of halves) {
      expect(day, `${name} in a ${scheme} window`).toBeGreaterThan(night + 0.3);
    }
  }
});

/**
 * Fails the root loader's settings read and its one retry, so the tab starts
 * on the fallback settings, then holds every later read until released and
 * answers it with the settings the server held before the page opened.
 */
async function holdSettingsLoad(page: import("@playwright/test").Page) {
  const before = await page.request.get("/api/settings");
  const held = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let reads = 0;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads += 1;
    if (reads <= 2) return route.abort();
    held.resolve();
    await released.promise;
    // A read the tab cancelled for a newer one can no longer be answered.
    await route.fulfill({ response: before }).catch(() => undefined);
  });
  return { held: held.promise, release: () => released.resolve() };
}

test("a tab that started on the fallback settings takes the saved theme and palette once they load", async ({
  page,
}) => {
  await patchSettings(page.request, { theme: "dark", palette: "nord" });
  const load = await holdSettingsLoad(page);
  const html = page.locator("html");
  const theme = page.getByRole("group", { name: "Theme" }).last();
  const palettes = page.getByRole("radiogroup", { name: "Palette", exact: true });
  try {
    await page.goto("/settings");
    await load.held;
    await expect(html).not.toHaveAttribute("data-theme");
    await expect(theme.getByRole("button", { name: "Match system" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(palettes.getByRole("radio", { name: "Tokyo Night" })).toBeChecked();
    // Marks this document, so the recovery below is shown without a reload.
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });

    load.release();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveAttribute("data-palette", "nord");
    await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(palettes.getByRole("radio", { name: "Nord" })).toBeChecked();
    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument),
    ).toBe(true);
  } finally {
    load.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("a theme and palette chosen before the saved settings load stay once they do", async ({
  page,
}) => {
  // Reasoning open shows when the saved settings have reached the screen (in Chat, kept mounted).
  await patchSettings(page.request, { theme: "dark", palette: "nord", reasoningOpen: true });
  const load = await holdSettingsLoad(page);
  const html = page.locator("html");
  const theme = page.getByRole("group", { name: "Theme" }).last();
  const palettes = page.getByRole("radiogroup", { name: "Palette", exact: true });
  const reasoning = page.getByRole("switch", {
    name: "Show reasoning open",
    exact: true,
    includeHidden: true,
  });
  try {
    await page.goto("/settings");
    await load.held;
    await expect(reasoning).not.toBeChecked();
    await theme.getByRole("button", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await palettes.getByRole("radio", { name: "Gruvbox" }).click();
    await expect(html).toHaveAttribute("data-palette", "gruvbox");

    // The read answers with the settings from before these choices.
    load.release();
    await expect(reasoning).toBeChecked();
    await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(palettes.getByRole("radio", { name: "Gruvbox" })).toBeChecked();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(html).toHaveAttribute("data-palette", "gruvbox");
  } finally {
    load.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

/** The editor's hex field for a colour, by its label. */
const hexField = (page: import("@playwright/test").Page, label: string) =>
  page.getByRole("textbox", { name: `${label}, hex`, exact: true });

/** A full custom palette for the API: every role one colour, the text another. */
function plainPalette(name: string): CustomPaletteInput {
  const scheme = (ground: string, ink: string) =>
    paletteSchemeSchema.parse(
      Object.fromEntries(PALETTE_ROLES.map((role) => [role, role === "ink" ? ink : ground])),
    );
  const light = scheme("#eeeeee", "#111111");
  const dark = scheme("#111111", "#eeeeee");
  return {
    name,
    base: "lamplight",
    light,
    dark,
    origin: { light, dark },
    handSet: { light: [], dark: [] },
  };
}

test("a custom palette starts from a built-in, warns, saves, paints before scripts and goes back to its base", async ({
  page,
  user,
}) => {
  const palettes = () => page.getByRole("radiogroup", { name: "Palette", exact: true });
  const own = () => page.getByRole("radiogroup", { name: "Your palettes" });
  const shell = async () => (await page.request.get("/")).text();
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  // The preload has the Markdown renderer in hand, so the editor's sample
  // scene opens without a Suspense reveal, a view transition that would
  // swallow the input typed meanwhile (app/preload.ts).
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Your palettes/ }).click();
  await page.getByRole("button", { name: "New palette" }).click();
  await page.getByRole("menuitem", { name: "Nord" }).click();
  const editor = page.getByRole("region", { name: "New palette" });
  await expect(editor).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Nord");
  // The whole app shows the draft at once.
  await expect.poll(() => canvas(page)).toBe("rgb(229, 233, 240)");

  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Harbour");
  // Editing Night shows the app by night while the editor is open.
  await page
    .getByRole("group", { name: "Editing scheme" })
    .getByRole("button", { name: "Night" })
    .click();
  await expect.poll(() => canvas(page)).toBe("rgb(46, 52, 64)");
  await hexField(page, "Background").fill("#3a2f28");
  await expect.poll(() => canvas(page)).toBe("rgb(58, 47, 40)");
  // Unreadable text is named, and saves anyway.
  await hexField(page, "Text").fill("#4a4a4a");
  const textWarning = editor.getByText(/^Hard to read on .+, aim for 7:1\.$/);
  await expect(textWarning).toBeVisible();
  await expect(editor.getByRole("status")).toContainText(
    /^By night, \d+ colours may be hard to read: Text,/,
  );
  await hexField(page, "Text").fill("#fbf6ef");
  await expect(textWarning).toHaveCount(0);

  await editor.getByRole("button", { name: "Save palette" }).click();
  await expect(editor).toBeHidden();
  await expect(own().getByRole("radio", { name: "Harbour" })).toBeChecked();
  // An arrow key on the Edit button stays with the button, never choosing another palette.
  await page.getByRole("button", { name: "Edit Harbour" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(own().getByRole("radio", { name: "Harbour" })).toBeChecked();
  // The saved theme is back, and the new palette is chosen in it.
  await expect.poll(() => canvas(page)).toBe("rgb(229, 233, 240)");
  await expect.poll(async () => (await shell()).includes("/api/palettes.css")).toBe(true);

  // Scripts off, by night: the shell's stylesheet alone paints the saved palette.
  const context = await page
    .context()
    .browser()
    ?.newContext({
      javaScriptEnabled: false,
      extraHTTPHeaders: boundHeaders(user),
      colorScheme: "dark",
    });
  const bare = await context?.newPage();
  await bare?.goto(page.url());
  expect(await bare?.evaluate(() => document.documentElement.dataset.palette)).toBe("custom-1");
  await expect
    .poll(() => bare?.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
    .toBe("rgb(58, 47, 40)");
  await context?.close();

  // Deleting the chosen palette returns the app to the built-in it started from.
  await page.getByRole("button", { name: "Edit Harbour" }).click();
  await page
    .getByRole("region", { name: "Edit Harbour" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText("The app goes back to Nord.");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(palettes().getByRole("radio", { name: "Nord" })).toBeChecked();
  await expect(own().getByRole("radio", { name: "Harbour" })).toHaveCount(0);
  await expect.poll(async () => (await shell()).includes("/api/palettes.css")).toBe(false);

  await palettes().getByRole("radio", { name: "Tokyo Night" }).click();
  await expect.poll(() => canvas(page)).toBe(LIGHT);
});

test("a colour set by hand stays when its key colour changes, and Cancel puts the app back", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  // The preload has the Markdown renderer in hand, so the editor's sample
  // scene opens without a Suspense reveal, a view transition that would
  // swallow the input typed meanwhile (app/preload.ts).
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Your palettes/ }).click();
  await page.getByRole("button", { name: "New palette" }).click();
  await page.getByRole("menuitem", { name: "Lamplight" }).click();
  const editor = page.getByRole("region", { name: "New palette" });
  await editor.getByRole("button", { name: /^All colours/ }).click();
  // The sample scene reveals its Markdown through a view transition; typing waits for it.
  await expect(
    editor.getByRole("figure", { name: "Sample scene" }).getByRole("emphasis"),
  ).toBeVisible();

  await hexField(page, "Actions").fill("#6b4a2e");
  await expect(editor.getByText("Set by you", { exact: true })).toBeVisible();
  const secondary = await hexField(page, "Secondary text").inputValue();
  await hexField(page, "Text").fill("#1f3b4d");
  // Secondary text follows the new Text; the hand-set Actions does not.
  await expect(hexField(page, "Secondary text")).not.toHaveValue(secondary);
  await expect(hexField(page, "Actions")).toHaveValue("#6b4a2e");
  await editor.getByRole("button", { name: "Follow Text again" }).click();
  await expect(hexField(page, "Actions")).not.toHaveValue("#6b4a2e");
  await expect(editor.getByText("Set by you", { exact: true })).toHaveCount(0);

  await hexField(page, "Background").fill("#d8e4d0");
  await expect.poll(() => canvas(page)).toBe("rgb(216, 228, 208)");
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => canvas(page)).toBe(LIGHT);
  expect(await (await page.request.get("/api/palettes")).json()).toEqual({ palettes: [] });
});

test("in a shallow window the New palette menu fits it and reaches its first and last palettes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 250 });
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Your palettes/ }).click();
  const trigger = page.getByRole("button", { name: "New palette" });
  const editor = page.getByRole("region", { name: "New palette" });
  // The first palette and the last, each opened from a menu that stays inside the window.
  for (const palette of ["Lamplight", "Tokyo Night"]) {
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toBeInViewport();
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Start from" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? Infinity)).toBeLessThanOrEqual(250);
    await menu.getByRole("menuitem", { name: palette }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(palette);
    await editor.getByRole("button", { name: "Cancel" }).click();
    await expect(editor).toBeHidden();
  }
});

/** A scroll a script started: the element brought into view, and how it moved. */
type Scroll = { id: string; text: string; behavior: string | null };

/** Records each `scrollIntoView` from the next navigation on. */
async function recordScrolls(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const scrolls: Scroll[] = [];
    (window as unknown as { __scrolls: Scroll[] }).__scrolls = scrolls;
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (
      this: Element,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      scrolls.push({
        id: this.id,
        text: (this.textContent ?? "").trim().slice(0, 40),
        behavior: typeof options === "object" ? (options.behavior ?? null) : null,
      });
      return scrollIntoView.call(this, options);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __scrolls: Scroll[] }).__scrolls);
}

test("the palette editor's scrolls to its heading and to a named colour move at once under reduced motion", async ({
  page,
}) => {
  const scrolls = await recordScrolls(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Your palettes/ }).click();
  await page.getByRole("button", { name: "New palette" }).click();
  await page.getByRole("menuitem", { name: "Lamplight" }).click();
  const editor = page.getByRole("region", { name: "New palette" });
  await expect(editor).toBeVisible();
  const toHeading = async () => [
    ...new Set(
      (await scrolls())
        .filter((scroll) => scroll.text === "New palette")
        .map((scroll) => scroll.behavior),
    ),
  ];
  await expect.poll(toHeading).toEqual(["instant"]);

  // The summary's way to a colour lands on its field: at once, then smoothly once motion is back.
  await hexField(page, "Text").fill("#bbbbbb");
  const reveal = editor.getByRole("status").getByRole("button", { name: "Text", exact: true });
  const swatch = editor.locator('input[type="color"][aria-label="Text"]');
  const toField = async () =>
    (await scrolls())
      .filter((scroll) => scroll.id.startsWith("palette-"))
      .map((scroll) => scroll.behavior);
  await reveal.click();
  await expect(swatch).toBeFocused();
  await expect.poll(toField).toEqual(["instant"]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await reveal.click();
  await expect.poll(toField).toEqual(["instant", "smooth"]);
  await expect(swatch).toBeFocused();

  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => canvas(page)).toBe(LIGHT);
});

test("three custom palettes fill the row, and no new one is offered", async ({ page }) => {
  for (const [slot, name] of [
    [1, "Ash"],
    [2, "Brine"],
    [3, "Cinder"],
  ] as const) {
    const response = await page.request.post(`/api/palettes/${slot}`, {
      headers: unsafe(),
      data: plainPalette(name),
    });
    expect(response.status()).toBe(200);
  }
  await page.goto("/settings");
  const trigger = page.getByRole("button", { name: /^Your palettes/ });
  await expect(trigger).toHaveAccessibleDescription(
    "Ash, Brine, Cinder. All three slots are used.",
  );
  await trigger.click();
  await expect(
    page.getByRole("radiogroup", { name: "Palette", exact: true }).getByRole("radio"),
  ).toHaveCount(6);
  await expect(
    page.getByRole("radiogroup", { name: "Your palettes" }).getByRole("radio"),
  ).toHaveCount(3);
  await expect(page.getByRole("button", { name: "New palette" })).toHaveCount(0);
});

test("after a reload the app comes back with its selection and an empty chat", async ({ page }) => {
  const character = uniqueName("Restore");
  const persona = uniqueName("Returning");
  const sampler = uniqueName("Kept sampler");
  const prompt = uniqueName("Kept prompt");
  const rover = uniqueName("Rover");
  await createCharacterViaApi(page.request, character);
  await createCharacterViaApi(page.request, rover);
  await createPersonaViaApi(page.request, persona);
  await createPresetViaApi(page.request, "sampler", {
    name: sampler,
    values: {
      model: null,
      maxOutputTokens: null,
      temperature: 0.8,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      reasoning: "provider-default",
    },
  });
  const promptPreset = await (await page.request.get("/api/presets/prompt")).json();
  await createPresetViaApi(page.request, "prompt", {
    name: prompt,
    blocks: promptPreset.presets[0].blocks,
  });

  await page.goto("/");
  await chooseModel(page, "mock-slow");
  await chooseCharacter(page, character);
  await openSession(page);
  await choose(page, "Persona", persona);
  await choose(page, "Sampler preset", sampler);
  await choose(page, "Prompt preset", prompt);
  await closeSession(page);

  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toContainText("Reply:");
  await page.getByLabel("Message", { exact: true }).fill(canary("draft"));
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();

  await expect(turns(page)).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(character);
  await openSession(page);
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText("mock-slow");
  await expect(page.getByRole("combobox", { name: "Character" })).toContainText(character);
  await expect(page.getByRole("combobox", { name: "Persona" })).toContainText(persona);
  await expect(page.getByRole("combobox", { name: "Sampler preset" })).toContainText(sampler);
  await expect(page.getByRole("combobox", { name: "Prompt preset" })).toContainText(prompt);
  // The five pickers share one trigger: a portrait beside a name does not make it taller.
  const heights = new Set<number | undefined>();
  for (const name of ["Character", "Persona", "Sampler preset", "Model", "Prompt preset"]) {
    const box = await page.getByRole("combobox", { name, exact: true }).boundingBox();
    heights.add(box?.height);
  }
  expect([...heights]).toHaveLength(1);
  // A list keeps its distance from the window's edges, whichever way it opens.
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  // The popup around the listbox scrolls and holds the edge; the listbox is its whole content.
  const popup = page.getByRole("listbox").locator("xpath=..");
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  const list = await popup.boundingBox();
  const viewport = page.viewportSize();
  expect(list?.y).toBeGreaterThanOrEqual(11.5);
  expect((list?.y ?? 0) + (list?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0) - 11.5);
  await page.getByRole("option", { name: "mock-slow", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  // A character without a portrait shows its initial in the leaf's place, and every name in
  // the list, "No character" included, starts at the same x.
  await page.getByRole("combobox", { name: "Character", exact: true }).click();
  const row = page.getByRole("option", { name: character, exact: true });
  await expect(row.locator('[aria-hidden="true"]').first()).toHaveText(character[0] ?? "");
  const nameX = async (option: string, name: string) =>
    (
      await page
        .getByRole("option", { name: option, exact: true })
        .getByText(name, { exact: true })
        .boundingBox()
    )?.x;
  const noneX = (await nameX("No character", "No character")) ?? Number.NaN;
  const characterX = (await nameX(character, character)) ?? Number.NaN;
  expect(Math.abs(characterX - noneX)).toBeLessThan(1);
  // Typing a name finds it past another of the same initial: the leaf's initial is not part of
  // what typing matches. "R" moves on from the chosen Restore to Rover; "Re" must come back,
  // which it could not if the label read "RRestore".
  await page.keyboard.type("Re");
  await expect(row).toHaveAttribute("data-highlighted");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await closeSession(page);

  // The selection lives on the server only: nothing of it, or of the chat, is in the browser.
  const storage = await browserStorage(page);
  expect(storage).toMatchObject({
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    cookies: "",
    cacheStorage: [],
    serviceWorkers: 0,
    windowName: "",
  });
  const serialized = JSON.stringify(storage);
  for (const needle of [CANARY_MARKER, character, persona, "mock-slow"]) {
    expect(serialized).not.toContain(needle);
  }
});

test("the settings screen sets the default persona and the model", async ({ page }) => {
  const persona = uniqueName("Default");
  await createPersonaViaApi(page.request, persona);
  await openSettings(page, "chat");
  await choose(page, "Default persona", persona);
  await choose(page, "Reply model", "mock-fast");
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Default persona" })).toContainText(persona);
  await expect(page.getByRole("combobox", { name: "Reply model", exact: true })).toHaveText(
    "mock-fast",
  );
  // The list draws each persona as the Session panel does: its leaf, every name at one x.
  await page.getByRole("combobox", { name: "Default persona" }).click();
  const option = page.getByRole("option", { name: persona, exact: true });
  await expect(option.locator('[aria-hidden="true"]').first()).toHaveText("D");
  const nameX = async (name: string) =>
    (await page.getByRole("option", { name, exact: true }).getByText(name).boundingBox())?.x;
  expect(
    Math.abs(((await nameX(persona)) ?? 0) - ((await nameX("No default persona")) ?? Number.NaN)),
  ).toBeLessThan(1);
  await page.keyboard.press("Escape");
  await choose(page, "Default persona", "No default persona");
});

test("another tab's saved choices never reach an open tab", async ({ page, context }) => {
  const mine = uniqueName("Mine");
  const theirs = uniqueName("Theirs");
  await createCharacterViaApi(page.request, mine);
  await createCharacterViaApi(page.request, theirs);
  await page.goto("/");
  await chooseModel(page, "mock-fast");
  await chooseCharacter(page, mine);

  const other = await context.newPage();
  await other.goto("/");
  await chooseModel(other, "mock-slow");
  await chooseCharacter(other, theirs);
  await other.close();
  // The owner comes back to this tab; a background tab gets no view transitions.
  await page.bringToFront();

  // A save from this tab (the theme) must not pull the other tab's row into it.
  await page.getByRole("button", { name: "Light" }).click();
  await page.getByRole("button", { name: "Match system" }).click();
  await expect(page.getByRole("button", { name: "Match system" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(mine);
  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await openSession(page);
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText("mock-fast");
  await closeSession(page);
});

test("a change that could not be saved stays listed until it is", async ({ page }) => {
  await page.clock.install();
  await openSettings(page, "chat");
  let blocked = true;
  await page.route("**/api/settings", (route) =>
    blocked && route.request().method() === "PATCH" ? route.abort() : route.fallback(),
  );
  await choose(page, "Reply model", "mock-long");
  const alert = page.getByRole("alert").filter({ hasText: "Not saved" });
  // Retried first, then reported.
  await expect(alert).toBeVisible({ timeout: 20_000 });
  // Leave all settings-screen observers, advance beyond mutation GC, then return.
  await page.getByRole("link", { name: "Characters", exact: true }).first().click();
  await page.clock.fastForward(301_000);
  // Settings opens on Appearance; the alert stands above every category.
  await page.getByRole("link", { name: "Settings", exact: true }).first().click();
  await expect(settingsTab(page, "Appearance")).toHaveAttribute("aria-selected", "true");
  await expect(alert).toBeVisible();
  blocked = false;
  // A later save of another field does not hide the unsaved model.
  const theme = page.getByRole("group", { name: "Theme" }).last();
  await theme.getByRole("button", { name: "Dark" }).click();
  await theme.getByRole("button", { name: "Match system" }).click();
  await expect(alert).toBeVisible();
  // The alert goes once the retry is sent; a reload before it lands would abort it.
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings") &&
      response.request().method() === "PATCH" &&
      response.ok() &&
      response.request().postDataJSON()?.model === "mock-long",
  );
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toHaveCount(0);
  await saved;
  await page.reload();
  await settingsTab(page, "Chat").click();
  await expect(page.getByRole("combobox", { name: "Reply model", exact: true })).toHaveText(
    "mock-long",
  );
});

test("a model without a known context window blocks sending until a window is set", async ({
  page,
}) => {
  await openChat(page, "mock-nowindow");
  const notice = page.getByRole("status").filter({ hasText: "Context window unknown" });
  await expect(notice).toContainText("mock-nowindow has no known context window");
  await page.getByLabel("Message", { exact: true }).fill(canary("in"));
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  // The link carries the model: Context opens on its window field, empty and focused.
  await notice.getByRole("link", { name: "Set a context window" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const field = page.getByRole("textbox", {
    name: "Context window for mock-nowindow",
    exact: true,
  });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await expect(field).toHaveAccessibleDescription(
    "Use the window your provider documents for this model.",
  );
  await expect(field).toBeInViewport();
  await expect(settingsTab(page, "Model setup")).toHaveAttribute("aria-selected", "true");
  // Shown, the model leaves the address; the category stays.
  await expect(page).toHaveURL(/\/settings\?section=setup$/);
  await field.fill("16384");
  await field.press("Tab");
  await expect(field).toHaveValue("16,384");

  // Kept on the server: a reload keeps it, and sending works.
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Context window for mock-nowindow", exact: true }),
  ).toHaveValue("16,384");
  await page.getByRole("link", { name: "Chat", exact: true }).first().click();
  await expect(notice).toHaveCount(0);
  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Prompt" })).toContainText(
    "Context window, set by you",
  );
  await page.keyboard.press("Escape");

  // Removing it blocks sending again.
  await page.getByRole("link", { name: "Settings", exact: true }).first().click();
  await settingsTab(page, "Model setup").click();
  await page.getByRole("button", { name: "Reset Context window for mock-nowindow" }).click();
  await expect(page.getByText("Not set: replies can't be sent")).toBeVisible();

  // Set opens an empty field and saves nothing until a window is committed.
  await page.getByRole("button", { name: "Set Context window for mock-nowindow" }).click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await expect.poll(async () => (await savedSettings(page)).contextWindows).toEqual({});
  await page.getByRole("button", { name: "Cancel Context window for mock-nowindow" }).click();
  await expect(page.getByText("Not set: replies can't be sent")).toBeVisible();
});

test("a model the provider does not list can be typed, and its window note leads to Context", async ({
  page,
}) => {
  const typed = "vendor/typed-model-7";
  await openSettings(page, "chat");
  const model = page.getByRole("combobox", { name: "Reply model", exact: true });
  await model.click();
  const find = page.getByRole("combobox", { name: "Find a model", exact: true });
  await expect(find).toBeFocused();
  // Padding is not part of the ID; nothing matches, so the typed row is the highlighted answer.
  await find.fill(`  ${typed} `);
  const use = page.getByRole("option", { name: `Use "${typed}"`, exact: true });
  await expect(use).toHaveAccessibleDescription("Not on the provider's list");
  await expect(use).toHaveAttribute("data-highlighted", "");
  await find.press("Enter");
  await expect(model).toHaveText(typed);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect.poll(async () => (await savedSettings(page)).model).toBe(typed);

  // Kept: a reload shows it, with the note that it has no window yet.
  await page.reload();
  await expect(model).toHaveText(typed);
  const note = page.getByRole("link", { name: `Set a context window for ${typed}`, exact: true });
  await expect(note).toBeVisible();
  await note.click();
  const field = page.getByRole("textbox", { name: `Context window for ${typed}`, exact: true });
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport();
  await field.fill("32768");
  await field.press("Tab");
  await expect(field).toHaveValue("32,768");
  await expect(note).toHaveCount(0);
  await expect
    .poll(async () => (await savedSettings(page)).contextWindows)
    .toEqual({ [typed]: 32_768 });

  // An ID past the model rule's length is refused in words, not offered.
  await settingsTab(page, "Chat").click();
  await model.click();
  await find.fill("x".repeat(201));
  await expect(page.getByText("Model IDs are at most 200 characters.")).toBeVisible();
  await expect(page.getByRole("option", { name: /^Use "/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(model).toBeFocused();
  await expect(model).toHaveText(typed);
});

test("finding a model narrows the list, and Enter picks the highlighted row", async ({ page }) => {
  await openSettings(page, "chat");
  const model = page.getByRole("combobox", { name: "Reply model", exact: true });
  await model.click();
  const find = page.getByRole("combobox", { name: "Find a model", exact: true });
  // Any part of the ID, in any case.
  await find.fill("LOW");
  // The matches, then the query as typed, which no listed ID equals.
  await expect(page.getByRole("option")).toHaveCount(3);
  await expect(page.getByRole("option").nth(0)).toHaveAccessibleName("mock-lowonly");
  await expect(page.getByRole("option").nth(1)).toHaveAccessibleName("mock-slow");
  await expect(page.getByRole("option").nth(2)).toHaveAccessibleName('Use "LOW"');
  const first = page.getByRole("option", { name: "mock-lowonly", exact: true });
  await expect(first).toHaveAttribute("data-highlighted", "");
  await expect(first).toHaveAccessibleDescription("Context window 131,072 tokens");
  await find.press("ArrowDown");
  await expect(page.getByRole("option", { name: "mock-slow", exact: true })).toHaveAttribute(
    "data-highlighted",
    "",
  );
  await find.press("ArrowUp");
  await find.press("Enter");
  await expect(model).toHaveText("mock-lowonly");

  // Opening again starts from the whole list.
  await model.click();
  await expect(find).toHaveValue("");
  await expect(page.getByRole("option", { name: "mock-fast", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(model).toHaveText("mock-lowonly");
});

test("a long model list shows the first 200 matches and asks for more letters", async ({
  page,
}) => {
  const models = Array.from({ length: 2_000 }, (_, index) => ({
    id: `vendor-${String(index).padStart(4, "0")}/model`,
    contextWindow: 200_000,
    outputLimit: null,
    reasoning: null,
    images: null,
  }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { models } }));
  await openSettings(page, "chat");
  await page.getByRole("combobox", { name: "Reply model", exact: true }).click();
  await expect(page.getByText("Showing 200 of 2,000. Keep typing to narrow.")).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(200);
  const find = page.getByRole("combobox", { name: "Find a model", exact: true });
  await find.fill("vendor-19");
  // 100 matches and the typed row.
  await expect(page.getByRole("option")).toHaveCount(101);
  await expect(page.getByText(/Keep typing to narrow/)).toHaveCount(0);
  // An exact listed ID is not offered again as typed.
  await find.fill("vendor-1999/model");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toHaveAccessibleName("vendor-1999/model");
});

test("a model list that didn't load says so, retries, and still takes a typed ID", async ({
  page,
}) => {
  // Each failed load is retried before it is reported.
  test.setTimeout(90_000);
  let failing = true;
  let asked = 0;
  await page.route("**/api/models", (route) => {
    asked += 1;
    return failing ? route.fulfill({ status: 503, body: "" }) : route.fallback();
  });
  await openSettings(page, "chat");
  const model = page.getByRole("combobox", { name: "Reply model", exact: true });
  // Never disabled for want of a list.
  await expect(model).toBeEnabled();
  await model.click();
  await expect(page.getByText("The model list didn't load.", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const find = page.getByRole("combobox", { name: "Find a model", exact: true });
  await find.fill("mock-fast");
  const use = page.getByRole("option", { name: 'Use "mock-fast"', exact: true });
  await expect(use).toHaveAccessibleDescription("Typed model ID");
  await use.click();
  await expect(model).toHaveText("mock-fast");

  // Choosing refetches the list, which fails again; Try again asks once more.
  // The popup's own Try again: Context's note says the same words while the
  // popup may still be loading through the query's retries.
  await model.click();
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeVisible({ timeout: 20_000 });
  const before = asked;
  await tryAgain.click();
  await expect.poll(() => asked).toBeGreaterThan(before);
  // Once the provider answers, Try again or a background refetch, whichever
  // comes first, brings the list in.
  failing = false;
  await expect(async () => {
    if (await tryAgain.isVisible()) await tryAgain.click({ timeout: 2_000 });
    await expect(page.getByRole("option", { name: "mock-slow", exact: true })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText("The model list didn't load.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "mock-slow", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a chat model the catalog does not list can still get a context window", async ({ page }) => {
  await patchSettings(page.request, { model: "mock-unlisted" });
  await openSettings(page, "setup");
  await expect(
    page.getByRole("button", { name: "Set Context window for mock-unlisted" }),
  ).toBeVisible();
});

/** The settings as the server holds them. */
const savedSettings = async (page: import("@playwright/test").Page) =>
  (await (await page.request.get("/api/settings")).json()).settings as {
    model: string | null;
    contextLimits: Record<string, number>;
    contextWindows: Record<string, number>;
  };

test("the context limit caps a model's window, clamps to its maximum and is kept", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  await openSettings(page, "setup");
  const field = page.getByRole("textbox", { name: "Context limit for mock-fast", exact: true });
  const reset = page.getByRole("button", { name: "Reset Context limit for mock-fast" });
  await expect(field).toHaveValue("131,072");
  await expect(page.getByText("Up to 131,072 tokens, the model's own window.")).toBeVisible();
  await expect(reset).toHaveCount(0);

  // Above the model's window it clamps to it.
  await field.fill("200000");
  await field.press("Tab");
  await expect(field).toHaveValue("131,072");

  await field.fill("16384");
  await field.press("Tab");
  await expect(field).toHaveValue("16,384");
  await expect(reset).toBeVisible();
  const saved = { "mock-fast": 16_384 };
  await expect.poll(async () => (await savedSettings(page)).contextLimits).toEqual(saved);
  await page.reload();
  await expect(field).toHaveValue("16,384");

  await page.getByRole("link", { name: "Chat", exact: true }).first().click();
  await openSession(page);
  await expect(
    page.getByText("Context 16,384 of 131,072 tokens, limited in Settings."),
  ).toBeVisible();
  await closeSession(page);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Prompt" })).toContainText(
    "Context window, limited by you to 16,384 of 131,072",
  );
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Settings", exact: true }).first().click();
  await settingsTab(page, "Model setup").click();
  await reset.click();
  await expect(field).toHaveValue("131,072");
  await expect(reset).toHaveCount(0);
  await page.getByRole("link", { name: "Chat", exact: true }).first().click();
  await openSession(page);
  await expect(page.getByText("Context window 131,072 tokens.")).toBeVisible();
  await closeSession(page);
});

test("a window above the default limit is fitted to the default, and says so", async ({ page }) => {
  await openChat(page, "mock-wide");
  await openSession(page);
  await expect(
    page.getByText("Context 131,072 of 262,144 tokens, the default limit; Settings can change it."),
  ).toBeVisible();
  await closeSession(page);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Prompt" })).toContainText(
    "Context window, limited by default to 131,072 of 262,144; Settings can change it",
  );
  await page.keyboard.press("Escape");
});

test("a model added for a context limit stays listed while Settings is open", async ({ page }) => {
  await openChat(page, "mock-fast");
  await openSettings(page, "setup");
  const field = page.getByRole("textbox", {
    name: "Context limit for mock-lowonly",
    exact: true,
  });
  await expect(field).toHaveCount(0);
  await page.getByRole("combobox", { name: "Add a model's context limit" }).click();
  await page.getByRole("option", { name: "mock-lowonly", exact: true }).click();
  // Added at the limit in use, the default; nothing is saved until it changes.
  await expect(field).toHaveValue("131,072");
  await field.fill("65536");
  await field.press("Tab");
  await expect(field).toHaveValue("65,536");
  await page.getByRole("button", { name: "Reset Context limit for mock-lowonly" }).click();
  await expect(field).toHaveValue("131,072");
  await expect(field).toBeVisible();
  // Back at the default, nothing is stored, so a reload lists it no longer.
  await expect.poll(async () => (await savedSettings(page)).contextLimits).toEqual({});
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Context limit for mock-fast" })).toBeVisible();
  await expect(field).toHaveCount(0);
});

test("a limit stored for a model with no known window can still be removed", async ({ page }) => {
  await patchSettings(page.request, { contextLimits: { "mock-nowindow": 16_384 } });
  await openSettings(page, "setup");
  // No window to limit, so no limit field: the stored limit is listed to be removed.
  await expect(
    page.getByRole("textbox", { name: "Context limit for mock-nowindow", exact: true }),
  ).toHaveCount(0);
  const notice = page.getByText("Not used: a limit of 16,384 tokens is stored.");
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Remove the limit stored for mock-nowindow" }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(async () => (await savedSettings(page)).contextLimits).toEqual({});
});

test("history uses the native block policy without a legacy switch", async ({ page }) => {
  await openSettings(page, "setup");
  await expect(page.getByRole("switch", { name: "Trim history in blocks" })).toHaveCount(0);
});

test("history overflowing a limited context is left out in a block that stays put", async ({
  page,
}) => {
  // The limit is tuned to the fixed prompt, so the plain preset keeps it apart from the default's wording.
  const preset = uniqueName("Trimming");
  await createPresetViaApi(page.request, "prompt", plainPromptPreset(preset));
  await patchSettings(page.request, { contextLimits: { "mock-unreported": 2_048 } });
  await openChat(page, "mock-unreported");
  await openSession(page);
  await choose(page, "Prompt preset", preset);
  await closeSession(page);
  // Each long line comes back whole in the reply, so ten exchanges overflow 2,048 tokens.
  const lines = Array.from(
    { length: 10 },
    () => `${canary("in")} ${"a quiet line of the ledger ".repeat(16)}`,
  );
  for (const line of lines) {
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  }
  const prompt = page.getByRole("dialog", { name: "Prompt" });
  /** How many of the oldest messages the last prompt sent left out, as the inspector says. */
  const leftOut = async () => {
    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    const text = await prompt
      .getByText(/oldest messages were left out in a block, so the rest stays put/)
      .textContent();
    await page.keyboard.press("Escape");
    await expect(prompt).toBeHidden();
    return Number(/The ([\d,]+) oldest/.exec(text ?? "")?.[1]?.replaceAll(",", ""));
  };
  const before = await leftOut();
  expect(before).toBeGreaterThan(0);

  const short = canary("in");
  await send(page, short);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  // One more exchange leaves out the same oldest turns: both prompts open the chat alike.
  expect(await leftOut()).toBe(before);
  const firstTurn = async (line: string) =>
    (await upstreamRecords(line))[0]?.messages.find((message) => message.role !== "system")
      ?.content;
  const opening = await firstTurn(short);
  expect(opening).toContain(CANARY_MARKER);
  expect(await firstTurn(lines.at(-1) ?? "")).toBe(opening);
});

test("prompt post-processing is off unless set for a model, then sent as set", async ({ page }) => {
  await openSettings(page, "setup");
  const add = page.getByRole("combobox", { name: "Add a model", exact: true });
  await add.click();
  await page.getByRole("option", { name: "mock-lowonly", exact: true }).click();
  const mode = page.getByRole("combobox", { name: "Post-processing for mock-lowonly" });
  await expect(mode).toHaveText("One system message");
  await expect(page.getByText("Saved", { exact: true }).or(mode)).toBeVisible();

  await openChat(page, "mock-lowonly");
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await (
    await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/__records?contains=${encodeURIComponent(line)}`)
  ).json();
  const roles = (record.messages as { role: string }[]).map((message) => message.role);
  expect(roles.filter((role) => role === "system")).toHaveLength(1);
  expect(roles[0]).toBe("system");
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Prompt" })).toContainText("One system message");
  await page.keyboard.press("Escape");

  await openSettings(page, "setup");
  await page.getByRole("button", { name: "Remove post-processing for mock-lowonly" }).click();
  await expect(mode).toHaveCount(0);
});

test("reasoning shows open when set, and a model's hidden reasoning is timed when asked", async ({
  page,
}) => {
  await openSettings(page, "chat");
  const open = await settingSwitch(page, "Show reasoning open");
  const hidden = await settingSwitch(page, "Time hidden reasoning");
  // The short label toggles its switch, like the switch itself.
  await page.getByText("Show reasoning open", { exact: true }).click();
  await hidden.click();
  await expect(open).toBeChecked();

  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page).locator("details")).toHaveAttribute("open", "");

  // A sampler preset that asks for reasoning, on a model that sends none back.
  const sampler = uniqueName("Thinks");
  await createPresetViaApi(page.request, "sampler", {
    name: sampler,
    values: {
      model: null,
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      reasoning: "high",
    },
  });
  await page.reload();
  await chooseModel(page, "mock-hostile");
  await openSession(page);
  await choose(page, "Sampler preset", sampler);
  await closeSession(page);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page)).toContainText(
    /Thought for \d+ seconds?; the model keeps its reasoning/,
  );

  await openSettings(page, "chat");
  await open.click();
  await hidden.click();
  await expect(open).not.toBeChecked();
});

test("the character's own prompt and instructions are used only while preferred", async ({
  page,
}) => {
  const character = uniqueName("Own prompt");
  // Card text persists, so it carries no canary (the server-writes check scans for them).
  const id = await createCharacterViaApi(page.request, character, {
    systemPrompt: "Card rules first. {{original}}",
    postHistoryInstructions: "Card closing words.",
  });
  // The preset's Main Prompt as sent: its macros filled in, so only its opening is compared.
  const main = defaultPromptPreset().blocks.find((block) => block.id === "main");
  const presetOpening = (main?.kind === "text" ? main.content : "").split("{{")[0] ?? "";
  expect(presetOpening).not.toBe("");
  const sent = async () => {
    const line = canary("in");
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const [record] = await upstreamRecords(line);
    return record?.messages.map((message) => message.content) ?? [];
  };

  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  const preferred = await sent();
  expect(preferred.some((text) => text.startsWith(`Card rules first. ${presetOpening}`))).toBe(
    true,
  );
  expect(preferred).toContain("Card closing words.");

  await openSettings(page, "chat");
  const prompt = await settingSwitch(page, "Prefer the character's system prompt");
  const instructions = await settingSwitch(
    page,
    "Prefer the character's post-history instructions",
  );
  await expect(prompt).toBeChecked();
  await expect(instructions).toBeChecked();
  await prompt.click();
  await instructions.click();
  await expect(prompt).not.toBeChecked();
  expect(await seriousAxeViolations(page)).toEqual([]);

  // The sheet says so where the card's own prompts are edited.
  await page.goto(`/characters/${id}`);
  await expect(
    page.getByText("Not used: Settings prefers the preset's main prompt."),
  ).toBeVisible();
  await expect(
    page.getByText("Not used: Settings prefers the preset's post-history instructions."),
  ).toBeVisible();

  await page.goto("/");
  await chooseCharacter(page, character);
  const presetOnly = await sent();
  expect(presetOnly.some((text) => text.startsWith(presetOpening))).toBe(true);
  expect(presetOnly.join("\n")).not.toContain("Card rules first.");
  expect(presetOnly.join("\n")).not.toContain("Card closing words.");

  await openSettings(page, "chat");
  await prompt.click();
  await instructions.click();
  await expect(instructions).toBeChecked();
});

test("a lorebook source template wraps the entries sent together", async ({ page }) => {
  const character = uniqueName("Wrapped");
  const id = await createCharacterViaApi(page.request, character);
  await setLorebookViaApi(page.request, id, {
    entries: [loreEntry({ comment: "Tide", constant: true, content: "High water at dusk." })],
  });
  const preset = uniqueName("Wrapper");
  const presetId = await createPresetViaApi(page.request, "prompt", {
    name: preset,
    blocks: defaultPromptPreset().blocks,
  });
  await page.goto(`/presets/prompt/${presetId}`);
  await page.locator('[data-block="lorebookBefore"] [aria-expanded]').click();
  const template = page
    .locator('[data-block="lorebookBefore"]')
    .getByRole("textbox", { name: "Template" });
  await template.fill("[The world: {{content}}]");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  await openSession(page);
  await choose(page, "Prompt preset", preset);
  await closeSession(page);
  const line = canary("in");
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(line);
  expect(record?.messages.map((message) => message.content)).toContain(
    "[The world: High water at dusk.]",
  );
});

test("a memory size steps with the arrow keys, each step saved and the field kept", async ({
  page,
}) => {
  const memoryKeepTurns = async () =>
    (
      (await (await page.request.get("/api/settings")).json()) as {
        settings: { memoryKeepTurns: number };
      }
    ).settings.memoryKeepTurns;
  const start = await memoryKeepTurns();
  await openSettings(page, "memory");
  const field = page.getByRole("textbox", { name: "Keep recent turns", exact: true });
  await expect(field).toHaveValue(String(start));
  // From the bottom of the range, so every step goes up.
  await field.fill("1");
  await field.press("Tab");
  await expect.poll(memoryKeepTurns).toBe(1);
  await field.focus();
  await field.press("ArrowUp");
  await expect.poll(memoryKeepTurns).toBe(2);
  // The committed step left the same field, focus included, for the next one.
  await expect(field).toBeFocused();
  // Steps as quick as a held key each count, from the one before.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(field).toHaveValue("4");
  await expect.poll(memoryKeepTurns).toBe(4);
  await expect(field).toBeFocused();
});

test("a context limit steps with quick arrow keys, each step counted", async ({ page }) => {
  const limits = async () => (await savedSettings(page)).contextLimits;
  await openChat(page, "mock-fast");
  await openSettings(page, "setup");
  const field = page.getByRole("textbox", { name: "Context limit for mock-fast", exact: true });
  await field.fill("16384");
  await field.press("Tab");
  await expect.poll(limits).toEqual({ "mock-fast": 16_384 });
  await field.focus();
  await field.press("ArrowUp");
  await expect.poll(limits).toEqual({ "mock-fast": 17_408 });
  await expect(field).toBeFocused();
  // Steps as quick as a held key each count, from the one before.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(field).toHaveValue("19,456");
  await expect.poll(limits).toEqual({ "mock-fast": 19_456 });
});

test("a long persona name never makes the empty composer taller or wider", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page, "mock-fast");
  const composer = page.getByLabel("Message", { exact: true });
  const oneLine = (await composer.boundingBox())?.height;

  // A persona at the name limit, chosen for the chat the tab starts with.
  const id = await createPersonaViaApi(
    page.request,
    uniqueName("Seraphina of the Reach ".repeat(8)),
  );
  await patchSettings(page.request, { personaId: id });
  await page.reload();
  await expect(composer).toHaveAttribute("placeholder", /^Write as Seraphina/);
  expect((await composer.boundingBox())?.height).toBe(oneLine);
  await expectNoOverflow(page);
  // Typed text still grows it, as before.
  await composer.fill("One line.\nTwo lines.\nThree lines.");
  expect((await composer.boundingBox())?.height).toBeGreaterThan(oneLine ?? 0);
});

test("a category opens from the address, an unknown one falls back to Appearance", async ({
  page,
}) => {
  await openSettings(page, "memory");
  await expect(settingsTab(page, "Memory & cast")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 2, name: "Memory & cast" })).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Open new chats where the story left off" }),
  ).toBeVisible();
  // Only the open category is there for role queries; Appearance's palettes are not.
  await expect(page.getByRole("radiogroup", { name: "Palette", exact: true })).toHaveCount(0);

  // A category is chosen in the index: the address follows it, and Back returns.
  await settingsTab(page, "Pictures").click();
  await expect(page).toHaveURL(/\/settings\?section=pictures$/);
  await expect(page.getByRole("textbox", { name: "ComfyUI address" })).toBeVisible();
  await page.goBack();
  await expect(settingsTab(page, "Memory & cast")).toHaveAttribute("aria-selected", "true");

  await page.goto("/settings?section=portraits");
  await expect(settingsTab(page, "Appearance")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("radiogroup", { name: "Palette", exact: true })).toBeVisible();
});

test("a window link opens Model setup on its field, then keeps only the category", async ({
  page,
}) => {
  await page.goto("/settings?section=memory&window=mock-nowindow");
  await expect(settingsTab(page, "Model setup")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Context window for mock-nowindow", exact: true }),
  ).toBeFocused();
  await expect(page).toHaveURL(/\/settings\?section=setup$/);
});

test("an infotip opens on hover and from the keyboard, and Escape closes it", async ({ page }) => {
  await openSettings(page, "memory");
  const trigger = page.getByRole("button", { name: "About Remember every", exact: true });
  const tip = page.getByRole("dialog", { name: "Remember every" });
  await trigger.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Writes a memory once this much new story has built up.");
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(trigger).toBeFocused();

  // A switch's infotip sits outside its label: opening it never toggles the switch.
  await settingsTab(page, "Chat").click();
  const open = page.getByRole("switch", { name: "Show reasoning open", exact: true });
  const checked = await open.isChecked();
  await page.getByRole("button", { name: "About Show reasoning open", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Show reasoning open" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await open.isChecked()).toBe(checked);
});

test.describe("on touch", () => {
  test.use({ hasTouch: true });

  test("an infotip opens on tap", async ({ page }) => {
    await openSettings(page, "memory");
    await page.getByRole("button", { name: "About Keep recent turns", exact: true }).tap();
    await expect(page.getByRole("dialog", { name: "Keep recent turns" })).toBeVisible();
  });
});

test("a phone opens a category from the list, and its back control returns to the row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  const list = page.getByRole("navigation", { name: "Settings categories" });
  const row = list.getByRole("link", { name: /^Memory & cast / });
  await row.click();
  await expect(page.getByRole("heading", { level: 1, name: "Memory & cast" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\?section=memory$/);
  await expect(list).toHaveCount(0);
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(row).toBeFocused();

  // Opened by its address, the category's back control still lands on the list.
  await page.goto("/settings?section=pictures");
  await expect(page.getByRole("heading", { level: 1, name: "Pictures" })).toBeVisible();
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(list).toBeVisible();
});

test("an unsaved palette stays open while another category is looked at", async ({ page }) => {
  await openSettings(page);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Your palettes/ }).click();
  await page.getByRole("button", { name: "New palette" }).click();
  await page.getByRole("menuitem", { name: "Nord" }).click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Harbour");
  await settingsTab(page, "Chat").click();
  await expect(page.getByRole("region", { name: "New palette" })).toHaveCount(0);
  await settingsTab(page, "Appearance").click();
  await expect(page.getByRole("region", { name: "New palette" })).toBeVisible();
  await expect(name).toHaveValue("Harbour");
});

for (const { name, width, height, scheme } of [
  { name: "desktop light", width: 1440, height: 900, scheme: "light" },
  { name: "tablet dark", width: 834, height: 1112, scheme: "dark" },
  { name: "phone dark", width: 390, height: 844, scheme: "dark" },
] as const) {
  test(`the settings screen fits and has no serious accessibility issue: ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    await openSettings(page);
    // Phones open on the list of categories, which must fit too.
    if (name === "phone dark") {
      await expectNoOverflow(page);
      expect(await seriousAxeViolations(page)).toEqual([]);
      await page
        .getByRole("navigation", { name: "Settings categories" })
        .getByRole("link", { name: /^Chat / })
        .click();
      await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeVisible();
    } else {
      await settingsTab(page, "Chat").click();
    }
    for (const label of Object.keys(SWITCH_HELP) as (keyof typeof SWITCH_HELP)[]) {
      await expect(await settingSwitch(page, label)).toBeVisible();
    }
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}
