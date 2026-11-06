import type { Locator, Page } from "@playwright/test";
import { uniqueName } from "./support/cards.ts";
import { castEntry, openRecord } from "./support/cast.ts";
import {
  DEVELOPED_HAIR,
  DEVELOPMENT_TURN,
  keeperWoman,
  SHEET_WOMAN,
} from "./support/cast-fixtures.ts";
import {
  chooseModel,
  headerAction,
  lastReply,
  messages,
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
import { keptBase, ownerDescription, portraitPng } from "./support/creator-fixtures.ts";
import {
  createCharacterViaApi,
  createEventViaApi,
  createLorebookViaApi,
  loreEntry,
  patchSettings,
  setLorebookViaApi,
  setPortraitViaApi,
} from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { settledSeamLine } from "./support/memory.ts";
import { createReworkCharacter, dock, openRework, submitRework } from "./support/rework.ts";
import { ownerRequest } from "./support/rework-fixtures.ts";
import { expire, notice, signInThroughPortal } from "./support/signin.ts";
import { expect, test, unsafe } from "./support/test.ts";

/** Public turn identities and visibility, including the greeting while fixtures arrive. */
const deletionMessages = (page: Page) =>
  messages(page).evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.querySelector<HTMLElement>("[data-edit-for]")?.dataset.editFor ?? null,
      role: node.getAttribute("data-role"),
      greeting: node.hasAttribute("data-greeting"),
      status: node.getAttribute("data-status"),
      text: node.querySelector("[data-prose]")?.textContent?.slice(0, 90),
      visible:
        node.getBoundingClientRect().bottom >
          (node.closest('[role="log"]')?.getBoundingClientRect().top ?? 0) &&
        node.getBoundingClientRect().top <
          (node.closest('[role="log"]')?.getBoundingClientRect().bottom ?? 0),
    })),
  );

async function deletionMoreBounds(more: Locator) {
  return more.evaluate((button) => {
    const turn = button.closest("[data-message]");
    const plate = turn?.querySelector("[data-speaker]");
    const scroll = button.closest('[role="log"]')?.firstElementChild;
    if (!turn || !plate || !(scroll instanceof HTMLElement)) throw new Error("Missing More owners");
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        height: rect.height,
        width: rect.width,
      };
    };
    const control = box(button);
    const viewport = box(scroll);
    const top = document.elementFromPoint(
      (control.left + control.right) / 2,
      (control.top + control.bottom) / 2,
    );
    return {
      control,
      viewport,
      turn: box(turn),
      plate: {
        ...box(plate),
        position: getComputedStyle(plate).position,
        stickyTop: getComputedStyle(plate).top,
      },
      fullyInside:
        control.top >= viewport.top &&
        control.bottom <= viewport.bottom &&
        control.left >= viewport.left &&
        control.right <= viewport.right,
      hit: button.contains(top),
      above: top && {
        tag: top.tagName,
        label: top.getAttribute("aria-label"),
        class: top.getAttribute("class"),
      },
      scroll: { top: scroll.scrollTop, height: scroll.scrollHeight, client: scroll.clientHeight },
      motion: [turn, plate, button].map((node) => ({
        tag: node.tagName,
        class: node.getAttribute("class"),
        transform: getComputedStyle(node).transform,
        translate: getComputedStyle(node).translate,
        animations: node
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running")
          .map((animation) => ({
            time: animation.currentTime,
            property: animation instanceof CSSTransition ? animation.transitionProperty : null,
          })),
      })),
    };
  });
}

