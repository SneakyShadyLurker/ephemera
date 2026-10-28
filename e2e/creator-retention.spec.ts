import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expectUpstreamAborted, upstreamRecords } from "./support/chat.ts";
import {
  ART_TIMEOUT,
  type ComfyScope,
  comfyScope,
  createCard,
  expectBatch,
  portraits,
  recordArt,
  showcaseAction,
} from "./support/creator.ts";
import { cardName, mark, ownerDescription } from "./support/creator-fixtures.ts";
import { patchSettings } from "./support/entities.ts";
import { CANARY_MARKER, CREATOR_RESTART, canary } from "./support/env.ts";
import { startServer, stopServer } from "./support/own-server.ts";
import {
  expectBackForwardRestoresNothing,
  expectClipboardUnchanged,
  expectProfileClean,
  expectStorageEmpty,
  expectUrlsClean,
  MATRIX_ROWS,
  matrixRow,
  openProfile,
  type RowLabel,
  recordClass,
  writeClipboardSentinel,
} from "./support/retention.ts";
import { dataDirContaining, filesContaining, holds } from "./support/scan.ts";
import { expect, test } from "./support/test.ts";

/*
 * Retention matrix, creation drafts (docs/ARCHITECTURE.md § Retention
 * matrix): the owner's description, the card before Keep, the image prompt
 * and the candidate portraits, along each path a creation can take. Every
 * mark of a row derives from one canary of its label
 * (e2e/support/creator-fixtures.ts), so the server cells in
 * e2e/server-writes.check.ts find any of them, the portraits' base64 forms
 * included. A row proves each draft existed (in the tab, at the mock upstream
 * or at the mock ComfyUI), then runs the browser cells; ComfyUI must hold
 * nothing of the run afterwards.
 */

/** A page of the app shows nothing a creation held: no text in any field, no card. */
async function expectCreatorEmpty(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  const values = await page
    .locator("textarea, input")
    .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value));
  expect(values.filter((value) => value.includes(CANARY_MARKER))).toEqual([]);
  if (new URL(page.url()).pathname === "/characters/create") {
    // A new document starts the creator at the choice of kind.
    await expect(page.locator('[data-kind="subject"]')).toBeVisible();
  }
}

/** Where every row starts, what B-bf finds once back, and the time a row may take. */
const CREATOR = { start: "/characters", expectEmpty: expectCreatorEmpty, timeout: 60_000 };

/**
 * Writes a Subject card from a canary of `label` and waits for its four
 * portraits: the description reached the upstream, the card the tab, the
 * image prompt ComfyUI and the portraits the tab, each proven.
 */
async function showcase(
  page: Page,
  scope: ComfyScope,
  label: RowLabel,
): Promise<{ base: string; art: Awaited<ReturnType<typeof recordArt>> }> {
  const base = canary(label);
  const art = await recordArt(page);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expect(page.locator("main")).toContainText(mark(base, "card"));
  expect(await upstreamRecords(mark(base, "desc"))).toHaveLength(1);
  await art.expectPortraits(base);
  await expectBatch(page);
  expect((await scope.state(mark(base, "prompt"))).containing).toBe(1);
  return { base, art };
}

matrixRow(
  "crok",
  async ({ comfy, page }) => {
    const scope = await comfy({ mode: "plain" });
    const { base, art } = await showcase(page, scope, "crok");
    // A direction for new art reaches the model, and a second batch follows from it.
    const direction = page.getByRole("textbox", { name: "Direction for the next art" });
    await direction.fill(`At dusk ${mark(base, "steer")}`);
    await direction.press("Enter");
    await art.expectPortraits(base, 2);
    expect(await upstreamRecords(mark(base, "steer"))).toHaveLength(1);
    await portraits(page).getByRole("radio").nth(3).click();
    await expect(portraits(page).getByRole("radio").nth(3)).toHaveAttribute("aria-checked", "true");
    await scope.expectClean();
  },
  CREATOR,
);

matrixRow(
  "crdiscard",
  async ({ comfy, page }) => {
    const scope = await comfy({ mode: "private" });
    const { base } = await showcase(page, scope, "crdiscard");
    await showcaseAction(page, "Discard");
    // Back at the description, which is kept; the card and its portraits are gone.
    await expect(page.getByRole("textbox", { name: "Who do you want to meet?" })).toHaveValue(
      ownerDescription(base),
    );
    await expect(portraits(page)).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(mark(base, "card"));
    await scope.expectClean();
  },
  CREATOR,
);

