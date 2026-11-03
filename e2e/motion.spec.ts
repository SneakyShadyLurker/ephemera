import type { Locator, Page } from "@playwright/test";
import { uniqueName } from "./support/cards.ts";
import { castEntry, openRecord } from "./support/cast.ts";
import { keeperWoman } from "./support/cast-fixtures.ts";
import {
  chooseModel,
  headerAction,
  lastReply,
  openChat,
  replyActions,
  replyCounter,
  send,
} from "./support/chat.ts";
import {
  BRAINSTORM_COPY,
  brainstorm,
  createCard,
  ideaRows,
  KEEP_WITHOUT_PORTRAIT,
} from "./support/creator.ts";
import { keptBase, ownerDescription } from "./support/creator-fixtures.ts";
import {
  createCharacterViaApi,
  createEventViaApi,
  createLorebookViaApi,
  loreEntry,
  patchSettings,
  setLorebookViaApi,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { createReworkCharacter, dock, openRework, submitRework } from "./support/rework.ts";
import { ownerRequest } from "./support/rework-fixtures.ts";
import { expire, notice, signInThroughPortal } from "./support/signin.ts";
import { expect, test, unsafe } from "./support/test.ts";

/** Read the outgoing popup after its primitive enters the closing phase. */
function closingFrame(popup: Locator) {
  return popup.evaluate(
    (element) =>
      new Promise<{ text: string; height: number; inert: boolean }>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!element.hasAttribute("data-ending-style")) return;
          observer.disconnect();
          resolve({
            text: element.textContent ?? "",
            height: element.getBoundingClientRect().height,
            inert: element.closest("[inert]") !== null || element.querySelector("[inert]") !== null,
          });
        });
        observer.observe(element, { attributes: true });
      }),
  );
}

/** Retain the actual outgoing node, so a removed role cannot hide a stranded slot. */
function exitFrames(surface: Locator) {
  return surface.evaluate(
    (element) =>
      new Promise<
        { height: number; opacity: number; inert: boolean; hidden: boolean; text: string }[]
      >((resolve) => {
        const frames: {
          height: number;
          opacity: number;
          inert: boolean;
          hidden: boolean;
          text: string;
        }[] = [];
        const sample = () => {
          if (!element.isConnected || element.hasAttribute("hidden")) return resolve(frames);
          frames.push({
            height: element.getBoundingClientRect().height,
            opacity: Number.parseFloat(getComputedStyle(element).opacity),
            inert: element.closest("[inert]") !== null,
            hidden: element.getAttribute("aria-hidden") === "true",
            text: element.textContent ?? "",
          });
          requestAnimationFrame(sample);
        };
        sample();
      }),
  );
}

/** Sample the actual layout slot until Session reaches its new endpoint. */
function sessionWidths(page: Page, opening: boolean) {
  return page.evaluate(
    (open) =>
      new Promise<number[]>((resolve) => {
        const main = document.querySelector("main");
        const toggle = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) =>
            (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Session",
        );
        if (main === null || toggle === undefined) throw new Error("Chat is not mounted");
        const widths = [main.getBoundingClientRect().width];
        const sample = () => {
          widths.push(main.getBoundingClientRect().width);
          const panel = document.querySelector('aside[aria-labelledby="session-title"]');
          const settled = open
            ? panel !== null && panel.getAnimations().length === 0 && widths.length > 2
            : panel === null;
          if (settled) resolve(widths);
          else requestAnimationFrame(sample);
        };
        toggle.click();
        requestAnimationFrame(sample);
      }),
    opening,
  );
}

/** Measure the dock's real flex slot and the sheet scroller sharing its height. */
function dockHeights(page: Page, opening: boolean) {
  return page.evaluate(
    (open) =>
      new Promise<{ dock: number; scroller: number }[]>((resolve) => {
        const scroller = document.querySelector("main [data-skip-target]");
        if (scroller === null) throw new Error("The sheet scroller is not mounted");
        const frames: { dock: number; scroller: number }[] = [];
        const sample = () => {
          const bar = document.querySelector('[role="region"][aria-label="AI Rework"]');
          const height = bar?.getBoundingClientRect().height ?? 0;
          frames.push({ dock: height, scroller: scroller.getBoundingClientRect().height });
          const naturalHeight = bar?.firstElementChild?.getBoundingClientRect().height ?? 0;
          const settled = open
            ? bar !== null &&
              height > 0 &&
              Math.abs(height - naturalHeight) < 0.1 &&
              Number.parseFloat(getComputedStyle(bar).opacity) > 0.999 &&
              frames.length > 2
            : bar === null;
          if (settled) resolve(frames);
          else requestAnimationFrame(sample);
        };
        sample();
      }),
    opening,
  );
}

test("Session opens and closes its layout slot continuously, including a reversed entrance", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const before = await page
    .locator("main")
    .evaluate((element) => element.getBoundingClientRect().width);
  const opening = await sessionWidths(page, true);
  const after = opening.at(-1) ?? 0;
  expect(before - after).toBeCloseTo(320, 0);
  expect(opening.some((width) => width < before - 1 && width > after + 1)).toBe(true);
  const closing = await sessionWidths(page, false);
  expect(closing.some((width) => width > after + 1 && width < before - 1)).toBe(true);
  expect(closing.at(-1)).toBeCloseTo(before, 0);

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const toggle = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) =>
            (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Session",
        );
        if (toggle === undefined) throw new Error("No Session toggle");
        toggle.click();
        const reverse = () => {
          const panel = document.querySelector('aside[aria-labelledby="session-title"]');
          if (panel === null || panel.getBoundingClientRect().width <= 1) {
            requestAnimationFrame(reverse);
            return;
          }
          toggle.click();
          requestAnimationFrame(() => {
            toggle.click();
            resolve();
          });
        };
        requestAnimationFrame(reverse);
      }),
  );
  const session = page.getByRole("complementary", { name: "Session" });
  await expect(session).toBeVisible();
  await expect
    .poll(() => session.evaluate((element) => element.getBoundingClientRect().width))
    .toBeCloseTo(320, 0);
  await session.getByRole("button", { name: "Close Session" }).click();
  await expect(session).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Session", exact: true })).toBeFocused();
});

