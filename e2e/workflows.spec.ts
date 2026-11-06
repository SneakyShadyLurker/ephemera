import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import type { CreatorArtStatus } from "../packages/core/src/index.ts";
import { uniqueName } from "./support/cards.ts";
import { ART_TIMEOUT, COPY, expectBatch, recordArt } from "./support/creator.ts";
import { keptBase, ownerDescription } from "./support/creator-fixtures.ts";
import { choose, expectNoOverflow, readSettings } from "./support/entities.ts";
import { sceneButton, sceneChat, scenePicture } from "./support/scene.ts";
import { settingsTab } from "./support/settings.ts";
import { expect, test } from "./support/test.ts";
import {
  actionsFor,
  apiFile,
  cleanUiFile,
  importButton,
  importPanel,
  importWorkflow,
  mappingRows,
  openImport,
  pickFile,
  SDXL_CHECKPOINT,
  SDXL_OBJECT_INFO,
  SDXL_PROMPT,
  SECOND_SAVER,
  twoSaverUiFile,
  workflowRow,
  yours,
} from "./support/workflow-files.ts";

/*
 * A ComfyUI workflow of the owner's own, imported in Settings > Pictures:
 * what the panel shows of a file, its
 * focus and its guard, then the saved workflow in Describe's picker, in a
 * New art batch and a scene picture, renamed, replaced and deleted. The
 * mock ComfyUI serves the fixture's `/object_info`, so the file's nodes and
 * model files are all there.
 */

/** The default workflow Create with AI goes back to. */
const DEFAULT_WORKFLOW = "Krea 2 Gonzalomo";

const READY = "Every node and model file is there.";

