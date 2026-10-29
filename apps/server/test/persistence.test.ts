import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blankCard,
  blankLorebook,
  type CharacterCard,
  DEFAULT_AUTHORS_NOTE,
  DEFAULT_PROMPT_ACTIONS,
  DEFAULT_PROMPT_REASONING,
  defaultPromptPreset,
  defaultSamplerPreset,
  normalizeCard,
  promptPresetSchema,
  samplerPresetSchema,
  settingsSchema,
  summarizeLorebook,
  upgradeLegacyLorebook,
} from "@ephemera/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usernameSchema } from "../src/identity.ts";
import { createLogger } from "../src/log.ts";
import { migrateDatabase } from "../src/persistence/db.ts";
import {
  type CharacterStore,
  createCharacterStore,
  createInstanceRegistry,
  createMemoryPortraitFiles,
  createPersonaStore,
  createStores,
  ENCRYPTED_FILE,
  openUserDatabase,
  type Portrait,
  type PortraitFiles,
  prepareDataDirectory,
} from "../src/persistence/index.ts";
import { referencedFiles } from "../src/persistence/portraits.ts";
import { settings as settingsTable } from "../src/persistence/schema.ts";
import { samplePortrait } from "./helpers.ts";

// Historical database input, never a runtime preset contract.
const LEGACY_FORMATS = {
  personality: "{{personality}}",
  scenario: "{{scenario}}",
  newChat: "[Start a new Chat]",
  newExampleChat: "[Example Chat]",
  continueNudge: DEFAULT_PROMPT_ACTIONS.continue,
  impersonation: DEFAULT_PROMPT_ACTIONS.writeForMe,
  continuePostfix: " ",
  lorebook: "{0}",
};

// Build a historical image with only its contemporary SQL migrations.
function historicalDatabase(migrationsFolder: string) {
  const client = new Database(":memory:", { strict: true });
  const db = migrateDatabase(client, migrationsFolder);
  return { client, db, close: () => client.close(true) };
}

function card(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return { ...blankCard("Seraphina"), tags: ["fantasy"], ...overrides };
}