for (const width of [390, 1440]) {
  test(`Latest after a history deletion supersedes its Undo bookmark at ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: width === 390 ? "reduce" : "no-preference" });
    const characterId = await createCharacterViaApi(request, uniqueName("Rejoin after deletion"), {
      firstMessage: Array.from({ length: 24 }, () => "The lamp lights the harbour.").join("\n\n"),
    });
    await setPortraitViaApi(request, characterId, portraitPng("rejoin-after-deletion"));
    await patchSettings(request, { characterId, model: "mock-fast" });
    await page.goto("/");
    await expect(page.locator("[data-message][data-greeting]")).toHaveAttribute(
      "data-status",
      "complete",
    );
    await expect(messages(page)).toHaveCount(1);
    for (const line of ["First exchange.", "Second exchange."]) {
      await send(page, line);
      await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    }
    const target = messages(page).nth(1);
    const view = page.getByRole("log").locator(":scope > div").first();
    await view.hover();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => view.evaluate((node) => node.scrollTop)).toBe(0);
    await target.hover();
    await target.getByRole("button", { name: /^More actions/ }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeVisible();
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await expect
      .poll(() => view.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(1);
    await undo.click();
    await expect(messages(page)).toHaveCount(5);
    await expect
      .poll(() => view.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(1);
    await expect(replyActions(page)).toBeInViewport();
    await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden();
    await expect(page.locator("[data-presence]")).toHaveCount(1);
  });

  test(`a refused Undo retains focus, geometry and its bookmark for a later permitted Undo at ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const characterId = await createCharacterViaApi(request, uniqueName("Refused Undo"), {
      firstMessage: Array.from({ length: 24 }, () => "The lamp lights the harbour.").join("\n\n"),
    });
    await setPortraitViaApi(request, characterId, portraitPng("refused-undo"));
    await patchSettings(request, { characterId, model: "mock-fast" });
    await page.goto("/");
    await expect(page.locator("[data-message][data-greeting]")).toHaveAttribute(
      "data-status",
      "complete",
    );
    await expect(messages(page)).toHaveCount(1);
    await send(
      page,
      Array.from({ length: 24 }, () => "The tide crosses the harbour.").join("\n\n"),
    );
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await send(page, "The lamps return.");
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const view = page.getByRole("log").locator(":scope > div").first();
    const target = messages(page).nth(2);
    await target.hover();
    await target.getByRole("button", { name: /^More actions/ }).click();
    const original = await target.evaluate((node) => {
      const view = node.closest('[role="log"]')?.firstElementChild;
      if (!view) throw new Error("Missing story scroller");
      return {
        offset: node.getBoundingClientRect().top - view.getBoundingClientRect().top,
        line: Number.parseFloat(
          getComputedStyle(node.querySelector(".prose-turn") ?? node).lineHeight,
        ),
      };
    });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(messages(page)).toHaveCount(4);
    let attempts = 0;
    await page.route("**/api/memory/remember", (route) => {
      attempts++;
      return attempts === 1 ? route.abort() : route.fulfill({ json: { error: "memory_failed" } });
    });
    await headerAction(page, "Clear chat");
    const dialog = page.getByRole("alertdialog", { name: "Clear this chat?" });
    await dialog.getByRole("button", { name: "Remember and clear" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Those turns stay read-only until confirmed.",
    );
    await dialog.getByRole("button", { name: "Keep chatting" }).click();
    await expect(dialog).toHaveCount(0);
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    await undo.focus();
    await expect(page.getByRole("log").locator("button[data-edit-for]")).toHaveCount(0);
    const geometry = () =>
      view.evaluate((node) => ({
        top: node.scrollTop,
        height: node.scrollHeight,
        client: node.clientHeight,
      }));
    const before = await geometry();
    await page.keyboard.press("Enter");
    await expect(undo).toBeFocused();
    await expect(messages(page)).toHaveCount(4);
    const afterRefusal = await geometry();
    expect(afterRefusal).toEqual(before);
    const seam = page.locator("[data-memory-seam]");
    await seam.getByRole("button", { name: "Try again" }).click();
    expect(await settledSeamLine(page)).toContain(
      "The memory was not written: the memory model's answer failed.",
    );
    expect(attempts).toBe(2);
    await undo.focus();
    await page.keyboard.press("Enter");
    await expect(messages(page)).toHaveCount(5);
    await expect(target.getByRole("button", { name: /^More actions/ })).toBeFocused();
    const restored = await target.evaluate((node) => {
      const view = node.closest('[role="log"]')?.firstElementChild;
      if (!view) throw new Error("Missing restored story scroller");
      return node.getBoundingClientRect().top - view.getBoundingClientRect().top;
    });
    expect(Math.abs(restored - original.offset)).toBeLessThanOrEqual(original.line);
    process.stdout.write(
      `Refused Undo stages ${JSON.stringify({ width, before, afterRefusal, original, restored, attempts })}\n`,
    );
  });

  for (const input of ["wheel", "keyboard", "touch"] as const) {
    test(`upward ${input} after deletion supersedes the Undo bookmark at ${width}`, async ({
      page,
      request,
      context,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: width === 390 ? "reduce" : "no-preference" });
      const characterId = await createCharacterViaApi(request, uniqueName("New reading position"), {
        firstMessage: Array.from(
          { length: 40 },
          (_, index) => `Harbour passage ${index}. The lamp lights the quay.`,
        ).join("\n\n"),
      });
      await setPortraitViaApi(request, characterId, portraitPng("new-reading-position"));
      await patchSettings(request, { characterId, model: "mock-fast" });
      await page.goto("/");
      const arrival = await deletionMessages(page);
      await expect(page.locator("[data-message][data-greeting]")).toHaveAttribute(
        "data-status",
        "complete",
      );
      await expect(messages(page)).toHaveCount(1);
      for (const line of ["First exchange.", "Second exchange."]) {
        await send(page, line);
        await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
      }
      const view = page.getByRole("log").locator(":scope > div").first();
      const original = await deletionMessages(page);
      const originalIds = original.map((message) => message.id);
      expect(originalIds).toHaveLength(5);
      expect(new Set(originalIds).size).toBe(5);
      expect(originalIds).not.toContain(null);
      await replyActions(page).getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Delete from here", exact: true }).click();
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeFocused();
      const deleted = await deletionMessages(page);
      expect(deleted.map((message) => message.id)).toEqual(originalIds.slice(0, -1));
      const deletedTop = await view.evaluate((node) => node.scrollTop);
      if (input === "wheel") {
        await view.hover();
        await page.mouse.wheel(0, -260);
      } else if (input === "keyboard") {
        await view.evaluate((node) => {
          node.setAttribute("tabindex", "-1");
          (node as HTMLElement).focus({ preventScroll: true });
        });
        await page.keyboard.press("PageUp");
      } else {
        const client = await context.newCDPSession(page);
        await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        const box = await view.boundingBox();
        if (!box) throw new Error("Missing story bounds");
        const x = box.x + 30;
        const y = box.y + 80;
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (const dy of [40, 100, 180])
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + dy }],
          });
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await client.detach();
      }
      await expect
        .poll(() => view.evaluate((node) => node.scrollTop))
        .toBeLessThan(deletedTop - 40);
      await view.evaluate(
        (node) =>
          new Promise<void>((resolve) => {
            let top = node.scrollTop;
            let stable = 0;
            const settle = () => {
              stable = top === node.scrollTop ? stable + 1 : 0;
              top = node.scrollTop;
              if (stable >= 3) resolve();
              else requestAnimationFrame(settle);
            };
            requestAnimationFrame(settle);
          }),
      );
      const afterInput = await deletionMessages(page);
      process.stdout.write(
        `Deletion input identities ${JSON.stringify({ width, input, arrival, original, deleted, afterInput, tombstones: await undo.count() })}\n`,
      );
      expect(afterInput.map((message) => message.id)).toEqual(originalIds.slice(0, -1));
      const anchor = await view.evaluateHandle((node) =>
        [...node.querySelectorAll(".prose-turn p")].find(
          (paragraph) =>
            paragraph.getBoundingClientRect().bottom > node.getBoundingClientRect().top,
        ),
      );
      const before = await anchor.evaluate((node) => node?.getBoundingClientRect().top);
      if (before === undefined) throw new Error("No visible prose anchor");
      const composer = page.getByRole("textbox", { name: "Message", exact: true });
      await composer.evaluate((node) => node.focus({ preventScroll: true }));
      // Undo without auto-scrolling its off-screen control, with focus deliberately elsewhere.
      await undo.evaluate((node: HTMLButtonElement) => node.click());
      const restored = await deletionMessages(page);
      process.stdout.write(
        `Deletion Undo identities ${JSON.stringify({ width, input, restored, tombstones: await undo.count() })}\n`,
      );
      await expect(messages(page)).toHaveCount(5);
      expect((await deletionMessages(page)).map((message) => message.id)).toEqual(originalIds);
      await expect(composer).toBeFocused();
      await expect
        .poll(() =>
          anchor.evaluate(
            (node, offset) => Math.abs((node?.getBoundingClientRect().top ?? Infinity) - offset),
            before,
          ),
        )
        .toBeLessThanOrEqual(24);
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeVisible();
      await expect(page.locator("[data-presence]")).toHaveCount(1);
      await anchor.dispose();
    });
  }

  test(`Latest hides at the physical end without rejoining an escaped view at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await openChat(page, "mock-fast");
    const view = page.getByRole("log").locator(":scope > div").first();
    const ordering = await view.evaluateHandle((node) => {
      const events: Record<string, unknown>[] = [];
      const log = node.closest('[role="log"]');
      const content = node.firstElementChild;
      const composer = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
      const snapshot = () => ({
        top: node.scrollTop,
        end: node.scrollHeight - node.clientHeight,
        client: node.clientHeight,
        content: content?.getBoundingClientRect().height,
        composer: composer?.getBoundingClientRect().height,
        anchor: getComputedStyle(node).overflowAnchor,
        busy: log?.getAttribute("aria-busy"),
        reply: log
          ?.querySelector('[data-role="assistant"]:last-child')
          ?.getAttribute("data-status"),
        focus:
          document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
      });
      const record = (kind: string, detail?: Record<string, unknown>) => {
        events.push({
          kind,
          time: performance.now(),
          ...snapshot(),
          ...detail,
        });
      };
      const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      if (!top?.get || !top.set) throw new Error("Missing scrollTop accessor");
      const own = Object.getOwnPropertyDescriptor(node, "scrollTop");
      Object.defineProperty(node, "scrollTop", {
        configurable: true,
        get: () => top.get?.call(node),
        set: (value: number) => {
          record("write", { value, stack: new Error().stack?.split("\n").slice(1, 10) });
          top.set?.call(node, value);
          record("written");
        },
      });
      // Observe the existing owner's rejoin/stop calls without adding app hooks.
      const ownAnchor = Object.getOwnPropertyDescriptor(node.style, "overflowAnchor");
      Object.defineProperty(node.style, "overflowAnchor", {
        configurable: true,
        get: () => node.style.getPropertyValue("overflow-anchor"),
        set: (value: string) => {
          node.style.setProperty("overflow-anchor", value);
          record("anchor:write", { value, stack: new Error().stack?.split("\n").slice(1, 10) });
        },
      });
      const capture = () => record("scroll:capture");
      const bubble = () => record("scroll:bubble");
      node.addEventListener("scroll", capture, true);
      node.addEventListener("scroll", bubble);
      const types = [
        "focusin",
        "focusout",
        "keydown",
        "beforeinput",
        "input",
        "submit",
        "wheel",
        "pointerdown",
        "touchmove",
      ] as const;
      const input = (event: Event) =>
        record(`input:${event.type}`, {
          target: event.target instanceof Element ? event.target.tagName : null,
          trusted: event.isTrusted,
          key: event instanceof KeyboardEvent ? event.key : undefined,
          deltaY: event instanceof WheelEvent ? event.deltaY : undefined,
          length: composer?.value.length,
        });
      for (const type of types) document.addEventListener(type, input, true);
      const observer = new ResizeObserver((entries) =>
        record("resize", {
          targets: entries.map((entry) => ({
            owner:
              entry.target === node
                ? "scroller"
                : entry.target === content
                  ? "content"
                  : "composer",
            height: entry.contentRect.height,
          })),
        }),
      );
      observer.observe(node);
      if (content) observer.observe(content);
      if (composer) observer.observe(composer);
      const mutations = new MutationObserver(() => record("mutation"));
      if (log)
        mutations.observe(log, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-busy", "data-status"],
        });
      let frame = 0;
      let previous = "";
      const sample = () => {
        const current = JSON.stringify(snapshot());
        if (current !== previous) record("frame");
        previous = current;
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      record("initial");
      return {
        mark: (stage: string) => record(`stage:${stage}`),
        stop: () => {
          cancelAnimationFrame(frame);
          observer.disconnect();
          mutations.disconnect();
          node.removeEventListener("scroll", capture, true);
          node.removeEventListener("scroll", bubble);
          for (const type of types) document.removeEventListener(type, input, true);
          if (own) Object.defineProperty(node, "scrollTop", own);
          else Reflect.deleteProperty(node, "scrollTop");
          if (ownAnchor) Object.defineProperty(node.style, "overflowAnchor", ownAnchor);
          else Reflect.deleteProperty(node.style, "overflowAnchor");
          record("final");
          return {
            events,
            cleanup: {
              scrollTopRestored:
                Object.getOwnPropertyDescriptor(node, "scrollTop")?.set === own?.set,
              anchorRestored:
                Object.getOwnPropertyDescriptor(node.style, "overflowAnchor")?.set ===
                ownAnchor?.set,
              observersDisconnected: true,
              listenersRemoved: true,
            },
          };
        },
      };
    });
    try {
      await ordering.evaluate((trace) => trace.mark("before-send"));
      await send(
        page,
        Array.from({ length: 90 }, (_, index) => `Keep the reading intent, passage ${index}.`).join(
          "\n\n",
        ),
      );
      await ordering.evaluate((trace) => trace.mark("after-send"));
      await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
      await ordering.evaluate((trace) => trace.mark("complete"));
      await expect
        .poll(() => view.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
        .toBeLessThan(1);
      await ordering.evaluate((trace) => trace.mark("initial-tail"));
      // Latest also measures on resize/rAF, before a native scroll event may
      // arrive. Do not reverse this write until the genuine upward event has
      // reached the scroll owner, or both writes can coalesce into an end event.
      const upward = await view.evaluate(
        (node) =>
          new Promise<{ before: number; after: number }>((resolve, reject) => {
            const before = node.scrollTop;
            const onScroll = () => {
              clearTimeout(deadline);
              resolve({ before, after: node.scrollTop });
            };
            const deadline = window.setTimeout(() => {
              node.removeEventListener("scroll", onScroll);
              reject(new Error("One-pixel escape did not dispatch its native scroll event"));
            }, 2000);
            node.addEventListener("scroll", onScroll, { once: true });
            node.scrollTop = before - 1;
          }),
      );
      expect(upward.after).toBe(upward.before - 1);
      const latest = page.getByRole("button", { name: "Latest", exact: true });
      await expect(latest).toBeVisible();
      await ordering.evaluate((trace) => trace.mark("one-pixel-escape"));
      await view.evaluate((node) => {
        node.scrollTop = node.scrollHeight - node.clientHeight;
      });
      await expect(latest).toBeHidden();
      const kept = await view.evaluate((node) => node.scrollTop);
      await page.setViewportSize({ width, height: 480 });
      await expect(latest).toBeVisible();
      expect(await view.evaluate((node) => node.scrollTop)).toBe(kept);
      await ordering.evaluate((trace) => trace.mark("escaped-resize"));
    } finally {
      try {
        const diagnostics = { width, ...(await ordering.evaluate((trace) => trace.stop())) };
        await test.info().attach("latest-tail-ordering", {
          body: JSON.stringify(diagnostics, null, 2),
          contentType: "application/json",
        });
        process.stdout.write(
          `Latest tail cleanup ${JSON.stringify({ width, cleanup: diagnostics.cleanup })}\n`,
        );
      } finally {
        await ordering.dispose();
      }
    }
  });

  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    for (const { intent, settled } of [
      { intent: "hover older", settled: false },
      { intent: "following visible", settled: false },
      { intent: "following visible", settled: true },
      { intent: "history", settled: false },
    ] as const) {
      test(`older deletion and Undo retain reading intent ${intent}${settled ? " settled" : ""} ${width}/${reducedMotion}`, async ({
        page,
        request,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ reducedMotion });
        const characterId = await createCharacterViaApi(request, uniqueName("Older deletion"), {
          firstMessage:
            intent === "following visible"
              ? "The lamp is lit."
              : Array.from({ length: 24 }, () => "The lamp lights the harbour.").join("\n\n"),
        });
        await setPortraitViaApi(request, characterId, portraitPng("older-deletion"));
        await patchSettings(request, { characterId, model: "mock-fast" });
        await page.goto("/");
        await expect(page.locator("[data-message][data-greeting]")).toHaveAttribute(
          "data-status",
          "complete",
        );
        const activeArrival =
          intent === "following visible" &&
          !settled &&
          width === 1440 &&
          reducedMotion === "no-preference";
        const exchanges = activeArrival
          ? ["First exchange."]
          : ["First exchange.", "Second exchange."];
        for (const line of exchanges) {
          await send(page, line);
          await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
        }
        const view = page.getByRole("log").locator(":scope > div").first();
        await expect
          .poll(() =>
            view.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
          )
          .toBeLessThan(1);
        const target = messages(page).nth(intent === "following visible" ? 3 : 1);
        const stages: Record<string, unknown> = {};
        const geometry = () =>
          target.evaluate((node) => {
            const view = node.closest('[role="log"]')?.firstElementChild;
            if (!(view instanceof HTMLElement)) throw new Error("Missing conversation scroller");
            return {
              top: view.scrollTop,
              height: view.scrollHeight,
              client: view.clientHeight,
              offset: node.getBoundingClientRect().top - view.getBoundingClientRect().top,
            };
          });
        if (intent === "history") {
          await view.hover();
          await page.mouse.wheel(0, -100_000);
          await expect.poll(() => view.evaluate((node) => node.scrollTop)).toBe(0);
        }
        if (!activeArrival) stages.beforeHover = await geometry();
        if (intent === "hover older") await target.hover();
        if (!activeArrival) stages.afterHover = await geometry();
        // The following case uses a target already in view, with no hover auto-scroll.
        const more = target.getByRole("button", { name: /^More actions/ });
        if (settled)
          await expect
            .poll(() =>
              target.evaluate((node) =>
                node.getAnimations().some((animation) => animation.playState === "running"),
              ),
            )
            .toBe(false);
        let reachablePoint: { x: number; y: number } | undefined;
        if (intent === "following visible" && !activeArrival) {
          await expect(target).toBeInViewport();
          const control = await deletionMoreBounds(more);
          process.stdout.write(
            `Following More before click ${JSON.stringify({ width, reducedMotion, settled, control })}\n`,
          );
          expect(control.fullyInside).toBe(true);
          expect(control.hit).toBe(true);
          reachablePoint = {
            x: (control.control.left + control.control.right) / 2,
            y: (control.control.top + control.control.bottom) / 2,
          };
        }
        const prepare = ({ index, activeArrival }: { index: number; activeArrival: boolean }) => {
          const scroll = document.querySelector('[role="log"]')?.firstElementChild;
          if (!(scroll instanceof HTMLElement)) throw new Error("Missing More scroller");
          const turnAt = () => document.querySelectorAll("[data-message]")[index];
          const buttonAt = () =>
            turnAt()?.querySelector<HTMLButtonElement>('button[aria-label^="More actions"]');
          const events: Record<string, unknown>[] = [];
          const record = (kind: string, event?: Event, extra?: Record<string, unknown>) => {
            if (events.length >= 100) return;
            const button = buttonAt();
            const turn = turnAt();
            if (!button || !turn) return;
            const target = event?.target instanceof Element ? event.target : null;
            const rect = button.getBoundingClientRect();
            events.push({
              kind,
              top: scroll.scrollTop,
              height: scroll.scrollHeight,
              client: scroll.clientHeight,
              time: performance.now(),
              target: target?.getAttribute("aria-label") ?? target?.tagName ?? null,
              prevented: event?.defaultPrevented,
              active: document.activeElement?.getAttribute("aria-label"),
              focusVisible: button.matches(":focus-visible"),
              control: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
              translate: getComputedStyle(turn).translate,
              animations: turn.getAnimations().map((animation) => ({
                state: animation.playState,
                time: animation.currentTime,
                property: animation instanceof CSSTransition ? animation.transitionProperty : null,
              })),
              menu: document.querySelector('[role="menu"]') !== null,
              ...extra,
            });
          };
          const types = ["pointerdown", "mousedown", "focus", "focusin", "mouseup", "click"];
          const capture = (event: Event) => record(`${event.type}:capture`, event);
          const bubble = (event: Event) => record(`${event.type}:bubble`, event);
          const onScroll = (event: Event) => record("scroll", event);
          for (const type of types) {
            document.addEventListener(type, capture, true);
            document.addEventListener(type, bubble);
          }
          scroll.addEventListener("scroll", onScroll, true);
          // Observe writes without changing their native behavior. Default focus
          // scrolling bypasses these JavaScript methods and the scrollTop setter.
          const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
          if (!top?.get || !top.set) throw new Error("Missing native scrollTop accessor");
          const ownTop = Object.getOwnPropertyDescriptor(scroll, "scrollTop");
          let restoreButton = () => {};
          let attached = false;
          const attach = () => {
            const button = buttonAt();
            if (!button || attached) return;
            attached = true;
            const ownFocus = Object.getOwnPropertyDescriptor(button, "focus");
            const ownReveal = Object.getOwnPropertyDescriptor(button, "scrollIntoView");
            const focus = button.focus;
            const reveal = button.scrollIntoView;
            button.focus = (options) => {
              record("focus:call", undefined, { options });
              focus.call(button, options);
              record("focus:returned");
            };
            button.scrollIntoView = (options) => {
              record("scrollIntoView:call", undefined, { options });
              reveal.call(button, options);
              record("scrollIntoView:returned");
            };
            restoreButton = () => {
              if (ownFocus) Object.defineProperty(button, "focus", ownFocus);
              else Reflect.deleteProperty(button, "focus");
              if (ownReveal) Object.defineProperty(button, "scrollIntoView", ownReveal);
              else Reflect.deleteProperty(button, "scrollIntoView");
            };
            record("prepared");
          };
          Object.defineProperty(scroll, "scrollTop", {
            configurable: true,
            get: () => top.get?.call(scroll),
            set: (value: number) => {
              record("scrollTop:write", undefined, {
                value,
                stack: new Error().stack?.split("\n").slice(1, 6),
              });
              top.set?.call(scroll, value);
              record("scrollTop:written");
            },
          });
          attach();
          const arrival = Promise.withResolvers<{
            x: number;
            y: number;
            hit: boolean;
            fullyInside: boolean;
            geometry: { top: number; height: number; client: number; offset: number };
            animations: { time: CSSNumberish | null; property: string | null }[];
          }>();
          let frame = 0;
          let deadline = 0;
          const sampleArrival = () => {
            const button = buttonAt();
            const turn = turnAt();
            if (!button || !turn) return;
            const animations = turn
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation instanceof CSSTransition &&
                  animation.transitionProperty === "translate",
              );
            const complete =
              document.querySelectorAll(
                '[data-message][data-role="assistant"][data-status="complete"]',
              ).length === 3;
            if (
              animations.length &&
              complete &&
              scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 1
            ) {
              const rect = button.getBoundingClientRect();
              const view = scroll.getBoundingClientRect();
              const x = (rect.left + rect.right) / 2;
              const y = (rect.top + rect.bottom) / 2;
              record("arrival-ready");
              arrival.resolve({
                x,
                y,
                hit: button.contains(document.elementFromPoint(x, y)),
                fullyInside:
                  rect.top >= view.top &&
                  rect.bottom <= view.bottom &&
                  rect.left >= view.left &&
                  rect.right <= view.right,
                geometry: {
                  top: scroll.scrollTop,
                  height: scroll.scrollHeight,
                  client: scroll.clientHeight,
                  offset: turn.getBoundingClientRect().top - view.top,
                },
                animations: animations.map((animation) => ({
                  time: animation.currentTime,
                  property:
                    animation instanceof CSSTransition ? animation.transitionProperty : null,
                })),
              });
            } else frame = requestAnimationFrame(sampleArrival);
          };
          const observer = new MutationObserver(() => {
            attach();
            if (activeArrival && attached && !frame) {
              frame = requestAnimationFrame(sampleArrival);
              deadline = window.setTimeout(
                () =>
                  arrival.reject(
                    new Error("Natural active More window missed before completed reply/tail"),
                  ),
                2000,
              );
            }
            if (document.querySelector('[role="menu"]')) {
              record("menu:mounted");
              observer.disconnect();
            }
          });
          observer.observe(document.body, { subtree: true, childList: true });
          record("before-click");
          return {
            arrival: arrival.promise,
            stop: () => {
              cancelAnimationFrame(frame);
              clearTimeout(deadline);
              observer.disconnect();
              scroll.removeEventListener("scroll", onScroll, true);
              for (const type of types) {
                document.removeEventListener(type, capture, true);
                document.removeEventListener(type, bubble);
              }
              if (ownTop) Object.defineProperty(scroll, "scrollTop", ownTop);
              else Reflect.deleteProperty(scroll, "scrollTop");
              restoreButton();
              record("after-menu");
              return events;
            },
          };
        };
        const trace = await page.evaluateHandle(prepare, {
          index: intent === "following visible" ? 3 : 1,
          activeArrival,
        });
        let pointerAttempted = false;
        try {
          if (activeArrival) {
            await send(page, "Second exchange.");
            const arrival = await trace.evaluate((value) => value.arrival);
            await test.info().attach("following-more-arrival", {
              body: JSON.stringify(arrival, null, 2),
              contentType: "application/json",
            });
            process.stdout.write(`Following More natural arrival ${JSON.stringify(arrival)}\n`);
            expect(arrival.fullyInside).toBe(true);
            expect(arrival.hit).toBe(true);
            stages.beforeHover = arrival.geometry;
            stages.afterHover = arrival.geometry;
            reachablePoint = arrival;
          }
          // A locator click waits for position stability. Deliver real pointer
          // input at the verified hit point while this entrance is interruptible.
          pointerAttempted = true;
          if (reachablePoint && !settled)
            await page.mouse.click(reachablePoint.x, reachablePoint.y);
          else await more.click();
          await expect(page.getByRole("menu")).toBeVisible();
        } finally {
          const events = await trace.evaluate((value) => value.stop());
          await test.info().attach("more-menu-events", {
            body: JSON.stringify({ width, reducedMotion, intent, settled, events }, null, 2),
            contentType: "application/json",
          });
          process.stdout.write(
            `More menu events ${JSON.stringify({ width, reducedMotion, intent, settled, events, control: await deletionMoreBounds(more) })}\n`,
          );
          await trace.dispose();
          if (intent === "following visible" && pointerAttempted) {
            expect(events.find((event) => event.kind === "focus:capture")?.focusVisible).toBe(
              false,
            );
            if (width === 1440 && reducedMotion === "no-preference" && !settled)
              expect(
                events.find((event) => event.kind === "pointerdown:capture")?.animations,
              ).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ state: "running", property: "translate" }),
                ]),
              );
          }
        }
        const beforeDelete = await geometry();
        stages.beforeDelete = beforeDelete;
        if (intent === "following visible") {
          expect(
            Math.abs(beforeDelete.top - (stages.beforeHover as { top: number }).top),
          ).toBeLessThan(1);
        }
        const readingHistory = intent !== "following visible";
        await page.getByRole("menuitem", { name: "Delete from here", exact: true }).click();
        const undo = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undo).toBeVisible();
        stages.deleted = await view.evaluate((node) => ({
          top: node.scrollTop,
          height: node.scrollHeight,
          client: node.clientHeight,
        }));
        await undo.focus();
        await page.keyboard.press("Enter");
        await expect(messages(page)).toHaveCount(5);
        stages.restored = await geometry();
        process.stdout.write(
          `Older deletion stages ${JSON.stringify({ width, reducedMotion, intent, stages })}\n`,
        );
        const restoredMore = target.getByRole("button", { name: /^More actions/ });
        await expect.soft(restoredMore).toBeFocused();
        await expect(page.locator("[data-presence]")).toHaveCount(1);
        if (readingHistory) {
          const line = await target.evaluate((node) =>
            Number.parseFloat(getComputedStyle(node).lineHeight),
          );
          const restored = await geometry();
          const expectedTop = Math.min(
            Math.max(0, restored.top + restored.offset - beforeDelete.offset),
            restored.height - restored.client,
          );
          expect.soft(Math.abs(restored.top - expectedTop)).toBeLessThanOrEqual(line);
        } else {
          await expect.soft
            .poll(() =>
              view.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
            )
            .toBeLessThan(1);
          await expect.soft(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden();
          await expect.soft(replyActions(page)).toBeInViewport();
        }
      });
    }
  }
}

for (const width of [390, 1440]) {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    test(`deletion samples start at its mutation and preserve portrait, Undo and tail ${width}/${reducedMotion}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion });
      const characterId = await createCharacterViaApi(request, uniqueName("Deletion"), {
        firstMessage: Array.from({ length: 30 }, () => "The lamp lights the harbour.").join("\n\n"),
      });
      await setPortraitViaApi(request, characterId, portraitPng("deletion"));
      await patchSettings(request, { characterId, model: "mock-fast" });
      await page.goto("/");
      await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
      await send(page, "The light returns.");
      await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
      const view = page.getByRole("log").locator(":scope > div").first();
      await expect
        .poll(() => view.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
        .toBeLessThan(4);
      const before = await view.evaluate((node) => ({
        top: node.scrollTop,
        height: node.scrollHeight,
      }));
      const sampling = page.evaluate(
        () =>
          new Promise<{
            start: number;
            frames: { top: number; height: number; portraits: number }[];
          }>((resolve) => {
            const view = document.querySelector<HTMLElement>('[role="log"] > div');
            if (!view) throw new Error("Missing scroller");
            const observer = new MutationObserver(() => {
              if (
                ![...view.querySelectorAll('[role="status"]')].some((node) =>
                  node.textContent?.includes("reply was deleted"),
                )
              )
                return;
              observer.disconnect();
              const start = view.scrollTop;
              const frames: { top: number; height: number; portraits: number }[] = [];
              const sample = () => {
                frames.push({
                  top: view.scrollTop,
                  height: view.scrollHeight,
                  portraits: view.querySelectorAll("[data-presence]").length,
                });
                if (frames.length === 20) resolve({ start, frames });
                else requestAnimationFrame(sample);
              };
              sample();
            });
            observer.observe(view, { childList: true, subtree: true });
          }),
      );
      await lastReply(page).hover();
      await lastReply(page)
        .getByRole("button", { name: /^More actions/ })
        .click();
      const beforeDelete = await page
        .locator('[role="log"] > div')
        .first()
        .evaluate((node) => ({
          top: node.scrollTop,
          height: node.scrollHeight,
        }));
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      const samples = await sampling;
      process.stdout.write(
        `Deletion scroll stages ${JSON.stringify({ width, reducedMotion, beforeMenu: before.top, beforeDelete: beforeDelete.top, mutation: samples.start, preClickDelta: beforeDelete.top - before.top, deletionClamp: samples.start - beforeDelete.top })}\n`,
      );
      for (const frame of samples.frames) {
        expect(frame.portraits).toBe(1);
        expect(Math.abs(frame.top - beforeDelete.top)).toBeLessThanOrEqual(
          Math.abs(beforeDelete.height - frame.height) + 2,
        );
      }
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeFocused();
      await expect(undo).toBeInViewport();
      await expect
        .poll(() => view.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
        .toBeLessThan(4);
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden();
      await page.keyboard.press("Enter");
      await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
      await expect(page.locator("[data-presence]")).toHaveCount(1);
      await expect
        .poll(() => view.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
        .toBeLessThan(4);
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden();
    });
  }
}

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

