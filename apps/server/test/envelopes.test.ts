import {
  blankCard,
  characterMemorySchema,
  eventsResponseSchema,
  importResponseSchema,
  PALETTE_ROLES,
  paletteResponseSchema,
  palettesResponseSchema,
  previewResponseSchema,
  settingsResponseSchema,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  fileForm,
  formRequest,
  ownerHeaders,
  PICK_SEED,
  postJson,
  TEST_USER,
  testApp,
} from "./helpers.ts";

/*
 * Each JSON body the web app reads parses with the one core schema both
 * sides use (core responses.ts), as the server answers it.
 */

function setup() {
  const { app, instances } = testApp({ fetch: fakeUpstream().fetch });
  return { app, stores: instances.instance(TEST_USER).stores };
}

const upload = (text: string, name: string) => formRequest("POST", fileForm(text, name));

const read = async (response: Response, status = 200) => {
  expect(response.status).toBe(status);
  return response.json();
};

describe("response envelopes", () => {
  it("answers the lists and settings the web app reads in their core shapes", async () => {
    const { app } = setup();
    const events = await read(await app.request("/api/events", { headers: ownerHeaders() }));
    expect(eventsResponseSchema.parse(events).events).toEqual([]);
    const settings = await read(await app.request("/api/settings", { headers: ownerHeaders() }));
    expect(settingsResponseSchema.safeParse(settings).success).toBe(true);
    const palettes = await read(await app.request("/api/palettes", { headers: ownerHeaders() }));
    expect(palettesResponseSchema.parse(palettes).palettes).toEqual([]);
  });

  it("answers a saved palette in its core shape", async () => {
    const { app } = setup();
    const scheme = Object.fromEntries(PALETTE_ROLES.map((role) => [role, "#123456"]));
    const palette = {
      name: "Mine",
      base: "nord",
      light: scheme,
      dark: scheme,
      origin: { light: scheme, dark: scheme },
      handSet: { light: [], dark: [] },
    };
    const saved = await read(
      await app.request("/api/palettes/1", { ...postJson(palette), method: "POST" }),
    );
    expect(paletteResponseSchema.parse(saved).palette.name).toBe("Mine");
  });

  it("answers a chat preview in its core shape", async () => {
    const { app } = setup();
    const preview = await read(
      await app.request(
        "/api/chat/preview",
        postJson({
          model: "fake-model",
          clock: CLOCK,
          pickSeed: PICK_SEED,
          messages: [{ role: "user", content: "Hello there." }],
        }),
      ),
    );
    expect(previewResponseSchema.parse(preview).prompt.messages.length).toBeGreaterThan(0);
  });

  it("answers a character's memory in its core shape", async () => {
    const { app, stores } = setup();
    const id = stores.characters.create(blankCard("Mara"));
    const memory = await read(
      await app.request(`/api/memory/characters/${id}`, { headers: ownerHeaders() }),
    );
    expect(characterMemorySchema.parse(memory)).toEqual({ state: null, episodes: [] });
  });

  it("answers card and lorebook imports in their core shapes", async () => {
    const { app } = setup();
    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Mara", description: "", personality: "", scenario: "", first_mes: "" },
    };
    const character = await read(
      await app.request("/api/characters/import", upload(JSON.stringify(card), "mara.json")),
      201,
    );
    expect(importResponseSchema.parse(character).name).toBe("Mara");
    const book = { entries: { "0": { uid: 0, key: ["harbour"], content: "The harbour." } } };
    const lorebook = await read(
      await app.request("/api/lorebooks/import", upload(JSON.stringify(book), "Harbour.json")),
      201,
    );
    expect(importResponseSchema.parse(lorebook)).toMatchObject({
      name: "Harbour",
      report: { kept: [], changed: [], skipped: [] },
    });
  });
});
