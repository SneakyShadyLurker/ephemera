import { deflateSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { pngChunk } from "../apps/server/test/image-fixtures.ts";
import { CONTRAST_FLOORS, paletteProperty, WASH_OPACITY } from "../packages/core/src/palettes.ts";
import { importCards, pngCard, uniqueName, v3 } from "./support/cards.ts";
import {
  browserStorage,
  chooseCharacter,
  chooseModel,
  clearChat,
  lastReply,
  messages,
  moreAction,
  openChat,
  send,
  turns,
} from "./support/chat.ts";
import {
  createCharacterViaApi,
  expectNoOverflow,
  FORM_FACTORS,
  loreEntry,
  seriousAxeViolations,
  setLorebookViaApi,
  setPortraitViaApi,
  tabTo,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

/**
 * The page clips what overflows, so the composer is measured against the
 * viewport, and the last reply's actions keep each divider between two groups
 * on one line, never leading a line of its own.
 */
async function expectComposerAndActionsFit(page: Page, width: number) {
  const composer = await page.getByLabel("Message", { exact: true }).locator("..").boundingBox();
  expect(composer?.x).toBeGreaterThanOrEqual(0);
  expect((composer?.x ?? 0) + (composer?.width ?? Infinity)).toBeLessThanOrEqual(width);
  const strays = await page.locator("[data-reply-actions]").evaluate((bar) => {
    const buttons = [...bar.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    return [...bar.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
      .map((el) => el.getBoundingClientRect())
      .filter((d) => d.width > 0 && d.width <= 1)
      .filter(
        (d) => !buttons.some((b) => b.right <= d.left && b.bottom > d.top && b.top < d.bottom),
      ).length;
  });
  expect(strays).toBe(0);
}

for (const { name, width, height } of FORM_FACTORS) {
  test(`the ${name} layout fits, and navigation and Session are reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectComposerAndActionsFit(page, width);

    if (name === "phone") {
      await page.getByRole("button", { name: "Open navigation" }).click();
      const sheet = page.getByRole("dialog", { name: "Ephemera" });
      // Headed like every sheet: its title, then the close control.
      await sheet.getByRole("button", { name: "Close navigation" }).click();
      await expect(sheet).toHaveCount(0);
      await page.getByRole("button", { name: "Open navigation" }).click();
      await sheet.getByRole("link", { name: "Characters" }).click();
      await expect(sheet).toHaveCount(0);
    } else {
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Characters" })
        .click();
    }
    await expect(page.getByRole("heading", { level: 1, name: "Characters" })).toBeVisible();
    await page.goBack();
    // Returning to the chat keeps it: the chat lives in memory, not in the route.
    await expect(messages(page)).toHaveCount(2);

    const toggle = page.getByRole("button", { name: "Session", exact: true });
    // The docked panel stays open after choosing the model; sheets close.
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    const session =
      name === "desktop"
        ? page.getByRole("complementary", { name: "Session" })
        : page.getByRole("dialog", { name: "Session" });
    await expect(session.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
      "mock-fast",
    );
  });
}

test.describe("on a touch phone", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("the composer and reply actions fit with touch-sized controls", async ({ page }) => {
    await openChat(page, "mock-fast");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expectComposerAndActionsFit(page, 390);
  });
});

/** The computed type of the first element `selector` matches inside `scope`. */
const typeOf = (scope: Locator, selector: string) =>
  scope
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        family: style.fontFamily,
        size: style.fontSize,
        leading: style.lineHeight,
        color: style.color,
      };
    });

/** A palette token resolved to the computed colour it paints in the current scheme. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

for (const { name, width, height, story } of [
  { ...FORM_FACTORS[0], story: { size: "17px", leading: "28px" } },
  { ...FORM_FACTORS[2], story: { size: "18px", leading: "30px" } },
]) {
  test(`the character speaks in the story face and the owner in the interface sans (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openChat(page, "mock-fast");
    await send(page, `${canary("in")} *leans closer*`);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

    const reply = lastReply(page).locator('[data-prose][data-voice="story"]');
    const line = page
      .locator('[data-message][data-role="user"]')
      .last()
      .locator('[data-prose][data-voice="line"]');
    const told = await tokenColor(page, "--ink-narration");
    const narration = await tokenColor(page, "--narration");
    const ink = await tokenColor(page, "--ink");

    const prose = await typeOf(reply, "p");
    expect(prose.family).toMatch(/^"Atkinson Hyperlegible Next Variable"/);
    // The mock's reply is unmarked narration, in the scene's narration ink.
    expect(prose).toMatchObject({ ...story, color: told });

    const said = await typeOf(line, "p");
    expect(said.family).toMatch(/^"Geist Variable"/);
    expect(said).toMatchObject({ size: "16px", leading: "26px", color: ink });
    // The owner's narration is a step quieter than what they say.
    expect((await typeOf(line, "em")).color).toBe(narration);

    // Told apart at a glance: the owner's line is a slip on the surface at the trailing
    // edge of the story, the character's prose open on the canvas from its leading edge.
    const [slip, open, turn] = await Promise.all([
      line.boundingBox(),
      reply.boundingBox(),
      lastReply(page).boundingBox(),
    ]);
    if (!slip || !open || !turn) throw new Error("turns are not laid out");
    expect(Math.abs(slip.x + slip.width - (turn.x + turn.width))).toBeLessThan(1);
    expect(slip.x).toBeGreaterThan(turn.x + 24);
    expect(Math.abs(open.x - turn.x)).toBeLessThan(1);
    const fill = (locator: typeof line) =>
      locator.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await fill(line)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await fill(reply)).toBe("rgba(0, 0, 0, 0)");

    // The face itself arrived: the story face is Atkinson Hyperlegible Next, not a fallback.
    const face = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        // check() is also true when no face of the family exists, so a loaded face is required too.
        loaded: [...document.fonts].some(
          (f) =>
            f.family.replaceAll('"', "") === "Atkinson Hyperlegible Next Variable" &&
            f.status === "loaded",
        ),
        ready: document.fonts.check('18px "Atkinson Hyperlegible Next Variable"'),
      };
    });
    expect(face).toEqual({ loaded: true, ready: true });

    // Editing the reply keeps its voice: the field is set as the prose it holds.
    await moreAction(page, page.locator("[data-reply-actions]"), "Edit");
    const field = await typeOf(lastReply(page), "textarea");
    expect(field).toMatchObject({ family: prose.family, size: story.size, leading: story.leading });
  });
}

test("the tablet rail's labels sit inside their rows with room to spare", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/");
  const rows = page.getByRole("navigation", { name: "Main" }).getByRole("link");
  // Chat, Characters, Personas, Lorebooks, Presets and Settings.
  await expect(rows).toHaveCount(6);
  // Measured in Geist, not the fallback face shown while it loads.
  const loaded = await page.evaluate(
    async () => (await document.fonts.load('500 11px "Geist Variable"')).length,
  );
  expect(loaded).toBeGreaterThan(0);
  const gaps = await rows.evaluateAll((links) =>
    links.map((link) => {
      const box = link.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(link);
      const words = [...text.getClientRects()].filter((r) => r.height < 20).at(-1);
      return words ? Math.min(words.left - box.left, box.right - words.right) : -1;
    }),
  );
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(4);
});

test("the app icon is served and follows the color scheme", async ({ page }) => {
  const inkByScheme: Record<string, number[]> = {};
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    const hrefs = await page
      .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) expect((await page.request.get(href)).ok()).toBe(true);
    // A point inside the crescent's thick left side.
    inkByScheme[colorScheme] = await page.evaluate(async () => {
      const image = new Image();
      image.src = document.querySelector<HTMLLinkElement>('link[type="image/svg+xml"]')?.href ?? "";
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d");
      context?.drawImage(image, 0, 0, 64, 64);
      return [...(context?.getImageData(7, 33, 1, 1).data ?? [])];
    });
  }
  expect(inkByScheme).toEqual({ light: [0x2a, 0x23, 0x1e, 255], dark: [0xed, 0xe4, 0xd6, 255] });
});

/**
 * The one dripping mark, at the top of the interface: the rail's mark, or on
 * a phone the mark that opens navigation, which keeps dripping alone while
 * the sheet is open.
 */
async function navigationMark(page: Page, phone: boolean) {
  await page.goto("/");
  const marks = page.locator(".lamplight-mark");
  await expect(marks).toHaveCount(1);
  if (phone) {
    const button = page.getByRole("button", { name: "Open navigation" });
    // Found by CSS, since the open sheet hides the header from the accessibility tree.
    const mark = page.locator("header .lamplight-mark");
    await expect(button.locator(".lamplight-mark")).toHaveCount(1);
    // At the top of the screen, in the header row.
    const box = await mark.boundingBox();
    expect((box?.y ?? Infinity) + (box?.height ?? 0) / 2).toBeLessThan(56);
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Ephemera" });
    await expect(sheet.getByRole("link", { name: "Characters" })).toBeVisible();
    await expect(sheet.locator(".lamplight-mark")).toHaveCount(0);
    await expect(marks).toHaveCount(1);
    return mark;
  }
  const navigation = page.getByRole("navigation", { name: "Main" });
  const mark = navigation.locator(".lamplight-mark");
  await expect(mark).toHaveCount(1);
  // In the navigation, above its destinations.
  const above = await navigation.evaluate((nav) => {
    const drawing = nav.querySelector(".lamplight-mark")?.getBoundingClientRect();
    const first = nav.querySelector("a")?.getBoundingClientRect();
    return drawing && first ? drawing.y + drawing.height < first.y : false;
  });
  expect(above).toBe(true);
  return mark;
}

