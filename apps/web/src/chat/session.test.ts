import {
  blankCard,
  type CharacterMemory,
  DEFAULT_SETTINGS,
  defaultPromptPreset,
  defaultSamplerPreset,
  type Settings,
  type StoredCharacter,
  type StoredPersona,
  type StoredPromptPreset,
  type StoredSamplerPreset,
} from "@ephemera/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsQuery } from "../api.ts";
import { queryClient } from "../app/query.ts";
import { characterQuery } from "../characters/queries.ts";
import { MEMORY_KEY, memoryQuery } from "../memory/queries.ts";
import { personaQuery } from "../personas/queries.ts";
import { presetQuery } from "../presets/queries.ts";
import { SETTINGS_MUTATION_KEY } from "../settings/save-history.ts";
import { settingsQuery } from "../settings/settings.ts";
import { signIn } from "../signin/signin.ts";
import { currentRegister } from "./cast-slice.ts";
import { chatStore, chatSubject, greetingSubject, memoryChanged } from "./session.ts";
import { NO_MEMORY, type Selection } from "./store.ts";
import * as transport from "./transport.ts";

/** Synthetic ids and values only. */
const SAMPLER = "33333333-3333-4333-8333-333333333333";
const samplerKey = presetQuery("sampler", SAMPLER).queryKey;

