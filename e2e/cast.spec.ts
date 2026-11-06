import { writeFile } from "node:fs/promises";
import type { APIRequestContext, Page, Request, Route } from "@playwright/test";
import { formatCount } from "../apps/web/src/lib/text.ts";
import {
  castSheetResponseSchema,
  castUpdateResponseSchema,
} from "../packages/core/src/cast/api.ts";
import { CAST_LIMITS } from "../packages/core/src/cast/limits.ts";
import { PALETTES } from "../packages/core/src/palettes.ts";
import { callAccountingSchema } from "../packages/core/src/usage.ts";
import { openSheet, uniqueName } from "./support/cards.ts";
import {
  castEntry,
  castPanel,
  castRecord,
  castStatus,
  castUpdating,
  chooseCastModel,
  editRecord,
  openRecord,
} from "./support/cast.ts";
import {
  DEVELOPED_HAIR,
  DEVELOPMENT_TURN,
  KEEPER_MAN,
  KEEPER_WOMAN_GIVEN,
  KEEPER_WOMAN_OUTFIT,
  keeperWoman,
  SHEET_MAN,
  SHEET_RETRY_EMPTY,
  SHEET_WOMAN,
} from "./support/cast-fixtures.ts";
import {
  chooseModel,
  clearChat,
  lastReply,
  moreAction,
  replyActions,
  replyCounter,
  send,
  upstreamRecords,
} from "./support/chat.ts";
import { portraitPng } from "./support/creator-fixtures.ts";
import {
  createCharacterViaApi,
  patchSettings,
  readSettings,
  saved,
  setPortraitViaApi,
} from "./support/entities.ts";
import { expect, test } from "./support/test.ts";
import {
  MOCK_OUTPUT_TOKENS,
  MOCK_REASONING_TOKENS,
  type UpstreamRecordView,
} from "./support/upstream.ts";

/*
 * The cast register (docs/PRODUCT.md, Chat) against the
 * mock upstream's cast model, `mock-cast`, whose keeper names a woman from the newest turn's `-in-`
 * mark and marks a man present, and whose sheet call answers two fixed
 * principals (e2e/support/cast-fixtures.ts). The marks here are not
 * canaries; e2e/cast-retention.spec.ts holds the retention rows.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const FACTORS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 412, height: 915 },
] as const;

/** The woman the keeper seeds from a greeting, which carries no mark. */
const SEEDED = keeperWoman([]);
/** The status line while the shown reply has no snapshot and no call is writing one. */
const STALE = "As of the previous reply";

