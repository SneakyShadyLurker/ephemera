import {
  blankCard,
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  defaultSamplerPreset,
  type InspectedPrompt,
  type ReasoningEffort,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { type FakeUpstreamOptions, fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  fileForm,
  formRequest,
  ownerHeaders,
  PICK_SEED,
  postJson,
  promptPart,
  responseParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";
import { plainPng } from "./image-fixtures.ts";

function setup(options: FakeUpstreamOptions = {}) {
  const upstream = fakeUpstream({ chunks: ["Aye."], ...options });
  const { app, instances } = testApp({ fetch: upstream.fetch });
  const { stores } = instances.instance(TEST_USER);
  return { app, stores, upstream };
}

const promptOf = async (response: Response) => promptPart(await responseParts(response));

const hello = [{ role: "user" as const, content: "Hello." }];
const request = (extra: Record<string, unknown> = {}) => ({
  model: "fake-model",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  messages: hello,
  ...extra,
});

async function preview(app: ReturnType<typeof setup>["app"], body: unknown) {
  const response = await app.request("/api/chat/preview", postJson(body));
  expect(response.status).toBe(200);
  return ((await response.json()) as { prompt: InspectedPrompt }).prompt;
}

describe("reasoning effort max", () => {
  const withEffort = (stores: ReturnType<typeof setup>["stores"], reasoning: ReasoningEffort) =>
    stores.presets.sampler.create(
      { name: "Deep", values: { ...defaultSamplerPreset().values, reasoning } },
      crypto.randomUUID(),
    );

  it("reaches upstream as reasoning_effort, and the inspector shows it as the setting", async () => {
    const { app, stores, upstream } = setup();
    const samplerPresetId = withEffort(stores, "max");
    const prompt = await promptOf(
      await app.request("/api/chat", postJson(request({ samplerPresetId }))),
    );
    expect(upstream.records[0]?.body).toMatchObject({ reasoning_effort: "max" });
    expect(prompt.settings).toEqual({ reasoning: "max" });
    expect(prompt.reasoningNotOffered).toBeNull();
  });

  it("leaves the AI SDK's own efforts to its reasoning setting", async () => {
    const { app, stores, upstream } = setup();
    const samplerPresetId = withEffort(stores, "xhigh");
    await (await app.request("/api/chat", postJson(request({ samplerPresetId })))).text();
    expect(upstream.records[0]?.body).toMatchObject({ reasoning_effort: "xhigh" });
  });

  it("is not sent to a model whose catalog entry does not offer it", async () => {
    const { app, stores, upstream } = setup({
      catalog: [
        {
          slug: "no-max",
          context_window: 100_000,
          supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }],
        },
      ],
    });
    const samplerPresetId = withEffort(stores, "max");
    const prompt = await promptOf(
      await app.request("/api/chat", postJson(request({ model: "no-max", samplerPresetId }))),
    );
    expect(upstream.records[0]?.body).not.toHaveProperty("reasoning_effort");
    expect(prompt.reasoningNotOffered).toBe("max");
  });

  it("accepts max as a preset's effort and refuses ultra", async () => {
    const { app } = setup();
    const create = async (reasoning: string) =>
      (
        await app.request(
          "/api/presets/sampler",
          postJson({
            id: crypto.randomUUID(),
            preset: { name: reasoning, values: { ...defaultSamplerPreset().values, reasoning } },
          }),
        )
      ).status;
    expect(await create("max")).toBe(201);
    expect(await create("ultra")).toBe(400);
  });
});

