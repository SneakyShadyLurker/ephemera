import { blankCard, CARD_LIMITS, storedPersonaSchema } from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";
import { personaBindings, personas } from "../src/persistence/schema.ts";
import { ownerHeaders, requestJson, sharedStores, testApp } from "./helpers.ts";

describe("personas API", () => {
  it("refuses duplicating a widened startup description until a valid PATCH reduces it", async () => {
    const legacy = openUserDatabase(undefined);
    const id = crypto.randomUUID();
    const alias = "{{charprompt}}";
    const description = alias.repeat(Math.floor(CARD_LIMITS.textLength / alias.length));
    legacy.db
      .insert(personas)
      .values({
        id,
        name: "Aria",
        description,
        revision: 3,
        createdAt: 11,
        updatedAt: 12,
      })
      .run();
    legacy.client.run("PRAGMA user_version = 0");
    const database = openUserDatabase(legacy.client.serialize());
    legacy.close();
    try {
      const stores = createStores(database.db, createMemoryPortraitFiles());
      const characterId = stores.characters.create(blankCard("Maren"));
      expect(stores.personas.bind(characterId, id)).toBe(true);
      const { app } = testApp({ instances: sharedStores(stores) });
      const read = await app.request(`/api/personas/${id}`, { headers: ownerHeaders() });
      expect(read.status).toBe(200);
      const source = storedPersonaSchema.parse(await read.json());
      expect(source.description).toBe(description.replaceAll(alias, "{{characterSystemPrompt}}"));
      expect(source.description.length).toBeGreaterThan(CARD_LIMITS.textLength);
      expect(source).toMatchObject({
        revision: 4,
        createdAt: 11,
        updatedAt: 12,
        characterIds: [characterId],
      });
      const rows = database.db.select().from(personas).all();
      const bindings = database.db.select().from(personaBindings).all();

      const refused = await app.request(`/api/personas/${id}/duplicate`, requestJson("POST"));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_request" });
      expect(database.db.select().from(personas).all()).toEqual(rows);
      expect(database.db.select().from(personaBindings).all()).toEqual(bindings);
      expect(stores.personas.get(id)).toEqual(source);

      const patched = await app.request(
        `/api/personas/${id}`,
        requestJson("PATCH", { description: "A captain.", revision: source.revision }),
      );
      expect(patched.status).toBe(200);
      const reduced = stores.personas.get(id);
      expect(reduced).toMatchObject({
        description: "A captain.",
        revision: 5,
        characterIds: [characterId],
      });
      const duplicated = await app.request(`/api/personas/${id}/duplicate`, requestJson("POST"));
      expect(duplicated.status).toBe(201);
      const copy = (await duplicated.json()) as { id: string };
      expect(stores.personas.get(copy.id)).toMatchObject({
        name: "Aria (copy)",
        description: "A captain.",
        revision: 0,
        characterIds: [],
      });
      expect(stores.personas.list()).toHaveLength(2);
      expect(stores.personas.get(id)).toEqual(reduced);
      expect(database.db.select().from(personaBindings).all()).toEqual(bindings);
    } finally {
      database.close();
    }
  });

  it("keeps non-validation duplicate faults as server errors", async () => {
    const database = openUserDatabase(undefined);
    try {
      const stores = createStores(database.db, createMemoryPortraitFiles());
      const id = stores.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
      vi.spyOn(stores.personas, "duplicate").mockImplementation(() => {
        throw new Error("duplicate failed");
      });
      const { app } = testApp({ instances: sharedStores(stores) });
      expect((await app.request(`/api/personas/${id}/duplicate`, requestJson("POST"))).status).toBe(
        500,
      );
      expect(stores.personas.list()).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
