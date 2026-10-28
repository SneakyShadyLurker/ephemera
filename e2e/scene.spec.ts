import type { Locator, Page } from "@playwright/test";
import { SCENE_METAPROMPTS } from "../packages/core/src/creator/prompts.ts";
import { clearChat, lastReply, send } from "./support/chat.ts";
import { ART_TIMEOUT } from "./support/creator.ts";
import { keptBase, mark } from "./support/creator-fixtures.ts";
import {
  chatPortrait,
  recordScene,
  replyCalls,
  sceneButton,
  sceneCalls,
  sceneChat,
  sceneItems,
  scenePicture,
} from "./support/scene.ts";
import { expect, test } from "./support/test.ts";

/*
 * Picture this scene (docs/PRODUCT.md, Chat) against the mock upstream and
 * the mock ComfyUI (e2e/support/mock-comfyui.ts). The chat's marks are not
 * canaries here; e2e/scene-retention.spec.ts holds the retention rows.
 */

/** The chat's next generation request, as the tab sent it. */
const chatRequest = (page: Page) =>
  page.waitForRequest(
    (sent) => new URL(sent.url()).pathname === "/api/chat" && sent.method() === "POST",
  );

/** The button's top sits at or below the portrait's foot, inside the same column. */
async function expectUnder(button: Locator, portrait: Locator) {
  await expect
    .poll(async () => {
      const [art, under] = await Promise.all([portrait.boundingBox(), button.boundingBox()]);
      return {
        portrait: art,
        button: under,
        below: art !== null && under !== null && under.y >= art.y + art.height,
        aligned: art !== null && under !== null && Math.abs(under.x - art.x) <= 1,
      };
    })
    .toMatchObject({ below: true, aligned: true });
}

test("Picture this scene paints one picture of the moment, which no reply carries and Clear takes", async ({
  comfy,
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const scope = await comfy({ mode: "plain" });
  const base = keptBase();
  const line = `At the window ${mark(base, "steer")}`;
  const first = chatRequest(page);
  const name = await sceneChat(page, request, line);
  const before = (await first).postDataJSON() as { messages: unknown[] };

  // Under the portrait that floats at the head of the latest reply.
  const button = lastReply(page).locator("[data-presence]").getByRole("button", {
    name: "Picture this scene",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await expectUnder(button, chatPortrait(page, name));

  const scene = await recordScene(page);
  await button.click();
  await expect(scenePicture(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  await expect(sceneItems(page)).toHaveCount(1);
  await expect(sceneItems(page)).toHaveAttribute("data-status", "complete");
  await expect(sceneItems(page).locator("canvas")).toHaveCount(1);
  await scene.expectPicture(base);

  // One scene call, under the workflow's Subject metaprompt, written from the chat's turns.
  const [call, ...more] = await sceneCalls(line);
  expect(more).toEqual([]);
  expect(call?.messages[0]).toMatchObject({
    role: "system",
    content: SCENE_METAPROMPTS.krea2.subject,
  });
  const user = call?.messages.find((message) => message.role === "user")?.content ?? "";
  expect(user).toContain(line);
  expect(user).toContain(`Reply: ${line}`);
  expect(call?.image).toBe(true);
  // A plain ComfyUI paints from the prompt alone: it never receives the portrait.
  const state = await scope.state(mark(base, "prompt"));
  expect(state.containing).toBe(1);
  expect(state.uploads).toBe(0);
  await scope.expectClean();

  // The next reply's request carries the same turns as before, then the new two, and no image.
  const next = `And then ${crypto.randomUUID()}`;
  const second = chatRequest(page);
  await send(page, next);
  const sent = await second;
  const after = sent.postDataJSON() as { messages: unknown[] };
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.messages).toHaveLength(before.messages.length + 2);
  const body = sent.postData() ?? "";
  expect(body).not.toContain("data:image");
  expect(body).not.toContain(scene.image().toString("base64").slice(0, 64));
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const replies = await replyCalls(next);
  expect(replies.map((record) => record.image)).toEqual([false]);
  // The picture stays with the message it followed.
  await expect(scenePicture(page, name)).toHaveCount(1);

  await clearChat(page);
  await expect(sceneItems(page)).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("on a phone the button sits under the band's portrait and paints there too", async ({
  comfy,
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await comfy({ mode: "plain" });
  const name = await sceneChat(page, request, `On the stairs ${mark(keptBase(), "steer")}`);
  // The band above the story, not the latest reply's float.
  await expect(lastReply(page).locator("[data-presence]")).toHaveCount(0);
  const band = page.locator("[data-presence]");
  await expect(band).toHaveCount(1);
  await expectUnder(sceneButton(band), chatPortrait(page, name));
  await sceneButton(band).click();
  await expect(scenePicture(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  await expect(sceneItems(page)).toHaveCount(1);
});

test("without a ComfyUI address the button is not there", async ({ page, request }) => {
  const name = await sceneChat(page, request, `In the hall ${mark(keptBase(), "steer")}`);
  await expect(chatPortrait(page, name)).toBeVisible();
  await expect(sceneButton(page)).toHaveCount(0);
});
