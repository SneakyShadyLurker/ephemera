import { defaultPromptPreset, normalizeCard, serializeCharacter } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import v2Full from "../../../packages/core/test-fixtures/imports/v2-full.json";
import v2Minimal from "../../../packages/core/test-fixtures/imports/v2-minimal.json";
import v3Full from "../../../packages/core/test-fixtures/imports/v3-full.json";
import { cardToPng, readCardFile } from "../src/cards.ts";
import { fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  PICK_SEED,
  postJson,
  promptPart,
  responseParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";
import { cardChunk, pngWithText } from "./image-fixtures.ts";

describe("foreign import corpus becomes native data", () => {
  it.each([v2Full, v2Minimal, v3Full])(
    "imports $spec/$data.name from JSON and PNG, exports native, and assembles",
    async (input) => {
      const result = normalizeCard(input);
      if (!result.ok) throw new Error(result.error);
      const bytes = new TextEncoder().encode(JSON.stringify(input));
      expect(await readCardFile(bytes)).toMatchObject({ ok: true, card: result.card });
      const foreign = await pngWithText({
        [input.spec === "chara_card_v3" ? "ccv3" : "chara"]: cardChunk(input),
      });
      expect(await readCardFile(foreign)).toMatchObject({ ok: true, card: result.card });
      expect(result.card).not.toHaveProperty("extensions");
      expect(result.card).not.toHaveProperty("assets");
      expect(result.card.firstMessage).toBe(input.data.first_mes);
      expect(
        await readCardFile(new TextEncoder().encode(serializeCharacter(result.card))),
      ).toMatchObject({ ok: true, card: result.card });
      expect(await readCardFile(await cardToPng(result.card, undefined))).toMatchObject({
        ok: true,
        card: result.card,
      });
      const upstream = fakeUpstream({ chunks: ["Synthetic response."] });
      const { app, instances } = testApp({ fetch: upstream.fetch });
      const { stores } = instances.instance(TEST_USER);
      const characterId = stores.characters.create(result.card);
      const promptPresetId = stores.presets.prompt.create(
        {
          ...defaultPromptPreset(),
          authorsNote: { ...defaultPromptPreset().authorsNote, enabled: false },
        },
        crypto.randomUUID(),
      );
      const response = await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          characterId,
          promptPresetId,
          clock: CLOCK,
          pickSeed: PICK_SEED,
          messages: [{ role: "user", content: "Hello." }],
        }),
      );
      expect(response.status).toBe(200);
      const prompt = promptPart(await responseParts(response));
      expect(
        prompt.messages.some(
          (message) => message.source.kind === "block" && message.source.id === "charDescription",
        ),
      ).toBe(result.card.description.trim() !== "");
      const body = upstream.records[0]?.body as { messages: object[] };
      expect(body.messages.every((message) => !Object.hasOwn(message, "name"))).toBe(true);
    },
  );
});