test.describe("Cast header target", () => {
  test.use({ hasTouch: true });
  for (const width of [360, 390]) {
    test(`header Cast has a clear touch target at ${width}`, async ({ page, request }, info) => {
      await page.setViewportSize({ width, height: 844 });
      const { name } = await castChat(request);
      await page.goto("/");
      await expect(castEntry(page, SEEDED)).toBeVisible();
      const control = page.getByRole("button", { name: "Show the cast", exact: true });
      await expect(control).toBeVisible();
      await control.click({ trial: true });
      const geometry = await control.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const header = node.closest("header");
        const neighbors = [...(header?.querySelectorAll("button, a") ?? [])]
          .filter((other) => other !== node && other.checkVisibility())
          .map((other) => ({
            text: other.getAttribute("aria-label") ?? other.textContent,
            rect: other.getBoundingClientRect().toJSON(),
          }));
        // Sample the four edges through their middles, inside the rounded
        // target rather than in the clipped corners of its bounding rectangle.
        const points = [
          { x: rect.left + 1, y: rect.top + rect.height / 2 },
          { x: rect.right - 1, y: rect.top + rect.height / 2 },
          { x: rect.left + rect.width / 2, y: rect.top + 1 },
          { x: rect.left + rect.width / 2, y: rect.bottom - 1 },
        ];
        const hits = points.map(({ x, y }) => node.contains(document.elementFromPoint(x, y)));
        return {
          target: rect.toJSON(),
          header: header?.getBoundingClientRect().toJSON(),
          title: header?.querySelector("h1")?.textContent,
          neighbors,
          points,
          cornerRadius: getComputedStyle(node).borderTopLeftRadius,
          hits,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      const path = info.outputPath("cast-header-target.json");
      await writeFile(path, JSON.stringify(geometry));
      await info.attach("Cast header same-frame targets", {
        path,
        contentType: "application/json",
      });
      expect(geometry.target.width).toBeGreaterThanOrEqual(44);
      expect(geometry.target.height).toBeGreaterThanOrEqual(44);
      expect(geometry.hits).toEqual([true, true, true, true]);
      expect(geometry.overflow).toBe(0);
      expect(geometry.title).toBe(name);
      for (const { rect } of geometry.neighbors) {
        const overlap =
          Math.min(rect.right, geometry.target.right) > Math.max(rect.left, geometry.target.left) &&
          Math.min(rect.bottom, geometry.target.bottom) > Math.max(rect.top, geometry.target.top);
        expect(overlap).toBe(false);
      }
    });
  }
});

test("phone streaming freshness excludes card-only data and a snapshot on a hidden alternate", async ({
  page,
  request,
}) => {
  page.on("pageerror", (error) => process.stdout.write(`Chat page error: ${error.message}\n`));
  page.on("console", (message) => {
    if (message.type() === "error") process.stdout.write(`Chat console error: ${message.text()}\n`);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const { characterId } = await castChat(request, { greeting: false });
  await setPortraitViaApi(request, characterId, portraitPng("freshness"));
  await patchSettings(request, { model: "mock-slow" });
  await page.goto("/");
  await send(page, "A first scene starts without a shown snapshot.");
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect(castPanel(page)).toHaveCount(0);
  await expect(page.locator("[data-cast-status]").filter({ hasText: STALE })).toHaveCount(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await chooseModel(page, "mock-fast");
  await replyActions(page).getByRole("button", { name: "New reply", exact: true }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(castEntry(page, SEEDED)).toBeVisible();
  await replyCounter(page).getByRole("button", { name: "Previous reply", exact: true }).click();
  await chooseModel(page, "mock-slow");
  await send(page, "A second scene follows the stopped shown alternate.");
  await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
  await expect(page.locator("[data-cast-status]").filter({ hasText: STALE })).toHaveCount(0);
  await expect(castPanel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

/** A mark the keeper names its woman after, `-in-` turned to `-cast-`; not a canary. */
function mark(): string {
  const id = crypto.randomUUID();
  return `k${id.slice(0, 6)}-in-${id.slice(9, 13)}`;
}

/** The woman the keeper names after the mark in `line`. */
const womanOf = (line: string) =>
  `${KEEPER_WOMAN_GIVEN} ${(/\w+-in-[\w-]+/.exec(line)?.[0] ?? "").replace("-in-", "-cast-")}`;

/** Sends `line` and waits out its reply, which turns its mark's `-in-` to `-out-`. */
async function exchange(page: Page, line: string) {
  await send(page, line);
  await expect(lastReply(page)).toContainText(`Reply: ${line.replace("-in-", "-out-")}`);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
}

/** The chat's own request carrying `text`, not a keeper call reading it. */
async function chatRecord(text: string): Promise<UpstreamRecordView | undefined> {
  return (await upstreamRecords(text))[0];
}

/** A message of a chat request: the `<cast>` block, or the `Cast now` state line. */
const castBlock = (record: UpstreamRecordView | undefined) =>
  record?.messages.find((message) => message.content.startsWith("<cast>"))?.content;
const stateLine = (record: UpstreamRecordView | undefined) =>
  record?.messages.find((message) => message.content.startsWith("[Cast now:"))?.content;

/**
 * The test's user chatting on mock-fast with a new character whose card
 * has a description and, unless `greeting` is false, a greeting; the cast
 * calls go to mock-cast.
 */
async function castChat(request: APIRequestContext, { greeting = true } = {}) {
  const name = uniqueName("Keeper");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse with her brother.`,
    ...(greeting ? { firstMessage: `The lamp room is warm. ${name} looks up from the log.` } : {}),
  });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-cast", characterId });
  return { name, characterId };
}

/** Opens the chat and waits for the seed: the keeper's woman in the roster. */
async function seeded(page: Page) {
  await page.goto("/");
  await expect(castEntry(page, SEEDED)).toBeVisible();
}

const inspector = (page: Page) => page.getByRole("dialog", { name: "Prompt" });

/** Read the actual pseudo hit plates, rather than treating glyph boxes as targets. */
async function expectStackFit(page: Page, state: string, names = true) {
  const panel = castPanel(page);
  await panel.scrollIntoViewIfNeeded();
  const lifecycle = await page.evaluate(() => ({
    active: document.documentElement.matches(":active-view-transition"),
    rootAnimations: document.getAnimations().flatMap((animation) => {
      const effect = animation.effect;
      if (
        !(effect instanceof KeyframeEffect) ||
        !effect.pseudoElement?.startsWith("::view-transition")
      )
        return [];
      return [
        { pseudo: effect.pseudoElement, state: animation.playState, time: animation.currentTime },
      ];
    }),
  }));
  if (lifecycle.active) {
    process.stdout.write(`C document lifecycle ${JSON.stringify({ state, ...lifecycle })}\n`);
    // Route/theme snapshots intercept the entire document until their native
    // lifecycle finishes. This is a resting-state contract, not a hit retry.
    await page.waitForFunction(
      () => !document.documentElement.matches(":active-view-transition"),
      undefined,
      { timeout: 2000 },
    );
  }
  const geometry = await panel.evaluate((element) => {
    const documentMotion = document.getAnimations().map((animation) => ({
      state: animation.playState,
      time: animation.currentTime,
      pseudo: animation.effect instanceof KeyframeEffect ? animation.effect.pseudoElement : null,
      target: animation.effect instanceof KeyframeEffect ? animation.effect.target?.tagName : null,
      name: animation instanceof CSSAnimation ? animation.animationName : null,
      property: animation instanceof CSSTransition ? animation.transitionProperty : null,
    }));
    const root = document.documentElement;
    const documentState = {
      activeViewTransition: root.matches(":active-view-transition"),
      animations: documentMotion,
      modal: [...document.querySelectorAll(":modal")].map((node) => node.outerHTML.slice(0, 300)),
      rootPseudo: [
        "::view-transition",
        "::view-transition-group(root)",
        "::view-transition-new(root)",
      ].map((pseudo) => {
        const style = getComputedStyle(root, pseudo);
        return { pseudo, pointerEvents: style.pointerEvents, animationName: style.animationName };
      }),
    };
    const bounds = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const describe = (node: Element | null) =>
      node === null
        ? null
        : {
            tag: node.tagName,
            role: node.getAttribute("role"),
            label: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 80),
            class: node.getAttribute("class"),
            bounds: bounds(node),
          };
    const scroller = element.closest('[role="log"]')?.firstElementChild;
    const column = element.closest("[data-presence]")?.firstElementChild;
    if (!column) throw new Error("Missing portrait column");
    const stack = element.getBoundingClientRect();
    const portrait = column.getBoundingClientRect();
    const actions = [...element.querySelectorAll<HTMLElement>("[data-slot=button]")].map(
      (action) => {
        const rect = action.getBoundingClientRect();
        const style = getComputedStyle(action);
        const after = getComputedStyle(action, "::after");
        const left =
          rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(after.left);
        const top =
          rect.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(after.top);
        const right =
          rect.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(after.right);
        const bottom =
          rect.bottom -
          Number.parseFloat(style.borderBottomWidth) -
          Number.parseFloat(after.bottom);
        const range = document.createRange();
        range.selectNodeContents(action);
        const text = range.getBoundingClientRect();
        const points = [-18, 0, 18].flatMap((x) =>
          [-18, 0, 18].map((y) => {
            const at = { x: (left + right) / 2 + x, y: (top + bottom) / 2 + y };
            const above = document.elementFromPoint(at.x, at.y);
            return { ...at, hit: action.contains(above), above: describe(above) };
          }),
        );
        const ancestors = [];
        for (let node: Element | null = action; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node);
          const animations = node
            .getAnimations()
            .filter((animation) => animation.playState === "running")
            .map((animation) => ({
              time: animation.currentTime,
              property: animation instanceof CSSTransition ? animation.transitionProperty : null,
              name: animation instanceof CSSAnimation ? animation.animationName : null,
            }));
          ancestors.push({
            node: describe(node),
            inert: node.hasAttribute("inert"),
            pointerEvents: style.pointerEvents,
            visibility: style.visibility,
            transform: style.transform,
            translate: style.translate,
            opacity: style.opacity,
            overflow: style.overflow,
            animations,
          });
        }
        return {
          label: action.textContent,
          left,
          top,
          right,
          bottom,
          width: right - left,
          height: bottom - top,
          controlRight: rect.right,
          hit: points.every((point) => point.hit),
          sampled: points.length,
          failedPoints: points.filter((point) => !point.hit),
          diagnostics: points.every((point) => point.hit)
            ? undefined
            : {
                control: bounds(action),
                stack: bounds(element),
                portrait: bounds(column),
                scroller: scroller && {
                  ...bounds(scroller),
                  top: scroller.scrollTop,
                  height: scroller.scrollHeight,
                  client: scroller.clientHeight,
                },
                ancestors,
                documentState,
              },
          textFits:
            text.left >= rect.left - 1 &&
            text.right <= rect.right + 1 &&
            text.top >= rect.top - 1 &&
            text.bottom <= rect.bottom + 1,
        };
      },
    );
    return {
      width: stack.width,
      budget: portrait.height,
      height: stack.height,
      bottom: stack.bottom,
      columnBottom: portrait.bottom,
      left: stack.left,
      // Layout height avoids coordinate cancellation in a translated ancestor.
      names: [...element.querySelectorAll<HTMLElement>("[data-cast-name]")].map(
        (name) => name.offsetHeight,
      ),
      actions,
    };
  });
  process.stdout.write(`C state geometry ${JSON.stringify({ state, ...geometry })}\n`);
  expect(geometry.bottom, state).toBeLessThanOrEqual(geometry.columnBottom + 1);
  if (names) expect(geometry.names.length, state).toBeGreaterThanOrEqual(1);
  for (const height of geometry.names) expect(height, state).toBeLessThanOrEqual(44);
  for (const [index, action] of geometry.actions.entries()) {
    expect(action.width, `${state}: ${action.label}`).toBeGreaterThanOrEqual(44);
    expect(action.height, `${state}: ${action.label}`).toBeGreaterThanOrEqual(44);
    expect(action.left, `${state}: ${action.label}`).toBeGreaterThanOrEqual(geometry.left);
    expect(action.controlRight, `${state}: ${action.label}`).toBeLessThanOrEqual(
      geometry.left + geometry.width,
    );
    expect(action.hit, `${state}: ${action.label}`).toBe(true);
    expect(action.textFits, `${state}: ${action.label}`).toBe(true);
    for (const other of geometry.actions.slice(index + 1)) {
      expect(
        Math.min(action.right, other.right) - Math.max(action.left, other.left),
        state,
      ).toBeLessThanOrEqual(-4);
    }
  }
  await expect(panel.locator("[aria-live]")).toHaveCount(1);
  await expect(panel.locator("[aria-live]")).toHaveAttribute("aria-live", "polite");
  return geometry;
}

test.describe("portrait-side phone cast", () => {
  test.use({ hasTouch: true });
  for (const width of [360, 390]) {
    for (const reducedMotion of ["reduce", "no-preference"] as const) {
      test(`single long away name falls back without clamping ${width}/${reducedMotion}`, async ({
        page,
        request,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ reducedMotion });
        const { characterId } = await castChat(request);
        await setPortraitViaApi(request, characterId, portraitPng("long-away"));
        const name = "AlexandrineMargueriteDeLaRochefortDuChateau".slice(0, 40);
        await page.route("**/api/cast/sheets/**", async (route) => {
          const response = await route.fetch();
          const body = castSheetResponseSchema.parse(await response.json());
          if (body.sheet)
            body.sheet.entries = body.sheet.entries.map((entry) => ({
              ...entry,
              anchor: {
                ...entry.anchor,
                name: entry.anchor.name === SHEET_WOMAN ? name : entry.anchor.name,
              },
            }));
          await route.fulfill({ response, json: body });
        });
        await page.route("**/api/cast/update", async (route) => {
          const response = await route.fetch();
          const body = castUpdateResponseSchema.parse(await response.json());
          const away = body.changes.cast[SHEET_WOMAN];
          if (!away) throw new Error("Missing away fixture");
          delete body.changes.cast[SHEET_WOMAN];
          body.changes.cast[name] = away;
          await route.fulfill({ response, json: body });
        });
        await page.goto("/");
        await expect(castEntry(page, SEEDED)).toBeVisible();
        const tail = castPanel(page).locator("[data-cast-tail]");
        await expect(tail).toHaveText("1 away");
        await expect(tail).toHaveAccessibleName("1 away");
        await expectStackFit(page, `${width}/${reducedMotion}/long-away`);
        await tail.click();
        await expect(
          page.getByRole("dialog", { name: "Cast", exact: true }).getByText(name, { exact: false }),
        ).toBeVisible();
      });
      test(`single away identity fits after names ${width}/${reducedMotion}`, async ({
        page,
        request,
        comfy,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ reducedMotion });
        if (width === 360) await comfy();
        const { characterId } = await castChat(request);
        await setPortraitViaApi(request, characterId, portraitPng("single-away"));
        let failKeeper = false;
        let addPresent = false;
        await page.route("**/api/cast/update", async (route) => {
          if (failKeeper) return route.fulfill({ json: { error: "cast_failed" } });
          if (!addPresent) return route.continue();
          const response = await route.fetch();
          const body = castUpdateResponseSchema.parse(await response.json());
          const template = body.changes.cast[SEEDED];
          if (!template) throw new Error("Missing present fixture");
          body.changes.cast.Beatriz = template;
          await route.fulfill({ response, json: body });
        });
        await page.goto("/");
        await expect(castEntry(page, SEEDED)).toBeVisible();
        const tail = () => castPanel(page).locator("[data-cast-tail]");
        await expect(tail()).toHaveText(`and ${SHEET_WOMAN} away`);
        await expect(tail()).toHaveAccessibleName(`and ${SHEET_WOMAN} away`);
        await expect(castPanel(page).locator("[data-cast-name]")).toHaveCount(1);
        await expectStackFit(page, `${width}/${reducedMotion}/single-away`);
        await page.setViewportSize({ width: width === 360 ? 390 : 360, height: 844 });
        await expect(tail()).toHaveText(`and ${SHEET_WOMAN} away`);
        await expectStackFit(page, `${width}/${reducedMotion}/resized-away`);
        await page.setViewportSize({ width, height: 844 });
        // Keep one present name after removal so retry and Undo retain their
        // ordinary roster owner, rather than removing the last present woman.
        addPresent = true;
        await exchange(page, "A friend joins the lamp room.");
        await expect(castPanel(page).locator("[data-cast-tail]")).toHaveText(
          width === 390 ? "and 2 more" : `and ${SHEET_WOMAN} away`,
        );
        failKeeper = true;
        await exchange(page, "The lamp dims.");
        await expect(
          castPanel(page).getByRole("button", { name: "Try again to update the cast" }),
        ).toBeVisible();
        await expectStackFit(page, `${width}/${reducedMotion}/away-retry`);
        await castEntry(page, SEEDED).click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Remove from cast", exact: true })
          .click();
        await expect(
          castPanel(page).getByRole("button", { name: "Try again to update the cast" }),
        ).toBeVisible();
        await expect(tail()).toHaveText(`and ${SHEET_WOMAN} away`);
        const wrapped = await tail()
          .locator("span")
          .evaluate((node) => ({
            height: node.getBoundingClientRect().height,
            scrollHeight: node.scrollHeight,
            line: Number.parseFloat(getComputedStyle(node).lineHeight),
            textWidth: node.getBoundingClientRect().width,
          }));
        process.stdout.write(
          `C named away with three actions ${JSON.stringify({ width, reducedMotion, ...wrapped })}\n`,
        );
        expect(wrapped.line).toBe(20);
        expect(wrapped.height).toBe(2 * wrapped.line);
        expect(wrapped.scrollHeight).toBeLessThanOrEqual(wrapped.height);
        await expectStackFit(page, `${width}/${reducedMotion}/away-retry-undo`);
        const undo = castPanel(page).getByRole("button", { name: /Undo removing/ });
        await expect(undo).toBeFocused();
        await undo.click();
        await expect(castEntry(page, SEEDED)).toBeVisible();
      });
    }
  }
  for (const width of [360, 390]) {
    for (const reducedMotion of ["reduce", "no-preference"] as const) {
      test(`${width}px ${reducedMotion}: portrait stack waiting uses zero name rows`, async ({
        page,
        request,
        comfy,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ reducedMotion, colorScheme: width === 360 ? "light" : "dark" });
        if (width === 360) await comfy();
        const characterId = await createCharacterViaApi(request, uniqueName("Waiting cast"), {
          firstMessage: "The lamp waits.",
        });
        await setPortraitViaApi(request, characterId, portraitPng("waiting-cast"));
        await patchSettings(request, { characterId });
        await page.goto("/");
        await expect(castPanel(page)).toHaveAttribute("data-cast-stack", "");
        await expect(castStatus(page)).toHaveText("Choose a model to load the cast.");
        await expect(castPanel(page).locator("[data-cast-name]")).toHaveCount(0);
        await expectStackFit(page, `${width}/${reducedMotion}/waiting`, false);
      });
      for (const portrait of [true, false]) {
        test(`${width}px ${reducedMotion} portrait=${portrait}: fit, status, roster and Undo stay reachable`, async ({
          page,
          request,
          comfy,
        }) => {
          test.setTimeout(90_000);
          await page.setViewportSize({ width, height: 844 });
          await page.emulateMedia({ reducedMotion, colorScheme: width === 360 ? "light" : "dark" });
          // Exercise both the portrait-only and the portrait-plus-scene budgets.
          if (width === 360) await comfy();
          const { characterId } = await castChat(request);
          if (portrait) await setPortraitViaApi(request, characterId, portraitPng("cast-band"));
          const names = [
            "Alexandrine Marguerite de la Rochefort du Château de Saint Clair",
            "Beatriz",
            "Cecilia",
            "Dorothea",
            "Eleanor",
          ];
          let calls = 0;
          let failKeeper = false;
          let awayOnly = false;
          let updating = Promise.withResolvers<void>();
          let release = Promise.withResolvers<void>();
          let holdKeeper = true;
          let geometryTrace: string | undefined;
          await page.route("**/api/cast/update", async (route) => {
            if (failKeeper) {
              if (holdKeeper) {
                updating.resolve();
                await release.promise;
              }
              return route.fulfill({ json: { error: "cast_failed" } });
            }
            const response = await route.fetch();
            const body = castUpdateResponseSchema.parse(await response.json());
            const template = body.changes.cast[SEEDED];
            if (template === undefined) throw new Error("Missing keeper fixture");
            const cast = { ...body.changes.cast };
            delete cast[SEEDED];
            for (const name of names)
              cast[name] = awayOnly
                ? { ...template, state: { ...template.state, present: false } }
                : template;
            if (++calls > 1 && holdKeeper) {
              updating.resolve();
              await release.promise;
            }
            await route.fulfill({
              response,
              json: { ...body, changes: { ...body.changes, cast } },
            });
          });
          try {
            await page.goto("/");
            await expect(castEntry(page, names[0] ?? "")).toBeVisible();
            const panel = castPanel(page);
            if (portrait) {
              await expect(panel).toHaveAttribute("data-cast-stack", "");
              const geometry = await panel.evaluate((element) => {
                const group = element.closest<HTMLElement>("[data-presence]");
                const column = group?.firstElementChild;
                const name = element.querySelector<HTMLElement>("[data-cast-name]");
                const label = name?.querySelector<HTMLElement>(
                  "[data-cast-entry] > span:last-child",
                );
                if (!group || !column || !name || !label)
                  throw new Error("Missing portrait grouping");
                return {
                  groupHeight:
                    group.clientHeight - Number.parseFloat(getComputedStyle(group).paddingBottom),
                  columnHeight: column.getBoundingClientRect().height,
                  rosterHeight: element.getBoundingClientRect().height,
                  nameHeight: name.getBoundingClientRect().height,
                  nameScrollWidth: label.scrollWidth,
                  nameWidth: label.clientWidth,
                  portraitRight: column.getBoundingClientRect().right,
                  rosterLeft: element.getBoundingClientRect().left,
                };
              });
              expect(geometry.rosterLeft - geometry.portraitRight).toBeCloseTo(16, 0);
              expect(geometry.nameScrollWidth).toBeLessThanOrEqual(geometry.nameWidth);
              expect(geometry.rosterHeight).toBeLessThanOrEqual(geometry.columnHeight + 1);
              // Translated DOMRect coordinates can add floating-point noise to the height.
              expect(geometry.nameHeight).toBeLessThanOrEqual(44 + 0.001);
              await expect(castEntry(page, names[0] ?? "")).toHaveAccessibleName(
                new RegExp(`^${names[0]}`),
              );
              const clamp = await panel
                .locator("[data-cast-name]")
                .first()
                .locator("[data-cast-entry] > span:last-child")
                .evaluate((element) => ({
                  clamp: getComputedStyle(element).webkitLineClamp,
                  scroll: element.scrollHeight,
                  height: element.getBoundingClientRect().height,
                }));
              expect(clamp.clamp).toBe("2");
              expect(clamp.scroll).toBeGreaterThan(clamp.height);
              const normal = await expectStackFit(page, `${width}/${reducedMotion}/normal`);
              expect(normal.width).toBe(width === 360 ? 208 : 238);
              expect(normal.budget).toBe(width === 360 ? 196 : 144);
              expect(normal.height).toBe(width === 360 ? 189 : 141);
              await expect(panel.locator("[data-cast-tail]")).toHaveText(
                width === 360 ? "and 4 more" : "and 5 more",
              );
              expect(await panel.locator("[data-cast-name]").count()).toBeGreaterThanOrEqual(1);
              await panel.locator("[data-cast-tail]").click();
              const roster = page.getByRole("dialog", { name: "Cast", exact: true });
              for (const name of names)
                await expect(roster.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
              await expect(roster.getByText(SHEET_WOMAN, { exact: false })).toBeVisible();
              await page.keyboard.press("Escape");
            } else {
              await expect(panel).not.toHaveAttribute("data-cast-stack");
            }
            await chooseModel(page, "mock-slow");
            geometryTrace = await page.evaluate(() => {
              const samples: unknown[] = [];
              const phases = new Map<
                string,
                { phase: string; min: number; max: number; frames: number }
              >();
              let frame = 0;
              let previous = "";
              const sample = () => {
                const turn = [...document.querySelectorAll('[data-role="assistant"]')].at(-1);
                const group = turn?.querySelector("[data-presence]");
                const prose = turn?.querySelector(".prose-turn");
                if (group && prose) {
                  const box = (element: Element | null | undefined) =>
                    element?.getBoundingClientRect().toJSON();
                  const state = {
                    turn: turn?.querySelector("[data-edit-for]")?.getAttribute("data-edit-for"),
                    status: turn?.getAttribute("data-status"),
                    text: turn?.querySelector("[data-prose]")?.textContent?.slice(0, 20),
                    relative: prose.getBoundingClientRect().top - group.getBoundingClientRect().top,
                    group: box(group),
                    column: box(group.firstElementChild),
                    portrait: box(group.querySelector('[aria-label^="Portrait of"]')),
                    scene: box(group.querySelector('[aria-label^="Picture"]')),
                    stack: box(group.querySelector("[data-cast-stack]")),
                    rows: [
                      ...group.querySelectorAll(
                        "[data-cast-name], [data-cast-status], [data-cast-tail]",
                      ),
                    ].map(box),
                    prose: box(prose),
                    thought: box(prose.querySelector("details")),
                    open: prose.querySelector("details")?.open,
                    animations: [turn, group, prose, prose.querySelector("details")].flatMap(
                      (element) =>
                        element
                          ? element.getAnimations().map((animation) => ({
                              owner: element.className,
                              state: animation.playState,
                              time: animation.currentTime,
                              property:
                                animation instanceof CSSTransition
                                  ? animation.transitionProperty
                                  : null,
                              translate: getComputedStyle(element).translate,
                            }))
                          : [],
                    ),
                  };
                  const current = JSON.stringify(state);
                  const phase = `${document.querySelectorAll('[data-role="assistant"]').length}/${state.status}/${state.text?.startsWith("Reply:")}/${group.querySelector("[data-cast-status]")?.textContent}`;
                  const prior = phases.get(phase);
                  phases.set(phase, {
                    phase,
                    min: Math.min(prior?.min ?? state.relative, state.relative),
                    max: Math.max(prior?.max ?? state.relative, state.relative),
                    frames: (prior?.frames ?? 0) + 1,
                  });
                  if (current !== previous && samples.length < 2000)
                    samples.push({ at: performance.now(), ...state });
                  previous = current;
                }
                frame = requestAnimationFrame(sample);
              };
              frame = requestAnimationFrame(sample);
              const key = `castGeometry${Math.random()}`;
              Reflect.set(window, key, () => {
                cancelAnimationFrame(frame);
                return { samples, phases: [...phases.values()] };
              });
              return key;
            });
            await send(page, "The lamp is steady.");
            const prose = lastReply(page).locator(".prose-turn").first();
            // Compare in the reply's own coordinates: scrolling the thread is allowed.
            // Both rectangles must come from the same frame of a live stream.
            const relative = () =>
              prose.evaluate((element) => {
                const group = element.closest("[data-message]")?.querySelector("[data-presence]");
                if (!group) return NaN;
                return element.getBoundingClientRect().top - group.getBoundingClientRect().top;
              });
            await expect(lastReply(page).locator("[data-prose]")).toContainText("Reply:");
            if (portrait) {
              await expect(castStatus(page)).toHaveText(STALE);
              await expect(panel.locator("[aria-live]")).not.toContainText(STALE);
            }
            const before = await relative();
            await expect(lastReply(page)).toHaveAttribute("data-status", "complete", {
              timeout: 15_000,
            });
            await updating.promise;
            await expect(castUpdating(page)).toBeVisible();
            await expect
              .poll(() =>
                page
                  .getByRole("log")
                  .locator(":scope > div")
                  .first()
                  .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
              )
              .toBeLessThan(4);
            await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden();
            expect(await relative()).toBeCloseTo(before, 0);
            if (portrait) await expectStackFit(page, `${width}/${reducedMotion}/held Updating`);
            release.resolve();
            await expect(castUpdating(page)).toHaveCount(0);
            expect(await relative()).toBeCloseTo(before, 0);
            await expect(prose.locator("summary")).toBeVisible();
            if (portrait) {
              await castEntry(page, names[0] ?? "").click();
              const record = page.getByRole("dialog");
              await record.getByRole("button", { name: "Remove from cast", exact: true }).click();
              await expect(
                page.getByRole("button", { name: `Undo removing ${names[0]}` }),
              ).toBeVisible();
              await expect(record).toBeHidden();
              const undo = () =>
                castPanel(page).getByRole("button", { name: `Undo removing ${names[0]}` });
              await expect(undo()).toBeFocused();
              await expectStackFit(page, `${width}/${reducedMotion}/removal`);
              const removalText = castPanel(page).locator("[data-cast-removed] > span").first();
              await expect(removalText).toHaveText(names[0] ?? "");
              expect(
                await removalText.evaluate((element) => element.scrollWidth > element.clientWidth),
              ).toBe(true);
              await expect(castPanel(page).locator("[aria-live]")).toContainText(
                `${names[0]} removed.`,
              );
              expect(await relative()).toBeCloseTo(before, 0);
              await undo().click();
              await expect(castEntry(page, names[0] ?? "")).toBeVisible();
              expect(await relative()).toBeCloseTo(before, 0);
              {
                await chooseModel(page, "mock-fast");
                failKeeper = true;
                updating = Promise.withResolvers<void>();
                release = Promise.withResolvers<void>();
                const phraseSamples = page.evaluate(async () => {
                  const samples: string[][] = [];
                  const start = performance.now();
                  while (performance.now() - start < 10_000) {
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    const phrases = [
                      ...document.querySelectorAll<HTMLElement>(
                        "[data-cast-stack] [data-cast-status]",
                      ),
                    ];
                    samples.push(
                      phrases
                        .filter(
                          (element) => Number.parseFloat(getComputedStyle(element).opacity) > 0.05,
                        )
                        .map((element) => element.textContent ?? ""),
                    );
                    if (
                      phrases.some(
                        (element) =>
                          element.textContent === "Couldn't update." &&
                          Number.parseFloat(getComputedStyle(element).opacity) > 0.99,
                      )
                    )
                      break;
                  }
                  return samples;
                });
                await exchange(page, "The lamp falters.");
                await updating.promise;
                await expect(castUpdating(page)).toBeVisible();
                await expect
                  .poll(() =>
                    castUpdating(page).evaluate((element) =>
                      Number.parseFloat(getComputedStyle(element).opacity),
                    ),
                  )
                  .toBeGreaterThan(0.99);
                release.resolve();
                const again = castPanel(page).getByRole("button", {
                  name: "Try again to update the cast",
                });
                await expect(again).toBeVisible();
                const failureOffset = await relative();
                await expectStackFit(page, `${width}/${reducedMotion}/failure`);
                await expect(castStatus(page)).toHaveText("Couldn't update.");
                await expect(castPanel(page).locator("[aria-live]")).toHaveText(
                  "Cast couldn't update.",
                );
                const samples = await phraseSamples;
                expect(samples.every((phrases) => phrases.length <= 1)).toBe(true);
                expect(samples.some((phrases) => phrases.includes("Updating…"))).toBe(true);
                expect(samples.some((phrases) => phrases.includes("Couldn't update."))).toBe(true);
                await castEntry(page, names[0] ?? "").click();
                await page
                  .getByRole("dialog")
                  .getByRole("button", { name: "Remove from cast", exact: true })
                  .click();
                await expect(undo()).toBeFocused();
                await expect(again).toBeVisible();
                await expectStackFit(page, `${width}/${reducedMotion}/removal+failure`);
                await expect(castStatus(page)).toHaveText(`${names[0]} removed.`);
                expect(await relative()).toBeCloseTo(failureOffset, 0);
                await undo().click();
                await expect(castStatus(page)).toHaveText("Couldn't update.");
                failKeeper = false;
                updating = Promise.withResolvers<void>();
                release = Promise.withResolvers<void>();
                await again.click();
                await updating.promise;
                await expect(castUpdating(page)).toBeVisible();
                await expectStackFit(page, `${width}/${reducedMotion}/Retry Updating`);
                expect(await relative()).toBeCloseTo(failureOffset, 0);
                release.resolve();
                await expect(again).toHaveCount(0);
                await expect(castUpdating(page)).toHaveCount(0);
                expect(await relative()).toBeCloseTo(failureOffset, 0);

                // A removal may stand into the next reply and disappear on its keeper snapshot.
                await castEntry(page, names[0] ?? "").click();
                await page
                  .getByRole("dialog")
                  .getByRole("button", { name: "Remove from cast", exact: true })
                  .click();
                await expect(undo()).toBeFocused();
                updating = Promise.withResolvers<void>();
                release = Promise.withResolvers<void>();
                await chooseModel(page, "mock-slow");
                await send(page, "The lamp keeps its place.");
                await expect(lastReply(page).locator("[data-prose]")).toContainText("Reply:");
                const standingOffset = await relative();
                await expectStackFit(page, `${width}/${reducedMotion}/standing removal streaming`);
                await expect(lastReply(page)).toHaveAttribute("data-status", "complete", {
                  timeout: 15_000,
                });
                await updating.promise;
                await expect(undo()).toBeVisible();
                expect(await relative()).toBeCloseTo(standingOffset, 0);
                release.resolve();
                await expect(undo()).toHaveCount(0);
                await expectStackFit(page, `${width}/${reducedMotion}/keeper cleared removal`);
                expect(await relative()).toBeCloseTo(standingOffset, 0);

                // Remove another present member while a mock-slow reply is still writing.
                holdKeeper = false;
                await send(page, "The lamp is still writing.");
                await expect(lastReply(page).locator("[data-prose]")).toContainText("Reply:");
                await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
                const streamingOffset = await relative();
                await castEntry(page, names[1] ?? "").click();
                await page
                  .getByRole("dialog")
                  .getByRole("button", { name: "Remove from cast", exact: true })
                  .click();
                await expectStackFit(page, `${width}/${reducedMotion}/removal during stream`);
                expect(await relative()).toBeCloseTo(streamingOffset, 0);
                await expect(lastReply(page)).toHaveAttribute("data-status", "complete", {
                  timeout: 15_000,
                });
                await expect(castUpdating(page)).toHaveCount(0);
                expect(await relative()).toBeCloseTo(streamingOffset, 0);
                awayOnly = true;
                await chooseModel(page, "mock-fast");
                await exchange(page, "The lamp room empties.");
                await expect(castPanel(page).locator("[data-cast-name]")).toHaveCount(0);
                await expectStackFit(page, `${width}/${reducedMotion}/away-only`, false);
                await expect(castPanel(page).locator("[data-cast-tail]")).toHaveText("4 away");
                await castPanel(page).locator("[data-cast-tail]").click();
                await expect(page.getByRole("dialog", { name: "Cast", exact: true })).toBeVisible();
                await page.keyboard.press("Escape");
              }
            }
          } finally {
            release.resolve();
            if (geometryTrace) {
              const samples = await page.evaluate((key) => {
                const stop = Reflect.get(window, key) as
                  | (() => {
                      samples: unknown[];
                      phases: { phase: string; min: number; max: number; frames: number }[];
                    })
                  | undefined;
                Reflect.deleteProperty(window, key);
                return stop?.();
              }, geometryTrace);
              await test.info().attach("cast-shared-frame-geometry", {
                body: JSON.stringify(samples, null, 2),
                contentType: "application/json",
              });
              process.stdout.write(
                `C shared-frame evidence ${JSON.stringify({ width, reducedMotion, portrait, ...samples })}\n`,
              );
              if (portrait)
                for (const phase of samples?.phases ?? [])
                  if (phase.phase.includes("/streaming/true/"))
                    expect(phase.max - phase.min, phase.phase).toBeLessThan(0.5);
            }
          }
        });
      }
    }
  }
});

/** Holds every request to `url` until the returned release is called. */
async function hold(page: Page, url: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    url,
    async (route: Route) => {
      await released;
      await route.continue();
    },
    { times: 1 },
  );
  return release;
}

test("a first chat without a model asks for one in place, and the cast waits for it instead of failing", async ({
  page,
  request,
}) => {
  // A new library: a character with a greeting is chosen, and no model is.
  const name = uniqueName("Keeper");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse with her brother.`,
    firstMessage: `The lamp room is warm. ${name} looks up from the log.`,
  });
  await patchSettings(request, { characterId });
  const sheets: Request[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().includes("/api/cast/sheets/")) sheets.push(sent);
  });
  await page.goto("/");
  await expect(lastReply(page)).toContainText("The lamp room is warm.");

  // The notice above the composer says why Send waits and holds the picker itself.
  const notice = page.getByRole("status").filter({ hasText: "Choose a model to begin" });
  await expect(notice).toContainText(`${name} replies through the model you choose.`);
  const field = page.getByLabel("Message", { exact: true });
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(field).toHaveAccessibleDescription(/replies through the model you choose/);
  await field.fill("Good evening");
  await expect(sendButton).toBeDisabled();
  await expect(sendButton).toHaveAccessibleDescription(/replies through the model you choose/);

  // The cast waits quietly: nothing was asked, so nothing failed.
  await expect(castStatus(page)).toHaveText("Choose a model to load the cast.");
  await expect(
    castPanel(page).getByRole("button", { name: "Try again to read the cast from the card" }),
  ).toHaveCount(0);
  expect(sheets).toHaveLength(0);

  // Enter, with nothing able to go out, leads to the picker; the draft stays.
  await field.press("Enter");
  const picker = page.getByRole("combobox", { name: "Chat model", exact: true });
  await expect(picker).toBeFocused();
  await expect(field).toHaveValue("Good evening");

  // One choice in place: the notice folds away, focus returns to the draft, Send works.
  await picker.click();
  await page.getByRole("option", { name: "mock-cast", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Good evening");
  await expect(sendButton).toBeEnabled();
  await expect(field).not.toHaveAttribute("aria-describedby");
  await expect.poll(async () => (await readSettings(request)).model).toBe("mock-cast");

  // The card is read as soon as the model is chosen, before anything is sent.
  await expect(castEntry(page, SEEDED)).toBeVisible();
  expect(sheets).toHaveLength(1);
});

test("a first model without a known context window turns the notice to the window, and the cast waits for it too", async ({
  page,
  request,
}) => {
  const name = uniqueName("Keeper");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse with her brother.`,
    firstMessage: `The lamp room is warm. ${name} looks up from the log.`,
  });
  await patchSettings(request, { characterId });
  const sheets: Request[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().includes("/api/cast/sheets/")) sheets.push(sent);
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Chat model", exact: true });
  await picker.click();
  await page.getByRole("option", { name: "mock-nowindow", exact: true }).click();

  // The same notice now says what still blocks, and its way out takes focus.
  const notice = page.getByRole("status").filter({ hasText: "Context window unknown" });
  await expect(notice).toContainText("mock-nowindow has no known context window");
  await expect(page.getByRole("status").filter({ hasText: "Choose a model to begin" })).toHaveCount(
    0,
  );
  await expect(notice.getByRole("link", { name: "Set a context window" })).toBeFocused();
  await expect(picker).toHaveText("mock-nowindow");

  // Nothing could be sized, so nothing was asked: the cast says what it waits for, not a failure.
  await expect(castStatus(page)).toHaveText("Set a context window to load the cast.");
  await expect(castPanel(page).getByRole("button", { name: /^Try again/ })).toHaveCount(0);
  expect(sheets).toHaveLength(0);

  // With a window set, the card is read on the next chat without a Send.
  await patchSettings(request, { contextWindows: { "mock-nowindow": 16_384 } });
  await page.reload();
  await expect(notice).toHaveCount(0);
  await expect.poll(() => sheets.length).toBe(1);
});

test("on a first run, a model without a known context window folds the story's model step into the window notice, which takes focus", async ({
  page,
}) => {
  await page.goto("/");
  const story = page.getByRole("log", { name: "Story" });
  const step = story.getByRole("status").filter({ hasText: "Choose a model to begin" });
  await expect(step).toBeVisible();
  await story.getByRole("combobox", { name: "Chat model", exact: true }).click();
  await page.getByRole("option", { name: "mock-nowindow", exact: true }).click();
  // The step folds away, inert while it does; the notice over the composer says what still blocks.
  const notice = page.getByRole("status").filter({ hasText: "Context window unknown" });
  await expect(notice).toContainText("mock-nowindow has no known context window");
  await expect(notice.getByRole("link", { name: "Set a context window" })).toBeFocused();
  await expect(step).toHaveCount(0);
});

for (const factor of [...FACTORS, { name: "stack", width: 390, height: 844 }]) {
  test(`cast name cue keeps its budget across every palette (${factor.name})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(factor);
    const { characterId } = await castChat(request);
    if (factor.name !== "phone") await setPortraitViaApi(request, characterId, portraitPng("cue"));
    await seeded(page);
    const entry = castEntry(page, SEEDED);
    const name = entry.locator(":scope > span:nth-child(2) > span:first-child");
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    const messageNode = await message.elementHandle();
    // Include the inert closing surface: aria-expanded=false alone does not finish its exit.
    const record = page.getByRole("dialog", { includeHidden: true }).filter({
      has: page.getByRole("heading", { name: SEEDED, includeHidden: true }),
    });
    const observations: unknown[] = [];
    let context = { scheme: "", palette: "" };
    const capture = async (stage: string) => {
      const state = await name.evaluate(
        (node, { message, recordName }) => {
          const entry = node.closest("[data-cast-entry]");
          const active = document.activeElement;
          const style = getComputedStyle(node);
          const records = [...document.querySelectorAll('[role="dialog"]')].filter((surface) =>
            [...surface.querySelectorAll("h1,h2,h3,[role=heading]")].some((heading) =>
              heading.textContent?.includes(recordName),
            ),
          );
          return {
            activeElement: {
              tag: active?.tagName,
              role: active?.getAttribute("role"),
              label: active?.getAttribute("aria-label"),
              isEntry: active === entry,
              isMessage: active === message,
            },
            hovered: entry?.matches(":hover"),
            focusVisible: entry?.matches(":focus-visible"),
            expanded: entry?.getAttribute("aria-expanded"),
            color: style.textDecorationColor,
            ink: style.color,
            line: style.textDecorationLine,
            records: records.map((surface) => ({
              connected: surface.isConnected,
              inert: surface.hasAttribute("inert"),
              ending: surface.hasAttribute("data-ending-style"),
              animations: surface.getAnimations({ subtree: true }).map((animation) => ({
                state: animation.playState,
                currentTime: animation.currentTime,
              })),
            })),
          };
        },
        { message: messageNode, recordName: SEEDED },
      );
      const observation = { factor: factor.name, ...context, stage, ...state };
      observations.push(observation);
      process.stdout.write(`R8 cast cue state ${JSON.stringify(observation)}\n`);
      return state;
    };
    const baseline = await entry.boundingBox();
    try {
      for (const scheme of ["light", "dark"] as const) {
        for (const palette of PALETTES) {
          context = { scheme, palette };
          await page.evaluate(
            ({ scheme, palette }) => {
              document.documentElement.dataset.theme = scheme;
              document.documentElement.dataset.palette = palette;
            },
            { scheme, palette },
          );
          await message.click();
          await expect(message).toBeFocused();
          await expect
            .poll(() =>
              entry.evaluate((node) => ({
                hovered: node.matches(":hover"),
                focusVisible: node.matches(":focus-visible"),
              })),
            )
            .toEqual({ hovered: false, focusVisible: false });
          await expect(name).toHaveCSS("text-decoration-line", "underline");
          // Sample interaction state and both colors together, without polling for a favorable color.
          const quiet = await capture("quiet");
          expect(quiet.activeElement.isMessage).toBe(true);
          expect(quiet.hovered).toBe(false);
          expect(quiet.focusVisible).toBe(false);
          expect(quiet.expanded).toBe("false");
          expect(quiet.records).toHaveLength(0);
          expect(quiet.color).not.toBe(quiet.ink);
          await entry.hover();
          await expect(name).toHaveCSS("text-decoration-color", quiet.ink);
          const hover = await capture("hover");
          expect(hover.color).toBe(hover.ink);
          const box = await entry.boundingBox();
          expect(box?.width).toBeCloseTo(baseline?.width ?? NaN, 3);
          expect(box?.height).toBeCloseTo(baseline?.height ?? NaN, 3);
          await entry.click();
          await expect(entry).toHaveAttribute("aria-expanded", "true");
          await expect(record).toBeVisible();
          await capture("open");
          await expect(name).toHaveCSS("text-decoration-color", "rgba(0, 0, 0, 0)");
          await page.keyboard.press("Escape");
          await expect(entry).toHaveAttribute("aria-expanded", "false");
          await capture("closing");
          await expect(record).toHaveCount(0);
          await expect(entry).toBeFocused();
          await capture("closed-returned");
          process.stdout.write(
            `R8 cast cue ${JSON.stringify({ factor: factor.name, scheme, palette, box })}\n`,
          );
        }
      }
    } finally {
      await capture("final").catch((error: unknown) => {
        observations.push({
          factor: factor.name,
          ...context,
          stage: "final",
          error: String(error),
        });
      });
      await test.info().attach("cast-cue-interaction-states", {
        body: JSON.stringify(observations, null, 2),
        contentType: "application/json",
      });
    }
  });
}

for (const factor of FACTORS) {
  test(`the cast seeds from the card's sheet and the greeting, lists women only, and opens each record (${factor.name})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(factor);
    const { name } = await castChat(request);
    await seeded(page);
    await expect(castEntry(page, SEEDED)).toHaveAttribute("data-present", "true");
    // One sheet call over the card, one seed call over the greeting.
    expect(await upstreamRecords(name, "castSheet")).toHaveLength(1);
    const [seed, ...others] = await upstreamRecords(name, "cast");
    expect(others).toEqual([]);
    expect(seed?.messages.at(-1)?.content).toContain("This is the opening.");
    // The men, the sheet's and the keeper's, are tracked but never listed.
    await expect(castPanel(page)).not.toContainText(KEEPER_MAN);
    await expect(castPanel(page)).not.toContainText(SHEET_MAN);

    if (factor.name === "phone") {
      // The band's tail opens the roster: the sheet's woman, away.
      await castPanel(page)
        .getByRole("button", { name: `and ${SHEET_WOMAN} away` })
        .click();
      const roster = castRecord(page, "Cast");
      await expect(roster).toBeVisible();
      await expect(roster.getByRole("region", { name: "Away" })).toContainText(SHEET_WOMAN);
      await expect(roster).not.toContainText(KEEPER_MAN);
      // Present records use the individual record's groups and stay editable directly.
      const record = roster.getByRole("group", { name: `${SEEDED} record`, exact: true });
      await expect(record).toContainText(KEEPER_WOMAN_OUTFIT);
      await expect(record.locator('[data-cast-edit="outfit"]')).toBeVisible();
      for (const title of ["Looks", "Intimate"]) {
        await expect(
          record.locator("details").filter({ has: page.getByText(title, { exact: true }) }),
        ).not.toHaveAttribute("open", "");
      }
      await expect(
        roster.getByRole("region", { name: "Away" }).locator(":scope > ul > li > details"),
      ).not.toHaveAttribute("open", "");
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The header's control and the latest reply's More menu open the roster too.
      await page.getByRole("button", { name: "Show the cast", exact: true }).click();
      await expect(castRecord(page, "Cast")).toContainText(SEEDED);
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // The greeting, the latest reply here, carries its More itself.
      await moreAction(page, lastReply(page), "Cast");
      await expect(castRecord(page, "Cast")).toContainText(SHEET_WOMAN);
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // A roster entry on the band opens her record straight away.
      await castEntry(page, SEEDED).click();
      await expect(castRecord(page, SEEDED)).toBeVisible();
      await expect(castRecord(page, SEEDED).getByRole("heading", { name: SEEDED })).toBeFocused();
      await page.getByRole("dialog").getByRole("button", { name: "Close the cast" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      return;
    }

    // The column: the away disclosure names her (or counts her where it is narrow).
    await castPanel(page)
      .locator("summary")
      .filter({ hasText: factor.name === "tablet" ? "1 away" : `and ${SHEET_WOMAN} away` })
      .click();
    await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "false");
    // The record opens in a popover beside the entry, its heading focused, and Escape returns.
    const record = await openRecord(page, SEEDED);
    await expect(record.getByRole("heading", { name: SEEDED })).toBeFocused();
    await expect(record).toContainText(KEEPER_WOMAN_OUTFIT);
    await expect(record.locator('[data-cast-edit="outfit"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(record).toHaveCount(0);
    await expect(castEntry(page, SEEDED)).toBeFocused();
  });
}

test("an update starting under the phone's band lights its hairline and says Updating until it lands", async ({
  page,
  request,
}) => {
  await page.setViewportSize(FACTORS[2]);
  await castChat(request);
  await seeded(page);
  const release = await hold(page, "**/api/cast/update");
  await send(page, `Lamp ${mark()}`);
  // The band sits outside the thread's motion: the light fades in all the same.
  const drift = castPanel(page).locator("[data-cast-drift]");
  await expect(drift).toHaveCSS("opacity", "1");
  await expect(castUpdating(page)).toHaveText("Updating…");
  release();
  await expect(drift).toHaveCount(0);
  await expect(castUpdating(page)).toHaveCount(0);
});

test("reduced-motion phone Cast names hold their place through streaming and Updating", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await castChat(request);
  await seeded(page);
  await chooseModel(page, "mock-slow");
  const release = await hold(page, "**/api/cast/update");
  const sampling = page.evaluate(
    () =>
      new Promise<
        {
          x: number;
          y: number;
          headingWidth: number;
          streaming: boolean;
          updating: boolean;
          stale: boolean;
        }[]
      >((resolve) => {
        const frames: {
          x: number;
          y: number;
          headingWidth: number;
          streaming: boolean;
          updating: boolean;
          stale: boolean;
        }[] = [];
        const start = performance.now();
        const sample = () => {
          const panel = [...document.querySelectorAll<HTMLElement>("[data-cast]")].find(
            (node) => node.getBoundingClientRect().width > 0,
          );
          const name = panel?.querySelector("[data-cast-name]");
          const heading = panel?.firstElementChild?.firstElementChild;
          const reply = [...document.querySelectorAll('[data-message][data-role="assistant"]')].at(
            -1,
          );
          if (panel && name && heading) {
            const bounds = panel.getBoundingClientRect();
            const rect = name.getBoundingClientRect();
            const frame = {
              x: rect.left - bounds.left,
              y: rect.top - bounds.top,
              headingWidth: heading.getBoundingClientRect().width,
              streaming: reply?.getAttribute("data-status") === "streaming",
              updating: panel.querySelector("[data-cast-updating]") !== null,
              stale: panel.textContent?.includes("As of the previous reply") ?? false,
            };
            frames.push(frame);
            if (frame.updating) return resolve(frames);
          }
          if (performance.now() - start > 15_000) return resolve(frames);
          requestAnimationFrame(sample);
        };
        sample();
      }),
  );
  try {
    // No marker: the keeper returns the same names before and after this reply.
    await send(page, "Lamp without a marker.");
    const frames = await sampling;
    const streaming = frames.filter((frame) => frame.streaming);
    expect(streaming.length).toBeGreaterThan(2);
    expect(streaming.some((frame) => frame.stale)).toBe(false);
    expect(frames.some((frame) => frame.updating)).toBe(true);
    expect(new Set(frames.map(({ x, y, headingWidth }) => `${x},${y},${headingWidth}`)).size).toBe(
      1,
    );
    await expect(castUpdating(page)).toBeVisible();
    const before = await castPanel(page).locator("[data-cast-name]").first().boundingBox();
    release();
    await expect(castUpdating(page)).toHaveCount(0);
    const after = await castPanel(page).locator("[data-cast-name]").first().boundingBox();
    expect(after?.x).toBe(before?.x);
    expect(after?.y).toBe(before?.y);
  } finally {
    release();
  }
});

test("the narrator is sent the whole cast, and the inspector shows its block, its state line, the counts and the keeper", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const line = `Up the stairs ${mark()}`;
  await exchange(page, line);
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  const next = `Onward ${crypto.randomUUID()} [e2e-usage:zero-cache]`;
  const narrated = Promise.withResolvers<{ body: string }>();
  // Buffer this accounting observation outside Chromium's response-body cache,
  // forwarding the real endpoint's status, headers and unchanged response bytes.
  await page.route(
    "**/api/chat",
    async (route) => {
      try {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const body = await response.body();
        await route.fulfill({ response, body });
        narrated.resolve({ body: body.toString("utf8") });
      } catch (error) {
        narrated.reject(error);
      }
    },
    { times: 1 },
  );
  const kept = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/cast/update" &&
      (response.request().postData() ?? "").includes(next) &&
      response.ok(),
  );
  const [{ body: narrationBody }, keeperResponse] = await Promise.all([
    narrated.promise,
    kept,
    exchange(page, next),
  ]);
  // The next request: everyone in the block, the man present on the state line.
  const sent = await chatRecord(next);
  const block = castBlock(sent);
  for (const person of [SEEDED, womanOf(line), KEEPER_MAN, SHEET_WOMAN, SHEET_MAN]) {
    expect(block).toContain(person);
  }
  expect(stateLine(sent)).toContain(`${KEEPER_MAN}: present`);
  expect(stateLine(sent)).toContain(`Away: ${SHEET_WOMAN}`);
  await expect(castPanel(page)).not.toContainText(KEEPER_MAN);
  // The keeper read the newest turns once they were written.
  await expect
    .poll(async () => (await upstreamRecords(next, "cast")).map((call) => call.completed))
    .toEqual([true]);

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByText("Cast", { exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText(KEEPER_MAN);
  await inspector(page)
    .getByRole("button", { name: /Chat history/ })
    .click();
  await expect(inspector(page).getByText(/^Cast state, /)).toBeVisible();
  // Rows are the actual receipts for this narration and its keeper,
  // not earlier sheet/seed calls or the preceding narration.
  const parts = narrationBody
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; data?: unknown });
  const narration = callAccountingSchema.parse(
    parts.find((part) => part.type === "data-usage")?.data,
  ).calls;
  const keeperBody = (await keeperResponse.json()) as { accounting?: unknown };
  const keeper = callAccountingSchema.parse(keeperBody.accounting).calls;
  expect(narration.map((call) => call.purpose)).toEqual(["narration"]);
  expect(keeper.map((call) => call.purpose)).toEqual(["cast.update"]);
  expect(narration[0]?.usage.cachedTokens).toBe(0);
  expect(keeper[0]?.usage.cachedTokens).toBeUndefined();

  const usage = inspector(page).getByRole("region", { name: "Usage", exact: true });
  await usage.getByRole("button", { name: /^This request/ }).click();
  const requestTable = usage.getByRole("table", { name: "This request usage", exact: true });
  const rows = requestTable.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("1. Narration");
  await expect(rows.nth(0)).toContainText("mock-fast");
  await expect(rows.nth(1)).toContainText("2. Cast keeper");
  await expect(rows.nth(1)).toContainText("mock-cast");
  for (const [index, receipt] of [...narration, ...keeper].entries()) {
    await expect(rows.nth(index).getByRole("cell").nth(0)).toHaveText(
      new Intl.NumberFormat("en").format(receipt.usage.inputTokens ?? Number.NaN),
    );
  }
  await expect(
    requestTable.getByRole("columnheader", { name: "Cached", exact: true }),
  ).toBeVisible();
  await expect(rows.nth(0).getByRole("cell").nth(1)).toHaveText("0");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toContainText("not reported");
  await expect(rows.nth(0).getByRole("cell").nth(2)).toContainText(`${MOCK_OUTPUT_TOKENS}`);
  await expect(rows.nth(0).getByRole("cell").nth(2)).toContainText(
    `${MOCK_REASONING_TOKENS} reasoning`,
  );
  await expect(rows.nth(1).getByRole("cell").nth(2)).toHaveText(
    formatCount(keeper[0]?.usage.outputTokens ?? 0),
  );
  await usage.getByRole("button", { name: /^This session/ }).click();
  const sessionTable = usage.getByRole("table", { name: "This session usage", exact: true });
  await expect(sessionTable.getByRole("row", { name: /Narration/ })).toContainText("(2)");
  await expect(sessionTable.getByRole("row", { name: /Cast keeper/ })).toContainText("(3)");
  await expect(sessionTable.getByRole("row", { name: /Cast sheet/ })).toContainText("(1)");
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveCount(0);

  await clearChat(page);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(
    inspector(page).getByRole("button", { name: "Last sent", exact: true }),
  ).toBeDisabled();
  await expect(inspector(page).getByRole("region", { name: "Usage", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await exchange(page, `Fresh ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await usage.getByRole("button", { name: /^This session/ }).click();
  await expect(sessionTable.getByRole("row", { name: /Narration/ })).toContainText("(1)");
  await expect(sessionTable.getByRole("row", { name: /Cast keeper/ })).toContainText("(1)");
  await expect(sessionTable.getByRole("row", { name: /Cast sheet/ })).toHaveCount(0);
});

test("a grounded development reaches the record and dynamic prompt while its baseline stays stable", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  await exchange(page, DEVELOPMENT_TURN);
  await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "true");
  const record = await openRecord(page, SHEET_WOMAN);
  await expect(record.locator('[data-cast-field="hair"]')).toContainText(DEVELOPED_HAIR);
  await expect(record.locator('[data-cast-field="hair"]')).not.toContainText("dark brown");
  await expect(record).not.toContainText("ungrounded personality fixture");
  await page.keyboard.press("Escape");

  const next = `Look again ${crypto.randomUUID()}`;
  await exchange(page, next);
  const sent = await chatRecord(next);
  expect(castBlock(sent)).toContain("shoulder-length dark brown hair in loose waves");
  expect(castBlock(sent)).not.toContain(DEVELOPED_HAIR);
  expect(stateLine(sent)).toContain(`hair: ${DEVELOPED_HAIR}`);
  expect(stateLine(sent)).toContain("authoritative over <cast> baseline");
  expect(stateLine(sent)).not.toContain("ungrounded personality fixture");
});

test("a swipe shows its own snapshot, an alternate without one shows the previous marked stale", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const first = `First ${mark()}`;
  await exchange(page, first);
  await expect(castEntry(page, womanOf(first))).toBeVisible();
  const second = `Second ${mark()}`;
  await exchange(page, second);
  await expect(castEntry(page, womanOf(second))).toBeVisible();

  // The new alternate's keeper call is held: the roster shows the previous snapshot, updating.
  const release = await hold(page, "**/api/cast/update");
  const drift = castPanel(page).locator("[data-cast-drift]");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(drift).toHaveCount(1);
  await expect(castUpdating(page)).toHaveText("Updating…");
  await expect(castEntry(page, womanOf(second))).toHaveCount(0);
  await expect(castEntry(page, womanOf(first))).toBeVisible();

  // The first alternate brings its own snapshot back.
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(replyCounter(page)).toContainText("1 / 2");
  await expect(castEntry(page, womanOf(second))).toBeVisible();
  // The held answer lands for an alternate no longer shown: dropped.
  release();
  await expect(drift).toHaveCount(0);
  await expect(castUpdating(page)).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");

  // The second alternate has no snapshot: the previous one, marked stale.
  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(castStatus(page)).toHaveText(STALE);
  await expect(castEntry(page, womanOf(second))).toHaveCount(0);
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(castStatus(page)).toHaveText("");
  await expect(castEntry(page, womanOf(second))).toBeVisible();

  // A swipe past the end writes the new alternate's snapshot.
  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("3 / 3");
  await expect(castEntry(page, womanOf(second))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
  await expect.poll(async () => (await upstreamRecords(second, "cast")).length).toBe(3);
});

test("Continue runs the keeper again over the whole continued reply", async ({ page, request }) => {
  await castChat(request);
  await seeded(page);
  const line = `At the rail ${mark()}`;
  await exchange(page, line);
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  expect(await upstreamRecords(line, "cast")).toHaveLength(1);
  await replyActions(page).getByRole("button", { name: "Continue" }).click();
  // The mock continues with "and on" and the last user-role message, here the cast's state line.
  await expect(lastReply(page)).toContainText(" and on ");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect.poll(async () => (await upstreamRecords(line, "cast")).length).toBe(2);
  const [, again] = await upstreamRecords(line, "cast");
  expect(again?.messages.at(-1)?.content).toContain(" and on ");
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
});

test("editing the newest reply drops its snapshot, and the next keeper call catches up from the last good one", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const line = `By the door ${mark()}`;
  await exchange(page, line);
  await expect(castEntry(page, womanOf(line))).toBeVisible();

  const rewritten = `She came back later ${mark()}`;
  await moreAction(page, replyActions(page), "Edit");
  await lastReply(page)
    .getByRole("textbox", { name: /^Edit / })
    .fill(rewritten);
  await page.keyboard.press("Control+Enter");
  await expect(lastReply(page)).toContainText(rewritten);
  // The edited reply's snapshot went with its old text: the greeting's shows, stale.
  await expect(castStatus(page)).toHaveText(STALE);
  await expect(castEntry(page, womanOf(line))).toHaveCount(0);
  await expect(castEntry(page, SEEDED)).toBeVisible();

  // The next call reads every turn since the greeting's snapshot, the edit included.
  const next = `Quiet now ${crypto.randomUUID()}`;
  await exchange(page, next);
  await expect(castEntry(page, womanOf(rewritten))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
  const [call, ...more] = await upstreamRecords(next, "cast");
  expect(more).toEqual([]);
  const turns = call?.messages.at(-1)?.content ?? "";
  expect(turns).toContain(line);
  expect(turns).toContain(rewritten);
});

test("a message sent before the sheet lands goes without it; the sheet then joins every base, with no seed", async ({
  page,
  request,
}) => {
  const { name } = await castChat(request);
  const release = await hold(page, "**/api/cast/sheets/**");
  await page.goto("/");
  await expect(castStatus(page)).toHaveText("Reading the card");
  // A model-derived sheet stays in the background while the narrator and keeper run.
  await expect(page.locator("[data-greeting]")).toContainText("The lamp room is warm.");

  const first = `Early ${mark()}`;
  const firstUpdate = page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/cast/update",
  );
  await exchange(page, first);
  expect((await firstUpdate).postDataJSON()).toMatchObject({
    mode: "update",
    sheetFingerprint: null,
  });
  await expect(castEntry(page, womanOf(first))).toBeVisible();
  expect(castBlock(await chatRecord(first)) ?? "").not.toContain(SHEET_WOMAN);
  // The keeper caught up from the start: the greeting and the first exchange.
  const [call] = await upstreamRecords(first, "cast");
  expect(call?.messages.at(-1)?.content).toContain("The lamp room is warm.");

  release();
  await castPanel(page)
    .locator("summary")
    .filter({ hasText: `and ${SHEET_WOMAN} away` })
    .click();
  await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "false");

  const second = `Later ${crypto.randomUUID()}`;
  const secondUpdate = page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/cast/update",
  );
  await exchange(page, second);
  const body = (await secondUpdate).postDataJSON() as { sheetFingerprint: unknown };
  expect(typeof body.sheetFingerprint).toBe("string");
  expect(castBlock(await chatRecord(second))).toContain(SHEET_WOMAN);
  // The greeting was no longer the newest reply: never seeded.
  await expect.poll(async () => (await upstreamRecords(name, "cast")).length).toBe(2);
  const calls = await upstreamRecords(name, "cast");
  expect(calls.some((one) => one.messages.at(-1)?.content.includes("This is the opening."))).toBe(
    false,
  );
});