for (const { name, width, height } of FORM_FACTORS) {
  test(`the mark has no halo: its lamp's light drips down the trail in a seamless loop, and holds still under reduced motion (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const mark = await navigationMark(page, name === "phone");
    // Nothing is drawn beside the drawing: no halo, no wrapper of its own.
    expect(await mark.evaluate((svg) => svg.parentElement?.children.length)).toBe(1);
    const loop = await mark.evaluate(async (svg) => {
      const lamp = svg.querySelector("[data-lamp]");
      const dots = [...svg.querySelectorAll(".lamplight-drip")];
      const [dot] = dots;
      const [animation] = dot?.getAnimations() ?? [];
      const effect = animation?.effect;
      const frames = effect instanceof KeyframeEffect ? effect.getKeyframes() : [];
      const at = (offset: number) => frames.find((f) => f.computedOffset === offset);
      // It runs by itself: the timeline advances across a few frames.
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const started = Number(animation?.currentTime);
      for (let i = 0; i < 5; i++) await frame();
      const advanced = Number(animation?.currentTime) - started;
      const playState = animation?.playState;
      // The dot sampled with the loop paused at a given moment of its cycle (after its delay).
      const delay = Number(effect?.getTiming().delay);
      const sample = (ms: number) => {
        if (animation) {
          animation.pause();
          animation.currentTime = delay + ms;
        }
        const style = dot ? getComputedStyle(dot) : undefined;
        return { fill: style?.fill, opacity: style?.opacity };
      };
      return {
        dots: dots.length,
        lampAnimations: lamp?.getAnimations().length,
        animations: svg.getAnimations({ subtree: true }).length,
        name: animation instanceof CSSAnimation ? animation.animationName : "",
        duration: effect?.getComputedTiming().duration,
        iterations: effect?.getComputedTiming().iterations,
        delay,
        playState,
        advanced,
        first: { fill: at(0)?.fill, opacity: at(0)?.opacity },
        last: { fill: at(1)?.fill, opacity: at(1)?.opacity },
        rest: sample(0),
        lit: sample(300),
        lamp: lamp ? getComputedStyle(lamp).fill : null,
      };
    });
    // The interface's small cut has one trail dot; it drips 0.18 s after the lamp.
    expect(loop).toMatchObject({
      dots: 1,
      lampAnimations: 0,
      animations: 1,
      name: "lamplight-drip",
      duration: 6000,
      iterations: Infinity,
      delay: 180,
      playState: "running",
    });
    expect(loop.advanced).toBeGreaterThan(0);
    // No seam: the loop ends where it starts, at the crescent's colour, dimmed.
    expect(loop.first).toEqual(loop.last);
    expect(loop.rest.opacity).toBe("0.6");
    // For a beat the dot takes the lamp's light, at full strength.
    expect(loop.lit).toEqual({ fill: loop.lamp, opacity: "1" });

    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = await (await navigationMark(page, name === "phone")).evaluate((svg) => {
      const dot = svg.querySelector(".lamplight-drip");
      return {
        animations: svg.getAnimations({ subtree: true }).length,
        opacity: dot ? getComputedStyle(dot).opacity : null,
      };
    });
    // Still, at the loop's resting frame, so switching the preference never jumps.
    expect(still).toEqual({ animations: 0, opacity: "0.6" });
  });
}

test("reduced motion removes movement and keeps fades short", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openChat(page, "mock-slow");
  await send(page, canary("in"));
  await expect(lastReply(page)).toContainText("Reply:");
  const motion = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const caret = document.querySelector('[data-status="streaming"] .caret-after > :last-child');
    return {
      rise: root.getPropertyValue("--rise").trim(),
      panelShift: root.getPropertyValue("--panel-shift").trim(),
      pressScale: root.getPropertyValue("--press-scale").trim(),
      caretAnimation: caret ? getComputedStyle(caret, "::after").animationName : "missing",
    };
  });
  expect(motion).toEqual({
    rise: "0px",
    panelShift: "0px",
    pressScale: "1",
    caretAnimation: "none",
  });
  // Streamed words appear at once.
  const word = page.locator('[data-status="streaming"] [data-sd-animate]').first();
  await expect(word).toHaveCSS("animation-name", "none");
});

const focusRing = (target: Locator) =>
  target.evaluate((node) => {
    const style = getComputedStyle(node);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });

test("every action works by keyboard alone, with visible focus", async ({ page }) => {
  await page.goto("/");
  const message = page.getByLabel("Message", { exact: true });
  await expect(message).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(message).toBeFocused();

  // Session by Tab, the model by arrow keys, Escape to close.
  const toggle = page.getByRole("button", { name: "Session", exact: true });
  await tabTo(page, toggle, { backward: true });
  expect(await focusRing(toggle)).toBe("solid 2px");
  await page.keyboard.press("Enter");
  const session = page.getByRole("dialog", { name: "Session" });
  const model = session.getByRole("combobox", { name: "Model", exact: true });
  await tabTo(page, model);
  expect(await focusRing(model)).toBe("solid 2px");
  await page.keyboard.press("Enter");
  const option = page.getByRole("option", { name: "mock-slow", exact: true });
  await expect(option).toBeVisible();
  while (!(await option.evaluate((node) => node.hasAttribute("data-highlighted")))) {
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
  await expect(model).toHaveText("mock-slow");
  await page.keyboard.press("Escape");
  await expect(session).toHaveCount(0);

  // The shortcut toggles Session too.
  await page.keyboard.press("Control+.");
  await expect(session).toBeVisible();
  // Escape goes where focus is, so it waits for focus to land in Session.
  await expect.poll(() => session.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(session).toHaveCount(0);

  // Send with Enter, stop with Escape.
  await tabTo(page, message);
  await page.keyboard.type(canary("in"));
  await page.keyboard.press("Enter");
  await expect(lastReply(page)).toContainText("Reply:");
  await page.keyboard.press("Escape");
  await expect(lastReply(page)).toHaveAttribute("data-status", "stopped");

  // Stop from its button hands focus back to the message field.
  await page.keyboard.type(canary("in"));
  await page.keyboard.press("Enter");
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeEnabled();
  await tabTo(page, stop);
  await page.keyboard.press("Enter");
  await expect(lastReply(page)).toHaveAttribute("data-status", "stopped");
  await expect(message).toBeFocused();

  // Clear, confirmed from the keyboard, leaves focus in the message field.
  const clear = page.getByRole("button", { name: "Clear" });
  await tabTo(page, clear, { backward: true });
  expect(await focusRing(clear)).toBe("solid 2px");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog", { name: "Clear this chat?" });
  await expect(dialog.getByRole("button", { name: "Keep chatting" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(turns(page)).toHaveCount(0);
  await expect(message).toBeFocused();

  // Theme and navigation from the rail, reached by Tab.
  const dark = page.getByRole("button", { name: "Dark" });
  await tabTo(page, page.getByRole("button", { name: "Match system" }));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(dark).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  const presets = page.getByRole("link", { name: "Presets" });
  await tabTo(page, presets, { backward: true });
  expect(await focusRing(presets)).toBe("solid 2px");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Presets" })).toBeVisible();
});

/** The thread's scroll container, owned by the Conversation component. */
const scroller = (page: Page) => page.getByRole("log").locator(":scope > div").first();

test("scrolling stays anchored while a reply streams", async ({ page }) => {
  await openChat(page, "mock-long");
  await send(page, canary("in"));
  const thread = scroller(page);
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight > node.clientHeight * 2))
    .toBe(true);

  // At the bottom, the view follows the new text.
  const gap = () =>
    thread.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  await expect.poll(gap).toBeLessThan(4);

  // Scrolled up, the visible line keeps its place while text keeps arriving.
  await thread.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole("button", { name: "Latest" })).toBeVisible();
  const anchor = lastReply(page).locator("p").nth(3);
  const before = await anchor.boundingBox();
  const heightBefore = await thread.evaluate((node) => node.scrollHeight);
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight))
    .toBeGreaterThan(heightBefore + 100);
  expect((await anchor.boundingBox())?.y).toBeCloseTo(before?.y ?? Number.NaN, 0);

  await page.getByRole("button", { name: "Latest" }).click();
  await expect.poll(gap).toBeLessThan(4);
  await expect(page.getByRole("button", { name: "Latest" })).toHaveCount(0);
});

test("sending from a scrolled-away story brings the view back to the new reply", async ({
  page,
}) => {
  await openChat(page, "mock-long");
  await send(page, canary("in"));
  const thread = scroller(page);
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight > node.clientHeight * 2))
    .toBe(true);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);

  await thread.hover();
  await page.mouse.wheel(0, -1200);
  const latest = page.getByRole("button", { name: "Latest" });
  await expect(latest).toBeVisible();

  // The owner's own line and the reply to it come into view and are followed again.
  await chooseModel(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(4);
  await expect(latest).toHaveCount(0);
});

test("returning to a story mid-reply lands on the newest text without sliding through it", async ({
  page,
}) => {
  await openChat(page, "mock-long");
  await send(page, canary("in"));
  const thread = scroller(page);
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight > node.clientHeight * 2))
    .toBe(true);
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Presets" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Presets" })).toBeVisible();

  // Distinguish traversal through existing history from text arriving before the next frame.
  await page.evaluate(() => {
    const measurement = {
      initialBottom: null as number | null,
      samples: [] as { top: number; gap: number; growth: number }[],
    };
    let container: HTMLElement | null = null;
    let previousHeight = 0;
    const observer = new MutationObserver(() => {
      if (container) return;
      container = document.querySelector<HTMLElement>('[role="log"] > div');
      if (!container) return;
      previousHeight = container.scrollHeight;
      measurement.initialBottom = previousHeight - container.clientHeight;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const onScroll = ({ target }: Event) => {
      if (target !== container || !container) return;
      const height = container.scrollHeight;
      measurement.samples.push({
        top: container.scrollTop,
        gap: height - container.scrollTop - container.clientHeight,
        growth: Math.max(0, height - previousHeight),
      });
      previousHeight = height;
    };
    document.addEventListener("scroll", onScroll, true);
    (
      window as unknown as { __finishScrollMeasurement: () => typeof measurement }
    ).__finishScrollMeasurement = () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      return measurement;
    };
  });
  await nav.getByRole("link", { name: "Chat" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect
    .poll(() => thread.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(4);
  const measurement = await page.evaluate(() =>
    (
      window as unknown as {
        __finishScrollMeasurement: () => {
          initialBottom: number | null;
          samples: { top: number; gap: number; growth: number }[];
        };
      }
    ).__finishScrollMeasurement(),
  );
  expect(measurement.samples.length).toBeGreaterThan(0);
  expect(measurement.initialBottom).not.toBeNull();
  expect(measurement.samples[0]?.top).toBeGreaterThanOrEqual(
    (measurement.initialBottom ?? Number.POSITIVE_INFINITY) - 4,
  );
  expect(
    Math.max(...measurement.samples.map(({ gap, growth }) => Math.max(0, gap - growth))),
  ).toBeLessThan(4);
});

test("streaming leaves earlier turns untouched and shifts no layout", async ({ page }) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await chooseModel(page, "mock-long");

  await page.evaluate(() => {
    const record = window as unknown as {
      __mutations: number;
      __shift: number;
      __shifted: string[];
    };
    record.__mutations = 0;
    record.__shift = 0;
    record.__shifted = [];
    for (const turn of document.querySelectorAll("[data-message]")) {
      new MutationObserver((changes) => {
        record.__mutations += changes.length;
      }).observe(turn, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
        sources: {
          node: Node | null;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }[];
      }[]) {
        if (entry.hadRecentInput) continue;
        // The meter's count changes digits inside its fixed box by design; an entry whose every
        // source is that box, unmoved, is the only one not counted.
        const meterOnly =
          entry.sources.length > 0 &&
          entry.sources.every(({ node, previousRect: from, currentRect: to }) => {
            const element = node instanceof Element ? node : node?.parentElement;
            return (
              element?.closest("[data-meter-count]") != null &&
              from.x === to.x &&
              from.y === to.y &&
              from.width === to.width &&
              from.height === to.height
            );
          });
        if (!meterOnly) record.__shift += entry.value;
        // What moved, for the failure message.
        for (const { node, previousRect: from, currentRect: to } of entry.sources) {
          const element = node instanceof Element ? node : node?.parentElement;
          record.__shifted.push(
            `${element?.tagName ?? "?"}.${String(element?.className).slice(0, 60)} "${(element?.textContent ?? "").slice(0, 30)}" ${from.x},${from.y},${from.width}x${from.height} -> ${to.x},${to.y},${to.width}x${to.height}`,
          );
        }
      }
    }).observe({ type: "layout-shift" });
  });

  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  const measured = await page.evaluate(() => {
    const record = window as unknown as {
      __mutations: number;
      __shift: number;
      __shifted: string[];
    };
    return { mutations: record.__mutations, shift: record.__shift, shifted: record.__shifted };
  });
  expect(
    { mutations: measured.mutations, shift: measured.shift },
    measured.shifted.join("\n"),
  ).toEqual({ mutations: 0, shift: 0 });
});

test("turns moved by a deletion and its Undo keep their own text, and the next reply streams into its own", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const lines = [canary("in"), canary("in"), canary("in")];
  for (const line of lines) {
    await send(page, line);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  }
  const said = page.locator('[data-message][data-role="user"] [data-prose]');
  const replies = page.locator('[data-message][data-role="assistant"] [data-prose]');
  await expect(said).toHaveText(lines);
  const answered = await replies.allInnerTexts();
  expect(answered).toHaveLength(3);

  // Every later turn moves up one place, and still shows itself.
  await moreAction(page, turns(page).first(), "Delete");
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  await expect(said).toHaveText(lines.slice(1));
  await expect(replies).toHaveText(answered, { useInnerText: true });
  await undo.click();
  await expect(said).toHaveText(lines);
  await expect(replies).toHaveText(answered, { useInnerText: true });

  const next = canary("in");
  await send(page, next);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(said).toHaveText([...lines, next]);
  await expect(replies).toHaveCount(4);
  expect((await replies.allInnerTexts()).slice(0, 3)).toEqual(answered);
});

/** A card with art and no greeting, imported as the owner would. */
async function characterWithArt(page: Page) {
  const name = uniqueName("Wren");
  await importCards(page, [
    await pngCard("wren.png", { spec: "chara_card_v3", spec_version: "3.0", data: { name } }),
  ]);
  return name;
}

for (const { name, width, height, portrait } of [
  { ...FORM_FACTORS[0], portrait: 96 },
  { ...FORM_FACTORS[1], portrait: 112 },
  { ...FORM_FACTORS[2], portrait: 160 },
]) {
  test(`the character is present once, at the head of the latest reply or above the story, and scrolls with it (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const character = await characterWithArt(page);
    await openChat(page, "mock-long");
    await chooseCharacter(page, character);
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });

    // One portrait on the page: above the story on phones, its name beside it; from tablet up
    // at the head of the latest reply, the header naming the character.
    const presence = page.locator("[data-presence]");
    await expect(presence).toHaveCount(1);
    const image = presence.locator("img");
    await expect(image).toHaveJSProperty("complete", true);
    expect((await image.boundingBox())?.width).toBe(portrait);
    if (name === "phone") {
      await expect(presence).toContainText(character);
      await expect(messages(page).locator("img")).toHaveCount(0);
    } else {
      await expect(lastReply(page).locator("[data-presence] img")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }

    const thread = scroller(page);
    expect(await thread.evaluate((node) => node.scrollHeight > node.clientHeight + 1_200)).toBe(
      true,
    );
    const scrollTo = (top: number) =>
      thread.evaluate((node, to) => node.scrollTo({ top: to }), top);
    const top = async () => (await image.boundingBox())?.y ?? Number.NaN;

    // Deep inside the long reply, its nameplate is still there, 12px below the story's top edge.
    const view = await thread.evaluate((node) => {
      const reply = [...node.querySelectorAll('[data-role="assistant"]')].at(-1);
      const edge = node.getBoundingClientRect().top;
      return { edge, reply: (reply?.getBoundingClientRect().top ?? 0) - edge + node.scrollTop };
    });
    await scrollTo(view.reply + 600);
    const nameplate = lastReply(page).locator("[data-speaker]");
    await expect(nameplate).toContainText(character);
    await expect
      .poll(async () => ((await nameplate.boundingBox())?.y ?? Number.NaN) - view.edge)
      .toBeCloseTo(12, 0);

    if (name === "phone") {
      // The band scrolls away with the story; the header's portrait takes over only once the
      // band's portrait has left the view, never while any of it shows.
      const header = page.locator("header [data-presence-header]");
      const opacity = () => header.evaluate((node) => Number(getComputedStyle(node).opacity));
      await scrollTo(0);
      await expect.poll(opacity).toBe(0);
      const band = await image.boundingBox();
      const scrollerTop = (await thread.boundingBox())?.y ?? 0;
      const bandBottom = (band?.y ?? 0) + (band?.height ?? 0) - scrollerTop;
      // Halfway out: still in view, so the header's portrait is not yet whole.
      await scrollTo(bandBottom - (band?.height ?? 0) / 2);
      await expect.poll(opacity).toBeLessThan(1);
      await scrollTo(bandBottom + 600);
      await expect.poll(opacity).toBe(1);
      expect(await top()).toBeLessThan(scrollerTop - (band?.height ?? 0));
      // In the header row, 32 by 48.
      const small = await header.locator("img").boundingBox();
      expect(small).toMatchObject({ width: 32, height: 48 });
      expect((small?.y ?? Infinity) + (small?.height ?? 0)).toBeLessThanOrEqual(56);
    } else {
      // It scrolls with the story instead of holding a place in the view.
      await scrollTo(1_200);
      const held = await top();
      await scrollTo(600);
      await expect.poll(top).toBeCloseTo(held + 600, 0);
      // The reply wraps around it: lines beside it start past its trailing edge, lines below
      // it at the turn's leading edge.
      await scrollTo(1_000_000);
      const wrap = await lastReply(page).evaluate((turn) => {
        const art = turn.querySelector("[data-presence] img")?.getBoundingClientRect();
        const lines = [...turn.querySelectorAll('[data-prose][data-voice="story"] p')].map(
          (paragraph) => {
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            const first = range.getClientRects()[0];
            return { x: first?.left ?? Number.NaN, y: first?.top ?? Number.NaN };
          },
        );
        return { art, turn: turn.getBoundingClientRect().left, lines };
      });
      if (wrap.art === undefined) throw new Error("the portrait is not in the latest reply");
      const art = wrap.art;
      const beside = wrap.lines.filter((line) => line.y < art.bottom);
      const below = wrap.lines.filter((line) => line.y > art.bottom);
      expect(beside.length).toBeGreaterThan(0);
      expect(below.length).toBeGreaterThan(0);
      for (const line of beside) expect(line.x).toBeGreaterThan(art.right);
      for (const line of below) expect(line.x).toBeCloseTo(wrap.turn, 0);
      // Nothing in the header repeats the portrait; the title names the character.
      await expect(page.locator("header [data-presence-header]")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(character);
    }
    if (name === "desktop") {
      // With the docked Session closed the chat column is wide: a larger portrait, and the
      // story spans the column but for its padding.
      await page.getByRole("button", { name: "Session", exact: true }).click();
      await expect.poll(async () => (await image.boundingBox())?.width).toBe(224);
      const column = await thread.boundingBox();
      const turn = await lastReply(page).boundingBox();
      if (!column || !turn) throw new Error("the story is not laid out");
      expect(turn.width).toBeGreaterThan(column.width - 180);
    }
  });
}