describe("database", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ephemera-db-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the data directory owner-only, even when it already existed", () => {
    const dataDir = join(dir, "loose");
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    prepareDataDirectory(dataDir);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it("repairs an owner-only data directory that lacks the owner's write access", () => {
    const dataDir = join(dir, "strict");
    mkdirSync(dataDir, { mode: 0o700 });
    chmodSync(dataDir, 0o500);
    prepareDataDirectory(dataDir);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it("migrates a new database once and reopens its image without changes", () => {
    const first = openUserDatabase(undefined);
    const id = createCharacterStore(first.db, createMemoryPortraitFiles()).create(card());
    const image = first.client.serialize();
    first.close();

    const second = openUserDatabase(image);
    expect(second.changes()).toBe(0);
    expect(createCharacterStore(second.db, createMemoryPortraitFiles()).get(id)?.card.name).toBe(
      "Seraphina",
    );
    const tables = second.client
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    expect(tables).toEqual([
      { name: "__drizzle_migrations" },
      { name: "cast_sheets" },
      { name: "character_lorebooks" },
      { name: "characters" },
      { name: "custom_palettes" },
      { name: "events" },
      { name: "lorebooks" },
      { name: "memories" },
      { name: "memory_notebooks" },
      { name: "persona_bindings" },
      { name: "personas" },
      { name: "portraits" },
      { name: "prompt_presets" },
      { name: "sampler_presets" },
      { name: "settings" },
      { name: "workflows" },
    ]);
    second.close();
  });

  it("upgrades an M3 database, and refuses one whose portrait never left its row", async () => {
    // An M3 database: only the first migration applied, one character.
    const migrations = join(dir, "m3-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    await copyFile(join(source, "0000_characters.sql"), join(migrations, "0000_characters.sql"));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, 1);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const id = crypto.randomUUID();
    old
      .query(
        "INSERT INTO characters (id, name, nickname, creator, tags, card, created_at, updated_at) VALUES (?, 'Wren', '', '', '[]', ?, 1, 1)",
      )
      .run(id, JSON.stringify(card({ name: "Wren" })));
    const upgraded = openUserDatabase(old.serialize());
    expect(createCharacterStore(upgraded.db, createMemoryPortraitFiles()).get(id)).toMatchObject({
      card: { name: "Wren" },
      portrait: null,
    });
    // The rebuilt table enforces one owner per portrait.
    expect(() =>
      upgraded.client
        .query(
          "INSERT INTO portraits (thumb, width, height, version, file) VALUES (x'00', 1, 1, 1, 'f')",
        )
        .run(),
    ).toThrow();
    upgraded.close();

    // A PNG still in its row has no portrait file to name: the upgrade stops rather than drop it.
    const image = await samplePortrait();
    old
      .query(
        "INSERT INTO portraits (character_id, png, thumb, width, height, version) VALUES (?, ?, ?, 20, 30, 7)",
      )
      .run(id, image.png, image.thumb);
    expect(() => openUserDatabase(old.serialize())).toThrow();
    old.close();
  });

  it("upgrades an M4 database: sampler presets lose the context size, prompt presets gain wrappers", async () => {
    // An M4 database: the first two migrations applied, presets as M4 wrote them.
    const migrations = join(dir, "m4-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    for (const file of ["0000_characters.sql", "0001_personas_presets_settings.sql"]) {
      await copyFile(join(source, file), join(migrations, file));
    }
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, 2);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const sampler = crypto.randomUUID();
    const prompt = crypto.randomUUID();
    const { values } = defaultSamplerPreset();
    old
      .query(
        "INSERT INTO sampler_presets (id, name, sampler_values, created_at, updated_at) VALUES (?, 'Warm', ?, 1, 1)",
      )
      .run(sampler, JSON.stringify({ ...values, contextSize: 32_768, temperature: 0.9 }));
    old
      .query(
        "INSERT INTO prompt_presets (id, name, blocks, created_at, updated_at) VALUES (?, 'Mine', ?, 1, 1)",
      )
      .run(prompt, JSON.stringify(defaultPromptPreset().blocks));
    old
      .query(
        "INSERT INTO settings (id, theme, prompt_preset_id, sampler_preset_id, updated_at) VALUES (1, 'dark', ?, ?, 1)",
      )
      .run(prompt, sampler);
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    const warm = stores.presets.sampler.get(sampler);
    expect(warm?.values).not.toHaveProperty("contextSize");
    expect(warm?.values.temperature).toBe(0.9);
    expect(samplerPresetSchema.parse({ name: warm?.name, values: warm?.values })).toBeTruthy();
    const mine = stores.presets.prompt.get(prompt);
    expect(mine?.actions).toEqual(DEFAULT_PROMPT_ACTIONS);
    expect(
      promptPresetSchema.parse({
        name: mine?.name,
        blocks: mine?.blocks,
        actions: mine?.actions,
        reasoning: mine?.reasoning,
      }),
    ).toBeTruthy();
    expect(stores.settings.get()).toMatchObject({ theme: "dark", contextWindows: {} });
    upgraded.close();
  });

  it("upgrades an M5 database: prompt presets gain the continue and impersonation prompts, and stay chosen", async () => {
    const migrations = join(dir, "m5-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const files = [
      "0000_characters.sql",
      "0001_personas_presets_settings.sql",
      "0002_prompt_assembly.sql",
    ];
    for (const file of files) await copyFile(join(source, file), join(migrations, file));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, files.length);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const prompt = crypto.randomUUID();
    const wrappers = {
      personality: "[{{char}}'s personality: {{personality}}]",
      scenario: "{{scenario}}",
      newChat: "",
      newExampleChat: "[Example Chat]",
    };
    old
      .query(
        "INSERT INTO prompt_presets (id, name, blocks, formats, created_at, updated_at) VALUES (?, 'Mine', ?, ?, 1, 1)",
      )
      .run(prompt, JSON.stringify(defaultPromptPreset().blocks), JSON.stringify(wrappers));
    old
      .query(
        "INSERT INTO settings (id, theme, prompt_preset_id, updated_at) VALUES (1, 'dark', ?, 1)",
      )
      .run(prompt);
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    const mine = stores.presets.prompt.get(prompt);
    expect(mine?.actions).toEqual(DEFAULT_PROMPT_ACTIONS);
    expect(mine?.blocks.find((b) => b.id === "charPersonality")).toMatchObject({
      template: "[{{char}}'s personality: {{content}}]",
    });
    expect(
      promptPresetSchema.parse({
        name: mine?.name,
        blocks: mine?.blocks,
        actions: mine?.actions,
        reasoning: mine?.reasoning,
      }),
    ).toBeTruthy();
    expect(stores.settings.get().promptPresetId).toBe(prompt);
    upgraded.close();
  });

  it("upgrades an M6 database: presets read and send no reasoning, settings gain their defaults", async () => {
    const migrations = join(dir, "m6-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const files = [
      "0000_characters.sql",
      "0001_personas_presets_settings.sql",
      "0002_prompt_assembly.sql",
      "0003_continue_impersonate.sql",
    ];
    for (const file of files) await copyFile(join(source, file), join(migrations, file));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, files.length);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const prompt = crypto.randomUUID();
    old
      .query(
        "INSERT INTO prompt_presets (id, name, blocks, formats, created_at, updated_at) VALUES (?, 'Mine', ?, ?, 1, 1)",
      )
      .run(prompt, JSON.stringify(defaultPromptPreset().blocks), JSON.stringify(LEGACY_FORMATS));
    old
      .query(
        "INSERT INTO settings (id, theme, prompt_preset_id, updated_at) VALUES (1, 'dark', ?, 1)",
      )
      .run(prompt);
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(stores.presets.prompt.get(prompt)?.reasoning).toEqual(DEFAULT_PROMPT_REASONING);
    expect(stores.settings.get()).toMatchObject({
      promptPresetId: prompt,
      promptProcessing: {},
      reasoningOpen: false,
      showHiddenReasoning: false,
    });
    upgraded.close();
  });

  it("upgrades an M8 database: presets gain the lorebook wrapper, settings prefer the character", async () => {
    const migrations = join(dir, "m8-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const files = [
      "0000_characters.sql",
      "0001_personas_presets_settings.sql",
      "0002_prompt_assembly.sql",
      "0003_continue_impersonate.sql",
      "0004_m6_follow_ups.sql",
    ];
    for (const file of files) await copyFile(join(source, file), join(migrations, file));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, files.length);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const { lorebook: _lorebook, ...m8Formats } = LEGACY_FORMATS;
    const formats = { ...m8Formats, scenario: "[Scene: {{scenario}}]" };
    const prompt = crypto.randomUUID();
    old
      .query(
        "INSERT INTO prompt_presets (id, name, blocks, formats, created_at, updated_at) VALUES (?, 'Mine', ?, ?, 1, 1)",
      )
      .run(prompt, JSON.stringify(defaultPromptPreset().blocks), JSON.stringify(formats));
    old
      .query(
        "INSERT INTO settings (id, theme, prompt_preset_id, reasoning_open, updated_at) VALUES (1, 'dark', ?, 1, 1)",
      )
      .run(prompt);
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    const mine = stores.presets.prompt.get(prompt);
    expect(mine?.actions).toEqual(DEFAULT_PROMPT_ACTIONS);
    expect(mine?.blocks.find((b) => b.id === "scenario")).toMatchObject({
      template: "[Scene: {{content}}]",
    });
    expect(
      promptPresetSchema.parse({
        name: mine?.name,
        blocks: mine?.blocks,
        actions: mine?.actions,
        reasoning: mine?.reasoning,
      }),
    ).toBeTruthy();
    expect(stores.settings.get()).toMatchObject({
      promptPresetId: prompt,
      reasoningOpen: true,
      preferCharacterPrompt: true,
      preferCharacterInstructions: true,
    });
    upgraded.close();
  });
  it("upgrades a database from before revisions: every entity starts at revision 0", async () => {
    const migrations = join(dir, "revision-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const files = [
      "0000_characters.sql",
      "0001_personas_presets_settings.sql",
      "0002_prompt_assembly.sql",
      "0003_continue_impersonate.sql",
      "0004_m6_follow_ups.sql",
      "0005_m8_follow_ups.sql",
    ];
    for (const file of files) await copyFile(join(source, file), join(migrations, file));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, files.length);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const ids = {
      character: crypto.randomUUID(),
      persona: crypto.randomUUID(),
      prompt: crypto.randomUUID(),
      sampler: crypto.randomUUID(),
    };
    const saved = card({ description: "Kept as it was" });
    old
      .query(
        "INSERT INTO characters (id, name, nickname, creator, tags, card, created_at, updated_at) VALUES (?, ?, '', '', '[]', ?, 1, 1)",
      )
      .run(ids.character, saved.name, JSON.stringify(saved));
    old
      .query(
        "INSERT INTO personas (id, name, description, created_at, updated_at) VALUES (?, 'Aria', 'An apprentice.', 1, 1)",
      )
      .run(ids.persona);
    const prompt = defaultPromptPreset("Mine");
    old
      .query(
        "INSERT INTO prompt_presets (id, name, blocks, formats, reasoning, created_at, updated_at) VALUES (?, 'Mine', ?, ?, ?, 1, 1)",
      )
      .run(
        ids.prompt,
        JSON.stringify(prompt.blocks),
        JSON.stringify(LEGACY_FORMATS),
        JSON.stringify(prompt.reasoning),
      );
    old
      .query(
        "INSERT INTO sampler_presets (id, name, sampler_values, created_at, updated_at) VALUES (?, 'Warm', ?, 1, 1)",
      )
      .run(ids.sampler, JSON.stringify(defaultSamplerPreset().values));
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(stores.characters.get(ids.character)).toMatchObject({ card: saved, revision: 0 });
    expect(stores.personas.get(ids.persona)).toMatchObject({ name: "Aria", revision: 0 });
    expect(stores.presets.prompt.get(ids.prompt)).toMatchObject({ name: "Mine", revision: 1 });
    expect(stores.presets.sampler.get(ids.sampler)).toMatchObject({ name: "Warm", revision: 0 });
    // The first edit after the upgrade is made against revision 0.
    expect(stores.characters.update(ids.character, { description: "New" }, 0)).toMatchObject({
      status: "updated",
      value: { revision: 1 },
    });
    upgraded.close();
  });

  it("upgrades a database from before context limits: settings keep theirs and gain the defaults", async () => {
    const migrations = join(dir, "limit-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const files = [
      "0000_characters.sql",
      "0001_personas_presets_settings.sql",
      "0002_prompt_assembly.sql",
      "0003_continue_impersonate.sql",
      "0004_m6_follow_ups.sql",
      "0005_m8_follow_ups.sql",
      "0006_revisions.sql",
    ];
    for (const file of files) await copyFile(join(source, file), join(migrations, file));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(0, files.length);
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    old
      .query(
        "INSERT INTO settings (id, theme, model, context_windows, prompt_processing, reasoning_open, prefer_character_prompt, updated_at) VALUES (1, 'dark', 'kimi-k3', ?, ?, 1, 0, 1)",
      )
      .run(JSON.stringify({ "kimi-k3": 32_768 }), JSON.stringify({ "kimi-k3": "strict" }));
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(stores.settings.get()).toMatchObject({
      theme: "dark",
      model: "kimi-k3",
      contextWindows: { "kimi-k3": 32_768 },
      promptProcessing: { "kimi-k3": "strict" },
      reasoningOpen: true,
      preferCharacterPrompt: false,
      contextLimits: {},
    });
    upgraded.close();
  });

  it("upgrades a database from before ComfyUI: settings keep their values and gain valid defaults", async () => {
    const migrations = join(dir, "comfyui-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    // Every migration before ComfyUI's: a later one applied first would make the migrator skip it.
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) =>
        entry.tag.endsWith("_comfyui_settings"),
      ),
    );
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const ids = { character: crypto.randomUUID(), prompt: crypto.randomUUID() };
    const saved = card();
    old
      .query(
        "INSERT INTO characters (id, name, nickname, creator, tags, card, created_at, updated_at) VALUES (?, ?, '', '', '[]', ?, 1, 1)",
      )
      .run(ids.character, saved.name, JSON.stringify(saved));
    const prompt = defaultPromptPreset("Mine");
    old
      .query(
        "INSERT INTO prompt_presets (id, name, blocks, formats, reasoning, created_at, updated_at) VALUES (?, 'Mine', ?, ?, ?, 1, 1)",
      )
      .run(
        ids.prompt,
        JSON.stringify(prompt.blocks),
        JSON.stringify(LEGACY_FORMATS),
        JSON.stringify(prompt.reasoning),
      );
    old
      .query(
        "INSERT INTO settings (id, theme, model, character_id, prompt_preset_id, context_windows, reasoning_open, prefer_character_prompt, updated_at) VALUES (1, 'dark', 'model-a', ?, ?, ?, 1, 0, 1)",
      )
      .run(ids.character, ids.prompt, JSON.stringify({ "model-a": 32_768 }));
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const settings = createStores(upgraded.db, createMemoryPortraitFiles()).settings.get();
    expect(settings).toMatchObject({
      theme: "dark",
      palette: "lamplight",
      model: "model-a",
      imagePromptModel: null,
      characterId: ids.character,
      promptPresetId: ids.prompt,
      contextWindows: { "model-a": 32_768 },
      reasoningOpen: true,
      preferCharacterPrompt: false,
      comfyuiBaseUrl: "",
      // The legacy SQL default the migration wrote; reads normalise it (settings.ts).
      comfyuiWorkflow: settingsTable.comfyuiWorkflow.default,
      castModel: null,
      castReasoning: null,
    });
    expect(settingsSchema.parse(settings)).toEqual(settings);
    upgraded.close();
  });

  it("upgrades a database from before relationships: notebooks keep their lines and gain none", async () => {
    const migrations = join(dir, "relationships-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) =>
        entry.tag.endsWith("_memory_relationships"),
      ),
    );
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const id = crypto.randomUUID();
    const saved = card();
    old
      .query(
        "INSERT INTO characters (id, name, nickname, creator, tags, card, created_at, updated_at) VALUES (?, ?, '', '', '[]', ?, 1, 1)",
      )
      .run(id, saved.name, JSON.stringify(saved));
    old
      .query(
        "INSERT INTO memory_notebooks (character_id, enabled, situation, facts, threads, revision, updated_at) VALUES (?, 1, 'At the pier.', ?, '[]', 3, 1)",
      )
      .run(id, JSON.stringify(["The key opens the vault."]));
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const memory = createStores(upgraded.db, createMemoryPortraitFiles()).memory;
    expect(memory.state(id)).toMatchObject({
      enabled: true,
      notebook: {
        situation: "At the pier.",
        relationships: [],
        facts: ["The key opens the vault."],
        threads: [],
      },
      revision: 3,
    });
    const notebook = {
      situation: "At the pier.",
      relationships: ["Seraphina and Ash: allies since the pier."],
      facts: [],
      threads: [],
      cast: [],
    };
    expect(memory.setState(id, { notebook }, 3)).toMatchObject({ status: "updated" });
    expect(memory.state(id)?.notebook).toEqual(notebook);
    upgraded.close();
  });

  it("upgrades a database from before the memory's opening: notebooks gain none, settings open on it", async () => {
    const migrations = join(dir, "opening-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    const at = journal.entries.findIndex((entry: { tag: string }) =>
      entry.tag.endsWith("_memory_opening"),
    );
    expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at);
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const id = crypto.randomUUID();
    const saved = card();
    old
      .query(
        "INSERT INTO characters (id, name, nickname, creator, tags, card, created_at, updated_at) VALUES (?, ?, '', '', '[]', ?, 1, 1)",
      )
      .run(id, saved.name, JSON.stringify(saved));
    old
      .query(
        "INSERT INTO memory_notebooks (character_id, enabled, situation, relationships, facts, threads, revision, updated_at) VALUES (?, 0, 'At the pier.', '[]', '[]', '[]', 5, 1)",
      )
      .run(id);
    old
      .query(
        "INSERT INTO settings (id, theme, model, context_windows, prompt_processing, reasoning_open, prefer_character_prompt, updated_at) VALUES (1, 'dark', 'kimi-k3', '{}', '{}', 0, 1, 1)",
      )
      .run();
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(stores.memory.state(id)).toMatchObject({
      enabled: false,
      notebook: { situation: "At the pier." },
      opening: "",
      revision: 5,
    });
    expect(stores.settings.get()).toMatchObject({ theme: "dark", memoryOpening: true });
    expect(stores.memory.setState(id, { opening: "> Location: The pier" }, 5)).toMatchObject({
      status: "updated",
      value: { opening: "> Location: The pier", revision: 6 },
    });
    upgraded.close();
  });

  it("upgrades a database from before the foreign-key indexes: lookups use them and deletes still clear chapters", async () => {
    const migrations = join(dir, "fk-index-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) => entry.tag.endsWith("_fk_indexes")),
    );
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const id = crypto.randomUUID();
    const saved = card();
    old
      .query(
        "INSERT INTO characters (id, name, nickname, creator, tags, card, created_at, updated_at) VALUES (?, ?, '', '', '[]', ?, 1, 1)",
      )
      .run(id, saved.name, JSON.stringify(saved));
    const insert = old.query(
      "INSERT INTO memories (id, character_id, seq, kind, title, summary, cues, turns, chapter_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, 'Title', 'Summary.', '[]', 4, ?, 0, 1, 1)",
    );
    insert.run("chapter", id, 2, "chapter", null);
    insert.run("episode", id, 1, "episode", "chapter");
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    // Prepared, not cached: a statement left open would keep the checkpoint on close from running.
    const plan = (query: string) => {
      using statement = upgraded.client.prepare<{ detail: string }, []>(
        `EXPLAIN QUERY PLAN ${query}`,
      );
      return statement
        .all()
        .map((row) => row.detail)
        .join("\n");
    };
    expect(plan("SELECT id FROM memories WHERE chapter_id = 'chapter'")).toContain(
      "memories_chapter_id_idx",
    );
    expect(plan("SELECT 1 FROM persona_bindings WHERE persona_id = 'p'")).toContain(
      "persona_bindings_persona_id_idx",
    );
    expect(plan("SELECT 1 FROM character_lorebooks WHERE lorebook_id = 'b'")).toContain(
      "character_lorebooks_lorebook_id_idx",
    );
    upgraded.client.run("DELETE FROM memories WHERE id = 'chapter'");
    const remaining = upgraded.client.prepare("SELECT id, chapter_id FROM memories");
    expect(remaining.all()).toEqual([{ id: "episode", chapter_id: null }]);
    remaining.finalize();
    upgraded.close();
  });

  it("upgrades a database from before lorebooks: its rows stay, references check, and links work", async () => {
    const migrations = join(dir, "lorebook-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) => entry.tag.endsWith("_lorebooks")),
    );
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const first = historicalDatabase(migrations);
    // Not createStores: today's preset and settings stores read columns added after lorebooks.
    const before = {
      characters: createCharacterStore(first.db, createMemoryPortraitFiles()),
      personas: createPersonaStore(first.db, createMemoryPortraitFiles()),
    };
    const character = before.characters.create(card());
    const persona = before.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
    before.personas.bind(character, persona);
    first.client
      .query(
        "INSERT INTO settings (id, theme, character_id, updated_at) VALUES (1, 'system', ?, 1)",
      )
      .run(character);
    const image = first.client.serialize();
    first.close();

    // The open refuses a result that fails `PRAGMA foreign_key_check`.
    const upgraded = openUserDatabase(image);
    expect(upgraded.client.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const after = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(after.characters.get(character)?.card.name).toBe("Seraphina");
    expect(after.settings.get().characterId).toBe(character);
    expect(after.personas.get(persona)?.characterIds).toEqual([character]);
    const book = after.lorebooks.create(
      { name: "Harbour", book: blankLorebook("Harbour") },
      crypto.randomUUID(),
    );
    expect(after.lorebooks.link(book, character)).toBe("linked");
    expect(after.lorebooks.links()).toEqual([{ characterId: character, lorebookIds: [book] }]);
    upgraded.close();
  });

  it("keeps events through an encrypted close and reopen, and adds them to an older database", async () => {
    const fields = {
      text: "A storm rolls in.",
      chance: 12.5,
      cooldown: 3,
      enabled: true,
      scope: { kind: "selected" as const, characters: [], tags: ["noir"] },
    };
    const dataDir = join(dir, "events-encrypted");
    await mkdir(dataDir, { mode: 0o700 });
    const options = { dataDir, key: Buffer.alloc(32, 7), log: createLogger(() => {}) };
    const alice = usernameSchema.parse("alice");
    const first = createInstanceRegistry(options);
    const id = crypto.randomUUID();
    expect(first.instance(alice).stores.events.create(fields, id)).toBe("created");
    await first.close();
    const sealed = await readFile(join(dataDir, "users", "alice", ENCRYPTED_FILE));
    expect(sealed.includes(Buffer.from(fields.text))).toBe(false);
    const reopened = createInstanceRegistry(options);
    expect(reopened.instance(alice).stores.events.list()).toEqual([
      expect.objectContaining({ id, ...fields, revision: 0 }),
    ]);
    await reopened.close();

    // A database from before events: every migration up to theirs.
    const migrations = join(dir, "events-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) => entry.tag.endsWith("_events")),
    );
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
    const older = historicalDatabase(migrations);
    // Not createStores: today's preset store reads a column added after events.
    const character = createCharacterStore(older.db, createMemoryPortraitFiles()).create(card());
    const upgraded = openUserDatabase(older.client.serialize());
    older.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(stores.characters.get(character)?.card.name).toBe("Seraphina");
    expect(stores.events.list()).toEqual([]);
    expect(stores.events.create(fields, id)).toBe("created");
    expect(stores.events.get(id)).toMatchObject(fields);
    upgraded.close();
  });

  it("upgrades a database from before the preset's Author's Note: presets read the default and keep an edited note", async () => {
    const migrations = join(dir, "note-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) =>
        entry.tag.endsWith("_preset_authors_note"),
      ),
    );
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const id = crypto.randomUUID();
    const preset = defaultPromptPreset("Mine");
    old
      .query(
        "INSERT INTO prompt_presets (id, name, blocks, formats, reasoning, created_at, updated_at) VALUES (?, 'Mine', ?, ?, ?, 1, 1)",
      )
      .run(
        id,
        JSON.stringify(preset.blocks),
        JSON.stringify(LEGACY_FORMATS),
        JSON.stringify(preset.reasoning),
      );
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const presets = createStores(upgraded.db, createMemoryPortraitFiles()).presets.prompt;
    expect(presets.get(id)?.authorsNote).toEqual(DEFAULT_AUTHORS_NOTE);
    expect(presets.list().find((row) => row.id === id)?.authorsNote).toEqual(DEFAULT_AUTHORS_NOTE);
    const column = () =>
      upgraded.client.query("SELECT authors_note FROM prompt_presets WHERE id = ?").get(id) as {
        authors_note: string | null;
      };
    expect(column().authors_note).not.toBeNull();

    const renamed = presets.update(id, { name: "Renamed" }, 1);
    expect(renamed.status).toBe("updated");
    expect(column().authors_note).not.toBeNull();
    const edited = { ...DEFAULT_AUTHORS_NOTE, text: "Keep the fog thick.", depth: 3 };
    expect(presets.update(id, { authorsNote: edited }, 2).status).toBe("updated");
    expect(presets.update(id, { name: "Again" }, 3).status).toBe("updated");
    expect(presets.get(id)).toMatchObject({ name: "Again", authorsNote: edited });
    upgraded.close();
  });

  it("upgrades a database from before stored lorebook counts: the list counts its books", async () => {
    const migrations = join(dir, "counts-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const source = join(import.meta.dirname, "../drizzle");
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) => entry.tag.endsWith("_lorebook_counts")),
    );
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: migrations });
    const id = crypto.randomUUID();
    const entry = {
      keys: ["harbour"],
      content: "Fog.",
      extensions: {},
      enabled: true,
      insertion_order: 0,
      use_regex: false,
    };
    const book = { ...blankLorebook("Harbour"), description: "The docks", entries: [entry] };
    old
      .query(
        "INSERT INTO lorebooks (id, name, book, created_at, updated_at) VALUES (?, 'Harbour', ?, 1, 1)",
      )
      .run(id, JSON.stringify(book));
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    const stores = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(stores.lorebooks.list()).toEqual([
      { id, name: "Harbour", ...summarizeLorebook(upgradeLegacyLorebook(book)), updatedAt: 1 },
    ]);
    expect(stores.lorebooks.list()[0]).toMatchObject({ description: "The docks", entries: 1 });
    // Brought up to date once: the next open writes nothing.
    const image = upgraded.client.serialize();
    upgraded.close();
    const reopened = openUserDatabase(image);
    createStores(reopened.db, createMemoryPortraitFiles());
    expect(reopened.changes()).toBe(0);
    reopened.close();
  });

  it("migrates with foreign keys off, so rebuilding a referenced table keeps what refers to it", async () => {
    // A later migration in drizzle-kit's rebuild form for `characters`.
    const source = join(import.meta.dirname, "../drizzle");
    const migrations = join(dir, "rebuild-migrations");
    await mkdir(join(migrations, "meta"), { recursive: true });
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
    }
    const fresh = new Database(":memory:");
    migrate(drizzle({ client: fresh }), { migrationsFolder: source });
    const { sql } = fresh
      .query("SELECT sql FROM sqlite_master WHERE name = 'characters'")
      .get() as { sql: string };
    fresh.close();
    const rebuild = [
      "PRAGMA foreign_keys=OFF;",
      `${sql.replace("CREATE TABLE `characters`", "CREATE TABLE `__new_characters`")};`,
      "INSERT INTO `__new_characters` SELECT * FROM `characters`;",
      "DROP TABLE `characters`;",
      "ALTER TABLE `__new_characters` RENAME TO `characters`;",
      "PRAGMA foreign_keys=ON;",
    ].join("--> statement-breakpoint\n");
    await writeFile(join(migrations, "0099_rebuild.sql"), rebuild);
    const last = journal.entries.at(-1);
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "0099_rebuild" });
    await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));

    const first = openUserDatabase(undefined);
    const before = createStores(first.db, createMemoryPortraitFiles());
    const id = before.characters.create(card(), await samplePortrait());
    const persona = before.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
    before.personas.bind(id, persona);
    before.settings.update({ characterId: id });
    const upgraded = openUserDatabase(first.client.serialize(), migrations);
    first.close();
    const after = createStores(upgraded.db, createMemoryPortraitFiles());
    expect(after.characters.get(id)?.portrait).not.toBeNull();
    expect(after.settings.get().characterId).toBe(id);
    expect(after.personas.list().find((row) => row.id === persona)?.characterIds).toEqual([id]);
    upgraded.close();
  });
});