test("reduced-motion Session keeps its width while its closing fade is visible", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Session", exact: true })).toBeVisible();
  await sessionWidths(page, true);
  const frames = await page.evaluate(
    () =>
      new Promise<{ width: number; opacity: number }[]>((resolve) => {
        const panel = document.querySelector<HTMLElement>('aside[aria-labelledby="session-title"]');
        const toggle = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) =>
            (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Session",
        );
        if (panel === null || toggle === undefined) throw new Error("Session is not open");
        const samples: { width: number; opacity: number }[] = [];
        const sample = () => {
          if (!panel.isConnected) return resolve(samples);
          samples.push({
            width: panel.getBoundingClientRect().width,
            opacity: Number.parseFloat(getComputedStyle(panel).opacity),
          });
          requestAnimationFrame(sample);
        };
        toggle.click();
        requestAnimationFrame(sample);
      }),
  );
  expect(frames.some(({ opacity }) => opacity > 0.05 && opacity < 0.95)).toBe(true);
  for (const { width } of frames) expect(width).toBeCloseTo(320, 0);
  await expect(page.getByRole("complementary", { name: "Session" })).toHaveCount(0);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Prompt retains its contents throughout closing at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openChat(page, "mock-fast");
    await headerAction(page, "Prompt");
    const prompt = page.getByRole("dialog", { name: "Prompt", exact: true });
    await expect(prompt).toContainText("Context window");
    await expect.poll(() => prompt.evaluate((element) => element.getAnimations().length)).toBe(0);
    const height = (await prompt.boundingBox())?.height ?? 0;
    const frame = closingFrame(prompt);
    await prompt.getByRole("button", { name: "Close prompt" }).click();
    const outgoing = await frame;
    expect(outgoing.text).toContain("Context window");
    expect(outgoing.height).toBeCloseTo(height, 0);
    expect(outgoing.inert).toBe(true);
    await expect(prompt).toHaveCount(0);
  });

  test(`removing a Cast record retains the outgoing record at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const characterId = await createCharacterViaApi(request, "Motion keeper", {
      description: "A lighthouse keeper.",
      firstMessage: "The lamp room is warm.",
    });
    await patchSettings(request, { model: "mock-fast", castModel: "mock-cast", characterId });
    await page.goto("/");
    const name = keeperWoman([]);
    await expect(castEntry(page, name)).toBeVisible();
    const record = await openRecord(page, name);
    await expect(record.getByRole("button", { name: "Remove from cast" })).toBeVisible();
    await expect.poll(() => record.evaluate((element) => element.getAnimations().length)).toBe(0);
    const height = (await record.boundingBox())?.height ?? 0;
    const frame = closingFrame(record);
    await record.getByRole("button", { name: "Remove from cast" }).click();
    const outgoing = await frame;
    expect(outgoing.text).toContain(name);
    expect(outgoing.text).toContain("Remove from cast");
    expect(outgoing.height).toBeCloseTo(height, 0);
    expect(outgoing.inert).toBe(true);
    await expect(record).toHaveCount(0);
    await page.getByRole("button", { name: `Undo removing ${name}` }).click();
    await expect(castEntry(page, name)).toBeVisible();
    await openRecord(page, name);
  });
}

test("a lower Brainstorm idea opens Describe at the top and Back restores its list position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await brainstorm(page, { request: `${keptBase()}-ask A quiet archivist.`, model: "mock-fast" });
  await expect(page.getByText(BRAINSTORM_COPY.complete, { exact: true })).toBeVisible();
  const last = ideaRows(page).last().getByRole("button");
  await expect(last).toBeEnabled();
  await last.scrollIntoViewIfNeeded();
  const scroller = page.locator("main [data-skip-target]");
  const before = await scroller.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await last.click();
  await expect(page.getByRole("textbox", { name: "Who do you want to meet?" })).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByRole("button", { name: "Back to ideas" })).toBeInViewport();
  await page.getByRole("button", { name: "Back to ideas" }).click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);
  await expect(ideaRows(page).last().getByRole("button")).toBeFocused();
});

test("creator completion transitions the scrolled writing into the top of the showcase", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 667 });
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(keptBase()),
    model: "mock-slow",
  });
  const scroller = page.locator("main [data-skip-target]");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document);
    const state = {
      calls: 0,
      types: [] as string[],
      typed: false,
      parts: [] as string[],
      spans: {} as Record<string, { start: number; end: number }>,
      layers: {} as Record<string, string>,
    };
    Object.assign(window, { completionTransitions: state });
    document.startViewTransition = (options) => {
      state.calls++;
      const transition = start(options);
      // Once the pseudo-element tree is built: the type, and each animated part with its span.
      void transition.ready.then(() => {
        state.types = [...transition.types];
        state.typed = document.documentElement.matches(
          ":active-view-transition-type(creator-complete)",
        );
        // Each group's stacking as painted, not as the elements stood when captured.
        for (const name of ["creator-header", "creator-frame", "creator-heading", "root"])
          state.layers[name] = getComputedStyle(
            document.documentElement,
            `::view-transition-group(${name})`,
          ).zIndex;
        for (const animation of document.getAnimations()) {
          const effect = animation.effect;
          if (!(effect instanceof KeyframeEffect) || effect.pseudoElement === null) continue;
          state.parts.push(effect.pseudoElement);
          const timing = effect.getComputedTiming();
          const start = Number(timing.delay ?? 0);
          state.spans[effect.pseudoElement] = {
            start,
            end: start + Number(timing.activeDuration ?? 0),
          };
        }
      });
      return transition;
    };
  });
  await expect(page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
  const transitions = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            completionTransitions: {
              calls: number;
              types: string[];
              typed: boolean;
              parts: string[];
              spans: Record<string, { start: number; end: number }>;
              layers: Record<string, string>;
            };
          }
        ).completionTransitions,
    );
  await expect.poll(async () => (await transitions()).parts.length).toBeGreaterThan(0);
  const { calls, types, typed, parts, spans, layers } = await transitions();
  expect(calls).toBe(1);
  expect(types).toEqual(["creator-complete"]);
  expect(typed).toBe(true);
  // The page fades through: the writing has left before the card arrives, so the two
  // text layouts are never drawn over each other.
  const out = spans["::view-transition-old(root)"];
  const into = spans["::view-transition-new(root)"];
  expect(out?.end).toBeGreaterThan(0);
  expect(into?.start).toBeGreaterThanOrEqual(out?.end ?? Infinity);
  // The screen header is its own part for this transition, so what glides passes beneath it.
  expect(parts).toContain("::view-transition-group(creator-header)");
  // Its group is stacked above every gliding group, whatever order the elements paint in.
  const layer = (name: string) => {
    const value = layers[name];
    return value === undefined || value === "auto" ? 0 : Number(value);
  };
  expect(layers["creator-header"]).toMatch(/^\d+$/);
  for (const name of ["creator-frame", "creator-heading", "root"])
    expect(layer("creator-header")).toBeGreaterThan(layer(name));
  // The frame and the name each glide as one shared element: a group that moves, holding
  // the old and the new image, so neither is drawn twice in two places.
  for (const name of ["creator-frame", "creator-heading"]) {
    expect(parts).toContain(`::view-transition-group(${name})`);
    expect(parts).toContain(`::view-transition-old(${name})`);
    expect(parts).toContain(`::view-transition-new(${name})`);
  }
  // The Keep bar is new: it fades in as its own part, not inside the text's crossfade.
  expect(parts).toContain("::view-transition-new(creator-keep)");
  expect(parts).not.toContain("::view-transition-old(creator-keep)");
});

test("creator completion in a hidden document finishes without starting a view transition", async ({
  page,
}) => {
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(keptBase()),
    model: "mock-slow",
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const start = document.startViewTransition.bind(document);
    Object.assign(window, { hiddenTransitions: 0 });
    document.startViewTransition = (options) => {
      (window as unknown as { hiddenTransitions: number }).hiddenTransitions++;
      return start(options);
    };
  });
  await expect(page.getByRole("button", { name: KEEP_WITHOUT_PORTRAIT })).toBeVisible({
    timeout: 20_000,
  });
  expect(
    await page.evaluate(
      () => (window as unknown as { hiddenTransitions: number }).hiddenTransitions,
    ),
  ).toBe(0);
  await page.evaluate(() => Reflect.deleteProperty(document, "visibilityState"));
});

test("sheet navigation waits for fresh data on first entry and cached return", async ({
  page,
  request,
}) => {
  const id = await createCharacterViaApi(request, "Motion arrival", {
    description: "First version.",
  });
  await page.goto("/characters");
  for (const description of ["First version.", "Fresh return version."]) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detail = `**/api/characters/${id}`;
    await page.route(
      detail,
      async (route) => {
        await held;
        await route.continue();
      },
      { times: 1 },
    );
    const requested = page.waitForRequest(
      (sent) => new URL(sent.url()).pathname === `/api/characters/${id}` && sent.method() === "GET",
    );
    const navigation = page
      .getByRole("list", { name: "Characters" })
      .getByRole("link", { name: "Motion arrival", exact: false })
      .click();
    await requested;
    await expect(page.getByRole("heading", { name: /^Characters/, level: 1 })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Loading page…" })).toHaveCSS(
      "opacity",
      "1",
    );
    release();
    await navigation;
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(
      description,
    );
    await expect(page.getByRole("status").filter({ hasText: "Loading page…" })).toHaveCount(0);
    if (description === "First version.") {
      await page.locator("main").getByRole("link", { name: "Characters", exact: true }).click();
      const current = await (await request.get(`/api/characters/${id}`)).json();
      const changed = await request.patch(`/api/characters/${id}`, {
        headers: unsafe(),
        data: { description: "Fresh return version.", revision: current.revision },
      });
      expect(changed.status()).toBe(200);
    }
  }
  // Duplicate navigates directly between ids on the same sheet route. Returning
  // to the cached first match must still fetch the version saved while away.
  const detailRequests: string[] = [];
  page.on("request", (sent) => {
    const path = new URL(sent.url()).pathname;
    if (sent.method() === "GET" && /^\/api\/characters\/[^/]+$/.test(path))
      detailRequests.push(path);
  });
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`/characters/${id}$`));
  const duplicateId = new URL(page.url()).pathname.split("/").at(-1);
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(
    "Fresh return version.",
  );
  const current = await (await request.get(`/api/characters/${id}`)).json();
  const changed = await request.patch(`/api/characters/${id}`, {
    headers: unsafe(),
    data: { description: "Fresh direct return.", revision: current.revision },
  });
  expect(changed.status()).toBe(200);
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(
    "Fresh direct return.",
  );
  expect(detailRequests).toEqual([`/api/characters/${duplicateId}`, `/api/characters/${id}`]);
});

for (const surface of ["lorebook", "memory"] as const) {
  test(`the character ${surface} keeps its source visible until fresh editor data arrives`, async ({
    page,
    request,
  }) => {
    const id = await createReworkCharacter(request, `Motion ${surface}`);
    await page.goto(`/characters/${id}`);
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    const sourceName = await name.inputValue();
    const endpoint =
      surface === "memory" ? `/api/memory/characters/${id}` : `/api/characters/${id}`;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gets = 0;
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() === "GET") {
        gets++;
        await held;
      }
      await route.continue();
    });
    const requested = page.waitForRequest(
      (sent) => sent.method() === "GET" && new URL(sent.url()).pathname === endpoint,
    );
    await page.getByRole("link", { name: `Open ${surface}`, exact: true }).click();
    await requested;
    try {
      await expect(name).toHaveValue(sourceName);
      await expect(page.getByRole("status").filter({ hasText: "Loading page…" })).toHaveCSS(
        "opacity",
        "1",
      );
    } finally {
      release();
    }
    await expect(page).toHaveURL(new RegExp(`/characters/${id}/${surface}$`));
    if (surface === "memory") {
      await expect(
        page.getByRole("heading", { name: "Memory", exact: true, level: 1 }),
      ).toBeVisible();
    } else {
      await expect(page.getByPlaceholder("Find by title, keyword or text")).toBeVisible();
    }
    expect(gets).toBe(1);
  });
}

for (const kind of ["characters", "personas"] as const) {
  test(`the first ${kind} autosave keeps typing focused while its saved URL loads`, async ({
    page,
  }) => {
    await page.goto(`/${kind}/new`);
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/${kind}/*`, async (route) => {
      if (route.request().method() === "GET") await held;
      await route.continue();
    });
    const requested = page.waitForRequest(
      (sent) => sent.method() === "GET" && new RegExp(`/api/${kind}/[^/]+$`).test(sent.url()),
    );
    await name.fill("First save");
    await requested;
    try {
      await expect(name).toBeFocused();
      await expect
        .poll(() => name.evaluate((element) => element.closest("[inert]") !== null))
        .toBe(false);
      await page.keyboard.press("End");
      await page.keyboard.type(" keeps typing");
      await expect(name).toHaveValue("First save keeps typing");
    } finally {
      release();
    }
    await expect(page).toHaveURL(new RegExp(`/${kind}/[0-9a-f-]{36}$`));
    await expect(name).toBeFocused();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
      "First save keeps typing",
    );
  });
}