/** Watch the same indicator through the real primitive's arrival or departure. */
async function indicatorFrames(control: Locator, action: Locator, leaving: boolean) {
  const sampling = await control.evaluateHandle((root, outgoing) => {
    const result =
      Promise.withResolvers<
        {
          scale: string;
          opacity: number;
          ending: boolean;
          checked: boolean;
          background: string;
          border: string;
        }[]
      >();
    let indicator = outgoing ? root.querySelector("span") : null;
    let finished = false;
    const frames: {
      scale: string;
      opacity: number;
      ending: boolean;
      checked: boolean;
      background: string;
      border: string;
    }[] = [];
    const observer = new MutationObserver(sample);
    function sample() {
      indicator ??= root.querySelector("span");
      if (indicator === null) return;
      if (!indicator.isConnected) {
        finished = true;
        observer.disconnect();
        result.resolve(frames);
        return;
      }
      const style = getComputedStyle(indicator);
      const face = getComputedStyle(root);
      frames.push({
        scale: style.scale,
        opacity: Number.parseFloat(style.opacity),
        ending: indicator.hasAttribute("data-ending-style"),
        checked: root.hasAttribute("data-checked"),
        background: face.backgroundColor,
        border: face.borderTopColor,
      });
      if (!outgoing && frames.length > 2 && Number.parseFloat(style.opacity) === 1) {
        finished = true;
        observer.disconnect();
        result.resolve(frames);
      }
    }
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    sample();
    const tick = () => {
      sample();
      if (!finished) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    return {
      finished: result.promise,
      cancel: () => {
        finished = true;
        observer.disconnect();
      },
    };
  }, leaving);
  try {
    await action.click();
    return await sampling.evaluate((value) => value.finished);
  } finally {
    await sampling.evaluate((value) => value.cancel());
    await sampling.dispose();
  }
}

test("reduced-motion check and radio indicators keep their size while tints switch instantly", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const character = uniqueName("Motion choice");
  await createCharacterViaApi(request, character);
  const instruction = "The lighthouse bell rings";
  await createEventViaApi(request, instruction);
  await page.goto("/lorebooks");
  await page.getByRole("button", { name: "Events", exact: true }).click();
  const events = page.getByRole("list", { name: "Events" });
  await events.getByRole("button", { name: instruction, exact: true }).click();
  await events.locator("summary").filter({ hasText: "Advanced" }).click();
  const all = events.getByRole("radio", { name: "All characters", exact: true });
  const chosen = events.getByRole("radio", { name: "Chosen characters and tags" });
  const radioExit = await indicatorFrames(all, chosen, true);
  const radioArrival = await indicatorFrames(all, all, false);
  await chosen.click();
  await events.getByRole("button", { name: "Characters", exact: true }).click();
  const choice = page.getByRole("dialog").getByRole("checkbox", { name: character });
  const checkArrival = await indicatorFrames(choice, choice, false);
  const checkExit = await indicatorFrames(choice, choice, true);
  for (const frames of [radioExit, radioArrival, checkArrival, checkExit]) {
    expect(frames.some(({ opacity }) => opacity > 0 && opacity < 1)).toBe(true);
    for (const frame of frames) expect(frame.scale).toBe("1");
    const changed = frames.filter(({ checked }) => checked === frames.at(-1)?.checked);
    expect(new Set(changed.map(({ background }) => background)).size).toBe(1);
    expect(new Set(changed.map(({ border }) => border)).size).toBe(1);
  }
  for (const frames of [radioExit, checkExit]) {
    process.stdout.write(`Indicator exit states ${JSON.stringify(frames)}\n`);
    expect(frames.some(({ ending, opacity }) => ending && opacity > 0 && opacity < 1)).toBe(true);
    expect(new Set(frames.map(({ background }) => background)).size).toBe(2);
    expect(new Set(frames.map(({ border }) => border)).size).toBe(2);
  }
  await expect(all).not.toBeChecked();
  await expect(chosen).toBeChecked();
  await expect(choice).not.toBeChecked();
  await expect(choice.locator("span")).toHaveCount(0);
});

