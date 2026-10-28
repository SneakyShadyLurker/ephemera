import type { APIRequestContext } from "@playwright/test";
import { toPortrait } from "../apps/server/src/images.ts";
import { expectUpstreamAborted, upstreamRecords } from "./support/chat.ts";
import { cardName, mark, noisyPortraitPng, portraitPng } from "./support/creator-fixtures.ts";
import { patchSettings } from "./support/entities.ts";
import { CANARY_MARKER, canary, integrationHeaders } from "./support/env.ts";
import {
  MATRIX_ROWS,
  type RowLabel,
  recordClass,
  type ServerHop,
  serverHopsHolding,
} from "./support/retention.ts";
import { FRAGMENT_OFFSETS, holds, imageFragments } from "./support/scan.ts";
import { appOrigin, expect, test } from "./support/test.ts";
import type { MockModel } from "./support/upstream.ts";

// These requests share the server's global image-card admission limit.
test.describe.configure({ mode: "default" });

/*
 * Retention matrix, image cards (docs/ARCHITECTURE.md § Retention matrix):
 * Atelier's server posts an image, its prompt as notes and the owner's
 * direction to `POST /api/creator/card/from-image` with the integration key.
 * The upload, the notes, the direction and the model's answer are creation
 * drafts; only a kept card and its re-encoded portrait persist. Server cells
 * only: the path never touches a tab. Each row's notes carry `<canary>-desc`,
 * its direction `<canary>-steer` and its image a `<canary>-src` text chunk, which re-encoding strips; the answer carries
 * `<canary>-card` except in the kept row, whose card derives from a
 * non-canary `-keep` base (e2e/support/creator-fixtures.ts). The image's top
 * rows are random pixels, so the server's two drafts of it are unique to the
 * row: the re-encoded PNG portrait, which this process rebuilds from the
 * upload with the server's own `toPortrait` (the kept row proves the rebuild
 * byte-identical to the stored portrait), and the JPEG made of it and sent
 * upstream, which the mock recorded. Fragments of both, kept in this
 * process's memory, mark the image where the text chunk cannot.
 */

/** The marks of one row: the notes, the direction and the image all carry canaries of its label. */
function rowContent(label: RowLabel, keep?: string) {
  const base = canary(label);
  const notes = [
    `A placeholder archivist in a slate town, soft window light. ${mark(base, "desc")}`,
    ...(keep === undefined ? [] : [mark(keep, "keep")]),
  ].join(" ");
  const direction = `A retired sea captain, gruff but kind. ${mark(base, "steer")}`;
  const source = `${base}-src`;
  return { base, notes, direction, source, png: noisyPortraitPng(source) };
}

/** The server hops holding any fragment of the JPEG the server sent upstream for the row. */
async function imageHops(notesMark: string): Promise<ServerHop[]> {
  const [record] = await upstreamRecords(notesMark);
  const url = record?.imageData ?? "";
  expect(url).toMatch(/^data:image\/jpeg;base64,/);
  const jpeg = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const fragments = await imageFragments(jpeg, FRAGMENT_OFFSETS.jpeg, {
    "sent.json": JSON.stringify({ image_url: { url } }),
  });
  return serverHopsHolding(fragments);
}

/** The PNG portrait the server builds from the row's upload, rebuilt here by the same pipeline. */
async function normalizedPortrait(content: { png: Buffer }): Promise<Buffer> {
  return Buffer.from((await toPortrait(new Uint8Array(content.png))).png);
}

/** A request that kept no character left neither draft of its image on any server hop. */
async function expectNoImageDrafts(content: { base: string; png: Buffer }) {
  // The model's JPEG copy, as the upstream received it.
  expect(await imageHops(mark(content.base, "desc"))).toEqual([]);
  // The re-encoded PNG portrait the JPEG was made from.
  const png = await normalizedPortrait(content);
  expect(await serverHopsHolding(await imageFragments(png, FRAGMENT_OFFSETS.png))).toEqual([]);
}