test("a failed keeper call says so and Try again runs it with the cast model Settings chose", async ({
  page,
  request,
}) => {
  await castChat(request);
  // Memory's model, which Try again falls back to below, is the cast one too.
  await patchSettings(request, { memoryModel: "mock-cast" });
  await seeded(page);
  await chooseCastModel(page, "mock-error");
  expect((await readSettings(request)).castModel).toBe("mock-error");

  const line = `Out in the rain ${mark()}`;
  await exchange(page, line);
  await expect(castStatus(page)).toHaveText("Cast couldn't update.");
  const again = castPanel(page).getByRole("button", { name: "Try again to update the cast" });
  await expect(again).toBeVisible();
  // The last good cast still shows.
  await expect(castEntry(page, SEEDED)).toBeVisible();
  await expect(castEntry(page, womanOf(line))).toHaveCount(0);
  const [failed] = await upstreamRecords(line, "cast");
  expect(failed?.model).toBe("mock-error");

  // Back to memory's model.
  await chooseCastModel(page, "Memory's model");
  expect((await readSettings(request)).castModel).toBeNull();
  await again.click();
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await expect(castStatus(page)).toHaveText("");
  await expect(again).toHaveCount(0);
  const [, retried] = await upstreamRecords(line, "cast");
  expect(retried?.model).toBe("mock-cast");
});

