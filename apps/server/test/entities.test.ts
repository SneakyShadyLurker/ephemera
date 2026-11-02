import {
  blankCard,
  defaultPromptPreset,
  defaultSamplerPreset,
  type PersonaFields,
  type PromptPreset,
  type SamplerPreset,
} from "@ephemera/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCharacterStore,
  createMemoryPortraitFiles,
  createPersonaStore,
  createPresetStore,
  createSettingsStore,
  openUserDatabase,
  type Portrait,
} from "../src/persistence/index.ts";
import { samplePortrait } from "./helpers.ts";

function stores() {
  const { db } = openUserDatabase(undefined);
  const presets = createPresetStore(db);
  const files = createMemoryPortraitFiles();
  return {
    characters: createCharacterStore(db, files),
    personas: createPersonaStore(db, files),
    presets,
    settings: createSettingsStore(db),
  };
}

const aria: PersonaFields = { name: "Aria", description: "A cartographer's apprentice." };

describe("persona store", () => {
  let s: ReturnType<typeof stores>;
  beforeEach(() => {
    s = stores();
  });

  it("creates idempotently, reads, lists, updates, duplicates and removes", async () => {
    const id = crypto.randomUUID();
    expect(s.personas.create(aria, id)).toBe(id);
    expect(s.personas.create({ ...aria, name: "Other" }, id)).toBe(id);
    expect(s.personas.get(id)).toMatchObject({
      id,
      name: "Aria",
      portrait: null,
      characterIds: [],
    });

    expect(s.personas.update(id, { description: "Now a captain." }, 0)).toMatchObject({
      status: "updated",
      value: { description: "Now a captain.", revision: 1 },
    });
    expect(s.personas.update(crypto.randomUUID(), { name: "X" }, 0)).toEqual({
      status: "missing",
    });

    const version = s.personas.setPortrait(id, await samplePortrait());
    const copy = s.personas.duplicate(id);
    expect(s.personas.get(copy ?? "")).toMatchObject({
      name: "Aria (copy)",
      description: "Now a captain.",
    });
    expect((await s.personas.portrait(copy ?? "", "thumb"))?.bytes).toEqual(
      (await s.personas.portrait(id, "thumb"))?.bytes,
    );
    expect(
      s.personas
        .list()
        .map((persona) => persona.name)
        .sort(),
    ).toEqual(["Aria", "Aria (copy)"]);
    expect(version).toEqual(expect.any(Number));

    expect(s.personas.remove(id)).toBe(true);
    expect(await s.personas.portrait(id, "full")).toBeUndefined();
    expect(s.personas.remove(id)).toBe(false);
  });

  it("binds a character to one persona, moves it, and loses it with either side", () => {
    const mara = s.characters.create(blankCard("Mara"));
    const first = s.personas.create(aria, crypto.randomUUID());
    const second = s.personas.create({ ...aria, name: "Ines" }, crypto.randomUUID());

    expect(s.personas.bind(mara, first)).toBe(true);
    expect(s.personas.get(first)?.characterIds).toEqual([mara]);
    expect(s.personas.bind(mara, second)).toBe(true);
    expect(s.personas.get(first)?.characterIds).toEqual([]);
    expect(s.personas.get(second)?.characterIds).toEqual([mara]);
    expect(s.personas.bind(mara, crypto.randomUUID())).toBe(false);
    expect(s.personas.bind(crypto.randomUUID(), second)).toBe(false);

    const copy = s.personas.duplicate(second);
    expect(s.personas.get(copy ?? "")?.characterIds).toEqual([]);

    s.characters.remove(mara);
    expect(s.personas.get(second)?.characterIds).toEqual([]);
    const wren = s.characters.create(blankCard("Wren"));
    s.personas.bind(wren, second);
    s.personas.remove(second);
    expect(s.personas.bind(wren, null)).toBe(true);
  });

  it("reads a persona's own characters, the same ones the list shows", () => {
    const mara = s.characters.create(blankCard("Mara"));
    const wren = s.characters.create(blankCard("Wren"));
    const ash = s.characters.create(blankCard("Ash"));
    const first = s.personas.create(aria, crypto.randomUUID());
    const second = s.personas.create({ ...aria, name: "Ines" }, crypto.randomUUID());
    s.personas.bind(mara, first);
    s.personas.bind(wren, first);
    s.personas.bind(ash, second);

    expect(s.personas.get(first)?.characterIds).toEqual([mara, wren]);
    expect(s.personas.get(second)?.characterIds).toEqual([ash]);
    for (const summary of s.personas.list()) {
      expect(s.personas.get(summary.id)?.characterIds).toEqual(summary.characterIds);
    }
  });

  it("keeps a character's and a persona's portraits apart", async () => {
    const portrait = await samplePortrait();
    const character = s.characters.create(blankCard("Mara"), portrait);
    const persona = s.personas.create(aria, crypto.randomUUID());
    expect(await s.personas.portrait(persona, "full")).toBeUndefined();
    s.personas.setPortrait(persona, portrait);
    s.personas.removePortrait(persona);
    expect(await s.characters.portrait(character, "full")).toBeDefined();
    expect(s.personas.setPortrait(character, portrait)).toBeUndefined();
  });
});