for (const { name, width, height } of [FORM_FACTORS[0], FORM_FACTORS[2]]) {
  test(`the portrait opens at full size and lays back in its place by Close, a click beside it or Escape (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const character = await characterWithArt(page);
    await openChat(page, "mock-fast");
    await chooseCharacter(page, character);

    // A CSS locator, as the modal viewer hides the rest of the page from the accessibility tree.
    const trigger = page.locator(`button[aria-label="Portrait of ${character}: show larger"]`);
    const viewer = page.getByRole("dialog", { name: `Portrait of ${character}` });
    const open = async () => {
      await trigger.click();
      await expect(viewer).toBeVisible();
      // Its place stays empty while the art is out.
      await expect(trigger).toHaveCSS("visibility", "hidden");
    };
    const closed = async () => {
      await expect(viewer).toHaveCount(0);
      await expect(trigger).toHaveCSS("visibility", "visible");
      await expect(trigger).toBeFocused();
    };

    // The art travels between its place and the viewer: one morph out, one back.
    await page.evaluate(() => {
      const record = window as unknown as { __morphs: string[] };
      record.__morphs = [];
      let last: Animation | undefined;
      const watch = () => {
        const morph = document.documentElement
          .getAnimations({ subtree: true })
          .find(
            (animation) =>
              animation.effect instanceof KeyframeEffect &&
              animation.effect.pseudoElement === "::view-transition-group(portrait-viewer)",
          );
        if (morph !== undefined && morph !== last) record.__morphs.push(morph.playState);
        last = morph;
        requestAnimationFrame(watch);
      };
      watch();
    });
    const morphs = () =>
      page.evaluate(() => (window as unknown as { __morphs: string[] }).__morphs.length);

    await open();
    await expect.poll(morphs).toBe(1);
    const full = viewer.locator('img[src*="size=full"]');
    await expect(full).toHaveJSProperty("complete", true);
    expect(await full.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    // Larger than its place, within the view.
    const box = await full.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(height / 2);
    expect((box?.y ?? -1) >= 0 && (box?.y ?? 0) + (box?.height ?? Infinity) <= height).toBe(true);
    // A click on the art itself keeps it open.
    await full.click();
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "Close the portrait" }).click();
    await closed();
    await expect.poll(morphs).toBe(2);

    await open();
    await page.mouse.click(4, height - 4);
    await closed();

    await open();
    await page.keyboard.press("Escape");
    await closed();

    // Session's shortcut waits while the viewer is open.
    await open();
    await page.keyboard.press("Control+.");
    await expect(page.getByRole("dialog", { name: "Session" })).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await closed();
  });
}

test("an open portrait stays open, and keeps focus, when the greeting arrives beneath it (desktop)", async ({
  page,
}) => {
  const { width, height } = FORM_FACTORS[2];
  await page.setViewportSize({ width, height });
  const character = uniqueName("Wren");
  await importCards(page, [
    await pngCard("wren.png", v3({ name: character, first_mes: "The lamp turns overhead." })),
  ]);
  await openChat(page, "mock-fast");
  // The greeting waits for the whole card, the portrait only for the gallery's list: the card
  // waits until the viewer is open.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/characters/*", async (route) => {
    await held;
    await route.continue();
  });
  await chooseCharacter(page, character);
  const greeting = messages(page).first();
  const trigger = page.locator(`button[aria-label="Portrait of ${character}: show larger"]`);
  const viewer = page.getByRole("dialog", { name: `Portrait of ${character}` });
  await trigger.click();
  await expect(viewer).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest("[data-portrait-viewer]") != null),
    )
    .toBe(true);
  await expect(messages(page)).toHaveCount(0);
  release();
  await expect(greeting).toContainText("The lamp turns overhead.");
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // Once focus leaves it, it takes its place at the head of the greeting.
  await expect(greeting.locator("[data-presence]")).toHaveCount(0);
  await page.getByLabel("Message", { exact: true }).focus();
  await expect(greeting.locator("[data-presence]")).toHaveCount(1);
  await expect(page.locator("[data-presence]")).toHaveCount(1);
});

for (const { name, width, height } of [FORM_FACTORS[1], FORM_FACTORS[2]]) {
  test(`the portrait opens a lone greeting level with its first line, its text beside it (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const character = uniqueName("Wren");
    await importCards(page, [
      await pngCard("wren.png", v3({ name: character, first_mes: "The lamp turns overhead." })),
    ]);
    await openChat(page, "mock-fast");
    await chooseCharacter(page, character);
    const greeting = messages(page).first();
    await expect(greeting).toContainText("The lamp turns overhead.");
    const image = greeting.locator("[data-presence] img");
    await expect(image).toHaveJSProperty("complete", true);
    const art = await image.boundingBox();
    const prose = await greeting.locator('[data-prose][data-voice="story"] p').evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      return { x: box.left, y: box.top };
    });
    if (!art) throw new Error("the portrait is not laid out");
    expect(prose.x).toBeGreaterThan(art.x + art.width);
    expect(Math.abs(art.y - prose.y)).toBeLessThanOrEqual(8);
  });
}

