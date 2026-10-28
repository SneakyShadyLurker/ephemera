import { randomUUID } from "node:crypto";
import {
  blankCard,
  CARD_LIMITS,
  type CharacterCard,
  defaultPromptPreset,
  fillChatText,
  inspectedPromptSchema,
  type LorebookEntry,
  MAX_CHAT_BODY_BYTES,
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
  promptPart,
  responseParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";

const CANARY = "lore-canary-5f3a";

function setup() {
  const upstream = fakeUpstream({ chunks: ["Aye."] });
  const { app, lines, instances } = testApp({ fetch: upstream.fetch });
  const { stores } = instances.instance(TEST_USER);
  return { app, lines, stores, upstream };
}

const entry = (overrides: Partial<LorebookEntry>): LorebookEntry => ({
  keys: [],
  content: "",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const withBook = (entries: LorebookEntry[]): CharacterCard => ({
  ...blankCard("Maren Vey"),
  description: "Keeper of the Skerry light.",
  lorebook: { entries },
});

const request = (characterId: string, content: string) => ({
  model: "fake-model",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  characterId,
  messages: [{ role: "user", content }],
});

describe("lorebook in a generation", () => {
  it("activates the same lore for a serialized generated display and literal story, retaining raw regeneration semantics", async () => {
    const raw = "{{getvar::place}} {{incvar::visits}}";
    const macroState = { local: { place: "Harbor" }, global: {} };
    const upstream = fakeUpstream({ chunks: [raw] });
    const { app, instances, lines } = testApp({ fetch: upstream.fetch, random: () => 0 });
    const { stores } = instances.instance(TEST_USER);
    const character = withBook([entry({ keys: ["Harbor"], content: "HARBOR_LORE" })]);
    const id = stores.characters.create(character);
    const first = await responseParts(
      await app.request("/api/chat", postJson({ ...request(id, "Begin."), macroState })),
    );
    const output = first
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(output).toBe(raw);
    const filled = fillChatText(output, {
      character,
      persona: null,
      preset: defaultPromptPreset(),
      history: [],
      clock: CLOCK,
      pickSeed: PICK_SEED,
      random: () => 0,
      macroState,
    });
    expect(filled.content).toBe("Harbor 1");
    const assistant = {
      role: "assistant",
      content: raw,
      macroEligible: true,
      scanText: filled.content,
    };
    for (const turn of [assistant, { role: "assistant", content: filled.content }]) {
      const payload = {
        ...request(id, "Go on."),
        macroState: filled.macroState,
        messages: [{ role: "user", content: "Begin." }, turn, { role: "user", content: "Go on." }],
      };
      const prompt = promptPart(
        await responseParts(await app.request("/api/chat", postJson(payload))),
      );
      expect(prompt.lorebook?.entries[0]?.status).toBe("sent");
      expect(prompt.messages.some(({ content }) => content === "HARBOR_LORE")).toBe(true);
    }
    const sent = (index: number) =>
      (
        upstream.records[index]?.body as
          | { messages: { role: string; content: string }[] }
          | undefined
      )?.messages ?? [];
    expect(sent(1).find((message) => message.role === "assistant")?.content).toBe("Harbor 2");
    expect(sent(2).find((message) => message.role === "assistant")?.content).toBe("Harbor 1");
    expect(lines.join("\n")).not.toContain(raw);
    expect(lines.join("\n")).not.toContain(filled.content);
  });

  it("counts scan text toward the existing total request body cap", async () => {
    const { app, upstream } = setup();
    const half = "x".repeat(MAX_CHAT_BODY_BYTES / 2);
    const payload = {
      model: "fake-model",
      clock: CLOCK,
      messages: [
        { role: "assistant", content: half, macroEligible: true, scanText: half },
        { role: "user", content: "Next" },
      ],
    };
    const response = await app.request("/api/chat", postJson(payload));
    expect(response.status).toBe(413);
    expect(upstream.records).toHaveLength(0);
  });
  it("reports only fitted example contributions in previews and generation", async () => {
    const { app, stores, upstream } = setup();
    stores.settings.update({ contextLimits: { "fake-model": 8_192 } });
    const id = stores.characters.create(
      withBook([
        entry({
          constant: true,
          content: "User: LORE_SENTINEL",
          settings: { placement: "examplesTop", cooldown: 10 },
        }),
      ]),
    );
    const payload = {
      ...request(id, "Hello."),
      messages: [
        { role: "assistant", content: "Older turn. ".repeat(8_000) },
        { role: "user", content: "Hello." },
      ],
    };
    const response = await app.request("/api/chat/preview", postJson(payload));
    expect(response.status).toBe(200);
    const preview = inspectedPromptSchema.parse(
      ((await response.json()) as { prompt: unknown }).prompt,
    );
    const generated = promptPart(
      await responseParts(await app.request("/api/chat", postJson(payload))),
    );
    for (const prompt of [preview, generated]) {
      expect(prompt.history.sent).toBe(1);
      expect(prompt.messages.some(({ content }) => content.includes("LORE_SENTINEL"))).toBe(false);
      expect(prompt.lorebook?.counts).toMatchObject({ sent: 0, doesNotFit: 1 });
      expect(prompt.lorebookState?.effects).toEqual([]);
    }
    const body = upstream.records[0]?.body as { messages: { content: string }[] };
    expect(body.messages.some(({ content }) => content.includes("LORE_SENTINEL"))).toBe(false);
  });

  it("starts no depth effect when the selected preset disables the history host", async () => {
    const { app, stores } = setup();
    const id = stores.characters.create(
      withBook([
        entry({
          constant: true,
          content: "DEPTH_SENTINEL",
          settings: { placement: "depth", cooldown: 10 },
        }),
      ]),
    );
    const preset = defaultPromptPreset();
    const promptPresetId = stores.presets.prompt.create(
      {
        ...preset,
        blocks: preset.blocks.map((block) =>
          block.kind === "chatHistory" ? { ...block, enabled: false } : block,
        ),
      },
      randomUUID(),
    );
    const prompt = promptPart(
      await responseParts(
        await app.request("/api/chat", postJson({ ...request(id, "Hello."), promptPresetId })),
      ),
    );
    expect(prompt.messages.some(({ content }) => content.includes("DEPTH_SENTINEL"))).toBe(false);
    expect(prompt.lorebook?.counts).toMatchObject({ sent: 0, blockOff: 1 });
    expect(prompt.lorebookState?.effects).toEqual([]);
  });

  it("sends activated entries in their block, reports them, and never logs them", async () => {
    const { app, lines, stores, upstream } = setup();
    const id = stores.characters.create(
      withBook([
        entry({ keys: ["lantern"], content: "The Grey Lantern is an oil lamp." }),
        entry({ keys: ["bell"], content: "Never sent." }),
      ]),
    );
    const prompt = promptPart(
      await responseParts(
        await app.request("/api/chat", postJson(request(id, `The lantern ${CANARY}`))),
      ),
    );
    const body = upstream.records[0]?.body as { messages: { content: string }[] };
    expect(body.messages.map((m) => m.content)).toContain("The Grey Lantern is an oil lamp.");
    expect(body.messages.map((m) => m.content)).not.toContain("Never sent.");
    expect(prompt.lorebook?.counts).toMatchObject({ sent: 1, notMatched: 1 });
    expect(prompt.lorebook?.entries[0]?.reason).toEqual({
      kind: "key",
      key: "lantern",
      matched: "lantern",
    });
    // The budget is a quarter of the model's window; the tokens are the calibrated estimate.
    expect(prompt.lorebook?.budget).toBe(Math.floor(131_072 / 4));
    expect(prompt.lorebook?.entries[0]?.tokens).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain("Grey Lantern");
  });

  it("previews the same activation without calling the model", async () => {
    const { app, stores, upstream } = setup();
    const id = stores.characters.create(withBook([entry({ constant: true, content: "Tide." })]));
    const response = await app.request("/api/chat/preview", postJson(request(id, "Hello.")));
    expect(response.status).toBe(200);
    const { prompt } = (await response.json()) as { prompt: unknown };
    const parsed = inspectedPromptSchema.parse(prompt);
    expect(parsed.lorebook?.entries[0]).toMatchObject({
      status: "sent",
      reason: { kind: "constant" },
    });
    expect(upstream.records).toHaveLength(0);
  });

  it("reports no lorebook for a character without one", async () => {
    const { app, stores } = setup();
    const id = stores.characters.create(blankCard("Plain"));
    const prompt = promptPart(
      await responseParts(await app.request("/api/chat", postJson(request(id, "Hi.")))),
    );
    expect(prompt.lorebook).toBeNull();
  });
});

describe("the lorebook's timed state", () => {
  const STICKY = `Sticky lamp ${CANARY}.`;
  const sticky = entry({ keys: ["lantern"], content: STICKY, settings: { sticky: 3 } });
  const later = [
    { role: "user", content: "The lantern." },
    { role: "assistant", content: "Aye." },
    { role: "user", content: "Quiet now." },
  ];
  const sentTexts = (body: unknown) =>
    (body as { messages: { content: string }[] }).messages.map((m) => m.content);

  it("comes back on the prompt part and, sent with the next request, keeps a sticky entry", async () => {
    const { app, lines, stores, upstream } = setup();
    const id = stores.characters.create(withBook([sticky]));
    const first = promptPart(
      await responseParts(await app.request("/api/chat", postJson(request(id, "The lantern.")))),
    );
    const state = first.lorebookState;
    expect(state).toEqual({
      characterId: id,
      effects: [{ index: 0, digest: expect.stringMatching(/^[0-9a-f]+$/), start: 1 }],
    });

    const next = promptPart(
      await responseParts(
        await app.request(
          "/api/chat",
          postJson({ ...request(id, ""), messages: later, lorebookState: state }),
        ),
      ),
    );
    expect(sentTexts(upstream.records[1]?.body)).toContain(STICKY);
    expect(next.lorebook?.entries[0]?.reason).toEqual({ kind: "sticky", left: 1 });
    expect(next.lorebookState).toEqual(state);

    // Without the state, the same chat reads the entry by its keys alone.
    await (
      await app.request("/api/chat", postJson({ ...request(id, ""), messages: later }))
    ).text();
    expect(sentTexts(upstream.records[2]?.body)).not.toContain(STICKY);

    const log = lines.join("\n");
    for (const text of [CANARY, "lorebookState", "effects", state?.effects[0]?.digest ?? "?"]) {
      expect(log).not.toContain(text);
    }
  });

  it("round-trips through the preview, which calls no model", async () => {
    const { app, stores, upstream } = setup();
    const id = stores.characters.create(withBook([sticky]));
    const preview = async (body: unknown) => {
      const response = await app.request("/api/chat/preview", postJson(body));
      expect(response.status).toBe(200);
      const { prompt } = (await response.json()) as { prompt: unknown };
      return inspectedPromptSchema.parse(prompt);
    };
    const first = await preview(request(id, "The lantern."));
    expect(first.lorebookState?.effects).toHaveLength(1);
    const next = await preview({
      ...request(id, ""),
      messages: later,
      lorebookState: first.lorebookState,
    });
    expect(next.lorebook?.entries[0]).toMatchObject({
      status: "sent",
      reason: { kind: "sticky", left: 1 },
    });
    expect(next.lorebookState).toEqual(first.lorebookState);
    expect(upstream.records).toHaveLength(0);
  });

  it("is null for a character without a book", async () => {
    const { app, stores } = setup();
    const id = stores.characters.create(blankCard("Plain"));
    const prompt = promptPart(
      await responseParts(await app.request("/api/chat", postJson(request(id, "Hi.")))),
    );
    expect(prompt.lorebookState).toBeNull();
  });

  it("refuses malformed or oversized state with 400, without echoing it", async () => {
    const { app, lines, stores, upstream } = setup();
    const id = stores.characters.create(withBook([sticky]));
    const effect = (index: number) => ({ index, digest: "a1b2c3", start: 1 });
    const malformed = [
      { characterId: id, effects: [{ ...effect(0), start: "one" }] },
      { characterId: id, effects: [{ ...effect(0), text: CANARY }] },
      { characterId: "not-a-uuid", effects: [] },
      { characterId: id, effects: [effect(0), effect(0)] },
      { characterId: id, effects: [{ ...effect(0), digest: CANARY }] },
    ];
    const oversized = {
      characterId: id,
      effects: Array.from({ length: CARD_LIMITS.lorebookEntries + 1 }, (_, i) => effect(i)),
    };
    // The largest state a request may carry is well inside the body cap, so the
    // schema, not the cap, refuses one past it.
    expect(JSON.stringify(oversized).length).toBeLessThan(MAX_CHAT_BODY_BYTES / 10);
    for (const lorebookState of [...malformed, oversized]) {
      for (const route of ["/api/chat", "/api/chat/preview"]) {
        const response = await app.request(
          route,
          postJson({ ...request(id, "The lantern."), lorebookState }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_request" });
      }
    }
    expect(upstream.records).toHaveLength(0);
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain("a1b2c3");
  });
});

describe("editing the lorebook", () => {
  const patch = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: ownerHeaders(),
    body: JSON.stringify(body),
  });

  it("saves the whole book, keeping fields Ephemera does not edit, and null removes it", async () => {
    const { app, stores } = setup();
    const id = stores.characters.create(blankCard("Maren Vey"));
    const book = {
      scanDepth: 4,
      recursiveScanning: true,

      entries: [
        entry({
          keys: ["Tobin"],
          content: "Her brother.",
          secondaryKeys: ["drowned"],
          selective: true,
          insertionOrder: 3,
          settings: { depth: 4 },
        }),
      ],
    };
    const saved = await app.request(
      `/api/characters/${id}`,
      patch({ lorebook: book, revision: 0 }),
    );
    expect(saved.status).toBe(200);
    expect(stores.characters.get(id)?.card.lorebook).toEqual(book);

    const removed = await app.request(
      `/api/characters/${id}`,
      patch({ lorebook: null, revision: 1 }),
    );
    expect(removed.status).toBe(200);
    expect(stores.characters.get(id)?.card.lorebook).toBeUndefined();
  });

  it("refuses a malformed book", async () => {
    const { app, stores } = setup();
    const id = stores.characters.create(blankCard("Maren Vey"));
    const bad = { entries: [{ keys: "not a list" }] };
    expect(
      (await app.request(`/api/characters/${id}`, patch({ lorebook: bad, revision: 0 }))).status,
    ).toBe(400);
  });
});

describe("importing a card with a lorebook", () => {
  it("reports unsupported foreign lorebook features while converting recognized settings", async () => {
    const { app } = setup();
    const card = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Maren Vey",
        character_book: {
          recursive_scanning: true,
          entries: [
            {
              keys: ["a"],
              content: "x",
              secondary_keys: ["b"],
              priority: 1,
              extensions: { probability: 50, useProbability: true },
            },
          ],
        },
      },
    };
    const response = await app.request(
      "/api/characters/import",
      formRequest("POST", fileForm(JSON.stringify(card), "maren.json")),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      name: "Maren Vey",
      report: { skipped: expect.arrayContaining([expect.stringContaining("priority")]) },
    });
  });
});