/** Sample real elapsed animation time without pausing or seeking the wash. */
function castWashFrames(field: Locator) {
  return field.evaluate(
    (element) =>
      new Promise<{
        delay: number;
        duration: number;
        frames: { progress: number; wash: string }[];
      }>((resolve) => {
        const animation = element
          .getAnimations()
          .find(
            (candidate) =>
              candidate instanceof CSSAnimation && candidate.animationName === "cast-settle",
          );
        if (animation?.effect === null || animation === undefined) {
          throw new Error("No Cast wash");
        }
        const effect = animation.effect;
        const timing = effect.getTiming();
        const frames: { progress: number; wash: string }[] = [];
        const sample = () => {
          frames.push({
            progress: Number(effect.getComputedTiming().progress),
            wash: getComputedStyle(element).getPropertyValue("--cast-wash").trim(),
          });
          if (frames.at(-1)?.progress === 1) {
            resolve({ delay: timing.delay ?? 0, duration: Number(timing.duration), frames });
          } else requestAnimationFrame(sample);
        };
        sample();
      }),
  );
}

for (const aged of [false, true]) {
  test(`reduced-motion Cast holds a changed field until its snapshot deadline (${aged ? "later record mount" : "open record"})`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    const characterId = await createCharacterViaApi(request, "Motion wash", {
      description: "A lighthouse keeper.",
      firstMessage: "The lamp room is warm.",
    });
    await patchSettings(request, { model: "mock-fast", castModel: "mock-cast", characterId });
    await page.goto("/");
    await expect(castEntry(page, keeperWoman([]))).toBeVisible();
    // A new person has no previous fields to wash. Use the fixture's actual
    // development of an existing person's hair, through narration and keeper.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/cast/update", async (route) => {
      await held;
      await route.continue();
    });
    await send(page, DEVELOPMENT_TURN);
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    const openHair = async () => {
      const record = await openRecord(page, SHEET_WOMAN);
      await record.locator("summary").filter({ hasText: "Looks" }).click();
      return record.locator('[data-cast-field="hair"][data-cast-changed]');
    };
    let hair: Locator;
    if (aged) {
      release();
      await expect(castEntry(page, SHEET_WOMAN)).toHaveAttribute("data-present", "true");
      await page.waitForTimeout(350);
      hair = await openHair();
    } else {
      await page
        .locator("[data-cast]")
        .filter({ visible: true })
        .locator("summary")
        .filter({ hasText: SHEET_WOMAN })
        .click();
      hair = await openHair();
      release();
    }
    await expect(hair).toContainText(DEVELOPED_HAIR);
    const sample = await castWashFrames(hair);
    if (aged) expect(sample.delay).toBeLessThan(-250);
    expect(sample.duration).toBe(1200);
    const holding = sample.frames.filter(({ progress }) => progress < 1);
    expect(holding.some(({ progress }) => progress > 0.25 && progress < 0.9)).toBe(true);
    expect(new Set(holding.map(({ wash }) => wash)).size).toBe(1);
    const cleared = sample.frames.at(-1)?.wash;
    expect(["rgba(0, 0, 0, 0)", "oklab(0 0 0 / 0)"]).toContain(cleared);
    expect(holding[0]?.wash).not.toBe(cleared);
  });
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
  expect(before - after).toBeCloseTo(432, 0);
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
    .toBeCloseTo(432, 0);
  await session.getByRole("button", { name: "Close Session" }).click();
  await expect(session).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Session", exact: true })).toBeFocused();
});