test("a pending sheet destination prevents new edits while its Back link can cancel navigation", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await createCharacterViaApi(request, "Pending source", {
    description: "Original description.",
  });
  await page.goto(`/characters/${id}`);
  const description = page.locator("#field-description");
  await expect(description).toHaveValue("Original description.");
  await description.scrollIntoViewIfNeeded();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/characters/*", async (route) => {
    if (route.request().method() === "GET" && !route.request().url().endsWith(`/${id}`)) await held;
    await route.continue();
  });
  const requested = page.waitForRequest(
    (sent) =>
      sent.method() === "GET" &&
      /\/api\/characters\/[^/]+$/.test(sent.url()) &&
      !sent.url().endsWith(`/${id}`),
  );
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await requested;
  try {
    await expect
      .poll(() => description.evaluate((element) => element.closest("[inert]") !== null))
      .toBe(true);
    const box = await description.boundingBox();
    if (box === null) throw new Error("The outgoing description disappeared");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type("An edit that must not be accepted");
    await expect(description).toHaveValue("Original description.");
    await page.getByRole("link", { name: "Back to characters", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^Characters/, level: 1 })).toBeVisible();
  } finally {
    release();
  }
});

for (const source of ["library", "character"] as const) {
  test(`${source} lorebook entry navigation stays local without fetching the book again`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const book = { entries: [loreEntry({ comment: "Lantern", content: "A light in the fog." })] };
    const id =
      source === "library"
        ? await createLorebookViaApi(request, "Motion book", book)
        : await createCharacterViaApi(request, "Motion card book");
    if (source === "character") await setLorebookViaApi(request, id, book);
    const path = source === "library" ? `/lorebooks/${id}` : `/characters/${id}/lorebook`;
    const endpoint = source === "library" ? `/api/lorebooks/${id}` : `/api/characters/${id}`;
    await page.goto(path);
    const entry = page.getByRole("button", { name: "Edit Lantern", exact: true });
    await expect(entry).toBeVisible();
    let detailRequests = 0;
    page.on("request", (sent) => {
      if (sent.method() === "GET" && new URL(sent.url()).pathname === endpoint) detailRequests++;
    });
    await entry.click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Lantern");
    await expect(page).toHaveURL(new RegExp(`${path}\\?entry=0$`));
    await page.goBack();
    await expect(entry).toBeVisible();
    expect(detailRequests).toBe(0);
  });
}

test("reduced-motion palette panels keep their height while closing and become inert immediately", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings?section=appearance");
  const toggle = page.getByRole("button", { name: /^Your palettes/ });
  await toggle.click();
  const id = await toggle.getAttribute("aria-controls");
  if (id === null) throw new Error("The palettes disclosure has no panel");
  const panel = page.locator(`[id="${id}"]`);
  await expect(panel).toHaveCSS("opacity", "1");
  const height = (await panel.boundingBox())?.height ?? 0;
  expect(height).toBeGreaterThan(0);
  const closing = exitFrames(panel);
  await toggle.click();
  const frames = (await closing).filter(({ opacity }) => opacity > 0.05 && opacity < 0.95);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.height).toBeCloseTo(height, 0);
    expect(frame.inert).toBe(true);
  }
  await expect(panel).toHaveCount(0);
});

test("reduced-motion native details retain their expanded block through the closing fade", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const base = "motion-details";
  const id = await createReworkCharacter(request, base);
  await page.goto(`/characters/${id}`);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-details"), model: "mock-fast" });
  const details = dock(page).locator("details.disclosure");
  await expect(details).toBeVisible();
  await details.locator("summary").click();
  await expect
    .poll(() =>
      details.evaluate((element) => getComputedStyle(element, "::details-content").opacity),
    )
    .toBe("1");
  const frames = await details.evaluate(
    (element) =>
      new Promise<{ height: number; opacity: number; visibility: string }[]>((resolve) => {
        const frames: { height: number; opacity: number; visibility: string }[] = [];
        const sample = () => {
          const style = getComputedStyle(element, "::details-content");
          if (style.contentVisibility === "hidden") return resolve(frames);
          frames.push({
            height: element.getBoundingClientRect().height,
            opacity: Number.parseFloat(style.opacity),
            visibility: style.contentVisibility,
          });
          requestAnimationFrame(sample);
        };
        frames.push({
          height: element.getBoundingClientRect().height,
          opacity: 1,
          visibility: "visible",
        });
        element.querySelector("summary")?.click();
        requestAnimationFrame(sample);
      }),
  );
  const height = frames[0]?.height ?? 0;
  const fading = frames.filter(({ opacity }) => opacity > 0.05 && opacity < 0.95);
  expect(fading.length).toBeGreaterThan(0);
  for (const frame of fading) expect(frame.height).toBeCloseTo(height, 0);
  await expect(details).not.toHaveAttribute("open");
});

test("the global sign-in notice stays visible while lazy animation features are unavailable", async ({
  page,
  context,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/motion-features-*.js", async (route) => {
    await held;
    await route.continue();
  });
  const requested = page.waitForRequest(/\/assets\/motion-features-[^/]+\.js$/);
  await page.goto("/characters", { waitUntil: "domcontentloaded" });
  await requested;
  try {
    await expire(context);
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await expect(notice(page)).toContainText("Your sign-in has expired");
    await expect(notice(page).locator("../..")).toHaveCSS("opacity", "1");
    await expect(notice(page).getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  } finally {
    release();
  }
});

test("sign-in notice ownership transfers to a sheet without rendering two notices", async ({
  page,
  context,
}) => {
  await page.goto("/characters");
  await expire(context);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(notice(page)).toContainText("Your sign-in has expired");
  await expect(notice(page).locator("../..")).toHaveCSS("opacity", "1");
  const counts = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const sampled: number[] = [];
        const started = performance.now();
        const sample = () => {
          sampled.push(document.querySelectorAll("[data-signin]").length);
          if (performance.now() - started > 1_000) resolve(sampled);
          else requestAnimationFrame(sample);
        };
        sample();
      }),
  );
  await page.locator("header").getByRole("button", { name: "New character", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/new$/);
  expect(Math.max(...(await counts))).toBe(1);
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText("Your sign-in has expired");
});

test("a renewed notice can reopen during its exit and later removes its slot without transitionend", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    document.addEventListener("transitionend", (event) => event.stopImmediatePropagation(), true);
  });
  await openChat(page, "mock-fast");
  await expire(context);
  await page.getByLabel("Message", { exact: true }).fill("Keep this request through renewal.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(notice(page)).toContainText("Your sign-in has expired");
  await signInThroughPortal(page, context);
  await expect(notice(page)).toContainText("Signed in again");
  // Only the explicit theme action expires this renewal; background previews and retries proceed.
  await page.route("**/api/**", (route) =>
    new URL(route.request().url()).pathname === "/api/settings" &&
    route.request().method() === "PATCH"
      ? route.fallback()
      : route.continue(),
  );
  await expire(context);
  // Start another domain expiry at the first exit frame, while Motion still owns this slot.
  const reopening = notice(page).evaluate(
    (element) =>
      new Promise<{ text: string; inert: boolean }>((resolve) => {
        const frame = element.parentElement?.parentElement;
        if (frame === null || frame === undefined) throw new Error("The notice has no slot");
        const observer = new MutationObserver(() => {
          if (!frame.hasAttribute("inert")) return;
          observer.disconnect();
          resolve({ text: element.textContent ?? "", inert: true });
          document.querySelector<HTMLButtonElement>('button[aria-label="Light"]')?.click();
        });
        observer.observe(frame, { attributes: true, attributeFilter: ["inert"] });
      }),
  );
  expect((await reopening).text).toContain("Signed in again");
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText("Your sign-in has expired");
  await expect(notice(page).getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await signInThroughPortal(page, context);
  await expect(notice(page)).toContainText("Signed in again");
  const slot = notice(page).locator("../..");
  const frames = await exitFrames(slot);
  expect(frames.some(({ inert, text }) => inert && text.includes("Signed in again"))).toBe(true);
  await expect(notice(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(slot).toHaveCount(0);
});

test("an outgoing confirmation is inert before another pointer press can confirm again", async ({
  page,
  request,
}) => {
  const id = await createCharacterViaApi(request, "Motion confirmation");
  let deletes = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/characters/${id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes++;
    await held;
    await route.continue();
  });
  await page.goto(`/characters/${id}`);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.locator('[role="alertdialog"]');
  const button = confirm.getByRole("button", { name: "Delete", exact: true });
  await expect.poll(() => confirm.evaluate((element) => element.getAnimations().length)).toBe(0);
  const box = await button.boundingBox();
  if (box === null) throw new Error("The confirmation is not visible");
  const closing = closingFrame(confirm);
  try {
    await button.click();
    expect((await closing).inert).toBe(true);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(confirm).toHaveCount(0);
    expect(deletes).toBe(1);
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/characters$/);
});

test("Undo holds its deadline for focus and hover, then expires inert at full height under reduced motion", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  const text = "A bell rings across the water";
  await createEventViaApi(request, text);
  await page.goto("/lorebooks");
  const section = page.getByRole("button", { name: "Events", exact: true });
  await section.click();
  const events = page.getByRole("list", { name: "Events" });
  await events.getByRole("button", { name: text }).click();
  await events.getByRole("button", { name: "Delete event", exact: true }).click();
  const row = page.locator("[data-removed]");
  await expect(row.getByRole("button", { name: "Undo", exact: true })).toBeFocused();
  await page.clock.runFor(9_000);
  await expect(row).not.toHaveAttribute("inert");
  await row.hover();
  await section.focus();
  await page.clock.runFor(9_000);
  await expect(row).not.toHaveAttribute("inert");
  await page.mouse.move(0, 0);
  const height = (await row.boundingBox())?.height ?? 0;
  await page.clock.runFor(7_000);
  await expect(row).not.toHaveAttribute("inert");
  await page.clock.runFor(1_500);
  await expect(row).toHaveAttribute("inert", "");
  await expect(row).toHaveAttribute("aria-hidden", "true");
  expect((await row.boundingBox())?.height).toBeCloseTo(height, 0);
  await expect(row).toContainText(text);
  await expect(section).toBeFocused();
});

test("Undo fades inert at full height under reduced motion without a CSS completion event", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    document.addEventListener("transitionend", (event) => event.stopImmediatePropagation(), true);
  });
  const text = "A light at the harbour";
  await createEventViaApi(request, text);
  await page.goto("/lorebooks");
  await page.getByRole("button", { name: "Events", exact: true }).click();
  const events = page.getByRole("list", { name: "Events" });
  await events.getByRole("button", { name: text }).click();
  await events.getByRole("button", { name: "Delete event", exact: true }).click();
  const row = page.locator("[data-removed]");
  await expect(row).toHaveCSS("opacity", "1");
  const height = (await row.boundingBox())?.height ?? 0;
  const closing = exitFrames(row);
  await page.getByRole("button", { name: "New event", exact: true }).click();
  const fading = (await closing).filter(
    ({ opacity, inert }) => inert && opacity > 0.05 && opacity < 0.95,
  );
  expect(fading.length).toBeGreaterThan(0);
  for (const frame of fading) {
    expect(frame.height).toBeCloseTo(height, 0);
    expect(frame.hidden).toBe(true);
    expect(frame.text).toContain(text);
  }
  await expect(row).toHaveCount(0);
});

test("Rework retains its outgoing snapshot but pagehide clears it during the exit", async ({
  page,
  request,
}) => {
  const base = "motion-rework-clear";
  const id = await createReworkCharacter(request, base);
  await page.goto(`/characters/${id}`);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-exit"), model: "mock-fast" });
  const bar = page.locator('[role="region"][aria-label="AI Rework"]');
  await expect(bar).toContainText("3 changes in 2 fields");
  await expect(bar).toHaveCSS("opacity", "1");
  const cleared = bar.evaluate(
    (element) =>
      new Promise<{ outgoing: string; inert: boolean; remains: boolean; html: string }>(
        (resolve) => {
          const observer = new MutationObserver(() => {
            if (!element.hasAttribute("inert")) return;
            observer.disconnect();
            const outgoing = element.textContent ?? "";
            const inert = element.hasAttribute("inert");
            window.dispatchEvent(new PageTransitionEvent("pagehide"));
            resolve({
              outgoing,
              inert,
              remains: element.isConnected,
              html: document.body.innerHTML,
            });
          });
          observer.observe(element, { attributes: true, attributeFilter: ["inert"] });
        },
      ),
  );
  await bar.getByRole("button", { name: "Discard", exact: true }).click();
  const after = await cleared;
  expect(after.outgoing).toContain("3 changes in 2 fields");
  expect(after.outgoing).toContain("1 change could not be matched");
  expect(after.inert).toBe(true);
  expect(after.remains).toBe(false);
  expect(after.html).not.toContain(`${base}-rej`);
  expect(after.html).not.toContain(`${base}-why`);
});

test("Undo stays available through a restoring request and a failed restoration", async ({
  page,
  request,
}) => {
  await page.clock.install();
  const text = "The harbour gates open";
  await createEventViaApi(request, text);
  await page.goto("/lorebooks");
  const section = page.getByRole("button", { name: "Events", exact: true });
  await section.click();
  const events = page.getByRole("list", { name: "Events" });
  await events.getByRole("button", { name: text }).click();
  await events.getByRole("button", { name: "Delete event", exact: true }).click();
  const row = page.locator("[data-removed]");
  const undo = row.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeFocused();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let restoring = false;
  await page.route("**/api/events", async (route) => {
    if (route.request().method() !== "POST" || restoring) return route.fallback();
    restoring = true;
    await held;
    await route.fulfill({ status: 503, body: "Unavailable" });
  });
  try {
    await undo.click();
    await expect(undo).toBeDisabled();
    await section.focus();
    await page.mouse.move(0, 0);
    await page.clock.runFor(9_000);
    await expect(row).not.toHaveAttribute("inert");
    release();
    await expect(row.getByRole("alert")).toContainText("Not restored");
    await page.clock.runFor(9_000);
    await expect(row).not.toHaveAttribute("inert");
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(events.getByRole("button", { name: text })).toHaveCount(1);
    await expect(events.getByRole("button", { name: text })).toBeFocused();
    await expect(row).toHaveAttribute("inert", "");
    await expect(undo).toHaveCount(0);
    const stored = await (await request.get("/api/events")).json();
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0].text).toBe(text);
  } finally {
    release();
  }
});