for (const [status, action] of [
  [{ state: "off" }, "Add the address"],
  [{ state: "unavailable", reason: "not_allowed" }, "Edit the address"],
  [{ state: "unavailable", reason: "insecure" }, "Edit the address"],
  [{ state: "unavailable", reason: "unreachable" }, "Edit the address"],
  [{ state: "unavailable", reason: "invalid_response" }, "Edit the address"],
  [{ state: "ready" }, null],
  [{ state: "unavailable", reason: "unauthorized" }, null],
  [{ state: "unavailable", reason: "not_ready" }, null],
  [{ state: "missing", nodes: ["MissingNode"], models: [] }, "Choose another"],
] satisfies [CreatorArtStatus, string | null][]) {
  test(`selected workflow recovery matches ${JSON.stringify(status)}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/creator/art/status?*", (route) => route.fulfill({ json: status }));
    await openSettings(page);
    const selected = page
      .locator("[data-workflow]")
      .filter({ has: page.getByText("Selected", { exact: true }) });
    await expect(selected).toHaveCount(1);
    if (action === "Add the address" || action === "Edit the address") {
      const button = selected.getByRole("button", { name: action, exact: true });
      await button.click();
      const address = page.getByRole("textbox", { name: "Picture server address", exact: true });
      await expect(address).toBeFocused();
      await expect(address).toBeInViewport();
      await expect(
        selected.getByRole("combobox", { name: "Choose another", exact: true }),
      ).toHaveCount(0);
    } else if (action === "Choose another") {
      await expect(
        selected.getByRole("combobox", { name: "Choose another", exact: true }),
      ).toBeVisible();
    } else {
      await expect(selected.getByRole("button", { name: /^(Add|Edit) the address$/ })).toHaveCount(
        0,
      );
      await expect(
        selected.getByRole("combobox", { name: "Choose another", exact: true }),
      ).toHaveCount(0);
      if (status.state === "unavailable")
        await expect(selected).toContainText(
          status.reason === "unauthorized" ? "refused this server's token" : "not ready yet",
        );
    }
  });
}

async function openSettings(page: Page) {
  await page.goto("/settings?section=pictures");
  await expect(importButton(page)).toBeEnabled();
}

/** Create with AI open on a subject, at Describe. */
async function openDescribe(page: Page) {
  await page.goto("/characters");
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await expect(
    page.getByRole("button", { name: "Change from Subject", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: COPY.subject.field })).toBeVisible();
}

const workflowPicker = (page: Page) =>
  page.getByRole("combobox", { name: "Workflow", exact: true });

/** A heading or action must be painted throughout its interior, with no clipping or overlay. */
async function expectWorkflowControlPainted(control: Locator) {
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          [0.1, 0.5, 0.9].every((x) =>
            [0.1, 0.5, 0.9].every((y) =>
              element.contains(
                document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y),
              ),
            ),
          )
        );
      }),
    )
    .toBe(true);
}

/** Native delivery diagnostics only, installed before choosing the file. */
async function traceWorkflowArrival(page: Page, holdResize = false) {
  await page.evaluate((holdResize) => {
    const NativeObserver = window.ResizeObserver;
    const nearest = Element.prototype.scrollIntoView;
    const scrollTo = Element.prototype.scrollTo;
    const events: unknown[] = [];
    const snapshot = () => {
      const title = Array.from(document.querySelectorAll("h3")).find(
        (node) => node.textContent === "Import a workflow",
      );
      const panel = title?.closest("section");
      const slot = panel?.parentElement;
      const view = panel?.closest<HTMLElement>("[data-skip-target]");
      const answer = panel?.querySelector("[data-workflow-answer]");
      return {
        busy: panel?.getAttribute("aria-busy"),
        answerText: answer?.textContent,
        heading: title?.getBoundingClientRect().toJSON(),
        answer: answer?.getBoundingClientRect().toJSON(),
        panel: panel?.getBoundingClientRect().toJSON(),
        slot: slot?.getBoundingClientRect().toJSON(),
        slotStyle: slot?.getAttribute("style"),
        inert: !!panel?.closest("[inert]"),
        view: view?.getBoundingClientRect().toJSON(),
        top: view?.scrollTop,
        height: view?.scrollHeight,
        client: view?.clientHeight,
        focus: document.activeElement?.outerHTML.slice(0, 200),
      };
    };
    const record = (kind: string, detail = {}) => {
      if (events.length < 350)
        events.push({ kind, time: performance.now(), ...detail, ...snapshot() });
    };
    let id = 0;
    let held = holdResize;
    const deliveries = new Map<ResizeObserver, () => void>();
    window.ResizeObserver = class extends NativeObserver {
      id = ++id;
      relevant = false;
      targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          if (this.relevant) record("resize-delivery", { id: this.id });
          if (
            held &&
            this.targets.size === 3 &&
            Array.from(this.targets).some((target) => target.matches("[data-skip-target]"))
          ) {
            record("arrival-resize-held", { id: this.id });
            deliveries.set(this, () => callback(entries, observer));
            return;
          }
          callback(entries, observer);
        });
      }
      override observe(target: Element, options?: ResizeObserverOptions) {
        this.targets.add(target);
        if (
          target.matches("[data-skip-target]") ||
          target.querySelector("[data-workflow-answer]")
        ) {
          this.relevant = true;
          record("observe", { id: this.id, target: target.tagName, stack: new Error().stack });
        }
        super.observe(target, options);
      }
      override disconnect() {
        if (this.relevant) record("disconnect", { id: this.id, stack: new Error().stack });
        deliveries.delete(this);
        super.disconnect();
      }
    };
    Element.prototype.scrollIntoView = function (options) {
      record("mount-nearest", { target: this.textContent, options });
      nearest.call(this, options);
      record("after-nearest");
    };
    Element.prototype.scrollTo = function (
      this: Element,
      ...args: Parameters<Element["scrollTo"]>
    ) {
      if (this.matches("[data-skip-target]")) record("alignment", { args });
      Reflect.apply(scrollTo, this, args);
    } as Element["scrollTo"];
    const input = (event: Event) =>
      record(event.type, {
        target: (event.target as Element)?.outerHTML?.slice(0, 200),
        trusted: event.isTrusted,
      });
    for (const type of ["focusin", "wheel", "touchmove", "keydown"])
      document.addEventListener(type, input, { capture: true });
    let previous = "";
    const mutations = new MutationObserver(() => {
      const current = JSON.stringify(snapshot());
      if (current !== previous) {
        previous = current;
        record("state-or-layout");
      }
    });
    mutations.observe(document.querySelector("[data-skip-target]") ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-busy", "style", "inert"],
    });
    Reflect.set(window, "releaseWorkflowArrivalResize", () => {
      held = false;
      record("arrival-resize-released", { queued: deliveries.size });
      for (const deliver of deliveries.values()) deliver();
      deliveries.clear();
    });
    Reflect.set(window, "stopWorkflowArrivalDiagnostics", () => {
      record("final");
      mutations.disconnect();
      window.ResizeObserver = NativeObserver;
      Element.prototype.scrollIntoView = nearest;
      Element.prototype.scrollTo = scrollTo;
      for (const type of ["focusin", "wheel", "touchmove", "keydown"])
        document.removeEventListener(type, input, { capture: true });
      return events;
    });
  }, holdResize);
  return async () => {
    const events = await page.evaluate(() => {
      const result = (Reflect.get(window, "stopWorkflowArrivalDiagnostics") as () => unknown)();
      Reflect.deleteProperty(window, "stopWorkflowArrivalDiagnostics");
      Reflect.deleteProperty(window, "releaseWorkflowArrivalResize");
      return result;
    });
    process.stdout.write(`P2 arrival ${JSON.stringify(events)}\n`);
    await test.info().attach("workflow-arrival.json", {
      body: JSON.stringify(events),
      contentType: "application/json",
    });
  };
}

for (const width of [390, 820, 1440]) {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    for (const override of width === 390
      ? (["none", "wheel", "key", "focus"] as const)
      : (["none"] as const)) {
      test(`workflow first answer alignment ${width}/${reducedMotion}/${override}`, async ({
        page,
        comfy,
      }) => {
        await page.setViewportSize({ width, height: width === 820 ? 1180 : 844 });
        await page.emulateMedia({ reducedMotion });
        await comfy({ objectInfo: SDXL_OBJECT_INFO });
        let release = () => {};
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/api/workflows/inspect", async (route) => {
          const response = await route.fetch();
          await wait;
          await route.fulfill({ response });
        });
        await openSettings(page);
        const panel = await openImport(page, cleanUiFile());
        const heading = panel.getByRole("heading", { name: "Import a workflow", exact: true });
        await expect(heading).toBeFocused();
        await expect(panel).toHaveAttribute("aria-busy", "true");
        const view = page.locator("[data-skip-target]");
        const trace = await view.evaluate((node) => {
          const original = node.scrollTo;
          const calls: unknown[] = [];
          node.scrollTo = function (
            this: HTMLElement,
            ...args: Parameters<HTMLElement["scrollTo"]>
          ) {
            calls.push(args);
            Reflect.apply(original, this, args);
          } as HTMLElement["scrollTo"];
          Reflect.set(window, "stopWorkflowScrollTrace", () => {
            node.scrollTo = original;
            return calls;
          });
          return true;
        });
        try {
          if (override === "wheel") {
            const observed = page.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  document.addEventListener("wheel", () => resolve(), { once: true });
                }),
            );
            const rect = await view.boundingBox();
            await page.mouse.move((rect?.x ?? 0) + 60, (rect?.y ?? 0) + 100);
            await page.mouse.wheel(0, -150);
            await observed;
          } else if (override === "key") {
            await heading.press("PageUp");
          } else if (override === "focus") {
            await page
              .getByRole("textbox", { name: "Picture server address", exact: true })
              .focus();
          }
          release();
          await expect(panel.getByRole("status")).toHaveText(READY);
          // Observe settlement without waiting on paused activity animations or
          // revealing either target. This is bounded, test-only observation.
          await page.evaluate(async () => {
            let previous = "";
            let changed = performance.now();
            const start = changed;
            while (performance.now() - start < 6000) {
              await new Promise((resolve) => requestAnimationFrame(resolve));
              const view = document.querySelector("[data-skip-target]");
              const state = `${view?.scrollTop}|${view?.scrollHeight}|${document.querySelector("[data-workflow-answer]")?.getBoundingClientRect().top}`;
              if (state !== previous) changed = performance.now();
              previous = state;
              if (performance.now() - changed >= 400) return;
            }
            throw new Error("Workflow geometry did not settle within six seconds");
          });
          if (override === "none") {
            await expectWorkflowControlPainted(heading);
            await expectWorkflowControlPainted(panel.getByText("On your ComfyUI", { exact: true }));
            await expect(heading).toBeFocused();
            if (width !== 820)
              await expect
                .poll(async () => {
                  return heading.evaluate(
                    (node) =>
                      node.getBoundingClientRect().top -
                      (node.closest("[data-skip-target]")?.getBoundingClientRect().top ?? NaN),
                  );
                })
                .toBeCloseTo(24, 0);
          } else if (override === "focus") {
            await expect(
              page.getByRole("textbox", { name: "Picture server address", exact: true }),
            ).toBeFocused();
          }
          const calls = await page.evaluate(() =>
            (Reflect.get(window, "stopWorkflowScrollTrace") as () => unknown[])(),
          );
          const geometry = await panel.evaluate((node) => ({
            heading: node.querySelector("h3")?.getBoundingClientRect().toJSON(),
            answer: node.querySelector("[data-workflow-answer]")?.getBoundingClientRect().toJSON(),
            view: node.closest("[data-skip-target]")?.getBoundingClientRect().toJSON(),
          }));
          process.stdout.write(
            `F answer arrival ${JSON.stringify({ width, reducedMotion, override, calls, ...geometry })}\n`,
          );
          expect(calls.length).toBeLessThanOrEqual(override === "none" ? 1 : 0);
          // Editing details is later work and must not invoke the arrival again.
          await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Arrival workflow");
        } finally {
          release();
          if (trace)
            await page.evaluate(() => {
              (Reflect.get(window, "stopWorkflowScrollTrace") as (() => unknown) | undefined)?.();
              Reflect.deleteProperty(window, "stopWorkflowScrollTrace");
            });
        }
      });
    }
  }
}

test.describe("workflow phone actions in the flow", () => {
  test.use({ hasTouch: true });

  for (const { width, phase } of [
    { width: 390, phase: "normal" },
    { width: 360, phase: "normal" },
    { width: 360, phase: "refused" },
    { width: 360, phase: "busy" },
    { width: 360, phase: "unreachable" },
  ] as const) {
    test(`${width}px ${phase}: arrival heading and end actions remain reachable`, async ({
      comfy,
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await comfy({ objectInfo: SDXL_OBJECT_INFO });
      if (phase === "busy" || phase === "unreachable") {
        await page.route("**/api/workflows/inspect", (route) =>
          phase === "busy"
            ? route.fulfill({ status: 429, json: { error: "busy" } })
            : route.abort(),
        );
      }
      await openSettings(page);
      const panel = await openImport(
        page,
        phase === "refused"
          ? {
              name: "portrait.json",
              mimeType: "application/json",
              buffer: Buffer.from("not a workflow {"),
            }
          : cleanUiFile(),
      );
      const heading = panel.getByRole("heading", { name: "Import a workflow", exact: true });
      await expect(heading).toBeFocused();
      await expectWorkflowControlPainted(heading);
      if (phase === "normal") await expect(panel.getByRole("status")).toHaveText(READY);
      else await expect(panel.getByRole("alert")).toBeVisible();
      await expect(heading).toBeFocused();
      await expectWorkflowControlPainted(heading);

      const chooseFile = panel.getByRole("button", { name: "Choose another file", exact: true });
      const cancel = panel.getByRole("button", { name: "Cancel", exact: true });
      const save = panel.getByRole("button", { name: "Save workflow", exact: true });
      await expect(chooseFile).toHaveCount(phase === "normal" ? 0 : 1);
      await expect(save).toHaveCount(phase === "refused" ? 0 : 1);
      if (phase === "busy" || phase === "unreachable") await expect(save).toBeDisabled();

      for (const height of [844, 480]) {
        // Reduced height approximates keyboard space; it does not emulate a native keyboard.
        await page.setViewportSize({ width, height });
        if (phase === "normal") {
          const name = panel.getByRole("textbox", { name: "Name", exact: true });
          await name.click();
          await expect(name).toBeFocused();
          await expectWorkflowControlPainted(name);
          await page.keyboard.press("Tab");
          await expect(panel.getByRole("combobox", { name: "Family", exact: true })).toBeFocused();
        }
        await page.locator("[data-skip-target]").evaluate((scroller) => {
          scroller.scrollTop = scroller.scrollHeight;
        });
        await expectWorkflowControlPainted(cancel);
        if (phase !== "normal") {
          await expectWorkflowControlPainted(chooseFile);
          await chooseFile.focus();
          await page.keyboard.press("Tab");
          await expect(cancel).toBeFocused();
        }
        if (phase !== "refused") {
          await expectWorkflowControlPainted(save);
          const cancelBox = await cancel.boundingBox();
          const saveBox = await save.boundingBox();
          expect(cancelBox?.y).toBeCloseTo(saveBox?.y ?? Infinity, 0);
          expect((cancelBox?.x ?? Infinity) + (cancelBox?.width ?? Infinity)).toBeLessThan(
            saveBox?.x ?? 0,
          );
          if (phase !== "normal") {
            const chooseBox = await chooseFile.boundingBox();
            expect((chooseBox?.y ?? Infinity) + (chooseBox?.height ?? Infinity)).toBeLessThan(
              cancelBox?.y ?? 0,
            );
          } else {
            await cancel.focus();
            await page.keyboard.press("Tab");
            await expect(save).toBeFocused();
            await expectWorkflowControlPainted(save);
          }
        }
        await expectNoOverflow(page);
        expect(
          await panel.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeLessThanOrEqual(0);
      }
      await cancel.click();
      if (phase === "normal") {
        await page
          .getByRole("alertdialog")
          .getByRole("button", { name: "Discard", exact: true })
          .click();
      }
      await expect(panel).toHaveCount(0);
      await expect(importButton(page)).toBeFocused();
    });
  }
});

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`a replacement file gets its own answer arrival ${reducedMotion}`, async ({
    page,
    comfy,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion });
    await comfy({ objectInfo: SDXL_OBJECT_INFO });
    let release = () => {};
    let reached = () => {};
    const first = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route("**/api/workflows/inspect", async (route) => {
      const response = await route.fetch();
      if (++calls === 1) {
        reached();
        await held;
      }
      await route.fulfill({ response });
    });
    try {
      await openSettings(page);
      const panel = await openImport(page, cleanUiFile());
      await first;
      await pickFile(page, () => importButton(page).click(), {
        ...cleanUiFile(),
        name: "replacement.json",
      });
      await expect(panel).toContainText("replacement.json");
      await expect(panel.getByRole("status")).toHaveText(READY);
      const title = panel.getByRole("heading", { name: "Import a workflow", exact: true });
      const view = page.locator("[data-skip-target]");
      await expect
        .poll(() =>
          title.evaluate(
            (node) =>
              node.getBoundingClientRect().top -
              (node.closest("[data-skip-target]")?.getBoundingClientRect().top ?? NaN),
          ),
        )
        .toBeCloseTo(24, 0);
      const top = await view.evaluate((node) => node.scrollTop);
      release();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      expect(await view.evaluate((node) => node.scrollTop)).toBe(top);
      await expect(panel).toContainText("replacement.json");
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await expect(panel).toHaveCount(0);
      await expect(importButton(page)).toBeFocused();
    } finally {
      release();
    }
  });
  for (const result of ["refused", "failed", "failed-rerender"] as const) {
    test(`workflow ${result} answer arrives once ${reducedMotion}`, async ({ page, comfy }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion });
      await comfy({ objectInfo: SDXL_OBJECT_INFO });
      let inspections = 0;
      if (result !== "refused")
        await page.route("**/api/workflows/inspect", (route) => {
          inspections += 1;
          return route.abort();
        });
      await openSettings(page);
      const stopTrace = await traceWorkflowArrival(page, result === "failed-rerender");
      try {
        const panel = await openImport(
          page,
          result === "refused"
            ? {
                name: "invalid.json",
                mimeType: "application/json",
                buffer: Buffer.from("invalid JSON {"),
              }
            : cleanUiFile(),
        );
        await expect(panel.getByRole("alert")).toBeVisible();
        if (result === "failed-rerender") {
          // Hold only this owner's native resize delivery across a real Retry,
          // without changing rendering, the response, or another observer.
          await expect.poll(() => inspections).toBe(1);
          await panel
            .getByRole("button", { name: "Try again", exact: true })
            .dispatchEvent("click");
          await expect.poll(() => inspections).toBe(2);
          await expect(panel.getByRole("alert")).toBeVisible();
          await page.evaluate(() =>
            (Reflect.get(window, "releaseWorkflowArrivalResize") as () => void)(),
          );
        }
        const title = panel.getByRole("heading", { name: "Import a workflow", exact: true });
        await expect
          .poll(() =>
            title.evaluate(
              (node) =>
                node.getBoundingClientRect().top -
                (node.closest("[data-skip-target]")?.getBoundingClientRect().top ?? NaN),
            ),
          )
          .toBeCloseTo(24, 0);
        await expectWorkflowControlPainted(panel.getByRole("alert"));
        await expect(title).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        await expect(importButton(page)).toBeFocused();
      } finally {
        await stopTrace();
      }
    });
  }
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test.describe(`settled summary ${reducedMotion}`, () => {
    test.use({ hasTouch: true });
    for (const width of [360, 390, 820, 1440]) {
      test(`mapping hierarchy and CSS layout scaling approximation at ${width}`, async ({
        page,
        comfy,
        policyViolations,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ reducedMotion });
        await comfy({ objectInfo: SDXL_OBJECT_INFO });
        await openSettings(page);
        const panel = await openImport(page, cleanUiFile());
        const mapping = panel.locator("details").filter({ hasText: "All found in this file" });
        const summary = mapping.locator("summary");
        await expect(summary).toBeVisible();
        const samples: unknown[] = [];
        const diagnose = (control: Locator) =>
          control.evaluate((node) => {
            const panel = node.closest("section");
            const summary = panel?.querySelector("details.disclosure > summary");
            const save = Array.from(panel?.querySelectorAll("button") ?? []).find(
              (element) => element.textContent?.trim() === "Save workflow",
            );
            if (!(panel instanceof HTMLElement) || !(summary instanceof HTMLElement) || !save)
              throw new Error("Missing diagnostic panel, summary or Save");
            const identify = (element: Element | null) =>
              element && {
                tag: element.tagName,
                role: element.getAttribute("role"),
                label: element.getAttribute("aria-label"),
                text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 160),
              };
            const box = (element: Element) => {
              const css = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return {
                ...identify(element),
                class: element.getAttribute("class"),
                rect: rect.toJSON(),
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                minWidth: css.minWidth,
                width: css.width,
                maxWidth: css.maxWidth,
                display: css.display,
                flex: css.flex,
                gap: css.gap,
                overflowX: css.overflowX,
                overflowY: css.overflowY,
                contain: css.contain,
                clipPath: css.clipPath,
                paddingBox: {
                  x: rect.x + Number.parseFloat(css.borderLeftWidth),
                  y: rect.y + Number.parseFloat(css.borderTopWidth),
                  width:
                    rect.width -
                    Number.parseFloat(css.borderLeftWidth) -
                    Number.parseFloat(css.borderRightWidth),
                  height:
                    rect.height -
                    Number.parseFloat(css.borderTopWidth) -
                    Number.parseFloat(css.borderBottomWidth),
                },
              };
            };
            const capture = () => {
              const currentSummary = panel.querySelector("details.disclosure > summary");
              const ancestors = [];
              for (let element: Element | null = panel; element; element = element.parentElement)
                ancestors.push(box(element));
              const actions = Array.from(
                panel.querySelectorAll("button, summary, input, [role='combobox']"),
                (element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    ...box(element),
                    points: [0.1, 0.5, 0.9].flatMap((x) =>
                      [0.1, 0.5, 0.9].map((y) => {
                        const px = rect.x + rect.width * x;
                        const py = rect.y + rect.height * y;
                        const hit = document.elementFromPoint(px, py);
                        return { x: px, y: py, hit: element.contains(hit), blocker: identify(hit) };
                      }),
                    ),
                  };
                },
              );
              return {
                viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
                document: box(document.documentElement),
                scroller: box(document.scrollingElement ?? document.documentElement),
                panel: box(panel),
                summary: currentSummary && box(currentSummary),
                summaryChildren: Array.from(
                  currentSummary?.querySelectorAll("span, svg") ?? [],
                  box,
                ),
                commitPair: save.parentElement && box(save.parentElement),
                footer: save.parentElement?.parentElement && box(save.parentElement.parentElement),
                actions,
                ancestors,
              };
            };
            return { current: capture() };
          });
        try {
          for (const scale of width < 820 ? [1] : [1, 2]) {
            // CSS layout scaling approximation only; this does not exercise native browser zoom.
            await page.setViewportSize({ width: width / scale, height: 1000 / scale });
            await summary.scrollIntoViewIfNeeded();
            const diagnostic = await diagnose(summary);
            samples.push({
              standardWidth: width,
              scale,
              stage: "summary-before-interaction",
              ...diagnostic,
            });
            await expect(summary).toHaveAccessibleName(
              /^Ephemera fills these four places\s*\.\s*All found in this file$/,
            );
            const geometry = await summary.evaluate((node) => {
              const wrapper = node.firstElementChild;
              const label = wrapper?.firstElementChild;
              const status = wrapper?.lastElementChild;
              const chevron = node.lastElementChild;
              if (!wrapper || !label || !status || !chevron)
                throw new Error("Missing summary content");
              const rect = node.getBoundingClientRect();
              const labelRect = label.getBoundingClientRect();
              const statusRect = status.getBoundingClientRect();
              const labelStyle = getComputedStyle(label);
              const statusStyle = getComputedStyle(status);
              return {
                height: rect.height,
                width: rect.width,
                viewport: innerWidth,
                overflow: node.scrollWidth - node.clientWidth,
                wrapperDisplay: getComputedStyle(wrapper).display,
                align: getComputedStyle(node).alignItems,
                gap: getComputedStyle(node).columnGap,
                label: labelRect.toJSON(),
                status: statusRect.toJSON(),
                chevron: chevron.getBoundingClientRect().toJSON(),
                labelWeight: labelStyle.fontWeight,
                statusWeight: statusStyle.fontWeight,
                labelColor: labelStyle.color,
                statusColor: statusStyle.color,
                labelSize: labelStyle.fontSize,
                statusSize: statusStyle.fontSize,
              };
            });
            samples.push({
              standardWidth: width,
              scale,
              mechanism:
                "CSS layout scaling approximation: viewport dimensions divided by scale, not native browser zoom",
              ...geometry,
            });
            expect.soft(geometry.height).toBeGreaterThanOrEqual(44 - 0.01);
            expect.soft(geometry.overflow).toBeLessThanOrEqual(1);
            expect.soft(geometry.labelWeight).toBe("500");
            expect.soft(geometry.statusWeight).toBe("400");
            expect.soft(geometry.labelColor).not.toBe(geometry.statusColor);
            expect.soft(geometry.labelSize).toBe("14px");
            expect.soft(geometry.statusSize).toBe("14px");
            expect.soft(geometry.gap).toBe("8px");
            if (width / scale < 720) {
              expect.soft(geometry.wrapperDisplay).toBe("grid");
              expect.soft(geometry.align).toBe("flex-start");
              expect.soft(geometry.status.top).toBeGreaterThanOrEqual(geometry.label.bottom);
              expect.soft(geometry.chevron.top - geometry.label.top).toBeCloseTo(2, 0);
              if (width === 390 && scale === 1) expect.soft(geometry.label.height).toBe(20);
            } else if (scale === 1) {
              expect.soft(geometry.wrapperDisplay).toBe("flex");
              expect.soft(geometry.status.top).toBeCloseTo(geometry.label.top, 0);
              expect.soft(geometry.label.height).toBe(20);
            }
            await summary.focus();
            await summary.press("Enter");
            await expect(mapping).toHaveAttribute("open", "");
            await expect(mappingRows(panel)).toHaveCount(4);
            await summary.press("Space");
            await expect(mapping).not.toHaveAttribute("open");
            const save = panel.getByRole("button", { name: "Save workflow", exact: true });
            await save.scrollIntoViewIfNeeded();
            samples.push({
              standardWidth: width,
              scale,
              stage: "save-before-reachability-assertion",
              ...(await diagnose(save)),
            });
            samples.push({
              standardWidth: width,
              scale,
              save: await save.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                return {
                  rect: rect.toJSON(),
                  viewport: { width: innerWidth, height: innerHeight },
                  panel: node.closest("section")?.getBoundingClientRect().toJSON(),
                  hits: [0.1, 0.5, 0.9].map((x) =>
                    [0.1, 0.5, 0.9].map((y) =>
                      node.contains(
                        document.elementFromPoint(
                          rect.x + rect.width * x,
                          rect.y + rect.height * y,
                        ),
                      ),
                    ),
                  ),
                };
              }),
            });
            await expectWorkflowControlPainted(save);
          }
        } finally {
          samples.push({ kind: "CSP-violations-observed", violations: [...policyViolations] });
          const path = testInfo.outputPath("round11-summary-layout.json");
          await writeFile(path, JSON.stringify(samples, null, 2));
          await testInfo.attach("round11-summary-CSS-layout-scaling-approximation", {
            path,
            contentType: "application/json",
          });
          await testInfo.attach("round11-summary-CSS-layout-scaling-approximation-accessibility", {
            body: await summary.ariaSnapshot(),
            contentType: "text/plain",
          });
        }
      });
    }
  });
}

test("a saved workflow file shows where Ephemera's values go, then saves as ready", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  // Opening moves focus to the heading.
  await expect(
    panel.getByRole("heading", { name: "Import a workflow", exact: true }),
  ).toBeFocused();
  await expect(panel.getByRole("status")).toHaveText(READY);
  const mapping = panel.locator("details").filter({ hasText: "All found in this file" });
  await expect(mapping).not.toHaveAttribute("open");
  await expect(mapping.locator("summary")).toContainText("All found in this file");
  await expect(mappingRows(panel)).toHaveCount(0);
  await mapping.locator("summary").click();
  const rows = mappingRows(panel);
  await expect(rows).toHaveCount(4);
  for (const [index, place] of ["Prompt", "Size and count", "Seed", "Image output"].entries()) {
    await expect(rows.nth(index)).toContainText(place);
  }
  await expect(rows.nth(0)).toContainText('In this file: "a lighthouse at dusk"');
  await expect(panel.getByRole("combobox", { name: "Output node", exact: true })).toHaveCount(0);
  await panel.getByText("Import details", { exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Changed", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Left out", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "On your ComfyUI", exact: true })).toBeVisible();

  const name = uniqueName("Lighthouse");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await choose(panel, "Family", "General");
  await expect(mapping).toHaveAttribute("open", "");
  await expect(rows.nth(0)).toBeVisible();
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const row = workflowRow(page, name);
  await expect(row.getByText(name, { exact: true })).toBeFocused();
  await expect(yours(page).getByRole("listitem")).toHaveCount(1);
  await expect(row).toContainText("Ready");
});

test("a workflow with two image outputs asks for one before it saves", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, twoSaverUiFile());
  const output = panel.getByRole("combobox", { name: "Output node", exact: true });
  await expect(output).toBeVisible();
  await expect(panel.getByText("All found in this file", { exact: true })).toHaveCount(0);
  await expect(mappingRows(panel)).toHaveCount(4);
  await expect(panel.getByText("Choose the output node", { exact: true })).toBeVisible();
  const save = panel.getByRole("button", { name: "Save workflow", exact: true });
  await expect(save).toBeDisabled();
  await expect(panel.getByText("Choose one mapping before saving.", { exact: true })).toBeVisible();
  const notChosen = panel.getByText("SaveImage (node 7), not the chosen output.", { exact: true });
  await expect(notChosen).toHaveCount(0);

  await choose(panel, "Output node", SECOND_SAVER);
  await expect(output).toBeVisible();
  await expect(panel.getByText("All found in this file", { exact: true })).toHaveCount(0);
  await panel.getByText("Import details", { exact: true }).click();
  await expect(notChosen).toBeVisible();
  await expect(panel.getByText("Choose one mapping before saving.")).toHaveCount(0);
  await expect(save).toBeEnabled();
});

test("an imported workflow is listed first in the picker and paints New art and a scene", async ({
  comfy,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const scope = await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);

  await openDescribe(page);
  await workflowPicker(page).click();
  const groups = page.getByRole("listbox").getByRole("group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAccessibleName("Yours");
  await expect(groups.nth(1)).toHaveAccessibleName("On this server");
  await expect(groups.nth(0).getByRole("option", { name, exact: true })).toBeVisible();
  await expect(
    groups.nth(1).getByRole("option", { name: DEFAULT_WORKFLOW, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await choose(page, "Workflow", name);

  const base = keptBase();
  const art = await recordArt(page);
  await page.getByRole("textbox", { name: COPY.subject.field }).fill(ownerDescription(base));
  await choose(page, "Model", "mock-fast");
  await page.getByRole("button", { name: COPY.subject.create }).click();
  await art.expectPortraits(base);
  await expectBatch(page);
  const newArt = page.getByRole("button", { name: "New art" });
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  await newArt.click();
  await art.expectPortraits(base, 2);
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  // Both batches were painted with the imported graph, not the server's.
  expect(await scope.state(SDXL_CHECKPOINT)).toMatchObject({ prompts: 2, containing: 2 });
  await scope.expectClean();

  const character = await sceneChat(page, request, "By the lighthouse lamp");
  await sceneButton(page).click();
  await expect(scenePicture(page, character)).toBeVisible({ timeout: ART_TIMEOUT });
  expect(await scope.state(SDXL_CHECKPOINT)).toMatchObject({ prompts: 3, containing: 3 });
  await scope.expectClean();
});

test("a rename refuses an empty name, and Escape leaves the name as it was", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);

  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  await expect(field).toBeFocused();
  await field.fill("  ");
  await field.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Give the workflow a name.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(actionsFor(page, name)).toBeFocused();
  await expect(workflowRow(page, name)).toBeVisible();
  await expect(page.getByText("Give the workflow a name.")).toHaveCount(0);

  const renamed = uniqueName("Harbour light");
  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await field.fill(renamed);
  await field.press("Enter");
  await expect(workflowRow(page, renamed)).toContainText("Ready");
  await expect(actionsFor(page, renamed)).toBeFocused();
  await page.reload();
  await expect(workflowRow(page, renamed)).toBeVisible();
  await expect(workflowRow(page, name)).toHaveCount(0);
});

test("Replace file takes the API export in place of the saved file", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);

  await actionsFor(page, name).click();
  await pickFile(
    page,
    () => page.getByRole("menuitem", { name: "Replace file" }).click(),
    apiFile(),
  );
  const panel = importPanel(page, `Replace the file of ${name}`);
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^sdxl-basic\.api\.json, API format, \d+ nodes$/)).toBeVisible();
  await expect(panel.getByRole("status")).toHaveText(READY);
  await expect(panel.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  await panel.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(workflowRow(page, name).getByText(name, { exact: true })).toBeFocused();
  await expect(workflowRow(page, name)).toContainText("Ready");
  await expect(yours(page).getByRole("listitem")).toHaveCount(1);
});

test("deleting the workflow in use goes back to the default", async ({ comfy, page, request }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  const { comfyuiWorkflow: before } = await readSettings(request);

  await openDescribe(page);
  await choose(page, "Workflow", name);
  await expect.poll(async () => (await readSettings(request)).comfyuiWorkflow).not.toBe(before);
  await openSettings(page);
  const row = workflowRow(page, name);
  await expect(row).toContainText("Selected");

  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
  await expect(dialog).toContainText(
    "Create with AI paints with it now and goes back to the default workflow.",
  );
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(`${name} was deleted; back to ${DEFAULT_WORKFLOW}.`)).toBeVisible();
  await expect(importButton(page)).toBeFocused();

  await openDescribe(page);
  await expect(workflowPicker(page)).toHaveText(DEFAULT_WORKFLOW);
});

test("the import panel takes focus on open and Cancel gives it back", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  // A file that is not JSON is refused in the tab, and closes without a discard prompt.
  const panel = await openImport(page, {
    name: "portrait.json",
    mimeType: "application/json",
    buffer: Buffer.from("not a workflow {"),
  });
  await expect(
    panel.getByRole("heading", { name: "Import a workflow", exact: true }),
  ).toBeFocused();
  await expect(panel.getByRole("alert")).toContainText("Cannot import portrait.json");
  await expect(panel.getByRole("alert")).toContainText("portrait.json is not a JSON file.");
  await expect(panel.getByRole("button", { name: "Choose another file" })).toBeVisible();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await expect(importButton(page)).toBeFocused();
});

test("a file read and not saved asks before it is left", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  await panel.locator("summary").filter({ hasText: "Ephemera fills these four places" }).click();

  const guard = page.getByRole("alertdialog", { name: "Discard this import?" });
  const presets = page.getByRole("link", { name: "Presets" });
  await presets.click();
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Keep importing", exact: true }).click();
  await expect(guard).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\?section=pictures$/);
  await expect(mappingRows(panel)).toHaveCount(4);

  // Escape in the panel asks the same.
  await panel.getByRole("textbox", { name: "Name", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Keep importing", exact: true }).click();
  await expect(panel).toBeVisible();

  await presets.click();
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Presets" })).toBeVisible();
});

test("a discarded import lets a navigation through while it folds away", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  const guard = page.getByRole("alertdialog", { name: "Discard this import?" });
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  // At once, while the panel is still folding away: nothing is left to guard.
  await page.getByRole("link", { name: "Presets" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Presets" })).toBeVisible();
  await expect(page).toHaveURL(/\/presets/);
  await expect(guard).toHaveCount(0);
});

test("an import in progress survives a look at another Settings category", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  const name = uniqueName("Harbour light");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);

  await settingsTab(page, "Chat").click();
  await expect(page).toHaveURL(/\/settings\?section=chat$/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(panel).toHaveCount(0);

  await settingsTab(page, "Pictures").click();
  await expect(panel).toBeVisible();
  await panel.locator("summary").filter({ hasText: "Ephemera fills these four places" }).click();
  await expect(mappingRows(panel)).toHaveCount(4);
  await expect(panel.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
});

test("an IME composition keeps Enter and Escape from the rename and the panel", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  const composing = (key: string) => ({ key, isComposing: true });

  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  await expect(field).toHaveAttribute("maxlength", "64");
  await field.fill(`${name} harbour`);
  await field.dispatchEvent("keydown", composing("Enter"));
  await field.dispatchEvent("keydown", composing("Escape"));
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(`${name} harbour`);
  await field.press("Escape");
  await expect(field).toHaveCount(0);

  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  const panelName = panel.getByRole("textbox", { name: "Name", exact: true });
  await panelName.focus();
  await panelName.dispatchEvent("keydown", composing("Escape"));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog", { name: "Discard this import?" })).toBeVisible();
});

test("a save the list cannot show yet gives focus to Import", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  await page.route("**/api/workflows", (route) =>
    route.request().method() === "GET" ? route.abort() : route.fallback(),
  );
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(uniqueName("Lighthouse"));
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  // The refresh is retried before the list gives up.
  await expect(panel).toHaveCount(0, { timeout: 15_000 });
  await expect(importButton(page)).toBeFocused();
});

test("a save in flight holds Cancel, Escape and a new file until it settles", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workflows", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    return route.fallback();
  });
  const name = uniqueName("Lighthouse");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Saving" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await panel.getByRole("heading", { name: "Import a workflow", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await pickFile(page, () => importButton(page).click(), cleanUiFile(SDXL_PROMPT, "second.json"));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  release();
  await expect(workflowRow(page, name)).toBeVisible();
  // The file held back opens once the save is in.
  await expect(panel.getByText(/^second\.json, saved workflow, \d+ nodes$/)).toBeVisible();
});

test("a create whose answer was lost is retried as a replace of the saved one", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  const sent: string[] = [];
  let lose = true;
  let failList = false;
  await page.route("**/api/workflows/**", (route) => {
    sent.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fallback();
  });
  await page.route("**/api/workflows", async (route) => {
    const method = route.request().method();
    sent.push(`${method} /api/workflows`);
    if (method === "GET" && failList) {
      failList = false;
      return route.abort();
    }
    if (method !== "POST" || !lose) return route.fallback();
    lose = false;
    // The server saves it; the answer never reaches the tab.
    await route.fetch();
    return route.abort();
  });
  const name = uniqueName("Lighthouse");
  const field = panel.getByRole("textbox", { name: "Name", exact: true });
  await field.fill(name);
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();

  // Renamed since; the list does not answer the lookup, so nothing is sent again.
  const renamed = uniqueName("Harbour light");
  await field.fill(renamed);
  failList = true;
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  expect(sent.filter((line) => line === "POST /api/workflows")).toHaveLength(1);

  await panel.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(workflowRow(page, renamed)).toContainText("Ready");
  expect(sent.filter((line) => line === "POST /api/workflows")).toHaveLength(1);
  expect(sent.filter((line) => line.startsWith("PUT ") && line.endsWith("/graph"))).toHaveLength(1);
});

test("Replace file answers a change made since it opened with a conflict", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  // Another graph than the saved one, so the replace is a write of its own.
  const file = apiFile();
  const graph: Record<string, { inputs: Record<string, unknown> }> = JSON.parse(
    file.buffer.toString("utf8"),
  );
  Object.assign(graph["5"]?.inputs ?? {}, { steps: 30 });

  await actionsFor(page, name).click();
  await pickFile(page, () => page.getByRole("menuitem", { name: "Replace file" }).click(), {
    ...file,
    buffer: Buffer.from(JSON.stringify(graph)),
  });
  const panel = importPanel(page, `Replace the file of ${name}`);
  await expect(panel.getByRole("status")).toHaveText(READY);

  // Renamed in the row while the replacement is open.
  const renamed = uniqueName("Harbour light");
  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  await field.fill(renamed);
  await field.press("Enter");
  await expect(workflowRow(page, renamed)).toBeVisible();

  await panel.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(panel.getByText("Changed in another tab")).toBeVisible();
});

test("a Reload that answers after another file was taken leaves that file open", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  const file = apiFile();
  const graph: Record<string, { inputs: Record<string, unknown> }> = JSON.parse(
    file.buffer.toString("utf8"),
  );
  Object.assign(graph["5"]?.inputs ?? {}, { steps: 30 });
  await actionsFor(page, name).click();
  await pickFile(page, () => page.getByRole("menuitem", { name: "Replace file" }).click(), {
    ...file,
    buffer: Buffer.from(JSON.stringify(graph)),
  });
  const panel = importPanel(page, `Replace the file of ${name}`);
  await expect(panel.getByRole("status")).toHaveText(READY);
  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  const renamed = uniqueName("Harbour light");
  await field.fill(renamed);
  await field.press("Enter");
  await expect(workflowRow(page, renamed)).toBeVisible();
  await panel.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(panel.getByText("Changed in another tab")).toBeVisible();

  // Reload's list answers only once another file has taken this one's place.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workflows", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    return route.fallback();
  });
  await panel.getByRole("button", { name: "Reload", exact: true }).click();
  await pickFile(page, () => importButton(page).click(), cleanUiFile(SDXL_PROMPT, "second.json"));
  await page
    .getByRole("alertdialog", { name: "Replace this import with the new file?" })
    .getByRole("button", { name: "Replace", exact: true })
    .click();
  const next = importPanel(page);
  await expect(next.getByText(/^second\.json, saved workflow, \d+ nodes$/)).toBeVisible();

  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workflows" &&
      response.request().method() === "GET",
  );
  release();
  await answered;
  // Long enough for a late Reload to close the panel, had it not been dropped.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  await expect(next).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
