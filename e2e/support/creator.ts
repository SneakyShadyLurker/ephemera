import { type APIRequestContext, expect, type Page } from "@playwright/test";
import type { CreatorKind } from "../../packages/core/src/creator/schema.ts";
import { artImages } from "./art-stream.ts";
import { type Mark, mark } from "./creator-fixtures.ts";
import { choose } from "./entities.ts";
import { COMFYUI_PORT } from "./env.ts";
import type { ScopeOptions, ScopeState } from "./mock-comfyui.ts";
import { holds } from "./scan.ts";
import type { MockModel } from "./upstream.ts";

/** AI card creation as the owner drives it (e2e/creator.spec.ts, e2e/creator-retention.spec.ts). */

export const COPY = {
  subject: {
    field: "Who do you want to meet?",
    create: "Create character",
    keep: "Keep character",
  },
  group: {
    field: "Who do you want to meet?",
    create: "Create characters",
    keep: "Keep character",
  },
  scenario: {
    field: "Where do you want to go?",
    create: "Create scenario",
    keep: "Keep scenario",
  },
} as const satisfies Record<CreatorKind, { field: string; create: string; keep: string }>;

/** Keep's label while no portrait is on show, for either kind. */
export const KEEP_WITHOUT_PORTRAIT = "Keep without portrait";

export const IMAGES = ["img0", "img1", "img2", "img3"] as const satisfies Mark[];

const COMFYUI = `http://127.0.0.1:${COMFYUI_PORT}`;

/** How long a card and its batch of portraits may take on a loaded machine. */
export const ART_TIMEOUT = 30_000;

/** A scope of the mock ComfyUI of the test's own (e2e/support/mock-comfyui.ts). */
export interface ComfyScope {
  /** The address the owner saves in Settings. */
  address: string;
  /** Replaces the scope's fake, as when ComfyUI is restarted with other behaviour. */
  configure: (options: ScopeOptions) => Promise<void>;
  /** What the fake recorded; `contains` counts submitted graphs holding the text. */
  state: (contains?: string) => Promise<ScopeState>;
  /** No queued or running prompt, no history entry and no lease is left (cleanup has its own deadline). */
  expectClean: () => Promise<void>;
  remove: () => Promise<void>;
}

export async function comfyScope(options: ScopeOptions = {}): Promise<ComfyScope> {
  const id = crypto.randomUUID();
  const control = `${COMFYUI}/__scopes/${id}`;
  const configure = async (next: ScopeOptions) => {
    const response = await fetch(control, { method: "PUT", body: JSON.stringify(next) });
    expect(response.status).toBe(204);
  };
  const state = async (contains = "") => {
    const response = await fetch(`${control}?contains=${encodeURIComponent(contains)}`);
    expect(response.status).toBe(200);
    return (await response.json()) as ScopeState;
  };
  await configure(options);
  return {
    address: `${COMFYUI}/c/${id}`,
    configure,
    state,
    expectClean: () =>
      expect
        .poll(async () => (await state()).clean, {
          message: "ComfyUI holds nothing of the run",
          timeout: ART_TIMEOUT,
        })
        .toBe(true),
    remove: async () => {
      await fetch(control, { method: "DELETE" });
    },
  };
}

/** From the gallery: Create with AI, the kind, the description, the model, then Create. */
export async function createCard(
  page: Page,
  {
    kind,
    description,
    model,
    onGallery = false,
  }: {
    kind: CreatorKind;
    description: string;
    model: MockModel;
    /** Start from the gallery already open, without loading the page again. */
    onGallery?: boolean;
  },
) {
  if (!onGallery) await page.goto("/characters");
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await page.locator(`[data-kind="${kind}"]`).click();
  const field = page.getByRole("textbox", { name: COPY[kind].field });
  await field.fill(description);
  await expect(field).toHaveValue(description);
  await choose(page, "Model", model);
  await page.getByRole("button", { name: COPY[kind].create }).click();
}

/** The four candidate portraits as a radio group; `expectBatch` waits for the four. */
export const portraits = (page: Page) => page.getByRole("radiogroup", { name: "Portraits" });

export const expectBatch = (page: Page) =>
  expect(portraits(page).getByRole("radio")).toHaveCount(4, { timeout: ART_TIMEOUT });

/**
 * Records every art stream the page receives, each passed through whole once
 * the server finished it (Chromium keeps no copy of a streamed fetch body).
 * `expectPortraits` checks that the latest of `count` streams carried the
 * four portraits marked from `base`: the candidate images reached the tab. `images` decodes the latest stream's
 * four PNGs, in order, as the tab received them.
 */
export async function recordArt(page: Page) {
  const bodies: Buffer[] = [];
  const batches: Buffer[][] = [];
  let contentType: string | undefined;
  await page.route("**/api/creator/art", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    contentType = response.headers()["content-type"];
    bodies.push(body);
    batches.push(await artImages(body));
    await route.fulfill({ response, body });
  });
  return {
    contentType: () => contentType,
    expectPortraits: async (base: string, count = 1) => {
      await expect.poll(() => bodies.length, { timeout: ART_TIMEOUT }).toBe(count);
      const body = bodies.at(-1) ?? Buffer.alloc(0);
      for (const image of IMAGES) expect(holds(body, mark(base, image)), image).toBe(true);
    },
    images: (): Buffer[] => {
      const images = batches.at(-1) ?? [];
      expect(images.filter(Boolean)).toHaveLength(IMAGES.length);
      return images;
    },
  };
}

/** Picks a More menu item of the showcase, confirming Rewrite or Discard when it asks. */
export async function showcaseAction(page: Page, item: "Keep and edit" | "Rewrite" | "Discard") {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: item }).click();
  if (item === "Keep and edit") return;
  const dialog = page.getByRole("alertdialog", { name: /^(Rewrite|Discard) this/ });
  await dialog.getByRole("button", { name: item }).click();
  await expect(dialog).toHaveCount(0);
}

/** The characters the app server holds now. */
export async function listCharacters(
  request: APIRequestContext,
): Promise<{ id: string; name: string; portrait: number | null }[]> {
  const response = await request.get("/api/characters");
  expect(response.status()).toBe(200);
  return (
    (await response.json()) as {
      characters: { id: string; name: string; portrait: number | null }[];
    }
  ).characters;
}