function sampler(maxOutputTokens: number | null): StoredSamplerPreset {
  const preset = defaultSamplerPreset("Short replies");
  return {
    id: SAMPLER,
    ...preset,
    values: { ...preset.values, maxOutputTokens },
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

const selectionOf = (change: Partial<Selection> = {}): Selection => ({
  model: "model-a",
  samplerPresetId: null,
  promptPresetId: null,
  characterId: null,
  personaId: null,
  reasoning: null,
  ...change,
});

/** The tab's settings, as loaded. */
const settle = (change: Partial<Settings> = {}) =>
  queryClient.setQueryData(settingsQuery.queryKey, { ...DEFAULT_SETTINGS, ...change });

/** A fetch the test answers by hand, once it was asked. */
function heldFetch() {
  let respond: (response: Response) => void = () => {};
  const asked = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  vi.stubGlobal("fetch", asked);
  return {
    asked,
    answer: async (response: Response) => {
      await vi.waitFor(() => expect(asked).toHaveBeenCalled());
      respond(response);
    },
  };
}

beforeEach(() => {
  queryClient.clear();
  settle();
  queryClient.setQueryData(modelsQuery.queryKey, [
    { id: "model-a", contextWindow: 8_192, outputLimit: null, reasoning: null, images: null },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  signIn.reset();
});

describe("the subject's runtime", () => {
  it("refreshes an expired model catalog before filling runtime macros", async () => {
    queryClient.setQueryData(
      modelsQuery.queryKey,
      [{ id: "model-a", contextWindow: 8_192, outputLimit: null, reasoning: null, images: null }],
      { updatedAt: Date.now() - 10 * 60_000 },
    );
    const fetched = vi.fn(async () =>
      Response.json({
        models: [
          {
            id: "model-a",
            contextWindow: 16_384,
            outputLimit: null,
            reasoning: null,
            images: null,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetched);
    expect(await chatSubject(selectionOf())).toMatchObject({
      ok: true,
      subject: { runtime: { window: 16_384, reserve: 4_096 } },
    });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("is the selection's model, the catalog's window and the sampler preset's reply length", async () => {
    queryClient.setQueryData(samplerKey, sampler(500));
    const fetched = vi.fn(async () => Response.json({ preset: sampler(900) }));
    vi.stubGlobal("fetch", fetched);
    expect(await chatSubject(selectionOf({ samplerPresetId: SAMPLER }))).toMatchObject({
      ok: true,
      subject: { runtime: { model: "model-a", window: 8_192, reserve: 500 } },
    });
    // Cached and not invalidated: nothing is fetched again.
    expect(fetched).not.toHaveBeenCalled();
  });

  it("follows the server without a sampler preset or with a deleted one, and reads an owner's window", async () => {
    settle({ contextWindows: { "model-b": 2_048 } });
    expect(await chatSubject(selectionOf({ model: "model-b" }))).toMatchObject({
      ok: true,
      subject: { runtime: { model: "model-b", window: 2_048, reserve: 512 } },
    });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    expect(await chatSubject(selectionOf({ samplerPresetId: SAMPLER }))).toMatchObject({
      ok: true,
      subject: { runtime: { model: "model-a", window: 8_192, reserve: 2_048 } },
    });
  });

  it("refuses an action for a model without a known window; the greeting fills without one", async () => {
    const selection = selectionOf({ model: "model-unknown" });
    expect(await chatSubject(selection)).toEqual({ ok: false, reason: "context_window_unknown" });
    const greeting = await greetingSubject(selection);
    expect(greeting).toMatchObject({ ok: true });
    expect(greeting).not.toHaveProperty(["subject", "runtime"]);
  });

  it("keeps the last catalog that loaded when its refresh fails; without one the window stays unknown", async () => {
    // Not retried here, so the failure is final at once.
    queryClient.setQueryDefaults(modelsQuery.queryKey, { retry: false });
    try {
      queryClient.setQueryData(
        modelsQuery.queryKey,
        [{ id: "model-a", contextWindow: 8_192, outputLimit: null, reasoning: null, images: null }],
        { updatedAt: Date.now() - 10 * 60_000 },
      );
      const fetched = vi.fn(async () => new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", fetched);
      expect(await chatSubject(selectionOf())).toMatchObject({
        ok: true,
        subject: { runtime: { model: "model-a", window: 8_192 } },
      });
      expect(fetched).toHaveBeenCalledTimes(1);
      queryClient.removeQueries({ queryKey: modelsQuery.queryKey });
      expect(await chatSubject(selectionOf())).toEqual({
        ok: false,
        reason: "context_window_unknown",
      });
    } finally {
      queryClient.setQueryDefaults(modelsQuery.queryKey, {});
    }
  });
});

describe("saved entities replaced while another read waits", () => {
  const CHARACTER = "55555555-5555-4555-8555-555555555555";
  const PERSONA = "66666666-6666-4666-8666-666666666666";
  const PROMPT = "77777777-7777-4777-8777-777777777777";

  const character = (name: string): StoredCharacter => ({
    id: CHARACTER,
    card: blankCard(name),
    portrait: null,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  });
  const persona = (name: string): StoredPersona => ({
    id: PERSONA,
    name,
    portrait: null,
    characterIds: [],
    updatedAt: 0,
    description: "",
    revision: 0,
    createdAt: 0,
  });
  const prompt = (name: string): StoredPromptPreset => ({
    id: PROMPT,
    ...defaultPromptPreset(name),
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  /** Lets the reads that answer from the cache settle while a fetch is held. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  const cases: [string, Partial<Selection>, () => void, () => void][] = [
    [
      "character",
      { characterId: CHARACTER },
      () => queryClient.setQueryData(characterQuery(CHARACTER).queryKey, character("Old")),
      () => queryClient.setQueryData(characterQuery(CHARACTER).queryKey, character("New")),
    ],
    [
      "persona",
      { personaId: PERSONA },
      () => queryClient.setQueryData(personaQuery(PERSONA).queryKey, persona("Old")),
      () => queryClient.setQueryData(personaQuery(PERSONA).queryKey, persona("New")),
    ],
    [
      "prompt preset",
      { promptPresetId: PROMPT },
      () => queryClient.setQueryData(presetQuery("prompt", PROMPT).queryKey, prompt("Old")),
      () => queryClient.setQueryData(presetQuery("prompt", PROMPT).queryKey, prompt("New")),
    ],
  ];

  it.each(cases)(
    "a %s saved while the catalog refreshes is out of date, then read as saved",
    async (_, change, cacheOld, saveNew) => {
      cacheOld();
      queryClient.setQueryData(
        modelsQuery.queryKey,
        [{ id: "model-a", contextWindow: 8_192, outputLimit: null, reasoning: null, images: null }],
        { updatedAt: Date.now() - 10 * 60_000 },
      );
      const held = heldFetch();
      const loading = chatSubject(selectionOf(change));
      await vi.waitFor(() => expect(held.asked).toHaveBeenCalled());
      await settled();
      saveNew();
      await held.answer(
        Response.json({
          models: [
            {
              id: "model-a",
              contextWindow: 8_192,
              outputLimit: null,
              reasoning: null,
              images: null,
            },
          ],
        }),
      );
      expect(await loading).toEqual({ ok: false, reason: "changed" });
      const again = await chatSubject(selectionOf(change));
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      if (change.characterId !== undefined) expect(again.subject.character?.name).toBe("New");
      if (change.personaId !== undefined) expect(again.subject.persona?.name).toBe("New");
      if (change.promptPresetId !== undefined) expect(again.subject.preset.name).toBe("New");
    },
  );

  it("a catalog refreshed while a saved entity loads is out of date, then read as refreshed", async () => {
    const held = heldFetch();
    const loading = chatSubject(selectionOf({ characterId: CHARACTER }));
    await vi.waitFor(() => expect(held.asked).toHaveBeenCalled());
    await settled();
    queryClient.setQueryData(modelsQuery.queryKey, [
      { id: "model-a", contextWindow: 16_384, outputLimit: null, reasoning: null, images: null },
    ]);
    await held.answer(Response.json(character("Keeper")));
    expect(await loading).toEqual({ ok: false, reason: "changed" });
    expect(await chatSubject(selectionOf({ characterId: CHARACTER }))).toMatchObject({
      ok: true,
      subject: { character: { name: "Keeper" }, runtime: { window: 16_384 } },
    });
  });
});

describe("saved entities an action reads", () => {
  it("uses the observer's shared card identity after an unchanged refresh", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const stored: StoredCharacter = {
      id,
      card: blankCard("Keeper"),
      portrait: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const key = characterQuery(id).queryKey;
    queryClient.setQueryData(key, stored);
    const observed = queryClient.getQueryData<StoredCharacter>(key)?.card;
    const held = heldFetch();
    const refreshing = queryClient.fetchQuery({ ...characterQuery(id), staleTime: 0 });
    const loading = greetingSubject(selectionOf({ characterId: id }));
    await held.answer(Response.json(stored));
    await refreshing;
    const result = await loading;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.subject.character).toBe(observed);
  });

  it("refuses to fill a greeting with a failed chosen preset, then reads it after recovery", async () => {
    const selection = selectionOf({ samplerPresetId: SAMPLER });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    expect(await greetingSubject(selection)).toEqual({ ok: false });
    vi.stubGlobal("fetch", async () => Response.json({ preset: sampler(600) }));
    expect(await greetingSubject(selection)).toMatchObject({
      ok: true,
      subject: { runtime: { reserve: 600 } },
    });
  });

  it("are fetched again once invalidated, and a refresh under way is awaited", async () => {
    queryClient.setQueryData(samplerKey, sampler(500));
    await queryClient.invalidateQueries({ queryKey: samplerKey });
    const fetched = vi.fn(async () => Response.json({ preset: sampler(600) }));
    vi.stubGlobal("fetch", fetched);
    expect(await chatSubject(selectionOf({ samplerPresetId: SAMPLER }))).toMatchObject({
      ok: true,
      subject: { runtime: { reserve: 600 } },
    });
    expect(fetched).toHaveBeenCalledTimes(1);

    // A sheet's refetch, not an invalidation: the action waits for it, not the data before it.
    const held = heldFetch();
    const refreshing = queryClient.refetchQueries({ queryKey: samplerKey });
    const loading = chatSubject(selectionOf({ samplerPresetId: SAMPLER }));
    await held.answer(Response.json({ preset: sampler(800) }));
    await refreshing;
    expect(await loading).toMatchObject({ ok: true, subject: { runtime: { reserve: 800 } } });
    expect(held.asked).toHaveBeenCalledTimes(1);
  });

  it("are out of date when a setting the subject reads changed while they loaded", async () => {
    const held = heldFetch();
    const loading = chatSubject(selectionOf({ samplerPresetId: SAMPLER }));
    settle({ preferCharacterPrompt: false });
    await held.answer(Response.json({ preset: sampler(500) }));
    expect(await loading).toEqual({ ok: false, reason: "changed" });
  });
});

describe("the chosen character's memory", () => {
  const CHARACTER = "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b";
  const E1 = "6b2f3c4d-5e6f-4a71-8b2c-3d4e5f6a7b8c";
  const E2 = "7c3a4d5e-6f7a-4b82-9c3d-4e5f6a7b8c9d";

  const stored = (ids: string[]): CharacterMemory => ({
    state: {
      enabled: true,
      notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
      opening: "",
      revision: 1,
      updatedAt: 0,
    },
    episodes: ids.map((id, seq) => ({
      id,
      characterId: CHARACTER,
      seq,
      kind: "episode" as const,
      title: `Memory ${seq}`,
      summary: "What happened.",
      cues: [],
      pinned: false,
      turns: 2,
      chapterId: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    })),
  });

  /**
   * The server as a preview and the memory load meet it: each preview's body
   * is kept, and the character's memory answers as `memory` says.
   */
  function server(memory: () => Promise<Response>) {
    const previews: { memoryState?: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/chat/preview")) {
        previews.push(await new Request(new URL(url, "http://ephemera.test"), init).json());
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (url.endsWith(`/memory/characters/${CHARACTER}`)) return memory();
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    // A preview fills its macros as on a desktop (the test runs without a window).
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    // The character itself is loaded: only its memory waits.
    const character: StoredCharacter = {
      id: CHARACTER,
      card: blankCard("Mira"),
      portrait: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    queryClient.setQueryData(characterQuery(CHARACTER).queryKey, character);
    return previews;
  }

  const OFF: CharacterMemory = {
    state: {
      enabled: false,
      notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
      opening: "",
      revision: 1,
      updatedAt: 0,
    },
    episodes: [],
  };

  it("publishes a remember notebook through the real query cache without interrupting a streaming reply", async () => {
    chatStore.getState().clear();
    const memory = stored([]);
    if (memory.state === null) throw new Error("Expected notebook state");
    const notebookState = memory.state;
    server(async () => Response.json(memory));
    queryClient.setQueryData(MEMORY_KEY(CHARACTER), memory);
    settle({ model: "model-a", characterId: CHARACTER });
    const finish = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const stream = vi
      .spyOn(transport, "streamReply")
      .mockImplementation(async function* (_request, current) {
        signal = current;
        yield { text: "The reply begins" };
        await finish.promise;
        yield { text: "The reply finishes" };
      });
    try {
      chatStore.getState().setDraft("Hello");
      const sending = chatStore.getState().send();
      await vi.waitFor(() => expect(signal).toBeDefined());
      expect(chatStore.getState().generating).toBe(true);
      const state = {
        ...notebookState,
        revision: 2,
        notebook: {
          ...notebookState.notebook,
          cast: [JSON.stringify({ name: "Ilse Brandt", gender: "female" })],
        },
      };
      // This is the same session callback used when remember returns its notebook row.
      memoryChanged(CHARACTER, state);
      expect(queryClient.getQueryData<CharacterMemory>(MEMORY_KEY(CHARACTER))?.state).toEqual(
        state,
      );
      expect(currentRegister(chatStore.getState()).entries[0]?.anchor.name).toBe("Ilse Brandt");
      expect(signal?.aborted).toBe(false);
      expect(chatStore.getState().generating).toBe(true);
      finish.resolve();
      await sending;
      const message = chatStore.getState().messages.at(-1);
      expect(
        message?.role === "assistant" ? message.replies[message.shown] : undefined,
      ).toMatchObject({ text: "The reply finishes", status: "complete" });
      expect(signal?.aborted).toBe(false);
      // A real fetch success is delivered to the session before fetchQuery resolves.
      const loaded = { ...memory, state: { ...state, revision: 3 } };
      vi.stubGlobal("fetch", async () => Response.json(loaded));
      await queryClient.fetchQuery({ ...memoryQuery(CHARACTER), staleTime: 0 });
      expect(chatStore.getState().cast.memory?.revision).toBe(3);
    } finally {
      finish.resolve();
      stream.mockRestore();
      chatStore.getState().clear();
    }
  });

  it("carries memory for a character without a notebook row once its memory loaded", async () => {
    const previews = server(async () => Response.json({ state: null, episodes: [] }));
    settle({ model: "model-a", characterId: CHARACTER });
    await vi.waitFor(() => expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toBeDefined());
    await chatStore.getState().requestPreview();
    expect(previews.at(-1)?.memoryState).toEqual({
      recap: [],
      folded: 0,
      foldedUsers: 0,
      held: [],
      continued: false,
    });
  });

  it("carries no memory while an opted-out character's memory loads, nor once it says off", async () => {
    const held = Promise.withResolvers<Response>();
    const previews = server(() => held.promise);
    settle({ model: "model-a", characterId: CHARACTER });
    await chatStore.getState().requestPreview();
    expect(previews).toHaveLength(1);
    expect(previews[0]).not.toHaveProperty("memoryState");

    held.resolve(Response.json(OFF));
    await vi.waitFor(() => expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(OFF));
    await chatStore.getState().requestPreview();
    expect(previews[1]).not.toHaveProperty("memoryState");
  });

  it("carries no memory when the character's memory failed to load", async () => {
    const previews = server(async () => Response.json({ error: "unavailable" }, { status: 500 }));
    settle({ model: "model-a", characterId: CHARACTER });
    // The load is retried twice before it fails.
    await vi.waitFor(
      () => expect(queryClient.getQueryState(MEMORY_KEY(CHARACTER))?.status).toBe("error"),
      { timeout: 5_000 },
    );
    // The settings change scheduled a preview of its own meanwhile; this one is the last.
    const before = previews.length;
    await chatStore.getState().requestPreview();
    expect(previews).toHaveLength(before + 1);
    expect(previews.at(-1)).not.toHaveProperty("memoryState");
  });

  it("reads a character deleted in another tab as off: the folded chat unfolds and carries no memory", async () => {
    let gone = false;
    const previews = server(async () =>
      gone ? Response.json({ error: "not_found" }, { status: 404 }) : Response.json(stored([E1])),
    );
    settle({ model: "model-a", characterId: CHARACTER });
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(stored([E1])),
    );
    chatStore.setState({
      memory: {
        ...NO_MEMORY,
        horizon: 4,
        recap: [E1],
        foldedLatest: { id: E1, title: "Memory 0", from: 0 },
      },
    });

    gone = true;
    await expect(
      queryClient.fetchQuery({ ...memoryQuery(CHARACTER), staleTime: 0 }),
    ).rejects.toThrow("not_found");
    // The failed refetch keeps the memory it had loaded; the chat still reads it as gone.
    expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(stored([E1]));
    expect(chatStore.getState().memory).toEqual(NO_MEMORY);
    await chatStore.getState().requestPreview();
    expect(previews.at(-1)).not.toHaveProperty("memoryState");
  });

  it("takes the notebook row a landed memory left only over an older one", async () => {
    vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}));
    const key = MEMORY_KEY(CHARACTER);
    const at = (revision: number, opening: string): CharacterMemory => {
      const memory = stored([E1]);
      return memory.state === null
        ? memory
        : { ...memory, state: { ...memory.state, revision, opening } };
    };
    queryClient.setQueryData(key, at(1, ""));
    const landed = at(2, "> Location: The quay\n\nMira waits.");
    memoryChanged(CHARACTER, landed.state ?? undefined);
    expect(queryClient.getQueryData(key)).toEqual(landed);
    // The owner edited the opening since (revision 3): the same answer replayed, or a late
    // one, leaves the edit.
    queryClient.setQueryData(key, at(3, "Edited."));
    memoryChanged(CHARACTER, landed.state ?? undefined);
    expect(queryClient.getQueryData(key)).toEqual(at(3, "Edited."));
    // A character without a notebook row takes it.
    queryClient.setQueryData(key, { state: null, episodes: [] });
    memoryChanged(CHARACTER, landed.state ?? undefined);
    expect(queryClient.getQueryData(key)).toEqual({ state: landed.state, episodes: [] });
  });

  it("drops episodes deleted elsewhere once the server says so, unfolding the latest", async () => {
    vi.stubGlobal("fetch", async () => Response.json(stored([E1, E2])));
    settle({ characterId: CHARACTER });
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(stored([E1, E2])),
    );
    chatStore.setState({
      memory: {
        ...NO_MEMORY,
        recap: [E1, E2],
        foldedLatest: { id: E2, title: "Memory 1", from: 0 },
      },
    });

    // A value set by hand is not the server's answer: nothing moves.
    queryClient.setQueryData(MEMORY_KEY(CHARACTER), stored([]));
    expect(chatStore.getState().memory.recap).toEqual([E1, E2]);

    vi.stubGlobal("fetch", async () => Response.json(stored([E1])));
    await queryClient.fetchQuery({ ...memoryQuery(CHARACTER), staleTime: 0 });
    expect(chatStore.getState().memory).toMatchObject({ recap: [E1], foldedLatest: null });
  });

  it("frees the turns of a held memory deleted elsewhere once the server says so", async () => {
    vi.stubGlobal("fetch", async () => Response.json(stored([E1, E2])));
    settle({ characterId: CHARACTER });
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(stored([E1, E2])),
    );
    chatStore.setState({
      memory: {
        ...NO_MEMORY,
        recap: [E1],
        held: [{ id: E2, title: "Memory 1", from: 0, to: 4 }],
      },
    });

    vi.stubGlobal("fetch", async () => Response.json(stored([E1])));
    await queryClient.fetchQuery({ ...memoryQuery(CHARACTER), staleTime: 0 });
    expect(chatStore.getState().memory).toMatchObject({ horizon: 0, recap: [E1], held: [] });
  });

  it("reads the chosen memory's episodes on its own changes only, not on every other query's", async () => {
    vi.stubGlobal("fetch", async () => Response.json(stored([E1])));
    settle({ characterId: CHARACTER });
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(stored([E1])),
    );
    /** A memory that counts how often its episodes are read (a class, so the cache keeps it as it is). */
    class Counted {
      reads = 0;
      readonly memory: CharacterMemory;
      constructor(memory: CharacterMemory) {
        this.memory = memory;
      }
      get state() {
        return this.memory.state;
      }
      get episodes() {
        this.reads++;
        return this.memory.episodes;
      }
    }
    const counted = new Counted(stored([E1, E2]));
    queryClient.setQueryData<CharacterMemory>(MEMORY_KEY(CHARACTER), counted);
    const read = counted.reads;
    expect(read).toBeGreaterThan(0);
    // Other queries change: the chosen memory is not read again.
    for (let at = 0; at < 5; at++) queryClient.setQueryData(["elsewhere", at], at);
    expect(counted.reads).toBe(read);
  });

  it("unfolds the chat whole once none of its episodes is left, as after Forget everything in another tab", async () => {
    vi.stubGlobal("fetch", async () => Response.json(stored([E1, E2])));
    settle({ characterId: CHARACTER });
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(stored([E1, E2])),
    );
    // Two memories folded the chat: the latest from where the older one ended.
    chatStore.setState({
      memory: {
        ...NO_MEMORY,
        horizon: 8,
        recap: [E1, E2],
        foldedLatest: { id: E2, title: "Memory 1", from: 4 },
      },
    });

    vi.stubGlobal("fetch", async () => Response.json(stored([])));
    await queryClient.fetchQuery({ ...memoryQuery(CHARACTER), staleTime: 0 });
    expect(chatStore.getState().memory).toEqual(NO_MEMORY);
  });
});

describe("a cast sheet that waits for a context window", () => {
  it("is asked for once the save that gave the window is done, not when the tab applies it", async () => {
    queryClient.setQueryData(modelsQuery.queryKey, [
      { id: "model-n", contextWindow: null, outputLimit: null, reasoning: null, images: null },
    ]);
    settle({ model: "model-n" });
    await Promise.resolve();
    const ready = vi.fn();
    const original = chatStore.getState().castModelReady;
    chatStore.setState({ castModelReady: ready });
    try {
      let release = () => {};
      const stored = new Promise<void>((resolve) => {
        release = resolve;
      });
      // As useUpdateSettings does: applied in this tab first, its save queued in the same task.
      settle({ model: "model-n", contextWindows: { "model-n": 8_192 } });
      const save = queryClient
        .getMutationCache()
        .build(queryClient, { mutationKey: SETTINGS_MUTATION_KEY, mutationFn: () => stored });
      const saving = save.execute(undefined);
      await Promise.resolve();
      await Promise.resolve();
      // The server reads the window from what it stored: nothing is asked while the save runs.
      expect(ready).not.toHaveBeenCalled();
      release();
      await saving;
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    } finally {
      chatStore.setState({ castModelReady: original });
    }
  });
});