test("the portrait moves to each new reply as it starts, and stays above an Undo (desktop)", async ({
  page,
}) => {
  const { width, height } = FORM_FACTORS[2];
  await page.setViewportSize({ width, height });
  const character = uniqueName("Wren");
  await importCards(page, [
    await pngCard("wren.png", v3({ name: character, first_mes: "The lamp turns overhead." })),
  ]);
  await openChat(page, "mock-slow");
  await chooseCharacter(page, character);
  const presence = page.locator("[data-presence]");
  await expect(messages(page).first().locator("[data-presence] img")).toHaveJSProperty(
    "complete",
    true,
  );
  await send(page, canary("in"));
  // While the reply streams the portrait already heads it, and only it.
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect(lastReply(page).locator("[data-presence]")).toHaveCount(1);
  await expect(presence).toHaveCount(1);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  await expect(lastReply(page).locator("[data-presence]")).toHaveCount(1);

  // The Undo a deleted alternate leaves below the reply does not take it.
  const actions = page.locator("[data-reply-actions]");
  await actions.getByRole("button", { name: "New reply" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  await actions.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete this alternate" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(presence).toHaveCount(1);
  await expect(lastReply(page).locator("[data-presence]")).toHaveCount(1);
});

test("a single greeting has no actions row; its own More holds Edit and Delete by keyboard", async ({
  page,
}) => {
  const character = uniqueName("Wren");
  await importCards(page, [
    await pngCard("wren.png", v3({ name: character, first_mes: "The lamp turns overhead." })),
  ]);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  await expect(messages(page).first()).toContainText("The lamp turns overhead.");
  await expect(page.locator("[data-reply-actions]")).toHaveCount(0);
  const more = page.getByRole("button", { name: `More actions, ${character}'s greeting` });
  await page.getByLabel("Message", { exact: true }).focus();
  await tabTo(page, more, { backward: true });
  expect(await focusRing(more)).toBe("solid 2px");
  // Revealed by focus on fine pointers.
  await expect(more.locator("..")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toBeFocused();
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

test("on a short window a long greeting menu scrolls within the window, its last greeting in reach", async ({
  page,
}) => {
  const character = uniqueName("Wren");
  const greetings = Array.from({ length: 12 }, (_, at) => `Greeting line ${at + 1} by the lamp.`);
  await importCards(page, [
    await pngCard(
      "wren.png",
      v3({ name: character, first_mes: greetings[0], alternate_greetings: greetings.slice(1) }),
    ),
  ]);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, character);
  const { width } = page.viewportSize() ?? FORM_FACTORS[2];
  await page.setViewportSize({ width, height: 320 });

  const trigger = page.getByRole("button", { name: "Greeting 1 of 12" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Greetings" });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? Infinity)).toBeLessThanOrEqual(320);
  await menu.getByRole("menuitemradio", { name: /line 12 by/ }).click();
  await expect(messages(page).first()).toContainText("Greeting line 12 by the lamp.");
  await expect(page.getByRole("button", { name: "Greeting 12 of 12" })).toBeVisible();
});

test("without a character the empty chat invites the first line, then offers a character, then says nothing is kept", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const story = page.getByRole("log", { name: "Story" });
  const said = await story.evaluate((node) =>
    [...node.querySelectorAll("p, button")]
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => text !== ""),
  );
  expect(said).toEqual([
    "Write the first line, or choose a character.",
    "Choose a character",
    "This conversation isn't saved. Refreshing or closing this tab clears it.",
  ]);
  const message = page.getByLabel("Message", { exact: true });
  await expect(message).toHaveAttribute("placeholder", "Write the first line");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(message).toHaveAttribute("placeholder", "Write your reply");
});

test("a long unbroken word in the owner's line wraps inside its slip and leaves the story's width alone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const before = await lastReply(page).boundingBox();
  await send(page, "o".repeat(240));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const after = await lastReply(page).boundingBox();
  expect(after?.width).toBe(before?.width);
  const slip = await page.locator('[data-prose][data-voice="line"]').last().boundingBox();
  if (!slip || !after) throw new Error("turns are not laid out");
  expect(slip.x).toBeGreaterThan(after.x);
  expect(Math.abs(slip.x + slip.width - (after.x + after.width))).toBeLessThan(1);
  const thread = scroller(page);
  expect(await thread.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("on a phone the story and the composer keep 20px margins", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page, "mock-long");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  const composer = await page.getByLabel("Message", { exact: true }).locator("..").boundingBox();
  expect(composer?.x).toBe(20);
  expect((composer?.x ?? 0) + (composer?.width ?? 0)).toBe(370);
  // The story starts at the leading margin; the owner's slip ends at the trailing one.
  for (const prose of await page.locator('[data-prose][data-voice="story"]').all()) {
    expect((await prose.boundingBox())?.x).toBe(20);
  }
  for (const slip of await page.locator('[data-prose][data-voice="line"]').all()) {
    const box = await slip.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBe(370);
    expect(box?.x).toBeGreaterThanOrEqual(20);
  }
});

/**
 * What the activity light shows at a moment: the mark's drip, the floating
 * portrait's rim, the last reply's hairline pass and the streamed words.
 */
async function activity(page: Page) {
  return page.evaluate(() => {
    const [drip] =
      document.querySelector(".lamplight-mark")?.getAnimations({ subtree: true }) ?? [];
    const rim = document.querySelector("[data-presence] .lamplight-rim");
    const lap = rim?.querySelector("g");
    const [lapping] = (lap?.getAnimations() ?? []).filter((a) => a instanceof CSSAnimation);
    const ring = rim?.querySelector('[data-rim="ring"]');
    const reply = [...document.querySelectorAll('[data-role="assistant"]')].at(-1);
    const pass = reply?.querySelector("[data-speaker] .lamplight-edge");
    const [passing] = pass?.getAnimations({ subtree: true }) ?? [];
    const words = [...document.querySelectorAll("[data-sd-animate]")];
    const newest = words.at(-1);
    return {
      dripRate: drip?.playbackRate,
      dripTime: Number(drip?.currentTime),
      rims: document.querySelectorAll(".lamplight-rim").length,
      rim: rim ? (rim.getAttribute("data-lamplight") ?? "idle") : null,
      lap: lapping
        ? {
            duration: lapping.effect?.getComputedTiming().duration,
            state: lapping.playState,
            shown: lap ? getComputedStyle(lap).display !== "none" : false,
          }
        : null,
      ring: ring ? Number(getComputedStyle(ring).opacity) : null,
      pass: passing
        ? {
            name: passing instanceof CSSAnimation ? passing.animationName : "",
            duration: passing.effect?.getComputedTiming().duration,
            state: passing.playState,
          }
        : null,
      words: words.length,
      newest: newest
        ? {
            name: getComputedStyle(newest).animationName,
            duration: getComputedStyle(newest).animationDuration,
          }
        : null,
    };
  });
}

/**
 * Watches the portrait's rim for its next ending and reports how it went:
 * whether the tail closed onto the head (a stroke-dasharray animation to a
 * full ring) and whether the light faded.
 */
async function watchEnding(page: Page) {
  await page.evaluate(() => {
    const rim = document.querySelector("[data-presence] .lamplight-rim");
    const store = window as unknown as { ending?: Promise<{ closed: boolean; faded: boolean }> };
    store.ending = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (rim?.getAttribute("data-lamplight") !== "ending") return;
        observer.disconnect();
        // Once the component's effect has started the ending.
        setTimeout(() => {
          const tail = rim.querySelector('[data-rim="tail"]');
          const closed = (tail?.getAnimations() ?? []).some((animation) =>
            animation.effect instanceof KeyframeEffect
              ? animation.effect.getKeyframes().some(
                  (frame) =>
                    String(frame.strokeDasharray)
                      .match(/[\d.]+/g)
                      ?.map(Number)
                      .join() === "100,0",
                )
              : false,
          );
          const faded = (rim.querySelector("g")?.getAnimations() ?? []).some(
            (animation) => !(animation instanceof CSSAnimation),
          );
          resolve({ closed, faded });
        }, 60);
      });
      if (rim) observer.observe(rim, { attributes: true, attributeFilter: ["data-lamplight"] });
    });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { ending: Promise<{ closed: boolean; faded: boolean }> }).ending,
    );
}

