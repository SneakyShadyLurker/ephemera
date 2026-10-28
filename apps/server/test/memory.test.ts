import { randomUUID } from "node:crypto";
import {
  blankCard,
  blankLorebook,
  type CharacterCard,
  type ChatMemoryState,
  CONTINUED_SCENE,
  CREATOR_LIMITS,
  defaultPromptPreset,
  type EventsState,
  inspectedPromptSchema,
  type LorebookEntry,
  type LorebookState,
  MAX_CHAT_TURNS,
  MEMORY_LIMITS,
  type MemoryAnswer,
  type MemoryOutput,
  memoryStateSchema,
  NEW_SCENE,
  openingResponseSchema,
  promptBudget,
  RECAP_IDS,
  rememberRefusalSchema,
  rememberResponseSchema,
  replyReserve,
  storedEpisodeSchema,
} from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import { KEEPALIVE_INTERVAL_MS } from "../src/keepalive.ts";
import { KEPT_ATTEMPTS } from "../src/memory.ts";
import type { Stores } from "../src/persistence/index.ts";
import { countMessage, countText, PRIMING } from "../src/tokens.ts";
import { type CatalogEntry, catalogEntry, type FakeTurn, fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  ownerHeaders,
  PICK_SEED,
  postJson,
  promptPart,
  responseParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";
import { until } from "./vitest-helpers.ts";

const SPAN_CANARY = "span-canary-71c4";
const BODY_CANARY = "upstream-body-canary-5e2a";

const object: MemoryOutput = {
  title: "The storm at the harbour",
  summary: "Maren and Ilse waited out the storm in the boathouse.",
  cues: ["boathouse", "storm"],
  notebook: {
    situation: "The storm has passed.",
    relationships: ["Maren and Ilse: closer after the storm."],
    facts: ["Maren owns the boathouse."],
    threads: ["Who cut the mooring line?"],
    cast: [],
  },
  opening: "",
};
/** The model's answer that writes `object` over an empty notebook: every line added. */
const reply: MemoryAnswer = {
  title: object.title,
  summary: object.summary,
  cues: object.cues,
  notebook: {
    situation: object.notebook.situation,
    relationships: { change: [], drop: [], add: object.notebook.relationships },
    facts: { change: [], drop: [], add: object.notebook.facts },
    threads: { change: [], drop: [], add: object.notebook.threads },
    cast: { change: [], drop: [], add: [] },
  },
  opening: object.opening,
};
const chapterObject = { title: "Part one", summary: "The early days.", cues: ["harbour"] };

const answer = (value: unknown): FakeTurn => ({ chunks: [JSON.stringify(value)] });
/** A call the provider refuses: never retried. */
const failure: FakeTurn = { failWith: { status: 400, body: BODY_CANARY } };
/** A busy provider that asks for no wait, so the AI SDK's retries run at once. */
const busy = (status: 429 | 503): FakeTurn => ({
  failWith: { status, body: BODY_CANARY, headers: { "Retry-After": "0" } },
});
/** An answer with no JSON object in it. */
const unusable: FakeTurn = { chunks: [`I cannot. ${BODY_CANARY}`] };

/**
 * The app over a fake upstream whose completions answer `turns` in order;
 * `before` runs as a completion arrives, before it is answered.
 */
function setup(
  turns: FakeTurn[],
  options: {
    before?: (stores: Stores) => Promise<void> | void;
    enabled?: boolean;
    card?: CharacterCard;
    random?: () => number;
    catalog?: CatalogEntry[];
  } = {},
) {
  const upstream = fakeUpstream({
    turns,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  let calls = 0;
  let stores: Stores | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/chat/completions")) {
      calls += 1;
      if (stores !== undefined) await options.before?.(stores);
      // As a real fetch: a call aborted while held never reaches the provider.
      init?.signal?.throwIfAborted();
    }
    return upstream.fetch(input, init);
  };
  const { app, lines, instances } = testApp({
    fetch,
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  stores = instances.instance(TEST_USER).stores;
  const characterId = stores.characters.create(options.card ?? blankCard("Maren"));
  // Memory is on for every character until its owner turns it off.
  if (options.enabled === false) stores.memory.setState(characterId, { enabled: false }, 0);
  return { app, lines, stores, upstream, characterId, calls: () => calls };
}

const span = [
  { role: "user" as const, content: `We should check the boathouse. ${SPAN_CANARY}` },
  { role: "assistant" as const, content: "Maren pulled on her coat." },
];

const request = (characterId: string, extra: Record<string, unknown> = {}) => ({
  characterId,
  model: "fake-model",
  turns: span,
  episodes: [],
  held: [],
  attempt: randomUUID(),
  ...extra,
});

const remember = (app: ReturnType<typeof setup>["app"], body: unknown) =>
  app.request("/api/memory/remember", postJson(body));

it("passes validated cast context to the archivist without copying it to persisted memory or logs", async () => {
  const { app, upstream, stores, lines, characterId } = setup([answer(reply)]);
  const canary = "grounded-cast-context-95c2";
  const castContext = [
    {
      anchor: { name: "Ilse", gender: "female", hair: canary },
      continuity: {
        voice: "calls Maren captain",
        goals: "return to harbour",
        knowledge: "does not know about the letter",
      },
    },
  ];
  const response = await remember(app, request(characterId, { castContext }));
  const body = rememberResponseSchema.parse(await response.json());
  const sent = JSON.stringify(upstream.records[0]?.body);
  expect(sent).toContain(canary);
  expect(sent).toContain("calls Maren captain");
  expect(sent).toContain("facts or relationships");
  expect(body.notebook.notebook).toEqual(object.notebook);
  expect(
    JSON.stringify([stores.memory.state(characterId), stores.memory.list(characterId), lines]),
  ).not.toContain(canary);
  for (const extra of [{ id: randomUUID() }, { aka: ["Alias"] }, { state: { present: true } }]) {
    const invalid = await remember(
      app,
      request(characterId, { castContext: [{ ...castContext[0], ...extra }] }),
    );
    expect(invalid.status).toBe(400);
  }
});

/** Seeds `count` episodes for the character and returns their ids. */
function seed(stores: Stores, characterId: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const written = stores.memory.remember(characterId, {
      output: { ...object, title: `Episode ${index}` },
      turns: 2,
      notebookRevision: -1,
    });
    if (typeof written === "string") throw new Error(written);
    return written.episode.id;
  });
}

/**
 * Seeds `count` episodes, titled "Buried 0" on, merged into one chapter: the
 * chapter is told before the chat, and its members, each with the boathouse
 * cue, stay recall candidates.
 */
function bury(stores: Stores, characterId: string, count = 2): string[] {
  const ids = Array.from({ length: count }, (_, index) => {
    const written = stores.memory.remember(characterId, {
      output: { ...object, title: `Buried ${index}` },
      turns: 2,
      notebookRevision: -1,
    });
    if (typeof written === "string") throw new Error(written);
    return written.episode.id;
  });
  const members = ids.map((id) => {
    const stored = stores.memory.get(id);
    if (stored === undefined) throw new Error("missing");
    return { id, revision: stored.revision, chapterId: stored.chapterId };
  });
  const chapter = stores.memory.chapter(characterId, {
    output: { ...chapterObject, title: "Buried chapter" },
    members,
  });
  if (typeof chapter === "string") throw new Error(chapter);
  return ids;
}

/**
 * Seeds four episodes, the first two merged into a chapter that a second
 * chapter merged with the third: a recap naming them is stale.
 */
function nest(stores: Stores, characterId: string) {
  const [e1 = "", e2 = "", e3 = "", e4 = ""] = seed(stores, characterId, 4);
  const merge = (ids: string[], title: string) => {
    const members = ids.map((id) => {
      const stored = stores.memory.get(id);
      if (stored === undefined) throw new Error("missing");
      return { id, revision: stored.revision, chapterId: stored.chapterId };
    });
    const chapter = stores.memory.chapter(characterId, {
      output: { ...chapterObject, title },
      members,
    });
    if (typeof chapter === "string") throw new Error(chapter);
    return chapter.id;
  };
  const inner = merge([e1, e2], "Inner chapter");
  const outer = merge([inner, e3], "Outer chapter");
  return { stale: [e1, e2, e3, e4], inner, outer, e4 };
}

const noCanary = (lines: string[]) => {
  for (const line of lines) {
    expect(line).not.toContain(SPAN_CANARY);
    expect(line).not.toContain(BODY_CANARY);
    expect(line).not.toContain(object.summary);
  }
};

describe("memory API", () => {
  it.each(["book lookup", "chapter write"] as const)(
    "keeps the committed episode and receipts after an optional %s exception",
    async (fault) => {
      const { app, stores, lines, characterId, calls, upstream } = setup([
        answer(reply),
        answer(chapterObject),
      ]);
      const recap =
        fault === "chapter write" ? seed(stores, characterId, MEMORY_LIMITS.recapCount + 1) : [];
      const persist = stores.memory.remember.bind(stores.memory);
      const write = vi.spyOn(stores.memory, "remember").mockImplementationOnce((...args) => {
        const stored = persist(...args);
        // Fail only after the real store has committed the episode and notebook.
        if (fault === "book lookup") {
          vi.spyOn(stores.memory, "list").mockImplementationOnce(() => {
            throw new TypeError(BODY_CANARY);
          });
        }
        return stored;
      });
      if (fault === "chapter write") {
        vi.spyOn(stores.memory, "chapter").mockImplementationOnce(() => {
          throw new TypeError(BODY_CANARY);
        });
      }
      const body = request(characterId, { episodes: recap });
      const ask = () => app.request("/api/memory/remember", postJson(body));
      const first = rememberResponseSchema.parse(await (await ask()).json());
      expect(first.episode.title).toBe(reply.title);
      expect(first.notebook).toEqual(stores.memory.state(characterId));
      expect(first.chapter).toBeUndefined();
      expect(first.recap).toEqual(recap);
      expect(first.accounting?.calls.map((call) => call.purpose)).toEqual(
        fault === "book lookup" ? ["memory.remember"] : ["memory.remember", "memory.chapter"],
      );
      expect(first.accounting?.calls.every((call) => call.status === "completed")).toBe(true);
      const replay = rememberResponseSchema.parse(await (await ask()).json());
      expect(replay).toEqual(first);
      expect(write).toHaveBeenCalledTimes(1);
      expect(calls()).toBe(fault === "book lookup" ? 1 : 2);
      expect(
        upstream.records.filter((record) => JSON.stringify(record.body).includes(SPAN_CANARY)),
      ).toHaveLength(1);
      const book = stores.memory.list(characterId);
      expect(book).toHaveLength(recap.length + 1);
      expect(book.filter((episode) => episode.title === reply.title)).toHaveLength(1);
      expect(book.some((episode) => episode.kind === "chapter")).toBe(false);
      const persisted = JSON.stringify([book, stores.memory.state(characterId)]);
      for (const call of first.accounting?.calls ?? []) expect(persisted).not.toContain(call.id);
      expect(persisted).not.toContain(body.attempt);
      expect(persisted).not.toContain(SPAN_CANARY);
      expect(lines.map((line) => JSON.parse(line))).toContainEqual({
        time: expect.any(String),
        level: "error",
        event: "memory.chapter.error",
        model: "fake-model",
        errorClass: "TypeError",
      });
      noCanary(lines);
    },
  );

  it("retries the same attempt after a store exception before the episode commits", async () => {
    const { app, stores, lines, characterId, calls } = setup([answer(reply), answer(reply)]);
    vi.spyOn(stores.memory, "remember").mockImplementationOnce(() => {
      throw new TypeError(BODY_CANARY);
    });
    const body = request(characterId);
    expect(await (await remember(app, body)).json()).toMatchObject({ error: "memory_failed" });
    expect(stores.memory.list(characterId)).toEqual([]);
    const retried = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(retried.episode.title).toBe(reply.title);
    expect(stores.memory.list(characterId)).toHaveLength(1);
    expect(calls()).toBe(2);
    noCanary(lines);
  });

  it("returns stable memory and chapter receipts on idempotent replay without persisting metadata", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply), answer(chapterObject)]);
    stores.settings.update({ memoryRecapTokens: 1_000 });
    const recap = seed(stores, characterId, 4);
    for (const id of recap)
      stores.memory.update(
        id,
        { summary: "w".repeat(3_000) },
        stores.memory.get(id)?.revision ?? 0,
      );
    const body = request(characterId, { episodes: recap });
    const ask = () => app.request("/api/memory/remember", postJson(body));
    const first = rememberResponseSchema.parse(await (await ask()).json());
    expect(first.accounting?.calls.map((call) => call.purpose)).toEqual([
      "memory.remember",
      "memory.chapter",
    ]);
    const second = rememberResponseSchema.parse(await (await ask()).json());
    expect(second.accounting).toEqual(first.accounting);
    expect(calls()).toBe(2);
    const persisted = JSON.stringify([
      stores.memory.state(characterId),
      stores.memory.list(characterId),
    ]);
    for (const call of first.accounting?.calls ?? []) expect(persisted).not.toContain(call.id);
    expect(persisted).not.toContain(body.attempt);
  });

  it("accounts for opening calls", async () => {
    const { app, stores, characterId } = setup([
      answer({ opening: "A new day." }),
      answer({ opening: "Another day." }),
    ]);
    seed(stores, characterId, 1);
    const path = `/api/memory/characters/${characterId}/opening`;
    const first = openingResponseSchema.parse(
      await (await app.request(path, postJson({ model: "fake-model" }))).json(),
    );
    expect(first.accounting?.calls.map((call) => call.purpose)).toEqual(["memory.opening"]);
  });
  it("answers every notebook response with its cast", async () => {
    const { app, stores, characterId } = setup([]);
    const path = `/api/memory/characters/${characterId}`;
    const cast = [JSON.stringify({ name: "Ilse Brandt", gender: "female", hair: "black bob" })];
    const notebook = { ...object.notebook, cast };
    const saved = await app.request(path, {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ notebook, revision: 0 }),
    });
    expect(await saved.json()).toHaveProperty("notebook.cast", cast);
    expect(stores.memory.state(characterId)?.notebook.cast).toEqual(cast);
    expect(await (await app.request(path, { headers: ownerHeaders() })).json()).toHaveProperty(
      "state.notebook.cast",
      cast,
    );
    const forgotten = await app.request(path, { method: "DELETE", headers: ownerHeaders() });
    expect(await forgotten.json()).toHaveProperty("state.notebook.cast", []);
  });

  it("replays a remembered cast with the memory", async () => {
    const cast = [JSON.stringify({ name: "Ilse Brandt", gender: "female", hair: "black bob" })];
    const model = {
      ...reply,
      notebook: { ...reply.notebook, cast: { change: [], drop: [], add: cast } },
    };
    const { app, stores, characterId, calls } = setup([answer(model)]);
    const body = request(characterId);
    const written = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(written.notebook.notebook.cast).toEqual(cast);
    const replay = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(replay.episode.id).toBe(written.episode.id);
    expect(replay.notebook.notebook.cast).toEqual(cast);
    expect(stores.memory.state(characterId)?.notebook.cast).toEqual(cast);
    expect(calls()).toBe(1);
  });

  it("reads, turns off and on, edits and forgets a character's memory, keeping on or off", async () => {
    const { app, stores } = setup([]);
    const characterId = stores.characters.create(blankCard("Ilse"));
    const path = `/api/memory/characters/${characterId}`;
    const read = async () =>
      (await (
        await app.request(path, {
          headers: ownerHeaders(),
        })
      ).json()) as {
        state: unknown;
        episodes: unknown[];
      };
    expect(await read()).toEqual({ state: null, episodes: [] });

    const patch = (body: unknown) =>
      app.request(path, { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify(body) });
    // No row yet: memory is on, and turning it off creates the row at revision 1.
    const off = await patch({ enabled: false, revision: 0 });
    expect(off.status).toBe(200);
    expect(memoryStateSchema.parse(await off.json())).toMatchObject({
      enabled: false,
      revision: 1,
    });
    const on = await patch({ enabled: true, revision: 1 });
    expect(memoryStateSchema.parse(await on.json())).toMatchObject({ enabled: true, revision: 2 });
    const notebook = {
      situation: "Quiet.",
      relationships: ["Maren and Wren: neighbours, on good terms."],
      facts: [],
      threads: [],
      cast: [],
    };
    expect((await patch({ notebook, revision: 2 })).status).toBe(200);
    expect((await read()).state).toMatchObject({ notebook });
    expect(await (await patch({ enabled: false, revision: 2 })).json()).toEqual({
      error: "conflict",
      revision: 3,
    });
    // A notebook edit against revision 0 creates the row of a character without one.
    const fresh = stores.characters.create(blankCard("Wren"));
    const first = await app.request(`/api/memory/characters/${fresh}`, {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ notebook, revision: 0 }),
    });
    expect(memoryStateSchema.parse(await first.json())).toMatchObject({
      enabled: true,
      notebook,
      revision: 1,
    });

    seed(stores, characterId, 1);
    const [episode] = (await read()).episodes;
    const episodePath = `/api/memory/episodes/${storedEpisodeSchema.parse(episode).id}`;
    const edited = await app.request(episodePath, {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ pinned: true, revision: 0 }),
    });
    expect(storedEpisodeSchema.parse(await edited.json()).pinned).toBe(true);

    // Forget answers with the memory as it left it: the emptied notebook at its real revision.
    const forget = await app.request(path, { method: "DELETE", headers: ownerHeaders() });
    expect(forget.status).toBe(200);
    const answered = (await forget.json()) as { state: unknown; episodes: unknown[] };
    expect(answered.episodes).toEqual([]);
    expect(memoryStateSchema.parse(answered.state)).toMatchObject({
      enabled: true,
      notebook: { situation: "", facts: [], threads: [] },
      revision: 4,
    });
    expect(await read()).toEqual({ ...answered, state: memoryStateSchema.parse(answered.state) });
    // A character without a notebook row keeps none: the answer says so.
    const forgetFresh = await app.request(`/api/memory/characters/${fresh}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(forgetFresh.status).toBe(200);
    expect(((await forgetFresh.json()) as { state: unknown }).state).toMatchObject({
      revision: 2,
    });
    const rowless = stores.characters.create(blankCard("Ada"));
    const forgetRowless = await app.request(`/api/memory/characters/${rowless}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(await forgetRowless.json()).toEqual({ state: null, episodes: [] });
    const missing = `/api/memory/characters/${randomUUID()}`;
    expect((await app.request(missing, { headers: ownerHeaders() })).status).toBe(404);
  });

  it("edits the next chat's opening as the owner typed it, and forgets it with the notebook", async () => {
    const { app, stores, characterId } = setup([]);
    const path = `/api/memory/characters/${characterId}`;
    const patch = (body: unknown) =>
      app.request(path, { method: "PATCH", headers: ownerHeaders(), body: JSON.stringify(body) });
    const typed = "Location: Ashore\nMaren waits for {{user}}.";
    const saved = await patch({ opening: ` ${typed} `, revision: 0 });
    expect(saved.status).toBe(200);
    expect(memoryStateSchema.parse(await saved.json())).toMatchObject({
      enabled: true,
      opening: typed,
      revision: 1,
    });
    const tooLong = await patch({ opening: "x".repeat(MEMORY_LIMITS.opening + 1), revision: 1 });
    expect(tooLong.status).toBe(400);
    expect(stores.memory.state(characterId)?.opening).toBe(typed);
    const forget = await app.request(path, { method: "DELETE", headers: ownerHeaders() });
    const { state } = (await forget.json()) as { state: unknown };
    expect(memoryStateSchema.parse(state)).toMatchObject({ enabled: true, opening: "" });
  });

  it("refuses memory_off for a character whose memory is turned off, calling nothing", async () => {
    const { app, characterId, calls } = setup([answer(reply)], { enabled: false });
    const response = await remember(app, request(characterId));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "memory_off" });
    expect(calls()).toBe(0);
  });

  it("writes an episode and the notebook from the model's object", async () => {
    const { app, lines, stores, upstream, characterId } = setup([answer(reply)]);
    // A character never touched has no notebook row and memory on: the first memory creates it.
    expect(stores.memory.state(characterId)).toBeUndefined();
    const response = await remember(app, request(characterId));
    expect(response.status).toBe(200);
    const body = rememberResponseSchema.parse(await response.json());
    expect(body.episode).toMatchObject({ title: object.title, turns: 2, seq: 0 });
    expect(body.notebook).toMatchObject({ enabled: true, notebook: object.notebook, revision: 1 });
    expect(stores.memory.state(characterId)).toEqual(body.notebook);
    // The new episode is held apart: the folded recap the call sent was empty.
    expect(body.recap).toEqual([]);
    expect(body.chapter).toBeUndefined();
    expect(stores.memory.list(characterId)).toEqual([body.episode]);
    // The span reached the model (positive control) and no log line.
    expect(JSON.stringify(upstream.records[0]?.body)).toContain(SPAN_CANARY);
    noCanary(lines);
    const logged = lines.map((line) => JSON.parse(line)).find((l) => l.event === "memory.remember");
    expect(logged).toMatchObject({ model: "fake-model", finishReason: "stop", attempt: 1 });
  });

  it("empties the stored opening when the model's answer gives none", async () => {
    const { opening: _, ...without } = reply;
    const { app, stores, characterId } = setup([answer(without)]);
    stores.memory.setState(characterId, { opening: "> Location: Ashore\n\nMaren waits." }, 0);
    const response = await remember(app, request(characterId));
    expect(response.status).toBe(200);
    const body = rememberResponseSchema.parse(await response.json());
    expect(body.notebook).toMatchObject({ notebook: object.notebook, opening: "", revision: 2 });
    expect(stores.memory.state(characterId)?.opening).toBe("");
  });

  it("repairs an object wrapped in prose without a second call", async () => {
    const prose = `Here is the memory:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`\nDone.`;
    const { app, characterId, calls } = setup([{ chunks: [prose] }]);
    const response = await remember(app, request(characterId));
    expect(response.status).toBe(200);
    expect(rememberResponseSchema.parse(await response.json()).episode.title).toBe(object.title);
    expect(calls()).toBe(1);
  });

  it("keeps an answer past its bounds once clamped, without a second call", async () => {
    const over = {
      ...reply,
      title: `The storm ${"and the long night ".repeat(10)}`,
      cues: Array.from({ length: MEMORY_LIMITS.cues + 4 }, (_, index) => `cue ${index}`),
      notebook: {
        ...reply.notebook,
        facts: {
          change: [],
          drop: [],
          add: [...object.notebook.facts, "", "x".repeat(MEMORY_LIMITS.line + 9)],
        },
      },
      mood: "tense",
    };
    const { app, stores, characterId, calls } = setup([answer(over), answer(reply)]);
    const response = await remember(app, request(characterId));
    const body = rememberResponseSchema.parse(await response.json());
    expect(calls()).toBe(1);
    expect(body.episode.title.length).toBeLessThanOrEqual(MEMORY_LIMITS.title);
    expect(body.episode.title.startsWith("The storm and the long night")).toBe(true);
    expect(body.episode.cues).toEqual(over.cues.slice(0, MEMORY_LIMITS.cues));
    expect(body.notebook.notebook.facts).toEqual([
      ...object.notebook.facts,
      "x".repeat(MEMORY_LIMITS.line),
    ]);
    expect(stores.memory.list(characterId)).toEqual([body.episode]);
  });

  it("remembers valid notebook and cast edits despite malformed optional cast items without retrying", async () => {
    const originalCast = [
      JSON.stringify({ name: "Ilse Brandt", gender: "female", hair: "black bob" }),
      JSON.stringify({ name: "Wren", gender: "female" }),
      JSON.stringify({ name: "Tove", gender: "female" }),
      JSON.stringify({ name: "Nils", gender: "male" }),
    ];
    const changed = JSON.stringify({ name: "Ilse Brandt", gender: "female", hair: "black braid" });
    const added = JSON.stringify({ name: "Oskar", gender: "male", eyes: "green" });
    const malformed = [
      { name: "Wrong", gender: "female" },
      JSON.stringify({ name: "Wrong", gender: "female", mood: "tense" }),
      "",
    ];
    const model = {
      ...reply,
      notebook: {
        ...reply.notebook,
        cast: {
          change: [
            { line: 1, text: changed },
            ...malformed.map((text, index) => ({ line: index + 2, text })),
          ],
          drop: [],
          add: [malformed[0], added, ...malformed.slice(1)],
        },
      },
    };
    const { app, lines, stores, upstream, characterId, calls } = setup([
      answer(model),
      answer(reply),
    ]);
    const priorFact = "The old pier is closed.";
    stores.memory.setState(
      characterId,
      {
        notebook: {
          ...object.notebook,
          situation: "The storm is approaching.",
          facts: [priorFact],
          cast: originalCast,
        },
      },
      0,
    );
    const response = await app.request("/api/memory/remember", {
      ...postJson(request(characterId)),
      headers: ownerHeaders(),
    });
    expect(response.status).toBe(200);
    const body = rememberResponseSchema.parse(await response.json());
    expect(body.episode).toMatchObject({
      title: object.title,
      summary: object.summary,
      cues: object.cues,
      turns: span.length,
    });
    expect(body.notebook).toMatchObject({
      notebook: {
        ...object.notebook,
        facts: [priorFact, ...object.notebook.facts],
        cast: [changed, ...originalCast.slice(1), added],
      },
      revision: 2,
    });
    const storedState = stores.memory.state(characterId);
    const storedEpisode = stores.memory.get(body.episode.id);
    expect(storedState).toEqual(body.notebook);
    expect(storedEpisode).toEqual(body.episode);
    expect(stores.memory.list(characterId)).toEqual([body.episode]);
    expect(JSON.stringify(upstream.records[0]?.body)).toContain(SPAN_CANARY);
    const persisted = JSON.stringify([storedState, storedEpisode]);
    for (const turn of span) expect(persisted).not.toContain(turn.content);
    expect(persisted).not.toContain(SPAN_CANARY);
    noCanary(lines);
    expect(calls()).toBe(1);
  });

  it("gives the call the card and its lorebook as canon, never logged or stored", async () => {
    const card: CharacterCard = {
      ...blankCard("Maren"),
      description: "{{char}} keeps the boathouse for {{user}}. canon-desc-3b1f",
      lorebook: {
        entries: [
          {
            keys: ["boathouse"],
            content: "The boathouse floods at spring tide. canon-entry-9d0e",

            enabled: true,
            insertionOrder: 100,
            useRegex: false,
          },
          {
            keys: ["lighthouse"],
            content: "canon-unmatched-77aa",

            enabled: true,
            insertionOrder: 100,
            useRegex: false,
          },
        ],
      },
    };
    const { app, lines, stores, upstream, characterId } = setup([answer(reply)], { card });
    const response = await remember(app, request(characterId));
    const body = rememberResponseSchema.parse(await response.json());
    const sent = JSON.stringify(upstream.records[0]?.body);
    expect(sent).toContain("Maren keeps the boathouse for User. canon-desc-3b1f");
    expect(sent).toContain("canon-entry-9d0e");
    expect(sent).not.toContain("canon-unmatched-77aa");
    for (const line of lines) expect(line).not.toContain("canon-");
    expect(JSON.stringify([body, stores.memory.list(characterId)])).not.toContain("canon-");
  });

  it("writes the persona as {{user}} in every memory and chapter, and reads it as named", async () => {
    const card: CharacterCard = {
      ...blankCard("Maren"),
      lorebook: {
        entries: [
          {
            keys: ["{{user}}"],
            content: "Canon keyed on the persona. canon-persona-5e2a",

            enabled: true,
            insertionOrder: 100,
            useRegex: false,
          },
        ],
      },
    };
    const named: MemoryAnswer = {
      title: "Aria Lund at the boathouse",
      summary: "Aria and Maren checked the boathouse; Aria's lamp failed. Ariadne Point flooded.",
      cues: ["Aria's lamp", "boathouse"],
      notebook: {
        situation: "Aria waits at the pier.",
        relationships: { change: [], drop: [], add: ["Maren and Aria: allies."] },
        facts: { change: [], drop: [], add: ["Maren owes {{user}} a lamp."] },
        threads: { change: [], drop: [], add: [] },
        cast: { change: [], drop: [], add: [] },
      },
      // The Location line as a model may write it: no quote mark, no empty line after it.
      opening: "Location: The pier, dawn\nMaren waits beside Aria Lund at the rail.",
    };
    const { app, stores, upstream, characterId } = setup(
      [
        answer(named),
        answer({ title: "Aria's winter", summary: "Aria stayed.", cues: ["winter"] }),
      ],
      { card },
    );
    const personaId = stores.personas.create({ name: "Aria Lund", description: "" }, randomUUID());
    // A recap past its count, whose memories already say {{user}}: the chapter call follows.
    const recap = Array.from({ length: MEMORY_LIMITS.recapCount + 1 }, (_, index) => {
      const written = stores.memory.remember(characterId, {
        output: { ...object, title: `Scene ${index}`, summary: "{{user}} rowed out." },
        turns: 2,
        notebookRevision: -1,
      });
      if (typeof written === "string") throw new Error(written);
      return written.episode.id;
    });
    const response = await remember(app, request(characterId, { personaId, episodes: recap }));
    const body = rememberResponseSchema.parse(await response.json());
    // The span is read as the story has it; the persona-keyed entry matches the chapter's
    // memories through the persona's name.
    expect(JSON.stringify(upstream.records[0]?.body)).toContain("called Aria Lund in the message");
    expect(JSON.stringify(upstream.records[1]?.body)).toContain("canon-persona-5e2a");
    expect(body.episode).toMatchObject({
      title: "{{user}} at the boathouse",
      summary:
        "{{user}} and Maren checked the boathouse; {{user}}'s lamp failed. Ariadne Point flooded.",
      cues: ["{{user}}'s lamp", "boathouse"],
    });
    expect(body.notebook.notebook).toMatchObject({
      situation: "{{user}} waits at the pier.",
      relationships: ["Maren and {{user}}: allies."],
      facts: ["Maren owes {{user}} a lamp."],
    });
    // The next chat's opening is set in the creator's shape and holds the persona as {{user}}.
    expect(body.notebook.opening).toBe(
      "> Location: The pier, dawn\n\nMaren waits beside {{user}} at the rail.",
    );
    expect(stores.memory.state(characterId)?.opening).toBe(body.notebook.opening);
    expect(stores.characters.get(characterId)?.card.firstMessage).toBe(card.firstMessage);
    expect(body.chapter).toMatchObject({ title: "{{user}}'s winter", summary: "{{user}} stayed." });
  });

  it("keeps the name in the answer when the character's name holds it", async () => {
    const { app, stores, characterId } = setup([answer({ ...reply, title: "Maren alone" })]);
    const personaId = stores.personas.create({ name: "Maren", description: "" }, randomUUID());
    const response = await remember(app, request(characterId, { personaId }));
    const body = rememberResponseSchema.parse(await response.json());
    expect(body.episode.title).toBe("Maren alone");
  });

  it("rolls up at the budget the call's window gives, capped by the setting", async () => {
    const heavy = "w".repeat(3_000);
    const run = async (model: string, cap: number | null) => {
      const catalog = [
        { ...catalogEntry("small"), context_window: 24_000 },
        catalogEntry("fake-model"),
      ];
      const { app, stores, characterId } = setup([answer(reply), answer(chapterObject)], {
        catalog,
      });
      stores.settings.update({ memoryRecapTokens: cap });
      const recap = seed(stores, characterId, 4).map((id) => {
        const stored = stores.memory.get(id);
        stores.memory.update(id, { summary: heavy }, stored?.revision ?? 0);
        return id;
      });
      const response = await remember(app, request(characterId, { model, episodes: recap }));
      return rememberResponseSchema.parse(await response.json()).chapter;
    };
    // About 3,000 estimated tokens of recap: past a 24,000-token window's budget, within a large one's.
    expect(await run("small", null)).toBeDefined();
    expect(await run("fake-model", null)).toBeUndefined();
    // The owner's cap holds even where the window would allow more.
    expect(await run("fake-model", 1_000)).toBeDefined();
  });

  it("answers memory_failed for a refused call without calling again, logging class and status only", async () => {
    const { app, lines, stores, characterId, calls } = setup([failure, answer(reply)]);
    const response = await remember(app, request(characterId));
    // Decided after the call: the model phase answered 200 at once, the refusal in its body.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: "memory_failed" });
    expect(calls()).toBe(1);
    expect(stores.memory.list(characterId)).toEqual([]);
    const errors = lines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "memory.remember.error");
    expect(errors.map((line) => [line.status, line.attempt])).toEqual([[400, 1]]);
    for (const line of errors) {
      expect(Object.keys(line).sort()).toEqual(
        ["attempt", "durationMs", "errorClass", "event", "level", "model", "status", "time"].sort(),
      );
    }
    noCanary(lines);
  });

  it("asks once more after an answer that does not parse, and writes the second", async () => {
    const { app, lines, stores, characterId, calls } = setup([unusable, answer(reply)]);
    const response = await remember(app, request(characterId));
    const body = rememberResponseSchema.parse(await response.json());
    expect(body.episode.title).toBe(object.title);
    expect(calls()).toBe(2);
    expect(stores.memory.list(characterId)).toEqual([body.episode]);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged.find((line) => line.event === "memory.remember.error")).toMatchObject({
      errorClass: "UnusableAnswer",
      finishReason: "stop",
      attempt: 1,
    });
    expect(logged.find((line) => line.event === "memory.remember")).toMatchObject({ attempt: 2 });
    noCanary(lines);
  });

  it("answers memory_failed after two answers that do not parse", async () => {
    const { app, stores, characterId, calls } = setup([unusable, unusable, answer(reply)]);
    const response = await remember(app, request(characterId));
    expect(await response.json()).toMatchObject({ error: "memory_failed" });
    expect(calls()).toBe(2);
    expect(stores.memory.list(characterId)).toEqual([]);
  });

  it("asks once more after an answer its room cut short, even when a draft in it parses", async () => {
    const cut: FakeTurn = {
      chunks: [`${JSON.stringify(reply)}\nOn reflection: {"title": "The storm`],
      finishReason: "length",
    };
    const { app, lines, characterId, calls } = setup([cut, answer({ ...reply, title: "Final" })]);
    const body = rememberResponseSchema.parse(
      await (await remember(app, request(characterId))).json(),
    );
    expect(calls()).toBe(2);
    expect(body.episode.title).toBe("Final");
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged.find((line) => line.event === "memory.remember.error")).toMatchObject({
      errorClass: "TruncatedAnswer",
      finishReason: "length",
      attempt: 1,
    });
    noCanary(lines);
  });

  it("takes the final object of an answer that writes a draft first", async () => {
    const drafted = `Draft: ${JSON.stringify({ ...reply, title: "Draft" })}\nFinal: ${JSON.stringify(reply)}`;
    const { app, characterId, calls } = setup([{ chunks: [drafted] }]);
    const body = rememberResponseSchema.parse(
      await (await remember(app, request(characterId))).json(),
    );
    expect(calls()).toBe(1);
    expect(body.episode.title).toBe(object.title);
  });

  it("asks for text: no response_format goes upstream, on either call", async () => {
    const { app, upstream, characterId } = setup([unusable, answer(reply)]);
    await (await remember(app, request(characterId))).text();
    expect(upstream.records).toHaveLength(2);
    for (const record of upstream.records)
      expect(record.body).not.toHaveProperty("response_format");
  });

  it("retries a busy provider through the AI SDK and writes the memory", async () => {
    const { app, stores, characterId, calls } = setup([busy(429), answer(reply)]);
    const body = rememberResponseSchema.parse(
      await (await remember(app, request(characterId))).json(),
    );
    expect(stores.memory.list(characterId)).toEqual([body.episode]);
    expect(calls()).toBe(2);
  });

  it.each([429, 503] as const)(
    "answers upstream_busy when the provider answers %i through every retry",
    async (status) => {
      const { app, lines, stores, characterId, calls } = setup([
        busy(status),
        busy(status),
        busy(status),
        answer(reply),
      ]);
      const response = await remember(app, request(characterId));
      expect(rememberRefusalSchema.parse(await response.json())).toEqual({
        error: "upstream_busy",
        retryAfterS: 0,
      });
      // The first call and the AI SDK's two retries; no second attempt of memory's own.
      expect(calls()).toBe(3);
      expect(stores.memory.list(characterId)).toEqual([]);
      const errors = lines
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === "memory.remember.error");
      expect(errors).toEqual([expect.objectContaining({ status, attempt: 1 })]);
      noCanary(lines);
    },
  );

  it("sends one cache key per character within the instance, which names neither", async () => {
    const { app, stores, upstream, characterId } = setup([
      answer(reply),
      answer(reply),
      answer(reply),
    ]);
    const other = stores.characters.create(blankCard("Ilse"));
    for (const id of [characterId, characterId, other]) {
      await (await remember(app, request(id))).text();
    }
    const keys = upstream.records.map(
      (record) => (record.body as { prompt_cache_key?: unknown }).prompt_cache_key,
    );
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toEqual(expect.any(String));
    expect(keys[2]).not.toBe(keys[0]);
    expect(upstream.records.map((record) => record.affinity)).toEqual(keys);
    for (const key of keys) {
      expect(String(key)).not.toContain(characterId);
      expect(String(key)).not.toContain(other);
    }
  });

  it("writes nothing when memory is turned off during the call", async () => {
    const { app, stores, characterId } = setup([answer(reply)], {
      before: (stores) => {
        stores.memory.setState(
          characterId,
          { enabled: false },
          stores.memory.state(characterId)?.revision ?? 0,
        );
      },
    });
    const response = await remember(app, request(characterId));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: "memory_off" });
    expect(stores.memory.list(characterId)).toEqual([]);
  });

  it("writes nothing into a book forgotten during the call, memory still on", async () => {
    let forget = async () => {};
    const { app, stores, characterId } = setup([answer(reply)], { before: () => forget() });
    const path = `/api/memory/characters/${characterId}`;
    forget = async () => {
      expect((await app.request(path, { method: "DELETE", headers: ownerHeaders() })).status).toBe(
        200,
      );
    };
    const response = await remember(app, request(characterId));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: "memory_off" });
    expect(stores.memory.list(characterId)).toEqual([]);
    // Nothing was written: no notebook row, and memory is still on.
    expect(stores.memory.state(characterId)).toBeUndefined();
  });

  it("refuses before any call a book that is full", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply)]);
    seed(stores, characterId, MEMORY_LIMITS.episodes);
    const response = await remember(app, request(characterId));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "too_many_memories" });
    expect(calls()).toBe(0);
  });

  it("refuses a recap at its bound, and takes one at the bound that reconciles below it", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply), answer(chapterObject)]);
    const known = seed(stores, characterId, RECAP_IDS);
    const full = await remember(app, request(characterId, { episodes: known }));
    expect(full.status).toBe(409);
    // This chat's list is full, not the book: its own refusal.
    expect(await full.json()).toEqual({ error: "too_many_chat_memories" });
    expect(calls()).toBe(0);

    // One id the book no longer has: the recap reconciles to one below the bound.
    const episodes = [randomUUID(), ...known.slice(1)];
    const response = await remember(app, request(characterId, { episodes }));
    expect(response.status).toBe(200);
    const body = rememberResponseSchema.parse(await response.json());
    // The recap past its count rolls up its oldest half, the unknown id gone.
    const merged = Math.floor((RECAP_IDS - 1) / 2);
    expect(body.recap).toEqual([body.chapter?.id, ...known.slice(1 + merged)]);
    expect(calls()).toBe(2);
  });

  it("counts the held memories with the recap against the chat's bound", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply), answer(chapterObject)]);
    const known = seed(stores, characterId, RECAP_IDS);
    const full = await remember(
      app,
      request(characterId, { episodes: known.slice(0, -1), held: known.slice(-1) }),
    );
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "too_many_chat_memories" });
    expect(calls()).toBe(0);
    // A held id the book no longer has does not count.
    const response = await remember(
      app,
      request(characterId, { episodes: known.slice(0, -1), held: [randomUUID()] }),
    );
    expect(response.status).toBe(200);
  });

  it("reads held memories as the earlier context, newest last, and rolls up the folded recap only", async () => {
    const { app, stores, upstream, characterId } = setup([answer(reply), answer(chapterObject)]);
    const [first = "", ...rest] = seed(stores, characterId, MEMORY_LIMITS.recapCount + 3);
    const held = rest.slice(-2);
    const folded = [first, ...rest.slice(0, -2)];
    const response = await remember(app, request(characterId, { episodes: folded, held }));
    const body = rememberResponseSchema.parse(await response.json());
    // The span's earlier context: the last folded memory, then the held ones.
    const message = JSON.stringify(upstream.records[0]?.body);
    const title = (id: string) => stores.memory.get(id)?.title ?? "?";
    for (const id of [folded.at(-1) ?? "", ...held]) expect(message).toContain(title(id));
    expect(message).not.toContain(`${title(folded.at(-2) ?? "")}.`);
    // Forty-one folded memories pass the count: half of them roll up, never a held one.
    const merged = Math.floor(folded.length / 2);
    expect(body.recap).toEqual([body.chapter?.id, ...folded.slice(merged)]);
    expect(body.recap).not.toContain(body.episode.id);
    const members = stores.memory
      .list(characterId)
      .filter((episode) => episode.chapterId === body.chapter?.id)
      .map((episode) => episode.id);
    expect(members).toEqual(folded.slice(0, merged));
  });

  it("refuses malformed and oversized requests without calling or logging the span", async () => {
    const { app, lines, characterId, calls } = setup([answer(reply)]);
    const bad = [
      { ...request(characterId), turns: [] },
      { ...request(characterId), characterId: "not-a-uuid" },
      { ...request(characterId), attempt: undefined },
      { ...request(characterId), extra: SPAN_CANARY },
      {
        ...request(characterId),
        episodes: Array.from({ length: RECAP_IDS + 1 }, () => randomUUID()),
      },
    ];
    for (const body of bad) {
      const response = await remember(app, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const huge = { ...request(characterId), turns: [...span, { role: "user", content: "" }] };
    const oversized = JSON.stringify(huge).replace(
      '"content":""',
      `"content":"${SPAN_CANARY}${"x".repeat(9 * 1024 * 1024)}"`,
    );
    const response = await app.request("/api/memory/remember", {
      ...postJson(null),
      body: oversized,
    });
    expect(response.status).toBe(413);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "payload_too_large" });
    expect(text).not.toContain(SPAN_CANARY);
    expect(calls()).toBe(0);
    noCanary(lines);
  });

  it("counts message framing and priming within the shared output ceiling", async () => {
    const small = 24_000;
    const catalog = [
      { ...catalogEntry("small"), context_window: small },
      { ...catalogEntry("tiny"), context_window: MEMORY_LIMITS.replyReserve + 64 },
      catalogEntry("fake-model"),
    ];
    const { app, upstream, characterId, calls } = setup([answer(reply), answer(reply)], {
      catalog,
    });
    const sent = (index: number) =>
      upstream.records[index]?.body as {
        max_tokens: number;
        messages: { role: string; content: string }[];
      };

    // The model phase answers 200 at once; its body settles once the call did.
    const written = async (body: unknown) =>
      rememberResponseSchema.safeParse(await (await remember(app, body)).json()).success;

    expect(await written(request(characterId, { model: "small" }))).toBe(true);
    // The window less the counted input: the instructions and the message.
    const input =
      PRIMING +
      sent(0).messages.reduce(
        (sum, message) => sum + countMessage(message as Parameters<typeof countMessage>[0]),
        0,
      );
    expect(sent(0).max_tokens).toBe(small - input);
    expect(sent(0).max_tokens).toBeGreaterThanOrEqual(MEMORY_LIMITS.replyReserve);

    expect(await written(request(characterId))).toBe(true);
    expect(sent(1).max_tokens).toBe(CREATOR_LIMITS.maxOutputTokens);

    // Input that leaves less than the reply's reserve is refused, as before.
    const tiny = await remember(app, request(characterId, { model: "tiny" }));
    expect(tiny.status).toBe(422);
    expect(await tiny.json()).toEqual({ error: "prompt_too_long" });
    expect(calls()).toBe(2);
  });

  it("sends the memory model and its offered effort to the scene and the chapter call", async () => {
    const catalog = [
      {
        ...catalogEntry("memory-model"),
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      },
    ];
    const turns = [answer(reply), answer(chapterObject), answer(reply), answer(chapterObject)];
    const { app, stores, upstream, characterId } = setup(turns, { catalog });
    const sent = (index: number) => upstream.records[index]?.body as Record<string, unknown>;
    for (const [reasoning, expected] of [
      ["medium", "medium"],
      ["xhigh", undefined],
    ] as const) {
      const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
      const before = upstream.records.length;
      const response = await remember(
        app,
        request(characterId, { model: "memory-model", reasoning, episodes: recap }),
      );
      const body = rememberResponseSchema.parse(await response.json());
      expect(body.chapter).toBeDefined();
      for (const index of [before, before + 1]) {
        expect(sent(index)).toMatchObject({ model: "memory-model" });
        if (expected === undefined) expect(sent(index)).not.toHaveProperty("reasoning_effort");
        else expect(sent(index)).toMatchObject({ reasoning_effort: expected });
      }
    }
  });

  it("keeps the owner's notebook edit made during the call", async () => {
    const edit = {
      situation: "The owner's words.",
      relationships: [],
      facts: [],
      threads: [],
      cast: [],
    };
    const { app, characterId } = setup([answer(reply)], {
      before: (stores) => {
        stores.memory.setState(characterId, { notebook: edit }, 0);
      },
    });
    const body = rememberResponseSchema.parse(
      await (await remember(app, request(characterId))).json(),
    );
    expect(body.notebook.notebook).toEqual(edit);
  });

  it("rolls the oldest half of a recap past its count into a chapter", async () => {
    const { app, stores, characterId } = setup([answer(reply), answer(chapterObject)]);
    const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
    // An unknown id is dropped, the order kept.
    const response = await remember(
      app,
      request(characterId, { episodes: [randomUUID(), ...recap] }),
    );
    expect(response.status).toBe(200);
    const body = rememberResponseSchema.parse(await response.json());
    const merged = Math.floor((MEMORY_LIMITS.recapCount + 1) / 2);
    expect(body.chapter).toMatchObject({ kind: "chapter", title: chapterObject.title });
    expect(body.recap).toEqual([body.chapter?.id, ...recap.slice(merged)]);
    const members = stores.memory
      .list(characterId)
      .filter((episode) => episode.chapterId === body.chapter?.id);
    expect(members.map((episode) => episode.id)).toEqual(recap.slice(0, merged));
  });

  it("rolls the oldest half of the story before the chat into a chapter, kept out of the chat's recap", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply), answer(chapterObject)]);
    // Earlier chats' memories past the count; this chat's own are never members.
    const before = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
    const [held = ""] = seed(stores, characterId, 1);
    const response = await remember(app, request(characterId, { held: [held] }));
    expect(response.status).toBe(200);
    const body = rememberResponseSchema.parse(await response.json());
    expect(calls()).toBe(2);
    expect(body.chapter).toMatchObject({ kind: "chapter", title: chapterObject.title });
    // The chapter tells the story before the chat: the chat's recap stays as it was.
    expect(body.recap).toEqual([]);
    const members = stores.memory
      .list(characterId)
      .filter((episode) => episode.chapterId === body.chapter?.id);
    // Of the story before it (the held one and the new one are the chat's): the oldest half.
    const merged = Math.floor(before.length / 2);
    expect(members.map((episode) => episode.id)).toEqual(before.slice(0, merged));
  });

  it("merges the oldest part of the story before the chat that the window holds, two at least", async () => {
    const small = 16_000;
    const { app, stores, characterId, upstream, calls } = setup(
      [answer(reply), answer(chapterObject)],
      { catalog: [{ ...catalogEntry("small"), context_window: small }] },
    );
    // A long book from before: its oldest half is more than one chapter call can read here.
    const dense = Array.from({ length: 300 }, (_, i) => `w${i}x`).join(" ");
    const before = Array.from({ length: MEMORY_LIMITS.recapCount + 1 }, (_, index) => {
      const written = stores.memory.remember(characterId, {
        output: { ...object, title: `Old ${index}`, summary: dense },
        turns: 2,
        notebookRevision: -1,
      });
      if (typeof written === "string") throw new Error(written);
      return written.episode.id;
    });
    const response = await remember(app, request(characterId, { model: "small" }));
    const body = rememberResponseSchema.parse(await response.json());
    expect(calls()).toBe(2);
    expect(body.chapter).toMatchObject({ kind: "chapter" });
    const members = stores.memory
      .list(characterId)
      .filter((episode) => episode.chapterId === body.chapter?.id)
      .map((episode) => episode.id);
    // Fewer than the oldest half, the oldest of it, and the call fitted its window.
    const half = Math.floor(before.length / 2);
    expect(members.length).toBeGreaterThanOrEqual(2);
    expect(members.length).toBeLessThan(half);
    expect(members).toEqual(before.slice(0, members.length));
    const sent = upstream.records[1]?.body as { max_tokens: number };
    expect(sent.max_tokens).toBeGreaterThanOrEqual(MEMORY_LIMITS.replyReserve);
  });

  it("leaves the chapter out when a member changed during its call, and logs it as stale", async () => {
    let edit = () => {};
    const { app, lines, stores, characterId } = setup([answer(reply), answer(chapterObject)], {
      before: () => edit(),
    });
    const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
    let completions = 0;
    edit = () => {
      completions += 1;
      // The owner pins the oldest member while the chapter is written.
      if (completions === 2) stores.memory.update(recap[0] ?? "", { pinned: true }, 0);
    };
    const response = await remember(app, request(characterId, { episodes: recap }));
    const body = rememberResponseSchema.parse(await response.json());
    expect(body.chapter).toBeUndefined();
    expect(body.recap).toEqual(recap);
    const book = stores.memory.list(characterId);
    expect(book.some((episode) => episode.kind === "chapter")).toBe(false);
    expect(book.every((episode) => episode.chapterId === null)).toBe(true);
    const logged = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "memory.chapter.error");
    expect(logged).toMatchObject({ level: "warn", errorClass: "stale" });
  });

  describe("a chapter past its room", () => {
    /** The summary's room the chapter call's instructions state. */
    const statedRoom = (record: { body: unknown } | undefined) => {
      const { messages } = (record?.body ?? { messages: [] }) as {
        messages: { role: string; content: string }[];
      };
      const system = messages.find(({ role }) => role === "system")?.content ?? "";
      const room = /in the order things happened, at most ([\d,]+) characters/.exec(system)?.[1];
      return Number(room?.replaceAll(",", ""));
    };
    /** A summary past any chapter's room, the largest included. */
    const past = (word: string) =>
      word.repeat(Math.ceil((MEMORY_LIMITS.chapterSummary + 200) / word.length));

    it("is asked once to compress it, and the compressed chapter is written whole", async () => {
      const { app, lines, stores, characterId, upstream, calls } = setup([
        answer(reply),
        answer({ ...chapterObject, summary: past("storm ") }),
        answer({ ...chapterObject, summary: "The early days, compressed." }),
      ]);
      const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
      const body = rememberResponseSchema.parse(
        await (await remember(app, request(characterId, { episodes: recap }))).json(),
      );
      expect(calls()).toBe(3);
      const room = statedRoom(upstream.records[1]);
      expect(room).toBeGreaterThanOrEqual(MEMORY_LIMITS.summary);
      expect(body.chapter?.summary).toBe("The early days, compressed.");
      // The correction follows the overshooting answer in the same conversation.
      const { messages } = (upstream.records[2]?.body ?? { messages: [] }) as {
        messages: { role: string; content: string }[];
      };
      expect(messages.map(({ role }) => role)).toEqual(["system", "user", "assistant", "user"]);
      expect(messages[3]?.content).toContain(`compressed to at most ${room.toLocaleString("en")}`);
      const logged = lines.map((line) => JSON.parse(line));
      expect(logged.find((line) => line.event === "memory.chapter.error")).toMatchObject({
        errorClass: "AnswerPastBound",
        attempt: 1,
      });
      expect(logged.find((line) => line.event === "memory.chapter")).toMatchObject({ attempt: 2 });
      noCanary(lines);
    });

    it("is cut to its room at a word break only when the correction overshoots too", async () => {
      const { app, stores, characterId, upstream, calls } = setup([
        answer(reply),
        answer({ ...chapterObject, summary: past("storm ") }),
        answer({ ...chapterObject, summary: past("calm ") }),
      ]);
      const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
      const body = rememberResponseSchema.parse(
        await (await remember(app, request(characterId, { episodes: recap }))).json(),
      );
      expect(calls()).toBe(3);
      const room = statedRoom(upstream.records[1]);
      const summary = body.chapter?.summary ?? "";
      expect(summary.length).toBeLessThanOrEqual(room);
      expect(summary.startsWith("calm calm")).toBe(true);
      expect(summary.endsWith("calm")).toBe(true);
    });

    it("keeps the first chapter, cut to its room, when the correction is unusable", async () => {
      const { app, stores, characterId, upstream, calls } = setup([
        answer(reply),
        answer({ ...chapterObject, summary: past("storm ") }),
        unusable,
      ]);
      const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
      const body = rememberResponseSchema.parse(
        await (await remember(app, request(characterId, { episodes: recap }))).json(),
      );
      expect(calls()).toBe(3);
      const room = statedRoom(upstream.records[1]);
      expect(body.chapter?.summary.startsWith("storm storm")).toBe(true);
      expect(body.chapter?.summary.length).toBeLessThanOrEqual(room);
    });

    it("writes no chapter, and answers the written episode, when the cut leaves no summary", async () => {
      // An unfinished macro the cut drops whole, so nothing of the summary is left.
      const macro = `{{${"x".repeat(MEMORY_LIMITS.chapterSummary + 200)}`;
      const { app, lines, stores, characterId, calls } = setup([
        answer(reply),
        answer({ ...chapterObject, summary: macro }),
        answer({ ...chapterObject, summary: macro }),
      ]);
      const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
      const response = await remember(app, request(characterId, { episodes: recap }));
      const body = rememberResponseSchema.parse(await response.json());
      expect(calls()).toBe(3);
      expect(body.chapter).toBeUndefined();
      expect(body.episode.title).toBe(reply.title);
      // One episode written, not one per failed answer a retry would bring.
      const book = stores.memory.list(characterId);
      expect(book.filter((episode) => episode.title === reply.title)).toHaveLength(1);
      expect(book.some((episode) => episode.kind === "chapter")).toBe(false);
      const logged = lines.map((line) => JSON.parse(line));
      expect(logged.find((line) => line.errorClass === "invalid_chapter")).toMatchObject({
        level: "warn",
        event: "memory.chapter",
      });
      noCanary(lines);
    });
  });

  it("answers the episode with the unrolled recap when the chapter step fails", async () => {
    const { app, stores, characterId } = setup([answer(reply), failure, failure]);
    const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
    const response = await remember(app, request(characterId, { episodes: recap }));
    expect(response.status).toBe(200);
    const body = rememberResponseSchema.parse(await response.json());
    expect(body.chapter).toBeUndefined();
    expect(body.recap).toEqual(recap);
    expect(stores.memory.list(characterId).every((episode) => episode.chapterId === null)).toBe(
      true,
    );
  });

  it("makes one call for repeats of one attempt, during and after it", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, stores, characterId, calls } = setup([answer(reply), answer(reply)], {
      before: () => gate.promise,
    });
    const body = request(characterId);
    const first = remember(app, body);
    const second = remember(app, body);
    await until(() => calls() > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    const answers = [await a.json(), await b.json()];
    expect(answers[0]).toEqual(answers[1]);
    const third = await (await remember(app, body)).json();
    expect(third).toEqual(answers[0]);
    expect(calls()).toBe(1);
    expect(stores.memory.list(characterId)).toHaveLength(1);
  });

  it("keeps the call a repeat waits on running when the request that started it goes", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, stores, characterId, calls } = setup([answer(reply), answer(reply)], {
      before: () => gate.promise,
    });
    const body = request(characterId);
    const first = await remember(app, body);
    await until(() => calls() > 0);
    const repeat = await remember(app, body);
    await first.body?.cancel();
    gate.resolve();
    expect(rememberResponseSchema.safeParse(await repeat.json()).success).toBe(true);
    expect(calls()).toBe(1);
    expect(stores.memory.list(characterId)).toHaveLength(1);
  });

  it("builds a repeat's recap from its own request, the kept memory the same", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply), answer(reply)]);
    const [earlier] = seed(stores, characterId, 1);
    const body = request(characterId, { episodes: [earlier] });
    const response = await remember(app, body);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const first = rememberResponseSchema.parse(await response.json());
    expect(first.recap).toEqual([earlier]);
    const again = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(again).toEqual(first);
    expect(calls()).toBe(1);
  });

  it("keeps a running attempt through more newer ones than it keeps", async () => {
    const gate = Promise.withResolvers<void>();
    let completions = 0;
    const { app, stores, characterId, calls } = setup(
      Array.from({ length: KEPT_ATTEMPTS + 2 }, () => answer(reply)),
      {
        before: () => {
          completions += 1;
          return completions === 1 ? gate.promise : undefined;
        },
      },
    );
    const held = request(characterId);
    const first = remember(app, held);
    await until(() => calls() > 0);
    // Another character's calls do not wait behind the held one, and each settles before the repeat.
    const other = stores.characters.create(blankCard("Ilse"));
    for (let index = 0; index < KEPT_ATTEMPTS; index += 1) {
      const answered = await remember(app, request(other));
      expect(answered.status).toBe(200);
      expect(rememberResponseSchema.safeParse(await answered.json()).success).toBe(true);
    }
    const repeat = remember(app, held);
    gate.resolve();
    const answers = await Promise.all([first, repeat].map(async (sent) => (await sent).json()));
    expect(answers[0]).toEqual(answers[1]);
    expect(calls()).toBe(KEPT_ATTEMPTS + 1);
    expect(stores.memory.list(characterId)).toHaveLength(1);
    expect(stores.memory.list(other)).toHaveLength(KEPT_ATTEMPTS);
  });

  it("answers memory_off for a kept attempt whose book was forgotten since, writing nothing", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply), answer(reply)]);
    const body = request(characterId);
    expect(rememberResponseSchema.safeParse(await (await remember(app, body)).json()).success).toBe(
      true,
    );
    const path = `/api/memory/characters/${characterId}`;
    expect((await app.request(path, { method: "DELETE", headers: ownerHeaders() })).status).toBe(
      200,
    );
    const again = await remember(app, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ error: "memory_off" });
    expect(calls()).toBe(1);
    expect(stores.memory.list(characterId)).toEqual([]);
  });

  it("replays a chapter in place of the members it still has, keeping every other episode", async () => {
    const { app, stores, characterId } = setup([answer(reply), answer(chapterObject)]);
    const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
    const body = request(characterId, { episodes: recap });
    const first = rememberResponseSchema.parse(await (await remember(app, body)).json());
    const merged = Math.floor((MEMORY_LIMITS.recapCount + 1) / 2);
    const chapterId = first.chapter?.id;
    expect(first.recap).toEqual([chapterId, ...recap.slice(merged)]);

    // One member leaves the book before the lost answer is asked for again.
    const removed = await app.request(`/api/memory/episodes/${recap[0]}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(removed.status).toBe(204);
    const again = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(again.recap).toEqual([chapterId, ...recap.slice(merged)]);
  });

  it("streams queued keepalives while serializing calls against the preceding notebook", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const gate = Promise.withResolvers<void>();
    let completions = 0;
    // The second drops every line the first wrote.
    const dropFirst = { change: [], drop: [1], add: [] };
    const second: MemoryAnswer = {
      ...reply,
      title: "After the storm",
      notebook: {
        situation: "Morning came.",
        relationships: dropFirst,
        facts: dropFirst,
        threads: dropFirst,
        cast: { change: [], drop: [], add: [] },
      },
    };
    const { app, stores, upstream, characterId, calls } = setup([answer(reply), answer(second)], {
      before: () => {
        completions += 1;
        return completions === 1 ? gate.promise : undefined;
      },
    });
    try {
      const first = await remember(app, request(characterId));
      await until(() => calls() > 0);
      // Headers arrive while the preceding model call is still blocked.
      const next = await remember(app, request(characterId));
      expect(next.status).toBe(200);
      expect(next.headers.get("Content-Type")).toBe("application/json");
      expect(next.headers.get("Cache-Control")).toBe("no-store, no-transform");
      const reader = next.body?.getReader();
      if (reader === undefined) throw new Error("no body");
      for (let interval = 0; interval < 2; interval += 1) {
        const frame = reader.read();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        expect(new TextDecoder().decode((await frame).value)).toBe("\n");
        expect(calls()).toBe(1);
        expect(stores.memory.state(characterId)).toBeUndefined();
      }
      gate.resolve();
      expect(rememberResponseSchema.parse(await first.json()).episode.title).toBe(object.title);
      let body = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        body += new TextDecoder().decode(chunk.value);
      }
      expect(rememberResponseSchema.parse(JSON.parse(body)).episode.title).toBe(second.title);
      expect(calls()).toBe(2);
      expect(JSON.stringify(upstream.records[0]?.body)).not.toContain(object.notebook.situation);
      expect(JSON.stringify(upstream.records[1]?.body)).toContain(object.notebook.situation);
      expect(stores.memory.list(characterId)).toHaveLength(2);
      expect(stores.memory.state(characterId)?.notebook).toEqual({
        situation: "Morning came.",
        relationships: [],
        facts: [],
        threads: [],
        cast: [],
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.resolve();
      vi.useRealTimers();
    }
  });

  it("writes a queued attempt once when two tabs send it before it starts", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, stores, characterId, calls } = setup([answer(reply), answer(reply)], {
      before: () => gate.promise,
    });
    try {
      const first = await remember(app, request(characterId));
      await until(() => calls() > 0);
      const body = request(characterId);
      const queued = await remember(app, body);
      const repeated = await remember(app, body);
      expect(queued.status).toBe(200);
      expect(repeated.status).toBe(200);
      expect(calls()).toBe(1);
      gate.resolve();
      await first.json();
      const [a, b] = await Promise.all([queued.json(), repeated.json()]);
      expect(rememberResponseSchema.parse(a)).toEqual(rememberResponseSchema.parse(b));
      expect(await (await remember(app, body)).json()).toEqual(a);
      expect(calls()).toBe(2);
      expect(stores.memory.list(characterId)).toHaveLength(2);
    } finally {
      gate.resolve();
    }
  });

  it("answers a stale recap with the outermost chapters, and replays it as the book stands", async () => {
    const { app, stores, characterId, calls } = setup([answer(reply)]);
    const { stale, outer, e4 } = nest(stores, characterId);
    const body = request(characterId, { episodes: stale });
    const first = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(first.recap).toEqual([outer, e4]);

    // The book moves on before the lost answer is asked for again: the replay follows it.
    const latest = stores.memory.get(e4);
    const outerNow = stores.memory.get(outer);
    if (latest === undefined || outerNow === undefined) throw new Error("missing");
    const top = stores.memory.chapter(characterId, {
      output: chapterObject,
      members: [outerNow, latest].map(({ id, revision, chapterId }) => ({
        id,
        revision,
        chapterId,
      })),
    });
    if (typeof top === "string") throw new Error(top);
    const again = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(again.recap).toEqual([top.id]);
    expect(calls()).toBe(1);
  });

  it("rolls a stale recap up from its chapters, not the members they absorbed", async () => {
    const { app, stores, characterId } = setup([answer(reply), answer(chapterObject)]);
    const { stale, outer } = nest(stores, characterId);
    const rest = seed(stores, characterId, MEMORY_LIMITS.recapCount);
    const response = await remember(
      app,
      request(characterId, { episodes: [...stale.slice(0, 3), ...rest] }),
    );
    const body = rememberResponseSchema.parse(await response.json());
    // The outer chapter and the rest: the oldest half goes into a chapter.
    const merged = Math.floor((MEMORY_LIMITS.recapCount + 1) / 2);
    expect(body.chapter).toBeDefined();
    expect(body.recap).toEqual([body.chapter?.id, ...rest.slice(merged - 1)]);
    expect(stores.memory.get(outer)?.chapterId).toBe(body.chapter?.id);
  });

  it("refuses a queued call when its memory is forgotten or turned off while it waits", async () => {
    for (const change of ["forget", "off and on"] as const) {
      const gate = Promise.withResolvers<void>();
      const { app, stores, characterId, calls } = setup([answer(reply), answer(reply)], {
        before: () => gate.promise,
      });
      const path = `/api/memory/characters/${characterId}`;
      const running = remember(app, request(characterId));
      await until(() => calls() > 0);
      const queued = remember(app, request(characterId));
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (change === "forget") {
        const forgotten = await app.request(path, { method: "DELETE", headers: ownerHeaders() });
        expect(forgotten.status).toBe(200);
      } else {
        const patch = async (enabled: boolean) => {
          const revision = stores.memory.state(characterId)?.revision ?? 0;
          const response = await app.request(path, {
            method: "PATCH",
            headers: ownerHeaders(),
            body: JSON.stringify({ enabled, revision }),
          });
          expect(response.status).toBe(200);
        };
        await patch(false);
        await patch(true);
      }
      gate.resolve();
      expect(await (await running).json()).toMatchObject({ error: "memory_off" });
      const refused = await queued;
      expect(refused.status).toBe(200);
      expect(await refused.json()).toMatchObject({ error: "memory_off" });
      expect(calls()).toBe(1);
      expect(stores.memory.list(characterId)).toEqual([]);
    }
  });

  it("answers the written episode when memory goes off and on during the chapter call, writing it once", async () => {
    let completions = 0;
    let toggle = async () => {};
    const { app, stores, characterId, calls } = setup([answer(reply), answer(chapterObject)], {
      before: async () => {
        completions += 1;
        if (completions === 2) await toggle();
      },
    });
    const path = `/api/memory/characters/${characterId}`;
    toggle = async () => {
      for (const enabled of [false, true]) {
        const revision = stores.memory.state(characterId)?.revision ?? 0;
        const response = await app.request(path, {
          method: "PATCH",
          headers: ownerHeaders(),
          body: JSON.stringify({ enabled, revision }),
        });
        expect(response.status).toBe(200);
      }
    };
    const recap = seed(stores, characterId, MEMORY_LIMITS.recapCount + 1);
    const body = request(characterId, { episodes: recap });
    const first = rememberResponseSchema.parse(await (await remember(app, body)).json());
    // The episode was written before the chapter call: it is the answer, without a chapter.
    expect(calls()).toBe(2);
    expect(first.chapter).toBeUndefined();
    expect(first.recap).toEqual(recap);
    const written = stores.memory
      .list(characterId)
      .filter((episode) => !recap.includes(episode.id));
    expect(written).toEqual([first.episode]);
    // A lost answer asked for again gets the same episode, and nothing more is written.
    const again = rememberResponseSchema.parse(await (await remember(app, body)).json());
    expect(again.episode).toEqual(first.episode);
    expect(calls()).toBe(2);
    expect(stores.memory.list(characterId)).toHaveLength(recap.length + 1);
  });

  it.each(["disconnect", "body cancellation", "deadline"] as const)(
    "drains a queued call on %s without an upstream call, then admits the next one",
    async (ending) => {
      const gate = Promise.withResolvers<void>();
      const { app, stores, characterId, calls } = setup([answer(reply), answer(reply)], {
        before: () => gate.promise,
      });
      try {
        const first = await remember(app, request(characterId));
        await until(() => calls() > 0);
        const waiting = new AbortController();
        // Control only this request's lifetime, independently of the running request's.
        const timeout =
          ending === "deadline"
            ? vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(waiting.signal)
            : undefined;
        const next = await app.request(
          "/api/memory/remember",
          postJson(request(characterId), {
            ...(ending === "disconnect" ? { signal: waiting.signal } : {}),
          }),
        );
        if (timeout !== undefined) {
          expect(timeout).toHaveBeenCalledWith(60_000);
          timeout.mockRestore();
        }
        expect(next.status).toBe(200);
        if (ending === "body cancellation") {
          await next.body?.cancel();
        } else {
          // Keep consuming so the deadline can deliver its closing refusal body.
          const result = next.json();
          waiting.abort(new DOMException("request ended", "TimeoutError"));
          expect(await result).toMatchObject({ error: "request_timeout" });
        }
        expect(calls()).toBe(1);
        const afterwards = await remember(app, request(characterId));
        expect(calls()).toBe(1);
        gate.resolve();
        expect(rememberResponseSchema.safeParse(await first.json()).success).toBe(true);
        expect(rememberResponseSchema.safeParse(await afterwards.json()).success).toBe(true);
        expect(calls()).toBe(2);
        expect(stores.memory.list(characterId)).toHaveLength(2);
      } finally {
        gate.resolve();
        vi.restoreAllMocks();
      }
    },
  );
});

describe("memory in the prompt", () => {
  /** A preview request; a `memoryState` gets what the tab always sends with it. */
  const preview = (
    characterId: string,
    { memoryState, ...extra }: Record<string, unknown> & { memoryState?: object } = {},
  ) => ({
    model: "fake-model",
    clock: CLOCK,
    pickSeed: PICK_SEED,
    characterId,
    messages: [{ role: "user", content: "Hello." }],
    ...extra,
    ...(memoryState === undefined
      ? {}
      : { memoryState: { foldedUsers: 0, continued: false, ...memoryState } }),
  });

  it("adds the story block while memory is on, and nothing while it is off", async () => {
    const { app, stores, characterId } = setup([]);
    const [id] = seed(stores, characterId, 1);
    const read = async () => {
      const response = await app.request(
        "/api/chat/preview",
        postJson(preview(characterId, { memoryState: { recap: [id] } })),
      );
      expect(response.status).toBe(200);
      const { prompt } = (await response.json()) as { prompt: unknown };
      return inspectedPromptSchema
        .parse(prompt)
        .messages.filter((message) => message.source.kind === "memory");
    };
    const on = await read();
    expect(on).toHaveLength(1);
    expect(on[0]?.source).toMatchObject({ kind: "memory", part: "story", episodes: 1 });
    expect(on[0]?.content).toContain("Episode 0");

    stores.memory.setState(
      characterId,
      { enabled: false },
      stores.memory.state(characterId)?.revision ?? 0,
    );
    expect(await read()).toEqual([]);
  });

  /** The memory parts, estimate and lorebook report of a preview of `content`. */
  const read = async (
    app: ReturnType<typeof setup>["app"],
    characterId: string,
    content: string,
    memoryState: Partial<ChatMemoryState> & Pick<ChatMemoryState, "recap">,
  ) => {
    const response = await app.request(
      "/api/chat/preview",
      postJson(preview(characterId, { messages: [{ role: "user", content }], memoryState })),
    );
    if (response.status !== 200) throw new Error(await response.text());
    const { prompt } = (await response.json()) as { prompt: unknown };
    const parsed = inspectedPromptSchema.parse(prompt);
    const part = (name: string) =>
      parsed.messages.find(
        (message) => message.source.kind === "memory" && message.source.part === name,
      );
    return {
      estimate: parsed.estimate,
      story: part("story"),
      recalled: part("recalled"),
      lorebook: parsed.lorebook,
    };
  };

  const window = 8_192;
  const budget = promptBudget(window, replyReserve(null, window));
  const cue = " Back to the boathouse.";
  /**
   * Text before `cue` that grows a prompt estimated at `estimate` past the
   * budget by less than half the recalled block's `recalled` tokens: it fits
   * without that block and not with it.
   */
  const overflowing = (estimate: number, recalled: number) => {
    const grow = budget - estimate + Math.floor(recalled / 2);
    const added = (words: number) => countText(" wave".repeat(words) + cue) - countText(cue);
    let words = grow;
    while (added(words) > grow) words -= 1;
    expect(added(words)).toBeGreaterThan(budget - estimate);
    return " wave".repeat(words) + cue;
  };

  it("leaves the recalled block out of a prompt it would push past the window", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    // One episode this chat tells, a chapter told before it, and its members the latest
    // message recalls by their cue.
    const [told = ""] = seed(stores, characterId, 1);
    bury(stores, characterId);
    const state = { recap: [told], folded: 0 };
    const small = await read(app, characterId, cue, state);
    const recalledTokens = small.recalled?.tokens ?? 0;
    expect(recalledTokens).toBeGreaterThan(4);

    const large = await read(app, characterId, overflowing(small.estimate, recalledTokens), state);
    expect(large.recalled).toBeUndefined();
    expect(large.story?.source).toMatchObject({ part: "story", episodes: 2 });
    expect(large.estimate).toBeLessThanOrEqual(budget);
    expect(large.estimate + recalledTokens).toBeGreaterThan(budget);
  });

  it("keeps the recap and recalls nothing when a left-out recap episode overflows, with no other memory", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const write = (output: MemoryOutput) => {
      const written = stores.memory.remember(characterId, {
        output,
        turns: 2,
        notebookRevision: -1,
      });
      if (typeof written === "string") throw new Error(written);
      return written.episode.id;
    };
    // Too large for the story block, so it keeps only the newest and the oldest is left out,
    // which the latest message recalls by its cue; the book holds nothing else.
    const dense = Array.from({ length: 600 }, (_, i) => `q${i}x`).join(" ");
    const old = write({ ...object, title: "The old pier", cues: ["boathouse"] });
    const large = write({ ...object, title: "The long night", summary: dense, cues: ["kelp"] });
    const newest = write({ ...object, title: "The quiet morning", cues: ["kettle"] });
    const state = { recap: [old, large, newest], folded: 0 };
    const small = await read(app, characterId, cue, state);
    expect(small.story?.source).toMatchObject({ part: "story", episodes: 1 });
    expect(small.recalled?.content).toContain("The old pier");
    const recalledTokens = small.recalled?.tokens ?? 0;

    const grown = await read(app, characterId, overflowing(small.estimate, recalledTokens), state);
    expect(grown.recalled).toBeUndefined();
    expect(grown.story?.source).toMatchObject({ part: "story", episodes: 1 });
    expect(grown.story?.content).toContain("The quiet morning");
    expect(grown.estimate).toBeLessThanOrEqual(budget);
  });

  it("tells the story before the chat, out of recall, a chat without memory of its own as a new scene", async () => {
    const { app, stores, characterId } = setup([]);
    const [, second = ""] = seed(stores, characterId, 2);
    stores.memory.setState(characterId, { notebook: object.notebook }, 0);
    // Nothing of this chat remembered: the book's latest are told before it, never recalled.
    const fresh = await read(app, characterId, cue, { recap: [], folded: 0 });
    expect(fresh.story?.source).toMatchObject({ part: "story", episodes: 2 });
    expect(fresh.story?.content).toContain(`The story so far\n${NEW_SCENE}`);
    expect(fresh.story?.content).toContain("Where the last scene ended\nThe storm has passed.");
    expect(fresh.story?.content).toContain(
      "Relationships\n- Maren and Ilse: closer after the storm.",
    );
    expect(fresh.story?.content).toContain(
      "Before this chat\nEpisode 0. Maren and Ilse waited out the storm in the boathouse.\n\nEpisode 1.",
    );
    expect(fresh.recalled).toBeUndefined();

    // Once it remembers anything of its own, it is no new scene, and the story before it is
    // still told, all but the chat's own memories.
    for (const memoryState of [
      { recap: [second], folded: 2 },
      { recap: [], folded: 2 },
      { recap: [], held: [{ id: second, turns: 1 }] },
    ]) {
      const own = await read(app, characterId, cue, memoryState);
      expect(own.story?.source).toMatchObject({ part: "story" });
      expect(own.story?.content).not.toContain(NEW_SCENE);
      expect(own.story?.content).toContain("Where things stand\nThe storm has passed.");
      expect(own.story?.content).toContain("Before this chat\nEpisode 0.");
      expect(own.recalled).toBeUndefined();
    }
    // The chat's held memory is its own: not told before it.
    const held = await read(app, characterId, cue, {
      recap: [],
      held: [{ id: second, turns: 1 }],
    });
    expect(held.story?.content).not.toContain("Episode 1");
    const content =
      (await read(app, characterId, cue, { recap: [second], folded: 2 })).story?.content ?? "";
    expect(content).toContain("Before this chat\nEpisode 0.");
    expect(content).toContain("Earlier in this chat\nEpisode 1.");
    expect(content.indexOf("Before this chat")).toBeLessThan(
      content.indexOf("Earlier in this chat"),
    );
  });

  it("opens on the day after the last scene only while a fresh chat's greeting is the memory's opening", async () => {
    const { app, stores, characterId } = setup([]);
    const [first = ""] = seed(stores, characterId, 1);
    stores.memory.setState(characterId, { notebook: object.notebook }, 0);
    const continued = await read(app, characterId, cue, { recap: [], continued: true });
    expect(continued.story?.content).toContain(`The story so far\n${CONTINUED_SCENE}`);
    expect(continued.story?.content).not.toContain(NEW_SCENE);
    expect(continued.story?.content).toContain("Where the last scene ended\nThe storm has passed.");
    // Another greeting in play: a new scene.
    const other = await read(app, characterId, cue, { recap: [], continued: false });
    expect(other.story?.content).toContain(`The story so far\n${NEW_SCENE}`);
    expect(other.story?.content).not.toContain(CONTINUED_SCENE);
    // Once the chat remembers anything of its own, neither.
    const own = await read(app, characterId, cue, { recap: [first], folded: 2, continued: true });
    expect(own.story?.content).not.toContain(CONTINUED_SCENE);
    expect(own.story?.content).not.toContain(NEW_SCENE);
  });

  it("leaves the story before a new chat out, as the recap, of a prompt it would push past the window", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    // Long enough that leaving it out saves more than the new chat's framing costs.
    const dense = Array.from({ length: 120 }, (_, i) => `q${i}x`).join(" ");
    const written = stores.memory.remember(characterId, {
      output: { ...object, summary: dense },
      turns: 2,
      notebookRevision: 0,
    });
    if (typeof written === "string") throw new Error(written);
    const fresh = { recap: [], folded: 0 };
    const small = await read(app, characterId, cue, fresh);
    expect(small.story?.source).toMatchObject({ part: "story", episodes: 1 });
    // As a chat whose own memory it is: the notebook alone in the story block.
    const notebookOnly = await read(app, characterId, cue, {
      recap: [],
      held: [{ id: written.episode.id, turns: 1 }],
    });
    expect(notebookOnly.story?.source).toMatchObject({ part: "story", episodes: 0 });
    const told = (small.story?.tokens ?? 0) - (notebookOnly.story?.tokens ?? 0);
    expect(told).toBeGreaterThan(4);

    const large = await read(app, characterId, overflowing(small.estimate, told), fresh);
    expect(large.story?.source).toMatchObject({ part: "story", episodes: 0 });
    expect(large.story?.content).not.toContain("Before this chat");
    expect(large.estimate).toBeLessThanOrEqual(budget);
  });

  it("gives a fallback the first attempt's lorebook chance", async () => {
    const draws: number[] = [];
    const card: CharacterCard = {
      ...blankCard("Maren"),
      lorebook: {
        entries: [
          {
            keys: [],
            content: "The tide tables.",
            settings: { useProbability: true, probability: 50 },
            enabled: true,
            insertionOrder: 100,
            useRegex: false,
            constant: true,
          },
        ],
      },
    };
    // Every draw hits the chance unless one is queued.
    const { app, stores, characterId } = setup([], { card, random: () => draws.shift() ?? 0.1 });
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const [told = ""] = seed(stores, characterId, 1);
    bury(stores, characterId);
    const state = { recap: [told], folded: 0 };
    draws.push(0.9);
    const small = await read(app, characterId, cue, state);
    expect(small.lorebook?.entries[0]).toMatchObject({ status: "chanceMissed" });
    const recalledTokens = small.recalled?.tokens ?? 0;

    // The first attempt misses the chance and overflows; a fresh draw would hit.
    draws.push(0.9);
    const large = await read(app, characterId, overflowing(small.estimate, recalledTokens), state);
    expect(large.recalled).toBeUndefined();
    expect(large.lorebook?.entries[0]).toMatchObject({ status: "chanceMissed" });
  });

  /** The parsed prompt of a preview of `messages` with `extra`, and its memory parts. */
  const previewOf = async (
    app: ReturnType<typeof setup>["app"],
    characterId: string,
    messages: { role: "user" | "assistant"; content: string }[],
    extra: Record<string, unknown>,
  ) => {
    const response = await app.request(
      "/api/chat/preview",
      postJson(preview(characterId, { messages, ...extra })),
    );
    if (response.status !== 200) throw new Error(await response.text());
    const { prompt } = (await response.json()) as { prompt: unknown };
    const parsed = inspectedPromptSchema.parse(prompt);
    const part = (name: string) =>
      parsed.messages.find(
        (message) => message.source.kind === "memory" && message.source.part === name,
      );
    return { prompt: parsed, story: part("story"), recalled: part("recalled") };
  };
  /** A turn of about `tokens` tokens, marked so a test finds it. */
  const long = (mark: string, tokens: number) => `${mark}${" wave".repeat(tokens)}`;
  const turnsOf = (...contents: string[]) =>
    contents.map((content, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content,
    }));
  const sentText = (prompt: { messages: { content: string }[] }) =>
    prompt.messages.map((message) => message.content).join("\n");

  it("sends held spans' turns whole while they fit, their memories neither told nor recalled", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    // Every seeded episode has the cue the last turn names: each could be recalled.
    const [told = "", heldId = ""] = seed(stores, characterId, 2);
    bury(stores, characterId);
    const messages = turnsOf("held-one", "held-two", `Live.${cue}`);
    const { prompt, story, recalled } = await previewOf(app, characterId, messages, {
      memoryState: { recap: [told], held: [{ id: heldId, turns: 2 }] },
    });
    expect(prompt.memoryFold).toBeUndefined();
    expect(prompt.history).toEqual({ sent: 3, total: 3 });
    expect(sentText(prompt)).toContain("held-one");
    // This chat's folded one, and the chapter before it; the held one is neither.
    expect(story?.source).toMatchObject({ part: "story", episodes: 2 });
    expect(story?.content).toContain("Episode 0");
    expect(story?.content).toContain("Buried chapter");
    expect(story?.content).not.toContain("Episode 1");
    // The positive control: another episode with the cue is recalled; the held one never.
    expect(recalled?.content).toContain("Buried 0");
    expect(recalled?.content).not.toContain("Episode 1");
  });

  it("never recalls a chapter that took a held memory since, at any depth, another chat's roll-up of the book", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const [other = "", heldId = "", third = ""] = seed(stores, characterId, 3);
    const merge = (ids: string[], output: typeof chapterObject) => {
      const members = ids.map((id) => {
        const stored = stores.memory.get(id);
        if (stored === undefined) throw new Error("missing");
        return { id, revision: stored.revision, chapterId: stored.chapterId };
      });
      const chapter = stores.memory.chapter(characterId, { output, members });
      if (typeof chapter === "string") throw new Error(chapter);
      return chapter.id;
    };
    // Two cues the last turn names: the inner chapter would outrank every member.
    const inner = merge([other, heldId], {
      ...chapterObject,
      title: "Taken chapter",
      cues: ["boathouse", "back"],
    });
    merge([inner, third], { ...chapterObject, title: "Outer chapter" });
    const { story, recalled } = await previewOf(
      app,
      characterId,
      turnsOf("held-one", `Live.${cue}`),
      { memoryState: { recap: [], held: [{ id: heldId, turns: 1 }] } },
    );
    // Its held turns are still sent: the chapter that holds it is neither told nor recalled.
    for (const title of ["Taken chapter", "Outer chapter"]) {
      expect(story?.content ?? "").not.toContain(title);
      expect(recalled?.content ?? "").not.toContain(title);
    }
    // The positive control: the other members, another chat's, are recalled by their cue.
    expect(recalled?.content).toContain("Episode 0");
    expect(recalled?.content).toContain("Episode 2");
  });

  it("folds the oldest held spans only once the history is trimmed, enough to cover it, and says so", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const ids = seed(stores, characterId, 7);
    const booksOf = vi.spyOn(stores.lorebooks, "booksOf");
    // Eight turns of about 1,100 tokens: three more than the budget holds.
    const contents = Array.from({ length: 8 }, (_, index) => long(`turn-${index}:`, 1_100));
    const held = ids.map((id) => ({ id, turns: 1 }));
    const { prompt, story } = await previewOf(app, characterId, turnsOf(...contents, "Now."), {
      memoryState: { recap: [], held },
    });
    const fold = prompt.memoryFold;
    expect(fold?.spans).toBeGreaterThanOrEqual(2);
    expect(fold?.turns).toBe(fold?.spans);
    // What is left fits whole, and only the folded spans left the history.
    expect(prompt.history.sent).toBe(prompt.history.total);
    expect(prompt.history.total).toBe(9 - (fold?.turns ?? 0));
    expect(sentText(prompt)).not.toContain("turn-0:");
    expect(sentText(prompt)).toContain(`turn-${fold?.turns ?? 0}:`);
    expect(story?.source).toMatchObject({ part: "story", episodes: fold?.spans });
    // One assembly to measure, one to fold: at most one per held span and one more.
    expect(booksOf.mock.calls.length).toBeLessThanOrEqual(3);
    expect(booksOf.mock.calls.length).toBeLessThanOrEqual(held.length + 1);

    // The same chat in a large window folds nothing.
    stores.settings.update({ contextLimits: {} });
    const wide = await previewOf(app, characterId, turnsOf(...contents, "Now."), {
      memoryState: { recap: [], held },
    });
    expect(wide.prompt.memoryFold).toBeUndefined();
    expect(wide.prompt.history).toEqual({ sent: 9, total: 9 });
  });

  it("folds timed anchors, keeping effects that started inside the folded span", async () => {
    const entry = (overrides: Partial<LorebookEntry>): LorebookEntry => ({
      keys: [],
      content: "",

      enabled: true,
      insertionOrder: 100,
      useRegex: false,
      ...overrides,
    });
    const card: CharacterCard = {
      ...blankCard("Maren"),
      lorebook: {
        entries: [
          entry({ keys: ["lantern"], content: "The lantern lore.", settings: { sticky: 20 } }),
          entry({ keys: ["anchor"], content: "The anchor lore.", settings: { sticky: 20 } }),
          entry({ constant: true, content: "The late lore.", settings: { delay: 9 } }),
        ],
      },
    };
    const { app, stores, characterId } = setup([], { card });
    stores.settings.update({ contextLimits: { "fake-model": window } });
    // The entries' digests, as a first request records them.
    const first = await previewOf(app, characterId, turnsOf("The lantern and the anchor."), {
      memoryState: { recap: [] },
    });
    const effects = first.prompt.lorebookState?.effects ?? [];
    expect(effects).toHaveLength(2);
    const [lantern, anchor] = effects;
    // The lantern's effect started inside the span that folds, the anchor's after it.
    const lorebookState: LorebookState = {
      characterId,
      effects: [
        { index: 0, digest: lantern?.digest ?? "", start: 1 },
        { index: 1, digest: anchor?.digest ?? "", start: 6 },
      ],
    };
    const [A, B] = [randomUUID(), randomUUID()];
    const eventsState: EventsState = {
      characterId,
      fired: [
        { id: A, start: 1 },
        { id: B, start: 6 },
      ],
    };
    const [heldId = ""] = seed(stores, characterId, 1);
    const contents = Array.from({ length: 8 }, (_, index) => long(`turn-${index}:`, 1_100));
    const { prompt } = await previewOf(app, characterId, turnsOf(...contents, "Quiet now."), {
      memoryState: {
        recap: [],
        held: [{ id: heldId, turns: 4 }],
      },
      lorebookState,
      eventsState,
    });
    expect(prompt.memoryFold).toEqual({ spans: 1, turns: 4 });
    const status = (index: number) =>
      prompt.lorebook?.entries.find((reported) => reported.index === index)?.status;
    expect(status(0)).toBe("sent");
    expect(status(1)).toBe("sent");
    expect(prompt.lorebookState?.effects).toEqual([
      { index: 0, digest: lantern?.digest, start: -3 },
      { index: 1, digest: anchor?.digest, start: 2 },
    ]);
    // Five turns left, nine with the folded ones: the delay of nine has passed.
    expect(status(2)).toBe("sent");
    expect(prompt.eventsState).toEqual({
      characterId,
      fired: [
        { id: A, start: -3, foldedReplies: 1 },
        { id: B, start: 2 },
      ],
    });
  });

  it("drops a failed reply's stale event anchor during an impersonation fold before the next roll", async () => {
    const { app, stores, characterId } = setup([
      { chunks: ["The wind rises."] },
      { chunks: ["Maren watches the harbour."] },
    ]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const stale = randomUUID();
    const valid = randomUUID();
    for (const [id, text] of [
      [stale, "A gull steals a hat."],
      [valid, "A bell rings."],
    ] as const) {
      stores.events.create(
        {
          text,
          chance: 100,
          cooldown: 10,
          enabled: true,
          scope: { kind: "all" },
        },
        id,
      );
    }
    const send = async (extra: Record<string, unknown>) => {
      const response = await app.request("/api/chat", postJson(preview(characterId, extra)));
      expect(response.status).toBe(200);
      return promptPart(await responseParts(response));
    };
    const [heldId = ""] = seed(stores, characterId, 1);
    const messages = [
      { role: "assistant", content: long("Greeting.", 1_400) },
      { role: "user", content: long("First question.", 1_400) },
      { role: "assistant", content: long("First reply.", 1_400) },
      { role: "user", content: long("Second question.", 1_400) },
      { role: "user", content: long("Third question after a failed reply.", 1_400) },
      { role: "user", content: "Now." },
    ];
    const folded = await send({
      mode: "impersonate",
      messages,
      memoryState: { recap: [], foldedUsers: 0, held: [{ id: heldId, turns: 5 }] },
      eventsState: {
        characterId,
        fired: [
          { id: stale, start: 4 },
          { id: valid, start: 2 },
        ],
      },
    });
    expect(folded.memoryFold).toEqual({ spans: 1, turns: 5 });
    expect(folded.eventsState).toEqual({
      characterId,
      fired: [{ id: valid, start: -3, foldedReplies: 0 }],
    });
    const next = await send({
      messages: [{ role: "user", content: "The wind rises." }],
      memoryState: { recap: [heldId], folded: 5, foldedUsers: 3 },
      eventsState: folded.eventsState,
    });
    // Only the event whose firing reply failed is eligible; the valid folded reply stays cooled.
    expect(next.messages.filter((message) => message.source.kind === "event")).toEqual([
      expect.objectContaining({ content: expect.stringContaining("A gull steals a hat.") }),
    ]);
    expect(next.eventsState?.fired.map(({ id }) => id)).toEqual([valid, stale]);
  });

  it("keeps Author's Note cadence and its linked lorebook entry across prompt-fit folds", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const preset = defaultPromptPreset("Every six user turns");
    const promptPresetId = stores.presets.prompt.create(
      {
        ...preset,
        authorsNote: {
          ...preset.authorsNote,
          text: "Keep the storm in view.",
          role: "system",
          depth: 0,
          frequency: 6,
        },
      },
      randomUUID(),
    );
    const lorebookId = stores.lorebooks.create(
      {
        name: "Storm",
        book: {
          ...blankLorebook("Storm"),
          entries: [
            {
              keys: [],
              content: "The storm's linked note.",
              enabled: true,
              insertionOrder: 100,
              useRegex: false,
              constant: true,
              settings: { placement: "anTop" },
            },
          ],
        },
      },
      randomUUID(),
    );
    expect(stores.lorebooks.link(lorebookId, characterId)).toBe("linked");
    const ids = seed(stores, characterId, 3);
    const held = ids.map((id) => ({ id, turns: 2 }));
    const contents = Array.from({ length: 8 }, (_, index) => long(`turn-${index}:`, 1_100));
    const messages = turnsOf(...contents, "Now.");
    const memoryState = { recap: [], folded: 2, foldedUsers: 1, held };
    const large = await previewOf(app, characterId, messages, { memoryState, promptPresetId });
    expect(large.prompt.memoryFold?.spans).toBeGreaterThanOrEqual(2);
    expect(large.prompt.history.sent).toBe(large.prompt.history.total);
    const note = (prompt: typeof large.prompt) =>
      prompt.messages.find((message) => message.source.kind === "authorsNote")?.content;
    expect(note(large.prompt)).toBe("The storm's linked note.\nKeep the storm in view.");
    expect(large.prompt.lorebook?.sources.some((source) => source.id === lorebookId)).toBe(true);
    expect(large.prompt.lorebook?.entries[0]?.status).toBe("sent");
    // A larger window sends the original history, with the same note and eligible entry.
    stores.settings.update({ contextLimits: {} });
    const wide = await previewOf(app, characterId, messages, { memoryState, promptPresetId });
    expect(wide.prompt.memoryFold).toBeUndefined();
    expect(note(wide.prompt)).toBe(note(large.prompt));
    // The prior folded user count participates even when nothing folds in this request.
    const notDue = await previewOf(app, characterId, messages, {
      memoryState: { ...memoryState, foldedUsers: 0 },
      promptPresetId,
    });
    expect(note(notDue.prompt)).toBeUndefined();
    expect(notDue.prompt.lorebook?.entries[0]?.status).toBe("noteOff");
  });

  it("counts folded users toward the Author's Note cadence", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const contents = Array.from({ length: 8 }, (_, index) => long(`turn-${index}:`, 1_100));
    const messages = turnsOf(...contents, "Now.");
    const users = messages.filter((turn) => turn.role === "user").length;
    const preset = defaultPromptPreset("Note cadence");
    const promptPresetId = stores.presets.prompt.create(
      {
        ...preset,
        authorsNote: {
          ...preset.authorsNote,
          text: "Keep the storm in view.",
          role: "system",
          depth: 0,
          frequency: users,
        },
      },
      randomUUID(),
    );
    const [heldId = ""] = seed(stores, characterId, 1);
    const { prompt } = await previewOf(app, characterId, messages, {
      promptPresetId,
      memoryState: { recap: [], held: [{ id: heldId, turns: contents.length }] },
    });
    const folded = prompt.memoryFold?.turns ?? 0;
    expect(folded).toBeGreaterThan(0);
    expect(prompt.history.sent).toBe(prompt.history.total);
    const liveUsers = messages.slice(folded).filter((turn) => turn.role === "user").length;
    expect(liveUsers).toBeGreaterThan(0);
    expect(liveUsers).toBeLessThan(users);
    // The frequency is due on the whole history, the folded turns included.
    expect(prompt.messages.some((message) => message.source.kind === "authorsNote")).toBe(true);
  });

  it("reads the first attempt's draws in every fold", async () => {
    const draws: number[] = [];
    const card: CharacterCard = {
      ...blankCard("Maren"),
      lorebook: {
        entries: [
          {
            keys: [],
            content: "The tide tables.",
            settings: { useProbability: true, probability: 50 },
            enabled: true,
            insertionOrder: 100,
            useRegex: false,
            constant: true,
          },
        ],
      },
    };
    // Every draw hits the chance unless one is queued: the first attempt misses it.
    const { app, stores, characterId } = setup([], { card, random: () => draws.shift() ?? 0.1 });
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const [heldId = ""] = seed(stores, characterId, 1);
    const contents = Array.from({ length: 8 }, (_, index) => long(`turn-${index}:`, 1_100));
    draws.push(0.9);
    const { prompt } = await previewOf(app, characterId, turnsOf(...contents, "Now."), {
      memoryState: { recap: [], held: [{ id: heldId, turns: 4 }] },
    });
    expect(prompt.memoryFold).toEqual({ spans: 1, turns: 4 });
    expect(prompt.lorebook?.entries[0]).toMatchObject({ status: "chanceMissed" });
  });

  it("folds every held span before it leaves recall out", async () => {
    const { app, stores, characterId } = setup([]);
    stores.settings.update({ contextLimits: { "fake-model": window } });
    const [told = "", heldId = ""] = seed(stores, characterId, 2);
    bury(stores, characterId);
    // As the prompt reads once the held span folds: both memories and the chapter before them
    // told, its members recalled.
    const small = await read(app, characterId, cue, { recap: [told, heldId] });
    const recalledTokens = small.recalled?.tokens ?? 0;
    expect(recalledTokens).toBeGreaterThan(4);

    const large = await previewOf(
      app,
      characterId,
      turnsOf("held-one", "held-two", overflowing(small.estimate, recalledTokens)),
      { memoryState: { recap: [told], held: [{ id: heldId, turns: 2 }] } },
    );
    expect(large.prompt.memoryFold).toEqual({ spans: 1, turns: 2 });
    expect(large.recalled).toBeUndefined();
    expect(large.story?.source).toMatchObject({ part: "story", episodes: 3 });
    expect(large.prompt.estimate).toBeLessThanOrEqual(budget);
  });

  it("tells a stale recap as its outermost chapters", async () => {
    const { app, stores, characterId } = setup([]);
    const { stale } = nest(stores, characterId);
    const { story } = await read(app, characterId, "Hello.", { recap: stale, folded: 4 });
    expect(story?.source).toMatchObject({ part: "story", episodes: 2 });
    expect(story?.content).toContain("Outer chapter");
    expect(story?.content).not.toContain("Inner chapter");
  });

  it("takes more folded turns than one request may send", async () => {
    const { app, stores, characterId } = setup([]);
    const [told = ""] = seed(stores, characterId, 1);
    const { story } = await read(app, characterId, "Hello.", {
      recap: [told],
      folded: MAX_CHAT_TURNS * 2,
    });
    expect(story?.source).toMatchObject({ part: "story", episodes: 1 });
  });

  it("adds no memory to a request without a memoryState, the notebook on", async () => {
    const { app, stores, characterId } = setup([]);
    const revision = stores.memory.state(characterId)?.revision ?? 0;
    stores.memory.remember(characterId, { output: object, turns: 2, notebookRevision: revision });
    const memoryParts = async (extra: Record<string, unknown>) => {
      const response = await app.request(
        "/api/chat/preview",
        postJson(preview(characterId, extra)),
      );
      expect(response.status).toBe(200);
      const { prompt } = (await response.json()) as { prompt: unknown };
      return inspectedPromptSchema
        .parse(prompt)
        .messages.filter((message) => message.source.kind === "memory");
    };
    // The same request with a memoryState carries the notebook.
    expect(await memoryParts({ memoryState: { recap: [] } })).toHaveLength(1);
    expect(await memoryParts({})).toEqual([]);
  });
});

describe("the opening call", () => {
  /** What the model writes: the Location line unset and the persona by name. */
  const named = "Location: The pier, dawn\nMaren waits beside Aria Lund at the rail.";
  const written = "> Location: The pier, dawn\n\nMaren waits beside {{user}} at the rail.";
  const openingPath = (characterId: string) => `/api/memory/characters/${characterId}/opening`;
  const write = (app: ReturnType<typeof setup>["app"], characterId: string, body: unknown) =>
    app.request(openingPath(characterId), postJson(body));
  const sent = (upstream: ReturnType<typeof setup>["upstream"], index = 0) =>
    (upstream.records[index]?.body as { messages: { role: string; content: string }[] } | undefined)
      ?.messages ?? [];

  it("writes an opening from the notebook and the newest memories, the persona as {{user}}, storing nothing", async () => {
    const { app, lines, stores, upstream, characterId } = setup([answer({ opening: named })]);
    bury(stores, characterId);
    seed(stores, characterId, 2);
    stores.memory.setState(
      characterId,
      { notebook: object.notebook, opening: "> Location: Ashore\n\nMaren waits." },
      stores.memory.state(characterId)?.revision ?? 0,
    );
    const personaId = stores.personas.create({ name: "Aria Lund", description: "" }, randomUUID());
    const before = {
      state: stores.memory.state(characterId),
      book: stores.memory.list(characterId),
    };
    const response = await write(app, characterId, {
      personaId,
      model: "fake-model",
      reasoning: "high",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ opening: written });
    // Nothing persisted: the row, its opening and the book are as they were.
    expect(stores.memory.state(characterId)).toEqual(before.state);
    expect(stores.memory.list(characterId)).toEqual(before.book);
    const [system, user] = sent(upstream);
    expect(system?.content).toContain("write one thing: the opening of the next chat");
    expect(system?.content).toContain("called Aria Lund in the message");
    // The story outside nothing, in story order: the chapter, then the newest episodes;
    // a chapter's members are told by it.
    const message = user?.content ?? "";
    expect(message).toContain(object.notebook.situation);
    expect(message.indexOf("Buried chapter.")).toBeGreaterThan(-1);
    expect(message.indexOf("Buried chapter.")).toBeLessThan(message.indexOf("Episode 0."));
    expect(message.indexOf("Episode 0.")).toBeLessThan(message.indexOf("Episode 1."));
    expect(message).not.toContain("Buried 0.");
    // The memory model and its offered effort.
    expect(upstream.records[0]?.body).toMatchObject({ model: "fake-model" });
    const logged = lines
      .map((line) => JSON.parse(line))
      .filter((l) => l.event === "memory.opening");
    expect(logged).toEqual([
      expect.objectContaining({ model: "fake-model", finishReason: "stop", attempt: 1 }),
    ]);
    for (const line of lines) {
      expect(line).not.toContain("The pier, dawn");
      expect(line).not.toContain(object.notebook.situation);
    }
  });

  it("writes one from the notebook alone, the newest memories that fit the window", async () => {
    const { app, stores, upstream, characterId } = setup([answer({ opening: written })], {
      catalog: [{ ...catalogEntry("small"), context_window: 32_000 }],
    });
    // Past the memory blocks' share of a small window: the oldest stay out.
    const long = "The tide came in. ".repeat(200);
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const kept = stores.memory.remember(characterId, {
        output: { ...object, title: `Tide ${index}`, summary: long },
        turns: 2,
        notebookRevision: -1,
      });
      if (typeof kept === "string") throw new Error(kept);
    }
    const response = await write(app, characterId, { model: "small" });
    expect(await response.json()).toMatchObject({ opening: written });
    const message = sent(upstream)[1]?.content ?? "";
    expect(message).toContain("Tide 5.");
    expect(message).not.toContain("Tide 0.");

    const notebookOnly = setup([answer({ opening: written })]);
    notebookOnly.stores.memory.setState(
      notebookOnly.characterId,
      { notebook: { ...object.notebook } },
      0,
    );
    const alone = await write(notebookOnly.app, notebookOnly.characterId, { model: "fake-model" });
    expect(await alone.json()).toMatchObject({ opening: written });
    expect(sent(notebookOnly.upstream)[1]?.content).toContain("There are no memories yet.");
  });

  it("refuses, calling nothing, what has nothing to write from or no memory", async () => {
    const empty = setup([answer({ opening: written })]);
    const nothing = await write(empty.app, empty.characterId, { model: "fake-model" });
    expect(nothing.status).toBe(409);
    expect(await nothing.json()).toEqual({ error: "nothing_to_remember" });
    // An opening alone is nothing to write a new one from.
    empty.stores.memory.setState(empty.characterId, { opening: written }, 0);
    expect(
      await (await write(empty.app, empty.characterId, { model: "fake-model" })).json(),
    ).toEqual({ error: "nothing_to_remember" });
    expect(empty.calls()).toBe(0);

    const off = setup([answer({ opening: written })]);
    seed(off.stores, off.characterId, 1);
    off.stores.memory.setState(
      off.characterId,
      { enabled: false },
      off.stores.memory.state(off.characterId)?.revision ?? 0,
    );
    const refused = await write(off.app, off.characterId, { model: "fake-model" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "memory_off" });
    const missing = await write(off.app, randomUUID(), { model: "fake-model" });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "memory_off" });
    expect(off.calls()).toBe(0);
  });

  it("refuses a model without a known window and a prompt too long for it", async () => {
    const { app, stores, characterId, calls } = setup([answer({ opening: written })], {
      catalog: [
        catalogEntry("fake-model"),
        { ...catalogEntry("tiny"), context_window: MEMORY_LIMITS.replyReserve + 64 },
      ],
    });
    seed(stores, characterId, 1);
    const unknown = await write(app, characterId, { model: "unlisted" });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: "context_window_unknown" });
    const tiny = await write(app, characterId, { model: "tiny" });
    expect(tiny.status).toBe(422);
    expect(await tiny.json()).toEqual({ error: "prompt_too_long" });
    expect(calls()).toBe(0);
  });

  it("gives the call the constant entries of the card's and the linked books as canon", async () => {
    const lore = (content: string, constant: boolean): LorebookEntry => ({
      keys: constant ? [] : ["pier"],
      content,

      enabled: true,
      insertionOrder: 100,
      useRegex: false,
      constant,
    });
    const card: CharacterCard = {
      ...blankCard("Maren"),
      lorebook: {
        entries: [lore("opening-embedded-c41a", true), lore("opening-keyed-5e0b", false)],
      },
    };
    const { app, stores, upstream, characterId } = setup([answer({ opening: written })], { card });
    const lorebookId = stores.lorebooks.create(
      {
        name: "Harbour",
        book: { ...blankLorebook("Harbour"), entries: [lore("opening-linked-8d2f", true)] },
      },
      randomUUID(),
    );
    expect(stores.lorebooks.link(lorebookId, characterId)).toBe("linked");
    // The notebook names the keyed entry's key: no turns, so it still stays out.
    stores.memory.setState(
      characterId,
      { notebook: { ...object.notebook, situation: "Maren waits on the pier." } },
      0,
    );
    const response = await write(app, characterId, { model: "fake-model" });
    expect(await response.json()).toMatchObject({ opening: written });
    const message = sent(upstream)[1]?.content ?? "";
    expect(message).toContain("opening-embedded-c41a");
    expect(message).toContain("opening-linked-8d2f");
    expect(message).not.toContain("opening-keyed-5e0b");
  });

  it("ends an incomplete upload at the request's deadline and stops reading it", async () => {
    const upstream = fakeUpstream({ turns: [answer({ opening: written })] });
    const { app, instances } = testApp({ fetch: upstream.fetch }, { requestTimeoutMs: 100 });
    const { stores } = instances.instance(TEST_USER);
    const characterId = stores.characters.create(blankCard("Maren"));
    seed(stores, characterId, 1);
    // The start of a body, then nothing: the upload stalls without ending.
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"fake-'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const started = Date.now();
    const response = await app.fetch(
      new Request(`http://app.test${openingPath(characterId)}`, {
        method: "POST",
        headers: ownerHeaders(),
        body: stalled,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "request_timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cancelled).toBe(true);
    expect(upstream.records).toHaveLength(0);
  });

  it("refuses malformed requests", async () => {
    const { app, stores, characterId, calls } = setup([answer({ opening: written })]);
    seed(stores, characterId, 1);
    for (const body of [{}, { model: "" }, { model: "fake-model", turns: span }]) {
      const response = await write(app, characterId, body);
      expect(response.status).toBe(400);
    }
    expect((await app.request(openingPath("nope"), postJson({ model: "m" }))).status).toBe(400);
    expect(calls()).toBe(0);
  });

  it("answers the upstream's failures as a memory call does, logging class and status only", async () => {
    const failed = setup([failure, answer({ opening: written })]);
    seed(failed.stores, failed.characterId, 1);
    const response = await write(failed.app, failed.characterId, { model: "fake-model" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: "memory_failed" });
    expect(failed.calls()).toBe(1);
    noCanary(failed.lines);
    const errors = failed.lines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "memory.opening.error");
    expect(errors.map((line) => [line.status, line.attempt])).toEqual([[400, 1]]);

    // No opening in two answers is no answer.
    const blank = setup([answer({ opening: " " }), answer({})]);
    seed(blank.stores, blank.characterId, 1);
    expect(
      await (await write(blank.app, blank.characterId, { model: "fake-model" })).json(),
    ).toMatchObject({ error: "memory_failed" });
    expect(blank.calls()).toBe(2);

    const busied = setup([busy(429), busy(429), busy(429), answer({ opening: written })]);
    seed(busied.stores, busied.characterId, 1);
    expect(
      await (await write(busied.app, busied.characterId, { model: "fake-model" })).json(),
    ).toMatchObject({ error: "upstream_busy", retryAfterS: 0 });
  });

  it("answers memory_off when memory is forgotten or turned off during the call", async () => {
    let during = async () => {};
    const { app, stores, characterId } = setup([answer({ opening: written })], {
      before: () => during(),
    });
    seed(stores, characterId, 1);
    during = async () => {
      const path = `/api/memory/characters/${characterId}`;
      expect((await app.request(path, { method: "DELETE", headers: ownerHeaders() })).status).toBe(
        200,
      );
    };
    const response = await write(app, characterId, { model: "fake-model" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: "memory_off" });
    expect(stores.memory.state(characterId)?.opening ?? "").toBe("");
  });
});