test("reduced-motion Rework exits at full height without waiting for a CSS event", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    document.addEventListener("transitionend", (event) => event.stopImmediatePropagation(), true);
  });
  const base = "motion-rework-fade";
  const id = await createReworkCharacter(request, base);
  await page.goto(`/characters/${id}`);
  await openRework(page);
  await submitRework(page, { request: ownerRequest(base, "kept-fade"), model: "mock-fast" });
  const bar = page.locator('[role="region"][aria-label="AI Rework"]');
  await expect(bar).toContainText("3 changes in 2 fields");
  await expect(bar).toHaveCSS("opacity", "1");
  const height = (await bar.boundingBox())?.height ?? 0;
  const closing = exitFrames(bar);
  await bar.getByRole("button", { name: "Discard", exact: true }).click();
  const fading = (await closing).filter(({ opacity }) => opacity > 0.05 && opacity < 0.95);
  expect(fading.length).toBeGreaterThan(0);
  for (const frame of fading) {
    expect(frame.height).toBeCloseTo(height, 0);
    expect(frame.inert).toBe(true);
    expect(frame.hidden).toBe(true);
    expect(frame.text).toContain("3 changes in 2 fields");
  }
  await expect(bar).toHaveCount(0);
});

test("reduced motion fades a rejected new entry at full height, then folds it at once", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const id = await createReworkCharacter(request, "motion-rework-new-entry");
  const block = (field: string, replace: string) =>
    `<change>\n<field>${field}</field>\n<why>The scene needs her.</why>\n<find></find>\n<replace>${replace}</replace>\n</change>`;
  const answer = [
    block("entry_new_1_name", "Night porter"),
    block("entry_new_1_keys", "porter, night"),
    block("entry_new_1", "The night porter locks the archive at ten and keeps the only key."),
    "<summary>Adds the night porter.</summary>",
  ].join("\n");
  await page.route("**/api/creator/rework", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "delta", text: answer })}\n${JSON.stringify({ type: "result", problems: [] })}\n`,
    }),
  );
  await page.goto(`/characters/${id}`);
  await openRework(page);
  await submitRework(page, { request: "Add the night porter.", model: "mock-fast" });
  const reject = page.getByRole("button", { name: "Reject new entry: Night porter" });
  const body = page
    .getByRole("group", { name: "New entry: Night porter", exact: true })
    .locator(".tracked-fold");
  await expect(body).toContainText("keeps the only key");
  await body.scrollIntoViewIfNeeded();
  // The body stays in the sheet, folded to its padding; sample its content height until it has collapsed.
  const folding = body.evaluate(
    (element) =>
      new Promise<{ height: number; opacity: number }[]>((resolve) => {
        const frames: { height: number; opacity: number }[] = [];
        const sample = () => {
          const style = getComputedStyle(element);
          const frame = {
            height:
              element.getBoundingClientRect().height -
              Number.parseFloat(style.paddingTop) -
              Number.parseFloat(style.paddingBottom),
            opacity: Number.parseFloat(style.opacity),
          };
          frames.push(frame);
          if (frame.height < 0.5) return resolve(frames);
          requestAnimationFrame(sample);
        };
        sample();
      }),
  );
  await reject.click();
  const frames = await folding;
  // The first frame is the open body, sampled before the click.
  const height = frames[0]?.height ?? 0;
  expect(height).toBeGreaterThan(0);
  const fading = frames.filter(({ opacity }) => opacity > 0.05 && opacity < 0.95);
  expect(fading.length).toBeGreaterThan(0);
  for (const frame of fading) expect(frame.height).toBeCloseTo(height, 0);
  expect(frames.at(-1)?.height).toBeCloseTo(0, 0);
  await expect(page.getByRole("button", { name: "Restore new entry: Night porter" })).toBeFocused();
});

test("normal-motion Rework grows and folds its real layout slot while the sheet scroller resizes", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const base = "motion-rework-layout";
  const id = await createReworkCharacter(request, base);
  await page.goto(`/characters/${id}`);
  await openRework(page);
  const scroller = page.locator("main [data-skip-target]");
  const before = (await scroller.boundingBox())?.height ?? 0;
  const opening = dockHeights(page, true);
  await submitRework(page, { request: ownerRequest(base, "kept-layout"), model: "mock-slow" });
  const entering = await opening;
  const expanded = entering.at(-1);
  if (expanded === undefined) throw new Error("The dock never entered");
  expect(expanded.dock).toBeGreaterThan(0);
  expect(entering.some((frame) => frame.dock > 1 && frame.dock < expanded.dock - 1)).toBe(true);
  expect(
    entering.some((frame) => frame.scroller > expanded.scroller + 1 && frame.scroller < before - 1),
  ).toBe(true);
  for (const frame of entering) expect(frame.dock + frame.scroller).toBeCloseTo(before, 0);

  const bar = page.locator('[role="region"][aria-label="AI Rework"]');
  await bar.getByRole("button", { name: "Stop", exact: true }).click();
  const discard = bar.getByRole("button", { name: "Discard", exact: true });
  await expect(discard).toBeVisible();
  const height = (await bar.boundingBox())?.height ?? 0;
  const closing = dockHeights(page, false);
  await discard.click();
  const leaving = await closing;
  expect(leaving.some((frame) => frame.dock > 1 && frame.dock < height - 1)).toBe(true);
  const first = leaving[0];
  if (first === undefined) throw new Error("The dock had no closing frame");
  expect(
    leaving.some((frame) => frame.scroller > first.scroller + 1 && frame.scroller < before - 1),
  ).toBe(true);
  for (const frame of leaving) expect(frame.dock + frame.scroller).toBeCloseTo(before, 0);
  expect(leaving.at(-1)?.dock).toBe(0);
  expect(leaving.at(-1)?.scroller).toBeCloseTo(before, 0);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`list screens arrive with their lists on a cold visit at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const name = uniqueName("Cold arrival");
    await createCharacterViaApi(request, name);
    // Presets never asks for the characters, so the gallery's list is cold.
    await page.goto("/presets");
    const previous = page.locator("main h1");
    await expect(previous).toHaveText(/^Presets/);
    await page.route("**/api/characters", async (route) => {
      if (route.request().method() === "GET") await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    let nav = page.getByRole("navigation", { name: "Main" });
    if (viewport.width < 720) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      nav = page.getByRole("dialog", { name: "Ephemera" });
    }
    // The first frame that shows the gallery's heading or a card, and how long it took.
    const arrival = page.evaluate(
      () =>
        new Promise<{ heading: boolean; card: boolean; waited: number }>((resolve) => {
          const start = performance.now();
          const sample = () => {
            const heading = [...document.querySelectorAll("main h1")].some((title) =>
              title.textContent?.startsWith("Characters"),
            );
            const card = document.querySelector('[aria-label="Characters"] li') !== null;
            if (heading || card) resolve({ heading, card, waited: performance.now() - start });
            else requestAnimationFrame(sample);
          };
          sample();
        }),
    );
    await nav.getByRole("link", { name: "Characters", exact: true }).click();
    await page.waitForTimeout(1000);
    await expect(previous).toHaveText(/^Presets/);
    const first = await arrival;
    expect(first).toMatchObject({ heading: true, card: true });
    expect(first.waited).toBeGreaterThanOrEqual(1000);
    await expect(page.getByRole("list", { name: "Characters" })).toContainText(name);
  });
}