test("a desktop reply lights the portrait's rim, not the hairline: its lap runs, the mark's drip quickens in place, and a finished reply closes the ring", async ({
  page,
}) => {
  await page.setViewportSize({ width: FORM_FACTORS[2].width, height: FORM_FACTORS[2].height });
  const character = await characterWithArt(page);
  await openChat(page, "mock-slow");
  await chooseCharacter(page, character);
  await expect(page.locator("[data-presence] .lamplight-rim")).toHaveCount(1);

  // At rest: the drip at its own pace, the rim dark.
  const rest = await activity(page);
  expect(rest).toMatchObject({ dripRate: 1, rims: 1, rim: "idle", ring: 0, words: 0 });

  // Listening: text in the focused composer shows a still, faint ring.
  const field = page.getByLabel("Message", { exact: true });
  const input = canary("in");
  await field.fill(input);
  await expect.poll(async () => (await activity(page)).ring).toBeCloseTo(0.25, 2);
  expect(await activity(page)).toMatchObject({ dripRate: 1, rim: "idle" });

  // In flight: one light, on the rim; the nameplate's hairline stays still.
  await field.press("Enter");
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect.poll(async () => (await activity(page)).dripRate).toBeCloseTo(5 / 3, 5);
  await expect.poll(async () => (await activity(page)).words).toBeGreaterThan(0);
  await expect
    .poll(async () => (await activity(page)).newest)
    .toEqual({ name: "sd-fadeIn", duration: "0.12s" });
  const writing = await activity(page);
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  expect(writing).toMatchObject({
    rim: "busy",
    lap: { duration: 6000, state: "running", shown: true },
    pass: null,
  });
  // The rate changed without restarting the drip.
  expect(writing.dripTime).toBeGreaterThan(rest.dripTime);

  // Done: the tail closes onto the head, the ring fades, and the drip returns to rest.
  const ending = await watchEnding(page);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  expect(await ending()).toEqual({ closed: true, faded: true });
  await expect.poll(async () => (await activity(page)).rim).toBe("idle");
  const done = await activity(page);
  expect(done).toMatchObject({ dripRate: 1, words: 0, lap: { state: "paused" } });
  expect(done.dripTime).toBeGreaterThan(writing.dripTime);
  await expect(lastReply(page).locator("[data-prose]")).toHaveText(
    `Reply: ${input.replace("-in-", "-out-")}${" more".repeat(80)}`,
  );
});

test("Stop fades the portrait's rim without closing it", async ({ page }) => {
  await page.setViewportSize({ width: FORM_FACTORS[2].width, height: FORM_FACTORS[2].height });
  const character = await characterWithArt(page);
  await openChat(page, "mock-slow");
  await chooseCharacter(page, character);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect.poll(async () => (await activity(page)).rim).toBe("busy");
  const ending = await watchEnding(page);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "stopped");
  expect(await ending()).toEqual({ closed: false, faded: true });
  await expect.poll(async () => (await activity(page)).rim).toBe("idle");
});

test("a stopped Write for me fades the rim without closing it, though the reply shown is complete", async ({
  page,
}) => {
  await page.setViewportSize({ width: FORM_FACTORS[2].width, height: FORM_FACTORS[2].height });
  const character = await characterWithArt(page);
  await openChat(page, "mock-slow");
  await chooseCharacter(page, character);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect.poll(async () => (await activity(page)).rim).toBe("idle");
  await page.getByRole("button", { name: "Write for me" }).click();
  await expect.poll(async () => (await activity(page)).rim).toBe("busy");
  const ending = await watchEnding(page);
  await page.getByRole("button", { name: "Stop" }).click();
  expect(await ending()).toEqual({ closed: false, faded: true });
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
});

test("a tablet's floating portrait is a small frame: its rim draws 1px strokes and no bloom, unlike the desktop's", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: FORM_FACTORS[1].width, height: FORM_FACTORS[1].height });
  const character = await characterWithArt(page);
  await openChat(page, "mock-slow");
  await chooseCharacter(page, character);
  const rim = page.locator("[data-presence] .lamplight-rim");
  const strokes = () =>
    rim.evaluate((node) =>
      Object.fromEntries(
        [...node.querySelectorAll("[data-rim]")].map((stroke) => [
          stroke.getAttribute("data-rim"),
          getComputedStyle(stroke).display === "none"
            ? "none"
            : getComputedStyle(stroke).strokeWidth,
        ]),
      ),
    );
  await expect(rim).toHaveCount(1);
  expect(await strokes()).toEqual({ ring: "1px", bloom: "none", tail: "1px", head: "1px" });
  await page.setViewportSize({ width: FORM_FACTORS[2].width, height: FORM_FACTORS[2].height });
  await expect.poll(strokes).toEqual({ ring: "1.5px", bloom: "4px", tail: "1.5px", head: "2px" });
});

test("a phone reply passes a light along the nameplate's hairline and draws no rim", async ({
  page,
}) => {
  await page.setViewportSize({ width: FORM_FACTORS[0].width, height: FORM_FACTORS[0].height });
  const character = await characterWithArt(page);
  await openChat(page, "mock-slow");
  await chooseCharacter(page, character);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect
    .poll(async () => (await activity(page)).pass)
    .toEqual({ name: "lamplight-pass", duration: 3600, state: "running" });
  // Neither the band's portrait nor the header's carries a rim.
  expect(await activity(page)).toMatchObject({ rims: 0, rim: null });
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  expect((await activity(page)).pass).toBeNull();
});

test("under reduced motion a reply in flight shows a still ring with no lap, no drip and words at once; lifting it brings the drip back at the writing pace", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const character = await characterWithArt(page);
  await openChat(page, "mock-slow");
  await chooseCharacter(page, character);
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect.poll(async () => (await activity(page)).ring).toBeCloseTo(0.4, 2);
  await expect.poll(async () => (await activity(page)).words).toBeGreaterThan(0);
  const writing = await activity(page);
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  expect(writing).toMatchObject({
    rim: "busy",
    // The lap is not drawn, so it does not run.
    lap: null,
    dripRate: undefined,
    newest: { name: "none" },
  });

  // Lifting the preference mid-reply brings the drip back at the writing pace, and the lap.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(async () => (await activity(page)).dripRate).toBeCloseTo(5 / 3, 5);
  const resumed = await activity(page);
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  expect(resumed.lap).toMatchObject({ state: "running", shown: true });
});

