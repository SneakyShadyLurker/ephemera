import {
  blankCard,
  blankLorebook,
  CARD_LIMITS,
  type CharacterCard,
  type CharacterPatch,
  defaultPromptPreset,
  defaultSamplerPreset,
  type Lorebook,
  presetImportResponseSchema,
  storedCharacterSchema,
  storedLorebookSchema,
  toCharacterFile,
  toLorebookFile,
  toPromptPresetFile,
  toSamplerPresetFile,
  utf8Bytes,
} from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";
import { fakeUpstream } from "./fake-upstream.ts";
import {
  fileForm,
  formRequest,
  ownerHeaders,
  postJson,
  requestJson,
  sharedStores,
  TEST_USER,
  testApp,
} from "./helpers.ts";

const malformed = [
  { format: "unknown", version: 1, data: { name: "Foreign bait" }, spec: "chara_card_v2" },
  { format: null, entries: {}, prompts: [] },
  { version: 1, name: "Foreign bait", entries: {}, prompts: [] },
  { ...toCharacterFile(blankCard("Future")), version: 2 },
  { ...toCharacterFile(blankCard("Mixed")), spec: "chara_card_v2" },
  { ...toLorebookFile(blankLorebook("Mixed")), entries: {} },
  { ...toPromptPresetFile(defaultPromptPreset()), prompts: [] },
];

describe("fail-closed native JSON dispatch", () => {
  it.each(malformed)(
    "refuses attempted or mixed native input %# at every import boundary",
    async (file) => {
      const { app, instances } = testApp({ fetch: fakeUpstream().fetch });
      const { stores } = instances.instance(TEST_USER);
      const count = [
        stores.characters.list().length,
        stores.lorebooks.list().length,
        stores.presets.prompt.list().length,
        stores.presets.sampler.list().length,
      ];
      for (const kind of ["characters", "lorebooks"]) {
        expect(
          (
            await app.request(
              `/api/${kind}/import`,
              formRequest("POST", fileForm(JSON.stringify(file), "native.json")),
            )
          ).status,
        ).toBe(422);
      }
      expect(
        (
          await app.request(
            "/api/presets/import",
            postJson({
              promptId: crypto.randomUUID(),
              samplerId: crypto.randomUUID(),
              name: "Native",
              file,
            }),
          )
        ).status,
      ).toBe(422);
      expect([
        stores.characters.list().length,
        stores.lorebooks.list().length,
        stores.presets.prompt.list().length,
        stores.presets.sampler.list().length,
      ]).toEqual(count);
    },
  );

  it("refuses valid packets at the wrong kind's route", async () => {
    const { app } = testApp({ fetch: fakeUpstream().fetch });
    const character = toCharacterFile(blankCard("Card")),
      lorebook = toLorebookFile(blankLorebook("Book"));
    expect(
      (
        await app.request(
          "/api/characters/import",
          formRequest("POST", fileForm(JSON.stringify(lorebook), "book.json")),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          "/api/lorebooks/import",
          formRequest("POST", fileForm(JSON.stringify(character), "card.json")),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          "/api/presets/import",
          postJson({
            promptId: crypto.randomUUID(),
            samplerId: crypto.randomUUID(),
            name: "Card",
            file: character,
          }),
        )
      ).status,
    ).toBe(422);
  });

  it.each(["prompt", "sampler"] as const)(
    "uses the shared %s import response and never fetches the foreign model catalog",
    async (kind) => {
      const upstream = fakeUpstream();
      const { app } = testApp({ fetch: upstream.fetch });
      const file =
        kind === "prompt"
          ? toPromptPresetFile(defaultPromptPreset("Prompt"))
          : toSamplerPresetFile(defaultSamplerPreset("Sampler"));
      const response = await app.request(
        "/api/presets/import",
        postJson({
          promptId: crypto.randomUUID(),
          samplerId: crypto.randomUUID(),
          name: "Ignored",
          file,
        }),
      );
      expect(response.status).toBe(201);
      expect(presetImportResponseSchema.parse(await response.json()).format).toBe(kind);
      expect(upstream.records).toEqual([]);
    },
  );
});

