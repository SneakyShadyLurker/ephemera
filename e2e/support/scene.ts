import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import { SCENE_METAPROMPTS } from "../../packages/core/src/creator/prompts.ts";
import { artImages } from "./art-stream.ts";
import { chooseCharacter, lastReply, openChat, send, upstreamRecords } from "./chat.ts";
import { ART_TIMEOUT } from "./creator.ts";
import { keptBase, mark } from "./creator-fixtures.ts";
import { holds } from "./scan.ts";
import { artName, createArtCharacter } from "./sheet-art.ts";
import type { UpstreamRecordView } from "./upstream.ts";

/*
 * Picture this scene as the owner drives it (e2e/scene.spec.ts,
 * e2e/scene-retention.spec.ts): a chat with a saved character from a
 * non-canary `kept-` base, whose line carries a `-steer` mark. The scene
 * source holds the card's `-card` mark before the excerpt, and the line's
 * mark outranks it, so the image prompt carries `<base>-prompt` and the one
 * picture `<base>-img0` of the line's base (e2e/support/creator-fixtures.ts).
 */

/** Picture this scene, under the portrait in the float and in the phone band. */
export const sceneButton = (scope: Page | Locator) =>
  scope.getByRole("button", { name: "Picture this scene", exact: true });

/** The scene items in the thread, each one `<li data-scene data-status>`. */
export const sceneItems = (page: Page) => page.locator("[data-scene]");

/** A painted scene's canvas, named for the character. */
export const scenePicture = (page: Page, name: string) =>
  page.getByRole("img", { name: `Scene with ${name}`, exact: true });

/** The character's portrait in the chat, the viewer's button. */
export const chatPortrait = (page: Page, name: string) =>
  page.getByRole("button", { name: `Portrait of ${name}: show larger`, exact: true });

const SCENE_PROMPTS = new Set(
  Object.values(SCENE_METAPROMPTS).flatMap((byKind) => Object.values(byKind)),
);

const isScene = (record: UpstreamRecordView) =>
  SCENE_PROMPTS.has(record.messages.find((message) => message.role === "system")?.content ?? "");

/** The scene calls the mock upstream saw whose user message holds `text`. */
export async function sceneCalls(text: string): Promise<UpstreamRecordView[]> {
  return (await upstreamRecords(text)).filter(isScene);
}

/** The other requests the mock upstream saw whose last user turn holds `text`: the chat's replies. */
export async function replyCalls(text: string): Promise<UpstreamRecordView[]> {
  return (await upstreamRecords(text)).filter((record) => !isScene(record));
}

/**
 * A chat with a saved character, its portrait stored, on `mock-fast`, that
 * said `line` and has its reply. Returns the character's name.
 */
export async function sceneChat(
  page: Page,
  request: APIRequestContext,
  line: string,
): Promise<string> {
  const kept = keptBase();
  await createArtCharacter(request, kept, { portrait: "plain" });
  const name = artName(kept);
  await openChat(page, "mock-fast");
  await chooseCharacter(page, name);
  await send(page, line);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  return name;
}

/**
 * Records every scene stream the page receives, each passed through whole
 * once the server finished it. `expectPicture` checks the latest carried the
 * one picture marked from `base`; `image` decodes it as the tab received it.
 */
export async function recordScene(page: Page) {
  const bodies: Buffer[] = [];
  const batches: Buffer[][] = [];
  await page.route("**/api/scene", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    bodies.push(body);
    batches.push(await artImages(body));
    await route.fulfill({ response, body });
  });
  return {
    expectPicture: async (base: string) => {
      await expect.poll(() => bodies.length, { timeout: ART_TIMEOUT }).toBe(1);
      expect(holds(bodies[0] ?? Buffer.alloc(0), mark(base, "img0"))).toBe(true);
    },
    image: (): Buffer => {
      const images = batches.at(-1) ?? [];
      expect(images).toHaveLength(1);
      return images[0] ?? Buffer.alloc(0);
    },
  };
}