test("Continue streams on without fading the reply's earlier words out and back in", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await chooseModel(page, "mock-slow");
  await page.locator("[data-reply-actions]").getByRole("button", { name: "Continue" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect(lastReply(page)).toContainText("more");
  expect(await lastReply(page).locator("[data-sd-animate]").count()).toBe(0);
  await page.getByRole("button", { name: "Stop" }).click();
});

test("turns open with a visible nameplate in their own voice and carry no portrait", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const said = await messages(page).evaluateAll((turns) =>
    turns.map((turn) => {
      const speaker = turn.querySelector("[data-speaker]");
      // The name itself, without the hidden colon, drawn at full size and opacity.
      const name = speaker?.firstElementChild;
      const style = name ? getComputedStyle(name) : undefined;
      return {
        start: turn.textContent?.slice(0, turn.textContent.indexOf(": ") + 2),
        first: turn.firstElementChild === speaker,
        visible:
          name !== undefined &&
          name !== null &&
          name.getBoundingClientRect().height >= 20 &&
          style?.clipPath === "none" &&
          style.opacity === "1",
        face: style?.fontFamily.split(",")[0]?.replaceAll('"', ""),
        images: turn.querySelectorAll("img").length,
      };
    }),
  );
  expect(said).toEqual([
    { start: "You: ", first: true, visible: true, face: "Geist Variable", images: 0 },
    {
      start: "Model: ",
      first: true,
      visible: true,
      face: "Atkinson Hyperlegible Next Variable",
      images: 0,
    },
  ]);
  // Without a character there is no presence.
  await expect(page.locator("[data-presence]")).toHaveCount(0);
});

test("a nameplate passing behind Latest never covers it", async ({ page }) => {
  await openChat(page, "mock-long");
  for (const label of ["first", "second"]) {
    await send(page, canary(label));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  }
  // Scrolled up by the wheel (which lets go of the end), until the second turn's nameplate
  // sits level with Latest.
  const thread = scroller(page);
  await thread.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => thread.evaluate((node) => node.scrollTop)).toBe(0);
  const latest = page.getByRole("button", { name: "Latest" });
  await expect(latest).toBeVisible();
  const nameplate = turns(page).nth(2).locator("[data-speaker]");
  const middle = (box: { y: number; height: number } | null) =>
    (box?.y ?? Number.NaN) + (box?.height ?? 0) / 2;
  const by = middle(await nameplate.boundingBox()) - middle(await latest.boundingBox());
  await thread.evaluate((node, top) => node.scrollBy({ top }), by);
  await expect
    .poll(async () =>
      Math.abs(middle(await nameplate.boundingBox()) - middle(await latest.boundingBox())),
    )
    .toBeLessThan(4);
  // What a click at Latest's centre reaches is Latest.
  const reached = await latest.evaluate((button) => {
    const box = button.getBoundingClientRect();
    return button.contains(
      document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
    );
  });
  expect(reached).toBe(true);
});

test("a long name keeps its nameplate to two lines and still reads in full", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = `${uniqueName("Wren")} ${"of the Long Harbour Light ".repeat(6).trim()}`;
  await createCharacterViaApi(page.request, name, { firstMessage: "The lamp is lit." });
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  const nameplate = lastReply(page).locator("[data-speaker]");
  await expect(nameplate).toContainText(name);
  expect((await nameplate.boundingBox())?.height).toBeLessThanOrEqual(48);
});

test("focus in a turn lands clear of the nameplate stuck above it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await openChat(page, "mock-fast");
  for (const label of ["first", "second", "third"]) {
    await send(page, canary(label));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  }
  const thread = scroller(page);
  await thread.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => thread.evaluate((node) => node.scrollTop)).toBe(0);
  // The first reply 24px past the top: its nameplate sticks over its reasoning's summary.
  await thread.evaluate((node) => {
    const reply = node.querySelector('[data-role="assistant"]');
    node.scrollTop +=
      (reply?.getBoundingClientRect().top ?? 0) - node.getBoundingClientRect().top + 24;
  });
  const reply = page.locator('[data-message][data-role="assistant"]').first();
  const nameplate = reply.locator("[data-speaker]");
  const summary = reply.locator("summary");
  const below = async () => {
    const box = await nameplate.boundingBox();
    return (box?.y ?? Number.NaN) + (box?.height ?? 0);
  };
  expect((await summary.boundingBox())?.y).toBeLessThan(await below());
  await summary.focus();
  await expect
    .poll(async () => ((await summary.boundingBox())?.y ?? Number.NaN) - (await below()))
    .toBeGreaterThanOrEqual(0);
});

test("a single reply shows no pager, and Edit and Delete are reachable through More by keyboard", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  await send(page, canary("in"));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const row = page.locator("[data-reply-actions]");
  await expect(row.getByRole("group", { name: "Replies" })).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveText(["New reply", "Continue", ""]);
  const story = page.getByRole("log", { name: "Story" });
  for (const action of ["Edit", "Delete"]) {
    await expect(story.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }

  // Edit: Tab to More, open it, and the first item is Edit.
  const more = row.getByRole("button", { name: "More actions" });
  await page.getByLabel("Message", { exact: true }).focus();
  await tabTo(page, more, { backward: true });
  expect(await focusRing(more)).toBe("solid 2px");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const field = page.getByRole("textbox", { name: /^Edit .*'s reply$/ });
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();

  // Delete: down the menu by arrow keys.
  await page.keyboard.press("Enter");
  const remove = page.getByRole("menuitem", { name: "Delete", exact: true });
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toBeFocused();
  for (
    let step = 0;
    step < 6 && !(await remove.evaluate((node) => node === document.activeElement));
    step++
  ) {
    await page.keyboard.press("ArrowDown");
  }
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "reply was deleted" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeFocused();
});

for (const { name, width, height, scheme } of [
  { name: "desktop light", width: 1440, height: 900, scheme: "light" },
  { name: "desktop dark", width: 1440, height: 900, scheme: "dark" },
  { name: "phone dark", width: 390, height: 844, scheme: "dark" },
] as const) {
  test(`no serious accessibility issues: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    await openChat(page, "mock-hostile");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await page.getByLabel("Message", { exact: true }).fill(canary("draft"));
    // Measure settled colors, not a crossfade in progress.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.getAnimations().filter((a) => a instanceof CSSTransition).length,
        ),
      )
      .toBe(0);

    const { violations } = await new AxeBuilder({ page }).analyze();
    const serious = violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map(
        (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`,
      );
    expect(serious).toEqual([]);
    await clearChat(page);
  });
}