test("a removed greeting retains its row while leaving, and the last leaves no line", async ({
  page,
  request,
}) => {
  const id = await createCharacterViaApi(request, uniqueName("Greeter"), {
    firstMessage: "Opening.",
    alternateGreetings: ["The tide is out."],
  });
  await page.goto(`/characters/${id}`);
  await page.getByText("Card details", { exact: true }).click();
  await page.getByRole("button", { name: /^Alternate 1: The tide/ }).click();
  const row = page.locator("#s-greetings li[data-key]");
  await expect(row).toHaveCount(1);
  await expect.poll(() => row.evaluate((element) => element.getAnimations().length)).toBe(0);
  const height = (await row.boundingBox())?.height ?? 0;
  await page.getByRole("button", { name: "More for Alternate 1" }).click();
  const menu = page.getByRole("menuitem", { name: "Remove" });
  await expect(menu).toBeVisible();
  const leaving = exitFrames(row);
  await menu.click();
  const frames = (await leaving).filter(({ inert }) => inert);
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) {
    expect(frame.hidden).toBe(true);
    expect(frame.text).toContain("The tide is out.");
  }
  // It folds: its height shrinks through the exit instead of dropping in one step.
  expect(frames.some((frame) => frame.height > 1 && frame.height < height - 1)).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(page.locator("#s-greetings ol").first()).toBeHidden();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("textbox", { name: "Alternate 1" })).toHaveValue("The tide is out.");
});