test("retrying an unread empty sheet queues reselected B1 behind the running keeper once", async ({
  page,
  request,
}) => {
  const name = uniqueName("Empty sheet retry");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse. ${SHEET_RETRY_EMPTY}`,
  });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-cast", characterId });
  const sheetFailed = Promise.withResolvers<void>();
  const sheetRetried = Promise.withResolvers<unknown>();
  const releaseSheet = Promise.withResolvers<void>();
  let sheetRequests = 0;
  await page.route("**/api/cast/sheets/**", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const attempt = ++sheetRequests;
    const response = await route.fetch();
    const body = await response.body();
    if (attempt === 1) {
      expect(JSON.parse(body.toString("utf8"))).toMatchObject({ error: "cast_failed" });
      sheetFailed.resolve();
      await releaseSheet.promise;
    }
    await route.fulfill({ response, body });
    if (attempt === 2) sheetRetried.resolve(JSON.parse(body.toString("utf8")));
  });
  const kept = Promise.withResolvers<Request>();
  const releaseKeeper = Promise.withResolvers<void>();
  const keeperDelivered = Promise.withResolvers<void>();
  const keeperRequests: Request[] = [];
  const failedRequests: Request[] = [];
  page.on("requestfailed", (sent) => failedRequests.push(sent));
  // Buffer only this real keeper endpoint in memory, leaving its browser request in flight.
  await page.route("**/api/cast/update", async (route) => {
    keeperRequests.push(route.request());
    const first = keeperRequests.length === 1;
    const response = await route.fetch();
    const body = await response.body();
    expect(response.ok()).toBe(true);
    if (first) {
      kept.resolve(route.request());
      await releaseKeeper.promise;
    }
    await route.fulfill({ response, body });
    if (first) keeperDelivered.resolve();
  });

  await page.goto("/");
  await sheetFailed.promise;
  const line = `Before anyone is known ${mark()}`;
  await exchange(page, line);
  const keeperRequest = await kept.promise;
  expect(keeperRequest.postDataJSON()).toMatchObject({ sheetFingerprint: null, mode: "update" });
  const newer = `Queued newer reply ${mark()}`;
  await exchange(page, newer);
  const baseline = await chatRecord(newer);
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(replyCounter(page)).toContainText("1 / 2");
  expect(keeperRequests).toHaveLength(1);
  const narration = await upstreamRecords(newer);
  expect(narration.map((one) => one.model)).toEqual(["mock-fast", "mock-fast"]);
  expect(castBlock(narration[1])).toBe(castBlock(baseline));
  expect(stateLine(narration[1])).toBe(stateLine(baseline));
  await expect(castPanel(page).locator("[data-cast-entry]")).toHaveCount(0);
  releaseSheet.resolve();
  const again = castPanel(page).getByRole("button", {
    name: "Try again to read the cast from the card",
  });
  await expect(again).toBeVisible();
  await expect(castStatus(page)).toHaveText("Couldn't read the cast from the card.");
  await again.click();
  expect(await sheetRetried.promise).toMatchObject({ sheet: { entries: [] }, current: true });
  await expect(again).toHaveCount(0);
  await expect(castPanel(page)).toHaveCount(0);
  expect(failedRequests).not.toContain(keeperRequest);
  expect(await upstreamRecords(line, "cast")).toHaveLength(1);
  expect(keeperRequests).toHaveLength(1);
  expect(await upstreamRecords(newer, "cast")).toHaveLength(0);

  releaseKeeper.resolve();
  await keeperDelivered.promise;
  await expect(castEntry(page, womanOf(newer))).toBeVisible();
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await expect(castPanel(page).locator("[data-cast-drift]")).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");
  expect(failedRequests).not.toContain(keeperRequest);
  expect(await upstreamRecords(name, "castSheet")).toHaveLength(2);
  expect(
    (await upstreamRecords(line, "cast")).map(({ completed, aborted }) => ({ completed, aborted })),
  ).toEqual([{ completed: true, aborted: false }]);
  expect(keeperRequests).toHaveLength(2);
  expect(keeperRequests[1]?.postDataJSON()).toMatchObject({
    model: "mock-cast",
    turns: [
      { role: "user", content: newer },
      { role: "assistant", content: `Reply: ${newer.replace("-in-", "-out-")}` },
    ],
  });
  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(castEntry(page, womanOf(newer))).toHaveCount(0);
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(castEntry(page, womanOf(newer))).toBeVisible();
  expect((await upstreamRecords(newer, "cast")).map((one) => one.model)).toEqual(["mock-cast"]);
  expect(await upstreamRecords(line, "cast")).toHaveLength(1);
});

test("a joined retry waits for the failed sheet reload before spending on the newly selected cast model", async ({
  page,
  request,
}) => {
  const name = uniqueName("Joined sheet retry");
  const characterId = await createCharacterViaApi(request, name, {
    description: `${name} keeps the lighthouse. ${SHEET_RETRY_EMPTY}`,
  });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-fast", characterId });
  const sheetFailed = Promise.withResolvers<void>();
  const releaseFailure = Promise.withResolvers<void>();
  const reloadSeen = Promise.withResolvers<void>();
  const releaseReload = Promise.withResolvers<void>();
  let sheets = 0;
  await page.route("**/api/cast/sheets/**", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const first = ++sheets === 1;
    const response = await route.fetch();
    const body = await response.body();
    if (first) {
      expect(JSON.parse(body.toString("utf8"))).toMatchObject({ error: "cast_failed" });
      sheetFailed.resolve();
      await releaseFailure.promise;
    } else {
      expect(JSON.parse(body.toString("utf8"))).toMatchObject({ sheet: { entries: [] } });
      reloadSeen.resolve();
      await releaseReload.promise;
    }
    await route.fulfill({ response, body });
  });
  const keeperSeen = Promise.withResolvers<void>();
  const releaseKeeper = Promise.withResolvers<void>();
  const keeperDelivered = Promise.withResolvers<void>();
  const keeperRequests: Request[] = [];
  await page.route("**/api/cast/update", async (route) => {
    const first = keeperRequests.push(route.request()) === 1;
    const response = await route.fetch();
    const body = await response.body();
    expect(response.ok()).toBe(true);
    if (first) {
      keeperSeen.resolve();
      await releaseKeeper.promise;
    }
    await route.fulfill({ response, body });
    if (first) keeperDelivered.resolve();
  });
  await page.goto("/");
  await sheetFailed.promise;
  const line = `New keeper model ${mark()}`;
  await exchange(page, line);
  await keeperSeen.promise;
  releaseFailure.resolve();
  const again = castPanel(page).getByRole("button", {
    name: "Try again to read the cast from the card",
  });
  await expect(again).toBeVisible();
  await chooseCastModel(page, "mock-cast");
  await again.click();
  await reloadSeen.promise;
  await expect(again).toHaveCount(0);
  expect(keeperRequests).toHaveLength(1);
  expect((await upstreamRecords(line, "cast")).map((one) => one.model)).toEqual(["mock-fast"]);
  releaseReload.resolve();
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  expect(keeperRequests).toHaveLength(2);
  expect(keeperRequests[1]?.postDataJSON()).toMatchObject({ model: "mock-cast" });
  releaseKeeper.resolve();
  await keeperDelivered.promise;
  await expect(castEntry(page, womanOf(line))).toBeVisible();
  expect((await upstreamRecords(line, "cast")).map((one) => one.model)).toEqual([
    "mock-fast",
    "mock-cast",
  ]);
  expect(await upstreamRecords(name, "castSheet")).toHaveLength(2);
});

test("an empty failed alternate hides an older keeper failure over covered cast, and reselecting it recovers once", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const covered = `Covered reply ${mark()}`;
  await exchange(page, covered);
  await expect(castEntry(page, womanOf(covered))).toBeVisible();

  await chooseCastModel(page, "mock-error");
  const uncovered = `Uncovered reply ${mark()}`;
  await exchange(page, uncovered);
  const again = castPanel(page).getByRole("button", { name: "Try again to update the cast" });
  await expect(again).toBeVisible();
  await expect(castStatus(page)).toHaveText("Cast couldn't update.");
  expect((await upstreamRecords(uncovered, "cast")).map((one) => one.model)).toEqual([
    "mock-error",
  ]);
  const baseline = await chatRecord(uncovered);
  expect(stateLine(baseline)).toContain(womanOf(covered));

  await chooseCastModel(page, "mock-cast");
  await chooseModel(page, "mock-error");
  await replyActions(page).getByRole("button", { name: "New reply" }).click();
  await expect(replyCounter(page)).toContainText("2 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "failed");
  await expect(lastReply(page).locator("[data-swipe]:not([data-leaving]) [data-prose]")).toHaveText(
    "No reply: the model's provider answered with an error.Try again",
  );
  await expect(again).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");
  await expect(castEntry(page, womanOf(covered))).toBeVisible();
  await expect(castEntry(page, womanOf(uncovered))).toHaveCount(0);
  const narration = await upstreamRecords(uncovered);
  expect(narration.map((one) => one.model)).toEqual(["mock-fast", "mock-error"]);
  expect(castBlock(narration[1])).toBe(castBlock(baseline));
  expect(stateLine(narration[1])).toBe(stateLine(baseline));
  expect(await upstreamRecords(covered, "cast")).toHaveLength(1);
  expect(await upstreamRecords(uncovered, "cast")).toHaveLength(1);

  // The failure belongs to C1: selecting it exposes recovery without automatically spending a call.
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(replyCounter(page)).toContainText("1 / 2");
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  await expect(lastReply(page)).toContainText(uncovered.replace("-in-", "-out-"));
  await expect(again).toBeVisible();
  expect(await upstreamRecords(uncovered, "cast")).toHaveLength(1);
  await again.click();
  await expect(castEntry(page, womanOf(uncovered))).toBeVisible();
  await expect(again).toHaveCount(0);
  await expect(castStatus(page)).toHaveText("");
  expect((await upstreamRecords(uncovered, "cast")).map((one) => one.model)).toEqual([
    "mock-error",
    "mock-cast",
  ]);

  await replyCounter(page).getByRole("button", { name: "Next reply" }).click();
  await expect(lastReply(page)).toHaveAttribute("data-status", "failed");
  await expect(lastReply(page).locator("[data-swipe]:not([data-leaving]) [data-prose]")).toHaveText(
    "No reply: the model's provider answered with an error.Try again",
  );
  await expect(castEntry(page, womanOf(covered))).toBeVisible();
  await expect(castEntry(page, womanOf(uncovered))).toHaveCount(0);
  await expect(again).toHaveCount(0);
  await replyCounter(page).getByRole("button", { name: "Previous reply" }).click();
  await expect(castEntry(page, womanOf(uncovered))).toBeVisible();
  expect(await upstreamRecords(uncovered, "cast")).toHaveLength(2);
  expect(await upstreamRecords(covered, "cast")).toHaveLength(1);
});

test("a value corrects where it stands, Escape and leaving unchanged keep it, and Revert takes a correction back", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const record = await openRecord(page, SEEDED);
  const field = (name: string) => record.locator(`[data-cast-field="${name}"]`);
  const outfit = record.locator('[data-cast-edit="outfit"]');
  const box = record.getByRole("textbox", { name: "Outfit", exact: true });

  // Escape leaves the field, not the record, and keeps the value.
  await outfit.click();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(KEEPER_WOMAN_OUTFIT);
  await expect(box).toHaveAttribute("maxlength", String(CAST_LIMITS.field));
  await box.fill("a red scarf");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(record).toBeVisible();
  await expect(outfit).toBeFocused();
  await expect(field("outfit")).toContainText(KEEPER_WOMAN_OUTFIT);
  await expect(field("outfit")).not.toHaveAttribute("data-cast-corrected");

  // Leaving it unchanged corrects nothing.
  await outfit.click();
  await record.getByRole("heading", { name: SEEDED }).click();
  await expect(box).toHaveCount(0);
  await expect(field("outfit")).not.toHaveAttribute("data-cast-corrected");

  // Enter saves: a look that holds for the chat, a state the next update takes over.
  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);
  await editRecord(page, SEEDED, { hair: "short silver hair", outfit: "a red scarf" });
  await expect(field("hair")).toContainText("short silver hair");
  await expect(field("hair")).toHaveAttribute("data-cast-corrected", "");
  await expect(field("outfit")).toContainText("a red scarf");
  await expect(field("outfit")).toHaveAttribute("data-cast-corrected", "");
  await expect(record.getByRole("button", { name: "Revert hair" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(record).toHaveCount(0);

  // Both go out in the next request. Its keeper call names her again: it takes the state over,
  // and the look holds against it.
  const line = `The lamp turns ${crypto.randomUUID()}`;
  await exchange(page, line);
  const sent = await chatRecord(line);
  expect(castBlock(sent)).toContain("short silver hair");
  expect(stateLine(sent)).toContain("a red scarf");
  await expect
    .poll(async () => (await upstreamRecords(line, "cast")).map((call) => call.completed))
    .toEqual([true]);
  await openRecord(page, SEEDED);
  await expect(field("hair")).toHaveAttribute("data-cast-corrected", "");
  await expect(field("hair")).toContainText("short silver hair");
  await expect(field("outfit")).toContainText(KEEPER_WOMAN_OUTFIT);
  await expect(field("outfit")).not.toHaveAttribute("data-cast-corrected");

  await record.locator("summary").filter({ hasText: "Looks" }).click();
  await record.getByRole("button", { name: "Revert hair" }).click();
  await expect(field("hair")).toContainText("long copper-red hair in a braid");
  await expect(field("hair")).not.toHaveAttribute("data-cast-corrected");
  await expect(record.getByRole("button", { name: "Revert hair" })).toHaveCount(0);
});

test.describe("narrow cast correction", () => {
  test.use({ hasTouch: true });

  for (const width of [360, 390]) {
    test(`${width}px outfit edits use the record width and preserve completion keys`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await castChat(request);
      await seeded(page);
      const record = await openRecord(page, SEEDED);
      const outfit = record.locator('[data-cast-edit="outfit"]');
      const row = record
        .locator("dt")
        .filter({ hasText: /^Outfit$/ })
        .locator("..");
      const label = row.locator("dt");
      const labelX = (await label.boundingBox())?.x;
      const box = record.getByRole("textbox", { name: "Outfit", exact: true });
      const long =
        "A rain-dark wool coat over a long linen dress, sturdy boots and a loosely tied red scarf.";
      await outfit.click();
      await box.fill(long);
      await expect(box).toBeFocused();
      expect((await label.boundingBox())?.x).toBe(labelX);
      const fieldBox = await box.boundingBox();
      const rowBox = await row.boundingBox();
      const labelBox = await label.boundingBox();
      expect(fieldBox?.y).toBeGreaterThanOrEqual((labelBox?.y ?? 0) + (labelBox?.height ?? 0));
      expect(fieldBox?.width).toBeGreaterThanOrEqual(rowBox?.width ?? Infinity);

      // Composition and Shift+Enter keep editing; Escape cancels without closing the record.
      await box.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
      await expect(box).toBeFocused();
      await box.press("End");
      await box.press("Shift+Enter");
      await expect(box).toHaveValue(`${long}\n`);
      await box.press("Escape");
      await expect(box).toHaveCount(0);
      await expect(outfit).toBeFocused();
      await expect(outfit).toContainText(KEEPER_WOMAN_OUTFIT);

      await outfit.click();
      await box.fill(`  ${long}  `);
      // Reduced viewport height approximates keyboard room, not a native keyboard.
      await page.setViewportSize({ width, height: 480 });
      await box.scrollIntoViewIfNeeded();
      const done = record.getByRole("button", { name: "Done", exact: true });
      await done.scrollIntoViewIfNeeded();
      for (const control of [box, done]) {
        const bounds = await control.boundingBox();
        expect(bounds?.y).toBeGreaterThanOrEqual(0);
        expect((bounds?.y ?? Infinity) + (bounds?.height ?? Infinity)).toBeLessThanOrEqual(480);
      }
      await done.click();
      await expect(box).toHaveCount(0);
      await expect(outfit).toBeFocused();
      await expect(outfit).toContainText(long);
      await expect(row.locator("[data-inline-save]")).toHaveText("Saved");
      await expect(row.getByRole("button", { name: "Revert outfit" })).toBeVisible();

      await outfit.click();
      await box.fill("a blue scarf");
      await box.press("Enter");
      await expect(box).toHaveCount(0);
      await expect(outfit).toBeFocused();
      await expect(outfit).toContainText("a blue scarf");
      await outfit.click();
      await box.fill("a green scarf");
      await record.getByRole("heading", { name: SEEDED }).click();
      await expect(box).toHaveCount(0);
      await expect(outfit).toContainText("a green scarf");
      await row.getByRole("button", { name: "Revert outfit" }).click();
      await expect(outfit).toContainText(KEEPER_WOMAN_OUTFIT);
    });
  }
});

test("an empty More details correction moves with focus and Saved feedback", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const record = await openRecord(page, SEEDED);
  await record.locator("summary").filter({ hasText: "More details" }).click();
  await record.locator('[data-cast-edit="disarray"]').click();
  const field = record.locator('textarea[data-cast-field="disarray"]');
  await field.fill("coat unbuttoned");
  await field.press("Enter");
  const value = record.locator('[data-cast-edit="disarray"]');
  await expect(value).toBeFocused();
  await expect(value).toContainText("coat unbuttoned");
  await expect(value.locator("..").locator("[data-inline-save]")).toHaveText("Saved");
  await expect(value.locator("xpath=ancestor::section[1]")).toContainText("Now");
});

test("the phone roster can remove an expanded away member", async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await castChat(request);
  await seeded(page);
  await castPanel(page)
    .getByRole("button", { name: `and ${SHEET_WOMAN} away` })
    .click();
  const roster = castRecord(page, "Cast");
  const away = roster.getByRole("region", { name: "Away" });
  await away.locator("summary").filter({ hasText: SHEET_WOMAN }).click();
  await away.getByRole("button", { name: "Remove from cast", exact: true }).click();
  await expect(roster).toHaveCount(0);
  await expect(castPanel(page)).toContainText(`${SHEET_WOMAN} removed.`);
  await expect(castPanel(page).getByRole("button", { name: /away/ })).toHaveCount(0);
  const undo = castPanel(page).getByRole("button", { name: `Undo removing ${SHEET_WOMAN}` });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(
    castPanel(page).getByRole("button", { name: `and ${SHEET_WOMAN} away` }),
  ).toBeVisible();
});

test("personality keywords, a repeated one included, revert to exactly the recorded ones", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const record = await editRecord(page, SEEDED, { personality: "shy, shy, curious, kind" });
  const personality = record.locator('[data-cast-field="personality"]');
  const words = personality.locator("[data-tone]");
  await expect(words).toHaveCount(4);
  await expect(personality).toHaveText("shy, shy, curious, kind");
  await record.getByRole("button", { name: "Revert personality" }).click();
  await expect(personality).not.toHaveAttribute("data-cast-corrected");
  await expect(words).toHaveCount(3);
  await expect(personality).toHaveText("curious, quick, teasing personality");
});

test("Remove from cast leaves her out of the panel and the requests, and Undo brings her back", async ({
  page,
  request,
}) => {
  await castChat(request);
  await seeded(page);
  const remove = async () => {
    const record = await openRecord(page, SEEDED);
    await record.getByRole("button", { name: "Remove from cast", exact: true }).click();
    await expect(record).toHaveCount(0);
    await expect(castPanel(page)).toContainText(`${SEEDED} removed.`);
    await expect(castEntry(page, SEEDED)).toHaveCount(0);
  };
  await remove();
  const undo = castPanel(page).getByRole("button", { name: `Undo removing ${SEEDED}` });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(castEntry(page, SEEDED)).toBeVisible();
  await expect(castPanel(page)).not.toContainText("removed.");

  await remove();
  const line = `Without her ${crypto.randomUUID()}`;
  await exchange(page, line);
  const block = castBlock(await chatRecord(line));
  expect(block).toContain(KEEPER_MAN);
  expect(block).not.toContain(SEEDED);
  // The keeper call follows the reply's end; nothing on the page waits for it here.
  await expect.poll(async () => (await upstreamRecords(line, "cast")).length).toBe(1);
  const [call] = await upstreamRecords(line, "cast");
  expect(call?.messages.at(-1)?.content).not.toContain(SEEDED);
  await expect(castEntry(page, SEEDED)).toHaveCount(0);
});

test("the character sheet reads the cast now, marks it stale after a description edit and regenerates it", async ({
  page,
  request,
}) => {
  const name = uniqueName("Sheet cast");
  await createCharacterViaApi(request, name, { description: `${name} tends the lamp.` });
  await patchSettings(request, { model: "mock-fast", castModel: "mock-cast" });
  await openSheet(page, name);
  const section = page.locator("#s-cast");
  await expect(section).toContainText(
    "No cast sheet yet. One is read from the card when a chat starts.",
  );
  await section.getByRole("button", { name: "Read the cast now", exact: true }).click();
  await expect(section.getByRole("listitem")).toHaveText([
    `${SHEET_WOMAN} (29)`,
    `${SHEET_MAN} (34)`,
  ]);
  await expect(section.getByRole("button", { name: "Regenerate the cast" })).toBeVisible();
  expect(await upstreamRecords(name, "castSheet")).toHaveLength(1);

  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill(`${name} tends the lamp and mends the nets.`);
  await saved(page);
  await expect(section).toContainText("The card changed since this was read.");
  await section.getByRole("button", { name: "Regenerate the cast", exact: true }).click();
  await expect(section).not.toContainText("The card changed since this was read.");
  await expect(section.getByRole("listitem")).toHaveText([
    `${SHEET_WOMAN} (29)`,
    `${SHEET_MAN} (34)`,
  ]);
  // The section shows the same names while the new read runs: wait for the second call itself.
  await expect.poll(async () => (await upstreamRecords(name, "castSheet")).length).toBe(2);
  const [, regenerated] = await upstreamRecords(name, "castSheet");
  expect(regenerated?.messages.at(-1)?.content).toContain("mends the nets");
});
