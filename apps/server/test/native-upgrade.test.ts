import { Database } from "bun:sqlite";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blankCard,
  blankLorebook,
  CARD_LIMITS,
  defaultPromptPreset,
  EVENT_LIMITS,
  emptyNotebook,
  legacyStoredCharacterCardSchema,
  MEMORY_LIMITS,
  memoryStateSchema,
  newEntry,
  PRESET_LIMITS,
  personaFieldsSchema,
  storedCharacterSchema,
  storedEventSchema,
  storedLorebookSchema,
  storedPersonaSchema,
  storedPromptPresetSchema,
} from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import { usernameSchema } from "../src/identity.ts";
import { createLogger } from "../src/log.ts";
import {
  decryptSnapshot,
  ENCRYPTED_FILE,
  encryptSnapshot,
  writeEncryptedFile,
} from "../src/persistence/encrypted-file.ts";
import {
  createInstanceRegistry,
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
  verifyInstances,
} from "../src/persistence/index.ts";
import { NativeDataError, upgradeNativeData } from "../src/persistence/native-upgrade.ts";
import {
  fileForm,
  formRequest,
  ownerHeaders,
  requestJson,
  samplePortrait,
  sharedStores,
  testApp,
} from "./helpers.ts";

const oldCard = (note = "Long note {{group}}.") => ({
  name: "Maren",
  nickname: "",
  description: "<BOT> keeps the light.",
  personality: "",
  scenario: "",
  first_mes: "{{notchar}} arrives.",
  alternate_greetings: [],
  mes_example: "<START>\n{{char}}: Hello.",
  system_prompt: "{{charprompt}}",
  post_history_instructions: "",
  creator_notes: "Literal {{group}}",
  creator: "",
  character_version: "",
  tags: ["sea"],
  extensions: { depth_prompt: { prompt: note, depth: 7, role: "user" }, unused: { omitted: true } },
  character_book: {
    scan_depth: 4,
    recursive_scanning: true,
    extensions: {},
    entries: [
      {
        keys: ["lantern"],
        content: "{{group}} keeps it.",
        enabled: true,
        insertion_order: 15,
        use_regex: false,
        extensions: { sticky: 3 },
      },
    ],
  },
});

function fixture(note?: string, migrationsFolder?: string) {
  const database = openUserDatabase(undefined, migrationsFolder);
  const stores = createStores(database.db, createMemoryPortraitFiles());
  const character = stores.characters.create(blankCard("Maren"));
  const persona = crypto.randomUUID(),
    event = crypto.randomUUID(),
    unchanged = crypto.randomUUID();
  stores.personas.create({ name: "Aria", description: "{{group}} and <USER>" }, persona);
  stores.personas.create({ name: "Literal", description: "{{char}} stays." }, unchanged);
  stores.personas.bind(character, persona);
  stores.events.create(
    {
      text: "{{charfirstmessage}} {{hasextension::x}}",
      chance: 20,
      cooldown: 2,
      enabled: true,
      scope: { kind: "all" },
    },
    event,
  );
  const lorebook = stores.lorebooks.create(
    { name: "Harbour", book: blankLorebook("Harbour") },
    crypto.randomUUID(),
  );
  stores.lorebooks.link(lorebook, character);
  stores.memory.remember(character, {
    output: {
      title: "Literal {{group}}",
      summary: "Literal {{group}}",
      cues: ["{{group}}"],
      notebook: { ...emptyNotebook(), situation: "Literal {{group}}" },
      opening: "{{groupnotmuted}} meets <USER>",
    },
    turns: 2,
    notebookRevision: 0,
  });
  stores.castSheets.put(character, { fingerprint: "a".repeat(64), entries: [] });
  const prompt = stores.presets.prompt.list()[0];
  if (!prompt) throw new Error("No preset");
  const blocks = defaultPromptPreset()
    .blocks.filter((b) => b.kind !== "custom")
    .map((b) => {
      if (b.kind === "source") {
        const { template: _template, ...rest } = b;
        return rest;
      }
      return b;
    });
  const custom = Array.from({ length: 100 }, (_, i) => ({
    kind: "custom",
    id: crypto.randomUUID(),
    name: `Block ${i}`,
    content: `Kept ${i}: {{group}}`,
    role: "system",
    enabled: true,
    depth: null,
  }));
  database.client
    .query("UPDATE characters SET card = ?, created_at = 11, updated_at = 12 WHERE id = ?")
    .run(JSON.stringify(oldCard(note)), character);
  database.client
    .query("UPDATE lorebooks SET book = ?, created_at = 11, updated_at = 12 WHERE id = ?")
    .run(JSON.stringify(oldCard().character_book), lorebook);
  database.client
    .query(
      "UPDATE prompt_presets SET blocks = ?, formats = ?, authors_note = ?, created_at = 11, updated_at = 12 WHERE id = ?",
    )
    .run(
      JSON.stringify([...blocks, ...custom]),
      JSON.stringify({
        personality: "Fixed instruction {{group}}",
        scenario: "Scene: {{scenario}}",
        persona: "Player: {{persona}}",
        lorebook: "World: {0}",
        newChat: "Begin carefully.",
        newExampleChat: "Study these examples.",
        continueNudge: "Continue {{group}}",
        impersonation: "Write {{notchar}}",
      }),
      JSON.stringify({ ...prompt.authorsNote, text: "{{group}} note" }),
      prompt.id,
    );
  database.client.run("PRAGMA user_version = 0");
  return {
    database,
    stores,
    ids: { character, persona, event, unchanged, lorebook, prompt: prompt.id },
  };
}