describe("pick seed", () => {
  const cardWithPick = (stores: ReturnType<typeof setup>["stores"]) =>
    stores.characters.create({
      ...blankCard("Mara"),
      description: "{{pick::amber::teal::violet::ochre::slate::rose::jade::umber}} eyes",
    });

  it("chooses the same for one seed on every request, and may differ for another", async () => {
    const { app, stores } = setup();
    const characterId = cardWithPick(stores);
    const description = async (pickSeed: number) =>
      (await preview(app, request({ characterId, pickSeed }))).messages.find(
        (m) => m.source.kind === "block" && m.source.id === "charDescription",
      )?.content;
    const first = await description(PICK_SEED);
    expect(first).toMatch(/^[a-z]+ eyes$/);
    expect(await description(PICK_SEED)).toBe(first);
    const others = new Set<string | undefined>();
    for (let seed = 0; seed < 16; seed += 1) others.add(await description(seed * 104_729));
    expect(others.size).toBeGreaterThan(1);
  });

  it("is a uint32 on generations and previews", async () => {
    const { app, upstream } = setup();
    for (const path of ["/api/chat", "/api/chat/preview"]) {
      for (const body of [request({ pickSeed: -1 }), request({ pickSeed: 2 ** 32 })]) {
        const response = await app.request(path, postJson(body));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_request" });
      }
    }
    expect(upstream.records).toHaveLength(0);
  });

  it("is required on generations and previews", async () => {
    const { app, upstream } = setup();
    const { pickSeed: _seed, ...without } = request();
    for (const path of ["/api/chat", "/api/chat/preview"]) {
      const response = await app.request(path, postJson(without));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(upstream.records).toHaveLength(0);
  });
});

describe("prefer the character's prompts", () => {
  const card = {
    ...blankCard("Mara"),
    systemPrompt: "Card main prompt.",
    postHistoryInstructions: "Card instructions.",
  };
  const preset = {
    ...defaultPromptPreset("Mine"),
    blocks: defaultPromptPreset().blocks.map((block) =>
      block.kind === "text"
        ? {
            ...block,
            content: block.id === "main" ? "Preset main prompt." : "Preset instructions.",
          }
        : block,
    ),
  };

  it("are on by default and can be switched off through the settings API", async () => {
    const { app } = setup();
    const settings = async () =>
      (
        (await (await app.request("/api/settings", { headers: ownerHeaders() })).json()) as {
          settings: Record<string, unknown>;
        }
      ).settings;
    expect(await settings()).toMatchObject({
      preferCharacterPrompt: true,
      preferCharacterInstructions: true,
    });
    const patched = await app.request("/api/settings", {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ preferCharacterPrompt: false }),
    });
    expect(patched.status).toBe(200);
    expect(await settings()).toMatchObject({
      preferCharacterPrompt: false,
      preferCharacterInstructions: true,
    });
    const bad = await app.request("/api/settings", {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ preferCharacterInstructions: "no" }),
    });
    expect(bad.status).toBe(400);
  });

  it("decide whether the card's or the preset's text is sent", async () => {
    const { app, stores } = setup();
    const characterId = stores.characters.create(card);
    const promptPresetId = stores.presets.prompt.create(preset, crypto.randomUUID());
    const sent = async () => {
      const prompt = await preview(app, request({ characterId, promptPresetId }));
      const text = (id: string) =>
        prompt.messages.find((m) => m.source.kind === "block" && m.source.id === id)?.content;
      return [text("main"), text("postHistory")];
    };
    expect(await sent()).toEqual(["Card main prompt.", "Card instructions."]);
    stores.settings.update({ preferCharacterPrompt: false });
    expect(await sent()).toEqual(["Preset main prompt.", "Card instructions."]);
    stores.settings.update({ preferCharacterPrompt: true, preferCharacterInstructions: false });
    expect(await sent()).toEqual(["Card main prompt.", "Preset instructions."]);
  });
});

describe("Character's Note", () => {
  it("is sent upstream at its depth with its role, and named in the inspector", async () => {
    const { app, stores, upstream } = setup();
    const characterId = stores.characters.create({
      ...blankCard("Mara"),
      characterNote: { prompt: "{{char}} hides the key.", depth: 1, role: "user" },
    });
    const chat = [
      { role: "user" as const, content: "Hi." },
      { role: "assistant" as const, content: "Hello." },
      { role: "user" as const, content: "Where is it?" },
    ];
    // The Author's Note off, so the Character's Note has depth 1 to itself.
    const promptPresetId = stores.presets.prompt.create(
      { ...defaultPromptPreset(), authorsNote: { ...DEFAULT_AUTHORS_NOTE, enabled: false } },
      crypto.randomUUID(),
    );
    const prompt = await promptOf(
      await app.request(
        "/api/chat",
        postJson(request({ characterId, promptPresetId, messages: chat })),
      ),
    );
    const body = upstream.records[0]?.body as { messages: { role: string; content: string }[] };
    expect(body.messages.slice(-3)).toEqual([
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Mara hides the key." },
      { role: "user", content: "Where is it?" },
    ]);
    expect(prompt.messages.find((m) => m.source.kind === "characterNote")?.source).toEqual({
      kind: "characterNote",
      depth: 1,
    });
  });

  it("is edited through the sheet patch and kept as native character data", async () => {
    const { app, stores } = setup();
    const characterId = stores.characters.create({
      ...blankCard("Mara"),
      characterNote: { prompt: "", depth: 4, role: "system" },
    });
    const patch = (body: object) =>
      app.request(`/api/characters/${characterId}`, {
        method: "PATCH",
        headers: ownerHeaders(),
        body: JSON.stringify({ ...body, revision: stores.characters.get(characterId)?.revision }),
      });
    const note = { prompt: "Rain all night.", depth: 2, role: "assistant" };
    expect((await patch({ characterNote: note })).status).toBe(200);
    expect(stores.characters.get(characterId)?.card.characterNote).toEqual(note);
    expect((await patch({ characterNote: { ...note, depth: 1001 } })).status).toBe(400);
    expect((await patch({ characterNote: { ...note, role: "narrator" } })).status).toBe(400);
  });
});