test("the header shows no meter figures while the window has room, and keeps its actions in place", async ({
  page,
}) => {
  await openChat(page, "mock-fast");
  const prompt = page.getByRole("button", { name: "Prompt", exact: true });
  const figures = page.locator("header [data-meter-figures]");
  // At rest only the icons show; the figures keep their room, hidden, before the actions.
  await expect(figures).toBeHidden();
  await expect(page.locator("header")).not.toContainText(" of ", { useInnerText: true });
  const before = await prompt.boundingBox();
  const clear = await page.getByRole("button", { name: "Clear chat" }).boundingBox();
  // Clear, Prompt and Session are one group, 4px apart.
  expect((before?.x ?? 0) - ((clear?.x ?? 0) + (clear?.width ?? 0))).toBe(4);
  await send(page, `${"word ".repeat(1_100)}${canary("in")}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(figures).toBeHidden();
  expect(await prompt.boundingBox()).toEqual(before);
  // The tooltip always carries the figures.
  await prompt.hover();
  await expect(page.getByText(/^Prompt: About [\d,]+ of 131,072 tokens/)).toBeVisible();
});

test("reduced motion switched on under an open sheet stops reordered rows from gliding", async ({
  page,
  request,
}) => {
  const id = await createCharacterViaApi(request, `Glide ${crypto.randomUUID().slice(0, 6)}`, {
    firstMessage: "Opening.",
    alternateGreetings: ["One", "Two"],
  });
  await page.goto(`/characters/${id}`);
  await page.getByRole("button", { name: /^Alternate 2:/ }).click();
  // The preference changes while the sheet stays open.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Move Alternate 2 earlier" }).click();
  // A glide would still be moving the row a frame later (a 240 ms spring).
  const transforms = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) =>
        requestAnimationFrame(() =>
          resolve(
            [...document.querySelectorAll<HTMLElement>("[data-key]")].map(
              (row) => row.style.transform,
            ),
          ),
        ),
      ),
  );
  expect(transforms.every((transform) => transform === "" || transform === "none")).toBe(true);
});

/** A native book with placement, timing, matching and recursion settings. */
const WORLD_INFO_BOOK = {
  scanDepth: 4,
  entries: [
    loreEntry({
      comment: "The Grey Lantern",
      keys: ["lantern", "lamp"],
      secondaryKeys: ["storm", "/(?<=old )squall/"],
      selective: true,
      content: "The lamp {{char}} trims by hand is older than the tower.",
      insertionOrder: 40,
      settings: {
        placement: "after",
        logic: "andAll",
        sticky: 3,
        cooldown: 2,
        delay: 4,
        scanDepth: 6,
        caseSensitive: true,
        wholeWords: false,
        probability: 50,
        useProbability: true,
      },
    }),
    loreEntry({ comment: "The harbour", keys: ["harbour"], insertionOrder: 60 }),
    loreEntry({ comment: "Keeper's log", keys: ["log"], settings: { placement: "examplesTop" } }),
    loreEntry({ comment: "Fog manner", keys: ["fog"], settings: { placement: "anBottom" } }),
    loreEntry({
      comment: "Gull omen",
      keys: ["gull"],
      settings: { placement: "depth", depth: 4, role: "system", recursiveOnly: true, sticky: 2 },
    }),
    loreEntry({ comment: "Wreck notes", keys: ["wreck"], enabled: false }),
    loreEntry({
      comment: "Contradiction",
      keys: ["rope"],
      enabled: false,
      settings: { excludeRecursion: true, recursiveOnly: true },
    }),
  ],
};

for (const { name, width, height, scheme } of [
  { name: "desktop light", width: 1440, height: 900, scheme: "light" },
  { name: "tablet dark", width: 820, height: 1180, scheme: "dark" },
  { name: "phone dark", width: 390, height: 844, scheme: "dark" },
] as const) {
  test(`the lorebook's native controls fit and pass axe: ${name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const id = await createCharacterViaApi(
      page.request,
      `World ${crypto.randomUUID().slice(0, 6)}`,
    );
    await setLorebookViaApi(page.request, id, WORLD_INFO_BOOK);
    const shot = async (label: string) =>
      testInfo.attach(`${name} ${label}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });

    // The list with every group.
    await page.goto(`/characters/${id}/lorebook`);
    const list = page.getByRole("list", { name: "Entries in prompt order" });
    await expect(list.getByRole("button", { name: "Edit Wreck notes" })).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await shot("list");

    // The editor with every row open.
    await list.getByRole("button", { name: "Edit The Grey Lantern" }).click();
    for (const row of [
      "Where it goes",
      "When it goes in",
      "What brings it in",
      "What it matches",
    ]) {
      const button = page.getByRole("button", { name: row, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
    }
    await expect(
      page.getByRole("region", { name: "The Grey Lantern" }).getByRole("textbox", {
        name: "Scan depth",
      }),
    ).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await shot("editor");

    // An in-chat entry reveals depth and role.
    if (name !== "desktop light") await page.getByRole("button", { name: "Entries" }).click();
    await list.getByRole("button", { name: "Edit Gull omen" }).click();
    await page.getByRole("button", { name: "Where it goes", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Role" })).toBeVisible();
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await shot("in the chat");
  });
}

/** A book whose first send explains every kind of line the inspector's lorebook section has. */
const INSPECTED_BOOK = {
  scanDepth: 1,
  recursiveScanning: true,
  entries: [
    loreEntry({
      comment: "The Grey Lantern and the long habit of trimming it before the storm comes in",
      keys: ["lantern"],
      secondaryKeys: ["storm", "squall"],
      selective: true,
      content: "The lamp is trimmed nightly.",
      settings: { logic: "andAll", sticky: 4 },
    }),
    loreEntry({ comment: "Lamp room", keys: ["lamp"], content: "Lamp room lore." }),
    loreEntry({
      comment: "Gull omen",
      keys: ["gull"],
      content: "Gull omen lore.",
      settings: { placement: "depth", depth: 1, role: "system" },
    }),
    loreEntry({
      comment: "Harbour without weather",
      keys: ["harbour"],
      secondaryKeys: ["fog", "sleet"],
      selective: true,
      content: "Harbour lore.",
      settings: { logic: "notAny" },
    }),
    loreEntry({
      comment: "Wreck",
      keys: ["wreck"],
      content: "Wreck lore.",
      settings: { delay: 4 },
    }),
    loreEntry({
      comment: "Rope",
      keys: ["rope"],
      secondaryKeys: ["storm"],
      selective: true,
      content: "Rope lore.",
      settings: { logic: "notAny" },
    }),
  ],
};

for (const { name, width, height, scheme } of [
  { name: "desktop light", width: 1440, height: 900, scheme: "light" },
  { name: "tablet dark", width: 820, height: 1180, scheme: "dark" },
  { name: "phone dark", width: 390, height: 844, scheme: "dark" },
] as const) {
  test(`the inspector's lorebook lines wrap, fit and pass axe: ${name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const character = `Inspected ${crypto.randomUUID().slice(0, 6)}`;
    const id = await createCharacterViaApi(page.request, character);
    await setLorebookViaApi(page.request, id, INSPECTED_BOOK);
    await openChat(page, "mock-fast");
    await chooseCharacter(page, character);
    await send(
      page,
      `The lantern in the storm and squall, a gull, a wreck, a rope, the harbour ${canary("in")}`,
    );
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");

    await page.getByRole("button", { name: "Prompt", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Prompt" });
    const section = dialog.getByRole("region", { name: "Lorebook" });
    await expect(section).toContainText("with storm and squall");
    await expect(section).toContainText("matched harbour, without fog or sleet");
    await section.getByRole("button", { name: /^Other entries/ }).click();
    await expect(section).toContainText("Wreck, until 4 messages");
    await dialog.getByRole("button", { name: /Chat history/ }).click();
    await expect(
      dialog
        .getByRole("list", { name: "Chat history as sent" })
        .getByText(/^Lorebook, in the chat/),
    ).toBeVisible();
    // The reason wraps under the title; nothing is cut off.
    const clipped = await section
      .getByRole("list", { name: "Lorebook entries sent" })
      .locator("li > span > span:last-child")
      .evaluateAll(
        (lines) => lines.filter((line) => line.scrollWidth > line.clientWidth + 1).length,
      );
    expect(clipped).toBe(0);
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await testInfo.attach(`${name} inspector`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}

test("reduced motion keeps the lorebook's rows to fades", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const id = await createCharacterViaApi(page.request, `Still ${crypto.randomUUID().slice(0, 6)}`);
  await setLorebookViaApi(page.request, id, WORLD_INFO_BOOK);
  await page.goto(`/characters/${id}/lorebook?entry=0`);
  const button = page.getByRole("button", { name: "Where it goes", exact: true });
  await button.click();
  const motion = await button.evaluate((node) => {
    const panel = document.getElementById(node.getAttribute("aria-controls") ?? "");
    const chevron = node.querySelector("svg");
    const thumb = document.querySelector('[data-slot="switch-thumb"]');
    return {
      panel: panel ? getComputedStyle(panel).transitionProperty : "missing",
      chevron: chevron ? getComputedStyle(chevron).transitionProperty : "missing",
      thumb: thumb ? getComputedStyle(thumb).transitionProperty : "missing",
    };
  });
  expect(motion).toEqual({ panel: "opacity", chevron: "none", thumb: "background-color" });
});

/** A PNG of one solid colour, built in memory. */
function solidPng([r, g, b]: readonly [number, number, number], width = 60, height = 90): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([
    Buffer.of(0),
    Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3] ?? 0),
  ]);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

/** A character with a portrait of one colour, given through the portrait upload. */
async function characterInColour(page: Page, base: string, rgb: readonly [number, number, number]) {
  const name = uniqueName(base);
  const id = await createCharacterViaApi(page.request, name);
  await setPortraitViaApi(page.request, id, solidPng(rgb));
  return name;
}

/**
 * The room as it settles: whether the root carries the atmosphere, its canvas
 * in OKLCH beside the palette's own, and the contrast of ink on it.
 */
async function room(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAnimations().length))
    .toBe(0);
  return page.evaluate(() => {
    const resolve = (color: string) => {
      const probe = document.createElement("span");
      probe.style.color = color;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) ?? [];
    };
    const root = document.documentElement;
    const canvas = getComputedStyle(root).backgroundColor;
    const [l = 0, c = 0, h = 0] = resolve(`oklch(from ${canvas} l c h)`);
    const [l0 = 0, c0 = 0, h0 = 0] = resolve("oklch(from var(--canvas-base) l c h)");
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = resolve(`color(from ${color} srgb r g b)`).map((v) =>
        v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [ink, ground] = [luminance("var(--ink)"), luminance(canvas)];
    return {
      atmosphere: root.dataset.atmosphere !== undefined,
      tinted: c > c0 + 0.001,
      lightness: l - l0,
      hueShift: Math.abs(((h - h0 + 540) % 360) - 180),
      contrast: (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05),
      hue: root.style.getPropertyValue("--tint-h"),
    };
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`the room takes the portrait's hue, keeps its lightness and keeps the hue in memory (${scheme})`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme: scheme });
    const [warm, cool, grey] = await Promise.all([
      characterInColour(page, "Ember", [190, 60, 40]),
      characterInColour(page, "Tide", [30, 130, 210]),
      characterInColour(page, "Ash", [128, 128, 128]),
    ]);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await openChat(page, "mock-fast");
    const root = page.locator("html");
    const untinted = { atmosphere: false, tinted: false };

    // No character: the palette's own room.
    expect(await room(page)).toMatchObject(untinted);

    const seen: string[] = [];
    for (const name of [warm, cool]) {
      const before = await root.evaluate((node) => node.style.getPropertyValue("--tint-h"));
      await chooseCharacter(page, name);
      await expect(root).toHaveAttribute("data-atmosphere", "");
      await expect
        .poll(() => root.evaluate((node) => node.style.getPropertyValue("--tint-h")))
        .not.toBe(before);
      const tinted = await room(page);
      expect(tinted).toMatchObject({ atmosphere: true, tinted: true });
      expect(Math.abs(tinted.lightness)).toBeLessThan(0.005);
      expect(tinted.hueShift).toBeLessThanOrEqual(30);
      expect(tinted.contrast).toBeGreaterThanOrEqual(7);
      seen.push(tinted.hue);
    }

    // Leaving the chat fades the room back; returning brings the tint again.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Characters" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Characters" })).toBeVisible();
    await expect(root).not.toHaveAttribute("data-atmosphere");
    expect(await room(page)).toMatchObject(untinted);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Chat" })
      .click();
    await expect(root).toHaveAttribute("data-atmosphere", "");
    expect(await room(page)).toMatchObject({ atmosphere: true, tinted: true });

    // A grey portrait and No character leave the room untinted.
    await chooseCharacter(page, grey);
    await expect(root).not.toHaveAttribute("data-atmosphere");
    expect(await room(page)).toMatchObject(untinted);
    await chooseCharacter(page, cool);
    await expect(root).toHaveAttribute("data-atmosphere", "");
    await chooseCharacter(page, "No character");
    await expect(root).not.toHaveAttribute("data-atmosphere");
    expect(await room(page)).toMatchObject(untinted);

    // The hue was never written anywhere the browser keeps or sends.
    const kept = JSON.stringify(await browserStorage(page));
    // Built assets are named after their modules (an `atmosphere-*.js` chunk), not by the room.
    const sent = requests.filter((url) => !new URL(url).pathname.startsWith("/assets/")).join("\n");
    expect(seen.every((hue) => hue !== "")).toBe(true);
    for (const value of [...seen, "tint", "atmosphere"]) {
      expect(kept).not.toContain(value);
      expect(sent).not.toContain(value);
    }
  });
}