describe("transactional native data upgrade", () => {
  it("preserves content and relationships, bumps only changed revisions, fences old tabs and reopens without writes", () => {
    const { database, ids } = fixture();
    const untouched = Object.fromEntries(
      ["persona_bindings", "character_lorebooks", "memories", "cast_sheets", "sampler_presets"].map(
        (table) => [table, database.client.query(`SELECT * FROM ${table}`).all()],
      ),
    );
    const oldNotebook = database.client.query("SELECT * FROM memory_notebooks").get();
    expect(upgradeNativeData(database.client)).toBe(true);
    const stores = createStores(database.db, createMemoryPortraitFiles());
    const card = stores.characters.get(ids.character);
    expect(card).toMatchObject({
      createdAt: 11,
      updatedAt: 12,
      revision: 1,
      card: {
        firstMessage: "{{user}} arrives.",
        // The example dialogue and the system prompt's aliased macro fold in.
        description:
          "{{char}} keeps the light.\n\n<example_dialogue>\n{{char}}: Hello.\n</example_dialogue>\n\n<instructions>\n{{characterSystemPrompt}}\n</instructions>",
        creatorNotes: "Literal {{group}}",
        characterNote: { prompt: "Long note {{char}}.", depth: 7, role: "user" },
        lorebook: { scanDepth: 4, recursiveScanning: true },
      },
    });
    expect(stores.lorebooks.get(ids.lorebook)).toMatchObject({
      revision: 1,
      createdAt: 11,
      updatedAt: 12,
    });
    const prompt = stores.presets.prompt.get(ids.prompt);
    expect(prompt).toMatchObject({
      revision: 1,
      createdAt: 11,
      updatedAt: 12,
      actions: { continue: "Continue {{char}}", writeForMe: "Write {{user}}" },
      authorsNote: { text: "{{char}} note" },
    });
    // The personality and scenario wrappers left with their source blocks.
    expect(prompt?.blocks.filter((b) => b.kind === "custom")).toHaveLength(102);
    for (let i = 0; i < 100; i++)
      expect(prompt?.blocks).toContainEqual(
        expect.objectContaining({ content: `Kept ${i}: {{char}}` }),
      );
    expect(JSON.stringify(prompt?.blocks)).not.toContain("Fixed instruction");
    expect(prompt?.blocks.find((b) => b.id === "scenario")).toBeUndefined();
    expect(stores.personas.get(ids.persona)).toMatchObject({
      revision: 1,
      description: "{{char}} and {{user}}",
    });
    expect(stores.personas.get(ids.unchanged)?.revision).toBe(0);
    expect(stores.events.get(ids.event)).toMatchObject({
      revision: 1,
      text: "{{firstMessage}} false",
    });
    expect(stores.memory.state(ids.character)).toMatchObject({
      revision: 2,
      opening: "{{char}} meets {{user}}",
      notebook: { situation: "Literal {{group}}" },
    });
    expect(database.client.query("SELECT updated_at FROM memory_notebooks").get()).toEqual({
      updated_at: (oldNotebook as { updated_at: number }).updated_at,
    });
    for (const [table, rows] of Object.entries(untouched))
      expect(database.client.query(`SELECT * FROM ${table}`).all()).toEqual(rows);
    expect(stores.personas.update(ids.persona, { description: "Old tab" }, 0).status).toBe(
      "conflict",
    );
    expect(stores.events.update(ids.event, { text: "Old tab" }, 0).status).toBe("conflict");
    expect(stores.memory.setState(ids.character, { opening: "Old tab" }, 1).status).toBe(
      "conflict",
    );
    const reopened = openUserDatabase(database.client.serialize());
    expect(reopened.changes()).toBe(0);
    expect(upgradeNativeData(reopened.client)).toBe(false);
    reopened.close();
    database.close();
  });

  it("removes the obsolete actions SQL default without losing native content or preset references", async () => {
    const migrations = join(import.meta.dirname, "../drizzle");
    const prior = await mkdtemp(join(tmpdir(), "ephemera-actions-migration-"));
    try {
      const journal = JSON.parse(
        await readFile(join(migrations, "meta/_journal.json"), "utf8"),
      ) as {
        entries: { idx: number; tag: string }[];
      };
      journal.entries = journal.entries.filter((entry) => entry.idx < 24);
      await mkdir(join(prior, "meta"));
      await writeFile(join(prior, "meta/_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries)
        await copyFile(join(migrations, `${entry.tag}.sql`), join(prior, `${entry.tag}.sql`));
      const { database, ids } = fixture(undefined, prior);
      // Written as SQL: today's settings store names columns later migrations add.
      database.client
        .query(
          "INSERT INTO settings (id, theme, prompt_preset_id, updated_at) VALUES (1, 'system', ?, 1)",
        )
        .run(ids.prompt);
      upgradeNativeData(database.client);
      const prompt = database.client
        .query("SELECT * FROM prompt_presets WHERE id = ?")
        .get(ids.prompt);
      // Migration 0027 drops the character override columns.
      const settings = database.client
        .query<Record<string, unknown>, []>("SELECT * FROM settings")
        .all()
        .map(
          ({
            prefer_character_prompt: _prompt,
            prefer_character_instructions: _instructions,
            ...rest
          }) => rest,
        );
      const reopened = openUserDatabase(database.client.serialize());
      try {
        expect(
          reopened.client.query("SELECT * FROM prompt_presets WHERE id = ?").get(ids.prompt),
        ).toEqual(prompt);
        // Later migrations may add settings columns; the ones the row had stay as they were.
        expect(reopened.client.query("SELECT * FROM settings").all()).toMatchObject(settings);
        expect(reopened.client.query("PRAGMA foreign_key_check").all()).toEqual([]);
        const columns = reopened.client
          .query<{ name: string; dflt_value: string | null }, []>(
            "PRAGMA table_info(prompt_presets)",
          )
          .all();
        expect(columns.find((column) => column.name === "formats")?.dflt_value).toBeNull();
        const native = createStores(reopened.db, createMemoryPortraitFiles()).presets.prompt.get(
          ids.prompt,
        );
        expect(native?.blocks.filter((block) => block.kind === "custom")).toHaveLength(102);
        expect(native?.actions).toEqual({
          continue: "Continue {{char}}",
          writeForMe: "Write {{user}}",
        });
      } finally {
        reopened.close();
        database.close();
      }
    } finally {
      await rm(prior, { recursive: true, force: true });
    }
  });

  it("rolls back every conversion and the version on failure, then can retry", () => {
    const { database, ids } = fixture();
    database.client.query("UPDATE prompt_presets SET blocks = 'null' WHERE id = ?").run(ids.prompt);
    const before = database.client.query("SELECT card, revision FROM characters").all();
    expect(() => upgradeNativeData(database.client)).toThrow(NativeDataError);
    expect(database.client.query("SELECT card, revision FROM characters").all()).toEqual(before);
    expect(database.client.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(
      database.client
        .query("SELECT description, revision FROM personas WHERE id = ?")
        .get(ids.persona),
    ).toEqual({ description: "{{group}} and <USER>", revision: 0 });
    database.client
      .query("UPDATE prompt_presets SET blocks = ? WHERE id = ?")
      .run(JSON.stringify(defaultPromptPreset().blocks), ids.prompt);
    expect(upgradeNativeData(database.client)).toBe(true);
    database.close();
  });

  it("counts a version-only upgrade dirty and refuses future versions", () => {
    const first = openUserDatabase(undefined);
    first.client.run("PRAGMA user_version = 0");
    const opened = openUserDatabase(first.client.serialize());
    expect(opened.client.query("SELECT total_changes() AS changes").get()).toEqual({ changes: 0 });
    expect(opened.changes()).toBe(1);
    opened.client.run("PRAGMA user_version = 3");
    expect(() => openUserDatabase(opened.client.serialize())).toThrow(NativeDataError);
    first.close();
    opened.close();
  });

  it("keeps an oversized legacy row and its long note readable, refuses both exports, and permits reduction", async () => {
    const note = "x".repeat(CARD_LIMITS.cardJsonBytes + 1);
    const { database, ids } = fixture(note);
    const opened = openUserDatabase(database.client.serialize());
    const stores = createStores(opened.db, createMemoryPortraitFiles());
    const { app } = testApp({ instances: sharedStores(stores) });
    const response = await app.request(`/api/characters/${ids.character}`, {
      headers: ownerHeaders(),
    });
    expect(response.status).toBe(200);
    expect(storedCharacterSchema.parse(await response.json()).card.characterNote?.prompt).toBe(
      note,
    );
    for (const extension of ["json", "png"])
      expect(
        (
          await app.request(`/api/characters/${ids.character}/export.${extension}`, {
            headers: ownerHeaders(),
          })
        ).status,
      ).toBe(413);
    expect(
      (
        await app.request(
          `/api/characters/${ids.character}`,
          requestJson("PATCH", {
            characterNote: { prompt: "Reduced", depth: 7, role: "user" },
            revision: 1,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/characters/${ids.character}/export.json`, {
          headers: ownerHeaders(),
        })
      ).status,
    ).toBe(200);
    opened.close();
    database.close();
  });
});

describe("durable startup upgrade", () => {
  const key = Buffer.alloc(32, 4),
    username = usernameSchema.parse("alice"),
    log = createLogger(() => {});
  it("keeps former-bound text readable through encrypted startup and restart, then permits bounded reductions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ephemera-native-bounds-"));
    const { database, stores: legacyStores, ids } = fixture();
    const oldText = `<BOT>${"x".repeat(CARD_LIMITS.textLength - 5)}`;
    const converted = `{{char}}${oldText.slice(5)}`;
    const oldPersona = `<USER>${"p".repeat(CARD_LIMITS.textLength - 6)}`;
    const oldOpening = `<USER>${"o".repeat(MEMORY_LIMITS.opening - 6)}`;
    const oldEvent = `<BOT>${"e".repeat(EVENT_LIMITS.text - 5)}`;
    const oldTemplate = `{0}${"t".repeat(PRESET_LIMITS.blockText - 3)}`;
    const noOp = crypto.randomUUID();
    const scope = { kind: "selected" as const, characters: [ids.character], tags: ["sea"] };
    legacyStores.events.create(
      { text: "{{chatstart}}", enabled: true, chance: 12.5, cooldown: 7, scope },
      noOp,
    );
    const card = {
      ...oldCard(oldText),
      description: oldText,
      personality: oldText,
      scenario: oldText,
      first_mes: oldText,
      alternate_greetings: [oldText],
      mes_example: oldText,
      system_prompt: oldText,
      post_history_instructions: oldText,
    };
    const book = {
      ...card.character_book,
      entries: card.character_book.entries.map((entry) => ({ ...entry, content: oldText })),
    };
    database.client
      .query("UPDATE characters SET card = ? WHERE id = ?")
      .run(JSON.stringify({ ...card, character_book: book }), ids.character);
    database.client
      .query("UPDATE lorebooks SET book = ? WHERE id = ?")
      .run(JSON.stringify(book), ids.lorebook);
    database.client
      .query("UPDATE personas SET description = ?, created_at = 11, updated_at = 12 WHERE id = ?")
      .run(oldPersona, ids.persona);
    database.client
      .query("UPDATE memory_notebooks SET opening = ?, updated_at = 12 WHERE character_id = ?")
      .run(oldOpening, ids.character);
    database.client.query("UPDATE events SET text = ? WHERE id = ?").run(oldEvent, ids.event);
    database.client.run("UPDATE events SET created_at = 11, updated_at = 12");
    const preset = defaultPromptPreset();
    database.client
      .query("UPDATE prompt_presets SET blocks = ?, formats = ?, authors_note = ? WHERE id = ?")
      .run(
        JSON.stringify(
          preset.blocks.map((block) =>
            block.kind === "text" || block.kind === "custom"
              ? { ...block, content: oldText }
              : block,
          ),
        ),
        JSON.stringify({
          personality: oldText,
          lorebook: oldTemplate,
          continueNudge: oldText,
          impersonation: oldText,
        }),
        JSON.stringify({ ...preset.authorsNote, text: oldText }),
        ids.prompt,
      );
    const file = join(dir, "users", username, ENCRYPTED_FILE);
    const encryption = { key, username };
    try {
      await mkdir(join(dir, "users", username), { recursive: true });
      await writeEncryptedFile(file, encryptSnapshot(database.client.serialize(), encryption));
      const write = vi.fn(writeEncryptedFile);
      expect(await verifyInstances({ dataDir: dir, key, log, write })).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);
      const durable = await readFile(file);
      expect(durable.includes(Buffer.from(converted))).toBe(false);
      const opened = openUserDatabase(decryptSnapshot(durable, encryption));
      try {
        const stores = createStores(opened.db, createMemoryPortraitFiles());
        const storedCard = storedCharacterSchema.parse(stores.characters.get(ids.character));
        expect(storedCard).toMatchObject({ revision: 1, createdAt: 11, updatedAt: 12 });
        // Folded past the field bound, and kept whole.
        expect(storedCard.card.description).toBe(
          [
            converted,
            `<scenario>\n${converted}\n</scenario>`,
            `<personality>\n${converted}\n</personality>`,
            `<example_dialogue>\n${converted}\n</example_dialogue>`,
            `<instructions>\n${converted}\n\n${converted}\n</instructions>`,
          ].join("\n\n"),
        );
        expect(storedCard.card.firstMessage).toBe(converted);
        expect(storedCard.card.alternateGreetings).toEqual([converted]);
        expect(storedCard.card.characterNote?.prompt).toBe(converted);
        expect(storedCard.card.lorebook?.entries[0]?.content).toBe(converted);
        const storedBook = storedLorebookSchema.parse(stores.lorebooks.get(ids.lorebook));
        expect(storedBook).toMatchObject({ revision: 1, createdAt: 11, updatedAt: 12 });
        expect(storedBook.book.entries[0]?.content).toBe(converted);
        const storedPrompt = storedPromptPresetSchema.parse(stores.presets.prompt.get(ids.prompt));
        expect(storedPrompt).toMatchObject({ revision: 1, createdAt: 11, updatedAt: 12 });
        for (const block of storedPrompt.blocks) {
          if (block.kind === "text" || block.kind === "custom")
            expect(block.content).toBe(converted);
          if (block.kind === "source" && ["lorebookBefore", "lorebookAfter"].includes(block.id))
            expect(block.template).toBe(`{{content}}${oldTemplate.slice(3)}`);
        }
        expect(storedPrompt.actions).toEqual({ continue: converted, writeForMe: converted });
        expect(storedPrompt.authorsNote.text).toBe(converted);
        expect(storedPersonaSchema.parse(stores.personas.get(ids.persona))).toMatchObject({
          description: `{{user}}${oldPersona.slice(6)}`,
          revision: 1,
          createdAt: 11,
          updatedAt: 12,
        });
        expect(
          personaFieldsSchema.safeParse({
            name: "Aria",
            description: `{{user}}${oldPersona.slice(6)}`,
          }).success,
        ).toBe(false);
        expect(storedEventSchema.parse(stores.events.get(ids.event))).toMatchObject({
          text: `{{char}}${oldEvent.slice(5)}`,
          revision: 1,
          createdAt: 11,
          updatedAt: 12,
        });
        expect(storedEventSchema.parse(stores.events.get(noOp))).toEqual({
          id: noOp,
          text: "",
          enabled: false,
          chance: 12.5,
          cooldown: 7,
          scope,
          revision: 1,
          createdAt: 11,
          updatedAt: 12,
        });
        expect(memoryStateSchema.parse(stores.memory.state(ids.character))).toMatchObject({
          opening: `{{user}}${oldOpening.slice(6)}`,
          revision: 2,
          updatedAt: 12,
        });
        expect(stores.personas.get(ids.unchanged)?.revision).toBe(0);
        expect(opened.changes()).toBe(0);
        expect(upgradeNativeData(opened.client)).toBe(false);
        write.mockClear();
        expect(await verifyInstances({ dataDir: dir, key, log, write })).toBe(1);
        expect(write).not.toHaveBeenCalled();
        expect(await readFile(file)).toEqual(durable);

        expect(() => stores.events.update(noOp, { enabled: true }, 1)).toThrow();
        expect(storedEventSchema.parse(stores.events.get(noOp))).toMatchObject({
          text: "",
          enabled: false,
          revision: 1,
          updatedAt: 12,
        });

        const reducedBook = {
          ...storedBook.book,
          entries: storedBook.book.entries.map((entry) => ({ ...entry, content: "Reduced" })),
        };
        expect(
          stores.characters.update(
            ids.character,
            {
              description: "Reduced",
              firstMessage: "Reduced",
              alternateGreetings: ["Reduced"],
              characterNote: { prompt: "Reduced", depth: 7, role: "user" },
              lorebook: reducedBook,
            },
            1,
          ).status,
        ).toBe("updated");
        expect(stores.lorebooks.update(ids.lorebook, { book: reducedBook }, 1).status).toBe(
          "updated",
        );
        expect(
          stores.presets.prompt.update(
            ids.prompt,
            {
              blocks: storedPrompt.blocks.map((block) =>
                block.kind === "text" || block.kind === "custom"
                  ? { ...block, content: "Reduced" }
                  : block.kind === "source" && block.template !== undefined
                    ? { ...block, template: "{{content}}" }
                    : block,
              ),
              actions: { continue: "Reduced", writeForMe: "Reduced" },
              authorsNote: { ...storedPrompt.authorsNote, text: "Reduced" },
            },
            1,
          ).status,
        ).toBe("updated");
        expect(stores.personas.update(ids.persona, { description: "Reduced" }, 1).status).toBe(
          "updated",
        );
        expect(stores.events.update(ids.event, { text: "Reduced" }, 1).status).toBe("updated");
        expect(stores.events.update(noOp, { text: "Restored", enabled: true }, 1).status).toBe(
          "updated",
        );
        expect(stores.memory.setState(ids.character, { opening: "Reduced" }, 2).status).toBe(
          "updated",
        );
        const reduced = openUserDatabase(opened.client.serialize());
        try {
          const again = createStores(reduced.db, createMemoryPortraitFiles());
          expect(storedCharacterSchema.parse(again.characters.get(ids.character)).revision).toBe(2);
          expect(storedLorebookSchema.parse(again.lorebooks.get(ids.lorebook)).revision).toBe(2);
          expect(
            storedPromptPresetSchema.parse(again.presets.prompt.get(ids.prompt)).revision,
          ).toBe(2);
          expect(storedPersonaSchema.parse(again.personas.get(ids.persona)).description).toBe(
            "Reduced",
          );
          expect(storedEventSchema.parse(again.events.get(noOp))).toMatchObject({
            text: "Restored",
            enabled: true,
            revision: 2,
          });
          expect(memoryStateSchema.parse(again.memory.state(ids.character))).toMatchObject({
            opening: "Reduced",
            revision: 3,
          });
          expect(reduced.changes()).toBe(0);
        } finally {
          reduced.close();
        }
      } finally {
        opened.close();
      }
    } finally {
      database.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
  it("writes encrypted upgrades before verification resolves and a restart with no request writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ephemera-native-"));
    try {
      const registry = createInstanceRegistry({ dataDir: dir, key, log });
      const instance = registry.instance(username);
      const id = instance.stores.characters.create(blankCard("Maren"), await samplePortrait());
      await registry.close();
      const file = join(dir, "users", username, ENCRYPTED_FILE);
      const scope = { key, username };
      const before = await readFile(file);
      const raw = Database.deserialize(decryptSnapshot(before, scope));
      const portraits = raw.query("SELECT * FROM portraits").all();
      raw.query("UPDATE characters SET card = ? WHERE id = ?").run(JSON.stringify(oldCard()), id);
      raw.run("PRAGMA user_version = 0");
      await writeEncryptedFile(file, encryptSnapshot(raw.serialize(), scope));
      raw.close();
      const write = vi.fn(writeEncryptedFile);
      expect(await verifyInstances({ dataDir: dir, key, log, write })).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);
      const durable = await readFile(file);
      expect(durable.includes(Buffer.from("keeps the light"))).toBe(false);
      const reopened = openUserDatabase(decryptSnapshot(durable, scope));
      expect(reopened.changes()).toBe(0);
      expect(reopened.client.query("SELECT * FROM portraits").all()).toEqual(portraits);
      expect(
        createStores(reopened.db, createMemoryPortraitFiles()).characters.get(id),
      ).toMatchObject({ revision: 1, card: { firstMessage: "{{user}} arrives." } });
      reopened.close();
      // A second startup, with no lazy registry request between the two.
      write.mockClear();
      expect(await verifyInstances({ dataDir: dir, key, log, write })).toBe(1);
      expect(write).not.toHaveBeenCalled();
      expect(await readFile(file)).toEqual(durable);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a failed startup write without replacing the image, then retries only unfinished users", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ephemera-native-failure-"));
    try {
      const first = openUserDatabase(undefined);
      first.client.run("PRAGMA user_version = 0");
      for (const name of ["alice", "bob"]) {
        await mkdir(join(dir, "users", name), { recursive: true });
        await writeEncryptedFile(
          join(dir, "users", name, ENCRYPTED_FILE),
          encryptSnapshot(first.client.serialize(), { key, username: name }),
        );
      }
      first.close();
      const paths: string[] = [];
      let failedFile = "",
        unchanged: Buffer | undefined;
      await expect(
        verifyInstances({
          dataDir: dir,
          key,
          log,
          write: async (path, bytes) => {
            paths.push(path);
            if (paths.length === 2) {
              failedFile = path;
              unchanged = await readFile(path);
              throw new Error("Injected write failure");
            }
            await writeEncryptedFile(path, bytes);
          },
        }),
      ).rejects.toThrow("Injected write failure");
      expect(paths).toHaveLength(2);
      expect(await readFile(failedFile)).toEqual(unchanged);
      const write = vi.fn(writeEncryptedFile);
      expect(await verifyInstances({ dataDir: dir, key, log, write })).toBe(2);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]?.[0]).toBe(failedFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A version-1 card row: the current card plus the five removed fields. */
const versionOneCard = (name: string, fields: Record<string, string> = {}) =>
  JSON.stringify(
    legacyStoredCharacterCardSchema.parse({
      ...blankCard(name),
      description: "{{char}} keeps the {{personality}}light.",
      personality: "",
      scenario: "",
      exampleDialogue: "",
      systemPrompt: "",
      postHistoryInstructions: "",
      ...fields,
    }),
  );

/** A database at native version 1 holding data from before the card fields left. */
function versionOne() {
  const database = openUserDatabase(undefined);
  const stores = createStores(database.db, createMemoryPortraitFiles());
  const legacy = stores.characters.create(blankCard("Maren"));
  const empty = stores.characters.create(blankCard("Ilse"));
  const current = stores.characters.create({ ...blankCard("Tove"), description: "Plain." });
  const persona = crypto.randomUUID(),
    unchanged = crypto.randomUUID(),
    event = crypto.randomUUID();
  stores.personas.create({ name: "Aria", description: "{{original}}Aria rows." }, persona);
  stores.personas.create({ name: "Literal", description: "{{char}} stays." }, unchanged);
  stores.events.create(
    {
      text: "{{personality}}A bell rings.",
      chance: 20,
      cooldown: 2,
      enabled: true,
      scope: { kind: "all" },
    },
    event,
  );
  const lorebook = stores.lorebooks.create(
    { name: "Harbour", book: blankLorebook("Harbour") },
    crypto.randomUUID(),
  );
  stores.memory.remember(legacy, {
    output: {
      title: "Literal {{scenario}}",
      summary: "Literal {{scenario}}",
      cues: ["dusk"],
      notebook: emptyNotebook(),
      opening: "{{scenario}}At dusk.",
    },
    turns: 2,
    notebookRevision: 0,
  });
  const prompt = stores.presets.prompt.list()[0];
  if (!prompt) throw new Error("No preset");
  const blocks = prompt.blocks.flatMap((block): Record<string, unknown>[] =>
    block.kind === "source" && block.id === "charDescription"
      ? [
          { ...block, forbidOverrides: true },
          { kind: "source", id: "charPersonality", enabled: true, forbidOverrides: true },
          { kind: "source", id: "scenario", enabled: true, template: "Scene: {{content}}" },
        ]
      : [block],
  );
  blocks.push({
    kind: "custom",
    id: crypto.randomUUID(),
    name: "Mind",
    content: "Mind {{personality}}and {{char}}.",
    role: "system",
    enabled: true,
    depth: null,
  });
  const entry = {
    ...newEntry([]),
    keys: ["lantern{{original}}"],
    content: "{{scenario}}By the sea.",
  };
  const run = (sql: string, ...values: (string | number)[]) =>
    database.client.query(sql).run(...values);
  run(
    "UPDATE characters SET card = ? WHERE id = ?",
    versionOneCard("Maren", {
      personality: "Calm {{scenario}}keeper.",
      scenario: "A lighthouse.",
      exampleDialogue: "{{char}}: Hello.",
      systemPrompt: "Stay terse{{original}}.",
    }),
    legacy,
  );
  run(
    "UPDATE characters SET card = ? WHERE id = ?",
    versionOneCard("Ilse", { description: "Quiet." }),
    empty,
  );
  run(
    "UPDATE lorebooks SET book = ? WHERE id = ?",
    JSON.stringify({ ...blankLorebook("Harbour"), entries: [entry] }),
    lorebook,
  );
  run(
    "UPDATE prompt_presets SET blocks = ?, formats = ?, authors_note = ? WHERE id = ?",
    JSON.stringify(blocks),
    JSON.stringify({ continue: "Continue {{original}}softly.", writeForMe: "Write." }),
    JSON.stringify({ ...prompt.authorsNote, text: "Note {{scenario}}here." }),
    prompt.id,
  );
  database.client.run("PRAGMA user_version = 1");
  return {
    database,
    ids: { legacy, empty, current, persona, unchanged, event, lorebook, prompt: prompt.id },
  };
}

const LEGACY_DESCRIPTION = [
  "{{char}} keeps the {{personality}}light.",
  "<scenario>\nA lighthouse.\n</scenario>",
  "<personality>\nCalm {{scenario}}keeper.\n</personality>",
  "<example_dialogue>\n{{char}}: Hello.\n</example_dialogue>",
  "<instructions>\nStay terse{{original}}.\n</instructions>",
].join("\n\n");

const REMOVED_KEYS = [
  "personality",
  "scenario",
  "exampleDialogue",
  "systemPrompt",
  "postHistoryInstructions",
];

describe("native data version 1 to 2", () => {
  it("folds cards and retires preset blocks, keeping macro text as written and bumping only changed rows, then writes nothing", () => {
    const { database, ids } = versionOne();
    expect(upgradeNativeData(database.client)).toBe(true);
    expect(database.client.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    const rows = database.client
      .query<{ id: string; card: string; name: string; tags: string; revision: number }, []>(
        "SELECT id, card, name, tags, revision FROM characters",
      )
      .all();
    const row = (id: string) => {
      const found = rows.find((candidate) => candidate.id === id);
      if (!found) throw new Error("No row");
      return { ...found, card: JSON.parse(found.card) as Record<string, unknown> };
    };
    const legacy = row(ids.legacy);
    expect(legacy.revision).toBe(1);
    expect(legacy.card.description).toBe(LEGACY_DESCRIPTION);
    expect(legacy.name).toBe(legacy.card.name);
    expect(JSON.parse(legacy.tags)).toEqual(legacy.card.tags);
    // Every version-1 card held the five keys, so even one with none of their text is written once.
    const empty = row(ids.empty);
    expect(empty.revision).toBe(1);
    expect(empty.card.description).toBe("Quiet.");
    for (const key of REMOVED_KEYS) {
      expect(legacy.card).not.toHaveProperty(key);
      expect(empty.card).not.toHaveProperty(key);
    }
    expect(row(ids.current)).toMatchObject({ revision: 0, card: { description: "Plain." } });

    const stores = createStores(database.db, createMemoryPortraitFiles());
    const prompt = stores.presets.prompt.get(ids.prompt);
    expect(prompt?.revision).toBe(1);
    expect(prompt?.blocks.map((block) => block.id)).not.toContain("charPersonality");
    expect(prompt?.blocks.map((block) => block.id)).not.toContain("scenario");
    expect(JSON.stringify(prompt?.blocks)).not.toContain("forbidOverrides");
    expect(prompt?.blocks).toContainEqual(
      expect.objectContaining({ name: "Mind", content: "Mind {{personality}}and {{char}}." }),
    );
    expect(prompt?.actions).toEqual({
      continue: "Continue {{original}}softly.",
      writeForMe: "Write.",
    });
    expect(prompt?.authorsNote.text).toBe("Note {{scenario}}here.");
    // Rows whose only old data is a removed macro stay as they were: the engine resolves it empty.
    expect(stores.lorebooks.get(ids.lorebook)).toMatchObject({
      revision: 0,
      book: { entries: [{ keys: ["lantern{{original}}"], content: "{{scenario}}By the sea." }] },
    });
    expect(stores.personas.get(ids.persona)).toMatchObject({
      revision: 0,
      description: "{{original}}Aria rows.",
    });
    expect(stores.personas.get(ids.unchanged)?.revision).toBe(0);
    expect(stores.events.get(ids.event)).toMatchObject({
      revision: 0,
      text: "{{personality}}A bell rings.",
      enabled: true,
    });
    expect(stores.memory.state(ids.legacy)).toMatchObject({
      revision: 1,
      opening: "{{scenario}}At dusk.",
    });

    expect(upgradeNativeData(database.client)).toBe(false);
    const reopened = openUserDatabase(database.client.serialize());
    expect(reopened.changes()).toBe(0);
    reopened.close();
    database.close();
  });

  it("rolls back every table and the version when a preset fails, then retries", () => {
    const { database, ids } = versionOne();
    const tables = ["characters", "lorebooks", "personas", "events", "memory_notebooks"];
    const before = tables.map((table) => database.client.query(`SELECT * FROM ${table}`).all());
    database.client.query("UPDATE prompt_presets SET blocks = 'null' WHERE id = ?").run(ids.prompt);
    expect(() => upgradeNativeData(database.client)).toThrow(NativeDataError);
    expect(tables.map((table) => database.client.query(`SELECT * FROM ${table}`).all())).toEqual(
      before,
    );
    expect(database.client.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    database.client
      .query("UPDATE prompt_presets SET blocks = ? WHERE id = ?")
      .run(JSON.stringify(defaultPromptPreset().blocks), ids.prompt);
    expect(upgradeNativeData(database.client)).toBe(true);
    expect(database.client.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    database.close();
  });

  it("upgrades a version-0 database through both steps", () => {
    const { database, ids } = fixture();
    database.client
      .query("UPDATE events SET text = ? WHERE id = ?")
      .run("<BOT> {{personality}}waves.", ids.event);
    expect(upgradeNativeData(database.client)).toBe(true);
    expect(database.client.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    const stores = createStores(database.db, createMemoryPortraitFiles());
    const card = stores.characters.get(ids.character);
    expect(card?.revision).toBe(1);
    for (const key of REMOVED_KEYS) expect(card?.card).not.toHaveProperty(key);
    expect(stores.events.get(ids.event)).toMatchObject({
      revision: 1,
      text: "{{char}} {{personality}}waves.",
    });
    expect(upgradeNativeData(database.client)).toBe(false);
    database.close();
  });

  it("stores a folded description past the field bound whole, and saves a reduction", async () => {
    const long = "x".repeat(CARD_LIMITS.textLength - 10);
    const { database, ids } = versionOne();
    database.client
      .query("UPDATE characters SET card = ? WHERE id = ?")
      .run(
        versionOneCard("Maren", { description: long, personality: long, scenario: long }),
        ids.legacy,
      );
    const opened = openUserDatabase(database.client.serialize());
    const stores = createStores(opened.db, createMemoryPortraitFiles());
    const { app } = testApp({ instances: sharedStores(stores) });
    const response = await app.request(`/api/characters/${ids.legacy}`, {
      headers: ownerHeaders(),
    });
    expect(response.status).toBe(200);
    const stored = storedCharacterSchema.parse(await response.json());
    expect(stored.revision).toBe(1);
    expect(stored.card.description).toBe(
      [long, `<scenario>\n${long}\n</scenario>`, `<personality>\n${long}\n</personality>`].join(
        "\n\n",
      ),
    );
    expect(
      (
        await app.request(
          `/api/characters/${ids.legacy}`,
          requestJson("PATCH", { description: "Reduced", revision: 1 }),
        )
      ).status,
    ).toBe(200);
    expect(stores.characters.get(ids.legacy)).toMatchObject({
      revision: 2,
      card: { description: "Reduced" },
    });
    opened.close();
    database.close();
  });

  it("stores a lorebook file exported before the change with the removed macros as written", async () => {
    const database = openUserDatabase(undefined);
    expect(database.client.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    const stores = createStores(database.db, createMemoryPortraitFiles());
    const { app } = testApp({ instances: sharedStores(stores) });
    const file = {
      format: "ephemera.lorebook",
      version: 1,
      data: {
        ...blankLorebook("Harbour"),
        entries: [
          {
            ...newEntry([]),
            keys: ["lantern{{original}}"],
            secondaryKeys: ["{{Scenario }}tide"],
            content: "{{personality}}By the sea {{char}}.",
          },
        ],
      },
    };
    const response = await app.request(
      "/api/lorebooks/import",
      formRequest("POST", fileForm(JSON.stringify(file), "Harbour.json")),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(stores.lorebooks.get(id)?.book.entries[0]).toMatchObject({
      keys: ["lantern{{original}}"],
      secondaryKeys: ["{{Scenario }}tide"],
      content: "{{personality}}By the sea {{char}}.",
    });
    database.close();
  });

  it("writes an encrypted version-1 file once at startup and nothing on restart", async () => {
    const key = Buffer.alloc(32, 5),
      username = usernameSchema.parse("alice"),
      log = createLogger(() => {});
    const dir = await mkdtemp(join(tmpdir(), "ephemera-native-two-"));
    const { database, ids } = versionOne();
    const file = join(dir, "users", username, ENCRYPTED_FILE);
    const scope = { key, username };
    try {
      await mkdir(join(dir, "users", username), { recursive: true });
      await writeEncryptedFile(file, encryptSnapshot(database.client.serialize(), scope));
      const write = vi.fn(writeEncryptedFile);
      expect(await verifyInstances({ dataDir: dir, key, log, write })).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);
      const durable = await readFile(file);
      const opened = openUserDatabase(decryptSnapshot(durable, scope));
      try {
        expect(opened.changes()).toBe(0);
        const stores = createStores(opened.db, createMemoryPortraitFiles());
        expect(stores.characters.get(ids.legacy)).toMatchObject({
          revision: 1,
          card: { description: LEGACY_DESCRIPTION },
        });
        const prompt = stores.presets.prompt.get(ids.prompt);
        expect(prompt?.revision).toBe(1);
        expect(JSON.stringify(prompt?.blocks)).not.toMatch(/forbidOverrides|charPersonality/);
      } finally {
        opened.close();
      }
      write.mockClear();
      expect(await verifyInstances({ dataDir: dir, key, log, write })).toBe(1);
      expect(write).not.toHaveBeenCalled();
      expect(await readFile(file)).toEqual(durable);
    } finally {
      database.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