test("reduced-motion Session keeps its width while its closing fade is visible", async ({
  page,
  request,
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
  for (const { width } of frames) expect(width).toBeCloseTo(432, 0);
  await expect(page.getByRole("complementary", { name: "Session" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const characterId = await createCharacterViaApi(request, uniqueName("Session slip"));
  await patchSettings(request, { characterId, model: "mock-fast" });
  await page.goto("/");
  await send(page, "The player records another turn of the lamp. ".repeat(100));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const player = page.locator('[data-message][data-role="user"]').last();
  await player.evaluate((element) => {
    const scroller = document.querySelector('[role="log"] > div');
    if (scroller === null) throw new Error("Missing chat scroller");
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 80;
  });
  const observe = () =>
    player.evaluate((element) => {
      const scroller = document.querySelector('[role="log"] > div');
      const plate = element.querySelector<HTMLElement>('[data-speaker][data-voice="line"]');
      const name = plate?.querySelector("p");
      if (
        scroller === null ||
        plate === null ||
        plate === undefined ||
        name === null ||
        name === undefined
      )
        throw new Error("Missing player nameplate geometry");
      const bounds = plate.getBoundingClientRect();
      const scroll = scroller.getBoundingClientRect();
      const turn = element.getBoundingClientRect();
      const top = Number.parseFloat(getComputedStyle(plate).top);
      return {
        scrollTop: scroller.scrollTop,
        plateTop: bounds.top,
        plateBottom: bounds.bottom,
        scrollerTop: scroll.top,
        turnTop: turn.top,
        turnBottom: turn.bottom,
        stickyTop: top,
        geometricallyStuck:
          turn.top < scroll.top + top && Math.abs(bounds.top - scroll.top - top) < 2,
        fadeHeight: getComputedStyle(name, "::after").height,
        fadeOpacity: getComputedStyle(name, "::after").opacity,
      };
    });
  await expect.poll(async () => (await observe()).geometricallyStuck).toBe(true);
  const before = await observe();
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Session", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const afterEscape = await observe();
  await expect(page.getByRole("dialog", { name: "Session", exact: true })).toHaveCount(0);
  const settled = await observe();
  process.stdout.write(
    `D Session player slip observation ${JSON.stringify({ before, afterEscape, settled })}\n`,
  );
  expect(afterEscape.scrollTop).toBeCloseTo(before.scrollTop, 0);
  expect(settled.scrollTop).toBeCloseTo(before.scrollTop, 0);
  expect(settled.plateTop).toBeCloseTo(before.plateTop, 0);
  expect(settled.geometricallyStuck).toBe(true);
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
  // The name glides as one shared element. With portraits off, the absent asset
  // has no arriving frame; the small caption takes its place in the showcase.
  for (const name of ["creator-heading"]) {
    expect(parts).toContain(`::view-transition-group(${name})`);
    expect(parts).toContain(`::view-transition-old(${name})`);
    expect(parts).toContain(`::view-transition-new(${name})`);
  }
  expect(parts).not.toContain("::view-transition-new(creator-frame)");
  await expect(page.getByText("No portrait", { exact: true })).toBeVisible();
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
  // Both sheets share a description; prove the duplicate editor arrived before returning.
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    "Motion arrival (copy)",
  );
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
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    "Motion arrival",
  );
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
    await expect(page.locator("header").getByText("Saved", { exact: true })).toBeVisible();
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
  // The outgoing event still occupies height during its fade. Let it leave
  // before advancing the clock or hovering, so scroll clamping cannot move Undo.
  await expect(events.locator("[data-event]")).toHaveCount(0);
  await page.clock.runFor(9_000);
  await expect(row).not.toHaveAttribute("inert");
  await row.hover();
  // Moving focus must keep the pointer over Undo, even when the expanded Events
  // section needs scrolling after its cross-link was added.
  await section.evaluate((element) => element.focus({ preventScroll: true }));
  await expect.poll(() => row.evaluate((element) => element.matches(":hover"))).toBe(true);
  await page.clock.runFor(9_000);
  await expect(row).not.toHaveAttribute("inert");
  await page.mouse.move(0, 0);
  await expect.poll(() => row.evaluate((element) => element.matches(":hover"))).toBe(false);
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
  await expect(bar).toContainText("3 changes to apply");
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
  expect(after.outgoing).toContain("3 changes to apply");
  expect(after.outgoing).toContain("1 change won't apply");
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
  await expect(bar).toContainText("3 changes to apply");
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
    expect(frame.text).toContain("3 changes to apply");
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
      new Promise<
        { height: number; opacity: number; rejected: boolean; background: string; shadow: string }[]
      >((resolve) => {
        const insertion = element.querySelector(".tracked-ins");
        if (insertion === null) throw new Error("No proposed entry text");
        const frames: {
          height: number;
          opacity: number;
          rejected: boolean;
          background: string;
          shadow: string;
        }[] = [];
        const sample = () => {
          const style = getComputedStyle(element);
          const frame = {
            height:
              element.getBoundingClientRect().height -
              Number.parseFloat(style.paddingTop) -
              Number.parseFloat(style.paddingBottom),
            opacity: Number.parseFloat(style.opacity),
            rejected: element.closest('[data-decision="rejected"]') !== null,
            background: getComputedStyle(insertion).backgroundColor,
            shadow: getComputedStyle(insertion).boxShadow,
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
  const rejected = frames.filter((frame) => frame.rejected);
  expect(rejected.length).toBeGreaterThan(1);
  expect(new Set(rejected.map(({ background }) => background))).toEqual(
    new Set(["rgba(0, 0, 0, 0)"]),
  );
  expect(new Set(rejected.map(({ shadow }) => shadow))).toEqual(new Set(["none"]));
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
 * The last reply's actions row, as its distance below the top of the turn, each frame
 * from now until it has moved and then held still for a while.
 */
function rowOffsets(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const turn = [...document.querySelectorAll('[data-message][data-role="assistant"]')].at(-1);
        const row = document.querySelector("[data-reply-actions]");
        if (turn === undefined || row === null) return resolve([]);
        const offsets: number[] = [];
        let held = 0;
        const sample = () => {
          const offset = Math.round(
            row.getBoundingClientRect().top - turn.getBoundingClientRect().top,
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
  const frame = lastReply(page).locator("[data-swipe]:not([data-leaving])");
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

for (const reduced of [false, true]) {
  test(`New reply keeps one readable layer without clipping (${reduced ? "reduced" : "normal"} motion)`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await openChat(page, "mock-fast");
    await send(page, canary("in"));
    await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
    await chooseModel(page, "mock-long");
    const sampling = page.evaluate(
      () =>
        new Promise<
          {
            text: string;
            opacity: number;
            x: number;
            clipped: number;
            readable: number;
            outgoingSafe: boolean;
          }[]
        >((resolve) => {
          const frames: {
            text: string;
            opacity: number;
            x: number;
            clipped: number;
            readable: number;
            outgoingSafe: boolean;
          }[] = [];
          const start = performance.now();
          const sample = () => {
            const frame = document.querySelector<HTMLElement>(
              '[data-message][data-role="assistant"]:last-of-type [data-swipe]:not([data-leaving])',
            );
            if (frame) {
              const style = getComputedStyle(frame);
              const layers = [
                ...(frame.parentElement?.querySelectorAll<HTMLElement>("[data-swipe]") ?? []),
              ];
              const leaving = layers.filter((layer) => layer.hasAttribute("data-leaving"));
              frames.push({
                text: frame.textContent ?? "",
                opacity: Number.parseFloat(style.opacity),
                x: new DOMMatrixReadOnly(style.transform).m41,
                clipped: frame.scrollHeight - frame.clientHeight,
                readable: layers.filter(
                  (layer) => Number.parseFloat(getComputedStyle(layer).opacity) > 0.05,
                ).length,
                outgoingSafe: leaving.every(
                  (layer) => layer.inert && layer.getAttribute("aria-hidden") === "true",
                ),
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
    expect(frames.every(({ readable, outgoingSafe }) => readable <= 1 && outgoingSafe)).toBe(true);
    if (reduced) expect(arriving.every(({ x }) => x === 0)).toBe(true);
    else expect(arriving.some(({ x }) => Math.abs(x) > 0.5)).toBe(true);
    expect(
      arriving
        .filter(({ clipped }) => clipped > 1)
        .map(({ clipped, x, opacity }) => ({ clipped, x, opacity })),
    ).toEqual([]);
    await expect(lastReply(page)).toHaveAttribute("data-status", "streaming");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const reduced of [false, true]) {
    test(`at ${viewport.width}px an alternate of another length ${reduced ? "moves the row below it in one step under reduced motion" : "eases the row below it"}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
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
      const frame = lastReply(page).locator("[data-swipe]:not([data-leaving])");
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