describe("character store", () => {
  let store: CharacterStore;
  let close: () => void;
  let portrait: Portrait;

  beforeAll(async () => {
    const opened = openUserDatabase(undefined);
    store = createCharacterStore(opened.db, createMemoryPortraitFiles());
    close = opened.close;
    portrait = await samplePortrait();
  });
  afterAll(() => close());

  it("creates, reads, lists, updates and removes a character", async () => {
    const id = store.create(card(), portrait);
    const stored = store.get(id);
    expect(stored?.card).toEqual(card());
    expect(stored?.portrait).toEqual(expect.any(Number));

    expect(store.list().find((summary) => summary.id === id)).toMatchObject({
      name: "Seraphina",
      tags: ["fantasy"],
      portrait: stored?.portrait,
    });

    const updated = store.update(
      id,
      { description: "Keeper of the forest", tags: ["fantasy", "healer"] },
      0,
    );
    expect(updated).toMatchObject({
      status: "updated",
      value: {
        card: {
          description: "Keeper of the forest",
          tags: ["fantasy", "healer"],
        },
        revision: 1,
      },
    });
    expect(store.list().find((summary) => summary.id === id)?.tags).toEqual(["fantasy", "healer"]);

    expect(store.remove(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
    expect(await store.portrait(id, "full")).toBeUndefined();
    expect(store.remove(id)).toBe(false);
  });

  it("discards unsupported imported extensions before persistence", () => {
    const extensions = JSON.parse('{"__proto__": {"x": 1}, "chub": {"id": 7}, "big": 1e300}');
    const result = normalizeCard({ spec: "chara_card_v2", data: { name: "Mara", extensions } });
    if (!result.ok) throw new Error(result.error);
    const id = store.create(result.card);
    expect(store.get(id)?.card).not.toHaveProperty("extensions");
  });

  it("duplicates a character with its portrait under a new name", async () => {
    const id = store.create(card({ name: "Wren" }), portrait);
    const copy = store.duplicate(id);
    expect(copy).toEqual(expect.any(String));
    expect(store.get(copy ?? "")?.card.name).toBe("Wren (copy)");
    expect((await store.portrait(copy ?? "", "full"))?.bytes).toEqual(
      (await store.portrait(id, "full"))?.bytes,
    );
    expect(store.duplicate("missing")).toBeUndefined();
  });

  it("replaces and removes a portrait with a new version each time", async () => {
    const id = store.create(card({ name: "Tobias" }));
    expect(store.get(id)?.portrait).toBeNull();
    const first = store.setPortrait(id, portrait);
    const second = store.setPortrait(id, portrait);
    expect(second).toBeGreaterThan(first ?? Infinity);
    expect((await store.portrait(id, "thumb"))?.version).toBe(second);
    expect(store.removePortrait(id)).toBe(true);
    expect(store.get(id)?.portrait).toBeNull();
    expect(store.setPortrait("missing", portrait)).toBeUndefined();
  });

  it("stores the card and the image apart", async () => {
    const id = store.create(card({ name: "Ines" }), portrait);
    expect(JSON.stringify(store.get(id)?.card)).not.toContain("PNG");
    expect(new TextDecoder().decode((await store.portrait(id, "full"))?.bytes.slice(1, 4))).toBe(
      "PNG",
    );
  });
});

describe("portrait files behind the stores", () => {
  let portrait: Portrait;
  beforeAll(async () => {
    portrait = await samplePortrait();
  });

  /** A memory file store that remembers every id it handed out. */
  function memoryFiles() {
    const files = createMemoryPortraitFiles();
    const ids: string[] = [];
    return {
      ids,
      files: {
        ...files,
        put(png: Uint8Array) {
          const id = files.put(png);
          ids.push(id);
          return id;
        },
      } satisfies PortraitFiles,
    };
  }

  const setup = () => {
    const opened = openUserDatabase(undefined);
    const { files, ids } = memoryFiles();
    const stores = createStores(opened.db, files);
    const row = (id: string) =>
      opened.client
        .query<{ file: string }, [string]>("SELECT file FROM portraits WHERE character_id = ?")
        .get(id);
    return { ...opened, files, ids, stores, row };
  };

  it("replaces a portrait with a new file", async () => {
    const { client, files, stores, row, close } = setup();
    const id = stores.characters.create(card(), portrait);
    const first = row(id)?.file;
    const black = sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } });
    const other = { ...portrait, png: new Uint8Array(await black.png().toBuffer()) };
    stores.characters.setPortrait(id, other);
    const replaced = row(id);
    expect(replaced?.file).toEqual(expect.any(String));
    expect(replaced?.file).not.toBe(first);
    expect(Buffer.from((await stores.characters.portrait(id, "full"))?.bytes ?? [])).toEqual(
      Buffer.from(other.png),
    );
    await files.collect(referencedFiles(client));
    expect(files.read(first ?? "")).toBeUndefined();
    expect(files.read(replaced?.file ?? "")).toBeDefined();
    close();
  });

  it("duplicates into a different file with equal bytes", async () => {
    const { client, stores, row, close } = setup();
    const id = stores.characters.create(card(), portrait);
    const copy = stores.characters.duplicate(id) ?? "";
    expect(row(copy)?.file).not.toBe(row(id)?.file);
    expect(referencedFiles(client).size).toBe(2);
    expect(Buffer.from((await stores.characters.portrait(copy, "full"))?.bytes ?? [])).toEqual(
      Buffer.from(portrait.png),
    );
    close();
  });

  it("collects an owner's file once the owner is deleted", async () => {
    const { client, files, stores, ids, close } = setup();
    const character = stores.characters.create(card(), portrait);
    const persona = stores.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
    stores.personas.setPortrait(persona, portrait);
    const [characterFile, personaFile] = ids;
    stores.characters.remove(character);
    stores.personas.remove(persona);
    await files.collect(referencedFiles(client));
    expect(files.read(characterFile ?? "")).toBeUndefined();
    expect(files.read(personaFile ?? "")).toBeUndefined();
    close();
  });

  it("drops the bytes a rolled-back transaction staged", async () => {
    const { client, files, stores, ids, close } = setup();
    const id = stores.characters.create(card());
    client.run(
      "CREATE TRIGGER refuse BEFORE INSERT ON portraits BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(() => stores.characters.setPortrait(id, portrait)).toThrow();
    expect(ids).toHaveLength(1);
    expect(referencedFiles(client).size).toBe(0);
    expect(stores.characters.get(id)?.portrait).toBeNull();
    await files.writeStaged(referencedFiles(client));
    expect(files.read(ids[0] ?? "")).toBeUndefined();
    close();
  });
});