/** Posts an image card request as Atelier's server does: multipart, its own key, its Authelia user and Origin. */
function postImageCard(
  content: { notes: string; direction?: string; png: Buffer },
  id: string,
  user: string,
  signal?: AbortSignal,
): Promise<Response> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(content.png)], { type: "image/png" }), "image.png");
  form.set("id", id);
  form.set("notes", content.notes);
  if (content.direction !== undefined) form.set("direction", content.direction);
  return fetch(`${appOrigin()}/api/creator/card/from-image`, {
    method: "POST",
    headers: { ...integrationHeaders(user), Origin: appOrigin(), Accept: "application/x-ndjson" },
    body: form,
    signal: signal ?? null,
  });
}

/** The stream's events, keepalive lines skipped; the body holds no canary. */
async function events(response: Response): Promise<unknown[]> {
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(CANARY_MARKER);
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** The character does not exist: nothing of a failed request was kept. */
async function expectNoCharacter(request: APIRequestContext, id: string) {
  expect((await request.get(`/api/characters/${id}`)).status()).toBe(404);
}

/** The notes and the direction reached the upstream once per attempt, with the image attached. */
async function expectSent(content: { base: string }, calls = 1) {
  expect(await upstreamRecords(mark(content.base, "steer"))).toHaveLength(calls);
  const records = await upstreamRecords(mark(content.base, "desc"));
  expect(records).toHaveLength(calls);
  for (const record of records) expect(record.image).toBe(true);
  return records;
}

/** One image card row: server cells only, recorded once its content was proven to exist. */
function imageCardRow(
  label: RowLabel,
  run: (row: { request: APIRequestContext; user: string }) => Promise<void>,
) {
  test(`retention matrix: ${MATRIX_ROWS[label].row}`, async ({ request, user }) => {
    await test.step(`${label}: the content exists`, () => run({ request, user }));
    await recordClass(label);
  });
}

imageCardRow("icok", async ({ request, user }) => {
  const keep = `imagecard-${crypto.randomUUID().slice(0, 8)}`;
  const content = rowContent("icok", keep);
  const id = crypto.randomUUID();
  await patchSettings(request, { model: "mock-fast" });
  const name = cardName("subject", keep);
  expect(await events(await postImageCard(content, id, user))).toEqual([
    { type: "status", phase: "writing" },
    { type: "status", phase: "saving" },
    { type: "result", id, name },
  ]);
  await expectSent(content);
  const character = await request.get(`/api/characters/${id}`);
  expect(character.status()).toBe(200);
  const stored = (await character.json()) as {
    card: { name: string; description: string };
    portrait: number | null;
  };
  expect(stored.card.name).toBe(name);
  expect(stored.card.description).toContain(mark(keep, "card"));
  expect(stored.portrait).not.toBeNull();
  const portrait = await request.get(`/api/characters/${id}/portrait/image?size=full`);
  expect(portrait.status()).toBe(200);
  const png = await portrait.body();
  // Positive control for the other rows: the rebuild here is byte for byte the server's portrait.
  expect(png.equals(await normalizedPortrait(content))).toBe(true);
  // Re-encoding dropped the upload's text chunk: the stored image holds no canary of it.
  expect(holds(png, content.source)).toBe(false);
  // The kept portrait and card are character data now, in the database only; the notes and direction nowhere.
  expect(await serverHopsHolding(await imageFragments(png, FRAGMENT_OFFSETS.png))).toEqual([
    "S-data",
  ]);
  // The model's JPEG copy was a draft: it persisted nowhere.
  expect(await imageHops(mark(content.base, "desc"))).toEqual([]);
  expect(await serverHopsHolding(keep)).toEqual(["S-data"]);
  expect(await serverHopsHolding(mark(keep, "keep"))).toEqual([]);
  expect(await serverHopsHolding(mark(content.base, "steer"))).toEqual([]);
});

/** A row whose request ends in `code` without a character; `model` answers each attempt. */
function failedRow(
  label: RowLabel,
  model: MockModel,
  code: string,
  phases: string[],
  calls: number,
) {
  imageCardRow(label, async ({ request, user }) => {
    const content = rowContent(label);
    const id = crypto.randomUUID();
    await patchSettings(request, { model });
    expect(await events(await postImageCard(content, id, user))).toEqual([
      ...phases.map((phase) => ({ type: "status", phase })),
      { type: "error", code },
    ]);
    const records = await expectSent(content, calls);
    for (const record of records) {
      // The model wrote a card of this row's canary, and the server dropped it.
      if (model !== "mock-error") expect(record.answer).toContain(mark(content.base, "card"));
    }
    await expectNoCharacter(request, id);
    await expectNoImageDrafts(content);
  });
}

// The mock's error body echoes the notes and the direction; the server must not pass them on anywhere.
failedRow("icerr", "mock-error", "upstream", ["writing"], 1);

// Both answers lack the creator notes: the validator accepts them, the strict bar does not.
failedRow("icinvalid", "mock-badcard", "invalid_card", ["writing", "rewriting"], 2);

imageCardRow("icstop", async ({ request, user }) => {
  const content = rowContent("icstop");
  const id = crypto.randomUUID();
  // mock-stall sends the answer up to its first `-card` chunk, then holds the stream open.
  await patchSettings(request, { model: "mock-stall" });
  // Playwright's request cannot abort mid-body; the runner's fetch can.
  const caller = new AbortController();
  const response = await postImageCard(content, id, user, caller.signal);
  expect(response.status).toBe(200);
  const reading = response.text().catch(() => undefined);
  // The mock records the `-card` chunk once it is flushed to the socket.
  await expect
    .poll(async () =>
      (await upstreamRecords(mark(content.base, "desc"))).map((record) =>
        record.answer?.includes(mark(content.base, "card")),
      ),
    )
    .toEqual([true]);
  /*
   * A flush plus a bound, not an acknowledgement that the server read it: on
   * loopback a flushed frame reaches the server's socket at once, and 300 ms
   * lets it read the frame into the draft before the caller leaves. Nothing
   * follows it, so the stream is still open when the abort lands.
   */
  await new Promise((resolve) => setTimeout(resolve, 300));
  caller.abort();
  await reading;
  await expectUpstreamAborted(mark(content.base, "desc"));
  expect(await upstreamRecords(mark(content.base, "steer"))).toHaveLength(1);
  const [record] = await upstreamRecords(mark(content.base, "desc"));
  // Aborted mid-stream: the model had not finished the card.
  expect(record?.completed).toBe(false);
  await expectNoCharacter(request, id);
  await expectNoImageDrafts(content);
});

test("an image card is kept with its portrait and listed in the gallery", async ({
  request,
  user,
}) => {
  const keep = `imagecard-${crypto.randomUUID().slice(0, 8)}`;
  const id = crypto.randomUUID();
  await patchSettings(request, { model: "mock-fast" });
  const response = await postImageCard(
    { notes: `A placeholder archivist. ${mark(keep, "keep")}`, png: portraitPng("no marker") },
    id,
    user,
  );
  expect((await events(response)).at(-1)).toEqual({
    type: "result",
    id,
    name: cardName("subject", keep),
  });
  const list = await request.get("/api/characters");
  expect(list.status()).toBe(200);
  const { characters } = (await list.json()) as {
    characters: { id: string; portrait: number | null }[];
  };
  expect(characters.find((character) => character.id === id)?.portrait).toEqual(expect.any(Number));
  const portrait = await request.get(`/api/characters/${id}/portrait/image?size=full`);
  expect(portrait.status()).toBe(200);
  expect(portrait.headers()["content-type"]).toBe("image/png");
  expect((await portrait.body()).subarray(0, 8)).toEqual(
    Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  );
});
