import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { uniqueName } from "./support/cards.ts";
import {
  createCharacterViaApi,
  createLorebookViaApi,
  createPersonaViaApi,
  createPresetViaApi,
  expectNoOverflow,
  FORM_FACTORS,
  loreEntry,
  seriousAxeViolations,
} from "./support/entities.ts";
import { expect, test, unsafe } from "./support/test.ts";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  for (const kind of ["character", "persona", "prompt", "sampler", "lorebook"] as const) {
    test(`the ${kind} header has one readable save state on phones and desktop (${reducedMotion})`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ reducedMotion });
      const name = uniqueName("Mara Voss");
      let path: string;
      let api: string;
      if (kind === "character") {
        const id = await createCharacterViaApi(page.request, name, {
          description: "A long description.\n".repeat(80),
        });
        path = `/characters/${id}`;
        api = `/api/characters/${id}`;
      } else if (kind === "persona") {
        const id = await createPersonaViaApi(
          page.request,
          name,
          "A long description.\n".repeat(80),
        );
        path = `/personas/${id}`;
        api = `/api/personas/${id}`;
      } else if (kind === "lorebook") {
        const id = await createLorebookViaApi(page.request, name, {
          entries: Array.from({ length: 30 }, (_, at) => loreEntry({ comment: `Entry ${at}` })),
        });
        path = `/lorebooks/${id}`;
        api = `/api/lorebooks/${id}`;
      } else {
        const { presets } = await (await page.request.get(`/api/presets/${kind}`)).json();
        const id = await createPresetViaApi(page.request, kind, {
          ...(kind === "prompt"
            ? {
                blocks: presets[0].blocks.map((block: { kind: string; content?: string }) =>
                  block.kind === "text" ? { ...block, content: "Write within the scene." } : block,
                ),
              }
            : { values: presets[0].values }),
          name,
        });
        path = `/presets/${kind}/${id}`;
        api = `/api/presets/${kind}/${id}`;
      }
      await page.goto(path);
      const header = page.locator("main header");
      const title = header.getByRole("heading", { level: 1, name, exact: true });
      const field = page.getByRole("textbox", { name: "Name", exact: true });
      const scroller = page.locator("main [data-skip-target]").first();
      const scroll = (top: number) =>
        scroller.evaluate((node, top) => {
          node.scrollTo({ top, behavior: "instant" });
        }, top);
      const titles = [];
      for (const width of [360, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        // CSS resizes before useFormFactor moves Saved into its responsive subtree.
        const slot = header.locator(width < 768 ? "h1 + p" : "div:has(> h1) + div > span");
        await expect(slot.getByText("Saved", { exact: true })).toBeVisible();
        await scroll(0);
        await expect(field).toHaveValue(name);
        await expect(title).toHaveCSS("opacity", "0");
        await scroll(600);
        await expect(title).toHaveCSS("opacity", "1");
        await expect(title).toHaveText(name);
        titles.push({
          width,
          scrollTop: await scroller.evaluate((node) => node.scrollTop),
          title: await title.textContent(),
          opacity: await title.evaluate((node) => getComputedStyle(node).opacity),
        });
        await scroll(0);
        await expect(title).toHaveCSS("opacity", "0");
        const status = header.getByText("Saved", { exact: true });
        await expect(status).toHaveCount(1);
        await expect(status).toBeVisible();
        // Hidden copies can still announce; count the complete alert subtree too.
        await expect(header.locator('[role="alert"]')).toHaveCount(1);
        const geometry = await header.evaluate((current, phone) => {
          if (!current.isConnected || document.querySelector("main header") !== current)
            throw new Error("No current sheet header");
          const title = current.querySelector("h1");
          if (!title) throw new Error("No sheet title");
          const column = title.parentElement;
          const slot = phone
            ? column?.querySelector(":scope > p")
            : column?.nextElementSibling?.querySelector(":scope > span");
          const node = slot?.querySelector(":scope > span > span > span");
          if (!node?.isConnected || node.textContent !== "Saved")
            throw new Error("No Saved state in the requested responsive subtree");
          const row = current.firstElementChild?.getBoundingClientRect();
          const heading = title.getBoundingClientRect();
          // The hidden title is translated during arrival; measure the slot it occupies.
          const shift = Number.parseFloat(getComputedStyle(title).translate.split(" ")[1] ?? "0");
          const state = (node.parentElement?.parentElement ?? node).getBoundingClientRect();
          return {
            row: row && { top: row.top, bottom: row.bottom, height: row.height },
            title: { top: heading.top - shift, bottom: heading.bottom - shift },
            status: { top: state.top, bottom: state.bottom, left: state.left },
            titleLeft: heading.left,
          };
        }, width < 768);
        expect(geometry.row?.height).toBe(56);
        expect(geometry.title.top).toBeGreaterThanOrEqual(geometry.row?.top ?? Infinity);
        expect(geometry.status.bottom).toBeLessThanOrEqual(geometry.row?.bottom ?? 0);
        if (width < 768) {
          expect(geometry.status.top).toBeGreaterThanOrEqual(geometry.title.bottom);
          expect(geometry.status.left).toBeCloseTo(geometry.titleLeft, 0);
        } else expect(geometry.status.top).toBeLessThan(geometry.title.bottom);
      }
      // At a height that contains this form, its name stays in the field.
      const sampleTallViewport = (nextFrame = false) =>
        scroller.evaluate(async (node, nextFrame) => {
          if (nextFrame) await new Promise(requestAnimationFrame);
          const currentHeader = document.querySelector("main header");
          const rect = (element: Element | null) => {
            const box = element?.getBoundingClientRect();
            return box && { top: box.top, width: box.width, height: box.height };
          };
          return {
            at: performance.now(),
            viewport: { width: innerWidth, height: innerHeight },
            visualViewport: {
              width: visualViewport?.width,
              height: visualViewport?.height,
            },
            current: node.isConnected && document.querySelector("main [data-skip-target]") === node,
            phoneSaved: currentHeader?.querySelector("h1 + p")?.textContent === "Saved",
            header: rect(currentHeader),
            scroller: rect(node),
            form: rect(node.querySelector("form")),
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            scrollTop: node.scrollTop,
            fields: Array.from(node.querySelectorAll("textarea"))
              .slice(0, 12)
              .map((field) => ({
                id: field.id,
                length: field.value.length,
                rect: rect(field),
                clientHeight: field.clientHeight,
                scrollHeight: field.scrollHeight,
                maxHeight: getComputedStyle(field).maxHeight,
                fieldSizing: getComputedStyle(field).getPropertyValue("field-sizing"),
              })),
          };
        }, nextFrame);
      const beforeResize = await sampleTallViewport();
      let afterResize: typeof beforeResize | undefined;
      const resizeSamples: (typeof beforeResize)[] = [];
      try {
        await page.setViewportSize({ width: 390, height: 6000 });
        await scroll(0);
        afterResize = await sampleTallViewport();
        // Viewport acknowledgement can precede the responsive React commit and
        // field-sizing layout. Require the phone tree and two matching frames;
        // overflow is asserted below, never used to decide readiness.
        let previous = "";
        await expect
          .poll(
            async () => {
              const sample = await sampleTallViewport(true);
              resizeSamples.push(sample);
              if (resizeSamples.length > 12) resizeSamples.shift();
              const { at: _at, ...geometry } = sample;
              const key = JSON.stringify(geometry);
              const settled =
                sample.current &&
                sample.phoneSaved &&
                sample.viewport.width === 390 &&
                sample.viewport.height === 6000 &&
                previous === key;
              previous = key;
              return settled;
            },
            { timeout: 5_000, message: "Tall phone layout has settled after resize" },
          )
          .toBe(true);
        const sample = await sampleTallViewport();
        resizeSamples.push(sample);
        if (resizeSamples.length > 12) resizeSamples.shift();
        expect(sample.scrollHeight - sample.clientHeight).toBeLessThanOrEqual(1);
        await expect(field).toBeInViewport();
        await expect(title).toHaveCSS("opacity", "0");
      } finally {
        const resizePath = testInfo.outputPath("editor-tall-viewport.json");
        await writeFile(
          resizePath,
          JSON.stringify(
            { kind, reducedMotion, titles, beforeResize, afterResize, resizeSamples },
            null,
            2,
          ),
        );
        await testInfo.attach("editor-tall-viewport", {
          path: resizePath,
          contentType: "application/json",
        });
      }
      const handoffPath = testInfo.outputPath("editor-title-handoff.json");
      await writeFile(handoffPath, JSON.stringify(titles, null, 2));
      await testInfo.attach("editor-title-handoff", {
        path: handoffPath,
        contentType: "application/json",
      });
      await page.setViewportSize({ width: 360, height: 900 });
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**${api}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        await pending;
        return route.abort();
      });
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(`${name} edited`);
      await expect(header.getByText("Saving", { exact: true })).toHaveCount(1);
      await expect
        .poll(() =>
          header.getByText("Saving", { exact: true }).evaluate((node) => {
            let opacity = 1;
            for (
              let at: Element | null = node;
              at?.tagName !== "HEADER" && at;
              at = at.parentElement
            ) {
              opacity *= Number.parseFloat(getComputedStyle(at).opacity);
            }
            return opacity;
          }),
        )
        .toBe(1);
      release();
      await expect(
        header.getByText("Not saved: can't reach Ephemera. Retrying", { exact: true }),
      ).toHaveCount(2);
      await expect(header.getByRole("heading", { level: 1 })).toHaveCount(0);
      await expect(header.locator('[role="alert"]')).toHaveCount(1);
      await page.unroute(`**${api}`);
      await expect(header.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    });
  }
  test(`a short lorebook retains its name in the field (${reducedMotion})`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ reducedMotion });
    const name = uniqueName("Short book");
    const id = await createLorebookViaApi(request, name);
    await page.goto(`/lorebooks/${id}`);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const field = page.getByRole("textbox", { name: "Name", exact: true });
      await expect(field).toHaveValue(name);
      const scroller = page.locator("main [data-skip-target]").first();
      expect(
        await scroller.evaluate((node) => node.scrollHeight - node.clientHeight),
      ).toBeLessThanOrEqual(1);
      await expect(field).toBeInViewport();
      await expect(page.locator("main header h1")).toHaveText(name);
      await expect(page.locator("main header h1")).toHaveCSS("opacity", "0");
    }
  });
}