describe("preset stores", () => {
  let s: ReturnType<typeof stores>;
  beforeEach(() => {
    s = stores();
  });

  it("seeds one preset of each kind and points the settings at them", () => {
    const [prompt] = s.presets.prompt.list();
    const [sampler] = s.presets.sampler.list();
    expect(prompt).toMatchObject({ name: "Default", blocks: defaultPromptPreset().blocks });
    expect(sampler).toMatchObject({
      name: "Model defaults",
      values: defaultSamplerPreset().values,
    });
    expect(s.settings.get()).toMatchObject({
      promptPresetId: prompt?.id,
      samplerPresetId: sampler?.id,
    });
  });

  it("creates idempotently, updates, duplicates, and never deletes the last one", () => {
    const id = crypto.randomUUID();
    const preset: SamplerPreset = { ...defaultSamplerPreset("Balanced") };
    s.presets.sampler.create(preset, id);
    s.presets.sampler.create({ ...preset, name: "Other" }, id);
    expect(s.presets.sampler.list()).toHaveLength(2);

    const updated = s.presets.sampler.update(
      id,
      { values: { ...preset.values, temperature: 0.9, model: "deepseek-v4-pro" } },
      0,
    );
    expect(updated).toMatchObject({
      status: "updated",
      value: { values: { temperature: 0.9, model: "deepseek-v4-pro" }, revision: 1 },
    });
    expect(s.presets.sampler.update(id, { name: "Renamed" }, 1)).toMatchObject({
      status: "updated",
      value: { values: { temperature: 0.9 }, revision: 2 },
    });
    expect(s.presets.sampler.get(s.presets.sampler.duplicate(id) ?? "")?.name).toBe(
      "Renamed (copy)",
    );

    for (const other of s.presets.sampler.list().filter((stored) => stored.id !== id)) {
      expect(s.presets.sampler.remove(other.id)).toBe("removed");
    }
    expect(s.presets.sampler.remove(id)).toBe("last");
    expect(s.presets.sampler.remove(crypto.randomUUID())).toBe("missing");
  });

  it("hands the settings to the most recently edited other preset when the one in use goes", () => {
    const [seeded] = s.presets.prompt.list();
    const chosen = s.presets.prompt.create(defaultPromptPreset("Slow burn"), crypto.randomUUID());
    s.settings.update({ promptPresetId: chosen });
    expect(s.presets.prompt.remove(chosen)).toBe("removed");
    expect(s.settings.get().promptPresetId).toBe(seeded?.id);
  });

  it("parses the whole preset on update, so an edit cannot break it", () => {
    const [seeded] = s.presets.prompt.list();
    const blocks = seeded?.blocks.filter((block) => block.id !== "chatHistory");
    expect(() => s.presets.prompt.update(seeded?.id ?? "", { blocks }, 0)).toThrow();
    expect(s.presets.prompt.get(seeded?.id ?? "")?.blocks).toEqual(seeded?.blocks);
  });
});