describe("native export size boundaries", () => {
  const content = "boundary-canary-".padEnd(CARD_LIMITS.textLength + 1, "x");
  const keys = ["boundary-key-".padEnd(CARD_LIMITS.shortTextLength + 1, "x")];
  const book = (overrides: { content?: string; keys?: string[] } = {}): Lorebook => ({
    entries: [
      {
        content: "Bounded content",
        keys: ["bounded"],
        enabled: true,
        insertionOrder: 0,
        useRegex: false,
        ...overrides,
      },
    ],
  });

  it.each<{
    label: string;
    widened: Partial<CharacterCard>;
    reduction: CharacterPatch;
  }>([
    {
      label: "description",
      widened: { description: content },
      reduction: { description: "Reduced" },
    },
    {
      label: "greeting",
      widened: { alternateGreetings: [content] },
      reduction: { alternateGreetings: ["Reduced"] },
    },
    {
      label: "embedded content",
      widened: { lorebook: book({ content }) },
      reduction: { lorebook: book() },
    },
    {
      label: "embedded key",
      widened: { lorebook: book({ keys }) },
      reduction: { lorebook: book() },
    },
  ])(
    "refuses widened character $label writes and exports, then allows reduction",
    async ({ widened, reduction }) => {
      const database = openUserDatabase(undefined);
      try {
        const stores = createStores(database.db, createMemoryPortraitFiles());
        const { app, lines } = testApp({ instances: sharedStores(stores) });
        const id = stores.characters.create(blankCard("Readable"));
        const linked = stores.lorebooks.create(
          { name: "Linked", book: blankLorebook() },
          crypto.randomUUID(),
        );
        stores.lorebooks.link(linked, id);
        const card = { ...blankCard("Readable"), ...widened };
        expect(
          utf8Bytes(JSON.stringify({ format: "ephemera.character", version: 1, data: card })),
        ).toBeLessThan(CARD_LIMITS.cardJsonBytes);
        database.client
          .query("UPDATE characters SET card = ? WHERE id = ?")
          .run(JSON.stringify(card), id);
        const original = stores.characters.get(id);
        const links = stores.lorebooks.links();
        const portrait = vi.spyOn(stores.characters, "portrait");
        try {
          const read = await app.request(`/api/characters/${id}`, requestJson("GET"));
          expect(storedCharacterSchema.parse(await read.json())).toEqual(original);
          for (const extension of ["json", "png"]) {
            const exported = await app.request(
              `/api/characters/${id}/export.${extension}`,
              requestJson("GET"),
            );
            expect(exported.status).toBe(413);
            expect(await exported.json()).toEqual({ error: "payload_too_large" });
          }
          expect(portrait).not.toHaveBeenCalled();
          const patched = await app.request(
            `/api/characters/${id}`,
            requestJson("PATCH", { name: "Unrelated", revision: 0 }),
          );
          expect(patched.status).toBe(400);
          expect(await patched.json()).toEqual({ error: "invalid_request" });
          const duplicated = await app.request(
            `/api/characters/${id}/duplicate`,
            requestJson("POST"),
          );
          expect(duplicated.status).toBe(400);
          expect(await duplicated.json()).toEqual({ error: "invalid_request" });
          expect(stores.characters.list()).toHaveLength(1);
          expect(stores.characters.get(id)).toEqual(original);
          expect(stores.lorebooks.links()).toEqual(links);

          const reduced = await app.request(
            `/api/characters/${id}`,
            requestJson("PATCH", { ...reduction, revision: 0 }),
          );
          expect(reduced.status).toBe(200);
          expect(await reduced.json()).toMatchObject({ revision: 1, card: reduction });
          const saved = storedCharacterSchema.parse(stores.characters.get(id));
          for (const extension of ["json", "png"]) {
            const exported = await app.request(
              `/api/characters/${id}/export.${extension}`,
              requestJson("GET"),
            );
            expect(exported.status).toBe(200);
            if (extension === "json")
              expect(await exported.json()).toEqual(toCharacterFile(saved.card));
          }
          expect(stores.lorebooks.links()).toEqual(links);
          expect(lines.join("\n")).not.toContain("boundary-canary-");
          expect(lines.join("\n")).not.toContain("boundary-key-");
        } finally {
          portrait.mockRestore();
        }
      } finally {
        database.close();
      }
    },
  );

  it.each([
    { label: "content", widened: book({ content }) },
    { label: "key", widened: book({ keys }) },
  ])(
    "refuses widened library $label writes without mutation, then allows reduction and export",
    async ({ widened }) => {
      const database = openUserDatabase(undefined);
      try {
        const stores = createStores(database.db, createMemoryPortraitFiles());
        const { app, lines } = testApp({ instances: sharedStores(stores) });
        const id = stores.lorebooks.create({ name: "Readable", book: book() }, crypto.randomUUID());
        const character = stores.characters.create(blankCard("Linked"));
        stores.lorebooks.link(id, character);
        widened.name = "Readable";
        expect(
          utf8Bytes(JSON.stringify({ format: "ephemera.lorebook", version: 1, data: widened })),
        ).toBeLessThan(CARD_LIMITS.cardJsonBytes);
        database.client
          .query("UPDATE lorebooks SET book = ? WHERE id = ?")
          .run(JSON.stringify(widened), id);
        const original = stores.lorebooks.get(id);
        const links = stores.lorebooks.links();
        const read = await app.request(`/api/lorebooks/${id}`, requestJson("GET"));
        expect(storedLorebookSchema.parse(await read.json())).toEqual(original);
        const patched = await app.request(
          `/api/lorebooks/${id}`,
          requestJson("PATCH", { name: "Unrelated", revision: 0 }),
        );
        expect(patched.status).toBe(400);
        expect(await patched.json()).toEqual({ error: "invalid_request" });
        const duplicated = await app.request(`/api/lorebooks/${id}/duplicate`, requestJson("POST"));
        expect(duplicated.status).toBe(400);
        expect(await duplicated.json()).toEqual({ error: "invalid_request" });
        expect(stores.lorebooks.list()).toHaveLength(1);
        expect(stores.lorebooks.get(id)).toEqual(original);
        expect(stores.lorebooks.links()).toEqual(links);
        const reduced = await app.request(
          `/api/lorebooks/${id}`,
          requestJson("PATCH", { book: book(), revision: 0 }),
        );
        expect(reduced.status).toBe(200);
        expect(await reduced.json()).toMatchObject({ revision: 1 });
        const exported = await app.request(`/api/lorebooks/${id}/export`, requestJson("GET"));
        expect(exported.status).toBe(200);
        expect(await exported.json()).toEqual(toLorebookFile({ ...book(), name: "Readable" }));
        expect(stores.lorebooks.links()).toEqual(links);
        expect(lines.join("\n")).not.toContain("boundary-canary-");
        expect(lines.join("\n")).not.toContain("boundary-key-");
      } finally {
        database.close();
      }
    },
  );

  it("refuses duplicating a widened prompt without inserting and preserves PATCH validation", async () => {
    const database = openUserDatabase(undefined);
    try {
      const stores = createStores(database.db, createMemoryPortraitFiles());
      const { app, lines } = testApp({ instances: sharedStores(stores) });
      const preset = defaultPromptPreset("Readable");
      const id = stores.presets.prompt.create(preset, crypto.randomUUID());
      const count = stores.presets.prompt.list().length;
      const actions = { ...preset.actions, continue: content };
      expect(
        utf8Bytes(
          JSON.stringify({
            format: "ephemera.prompt-preset",
            version: 1,
            data: { ...preset, actions },
          }),
        ),
      ).toBeLessThan(CARD_LIMITS.cardJsonBytes);
      database.client
        .query("UPDATE prompt_presets SET formats = ? WHERE id = ?")
        .run(JSON.stringify(actions), id);
      const original = stores.presets.prompt.get(id);
      const read = await app.request(`/api/presets/prompt/${id}`, requestJson("GET"));
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ preset: original });
      const duplicated = await app.request(
        `/api/presets/prompt/${id}/duplicate`,
        requestJson("POST"),
      );
      expect(duplicated.status).toBe(400);
      expect(await duplicated.json()).toEqual({ error: "invalid_request" });
      const patched = await app.request(
        `/api/presets/prompt/${id}`,
        requestJson("PATCH", { name: "Unrelated", revision: 0 }),
      );
      expect(patched.status).toBe(400);
      expect(await patched.json()).toEqual({ error: "invalid_request" });
      expect(stores.presets.prompt.list()).toHaveLength(count);
      expect(stores.presets.prompt.get(id)).toEqual(original);
      const reduced = await app.request(
        `/api/presets/prompt/${id}`,
        requestJson("PATCH", { actions: preset.actions, revision: 0 }),
      );
      expect(reduced.status).toBe(200);
      const exported = await app.request(`/api/presets/prompt/${id}/export`, requestJson("GET"));
      expect(exported.status).toBe(200);
      expect(await exported.json()).toEqual(toPromptPresetFile(preset));
      expect(lines.join("\n")).not.toContain("boundary-canary-");
    } finally {
      database.close();
    }
  });

  it("exports an exact-boundary prompt, imports it, and handles an oversized readable prompt with 413", async () => {
    const database = openUserDatabase(undefined);
    try {
      const stores = createStores(database.db, createMemoryPortraitFiles());
      const { app } = testApp({ instances: sharedStores(stores) });
      const preset = defaultPromptPreset("Boundary");
      // More than one field is needed to reach the file cap without exceeding a field cap.
      for (let i = 0; i < 32; i++)
        preset.blocks.push({
          kind: "custom",
          id: crypto.randomUUID(),
          name: `Block ${i}`,
          content: "x".repeat(CARD_LIMITS.textLength),
          role: "system",
          enabled: true,
          depth: null,
        });
      const last = preset.blocks.at(-1);
      if (last?.kind !== "custom") throw new Error("Fixture block");
      last.content = "";
      const packet = { format: "ephemera.prompt-preset", version: 1, data: preset };
      last.content = "x".repeat(CARD_LIMITS.cardJsonBytes - utf8Bytes(JSON.stringify(packet)));
      const id = stores.presets.prompt.create(preset, crypto.randomUUID());
      const exported = await app.request(`/api/presets/prompt/${id}/export`, {
        headers: ownerHeaders(),
      });
      expect(exported.status).toBe(200);
      const text = await exported.text();
      expect(utf8Bytes(text)).toBe(CARD_LIMITS.cardJsonBytes);
      expect(
        (
          await app.request(
            "/api/presets/import",
            postJson({
              promptId: crypto.randomUUID(),
              samplerId: crypto.randomUUID(),
              name: "Ignored",
              file: JSON.parse(text),
            }),
          )
        ).status,
      ).toBe(201);
      last.content += "x";
      database.client
        .query("UPDATE prompt_presets SET blocks = ? WHERE id = ?")
        .run(JSON.stringify(preset.blocks), id);
      expect(
        (await app.request(`/api/presets/prompt/${id}`, { headers: ownerHeaders() })).status,
      ).toBe(200);
      expect(
        (await app.request(`/api/presets/prompt/${id}/export`, { headers: ownerHeaders() })).status,
      ).toBe(413);
    } finally {
      database.close();
    }
  });

  it("rolls back both halves of a foreign pair if either validated store write fails", () => {
    const database = openUserDatabase(undefined);
    try {
      const stores = createStores(database.db, createMemoryPortraitFiles());
      const prompt = crypto.randomUUID(),
        sampler = crypto.randomUUID();
      expect(() =>
        stores.presets.createPair(
          defaultPromptPreset(),
          {
            ...defaultSamplerPreset(),
            values: { ...defaultSamplerPreset().values, temperature: 3 },
          },
          { prompt, sampler },
        ),
      ).toThrow();
      expect(stores.presets.prompt.get(prompt)).toBeUndefined();
      expect(stores.presets.sampler.get(sampler)).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