test("the palette editor leaves inert and folded, with its last contents", async ({ page }) => {
  await page.goto("/settings?section=appearance");
  // The editor's sample scene needs the preloaded Markdown renderer (app/preload.ts).
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Your palettes/ }).click();
  await page.getByRole("button", { name: "New palette" }).click();
  await page.getByRole("menuitem", { name: "Nord" }).click();
  const editor = page.getByRole("region", { name: "New palette" });
  await expect(editor).toBeVisible();
  // The slot around the editor is what folds.
  const slot = editor.locator("xpath=..");
  await expect.poll(() => slot.evaluate((element) => element.getAnimations().length)).toBe(0);
  const height = (await slot.boundingBox())?.height ?? 0;
  const leaving = exitFrames(slot);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  const frames = (await leaving).filter(({ inert }) => inert);
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) {
    expect(frame.hidden).toBe(true);
    expect(frame.text).toContain("New palette");
  }
  expect(frames.some((frame) => frame.height > 1 && frame.height < height - 1)).toBe(true);
  await expect(editor).toHaveCount(0);
});

/**
 * The last reply's actions row, as its distance below the top of the reply's prose, each frame
 * from now until it has moved and then held still for a while.
 */
function rowOffsets(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const prose = [...document.querySelectorAll('[data-role="assistant"] [data-prose]')].at(-1);
        const row = document.querySelector("[data-reply-actions]");
        if (prose === undefined || row === null) return resolve([]);
        const offsets: number[] = [];
        let held = 0;
        const sample = () => {
          const offset = Math.round(
            row.getBoundingClientRect().top - prose.getBoundingClientRect().top,
          );
          held = offset === offsets.at(-1) ? held + 1 : 0;
          offsets.push(offset);
          const moved = offsets.some((value) => value !== offsets[0]);
          if ((moved && held > 20) || offsets.length > 600) return resolve(offsets);
          requestAnimationFrame(sample);
        };
        sample();
      }),
  );
}