matrixRow(
  "crrewrite",
  async ({ comfy, page }) => {
    const scope = await comfy({ mode: "plain" });
    const { base, art } = await showcase(page, scope, "crrewrite");
    await showcaseAction(page, "Rewrite");
    // The model writes the card again from the same description, and new portraits follow.
    await art.expectPortraits(base, 2);
    await expectBatch(page);
    expect(await upstreamRecords(mark(base, "desc"))).toHaveLength(2);
    await scope.expectClean();
    expect((await scope.state(mark(base, "prompt"))).containing).toBe(2);
  },
  CREATOR,
);

matrixRow(
  "crretry",
  async ({ page }) => {
    // The first draft has no opening, so the server sends it back and the model writes the card again.
    const base = canary("crretry");
    await createCard(page, {
      kind: "subject",
      description: ownerDescription(base, "retry"),
      model: "mock-fast",
    });
    await expect(
      page.getByText("The first draft was missing parts, so the card is being written again."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: cardName("subject", base) })).toBeVisible();
    await expect(page.locator("main")).toContainText(mark(base, "card"));
    // The draft existed: it went back to the model as the retry's assistant turn.
    const calls = await upstreamRecords(mark(base, "desc"));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.find((message) => message.role === "assistant")?.content).toContain(
      mark(base, "draft"),
    );
    expect(await page.content()).not.toContain(mark(base, "draft"));
  },
  CREATOR,
);

matrixRow(
  "crstop",
  async ({ page }) => {
    const base = canary("crstop");
    await createCard(page, {
      kind: "subject",
      description: ownerDescription(base),
      model: "mock-slow",
    });
    await expect(page.locator("main")).toContainText(mark(base, "card"));
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(
      page.getByText("Stopped. What was written is kept, but the card is incomplete."),
    ).toBeVisible();
    await expectUpstreamAborted(mark(base, "desc"));
  },
  CREATOR,
);

matrixRow(
  "crerr",
  async ({ page }) => {
    // The mock's error body echoes the description; the app must not pass it on anywhere.
    const base = canary("crerr");
    await createCard(page, {
      kind: "subject",
      description: ownerDescription(base),
      model: "mock-error",
    });
    await expect(
      page.getByText("The model stopped before the card was complete. Rewrite to try again."),
    ).toBeVisible();
    expect(await upstreamRecords(mark(base, "desc"))).toHaveLength(1);
    expect(await page.content()).not.toContain(mark(base, "desc"));
  },
  CREATOR,
);

matrixRow(
  "crcomfy",
  async ({ comfy, page }) => {
    const scope = await comfy({ mode: "private", fail: true });
    const base = canary("crcomfy");
    await createCard(page, {
      kind: "subject",
      description: ownerDescription(base),
      model: "mock-fast",
    });
    await expect(page.locator("main")).toContainText(mark(base, "card"));
    await expect(
      page.getByText("Portraits unavailable. Try the art again or keep the card without it."),
    ).toBeVisible({ timeout: ART_TIMEOUT });
    expect((await scope.state(mark(base, "prompt"))).containing).toBe(1);
    await scope.expectClean();
    expect((await scope.state()).released).toBe(1);
  },
  CREATOR,
);

matrixRow(
  "crnav",
  async ({ comfy, page }) => {
    const scope = await comfy({ mode: "plain", stall: true });
    const base = canary("crnav");
    await createCard(page, {
      kind: "subject",
      description: ownerDescription(base),
      model: "mock-fast",
    });
    await expect(page.locator("main")).toContainText(mark(base, "card"));
    // The portraits are being painted when the owner leaves.
    await expect
      .poll(async () => {
        const state = await scope.state(mark(base, "prompt"));
        return state.containing === 1 && state.running;
      })
      .toBe(true);
    await page.getByRole("main").getByRole("link", { name: "Characters", exact: true }).click();
    const leave = page.getByRole("alertdialog", { name: "Leave and lose it?" });
    await leave.getByRole("button", { name: "Leave" }).click();
    await expect(page).toHaveURL(/\/characters$/);
    // Leaving aborted the art request: ComfyUI interrupted the run and holds nothing of it.
    await scope.expectClean();
    expect((await scope.state()).interrupted).toBe(1);
  },
  CREATOR,
);

matrixRow(
  "crreload",
  async ({ comfy, page }) => {
    const scope = await comfy({ mode: "plain" });
    const { base } = await showcase(page, scope, "crreload");
    await scope.expectClean();
    // The leave guard asks through beforeunload; the profile accepts.
    await page.reload();
    await expect(page.locator('[data-kind="subject"]')).toBeVisible();
    expect(await page.content()).not.toContain(mark(base, "card"));
    await expect(portraits(page)).toHaveCount(0);
  },
  { ...CREATOR, skip: { bf: true } },
);