describe("lorebook wrapper", () => {
  it("wraps the entries as the prompt preset says", async () => {
    const { app, stores } = setup();
    const characterId = stores.characters.create({
      ...blankCard("Mara"),
      lorebook: {
        entries: [
          {
            keys: [],
            constant: true,
            content: "High water at dusk.",

            enabled: true,
            insertionOrder: 1,
            useRegex: false,
          },
        ],
      },
    });
    const promptPresetId = stores.presets.prompt.create(
      {
        ...defaultPromptPreset("Wrapped"),
        blocks: defaultPromptPreset().blocks.map((b) =>
          b.kind === "source" && (b.id === "lorebookBefore" || b.id === "lorebookAfter")
            ? { ...b, template: "[World of {{char}}:\n{{content}}]" }
            : b,
        ),
      },
      crypto.randomUUID(),
    );
    const prompt = await preview(app, request({ characterId, promptPresetId }));
    expect(prompt.messages.find((m) => m.source.kind === "lorebook")?.content).toBe(
      "[World of Mara:\nHigh water at dusk.]",
    );
  });
});

describe("edits against a revision", () => {
  type Stores = ReturnType<typeof setup>["stores"];
  interface Kind {
    path: string;
    make(stores: Stores): string;
    /** An edit that changes one text field to `text`. */
    edit(text: string): object;
    /** That text field as stored. */
    text(stores: Stores, id: string): string | undefined;
    revision(stores: Stores, id: string): number | undefined;
    /** The revision a successful edit answers with. */
    answered(body: unknown): unknown;
  }
  const answeredPreset = (body: unknown) =>
    (body as { preset: { revision: number } }).preset.revision;
  const answeredTop = (body: unknown) => (body as { revision: number }).revision;
  const kinds: Record<string, Kind> = {
    character: {
      path: "/api/characters",
      make: (stores) => stores.characters.create(blankCard("Mara")),
      edit: (text) => ({ description: text }),
      text: (stores, id) => stores.characters.get(id)?.card.description,
      revision: (stores, id) => stores.characters.get(id)?.revision,
      answered: answeredTop,
    },
    persona: {
      path: "/api/personas",
      make: (stores) =>
        stores.personas.create({ name: "Aria", description: "" }, crypto.randomUUID()),
      edit: (text) => ({ description: text }),
      text: (stores, id) => stores.personas.get(id)?.description,
      revision: (stores, id) => stores.personas.get(id)?.revision,
      answered: answeredTop,
    },
    "prompt preset": {
      path: "/api/presets/prompt",
      make: (stores) =>
        stores.presets.prompt.create(defaultPromptPreset("Slow"), crypto.randomUUID()),
      edit: (text) => ({ name: text }),
      text: (stores, id) => stores.presets.prompt.get(id)?.name,
      revision: (stores, id) => stores.presets.prompt.get(id)?.revision,
      answered: answeredPreset,
    },
    "sampler preset": {
      path: "/api/presets/sampler",
      make: (stores) =>
        stores.presets.sampler.create(defaultSamplerPreset("Warm"), crypto.randomUUID()),
      edit: (text) => ({ name: text }),
      text: (stores, id) => stores.presets.sampler.get(id)?.name,
      revision: (stores, id) => stores.presets.sampler.get(id)?.revision,
      answered: answeredPreset,
    },
  };
  const patch = (body: object): RequestInit => ({
    method: "PATCH",
    headers: ownerHeaders(),
    body: JSON.stringify(body),
  });

  describe.each(Object.entries(kinds))("a %s", (_name, kind) => {
    it("starts at revision 0, and each edit adds one and answers with it", async () => {
      const { app, stores } = setup();
      const id = kind.make(stores);
      expect(kind.revision(stores, id)).toBe(0);
      for (const revision of [0, 1, 2]) {
        const response = await app.request(
          `${kind.path}/${id}`,
          patch({ ...kind.edit(`Edit ${revision}`), revision }),
        );
        expect(response.status).toBe(200);
        expect(kind.answered(await response.json())).toBe(revision + 1);
      }
      expect(kind.revision(stores, id)).toBe(3);
      expect(kind.text(stores, id)).toBe("Edit 2");
      const read = await app.request(`${kind.path}/${id}`, { headers: ownerHeaders() });
      const body = (await read.json()) as { revision?: number; preset?: { revision: number } };
      expect(body.preset?.revision ?? body.revision).toBe(3);
    });

    it("refuses an edit made against another revision with 409 and the current one, writing nothing", async () => {
      const { app, stores } = setup();
      const id = kind.make(stores);
      await app.request(`${kind.path}/${id}`, patch({ ...kind.edit("Saved here"), revision: 0 }));
      const before = kind.text(stores, id);
      for (const stale of [0, 2]) {
        const response = await app.request(
          `${kind.path}/${id}`,
          patch({ ...kind.edit("From another tab"), revision: stale }),
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "conflict", revision: 1 });
      }
      expect(kind.text(stores, id)).toBe(before);
      expect(kind.revision(stores, id)).toBe(1);
    });

    it("answers a stale edit the entity already holds as saved, writing nothing (a retry after a lost response)", async () => {
      const { app, stores } = setup();
      const id = kind.make(stores);
      const edit = patch({ ...kind.edit("Sent once"), revision: 0 });
      expect((await app.request(`${kind.path}/${id}`, edit)).status).toBe(200);
      // The response was lost; the retry names the old revision.
      const retry = await app.request(`${kind.path}/${id}`, edit);
      expect(retry.status).toBe(200);
      expect(kind.answered(await retry.json())).toBe(1);
      expect(kind.revision(stores, id)).toBe(1);
      expect(kind.text(stores, id)).toBe("Sent once");
    });

    it("lets one of two edits made against the same revision land, and refuses the other", async () => {
      const { app, stores } = setup();
      const id = kind.make(stores);
      const responses = await Promise.all(
        ["First tab", "Second tab"].map((text) =>
          app.request(`${kind.path}/${id}`, patch({ ...kind.edit(text), revision: 0 })),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = responses.findIndex((response) => response.status === 200);
      expect(kind.text(stores, id)).toBe(winner === 0 ? "First tab" : "Second tab");
      expect(kind.revision(stores, id)).toBe(1);
    });

    it.each([
      ["no revision", {}],
      ["a negative revision", { revision: -1 }],
      ["a fractional revision", { revision: 0.5 }],
      ["a revision as text", { revision: "0" }],
    ])("refuses an edit with %s as invalid", async (_label, revision) => {
      const { app, stores } = setup();
      const id = kind.make(stores);
      const response = await app.request(
        `${kind.path}/${id}`,
        patch({ ...kind.edit("Unsent"), ...revision }),
      );
      expect(response.status).toBe(400);
      expect(kind.revision(stores, id)).toBe(0);
    });

    it("answers 404 for an unknown id whatever the revision", async () => {
      const { app } = setup();
      const response = await app.request(
        `${kind.path}/${crypto.randomUUID()}`,
        patch({ ...kind.edit("Nobody"), revision: 0 }),
      );
      expect(response.status).toBe(404);
    });
  });

  it("starts duplicates and imports at 0; portraits and bindings leave the revision alone", async () => {
    const { app, stores } = setup();
    const character = kinds.character?.make(stores) ?? "";
    const persona = kinds.persona?.make(stores) ?? "";
    stores.characters.update(character, { description: "Edited" }, 0);
    stores.personas.update(persona, { description: "Edited" }, 0);
    const copy = stores.characters.duplicate(character) ?? "";
    expect(stores.characters.get(copy)?.revision).toBe(0);
    expect(stores.personas.get(stores.personas.duplicate(persona) ?? "")?.revision).toBe(0);

    const png = await plainPng();
    for (const path of [`/api/characters/${character}`, `/api/personas/${persona}`]) {
      const uploaded = await app.request(
        `${path}/portrait`,
        formRequest("PUT", fileForm(png, "p.png")),
      );
      expect(uploaded.status).toBe(200);
    }
    expect(stores.personas.bind(character, persona)).toBe(true);
    expect(stores.characters.get(character)?.revision).toBe(1);
    expect(stores.personas.get(persona)?.revision).toBe(1);

    const ids = { prompt: crypto.randomUUID(), sampler: crypto.randomUUID() };
    stores.presets.createPair(defaultPromptPreset("In"), defaultSamplerPreset("In"), ids);
    expect(stores.presets.prompt.get(ids.prompt)?.revision).toBe(0);
    expect(stores.presets.sampler.get(ids.sampler)?.revision).toBe(0);
    const prompt = stores.presets.prompt.duplicate(ids.prompt) ?? "";
    expect(stores.presets.prompt.get(prompt)?.revision).toBe(0);
  });
});
