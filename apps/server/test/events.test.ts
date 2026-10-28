import { randomUUID } from "node:crypto";
import {
  blankCard,
  defaultPromptPreset,
  EVENT_LIMITS,
  type EventFields,
  type EventsState,
  type InspectedPrompt,
  inspectedPromptSchema,
  storedEventSchema,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";
import { catalogEntry, fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  PICK_SEED,
  postJson,
  promptPart,
  requestJson,
  responseParts,
  sharedStores,
  TEST_USER,
  testApp,
} from "./helpers.ts";

const CANARY = "event-canary-3b9e";

const fields = (overrides: Partial<EventFields> = {}): EventFields => ({
  text: `A gull steals {{char}}'s hat. ${CANARY}`,
  chance: 100,
  cooldown: 0,
  enabled: true,
  scope: { kind: "all" },
  ...overrides,
});

/** The app with a pinned random source that counts its draws, and one character. */
function setup(options: { window?: number; random?: number } = {}) {
  const upstream = fakeUpstream({
    chunks: ["Aye."],
    ...(options.window === undefined
      ? {}
      : { catalog: [{ ...catalogEntry("fake-model"), context_window: options.window }] }),
  });
  const draws = { count: 0 };
  const { app, lines, instances } = testApp({
    fetch: upstream.fetch,
    random: () => {
      draws.count += 1;
      return options.random ?? 0;
    },
  });
  const { stores } = instances.instance(TEST_USER);
  const character = stores.characters.create({ ...blankCard("Maren"), tags: ["harbour"] });
  return { app, lines, stores, upstream, draws, character };
}

/** A chat of `replies` exchanges after the greeting, ending with the user's turn. */
const turns = (replies: number) => [
  { role: "assistant", content: "Welcome aboard." },
  ...Array.from({ length: replies }, (_, index) => [
    { role: "user", content: `Line ${index}.` },
    { role: "assistant", content: `Reply ${index}.` },
  ]).flat(),
  { role: "user", content: "Onward." },
];

const body = (characterId: string | undefined, messages: unknown[], extra = {}) => ({
  model: "fake-model",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  ...(characterId === undefined ? {} : { characterId }),
  messages,
  ...extra,
});

async function sent(response: Response): Promise<InspectedPrompt> {
  expect(response.status).toBe(200);
  return promptPart(await responseParts(response));
}

const events = (prompt: InspectedPrompt) =>
  prompt.messages.filter((message) => message.source.kind === "event");

describe("events API", () => {
  it("refuses enabling a migrated blank event without mutation, then accepts text and enable together", async () => {
    const database = openUserDatabase(undefined);
    try {
      const stores = createStores(database.db, createMemoryPortraitFiles());
      const { app, lines } = testApp({ instances: sharedStores(stores) });
      const id = randomUUID();
      stores.events.create(fields(), id);
      database.client
        .query("UPDATE events SET text = '', enabled = 0, revision = 1 WHERE id = ?")
        .run(id);
      const original = stores.events.get(id);
      expect(storedEventSchema.parse(original)).toMatchObject({
        text: "",
        enabled: false,
        revision: 1,
      });
      const refused = await app.request(
        `/api/events/${id}`,
        requestJson("PATCH", { enabled: true, revision: 1 }),
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_request" });
      expect(stores.events.get(id)).toEqual(original);
      const enabled = await app.request(
        `/api/events/${id}`,
        requestJson("PATCH", { text: fields().text, enabled: true, revision: 1 }),
      );
      expect(enabled.status).toBe(200);
      expect(storedEventSchema.parse(await enabled.json())).toMatchObject({
        text: fields().text,
        enabled: true,
        revision: 2,
      });
      expect(lines.join("\n")).not.toContain(CANARY);
    } finally {
      database.close();
    }
  });

  it("creates, lists newest first, edits against the revision and deletes", async () => {
    const { app } = setup();
    const first = randomUUID();
    const second = randomUUID();
    expect(
      (await app.request("/api/events", requestJson("POST", { id: first, ...fields() }))).status,
    ).toBe(201);
    // A retried create makes no second event.
    expect(
      (await app.request("/api/events", requestJson("POST", { id: first, ...fields() }))).status,
    ).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await app.request(
      "/api/events",
      requestJson("POST", { id: second, ...fields({ text: "  Fog.  " }) }),
    );
    const list = (await (await app.request("/api/events", requestJson("GET"))).json()) as {
      events: unknown[];
    };
    const parsed = list.events.map((event) => storedEventSchema.parse(event));
    expect(parsed.map((event) => [event.id, event.text])).toEqual([
      [second, "Fog."],
      [first, fields().text],
    ]);

    const edited = await app.request(
      `/api/events/${first}`,
      requestJson("PATCH", { chance: 2.5, revision: 0 }),
    );
    expect(storedEventSchema.parse(await edited.json())).toMatchObject({
      chance: 2.5,
      revision: 1,
    });
    const stale = await app.request(
      `/api/events/${first}`,
      requestJson("PATCH", { cooldown: 4, revision: 0 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", revision: 1 });
    // The same edit retried after its answer was lost is answered as saved.
    expect(
      (
        await app.request(
          `/api/events/${first}`,
          requestJson("PATCH", { chance: 2.5, revision: 0 }),
        )
      ).status,
    ).toBe(200);

    expect((await app.request(`/api/events/${first}`, requestJson("DELETE"))).status).toBe(204);
    expect((await app.request(`/api/events/${first}`, requestJson("DELETE"))).status).toBe(404);
    const remaining = (await (await app.request("/api/events", requestJson("GET"))).json()) as {
      events: { id: string }[];
    };
    expect(remaining.events.map((event) => event.id)).toEqual([second]);
  });

  it("refuses invalid input without detail", async () => {
    const { app } = setup();
    const characters = Array.from({ length: EVENT_LIMITS.characters + 1 }, () => randomUUID());
    for (const invalid of [
      fields({ text: "One\nTwo" }),
      fields({ text: "x".repeat(EVENT_LIMITS.text + 1) }),
      fields({ chance: 33.33 }),
      fields({ cooldown: EVENT_LIMITS.cooldown + 1 }),
      fields({ scope: { kind: "selected", characters, tags: [] } }),
    ]) {
      const response = await app.request("/api/events", postJson({ id: randomUUID(), ...invalid }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("refuses event 201 with a final answer", async () => {
    const { app, stores } = setup();
    for (let n = 0; n < EVENT_LIMITS.events; n += 1) stores.events.create(fields(), randomUUID());
    const response = await app.request("/api/events", postJson({ id: randomUUID(), ...fields() }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "too_many_events" });
    expect(stores.events.list()).toHaveLength(EVENT_LIMITS.events);
  });
});

describe("events in a generation", () => {
  it("injects one filled event after the latest turn and records it, never logging it", async () => {
    const { app, lines, stores, upstream, character } = setup();
    const id = randomUUID();
    stores.events.create(fields(), id);
    const prompt = await sent(await app.request("/api/chat", postJson(body(character, turns(0)))));
    const injected = events(prompt);
    expect(injected).toHaveLength(1);
    expect(prompt.messages.at(-1)).toMatchObject({
      role: "system",
      content: `[Direction for your next reply: A gull steals Maren's hat. ${CANARY}. Work it into the scene naturally and do not mention this note.]`,
      source: { kind: "event" },
    });
    expect(prompt.eventsState).toEqual({ characterId: character, fired: [{ id, start: 2 }] });
    const upstreamBody = upstream.records[0]?.body as { messages: { content: string }[] };
    expect(upstreamBody.messages.at(-1)?.content).toContain(CANARY);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("holds the event for its cooldown, then fires again; a regenerate rolls again", async () => {
    const { app, stores, character } = setup();
    const id = randomUUID();
    stores.events.create(fields({ cooldown: 2 }), id);
    let state: EventsState | null = null;
    const reply = async (replies: number) => {
      const prompt = await sent(
        await app.request(
          "/api/chat",
          postJson(body(character, turns(replies), state === null ? {} : { eventsState: state })),
        ),
      );
      state = prompt.eventsState ?? null;
      return events(prompt).length;
    };
    expect([await reply(0), await reply(1), await reply(2), await reply(3)]).toEqual([1, 0, 0, 1]);
    expect(state).toEqual({ characterId: character, fired: [{ id, start: 8 }] });
    // Regenerating the reply it fired on: the same history, with the state that reply left.
    expect(await reply(3)).toBe(1);
  });

  it("keeps cooldown after the firing reply was folded, counting folded and live replies", async () => {
    const { app, stores, character } = setup();
    const id = randomUUID();
    stores.events.create(fields({ cooldown: 5 }), id);
    const carried = { characterId: character, fired: [{ id, start: -5, foldedReplies: 2 }] };
    const memoryState = { recap: [], folded: 7, foldedUsers: 3, continued: false };
    const held = await sent(
      await app.request(
        "/api/chat",
        postJson(body(character, turns(1), { eventsState: carried, memoryState })),
      ),
    );
    expect(events(held)).toEqual([]);
    expect(held.eventsState).toEqual(carried);
    const released = await sent(
      await app.request(
        "/api/chat",
        postJson(body(character, turns(2), { eventsState: carried, memoryState })),
      ),
    );
    expect(events(released)).toHaveLength(1);
    expect(released.eventsState).toEqual({ characterId: character, fired: [{ id, start: 6 }] });
  });

  it.each([false, true])(
    "keeps ordinary non-folded event records plain, memory %s",
    async (memory) => {
      const { app, stores, character } = setup();
      const id = randomUUID();
      stores.events.create(fields({ cooldown: 2 }), id);
      const prompt = await sent(
        await app.request(
          "/api/chat",
          postJson(
            body(character, turns(0), {
              ...(memory ? { memoryState: { recap: [], foldedUsers: 0, continued: false } } : {}),
            }),
          ),
        ),
      );
      expect(prompt.eventsState).toEqual({ characterId: character, fired: [{ id, start: 2 }] });
      expect(prompt.eventsState?.fired[0]).not.toHaveProperty("foldedReplies");
    },
  );

  it("injects exactly one of two hits and records only that one", async () => {
    const { app, stores, character } = setup();
    const older = randomUUID();
    const newer = randomUUID();
    stores.events.create(fields({ text: "Older." }), older);
    await new Promise((resolve) => setTimeout(resolve, 2));
    stores.events.create(fields({ text: "Newer." }), newer);
    const prompt = await sent(await app.request("/api/chat", postJson(body(character, turns(0)))));
    // A pinned draw of 0 picks the first hit in list order: the newest.
    expect(events(prompt).map((message) => message.content)).toEqual([
      "[Direction for your next reply: Newer. Work it into the scene naturally and do not mention this note.]",
    ]);
    expect(prompt.eventsState?.fired).toEqual([{ id: newer, start: 2 }]);
  });

  it("injects nothing out of scope, disabled, at 0% or without a character", async () => {
    const { app, stores, character } = setup();
    for (const event of [
      fields({ scope: { kind: "selected", characters: [randomUUID()], tags: ["noir"] } }),
      fields({ enabled: false }),
      fields({ chance: 0 }),
    ]) {
      stores.events.create(event, randomUUID());
    }
    const prompt = await sent(await app.request("/api/chat", postJson(body(character, turns(0)))));
    expect(events(prompt)).toEqual([]);
    // Nothing to carry: the field is left out, so a tab from before events still reads the prompt.
    expect(prompt).not.toHaveProperty("eventsState");

    stores.events.create(fields(), randomUUID());
    const alone = await sent(await app.request("/api/chat", postJson(body(undefined, turns(0)))));
    expect(events(alone)).toEqual([]);
    expect(alone).not.toHaveProperty("eventsState");
  });

  it("leaves the state out once no record stands, so the tab drops the one it held", async () => {
    const { app, stores, character } = setup();
    stores.events.create(fields({ chance: 0 }), randomUUID());
    // The event this record names was deleted since it fired.
    const carried = { characterId: character, fired: [{ id: randomUUID(), start: 2 }] };
    const prompt = await sent(
      await app.request("/api/chat", postJson(body(character, turns(1), { eventsState: carried }))),
    );
    expect(prompt).not.toHaveProperty("eventsState");
  });

  it("matches a chosen tag of the character's card", async () => {
    const { app, stores, character } = setup();
    stores.events.create(
      fields({ scope: { kind: "selected", characters: [], tags: ["harbour"] } }),
      randomUUID(),
    );
    const prompt = await sent(await app.request("/api/chat", postJson(body(character, turns(0)))));
    expect(events(prompt)).toHaveLength(1);
  });

  it("previews without drawing and returns the carried state unchanged", async () => {
    const { app, stores, draws, character } = setup();
    const id = randomUUID();
    stores.events.create(fields(), id);
    const carried = { characterId: character, fired: [{ id, start: 0 }] };
    const response = await app.request(
      "/api/chat/preview",
      postJson(body(character, turns(1), { eventsState: carried })),
    );
    expect(response.status).toBe(200);
    const { prompt } = (await response.json()) as { prompt: unknown };
    const parsed = inspectedPromptSchema.parse(prompt);
    expect(events(parsed)).toEqual([]);
    expect(parsed.eventsState).toEqual(carried);
    expect(draws.count).toBe(0);
  });

  it("keeps the state through Continue and Impersonate, injecting nothing", async () => {
    const { app, stores, draws, character } = setup();
    const id = randomUUID();
    stores.events.create(fields(), id);
    const carried = { characterId: character, fired: [{ id, start: 2 }] };
    const history = turns(1).slice(0, -1);
    for (const mode of ["continue", "impersonate"]) {
      const prompt = await sent(
        await app.request(
          "/api/chat",
          postJson(body(character, history, { mode, eventsState: carried })),
        ),
      );
      expect(events(prompt)).toEqual([]);
      expect(prompt.eventsState).toEqual(carried);
    }
    expect(draws.count).toBe(0);
  });

  it("sends the event last when the preset sends no history", async () => {
    const { app, stores, character } = setup();
    stores.events.create(fields({ text: "Thunder." }), randomUUID());
    const preset = defaultPromptPreset("No history");
    const promptPresetId = stores.presets.prompt.create(
      {
        ...preset,
        blocks: preset.blocks.map((block) =>
          block.kind === "chatHistory" ? { ...block, enabled: false } : block,
        ),
      },
      randomUUID(),
    );
    const prompt = await sent(
      await app.request("/api/chat", postJson(body(character, turns(0), { promptPresetId }))),
    );
    expect(prompt.messages.some((message) => message.source.kind === "history")).toBe(false);
    expect(prompt.messages.at(-1)).toMatchObject({
      role: "system",
      content:
        "[Direction for your next reply: Thunder. Work it into the scene naturally and do not mention this note.]",
      source: { kind: "event" },
    });
    expect(prompt.eventsState?.fired).toHaveLength(1);
  });

  it("never merges with an Author's Note at depth 0, with adjacent system blocks", async () => {
    const { app, stores, character } = setup();
    stores.events.create(fields({ text: "Thunder." }), randomUUID());
    const preset = defaultPromptPreset("Squashed");
    const promptPresetId = stores.presets.prompt.create(
      {
        ...preset,
        authorsNote: {
          enabled: true,
          text: "Note.",
          position: "inChat",
          depth: 0,
          role: "system",
          frequency: 1,
        },
      },
      randomUUID(),
    );
    const prompt = await sent(
      await app.request("/api/chat", postJson(body(character, turns(0), { promptPresetId }))),
    );
    const [note, event] = prompt.messages.slice(-2);
    expect(note).toMatchObject({ content: "Note.", source: { kind: "authorsNote", depth: 0 } });
    expect(note?.merged).toBeUndefined();
    expect(event).toMatchObject({
      content:
        "[Direction for your next reply: Thunder. Work it into the scene naturally and do not mention this note.]",
    });
    expect(event?.merged).toBeUndefined();
  });

  it("delivers no prompt, so no state, when the prompt is too long", async () => {
    const { app, stores, upstream, character } = setup({ window: 5_000 });
    stores.events.create(fields(), randomUUID());
    const long = [{ role: "user", content: "long ".repeat(5_000) }];
    const response = await app.request("/api/chat", postJson(body(character, long)));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "prompt_too_long" });
    expect(upstream.records).toHaveLength(0);
  });
});