test(`retention matrix: ${MATRIX_ROWS.crrst.row}`, async ({ browserName, playwright, user }) => {
  // A slow card, two stalled batches, three restarts and a profile scan; generous for a loaded machine.
  test.setTimeout(240_000);
  const server = CREATOR_RESTART;
  await rm(server.dir, { recursive: true, force: true });
  await mkdir(server.tmp, { recursive: true });
  await mkdir(server.home, { recursive: true });
  const log = createWriteStream(server.log, { flags: "a" });
  let child = await startServer(server, log);
  const scope = await comfyScope({ mode: "plain", stall: true });
  const profile = await openProfile(playwright[browserName], server.origin, user);
  const { context, page } = profile;
  try {
    await patchSettings(context.request, { comfyuiBaseUrl: scope.address }, server.origin);
    await page.goto("/characters");
    const sentinel = await writeClipboardSentinel(page);

    await test.step("crrst: SIGKILL while the card is written, then a restart", async () => {
      const base = canary("crrst");
      await createCard(page, {
        kind: "subject",
        description: ownerDescription(base),
        model: "mock-slow",
      });
      await expect(page.locator("main")).toContainText(mark(base, "card"));
      expect(await upstreamRecords(mark(base, "desc"))).toHaveLength(1);
      await stopServer(child, "SIGKILL");
      await expect(
        page.getByText("The model stopped before the card was complete. Rewrite to try again."),
      ).toBeVisible({ timeout: 15_000 });
      child = await startServer(server, log);
    });

    /** A new card from the gallery, stopped by `signal` while its portraits are painted. */
    const stopWhilePainting = async (signal: "SIGTERM" | "SIGKILL") => {
      const base = canary("crrst");
      // The leave guard asks through beforeunload and the profile accepts.
      await createCard(page, {
        kind: "subject",
        description: ownerDescription(base),
        model: "mock-fast",
      });
      await expect(page.getByRole("heading", { name: cardName("subject", base) })).toBeVisible();
      await expect
        .poll(async () => {
          const state = await scope.state(mark(base, "prompt"));
          return state.containing === 1 && state.running;
        })
        .toBe(true);
      await stopServer(child, signal);
      await expect(
        page.getByText("Portraits unavailable. Try the art again or keep the card without it."),
      ).toBeVisible({ timeout: 15_000 });
    };

    await test.step("crrst: SIGTERM while the portraits are painted, then a restart", async () => {
      await stopWhilePainting("SIGTERM");
      // An orderly stop ends the run and waits for its cleanup: ComfyUI holds nothing of it.
      await scope.expectClean();
      expect((await scope.state()).interrupted).toBe(1);
      child = await startServer(server, log);
    });

    await test.step("crrst: SIGKILL while the portraits are painted, then a restart", async () => {
      await stopWhilePainting("SIGKILL");
      // PRINCIPLES.md 1, ComfyUI: a plain instance keeps the prompt of a run whose client
      // was killed until it restarts. The stated residual risk, shown rather than hidden.
      expect(await scope.state()).toMatchObject({ clean: false, running: true });
      child = await startServer(server, log);
    });

    await test.step("B-store", () => expectStorageEmpty(page));
    await test.step("B-url", () => expectUrlsClean(page));
    await test.step("B-bf", () => expectBackForwardRestoresNothing(page, expectCreatorEmpty));
    await test.step("B-clip", () => expectClipboardUnchanged(page, sentinel));
    await context.close();
    expect(profile.policyViolations, "Content Security Policy violations").toEqual([]);
    await test.step("B-disk", () => expectProfileClean(profile.dir));
    await stopServer(child, "SIGTERM");
    await new Promise<void>((resolve) => log.end(resolve));

    await test.step("S-data", async () => {
      const scan = await dataDirContaining(server.data, CANARY_MARKER);
      expect(scan.decrypted).toBeGreaterThan(0);
      expect(scan).toMatchObject({ hits: [], unreadable: [] });
    });
    await test.step("S-tmp", async () => {
      expect(await filesContaining(server.tmp, CANARY_MARKER)).toMatchObject({
        hits: [],
        unreadable: [],
      });
    });
    await test.step("S-log", async () => {
      const output = await readFile(server.log);
      // Four starts, all captured.
      expect(output.toString("utf8").split('"event":"listening"')).toHaveLength(5);
      expect(holds(output, CANARY_MARKER)).toBe(false);
    });
    await test.step("S-home", async () => {
      expect(await filesContaining(server.home, CANARY_MARKER)).toMatchObject({
        hits: [],
        unreadable: [],
      });
    });
    await recordClass("crrst");
  } finally {
    await context.close();
    await stopServer(child, "SIGTERM");
    log.end();
    await rm(profile.dir, { recursive: true, force: true });
    await scope.remove();
  }
});