/** Core's floors with each role as the custom property the page resolves. */
const PAGE_FLOORS = CONTRAST_FLOORS.map(({ role, grounds, floor }) => ({
  token: paletteProperty(role),
  grounds: grounds.map((ground) => ({ token: paletteProperty(ground.role), wash: ground.wash })),
  floor,
  role,
}));

for (const scheme of ["light", "dark"] as const) {
  test(`every palette keeps its text readable (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/settings");
    const swatches = page
      .getByRole("radiogroup", { name: "Palette", exact: true })
      .locator("[data-palette]");
    await expect(swatches).toHaveCount(6);
    const ids = await swatches.evaluateAll((all) =>
      all.map((swatch) => swatch.getAttribute("data-palette")),
    );
    const canvases = new Set<string>();
    for (const id of ids) {
      // Only the root's attribute, never the saved setting, which other tests share.
      const { canvas, lowest } = await page.evaluate(
        ({ id, floors, wash }) => {
          const root = document.documentElement;
          if (id === "tokyo-night") delete root.dataset.palette;
          else if (id !== null) root.dataset.palette = id;
          // Every colour as `color(srgb r g b)`, channels 0 to 1, whatever its own form.
          const srgb = (color: string) => {
            const probe = document.createElement("span");
            probe.style.color = `color(from ${color} srgb r g b)`;
            document.body.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return (value.match(/-?[\d.]+(e-?\d+)?/g) ?? []).slice(0, 3).map(Number);
          };
          const luminance = (color: string) => {
            const [r = 0, g = 0, b = 0] = srgb(color).map((c) =>
              c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
            );
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const lowest = floors.map(({ token, grounds, floor, role }) => {
            const ink = luminance(`var(${token})`);
            const least = Math.min(
              ...grounds.map((ground) => {
                const under = ground.wash
                  ? `color-mix(in srgb, var(${token}) ${wash}%, var(${ground.token}))`
                  : `var(${ground.token})`;
                const back = luminance(under);
                return (Math.max(ink, back) + 0.05) / (Math.min(ink, back) + 0.05);
              }),
            );
            return { token: role, least: Math.floor(least * 100) / 100, floor };
          });
          return { canvas: srgb("var(--canvas-base)").join(), lowest };
        },
        { id, floors: PAGE_FLOORS, wash: WASH_OPACITY * 100 },
      );
      for (const { token, least, floor } of lowest) {
        expect(least, `${id} ${scheme}: ${token}`).toBeGreaterThanOrEqual(floor);
      }
      canvases.add(canvas);
    }
    // Each palette applied its own colours, rather than falling back to the default's.
    expect(canvases.size).toBe(ids.length);
  });
}

/** A locator's left and right edges, inside its padding when `content` is set. */
const edges = (target: Locator, content = false) =>
  target.evaluate((el, inner) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const left = inner ? Number.parseFloat(style.paddingLeft) : 0;
    const right = inner ? Number.parseFloat(style.paddingRight) : 0;
    return { left: box.left + left, right: box.right - right };
  }, content);

/**
 * A scroller holds its content: it does not scroll sideways, and nothing in
 * it reaches past its own right edge or the window's. The shell clips what
 * overflows, so the document never scrolls sideways and only measuring the
 * scroller and each element in it shows content cut off.
 */
async function expectContained(scroller: Locator) {
  const { sideways, past } = await scroller.evaluate((root) => {
    const box = root.getBoundingClientRect();
    const edge = Math.min(box.left + root.clientLeft + root.clientWidth, window.innerWidth);
    return {
      sideways: root.scrollWidth - root.clientWidth,
      past: [...root.querySelectorAll("*")]
        .map((el) => el.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.right > edge + 0.5).length,
    };
  });
  expect(sideways).toBeLessThanOrEqual(0);
  expect(past).toBe(0);
}

/** The gallery's column tracks; auto-fill keeps empty ones, so the count holds with few cards. */
const galleryColumns = (page: Page) =>
  page
    .getByRole("list", { name: "Characters" })
    .evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(" ").length);

for (const { width, height, root, columns } of [
  { width: 1440, height: 900, root: "16px", columns: 6 },
  // A portrait screen: the width keys the scale, so the root stays at the default.
  { width: 1440, height: 2560, root: "16px", columns: 6 },
  { width: 1920, height: 1080, root: "16px", columns: 7 },
  { width: 2560, height: 1440, root: "18px", columns: 8 },
  { width: 3840, height: 2160, root: "20px", columns: 10 },
]) {
  test(`the interface scales with the display and fills the gallery (${width}x${height})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    // A long name with art: the portrait beside the story, and a Session field that must truncate it.
    const character = uniqueName("Mira of the Northern Observatory");
    await importCards(page, [
      await pngCard("mira.png", {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: { name: character },
      }),
    ]);
    await openChat(page, "mock-fast");
    await chooseCharacter(page, character);
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await expect(page.locator("[data-presence] img")).toBeVisible();
    await expectContained(scroller(page));
    const size = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    // The root is fluid, so its computed size may carry a fraction of a pixel.
    expect(Number.parseFloat(size)).toBeCloseTo(Number.parseFloat(root), 1);

    // The docked Session panel holds the long name without scrolling sideways.
    const toggle = page.getByRole("button", { name: "Session", exact: true });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    const fields = page.getByRole("complementary", { name: "Session" }).locator(":scope > div");
    await expect(fields).toContainText(character);
    expect(await fields.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);

    await page.goto("/characters");
    await expect(page.getByRole("list", { name: "Characters" })).toBeVisible();
    await expectContained(page.locator("main [data-skip-target]"));
    // The count holds whether the host's scrollbars overlay the content or take their gutters.
    expect(await galleryColumns(page)).toBe(columns);
  });
}

test("on a large display the header's controls sit on the edges of the body they act on", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  const header = page.locator("main header");
  const expectOn = async (
    [first, last]: [Locator, Locator],
    body: { left: number; right: number },
  ) => {
    expect(Math.abs((await edges(first)).left - body.left)).toBeLessThanOrEqual(2);
    expect(Math.abs((await edges(last)).right - body.right)).toBeLessThanOrEqual(2);
  };

  // The presets list: the title over the first list, the import over the second.
  await page.goto("/presets");
  const sampler = page.getByRole("region", { name: "Sampler presets" });
  const prompt = page.getByRole("region", { name: "Prompt presets" });
  await expect(prompt).toBeVisible();
  await expectOn(
    [
      header.getByRole("heading", { level: 1, name: "Presets" }),
      header.getByRole("button", { name: "Import preset" }),
    ],
    { left: (await edges(sampler)).left, right: (await edges(prompt)).right },
  );

  // A character sheet: Back on the form's left edge, its last action on the index's right.
  const id = await createCharacterViaApi(page.request, uniqueName("Edges"));
  await page.goto(`/characters/${id}`);
  const form = page.getByRole("form", { name: "Character sheet" });
  const index = page.getByRole("navigation", { name: "On this sheet" });
  await expect(index).toBeVisible();
  await expectOn(
    [
      header.getByRole("link", { name: "Characters" }),
      header.getByRole("button", { name: "More actions" }),
    ],
    { left: (await edges(form)).left, right: (await edges(index)).right },
  );
});

test("on a large display the lorebook's editor starts beside its list, under the header's actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  const id = await createCharacterViaApi(page.request, uniqueName("Workspace"));
  await setLorebookViaApi(page.request, id, {
    entries: [loreEntry({ keys: ["harbor"], content: "The harbor.", comment: "Harbor bells" })],
  });
  await page.goto(`/characters/${id}/lorebook`);
  await page
    .getByRole("list", { name: "Entries in prompt order" })
    .getByRole("button", { name: "Edit Harbor bells" })
    .click();
  const editor = page.getByRole("region", { name: "Harbor bells" });
  await expect(editor).toBeVisible();
  const list = page.locator("main [data-skip-target]");
  expect(Math.abs((await edges(editor)).left - (await edges(list)).right)).toBeLessThanOrEqual(2);
  const actions = page.locator("main header").getByRole("button", { name: "More actions" });
  expect(
    Math.abs((await edges(actions)).right - (await edges(editor, true)).right),
  ).toBeLessThanOrEqual(2);
});

test("on a phone nothing in the gallery reaches past the screen's edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createCharacterViaApi(page.request, uniqueName("Narrow"));
  await page.goto("/characters");
  await expect(page.getByRole("list", { name: "Characters" })).toBeVisible();
  const gallery = page.locator("main [data-skip-target]");
  await expectContained(gallery);
  // The toolbar's controls all show, inside the scroller.
  const frame = await gallery.boundingBox();
  for (const control of [
    gallery.getByRole("searchbox", { name: "Search characters" }),
    gallery.getByRole("button", { name: "Filter and order" }),
    gallery.getByRole("button", { name: "Create with AI" }),
  ]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(frame?.x ?? Infinity);
    expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (frame?.x ?? 0) + (frame?.width ?? 0),
    );
  }
  // Its sheet closes like every sheet: an X in the header, named for what it closes.
  await gallery.getByRole("button", { name: "Filter and order" }).click();
  const sheet = page.getByRole("dialog", { name: "Filter and order" });
  await sheet.getByRole("button", { name: "Close filter and order" }).click();
  await expect(sheet).toHaveCount(0);
});