test("New reply removes the outgoing alternate under normal motion, including repeated fast replies", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const frame = lastReply(page).locator("[data-prose] > div").first();
  for (const model of ["mock-fast", "mock-fast", "mock-slow"] as const) {
    await chooseModel(page, model);
    const outgoing = await frame.elementHandle();
    if (outgoing === null) throw new Error("No outgoing reply frame");
    await replyActions(page).getByRole("button", { name: "New reply" }).click();
    await expect.poll(() => outgoing.evaluate((element) => element.isConnected)).toBe(false);
    await expect(frame).toContainText("Reply:");
    await expect(frame).toHaveCSS("opacity", "1");
    if (model === "mock-slow") {
      await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
      await page.getByRole("button", { name: "Stop", exact: true }).click();
    } else await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  }
});

test("New reply shows growing streaming prose without clipping", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await chooseModel(page, "mock-long");
  const sampling = page.evaluate(
    () =>
      new Promise<{ text: string; opacity: number; x: string; clipped: number }[]>((resolve) => {
        const frames: { text: string; opacity: number; x: string; clipped: number }[] = [];
        const start = performance.now();
        const sample = () => {
          const frame = document.querySelector<HTMLElement>(
            '[data-message][data-role="assistant"]:last-of-type [data-prose] > div',
          );
          if (frame) {
            const style = getComputedStyle(frame);
            frames.push({
              text: frame.textContent ?? "",
              opacity: Number.parseFloat(style.opacity),
              x: style.transform,
              clipped: frame.scrollHeight - frame.clientHeight,
            });
          }
          if (performance.now() - start > 1500) resolve(frames);
          else requestAnimationFrame(sample);
        };
        sample();
      }),
  );
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  const frames = await sampling;
  const arriving = frames.filter(({ text, opacity }) => text.includes("Line 1") && opacity > 0);
  expect(arriving, JSON.stringify(frames.slice(-5))).not.toHaveLength(0);
  expect(
    arriving
      .filter(({ clipped }) => clipped > 1)
      .map(({ clipped, x, opacity }) => ({ clipped, x, opacity })),
  ).toEqual([]);
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

for (const reduced of [false, true]) {
  test(`an alternate of another length ${reduced ? "moves the row below it in one step under reduced motion" : "eases the row below it"}`, async ({
    page,
  }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    // A second alternate of several paragraphs, against the first's one line.
    await chooseModel(page, "mock-hostile");
    await replyActions(page).getByRole("button", { name: "New reply" }).click();
    await expect(replyCounter(page)).toContainText("2 / 2");
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const pager = (name: "Previous reply" | "Next reply") =>
      replyCounter(page).getByRole("button", { name });
    const frame = lastReply(page).locator("[data-prose] > div").first();
    await pager("Previous reply").click();
    await expect(frame).toContainText("Reply:");
    await expect(frame).toHaveCSS("opacity", "1");
    // Back to the long one, and settled there before stepping to the short one.
    const growing = rowOffsets(page);
    await pager("Next reply").click();
    await growing;
    await expect(frame).toContainText("She smiles.");
    const moving = rowOffsets(page);
    await pager("Previous reply").click();
    const offsets = await moving;
    await expect(replyCounter(page)).toContainText("1 / 2");
    const distinct = new Set(offsets);
    // The row ends higher, as the shorter alternate is.
    expect(offsets.at(-1)).toBeLessThan(offsets[0] ?? Number.NaN);
    if (reduced) expect(distinct.size).toBe(2);
    else expect(distinct.size).toBeGreaterThan(2);
  });
}

/** Latest's wrapper each frame from now until it no longer shows. */
function latestFrames(wrapper: Locator) {
  return wrapper.evaluate(
    (element) =>
      new Promise<
        { hidden: boolean; inert: boolean; shown: boolean; opacity: number; top: number }[]
      >((resolve) => {
        const frames: {
          hidden: boolean;
          inert: boolean;
          shown: boolean;
          opacity: number;
          top: number;
        }[] = [];
        const sample = () => {
          const style = getComputedStyle(element);
          const shown = element.isConnected && style.display !== "none";
          frames.push({
            hidden: element.hasAttribute("hidden"),
            inert: element.closest("[inert]") !== null,
            shown,
            opacity: Number.parseFloat(style.opacity),
            top: element.getBoundingClientRect().top,
          });
          if (!shown || frames.length > 600) return resolve(frames);
          requestAnimationFrame(sample);
        };
        sample();
      }),
  );
}

test("Latest fades out in place and rises back in", async ({ page }) => {
  await openChat(page, "mock-long");
  await send(page, canary("in"));
  const thread = page.getByRole("log").locator(":scope > div").first();
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight > node.clientHeight * 2))
    .toBe(true);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await thread.hover();
  await page.mouse.wheel(0, -600);
  const latest = page.getByRole("button", { name: "Latest" });
  await expect(latest).toBeVisible();
  const wrapper = page
    .getByRole("button", { name: "Latest", includeHidden: true })
    .locator("xpath=..");
  await expect.poll(() => wrapper.evaluate((node) => node.getAnimations().length)).toBe(0);
  const leaving = latestFrames(wrapper);
  await latest.click();
  const frames = await leaving;
  // Still drawn after it was hidden, fading and out of reach, then gone: it was never removed.
  const fading = frames.filter((frame) => frame.hidden && frame.shown);
  expect(fading.length).toBeGreaterThan(1);
  for (const frame of fading) expect(frame.inert).toBe(true);
  expect(fading.some((frame) => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  // In place: it fades where it stood, without drifting.
  const resting = frames[0]?.top ?? Number.NaN;
  for (const frame of fading) expect(Math.abs(frame.top - resting)).toBeLessThan(0.5);
  expect(frames.at(-1)?.shown).toBe(false);
  await expect(wrapper).toHaveCount(1);
  await expect(latest).toBeHidden();
  // Scrolled away again, the same control rises back in.
  await thread.hover();
  await page.mouse.wheel(0, -600);
  await expect(latest).toBeVisible();
  await expect(wrapper).not.toHaveAttribute("hidden");
});