describe("the store accepts characters only (PRINCIPLES.md 1)", () => {
  const chatShapes: unknown[] = [
    { role: "user", content: "canary" },
    { model: "m", messages: [{ role: "user", content: "canary" }] },
    { id: "1", role: "assistant", text: "canary", status: "complete" },
    [{ role: "user", content: "canary" }],
    "canary",
  ];

  it.each(chatShapes)("rejects %j on every write and writes nothing", async (value) => {
    const { db, close } = openUserDatabase(undefined);
    const store = createCharacterStore(db, createMemoryPortraitFiles());
    const id = store.create(card());
    const before = JSON.stringify(store.list());
    const portrait = await samplePortrait();

    expect(() => store.create(value as CharacterCard)).toThrow();
    expect(() => store.create({ ...card(), messages: value } as CharacterCard)).toThrow();
    expect(() => store.update(id, value as never, 0)).toThrow();
    expect(() => store.update(id, { description: "x", messages: value } as never, 0)).toThrow();
    expect(() => store.setPortrait(id, value as Portrait)).toThrow();
    expect(() =>
      store.setPortrait(id, { ...portrait, png: new TextEncoder().encode(String(value)) }),
    ).toThrow();

    expect(JSON.stringify(store.list())).toBe(before);
    expect(JSON.stringify(store.get(id)?.card)).not.toContain("canary");
    close();
  });

  it("has no write that takes a chat type", () => {
    const { db, close } = openUserDatabase(undefined);
    const store = createCharacterStore(db, createMemoryPortraitFiles());
    // @ts-expect-error a chat turn is not a character card
    expect(() => store.create({ role: "user", content: "x" })).toThrow();
    // @ts-expect-error a message list is not a character patch
    expect(() => store.update("id", { messages: [] }, 0)).toThrow();
    close();
  });
});
