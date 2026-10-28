import type { APIRequestContext, Page } from "@playwright/test";
import { clearChat, turns } from "./support/chat.ts";
import { ART_TIMEOUT, type ComfyScope } from "./support/creator.ts";
import { mark } from "./support/creator-fixtures.ts";
import { canary } from "./support/env.ts";
import { matrixRow, type RowLabel, serverHopsHolding } from "./support/retention.ts";
import { FRAGMENT_OFFSETS, imageFragments } from "./support/scan.ts";
import {
  recordScene,
  sceneButton,
  sceneCalls,
  sceneChat,
  sceneItems,
  scenePicture,
} from "./support/scene.ts";
import { expect } from "./support/test.ts";

/*
 * Retention matrix, Picture this scene (docs/ARCHITECTURE.md § Retention
 * matrix): the scene source the tab wrote from the card and the chat's
 * turns, the image prompt and the one picture are chat content. A row chats
 * with a saved character from a non-canary `kept-` base, saying a line that
 * holds `zqcanary7w-<label>-<id>-steer`, which outranks the card's mark, so
 * the image prompt holds `-prompt` and the picture `-img0`
 * (e2e/support/scene.ts). A row proves each existed as far as its path
 * reaches (at the mock upstream's scene call, at the mock ComfyUI, in the
 * scene stream the tab read), then runs the browser cells; ComfyUI must hold
 * nothing of the run afterwards.
 */

/** The time a row may take: a chat, a picture and, for `scene`, fragment scans of every hop. */
const SCENE = { timeout: 90_000 };

/**
 * A chat whose line holds a canary of `label`, and Picture this scene
 * pressed: the scene call reached the upstream with the line, and the image
 * prompt ComfyUI. Returns the canary and the character's name.
 */
async function pictureFromChat(
  page: Page,
  request: APIRequestContext,
  scope: ComfyScope,
  label: RowLabel,
) {
  const base = canary(label);
  const name = await sceneChat(page, request, `By the lamp ${mark(base, "steer")}`);
  await sceneButton(page).click();
  await expect.poll(async () => (await sceneCalls(mark(base, "steer"))).length).toBe(1);
  await expect
    .poll(async () => (await scope.state(mark(base, "prompt"))).containing, {
      timeout: ART_TIMEOUT,
    })
    .toBe(1);
  return { base, name };
}

/** The run is being painted: its prompt is in the mock ComfyUI, sampling. */
async function expectPainting(scope: ComfyScope, base: string) {
  await expect
    .poll(async () => {
      const state = await scope.state(mark(base, "prompt"));
      return state.containing === 1 && state.running;
    })
    .toBe(true);
}

matrixRow(
  "scene",
  async ({ comfy, fragments, page, request }) => {
    // The private worker takes the portrait's top third for the reference graph, as a job input.
    const scope = await comfy({ mode: "private", distinct: true });
    const scene = await recordScene(page);
    const { base, name } = await pictureFromChat(page, request, scope, "scene");
    await expect(scenePicture(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
    await scene.expectPicture(base);
    expect((await scope.state()).uploads).toBe(1);
    await scope.expectClean();
    // The picture's noisy bytes are unique to this run: found at no server hop, and B-disk looks too.
    const picture = await imageFragments(scene.image(), FRAGMENT_OFFSETS.png);
    expect(await serverHopsHolding(picture)).toEqual([]);
    fragments.push(...picture);
  },
  SCENE,
);

matrixRow(
  "sceneerr",
  async ({ comfy, page, request }) => {
    const scope = await comfy({ mode: "private", fail: true });
    await pictureFromChat(page, request, scope, "sceneerr");
    await expect(sceneItems(page)).toHaveAttribute("data-status", "failed", {
      timeout: ART_TIMEOUT,
    });
    await expect(sceneItems(page).getByRole("status")).toHaveText(
      "The picture failed. ComfyUI failed or returned an unusable picture.",
    );
    await expect(sceneItems(page).locator("canvas")).toHaveCount(0);
    await scope.expectClean();
    expect((await scope.state()).released).toBe(1);
  },
  SCENE,
);

matrixRow(
  "scenestop",
  async ({ comfy, page, request }) => {
    const scope = await comfy({ mode: "private", stall: true });
    const { base } = await pictureFromChat(page, request, scope, "scenestop");
    await expectPainting(scope, base);
    await page.getByRole("button", { name: "Stop the picture", exact: true }).click();
    await expect(sceneItems(page)).toHaveAttribute("data-status", "stopped");
    await expect(sceneItems(page).locator("canvas")).toHaveCount(0);
    // Stop aborted the scene request: ComfyUI interrupted the run and holds nothing of it.
    await scope.expectClean();
    expect((await scope.state()).interrupted).toBe(1);
  },
  SCENE,
);

matrixRow(
  "sceneclear",
  async ({ comfy, page, request }) => {
    const scope = await comfy({ mode: "plain", stall: true });
    const { base } = await pictureFromChat(page, request, scope, "sceneclear");
    await expectPainting(scope, base);
    await clearChat(page);
    await expect(turns(page)).toHaveCount(0);
    await expect(sceneItems(page)).toHaveCount(0);
    await scope.expectClean();
    expect((await scope.state()).interrupted).toBe(1);
    // A late event of the aborted stream must not bring the item back.
    await page.waitForTimeout(500);
    await expect(sceneItems(page)).toHaveCount(0);
  },
  SCENE,
);