describe("library lorebooks linked to a character", () => {
  const LINKED = `Harbour lamp ${CANARY}.`;
  const contents = (body: unknown) =>
    (body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
  const harbour = (stores: ReturnType<typeof setup>["stores"], entries: LorebookEntry[]) =>
    stores.lorebooks.create({ name: "Harbour", book: { entries } }, randomUUID());

  it("sends a linked book's entry for its character, with the card's own book, and not for another", async () => {
    const { app, lines, stores, upstream } = setup();
    const book = harbour(stores, [entry({ keys: ["lantern"], content: LINKED })]);
    const linked = stores.characters.create(
      withBook([entry({ keys: ["lantern"], content: "The card's own lamp." })]),
    );
    const other = stores.characters.create(blankCard("Other"));
    stores.lorebooks.link(book, linked);

    const prompt = promptPart(
      await responseParts(
        await app.request("/api/chat", postJson(request(linked, "The lantern."))),
      ),
    );
    expect(contents(upstream.records[0]?.body)).toContain(LINKED);
    expect(contents(upstream.records[0]?.body)).toContain("The card's own lamp.");
    expect(prompt.lorebook?.sources).toEqual([
      { id: null, name: "", count: 1 },
      { id: book, name: "Harbour", count: 1 },
    ]);

    await (await app.request("/api/chat", postJson(request(other, "The lantern.")))).text();
    expect(contents(upstream.records[1]?.body)).not.toContain(LINKED);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("activates linked books for a character whose card has none", async () => {
    const { app, stores } = setup();
    const book = harbour(stores, [entry({ constant: true, content: LINKED })]);
    const id = stores.characters.create(blankCard("Plain"));
    stores.lorebooks.link(book, id);
    const response = await app.request("/api/chat/preview", postJson(request(id, "Hello.")));
    const { prompt } = (await response.json()) as { prompt: unknown };
    const parsed = inspectedPromptSchema.parse(prompt);
    expect(parsed.lorebook?.sources).toEqual([{ id: book, name: "Harbour", count: 1 }]);
    expect(parsed.messages.map((m) => m.content).join("\n")).toContain(LINKED);
  });

  it("rolls a linked entry's chance with the request's random source", async () => {
    const byChance = entry({
      constant: true,
      content: LINKED,
      settings: { useProbability: true, probability: 40 },
    });
    const run = async (roll: number) => {
      const upstream = fakeUpstream({ chunks: ["Aye."] });
      const { app, instances } = testApp({ fetch: upstream.fetch, random: () => roll });
      const { stores } = instances.instance(TEST_USER);
      const id = stores.characters.create(blankCard("Plain"));
      stores.lorebooks.link(harbour(stores, [byChance]), id);
      const prompt = promptPart(
        await responseParts(await app.request("/api/chat", postJson(request(id, "Hello.")))),
      );
      return { prompt, sent: contents(upstream.records[0]?.body) };
    };
    const hit = await run(0.39);
    expect(hit.sent).toContain(LINKED);
    expect(hit.prompt.lorebook?.entries[0]).toMatchObject({ status: "sent" });
    const miss = await run(0.4);
    expect(miss.sent).not.toContain(LINKED);
    expect(miss.prompt.lorebook?.entries[0]).toMatchObject({ status: "chanceMissed" });
  });
});