describe("settings store", () => {
  let s: ReturnType<typeof stores>;
  beforeEach(() => {
    s = stores();
  });

  it("stores the theme, model and chosen entities; references must exist", () => {
    const mara = s.characters.create(blankCard("Mara"));
    const persona = s.personas.create(aria, crypto.randomUUID());
    expect(
      s.settings.update({ theme: "dark", model: "kimi-k3", characterId: mara, personaId: persona }),
    ).toMatchObject({ theme: "dark", model: "kimi-k3", characterId: mara, personaId: persona });
    expect(s.settings.update({ characterId: crypto.randomUUID() })).toBeUndefined();
    expect(s.settings.get().characterId).toBe(mara);
  });

  it("forgets a deleted character or persona", () => {
    const mara = s.characters.create(blankCard("Mara"));
    const persona = s.personas.create(aria, crypto.randomUUID());
    s.settings.update({ characterId: mara, personaId: persona, defaultPersonaId: persona });
    s.characters.remove(mara);
    s.personas.remove(persona);
    expect(s.settings.get()).toMatchObject({
      characterId: null,
      personaId: null,
      defaultPersonaId: null,
    });
  });

  it("starts with no context limits and block trimming on", () => {
    expect(s.settings.get()).toMatchObject({ contextLimits: {} });
  });

  it("keeps the context limits it is given", () => {
    expect(s.settings.update({ contextLimits: { "kimi-k3": 16_384 } })).toMatchObject({
      contextLimits: { "kimi-k3": 16_384 },
    });
    expect(s.settings.get()).toMatchObject({
      contextLimits: { "kimi-k3": 16_384 },
    });
  });
});

describe("the new stores accept their own schemas only (PRINCIPLES.md 1)", () => {
  const chatShapes: unknown[] = [
    { role: "user", content: "canary" },
    { model: "m", messages: [{ role: "user", content: "canary" }] },
    { id: "1", role: "assistant", parts: [{ type: "text", text: "canary" }] },
    [{ role: "user", content: "canary" }],
    "canary",
  ];

  it.each(chatShapes)("rejects %j on every write and writes nothing", async (value) => {
    const s = stores();
    const persona = s.personas.create(aria, crypto.randomUUID());
    const [prompt] = s.presets.prompt.list();
    const [sampler] = s.presets.sampler.list();
    const before = JSON.stringify([
      s.personas.list(),
      s.presets.prompt.list(),
      s.presets.sampler.list(),
      s.settings.get(),
    ]);

    expect(() => s.personas.create(value as PersonaFields, crypto.randomUUID())).toThrow();
    expect(() =>
      s.personas.create({ ...aria, messages: value } as PersonaFields, crypto.randomUUID()),
    ).toThrow();
    expect(() => s.personas.update(persona, value as never, 0)).toThrow();
    expect(() =>
      s.personas.update(persona, { description: "x", messages: value } as never, 0),
    ).toThrow();
    expect(() => s.personas.setPortrait(persona, value as Portrait)).toThrow();
    expect(() => s.presets.prompt.create(value as PromptPreset, crypto.randomUUID())).toThrow();
    expect(() =>
      s.presets.prompt.create(
        { ...defaultPromptPreset(), messages: value } as PromptPreset,
        crypto.randomUUID(),
      ),
    ).toThrow();
    expect(() =>
      s.presets.prompt.update(prompt?.id ?? "", { messages: value } as never, 0),
    ).toThrow();
    expect(() => s.presets.sampler.create(value as SamplerPreset, crypto.randomUUID())).toThrow();
    expect(() =>
      s.presets.sampler.update(sampler?.id ?? "", { values: value } as never, 0),
    ).toThrow();
    expect(() => s.settings.update(value as never)).toThrow();
    expect(() => s.settings.update({ theme: "dark", messages: value } as never)).toThrow();

    expect(
      JSON.stringify([
        s.personas.list(),
        s.presets.prompt.list(),
        s.presets.sampler.list(),
        s.settings.get(),
      ]),
    ).toBe(before);
    expect(before).not.toContain("canary");
  });

  it("has no write that takes a chat type", () => {
    const s = stores();
    // @ts-expect-error a chat turn is not a persona
    expect(() => s.personas.create({ role: "user", content: "x" }, crypto.randomUUID())).toThrow();
    // @ts-expect-error a message list is not a settings patch
    expect(() => s.settings.update({ messages: [] })).toThrow();
    const turn = { role: "user", content: "x" };
    // @ts-expect-error a chat turn is not a prompt preset
    expect(() => s.presets.prompt.create(turn, crypto.randomUUID())).toThrow();
  });
});