test("a successful create with a lost response reconciles later edits before opening the saved sheet", async ({
  page,
}) => {
  const name = uniqueName("Lost response");
  const posts: unknown[] = [];
  await page.route("**/api/personas", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort();
    }
    return route.fallback();
  });
  await page.goto("/personas/new");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await expect(
    page.getByText("Not saved: can't reach Ephemera. Retrying", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Description").fill("Typed after the response was lost.");
  await expect(page).toHaveURL(/\/personas\/[0-9a-f-]{36}$/);
  await expect(page.locator("header").getByText("Saved", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  await page.reload();
  await expect(page.getByLabel("Description")).toHaveValue("Typed after the response was lost.");
});

for (const kind of ["character", "persona", "prompt", "sampler"] as const) {
  test(`a failed ${kind} deletion keeps unsaved edits recoverable`, async ({ page }) => {
    const initialName = uniqueName(`Delete ${kind}`);
    let id: string;
    let collection: string;
    let api: string;
    if (kind === "character") {
      id = await createCharacterViaApi(page.request, initialName);
      collection = "characters";
      api = `/api/characters/${id}`;
    } else if (kind === "persona") {
      id = await createPersonaViaApi(page.request, initialName);
      collection = "personas";
      api = `/api/personas/${id}`;
    } else {
      const { presets } = await (await page.request.get(`/api/presets/${kind}`)).json();
      const {
        id: _id,
        revision: _revision,
        createdAt: _created,
        updatedAt: _updated,
        ...preset
      } = presets[0];
      id = await createPresetViaApi(page.request, kind, { ...preset, name: initialName });
      collection = "presets";
      api = `/api/presets/${kind}/${id}`;
    }
    await page.goto(
      `/${collection}/${kind === "prompt" || kind === "sampler" ? `${kind}/` : ""}${id}`,
    );
    let blocked = true;
    await page.route(`**${api}`, (route) => {
      const method = route.request().method();
      if (method === "DELETE")
        return kind === "sampler"
          ? route.fulfill({
              status: 409,
              contentType: "application/json",
              body: '{"error":"last_preset"}',
            })
          : route.abort();
      return blocked && method === "PATCH" ? route.abort() : route.fallback();
    });
    const editedName = `${initialName} edited`;
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(editedName);
    await expect(
      page.getByText("Not saved: can't reach Ephemera. Retrying", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog", { name: `Delete ${editedName}?` })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByRole("alert").filter({ hasText: "Not deleted" })).toBeVisible();
    blocked = false;
    await page
      .getByRole("link", { name: collection[0]?.toUpperCase() + collection.slice(1), exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/${collection}$`));
    const saved = await (await page.request.get(api)).json();
    expect((saved.card ?? saved.persona ?? saved.preset ?? saved).name).toBe(editedName);
  });
}

test("an edit made during a reorder, while a save is in flight, is saved with the new order", async ({
  page,
}) => {
  const id = await createCharacterViaApi(page.request, uniqueName("Reordered"), {
    firstMessage: "Opening.",
    alternateGreetings: ["One", "Two"],
  });
  // The first save is held in flight until the reorder and the next edit have landed.
  let firstSave: () => void = () => {};
  const firstSaveStarted = new Promise<void>((started) => {
    let held = false;
    void page.route(`**/api/characters/${id}`, async (route) => {
      if (route.request().method() === "PATCH" && !held) {
        held = true;
        const release = new Promise<void>((done) => {
          firstSave = done;
        });
        started();
        await release;
      }
      return route.fallback();
    });
  });
  await page.goto(`/characters/${id}`);
  await page.getByLabel("First message", { exact: true }).fill("Opening, edited.");
  await firstSaveStarted;
  await page.getByRole("button", { name: /^Alternate 2:/ }).click();
  await page.getByRole("button", { name: "Move Alternate 2 earlier" }).click();
  await page.getByLabel("First message", { exact: true }).fill("Opening, edited again.");
  await expect(page.getByLabel("First message", { exact: true })).toHaveValue(
    "Opening, edited again.",
  );
  firstSave();
  // Both edits reach the server, and neither overwrites the other (a reorder once ran as a
  // transition, and the later edit was committed and then lost to the older state).
  const card = async () =>
    (
      (await (await page.request.get(`/api/characters/${id}`)).json()) as {
        card: { firstMessage: string; alternateGreetings: string[] };
      }
    ).card;
  await expect
    .poll(
      async () => {
        const { firstMessage, alternateGreetings } = await card();
        return { firstMessage, alternateGreetings };
      },
      { timeout: 15_000 },
    )
    .toEqual({ firstMessage: "Opening, edited again.", alternateGreetings: ["Two", "One"] });
  await expect(page.locator("header").getByText("Saved", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("a save refused because another tab saved first is resolved by Keep mine or Reload", async ({
  page,
  context,
}) => {
  const id = await createCharacterViaApi(page.request, uniqueName("Two tabs"));
  const other = await context.newPage();
  await page.goto(`/characters/${id}`);
  await other.goto(`/characters/${id}`);
  const description = (tab: typeof page) => tab.getByRole("textbox", { name: "Description" });
  // The visible save state; its screen-reader twin, later in the page, repeats the text.
  const status = (tab: typeof page) =>
    tab.getByText(/^(Saved|Not saved: changed in another tab)$/).first();
  const notice = (tab: typeof page) => tab.locator("[data-conflict]");

  await description(other).fill("The other tab's text.");
  await expect(status(other)).toHaveText("Saved", { timeout: 15_000 });

  // This tab opened the card before that save, so its save is refused and nothing is lost.
  await description(page).fill("This tab's text.");
  await expect(notice(page)).toBeVisible({ timeout: 15_000 });
  await expect(status(page)).toHaveText("Not saved: changed in another tab");
  await expectNoOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await notice(page).getByRole("button", { name: "Keep mine" }).click();
  await expect(status(page)).toHaveText("Saved", { timeout: 15_000 });
  await expect(notice(page)).toHaveCount(0);
  const stored = async () =>
    (
      (await (await page.request.get(`/api/characters/${id}`)).json()) as {
        card: { description: string };
      }
    ).card.description;
  expect(await stored()).toBe("This tab's text.");

  // Now the other tab is behind; Reload shows the saved text and drops its edit.
  await description(other).fill("A later edit in the other tab.");
  await expect(notice(other)).toBeVisible({ timeout: 15_000 });
  await notice(other).getByRole("button", { name: "Reload" }).click();
  await expect(notice(other)).toHaveCount(0);
  await expect(description(other)).toHaveValue("This tab's text.");
  expect(await stored()).toBe("This tab's text.");

  // After Reload the tab saves against the new revision.
  await description(other).fill("Saved after the reload.");
  await expect(status(other)).toHaveText("Saved", { timeout: 15_000 });
  expect(await stored()).toBe("Saved after the reload.");
});

/** Saves the character from outside this tab, so this tab's next save is refused as stale. */
async function saveElsewhere(page: Page, id: string) {
  const { revision } = (await (await page.request.get(`/api/characters/${id}`)).json()) as {
    revision: number;
  };
  const response = await page.request.patch(`/api/characters/${id}`, {
    headers: unsafe(),
    data: { description: "Saved by another tab.", revision },
  });
  expect(response.status()).toBe(200);
}

for (const { name, width, height, scheme } of FORM_FACTORS) {
  test(`the conflict notice fits the ${name} layout on a sheet and the lorebook, and passes axe`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    const id = await createCharacterViaApi(page.request, uniqueName("Stale"));
    await page.goto(`/characters/${id}`);
    // The sheet has loaded the card, and with it the revision it will save against.
    await expect(page.getByRole("textbox", { name: "Creator notes" })).toBeVisible();
    await saveElsewhere(page, id);
    await page.getByRole("textbox", { name: "Creator notes" }).fill("Edited here.");
    const notice = page.locator("[data-conflict]");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    // Keyboard reaches both choices.
    await notice.getByRole("button", { name: "Reload" }).focus();
    await page.keyboard.press("Tab");
    await expect(notice.getByRole("button", { name: "Keep mine" })).toBeFocused();

    await page.goto(`/characters/${id}/lorebook`);
    await page.getByRole("button", { name: "Add the first entry" }).click();
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
    await saveElsewhere(page, id);
    await page.getByRole("textbox", { name: "Title" }).fill("Harbour");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expectNoOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}

test("Reload works on a sheet that just created its character, and keeps the edits if it cannot fetch", async ({
  page,
}) => {
  await page.goto("/characters/new");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(uniqueName("Fresh"));
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const id = page.url().split("/").at(-1) ?? "";
  await expect(page.locator("header").getByText("Saved", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await saveElsewhere(page, id);
  const notes = page.getByRole("textbox", { name: "Creator notes" });
  await notes.fill("Edited here.");
  const notice = page.locator("[data-conflict]");
  await expect(notice).toBeVisible({ timeout: 15_000 });

  // The fetch fails: nothing is dropped, and the choice stays.
  await page.route(`**/api/characters/${id}`, (route) =>
    route.request().method() === "GET" ? route.abort() : route.fallback(),
  );
  await notice.getByRole("button", { name: "Reload" }).click();
  await expect(notice.getByRole("button", { name: "Reload" })).toBeEnabled({ timeout: 15_000 });
  await expect(notice).toBeVisible();
  await expect(notes).toHaveValue("Edited here.");

  await page.unroute(`**/api/characters/${id}`);
  await notice.getByRole("button", { name: "Reload" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Saved by another tab.",
  );
  await expect(notes).toHaveValue("");
  await notes.fill("Saved after the reload.");
  await expect(page.locator("header").getByText("Saved", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});
