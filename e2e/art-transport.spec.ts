import { ART_STREAM_TYPE } from "../packages/core/src/creator/art-stream.ts";
import { ART_TIMEOUT, createCard, expectBatch, portraits, recordArt } from "./support/creator.ts";
import { keptBase, mark, ownerDescription } from "./support/creator-fixtures.ts";
import { recordScene, sceneButton, sceneChat, scenePicture } from "./support/scene.ts";
import { expect, test } from "./support/test.ts";

const LARGE = 4 * 1024 * 1024;

test("large noisy portraits reach Chromium as binary frames after socket loss", async ({
  comfy,
  page,
}) => {
  test.setTimeout(90_000);
  const scope = await comfy({ mode: "private", large: true, dropSocket: true });
  const base = keptBase();
  // This wrapper records the stream before passing it to the tab's real reader and ImageDecoder.
  const art = await recordArt(page);
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(base),
    model: "mock-fast",
  });
  await expectBatch(page);
  await art.expectPortraits(base);
  expect(
    art
      .images()
      .map((png) => png.byteLength)
      .every((size) => size >= LARGE),
  ).toBe(true);
  await expect(portraits(page).locator("canvas")).toHaveCount(4);
  expect(art.contentType()).toBe(ART_STREAM_TYPE);
  await scope.expectClean();
  expect((await scope.state()).prompts).toBe(1);
});

test("large noisy scene reaches Chromium through a silent healthy socket's private status", async ({
  comfy,
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const scope = await comfy({ mode: "private", large: true, silent: true });
  const base = keptBase();
  const name = await sceneChat(page, request, `At the window ${mark(base, "steer")}`);
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/scene",
  );
  const scene = await recordScene(page);
  await sceneButton(page).click();
  await expect(scenePicture(page, name)).toBeVisible({ timeout: ART_TIMEOUT });
  await scene.expectPicture(base);
  expect(scene.image().byteLength).toBeGreaterThanOrEqual(LARGE);
  expect((await response).headers()["content-type"]).toBe(ART_STREAM_TYPE);
  await scope.expectClean();
  expect((await scope.state()).prompts).toBe(1);
});

test("Chromium rejects a large image frame cut short without showing candidate images", async ({
  comfy,
  page,
}) => {
  await comfy();
  // An image frame that announces more bytes than arrive before the body ends.
  const header = Buffer.alloc(5);
  header[0] = 2;
  header.writeUInt32BE(LARGE + 1, 1);
  await page.route("**/api/creator/art", (route) =>
    route.fulfill({
      contentType: ART_STREAM_TYPE,
      body: Buffer.concat([header, Buffer.alloc(LARGE, 0x41)]),
    }),
  );
  await createCard(page, {
    kind: "subject",
    description: ownerDescription(keptBase()),
    model: "mock-fast",
  });
  await expect(page.getByText(/^Portraits unavailable\./)).toBeVisible({
    timeout: ART_TIMEOUT,
  });
  await expect(portraits(page).getByRole("radio")).toHaveCount(0);
});
