import type { APIRequestContext, Page } from "@playwright/test";
import { upstreamRecords } from "./support/chat.ts";
import { type ComfyScope, expectBatch, portraits, recordArt } from "./support/creator.ts";
import { mark } from "./support/creator-fixtures.ts";
import { patchSettings } from "./support/entities.ts";
import { CANARY_MARKER, canary } from "./support/env.ts";
import { matrixRow, type RowLabel, serverHopsHolding } from "./support/retention.ts";
import { FRAGMENT_OFFSETS, imageFragments } from "./support/scan.ts";
import {
  asStoredPortrait,
  createArtCharacter,
  newArt,
  openStudio,
  storedPortrait,
  studio,
  useAsPortrait,
} from "./support/sheet-art.ts";
import { expect, test } from "./support/test.ts";

/*
 * Retention matrix, a saved character's new art (docs/ARCHITECTURE.md §
 * Retention matrix): the owner's direction, the image prompt and the four
 * candidates are creation drafts; Use as portrait makes the chosen one
 * character data. A row types a canary direction before New art, whose
 * `-steer` mark outranks the card's, so the image prompt carries `-prompt`
 * and the four `-img0` to `-img3` of the same canary
 * (e2e/support/creator-fixtures.ts) and the server cells in
 * e2e/server-writes.check.ts find any of them. The saved card derives from
 * a non-canary `kept-` base, as it persists by design. A row proves each
 * draft existed (at the mock upstream, at the mock ComfyUI, in the art stream
 * the tab read), then runs the browser cells; ComfyUI must hold nothing of
 * the run afterwards. Each row saves the model the image prompt defaults to.
 */

test.beforeEach(async ({ request }) => {
  await patchSettings(request, { model: "mock-fast" });
});

/** The sheet returns without the studio, a candidate or a canary in any field. */
async function expectSheetArtEmpty(page: Page) {
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  await expect(studio(page)).toHaveCount(0);
  await expect(portraits(page)).toHaveCount(0);
  const values = await page
    .locator("textarea, input")
    .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value));
  expect(values.filter((value) => value.includes(CANARY_MARKER))).toEqual([]);
}

/** Where every row starts, what B-bf finds once back, and the time a row may take. */
const SHEET_ART = {
  start: "/characters",
  expectEmpty: expectSheetArtEmpty,
  // Image fragments scanned across every server directory and the profile.
  timeout: 90_000,
};

/**
 * A saved character's studio painting four from a canary direction of
 * `label`: the direction reached the upstream, the image prompt ComfyUI and
 * the four the tab, each proven. Returns the canary, the character and the
 * four as the tab received them.
 */
async function paintFromDirection(
  page: Page,
  request: APIRequestContext,
  scope: ComfyScope,
  label: RowLabel,
  portrait?: "noisy",
) {
  const base = canary(label);
  const kept = `kept-${label}-${crypto.randomUUID().slice(0, 8)}`;
  const id = await createArtCharacter(request, kept, portrait === undefined ? {} : { portrait });
  const art = await recordArt(page);
  await openStudio(page, id);
  await studio(page)
    .getByRole("textbox", { name: "Direction for the next art" })
    .fill(`At dusk ${mark(base, "steer")}`);
  await newArt(page).click();
  await art.expectPortraits(base);
  await expectBatch(page);
  expect(await upstreamRecords(mark(base, "steer"))).toHaveLength(1);
  expect((await scope.state(mark(base, "prompt"))).containing).toBe(1);
  await scope.expectClean();
  return { base, id, candidates: art.images() };
}

matrixRow(
  "saok",
  async ({ comfy, page, request }) => {
    await paintFromDirection(page, request, await comfy({ mode: "plain" }), "saok");
  },
  SHEET_ART,
);

matrixRow(
  "sause",
  async ({ comfy, fragments, page, request }) => {
    const scope = await comfy({ mode: "plain", distinct: true });
    const { base, id, candidates } = await paintFromDirection(
      page,
      request,
      scope,
      "sause",
      "noisy",
    );
    // The stored portrait went to the prompt model as a JPEG copy, a draft of the request.
    const [sent] = await upstreamRecords(mark(base, "steer"));
    expect(sent?.image).toBe(true);
    const url = sent?.imageData ?? "";
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    const reference = await imageFragments(
      Buffer.from(url.slice(url.indexOf(",") + 1), "base64"),
      FRAGMENT_OFFSETS.jpeg,
      { "sent.json": JSON.stringify({ image_url: { url } }) },
    );

    const radios = portraits(page).getByRole("radio");
    await radios.nth(3).click();
    await expect(radios.nth(3)).toHaveAttribute("aria-checked", "true");
    await useAsPortrait(page);
    // The chosen one is character data now: the server's rebuild of it, byte for byte.
    const kept = await asStoredPortrait(candidates[3] ?? Buffer.alloc(0));
    expect((await storedPortrait(request, id)).png.equals(kept)).toBe(true);
    expect(await page.content()).not.toContain(CANARY_MARKER);

    // Positive control: the kept portrait is found, in the database only.
    expect(await serverHopsHolding(await imageFragments(kept, FRAGMENT_OFFSETS.png))).toEqual([
      "S-data",
    ]);
    const others = (
      await Promise.all(
        [0, 1, 2].map((index) =>
          imageFragments(candidates[index] ?? Buffer.alloc(0), FRAGMENT_OFFSETS.png),
        ),
      )
    ).flat();
    expect(await serverHopsHolding([...others, ...reference])).toEqual([]);
    fragments.push(...others, ...reference);
  },
  SHEET_ART,
);
