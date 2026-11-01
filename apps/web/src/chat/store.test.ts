import {
  type ArtStreamEvent,
  blankCard,
  type CallAccounting,
  type CreatorArtStatus,
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  type EventsState,
  emptyCastAnchor,
  emptyCastState,
  fillChatText,
  type GenerateRequest,
  type InspectedPrompt,
  type LorebookState,
  type MacroState,
  MEMORY_GREETING,
  MEMORY_LIMITS,
  type MemoryState,
  type PreviewRequest,
  type RememberRequest,
  type RememberResponse,
  rollEvents,
  type SceneRequest,
} from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RememberOutcome } from "../memory/queries.ts";
import { SignedOut } from "../signin/signin.ts";
import { tick } from "../testing.ts";
import type { SceneSubject } from "./scene-slice.ts";
import {
  type ChatMessage,
  type ChatState,
  contentChangedSince,
  createChatStore,
  editHolds,
  endingToRemember,
  type GreetingChoice,
  hasChatContent,
  lockedBefore,
  type MacroSubject,
  NO_MEMORY,
  nextPrompt,
  PREVIEW_DEBOUNCE_MS,
  promptFoldedTurns,
  rememberableTurns,
  type Selection,
  type StreamReply,
  type SubjectResult,
  shownReply,
  spanToRemember,
} from "./store.ts";
import type { PreviewResult, ReplyUpdate } from "./transport.ts";

const CLOCK = { now: Date.UTC(2026, 8, 29, 19, 42), timeZone: "Europe/Berlin" };

function inspected(content: string): InspectedPrompt {
  return {
    model: "model-a",
    mode: "reply",
    processing: "none",
    messages: [{ role: "user", content, tokens: 5, source: { kind: "history", index: 0 } }],
    settings: {},
    reasoningNotOffered: null,
    window: { tokens: 1_000, source: "catalog", model: 1_000, limit: null },
    reserve: 100,
    estimate: 5,
    history: { sent: 1, total: 1 },
    examples: { sent: 0, total: 0 },
    trimming: "exact",
    lorebook: null,
    lorebookState: null,
  };
}

/** Reply streams the test drives by hand; `push`/`finish` target the latest call. */
function controlledReply() {
  const calls: {
    request: GenerateRequest;
    signal: AbortSignal;
    push: (update: string | ReplyUpdate) => void;
    finish: (error?: Error) => void;
  }[] = [];

  const streamReply: StreamReply = (request, signal) => {
    const queue: ReplyUpdate[] = [];
    let done: { error?: Error } | undefined;
    let wake: () => void = () => {};
    calls.push({
      request,
      signal,
      push: (update) => {
        queue.push(typeof update === "string" ? { text: update } : update);
        wake();
      },
      finish: (error) => {
        done = error ? { error } : {};
        wake();
      },
    });
    return (async function* () {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (done) {
          if (done.error) throw done.error;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })();
  };
  return {
    streamReply,
    calls,
    push: (update: string | ReplyUpdate) => calls.at(-1)?.push(update),
    finish: (error?: Error) => calls.at(-1)?.finish(error),
  };
}

/** The saved selection the store reads when it sends; tests change it in place. */
function selectionOf(change: Partial<Selection> = {}): Selection {
  return {
    model: "model-a",
    samplerPresetId: null,
    promptPresetId: null,
    characterId: null,
    personaId: null,
    reasoning: null,
    ...change,
  };
}

/** Previews the test answers by hand. */
function controlledPreview() {
  const calls: {
    request: PreviewRequest;
    signal: AbortSignal;
    answer: (r: PreviewResult) => void;
  }[] = [];
  const fetchPreview = (request: PreviewRequest, signal: AbortSignal) =>
    new Promise<PreviewResult>((resolve) => calls.push({ request, signal, answer: resolve }));
  return { fetchPreview, calls };
}

let now = 0;

/** Each message as the thread shows it: the user's text, or the shown alternate. */
const view = (state: ChatState) =>
  state.messages.map((message: ChatMessage) =>
    message.role === "user"
      ? { role: "user", text: message.text, status: "complete" }
      : { role: "assistant", text: shownReply(message).text, status: shownReply(message).status },
  );
const last = (state: ChatState) => view(state).at(-1);

/** The first pick seed a ready store makes; each Clear makes the next. */
const SEED = 101;

/** The n-th cache affinity id a ready store makes: its first chat's is 0, each Clear's the next. */
const cacheKeyOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** What a chat's first send tells the macros: no state yet, the thread's first turn, an empty composer. */
const FIRST_SEND = {
  macroState: { local: {}, global: {} },
  generationType: "normal",
  macroRuntime: {
    firstDisplayedMessageId: 0,
    isMobile: false,
    idleDuration: "just now",
    input: "",
  },
} as const;

function readyStore(selection = selectionOf(), session = { signedIn: true }) {
  const reply = controlledReply();
  const preview = controlledPreview();
  let seed = SEED;
  let keys = 0;
  const store = createChatStore(reply.streamReply, () => selection, {
    clock: () => CLOCK,
    pickSeed: () => seed++,
    cacheKey: () => cacheKeyOf(keys++),
    now: () => now,
    fetchPreview: preview.fetchPreview,
    signedIn: () => session.signedIn,
  });
  store.getState().setDraft("hello");
  return { store, reply, selection, preview, session };
}

describe("chat store", () => {
  it("drops a preview in flight when a generation starts, and previews nothing while it streams", async () => {
    const { store, reply, preview } = readyStore();
    void store.getState().requestPreview();
    expect(preview.calls).toHaveLength(1);
    const sending = store.getState().send();
    expect(preview.calls[0]?.signal.aborted).toBe(true);
    await store.getState().requestPreview();
    expect(preview.calls).toHaveLength(1);
    reply.finish();
    await sending;
  });

  it("streams a reply into the assistant message and completes it", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    expect(store.getState().draft).toBe("");
    reply.push("Hi");
    reply.push("Hi there");
    await tick();
    expect(last(store.getState())).toMatchObject({ text: "Hi there", status: "streaming" });
    reply.finish();
    await sending;
    expect(view(store.getState())).toEqual([
      { role: "user", text: "hello", status: "complete" },
      { role: "assistant", text: "Hi there", status: "complete" },
    ]);
    expect(store.getState().generating).toBe(false);
    expect(reply.calls[0]?.request).toEqual({
      model: "model-a",
      clock: CLOCK,
      pickSeed: SEED,
      ...FIRST_SEND,
      cacheKey: cacheKeyOf(0),
      mode: "reply",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("does not send without a model, with a blank draft, or while generating", async () => {
    const { store, reply, selection } = readyStore(selectionOf({ model: null }));
    await store.getState().send();
    selection.model = "m";
    store.getState().setDraft("   ");
    await store.getState().send();
    expect(reply.calls).toHaveLength(0);

    store.getState().setDraft("one");
    void store.getState().send();
    store.getState().setDraft("two");
    await store.getState().send();
    expect(reply.calls).toHaveLength(1);
  });

  it("Clear advances the epoch, aborts the generation and drops late chunks", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push("partial");
    await tick();

    store.getState().setDraft("unsent draft");
    store.getState().clear();
    expect(reply.calls[0]?.signal.aborted).toBe(true);
    expect(store.getState()).toMatchObject({
      epoch: 1,
      messages: [],
      draft: "",
      generating: false,
    });

    // A late chunk and a late failure from the old epoch change nothing.
    reply.push("late text");
    reply.finish(new Error("aborted"));
    await sending;
    expect(store.getState().messages).toEqual([]);
  });

  it("a new generation after Clear is not disturbed by the old one finishing", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    const firstFinish = reply.calls[0]?.finish ?? (() => {});
    store.getState().clear();

    store.getState().setDraft("again");
    const second = store.getState().send();
    expect(store.getState().generating).toBe(true);
    firstFinish(new Error("aborted"));
    await first;
    expect(store.getState().generating).toBe(true);
    expect(store.getState().messages).toHaveLength(2);
    reply.finish();
    await second;
  });

  it("Stop aborts and keeps the partial reply", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push("half a");
    await tick();
    store.getState().stop();
    expect(reply.calls[0]?.signal.aborted).toBe(true);
    reply.finish(new DOMException("aborted", "AbortError"));
    await sending;
    expect(last(store.getState())).toMatchObject({ text: "half a", status: "stopped" });
  });

  it("Stop wins when the aborted stream ends without an error", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push("half");
    await tick();
    store.getState().stop();
    reply.finish();
    await sending;
    expect(last(store.getState())).toMatchObject({ text: "half", status: "stopped" });
  });

  it("marks a failed reply and leaves it out of the next request", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    reply.finish(new Error("upstream"));
    await first;
    expect(last(store.getState())?.status).toBe("failed");

    store.getState().setDraft("retry");
    const second = store.getState().send();
    expect(reply.calls[1]?.request.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "retry" },
    ]);
    reply.finish();
    await second;
  });

  it("sends the chosen presets, character and persona with the model and the clock", async () => {
    const { store, reply } = readyStore(
      selectionOf({
        samplerPresetId: "preset-b",
        promptPresetId: "prompt-c",
        characterId: "mara",
        personaId: "aria",
      }),
    );
    const sending = store.getState().send();
    expect(reply.calls[0]?.request).toEqual({
      model: "model-a",
      samplerPresetId: "preset-b",
      promptPresetId: "prompt-c",
      characterId: "mara",
      personaId: "aria",
      clock: CLOCK,
      pickSeed: SEED,
      ...FIRST_SEND,
      cacheKey: cacheKeyOf(0),
      mode: "reply",
      messages: [{ role: "user", content: "hello" }],
    });
    reply.finish();
    await sending;
  });

  it("sends the chat's pick seed with every request and preview, and a new one after Clear", async () => {
    const { store, reply, preview } = readyStore();
    const first = store.getState().send();
    reply.finish();
    await first;
    void store.getState().requestPreview();
    expect(reply.calls[0]?.request.pickSeed).toBe(SEED);
    expect(preview.calls[0]?.request.pickSeed).toBe(SEED);

    store.getState().clear();
    expect(store.getState().pickSeed).toBe(SEED + 1);
    store.getState().setDraft("again");
    const second = store.getState().send();
    reply.finish();
    await second;
    void store.getState().requestPreview();
    expect(reply.calls[1]?.request.pickSeed).toBe(SEED + 1);
    expect(preview.calls.at(-1)?.request.pickSeed).toBe(SEED + 1);
  });

  it("sends one cache affinity id with every generation of a chat, and none with a preview", async () => {
    const { store, reply, preview } = readyStore();
    const first = store.getState().send();
    reply.finish();
    await first;
    const again = store.getState().regenerate();
    reply.finish();
    await again;
    store.getState().setDraft("more");
    const second = store.getState().send();
    reply.finish();
    await second;
    void store.getState().requestPreview();
    expect(reply.calls.map((call) => call.request.cacheKey)).toEqual([
      cacheKeyOf(0),
      cacheKeyOf(0),
      cacheKeyOf(0),
    ]);
    expect(preview.calls.length).toBeGreaterThan(0);
    for (const call of preview.calls) expect(call.request).not.toHaveProperty("cacheKey");
  });

  it("gives the chat a new cache affinity id on Clear", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    reply.finish();
    await first;
    store.getState().clear();
    store.getState().setDraft("again");
    const second = store.getState().send();
    reply.finish();
    await second;
    expect(reply.calls.map((call) => call.request.cacheKey)).toEqual([
      cacheKeyOf(0),
      cacheKeyOf(1),
    ]);
  });

  it("makes a random UUID cache affinity id by default", () => {
    const keys = Array.from({ length: 4 }, () => {
      const store = createChatStore(controlledReply().streamReply, () => selectionOf(), {
        clock: () => CLOCK,
        fetchPreview: controlledPreview().fetchPreview,
      });
      return store.getState().cacheKey;
    });
    for (const key of keys) expect(z.uuid().safeParse(key).success).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("makes a random uint32 pick seed by default", () => {
    const seeds = Array.from({ length: 4 }, () => {
      const store = createChatStore(controlledReply().streamReply, () => selectionOf(), {
        clock: () => CLOCK,
        fetchPreview: controlledPreview().fetchPreview,
      });
      return store.getState().pickSeed;
    });
    for (const seed of seeds) {
      expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("each user turn keeps the persona it was sent as", async () => {
    const { store, reply, selection } = readyStore(selectionOf({ personaId: "aria" }));
    const first = store.getState().send();
    reply.finish();
    await first;
    selection.personaId = null;
    store.getState().setDraft("as myself");
    const second = store.getState().send();
    reply.finish();
    await second;
    expect(
      store
        .getState()
        .messages.flatMap((message) => (message.role === "user" ? [message.personaId] : [])),
    ).toEqual(["aria", null]);
  });

  it("keeps the exact prompt sent, with the time and the model's count, for the inspector", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "", prompt: inspected("hello") });
    await tick();
    expect(store.getState().lastSent).toMatchObject({
      inputTokens: null,
      cachedTokens: null,
      outputTokens: null,
      reasoningTokens: null,
    });
    reply.push({
      text: "Hi",
      prompt: inspected("hello"),
      inputTokens: 7,
      cachedTokens: 4,
      outputTokens: 3,
      reasoningTokens: 1,
    });
    reply.finish();
    await sending;
    expect(store.getState().lastSent).toMatchObject({
      prompt: inspected("hello"),
      inputTokens: 7,
      cachedTokens: 4,
      outputTokens: 3,
      reasoningTokens: 1,
      speakers: [null],
    });
    expect(store.getState().lastSent?.sentAt).toBeTypeOf("number");
  });

  it("Clear and a late prompt: the inspector never refills after Clear", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "", prompt: inspected("first") });
    await tick();
    store.getState().clear();
    expect(store.getState().lastSent).toBeNull();
    reply.push({ text: "late", prompt: inspected("late"), inputTokens: 9, cachedTokens: 9 });
    reply.finish();
    await sending;
    expect(store.getState().lastSent).toBeNull();
  });

  it("previews the chat with the draft as its last turn", async () => {
    const { store, preview } = readyStore();
    store.getState().setDraft("  a draft  ");
    const previewing = store.getState().requestPreview();
    expect(store.getState().preview.status).toBe("loading");
    expect(preview.calls[0]?.request).toEqual({
      model: "model-a",
      clock: CLOCK,
      pickSeed: SEED,
      macroState: { local: {}, global: {} },
      generationType: "normal",
      macroRuntime: { isMobile: false, idleDuration: "just now", input: "  a draft  " },
      messages: [{ role: "user", content: "  a draft  " }],
    });
    preview.calls[0]?.answer({ ok: true, prompt: inspected("a draft") });
    await previewing;
    expect(store.getState().preview).toEqual({
      status: "ready",
      prompt: inspected("a draft"),
      draftIndex: 0,
    });
  });

  it("previews without a draft, and reports a refusal", async () => {
    const { store, preview } = readyStore();
    store.getState().setDraft("");
    const previewing = store.getState().requestPreview();
    expect(preview.calls[0]?.request.messages).toEqual([]);
    preview.calls[0]?.answer({ ok: false, error: "context_window_unknown" });
    await previewing;
    expect(store.getState().preview).toEqual({
      status: "context_window_unknown",
      prompt: null,
      draftIndex: null,
    });
  });

  it("a newer preview replaces an older one; Clear aborts and drops it", async () => {
    const { store, preview } = readyStore();
    const first = store.getState().requestPreview();
    const second = store.getState().requestPreview();
    expect(preview.calls[0]?.signal.aborted).toBe(true);
    preview.calls[0]?.answer({ ok: true, prompt: inspected("stale") });
    await first;
    expect(store.getState().preview.status).toBe("loading");

    store.getState().clear();
    expect(preview.calls[1]?.signal.aborted).toBe(true);
    preview.calls[1]?.answer({ ok: true, prompt: inspected("late") });
    await second;
    expect(store.getState().preview).toEqual({ status: "idle", prompt: null, draftIndex: null });
  });

  it("marks a refused reply with why", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    const error = Object.assign(new Error("refused"), {
      reason: "refused",
      code: "prompt_too_long",
    });
    reply.finish(error);
    await sending;
    const message = store.getState().messages.at(-1);
    expect(message?.role === "assistant" && shownReply(message)).toMatchObject({
      status: "failed",
      refusal: "prompt_too_long",
    });
  });
});

/** A reply sent and finished with `text`, the draft already set. */
async function replied(
  store: ReturnType<typeof readyStore>["store"],
  reply: ReturnType<typeof controlledReply>,
  text: string,
) {
  const sending = store.getState().send();
  reply.push(text);
  reply.finish();
  await sending;
}

const assistant = (state: ChatState) => {
  const message = state.messages.at(-1);
  if (message?.role !== "assistant") throw new Error("no reply");
  return message;
};

describe("how the latest generation ended", () => {
  it("is complete, failed or stopped by the generation, whatever reply is shown; Clear forgets it", async () => {
    const { store, reply } = readyStore();
    expect(store.getState().generationEnd).toBeNull();
    await replied(store, reply, "First");
    expect(store.getState().generationEnd).toBe("complete");

    // A failed Continue puts the completed reply back; the generation still failed.
    const continuing = store.getState().continueReply();
    reply.push("lost");
    reply.finish(new Error("upstream"));
    await continuing;
    expect(shownReply(assistant(store.getState())).status).toBe("complete");
    expect(store.getState().generationEnd).toBe("failed");

    // Write for me leaves the messages alone: a completed reply stays the last one.
    const writing = store.getState().impersonate();
    reply.push("I wa");
    await tick();
    store.getState().stop();
    reply.finish(new DOMException("aborted", "AbortError"));
    await writing;
    expect(store.getState().generationEnd).toBe("stopped");

    store.getState().clear();
    expect(store.getState().generationEnd).toBeNull();
  });
});

describe("greetings", () => {
  it("open an empty chat, step and pick without requests, and stop at the last", () => {
    const { store, reply } = readyStore();
    store.getState().setDraft("");
    store.getState().setGreetings(["One.", "Two.", "Three."]);
    expect(view(store.getState())).toEqual([
      { role: "assistant", text: "One.", status: "complete" },
    ]);
    expect(hasChatContent(store.getState())).toBe(false);
    // An open edit of the greeting is the user's, saved or not.
    store.getState().startEdit(assistant(store.getState()).id);
    const untouched = store.getState();
    store.getState().setEditText("A scene of my own.");
    expect(hasChatContent(store.getState())).toBe(true);
    // A choice waiting on the persona list gives way to the edit.
    expect(contentChangedSince(untouched, store.getState())).toBe(true);
    const editing = store.getState();
    store.getState().cancelEdit();
    expect(hasChatContent(store.getState())).toBe(false);
    // An edit that closes adds nothing of the owner's: a confirmed switch still goes through.
    expect(contentChangedSince(editing, store.getState())).toBe(false);
    store.getState().swipe(1);
    store.getState().swipe(1);
    store.getState().swipe(1);
    expect(last(store.getState())?.text).toBe("Three.");
    store.getState().pickGreeting(0);
    store.getState().swipe(-1);
    expect(last(store.getState())?.text).toBe("One.");
    expect(reply.calls).toHaveLength(0);
  });

  it("refill an untouched greeting (a persona change) and keep the one shown", () => {
    const { store } = readyStore();
    store.getState().setGreetings(["Hi, Ash.", "Bye, Ash."]);
    store.getState().swipe(1);
    store.getState().setGreetings(["Hi, Wren.", "Bye, Wren."]);
    expect(last(store.getState())?.text).toBe("Bye, Wren.");
    const id = assistant(store.getState()).id;
    store.getState().edit(id, "Bye, you.");
    store.getState().setGreetings(["Hi, Kai.", "Bye, Kai."]);
    expect(last(store.getState())?.text).toBe("Bye, you.");
    expect(hasChatContent(store.getState())).toBe(true);
  });

  it("keep the one shown across a refill by which greeting it is, not by its place", () => {
    const { store } = readyStore();
    const OPENING: GreetingChoice = { content: "> Location: The pier", key: MEMORY_GREETING };
    const card: GreetingChoice[] = [
      { content: "Hello.", key: "card:0" },
      { content: "Again.", key: "card:1" },
    ];
    const ids = () => assistant(store.getState()).replies.map((reply) => reply.id);
    store.getState().setGreetingChoices(() => card);
    store.getState().swipe(1);
    const [, again] = ids();
    // The opening arrives: the card's second greeting stays shown, with its id.
    store.getState().setGreetingChoices(() => [OPENING, ...card]);
    expect(last(store.getState())?.text).toBe("Again.");
    expect(ids()[2]).toBe(again);
    // It goes again (the setting turned off): still the same greeting.
    store.getState().setGreetingChoices(() => card);
    expect(last(store.getState())?.text).toBe("Again.");
    expect(ids()[1]).toBe(again);

    // A chat opening on the opening shows the card's first once the opening goes.
    store.getState().clear();
    store.getState().setGreetingChoices(() => [OPENING, ...card]);
    expect(last(store.getState())?.text).toBe("> Location: The pier");
    store
      .getState()
      .setGreetingChoices(() => [{ ...OPENING, content: "> Location: The quay" }, ...card]);
    expect(last(store.getState())?.text).toBe("> Location: The quay");
    store.getState().setGreetingChoices(() => card);
    expect(last(store.getState())?.text).toBe("Hello.");
  });

  it("go when the chat moves to a character without greetings", () => {
    const { store } = readyStore();
    store.getState().setGreetings(["One."]);
    store.getState().setGreetings([]);
    expect(store.getState().messages).toEqual([]);
  });

  it("are an ordinary turn once the user replies, and come back after Clear", async () => {
    const { store, reply } = readyStore();
    store.getState().setGreetings(["One.", "Two."]);
    store.getState().swipe(1);
    const sending = store.getState().send();
    expect(reply.calls[0]?.request.messages).toEqual([
      { role: "assistant", content: "Two." },
      { role: "user", content: "hello" },
    ]);
    reply.finish();
    await sending;
    store.getState().setGreetings(["One.", "Two."]);
    expect(store.getState().messages).toHaveLength(3);
    store.getState().clear();
    store.getState().setGreetings(["One.", "Two."]);
    expect(view(store.getState())).toEqual([
      { role: "assistant", text: "One.", status: "complete" },
    ]);
  });
});

describe("alternate replies", () => {
  it("swiping past the last generates one from the history before it; stepping sends nothing", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const swiping = store.getState().swipe(1);
    expect(reply.calls[1]?.request).toMatchObject({
      mode: "reply",
      messages: [{ role: "user", content: "hello" }],
    });
    reply.push("B");
    reply.finish();
    await swiping;
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["A", "B"]);
    store.getState().swipe(-1);
    expect(last(store.getState())?.text).toBe("A");
    store.getState().swipe(1);
    expect(last(store.getState())?.text).toBe("B");
    expect(reply.calls).toHaveLength(2);
  });

  it("Regenerate replaces only the shown alternate", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const swiping = store.getState().swipe(1);
    reply.push("B");
    reply.finish();
    await swiping;
    store.getState().swipe(-1);
    const regenerating = store.getState().regenerate();
    reply.push("C");
    reply.finish();
    await regenerating;
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["C", "B"]);
    expect(assistant(store.getState()).shown).toBe(0);
  });

  it("sends the shown alternate as the turn", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const swiping = store.getState().swipe(1);
    reply.push("B");
    reply.finish();
    await swiping;
    store.getState().setDraft("next");
    const sending = store.getState().send();
    expect(reply.calls[2]?.request.messages.at(-2)).toEqual({
      role: "assistant",
      content: "B",
      macroEligible: true,
    });
    reply.finish();
    await sending;
  });

  it("generates nothing while a generation runs or with no user turn before the reply", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    await store.getState().swipe(1);
    await store.getState().regenerate();
    await store.getState().continueReply();
    expect(reply.calls).toHaveLength(1);
    reply.push("A");
    reply.finish();
    await sending;
    const user = store.getState().messages[0];
    if (user) store.getState().remove(user.id);
    await store.getState().swipe(1);
    await store.getState().regenerate();
    expect(reply.calls).toHaveLength(1);
  });

  it("drops a late alternate after Clear", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const swiping = store.getState().swipe(1);
    store.getState().clear();
    reply.push("late");
    reply.finish();
    await swiping;
    expect(store.getState().messages).toEqual([]);
  });
});

const continuedPrompt = () => ({
  ...inspected("x"),
  mode: "continue" as const,
});

describe("Continue", () => {
  it("keeps partial endings per alternate, restores failed Continue/Replace, and clears edits", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "First", finishReason: "length" });
    reply.finish();
    await sending;
    const first = shownReply(assistant(store.getState()));
    expect(first).toMatchObject({ text: "First", status: "complete", finishReason: "length" });
    expect(reply.calls).toHaveLength(1);

    const swiping = store.getState().swipe(1);
    reply.push({ text: "Second", finishReason: "content-filter" });
    reply.finish();
    await swiping;
    expect(shownReply(assistant(store.getState())).finishReason).toBe("content-filter");
    await store.getState().swipe(-1);
    expect(shownReply(assistant(store.getState())).finishReason).toBe("length");

    const failing = store.getState().continueReply();
    reply.push({ text: "lost", finishReason: "content-filter" });
    reply.finish(new Error("upstream"));
    await failing;
    expect(shownReply(assistant(store.getState()))).toEqual({ ...first, failed: "continue" });

    const replacing = store.getState().regenerate();
    reply.push({ text: "lost again", finishReason: "content-filter" });
    reply.finish(new Error("upstream"));
    await replacing;
    expect(shownReply(assistant(store.getState()))).toEqual({ ...first, failed: "replace" });

    const continuing = store.getState().continueReply();
    reply.push({ text: "more", finishReason: "content-filter" });
    reply.finish();
    await continuing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "First more",
      finishReason: "content-filter",
    });
    const completing = store.getState().continueReply();
    reply.push("done");
    reply.finish();
    await completing;
    expect(shownReply(assistant(store.getState()))).not.toHaveProperty("finishReason");

    await store.getState().swipe(1);
    expect(shownReply(assistant(store.getState())).finishReason).toBe("content-filter");
    store.getState().edit(assistant(store.getState()).id, "Edited");
    expect(shownReply(assistant(store.getState()))).not.toHaveProperty("finishReason");
    const replaced = store.getState().regenerate();
    reply.push({ text: "Partial replacement", finishReason: "length" });
    reply.finish();
    await replaced;
    expect(shownReply(assistant(store.getState())).finishReason).toBe("length");
    const completedReplacement = store.getState().regenerate();
    reply.push("Complete replacement");
    reply.finish();
    await completedReplacement;
    expect(shownReply(assistant(store.getState()))).not.toHaveProperty("finishReason");
  });

  it("replaces the ending even when a successful Continue adds no text", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "Story", finishReason: "length" });
    reply.finish();
    await sending;
    const continuing = store.getState().continueReply();
    reply.push({ text: "", finishReason: "content-filter" });
    reply.finish();
    await continuing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "Story",
      finishReason: "content-filter",
    });
    const completing = store.getState().continueReply();
    reply.finish();
    await completing;
    expect(shownReply(assistant(store.getState()))).not.toHaveProperty("finishReason");
  });
  it("appends to the shown alternate, joined by the native continuation rule", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "She waits");
    const continuing = store.getState().continueReply();
    expect(reply.calls[1]?.request).toMatchObject({
      mode: "continue",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "She waits" },
      ],
    });
    reply.push({ text: "", prompt: continuedPrompt() });
    reply.push({ text: "for the tide.", prompt: continuedPrompt() });
    await tick();
    expect(last(store.getState())).toEqual({
      role: "assistant",
      text: "She waits for the tide.",
      status: "streaming",
    });
    reply.finish();
    await continuing;
    expect(last(store.getState())?.status).toBe("complete");
  });

  it.each([
    ["She waves", "She waits She waves"],
    ["She waits for rain.", "She waits for rain."],
  ])("buffers matching updates before revealing %s", async (continuation, expected) => {
    const { store, reply } = readyStore();
    await replied(store, reply, "She waits");
    const continuing = store.getState().continueReply();
    for (const text of ["S", "She", "She wa"]) {
      reply.push({ text, prompt: continuedPrompt() });
      await tick();
      expect(last(store.getState())).toEqual({
        role: "assistant",
        text: "She waits",
        status: "streaming",
      });
    }
    reply.push({ text: continuation, prompt: continuedPrompt() });
    await tick();
    expect(last(store.getState())?.text).toBe(expected);
    reply.finish();
    await continuing;
    expect(last(store.getState())).toEqual({
      role: "assistant",
      text: expected,
      status: "complete",
    });
  });

  it.each([
    ["She", "She waits She"],
    ["She waits", "She waits"],
  ])("settles completed output %s after hiding matching updates", async (output, expected) => {
    const { store, reply } = readyStore();
    await replied(store, reply, "She waits");
    const observed: ReturnType<typeof last>[] = [];
    const unsubscribe = store.subscribe((state) => observed.push(last(state)));
    const continuing = store.getState().continueReply();
    for (const text of ["S", "She", output]) {
      reply.push({ text, prompt: continuedPrompt() });
      await tick();
      expect(last(store.getState())).toEqual({
        role: "assistant",
        text: "She waits",
        status: "streaming",
      });
    }
    reply.finish();
    await continuing;
    unsubscribe();
    expect(
      observed
        .filter((update) => update?.status === "streaming")
        .every((update) => update?.text === "She waits"),
    ).toBe(true);
    expect(observed.at(-1)).toEqual({ role: "assistant", text: expected, status: "complete" });
  });

  it("adds nothing when stopped during a matching prefix", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "She waits");
    const before = shownReply(assistant(store.getState()));
    const observed: ReturnType<typeof last>[] = [];
    const unsubscribe = store.subscribe((state) => observed.push(last(state)));
    const continuing = store.getState().continueReply();
    reply.push({ text: "She", prompt: continuedPrompt() });
    await tick();
    expect(last(store.getState())?.text).toBe("She waits");
    store.getState().stop();
    expect(reply.calls.at(-1)?.signal.aborted).toBe(true);
    reply.finish();
    await continuing;
    unsubscribe();
    expect(shownReply(assistant(store.getState()))).toEqual({ ...before, status: "stopped" });
    expect(observed.every((update) => update?.text === "She waits")).toBe(true);
    expect(observed.at(-1)?.status).toBe("stopped");
  });

  it("drops a buffered echo and its late suffix after Clear", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "She waits");
    const continuing = store.getState().continueReply();
    reply.push({ text: "She", prompt: continuedPrompt() });
    await tick();
    store.getState().clear();
    reply.push({ text: "She waits for rain.", prompt: continuedPrompt() });
    reply.finish();
    await continuing;
    expect(store.getState()).toMatchObject({ messages: [], generating: false });
  });

  it.each(["for", "She"])("restores the reply when continuation %s fails", async (text) => {
    const { store, reply } = readyStore();
    await replied(store, reply, "She waits");
    const continuing = store.getState().continueReply();
    reply.push({ text, prompt: continuedPrompt() });
    reply.finish(new Error("upstream"));
    await continuing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "She waits",
      status: "complete",
      failed: "continue",
    });
  });
});

describe("Impersonate", () => {
  it("writes the user's next message into the draft, never into the chat", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "Your move.");
    const writing = store.getState().impersonate();
    expect(reply.calls[1]?.request).toMatchObject({
      mode: "impersonate",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Your move." },
      ],
    });
    reply.push("I wave");
    await tick();
    expect(store.getState()).toMatchObject({ draft: "I wave", generationMode: "impersonate" });
    reply.push("I wave back.");
    reply.finish();
    await writing;
    expect(store.getState()).toMatchObject({ draft: "I wave back.", generating: false });
    expect(store.getState().messages).toHaveLength(2);
  });

  it("is not offered with a draft, and keeps a partial draft on Stop", async () => {
    const { store, reply } = readyStore();
    await store.getState().impersonate();
    expect(reply.calls).toHaveLength(0);
    store.getState().setDraft("");
    const writing = store.getState().impersonate();
    reply.push("I hes");
    await tick();
    store.getState().stop();
    reply.finish();
    await writing;
    expect(store.getState().draft).toBe("I hes");
  });

  it("drops a late draft after Clear", async () => {
    const { store, reply } = readyStore();
    store.getState().setDraft("");
    const writing = store.getState().impersonate();
    store.getState().clear();
    reply.push("late words");
    reply.finish();
    await writing;
    expect(store.getState().draft).toBe("");
  });
});

describe("edit and delete", () => {
  it("edits the user's text or the shown alternate only", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const swiping = store.getState().swipe(1);
    reply.push("B");
    reply.finish();
    await swiping;
    const [user, answer] = store.getState().messages;
    store.getState().edit(user?.id ?? "", "hello, edited");
    store.getState().edit(answer?.id ?? "", "B, edited");
    expect(view(store.getState()).map((m) => m.text)).toEqual(["hello, edited", "B, edited"]);
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["A", "B, edited"]);
  });

  it("deletes one message with an Undo that lasts until the next change", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const [user] = store.getState().messages;
    store.getState().remove(user?.id ?? "");
    expect(view(store.getState()).map((m) => m.text)).toEqual(["A"]);
    expect(store.getState().deleted).toMatchObject({ index: 0 });
    store.getState().undoDelete();
    expect(view(store.getState()).map((m) => m.text)).toEqual(["hello", "A"]);
    expect(store.getState().deleted).toBeNull();

    store.getState().remove(user?.id ?? "");
    store.getState().setDraft("typing keeps it");
    expect(store.getState().deleted).not.toBeNull();
    store.getState().edit(store.getState().messages[0]?.id ?? "", "A2");
    expect(store.getState().deleted).toBeNull();
  });

  it("changes nothing while a generation runs", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    const [user] = store.getState().messages;
    store.getState().remove(user?.id ?? "");
    store.getState().edit(user?.id ?? "", "changed");
    expect(view(store.getState())[0]?.text).toBe("hello");
    reply.finish();
    await sending;
  });
});

describe("Author's Note", () => {
  it("is not chat content: a reply and a preview carry no note, the preset brings it", async () => {
    const { store, reply, preview } = readyStore();
    const sending = store.getState().send();
    expect(reply.calls[0]?.request).not.toHaveProperty("authorsNote");
    reply.finish();
    await sending;
    store.getState().setDraft("a draft");
    void store.getState().requestPreview();
    expect(preview.calls.at(-1)?.request).not.toHaveProperty("authorsNote");
  });
});

describe("reasoning", () => {
  it("is kept per alternate with how long it took, and goes with the history for the preset to use", async () => {
    const { store, reply } = readyStore();
    now = 1_000;
    const sending = store.getState().send();
    reply.push({ text: "", reasoning: "Thinking" });
    await tick();
    now = 4_200;
    reply.push({ text: "Hi", reasoning: "Thinking it over" });
    await tick();
    now = 9_000;
    reply.finish();
    await sending;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "Hi",
      reasoning: "Thinking it over",
      thoughtMs: 3_200,
    });
    store.getState().setDraft("next");
    const next = store.getState().send();
    expect(reply.calls[1]?.request.messages[1]).toEqual({
      role: "assistant",
      content: "Hi",
      macroEligible: true,
      reasoning: "Thinking it over",
    });
    reply.finish();
    await next;
  });
});

describe("preview refresh", () => {
  afterEach(() => vi.useRealTimers());

  it("follows the draft after a pause, and waits while a reply streams", async () => {
    vi.useFakeTimers();
    const { store, reply, preview } = readyStore();
    store.getState().setDraft("a");
    store.getState().setDraft("ab");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(preview.calls).toHaveLength(1);
    expect(preview.calls[0]?.request.messages).toEqual([{ role: "user", content: "ab" }]);

    const sending = store.getState().send();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);
    expect(preview.calls).toHaveLength(1);
    reply.finish();
    await vi.runAllTimersAsync();
    await sending;
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(preview.calls).toHaveLength(2);
  });
});

describe("review fixes", () => {
  it("keeps an edit in the store until saved; Clear drops it; blank or busy saves are refused", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const [user] = store.getState().messages;
    const id = user?.id ?? "";
    store.getState().startEdit(id);
    store.getState().setEditText("   ");
    expect(store.getState().saveEdit()).toBe(false);
    store.getState().setEditText("changed");
    store.getState().setDraft("next");
    const sending = store.getState().send();
    expect(store.getState().saveEdit()).toBe(false);
    expect(store.getState().editing).toEqual({ id, text: "changed", target: "text" });
    reply.finish();
    await sending;
    expect(store.getState().saveEdit()).toBe(true);
    expect(view(store.getState())[0]?.text).toBe("changed");
    expect(store.getState().editing).toBeNull();

    store.getState().startEdit(id);
    store.getState().clear();
    expect(store.getState().editing).toBeNull();
  });

  it("closes an edit whose message is deleted", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const [user] = store.getState().messages;
    store.getState().startEdit(user?.id ?? "");
    store.getState().remove(user?.id ?? "");
    expect(store.getState().editing).toBeNull();
  });

  it("does not bring a deleted greeting back, so Undo cannot duplicate it", () => {
    const { store } = readyStore();
    store.getState().setDraft("");
    store.getState().setGreetings(["One."]);
    const [greeting] = store.getState().messages;
    store.getState().remove(greeting?.id ?? "");
    store.getState().setGreetings(["One."]);
    expect(store.getState().messages).toEqual([]);
    expect(hasChatContent(store.getState())).toBe(true);
    store.getState().undoDelete();
    expect(view(store.getState()).map((m) => m.text)).toEqual(["One."]);
  });

  it("does not continue a greeting", async () => {
    const { store, reply } = readyStore();
    store.getState().setDraft("");
    store.getState().setGreetings(["One."]);
    await store.getState().continueReply();
    expect(reply.calls).toHaveLength(0);
  });

  it("puts the replaced alternate back when a Replace fails", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const replacing = store.getState().regenerate();
    reply.finish(new Error("upstream"));
    await replacing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "A",
      status: "complete",
      failed: "replace",
    });
  });

  it("reads the next prompt from the preview, never from an older request when the preview is refused", async () => {
    const { store, reply, preview } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "", prompt: inspected("sent") });
    reply.finish();
    await sending;
    expect(nextPrompt(store.getState())).toEqual(inspected("sent"));
    const previewing = store.getState().requestPreview();
    preview.calls.at(-1)?.answer({ ok: false, error: "prompt_too_long" });
    await previewing;
    expect(nextPrompt(store.getState())).toBeNull();
  });
});

describe("follow-ups", () => {
  it("deletes a message and everything after it, and Undo brings them all back", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    store.getState().setDraft("second");
    await replied(store, reply, "B");
    const [, answer] = store.getState().messages;
    store.getState().removeFrom(answer?.id ?? "");
    expect(view(store.getState()).map((m) => m.text)).toEqual(["hello"]);
    expect(store.getState().deleted).toMatchObject({ kind: "messages", index: 1 });
    store.getState().undoDelete();
    expect(view(store.getState()).map((m) => m.text)).toEqual(["hello", "A", "second", "B"]);
  });

  it("deletes the shown alternate, shows the one before it, and Undo restores it", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    for (const text of ["B", "C"]) {
      const swiping = store.getState().swipe(1);
      reply.push(text);
      reply.finish();
      await swiping;
    }
    store.getState().swipe(-1);
    store.getState().removeAlternate();
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["A", "C"]);
    expect(last(store.getState())?.text).toBe("A");
    store.getState().undoDelete();
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["A", "B", "C"]);
    expect(last(store.getState())?.text).toBe("B");
    // The first deleted shows the new first; a lone alternate is not deleted this way.
    store.getState().swipe(-1);
    store.getState().removeAlternate();
    expect(last(store.getState())?.text).toBe("B");
  });

  it("edits a reply's reasoning, blank removing it, and sends reasoning with the history", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "Hi", reasoning: "Plan" });
    reply.finish();
    await sending;
    const id = assistant(store.getState()).id;
    store.getState().startEdit(id, "reasoning");
    expect(store.getState().editing).toEqual({ id, text: "Plan", target: "reasoning" });
    store.getState().setEditText("Better plan");
    expect(store.getState().saveEdit()).toBe(true);
    expect(shownReply(assistant(store.getState())).reasoning).toBe("Better plan");
    store.getState().setDraft("next");
    const next = store.getState().send();
    expect(reply.calls[1]?.request.messages[1]).toEqual({
      role: "assistant",
      content: "Hi",
      macroEligible: true,
      reasoning: "Better plan",
    });
    reply.finish();
    await next;
    store.getState().startEdit(id, "reasoning");
    store.getState().setEditText("  ");
    expect(store.getState().saveEdit()).toBe(true);
    expect(shownReply(assistant(store.getState())).reasoning).toBe("");
  });

  it("closes an open edit when the shown alternate changes, so it never saves onto another", async () => {
    const { store, reply } = readyStore();
    await replied(store, reply, "A");
    const swiping = store.getState().swipe(1);
    reply.push({ text: "B", reasoning: "B's plan" });
    reply.finish();
    await swiping;
    const id = assistant(store.getState()).id;
    // Delete B, edit A, then Undo: B shows again and A's edit is gone.
    store.getState().removeAlternate();
    store.getState().startEdit(id);
    store.getState().setEditText("A, edited");
    store.getState().undoDelete();
    expect(store.getState().editing).toBeNull();
    expect(store.getState().saveEdit()).toBe(false);
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["A", "B"]);
    // Swiping away from a reasoning edit closes it too.
    store.getState().startEdit(id, "reasoning");
    store.getState().setEditText("Other plan");
    await store.getState().swipe(-1);
    expect(store.getState().editing).toBeNull();
    expect(assistant(store.getState()).replies.map((r) => r.reasoning)).toEqual(["", "B's plan"]);
  });

  it("sends only the reasoning the prompt preset sends back, all of it while unknown", async () => {
    const { store, reply, selection } = readyStore();
    for (const [draft, reasoning] of [
      ["one", "First plan"],
      ["two", "Second plan"],
    ]) {
      store.getState().setDraft(draft ?? "");
      const sending = store.getState().send();
      reply.push({ text: "Reply", reasoning: reasoning ?? "" });
      reply.finish();
      await sending;
    }
    const sentReasoning = async () => {
      store.getState().setDraft("next");
      const sending = store.getState().send();
      reply.finish();
      await sending;
      return reply.calls
        .at(-1)
        ?.request.messages.flatMap((turn) =>
          turn.reasoning === undefined ? [] : [turn.reasoning],
        );
    };
    expect(await sentReasoning()).toEqual(["First plan", "Second plan"]);
    selection.reasoning = { addToPrompts: false, maxAdditions: 1 };
    expect(await sentReasoning()).toEqual([]);
    selection.reasoning = { addToPrompts: true, maxAdditions: 1 };
    expect(await sentReasoning()).toEqual(["Second plan"]);
  });

  it("times a reply whose model reasoned but showed nothing", async () => {
    const { store, reply } = readyStore();
    now = 1_000;
    const sending = store.getState().send();
    const prompt = { ...inspected("x"), settings: { reasoning: "high" as const } };
    reply.push({ text: "", prompt });
    await tick();
    now = 3_500;
    reply.push({ text: "Hi", prompt });
    reply.finish();
    await sending;
    expect(shownReply(assistant(store.getState()))).toMatchObject({ hiddenMs: 2_500 });
  });
});

describe("signed out", () => {
  /** The tab's view of the session in the current test; a refusal signs it out, as apiFetch does. */
  let session = { signedIn: true };
  const signedOutStore = () => {
    const ready = readyStore();
    session = ready.session;
    return ready;
  };

  /** What the transport throws when the sign-in redirect answered instead of Ephemera. */
  const signedOut = () => {
    session.signedIn = false;
    return Object.assign(new Error("Generation failed (signed_out)"), { reason: "signed_out" });
  };

  it("a send refused before streaming keeps the turn and waits, then goes out once, in place", async () => {
    const { store, reply } = signedOutStore();
    await replied(store, reply, "Welcome.");
    store.getState().setDraft("Where to?");
    const sending = store.getState().send();
    reply.finish(signedOut());
    await sending;
    expect(view(store.getState()).slice(-2)).toEqual([
      { role: "user", text: "Where to?", status: "complete" },
      { role: "assistant", text: "", status: "waiting" },
    ]);
    expect(store.getState().pending).toMatchObject({ mode: "reply" });
    // The draft written meanwhile is the user's and stays.
    store.getState().setDraft("And then?");

    const resumed = store.getState().resume();
    expect(reply.calls).toHaveLength(3);
    expect(reply.calls[2]?.request.messages.at(-1)).toEqual({ role: "user", content: "Where to?" });
    reply.push("Downriver.");
    expect(await resumed).toBe(true);
    reply.finish();
    await tick();
    expect(view(store.getState())).toEqual([
      { role: "user", text: "hello", status: "complete" },
      { role: "assistant", text: "Welcome.", status: "complete" },
      { role: "user", text: "Where to?", status: "complete" },
      { role: "assistant", text: "Downriver.", status: "complete" },
    ]);
    expect(assistant(store.getState()).replies).toHaveLength(1);
    expect(store.getState()).toMatchObject({ pending: null, draft: "And then?" });
    // Once is once: a second renewal has nothing to send.
    expect(await store.getState().resume()).toBe(false);
    expect(reply.calls).toHaveLength(3);
  });

  it("a retry refused again waits again, never loops", async () => {
    const { store, reply } = signedOutStore();
    const sending = store.getState().send();
    reply.finish(signedOut());
    await sending;
    const resumed = store.getState().resume();
    reply.finish(signedOut());
    expect(await resumed).toBe(false);
    await tick();
    expect(reply.calls).toHaveLength(2);
    expect(last(store.getState())?.status).toBe("waiting");
    expect(store.getState().pending).not.toBeNull();
  });

  it("a failure other than signing out stays an ordinary failure", async () => {
    const { store, reply } = signedOutStore();
    const sending = store.getState().send();
    reply.finish(new Error("upstream"));
    await sending;
    expect(last(store.getState())?.status).toBe("failed");
    expect(store.getState().pending).toBeNull();
  });

  it("a stream refused after it started is not retried", async () => {
    const { store, reply } = signedOutStore();
    const sending = store.getState().send();
    reply.push("Half a");
    reply.finish(signedOut());
    await sending;
    expect(last(store.getState())).toMatchObject({ text: "Half a", status: "failed" });
    expect(store.getState().pending).toBeNull();
  });

  it("a Regenerate refused keeps the alternate it would replace, then regenerates that slot", async () => {
    const { store, reply } = signedOutStore();
    await replied(store, reply, "First.");
    const regenerating = store.getState().regenerate();
    reply.finish(signedOut());
    await regenerating;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "First.",
      status: "complete",
    });
    expect(shownReply(assistant(store.getState())).failed).toBeUndefined();
    const resumed = store.getState().resume();
    reply.push("Second.");
    reply.finish();
    await resumed;
    await tick();
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["Second."]);
  });

  it("a Continue refused restores the reply, then continues it", async () => {
    const { store, reply } = signedOutStore();
    await replied(store, reply, "She waits");
    const continuing = store.getState().continueReply();
    reply.finish(signedOut());
    await continuing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "She waits",
      status: "complete",
    });
    expect(shownReply(assistant(store.getState())).failed).toBeUndefined();
    const resumed = store.getState().resume();
    expect(reply.calls.at(-1)?.request.mode).toBe("continue");
    reply.push({ text: "on.", prompt: continuedPrompt() });
    reply.finish();
    await resumed;
    await tick();
    expect(shownReply(assistant(store.getState())).text).toBe("She waits on.");
  });

  it("Write for me refused leaves the draft alone, then writes it", async () => {
    const { store, reply } = signedOutStore();
    await replied(store, reply, "Your move.");
    const writing = store.getState().impersonate();
    reply.finish(signedOut());
    await writing;
    expect(store.getState()).toMatchObject({ draft: "", impersonation: null });
    const resumed = store.getState().resume();
    reply.push("I wave.");
    reply.finish();
    await resumed;
    await tick();
    expect(store.getState().draft).toBe("I wave.");
  });

  it("nothing is generated while signed out", async () => {
    let signedIn = false;
    const reply = controlledReply();
    const store = createChatStore(reply.streamReply, () => selectionOf(), {
      clock: () => CLOCK,
      fetchPreview: controlledPreview().fetchPreview,
      signedIn: () => signedIn,
    });
    store.getState().setDraft("hello");
    await store.getState().send();
    await store.getState().impersonate();
    expect(reply.calls).toHaveLength(0);
    expect(store.getState().draft).toBe("hello");
    signedIn = true;
    void store.getState().send();
    expect(reply.calls).toHaveLength(1);
  });

  it("the preview sends nothing while signed out and keeps the last one", async () => {
    vi.useFakeTimers();
    try {
      let signedIn = true;
      const preview = controlledPreview();
      const store = createChatStore(controlledReply().streamReply, () => selectionOf(), {
        clock: () => CLOCK,
        fetchPreview: preview.fetchPreview,
        signedIn: () => signedIn,
      });
      store.getState().setDraft("one");
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
      preview.calls[0]?.answer({ ok: true, prompt: inspected("one") });
      await vi.advanceTimersByTimeAsync(0);
      signedIn = false;
      store.getState().setDraft("two");
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS * 3);
      await store.getState().requestPreview();
      expect(preview.calls).toHaveLength(1);
      expect(store.getState().preview).toMatchObject({ status: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Replace waiting for sign-in follows its alternate, never another one", async () => {
    const { store, reply } = signedOutStore();
    await replied(store, reply, "First.");
    const another = store.getState().swipe(1);
    reply.push("Second.");
    reply.finish();
    await another;
    // Replace the second alternate, refused; then the owner deletes the first one.
    const regenerating = store.getState().regenerate();
    reply.finish(signedOut());
    await regenerating;
    await store.getState().swipe(-1);
    store.getState().removeAlternate();
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["Second."]);
    const resumed = store.getState().resume();
    reply.push("Third.");
    reply.finish();
    await resumed;
    await tick();
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["Third."]);
  });

  it("a Replace whose alternate was deleted meanwhile is dropped", async () => {
    const { store, reply } = signedOutStore();
    await replied(store, reply, "First.");
    const another = store.getState().swipe(1);
    reply.push("Second.");
    reply.finish();
    await another;
    const regenerating = store.getState().regenerate();
    reply.finish(signedOut());
    await regenerating;
    store.getState().removeAlternate();
    const calls = reply.calls.length;
    expect(await store.getState().resume()).toBe(false);
    expect(reply.calls).toHaveLength(calls);
    expect(assistant(store.getState()).replies.map((r) => r.text)).toEqual(["First."]);
  });

  it("a Continue waiting for sign-in continues only the alternate it was for", async () => {
    const { store, reply } = signedOutStore();
    await replied(store, reply, "She waits");
    const another = store.getState().swipe(1);
    reply.push("He runs");
    reply.finish();
    await another;
    const continuing = store.getState().continueReply();
    reply.finish(signedOut());
    await continuing;
    await store.getState().swipe(-1);
    const calls = reply.calls.length;
    expect(await store.getState().resume()).toBe(false);
    expect(reply.calls).toHaveLength(calls);
  });

  it("without a model at renewal the generation keeps waiting, never shows as streaming", async () => {
    const { store, reply, selection } = signedOutStore();
    const sending = store.getState().send();
    reply.finish(signedOut());
    await sending;
    selection.model = null;
    expect(await store.getState().resume()).toBe(false);
    expect(last(store.getState())?.status).toBe("waiting");
    expect(store.getState().pending).not.toBeNull();
  });

  it("a send made while a generation still waits leaves that slot not sent, with a failed reply's actions", async () => {
    const { store, reply, selection, session } = signedOutStore();
    const sending = store.getState().send();
    reply.finish(signedOut());
    await sending;
    selection.model = null;
    expect(await store.getState().resume()).toBe(false);
    // Signed in again with a model, the owner sends something else first.
    session.signedIn = true;
    selection.model = "model-a";
    store.getState().setDraft("again");
    const next = store.getState().send();
    reply.push("Hi.");
    reply.finish();
    await next;
    expect(store.getState().pending).toBeNull();
    expect(view(store.getState()).map((message) => message.status)).toEqual([
      "complete",
      "failed",
      "complete",
      "complete",
    ]);
  });

  it("a refusal that arrives before the renewal's saves ended waits for them", async () => {
    let resumable = false;
    const reply = controlledReply();
    const store = createChatStore(reply.streamReply, () => selectionOf(), {
      clock: () => CLOCK,
      fetchPreview: controlledPreview().fetchPreview,
      signedIn: () => true,
      resumable: () => resumable,
    });
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    reply.finish(signedOut());
    await sending;
    await tick();
    expect(reply.calls).toHaveLength(1);
    expect(store.getState().pending).not.toBeNull();
    resumable = true;
    const resumed = store.getState().resume();
    reply.push("Hi.");
    reply.finish();
    expect(await resumed).toBe(true);
  });

  it("a refusal that arrives once the session is back is retried at once", async () => {
    let signedIn = false;
    const reply = controlledReply();
    const store = createChatStore(reply.streamReply, () => selectionOf(), {
      clock: () => CLOCK,
      fetchPreview: controlledPreview().fetchPreview,
      signedIn: () => signedIn,
    });
    signedIn = true;
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    // The renewal completed while this older request was still on its way.
    reply.finish(signedOut());
    await sending;
    await tick();
    expect(reply.calls).toHaveLength(2);
    reply.push("Hi.");
    reply.finish();
    await tick();
    await tick();
    expect(last(store.getState())).toMatchObject({ text: "Hi.", status: "complete" });
    expect(store.getState().pending).toBeNull();
  });

  it("Clear drops the pending generation", async () => {
    const { store, reply } = signedOutStore();
    const sending = store.getState().send();
    reply.finish(signedOut());
    await sending;
    store.getState().clear();
    expect(store.getState().pending).toBeNull();
    expect(await store.getState().resume()).toBe(false);
    expect(reply.calls).toHaveLength(1);
  });

  it("a resumed generation keeps the type of the action that asked for it", async () => {
    const { store, reply, session } = signedOutStore();
    const typeSent = () => reply.calls.at(-1)?.request.generationType;
    const refusedThenResumed = async (action: Promise<void>, text: string) => {
      reply.finish(signedOut());
      await action;
      const sentBefore = typeSent();
      const resumed = store.getState().resume();
      expect(typeSent()).toBe(sentBefore);
      reply.push(text);
      reply.finish();
      await resumed;
      await tick();
      session.signedIn = true;
    };
    await refusedThenResumed(store.getState().send(), "A.");
    expect(typeSent()).toBe("normal");
    await refusedThenResumed(store.getState().swipe(1), "B.");
    expect(typeSent()).toBe("swipe");
    await refusedThenResumed(store.getState().regenerate(), "C.");
    expect(typeSent()).toBe("regenerate");
    await refusedThenResumed(store.getState().continueReply(), "D.");
    expect(typeSent()).toBe("continue");
    store.getState().setDraft("");
    await refusedThenResumed(store.getState().impersonate(), "E.");
    expect(typeSent()).toBe("impersonate");
    expect(reply.calls.map((call) => call.request.generationType)).toEqual([
      "normal",
      "normal",
      "swipe",
      "swipe",
      "regenerate",
      "regenerate",
      "continue",
      "continue",
      "impersonate",
      "impersonate",
    ]);
  });

  it("a waiting reply deleted meanwhile is not sent", async () => {
    const { store, reply } = signedOutStore();
    const sending = store.getState().send();
    reply.finish(signedOut());
    await sending;
    store.getState().remove(assistant(store.getState()).id);
    expect(await store.getState().resume()).toBe(false);
    expect(reply.calls).toHaveLength(1);
  });
});

describe("timed lorebook state", () => {
  const CHARACTER = "3f6c1a52-8e4b-4c1d-9a2e-5b7d0c4e8f11";
  const stateAt = (start: number): LorebookState => ({
    characterId: CHARACTER,
    effects: [{ index: 0, digest: "ab12", start }],
  });
  const withState = (state: LorebookState | null): InspectedPrompt => ({
    ...inspected("x"),
    lorebookState: state,
  });

  it("starts empty and is left off requests and previews while empty", async () => {
    const { store, reply, preview } = readyStore();
    expect(store.getState().lorebookState).toBeNull();
    const sending = store.getState().send();
    reply.finish();
    await sending;
    void store.getState().requestPreview();
    expect(reply.calls[0]?.request).not.toHaveProperty("lorebookState");
    expect(preview.calls[0]?.request).not.toHaveProperty("lorebookState");
  });

  it("commits the state a generation's prompt part brings and sends it with every generation and preview", async () => {
    const { store, reply, preview } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "", prompt: withState(stateAt(2)) });
    await tick();
    expect(store.getState().lorebookState).toEqual(stateAt(2));
    reply.push("A");
    reply.finish();
    await sending;

    const swiping = store.getState().swipe(1);
    expect(reply.calls[1]?.request.lorebookState).toEqual(stateAt(2));
    reply.push({ text: "B", prompt: withState(stateAt(3)) });
    reply.finish();
    await swiping;

    const regenerating = store.getState().regenerate();
    expect(reply.calls[2]?.request.lorebookState).toEqual(stateAt(3));
    reply.push("C");
    reply.finish();
    await regenerating;

    const continuing = store.getState().continueReply();
    expect(reply.calls[3]?.request.lorebookState).toEqual(stateAt(3));
    reply.finish();
    await continuing;

    store.getState().setDraft("");
    const writing = store.getState().impersonate();
    expect(reply.calls[4]?.request.lorebookState).toEqual(stateAt(3));
    reply.finish();
    await writing;

    void store.getState().requestPreview();
    expect(preview.calls.at(-1)?.request.lorebookState).toEqual(stateAt(3));
  });

  it("commits on the prompt part even when the reply is then stopped or fails", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "half", prompt: withState(stateAt(2)) });
    await tick();
    store.getState().stop();
    reply.finish(new DOMException("aborted", "AbortError"));
    await sending;
    expect(last(store.getState())?.status).toBe("stopped");
    expect(store.getState().lorebookState).toEqual(stateAt(2));

    store.getState().setDraft("again");
    const failing = store.getState().send();
    reply.push({ text: "", prompt: withState(stateAt(4)) });
    reply.finish(new Error("upstream"));
    await failing;
    expect(last(store.getState())?.status).toBe("failed");
    expect(store.getState().lorebookState).toEqual(stateAt(4));
  });

  it("follows a prompt part that carries no state, for a character without a book", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    reply.push({ text: "A", prompt: withState(stateAt(2)) });
    reply.finish();
    await first;
    store.getState().setDraft("next");
    const second = store.getState().send();
    reply.push({ text: "B", prompt: withState(null) });
    reply.finish();
    await second;
    expect(store.getState().lorebookState).toBeNull();
  });

  it("is never changed by a preview", async () => {
    const { store, reply, preview } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "A", prompt: withState(stateAt(2)) });
    reply.finish();
    await sending;
    const previewing = store.getState().requestPreview();
    preview.calls.at(-1)?.answer({ ok: true, prompt: withState(stateAt(9)) });
    await previewing;
    expect(store.getState().preview.status).toBe("ready");
    expect(store.getState().lorebookState).toEqual(stateAt(2));
  });

  it("Clear empties it, and a late prompt part from before the Clear is dropped", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    reply.push({ text: "A", prompt: withState(stateAt(2)) });
    reply.finish();
    await first;

    store.getState().setDraft("next");
    const streaming = store.getState().send();
    store.getState().clear();
    expect(store.getState().lorebookState).toBeNull();
    reply.push({ text: "late", prompt: withState(stateAt(3)) });
    reply.finish();
    await streaming;
    expect(store.getState().lorebookState).toBeNull();

    store.getState().setDraft("fresh");
    const fresh = store.getState().send();
    expect(reply.calls[2]?.request).not.toHaveProperty("lorebookState");
    reply.finish();
    await fresh;
  });
});

describe("events state", () => {
  const CHARACTER = "3f6c1a52-8e4b-4c1d-9a2e-5b7d0c4e8f11";
  const A = "7d0b2c1e-4f3a-4b5c-8d6e-0a1b2c3d4e5f";
  const B = "8e1c3d2f-5a4b-4c6d-9e7f-1b2c3d4e5f60";
  const fired = (...records: { id: string; start: number }[]): EventsState => ({
    characterId: CHARACTER,
    fired: records,
  });
  const withEvents = (state: EventsState): InspectedPrompt => ({
    ...inspected("x"),
    eventsState: state,
  });

  it("commits the state a generation's prompt part brings and sends it with the next one", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    expect(reply.calls[0]?.request).not.toHaveProperty("eventsState");
    reply.push({ text: "", prompt: withEvents(fired({ id: A, start: 1 })) });
    await tick();
    expect(store.getState().eventsState).toEqual(fired({ id: A, start: 1 }));
    reply.finish();
    await sending;

    const swiping = store.getState().swipe(1);
    expect(reply.calls[1]?.request.eventsState).toEqual(fired({ id: A, start: 1 }));
    reply.push({ text: "B", prompt: withEvents(fired()) });
    reply.finish();
    await swiping;
    expect(store.getState().eventsState).toEqual(fired());
  });

  it("drops the state it held when a reply's prompt carries none", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    reply.push({ text: "A", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish();
    await first;
    expect(store.getState().eventsState).toEqual(fired({ id: A, start: 1 }));

    // The server leaves out a state with nothing in it: the tab holds none either.
    store.getState().setDraft("next");
    const second = store.getState().send();
    reply.push({ text: "B", prompt: inspected("x") });
    reply.finish();
    await second;
    expect(store.getState().eventsState).toBeNull();
    store.getState().setDraft("after");
    const third = store.getState().send();
    expect(reply.calls[2]?.request).not.toHaveProperty("eventsState");
    reply.finish();
    await third;
  });

  it("is never changed by a preview", async () => {
    const { store, reply, preview } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "A", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish();
    await sending;
    const previewing = store.getState().requestPreview();
    expect(preview.calls.at(-1)?.request.eventsState).toEqual(fired({ id: A, start: 1 }));
    preview.calls.at(-1)?.answer({ ok: true, prompt: withEvents(fired({ id: B, start: 9 })) });
    await previewing;
    expect(store.getState().preview.status).toBe("ready");
    expect(store.getState().eventsState).toEqual(fired({ id: A, start: 1 }));
  });

  it("Clear empties it", async () => {
    const { store, reply } = readyStore();
    const sending = store.getState().send();
    reply.push({ text: "A", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish();
    await sending;
    store.getState().clear();
    expect(store.getState().eventsState).toBeNull();
    store.getState().setDraft("fresh");
    const fresh = store.getState().send();
    expect(reply.calls[1]?.request).not.toHaveProperty("eventsState");
    reply.finish();
    await fresh;
  });

  it("drops a late event-bearing prompt part from before a Clear", async () => {
    const { store, reply } = readyStore();
    const streaming = store.getState().send();
    store.getState().clear();
    reply.push({ text: "late", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish();
    await streaming;
    expect(store.getState().eventsState).toBeNull();
  });

  it("forgets an event that fired on a deleted message and moves the later ones down", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    reply.push({ text: "A", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish();
    await first;
    store.getState().setDraft("next");
    const second = store.getState().send();
    reply.push({ text: "B", prompt: withEvents(fired({ id: A, start: 1 }, { id: B, start: 3 })) });
    reply.finish();
    await second;

    // The first reply, the turn at index 1: A fired on it.
    const firstReply = store.getState().messages[1];
    store.getState().remove(firstReply?.id ?? "");
    expect(store.getState().eventsState).toEqual(fired({ id: B, start: 2 }));
    // Undo brings the reply back, and the state it had.
    store.getState().undoDelete();
    expect(store.getState().eventsState).toEqual(fired({ id: A, start: 1 }, { id: B, start: 3 }));
  });

  it("forgets every event at or past a cut when a message and all after it are deleted", async () => {
    const { store, reply } = readyStore();
    const first = store.getState().send();
    reply.push({ text: "A", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish();
    await first;
    store.getState().setDraft("next");
    const second = store.getState().send();
    reply.push({ text: "B", prompt: withEvents(fired({ id: A, start: 1 }, { id: B, start: 3 })) });
    reply.finish();
    await second;

    // From the second user turn on (index 2): B fired on the reply after it.
    const cut = store.getState().messages[2];
    store.getState().removeFrom(cut?.id ?? "");
    expect(store.getState().eventsState).toEqual(fired({ id: A, start: 1 }));
    store.getState().undoDelete();
    expect(store.getState().eventsState).toEqual(fired({ id: A, start: 1 }, { id: B, start: 3 }));
  });

  it("moves later events up when an earlier failed reply is edited into one that is sent", async () => {
    const { store, reply } = readyStore();
    const failing = store.getState().send();
    reply.push({ text: "", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish(new Error("upstream"));
    await failing;
    store.getState().setDraft("again");
    const next = store.getState().send();
    // Sent without the failed reply, the history had 2 turns: B fired on the reply at index 2.
    reply.push({ text: "B", prompt: withEvents(fired({ id: B, start: 2 })) });
    reply.finish();
    await next;

    const failed = store.getState().messages[1];
    store.getState().edit(failed?.id ?? "", "Written by hand");
    // The edited reply is the turn at index 1 now, so the one B fired on is at index 3.
    expect(store.getState().eventsState).toEqual(fired({ id: B, start: 3 }));
    // Editing a turn that was already sent moves nothing.
    store.getState().edit(failed?.id ?? "", "Written again");
    expect(store.getState().eventsState).toEqual(fired({ id: B, start: 3 }));
  });

  it("lets an event that fired on a failed reply roll again when the user sends a new message", async () => {
    const { store, reply } = readyStore();
    const failing = store.getState().send();
    reply.push({ text: "", prompt: withEvents(fired({ id: A, start: 1 })) });
    reply.finish(new Error("upstream"));
    await failing;
    expect(last(store.getState())?.status).toBe("failed");

    store.getState().setDraft("again");
    const next = store.getState().send();
    const request = reply.calls[1]?.request;
    expect(request?.eventsState).toEqual(fired({ id: A, start: 1 }));
    // The failed reply is not sent on, so its record no longer stands: the event rolls again.
    const event = {
      id: A,
      chance: 100,
      cooldown: 5,
      enabled: true,
      scope: { kind: "all" as const },
    };
    const roll = rollEvents({
      events: [event],
      character: { id: CHARACTER, tags: [] },
      state: request?.eventsState ?? null,
      roles: request?.messages.map((turn) => turn.role) ?? [],
      random: () => 0,
    });
    expect(roll).toEqual({ fired: event, kept: [] });
    reply.finish();
    await next;
  });
});

describe("macro state", () => {
  /** What the browser's macros read: a persona and the built-in preset; synthetic only. */
  const subjectAs = (name: string | null, change: Partial<MacroSubject> = {}): MacroSubject => ({
    character: null,
    persona: name === null ? null : { name, description: "" },
    preset: defaultPromptPreset(),
    prefer: { preferCharacterPrompt: true, preferCharacterInstructions: true },
    ...change,
  });
  const loaded = (subject: MacroSubject = subjectAs("Ash")): SubjectResult => ({
    ok: true,
    subject,
  });

  function macroStore(
    subject: (selection: Selection) => Promise<SubjectResult> = async () => loaded(),
    session = { signedIn: true },
  ) {
    const reply = controlledReply();
    const preview = controlledPreview();
    const selection = selectionOf({ personaId: "ash" });
    const store = createChatStore(reply.streamReply, () => selection, {
      clock: () => CLOCK,
      pickSeed: () => SEED,
      now: () => now,
      fetchPreview: preview.fetchPreview,
      signedIn: () => session.signedIn,
      subject,
      random: () => 0.5,
    });
    return { store, reply, preview, selection, session };
  }

  const state = (local: Record<string, string>, global: Record<string, string> = {}) => ({
    local,
    global,
  });
  const promptWith = (macroState: MacroState): InspectedPrompt => ({
    ...inspected("x"),
    macroState,
  });

  it("fills a sent message once, commits each step once, and survives two turns; a preview never commits", async () => {
    const { store, reply, preview } = macroStore();
    store.getState().setDraft("{{setvar::mood::calm}}I am {{user}}, {{getvar::mood}}.");
    const first = store.getState().send();
    await tick();
    expect(store.getState().messages[0]).toMatchObject({
      role: "user",
      text: "I am Ash, calm.",
      name: "Ash",
    });
    expect(reply.calls[0]?.request).toMatchObject({
      generationType: "normal",
      macroState: state({ mood: "calm" }),
      messages: [{ role: "user", content: "I am Ash, calm.", name: "Ash" }],
    });
    // The prompt's effects commit once it arrives; the output's once it ends, never per chunk.
    reply.push({ text: "", prompt: promptWith(state({ mood: "calm", turn: "1" })) });
    reply.push("{{setglobalvar::seen::yes}}Turn");
    await tick();
    expect(store.getState().macroState).toEqual(state({ mood: "calm", turn: "1" }));
    reply.push("{{setglobalvar::seen::yes}}Turn {{getvar::turn}}");
    reply.finish();
    await first;
    const raw = "{{setglobalvar::seen::yes}}Turn {{getvar::turn}}";
    expect(shownReply(assistant(store.getState()))).toMatchObject({ text: "Turn 1", rawText: raw });
    expect(store.getState().macroState).toEqual(
      state({ mood: "calm", turn: "1" }, { seen: "yes" }),
    );

    // A preview fills the draft on a copy; what the server answers is never committed.
    store.getState().setDraft("{{setvar::mood::tense}}Again");
    const previewing = store.getState().requestPreview();
    await tick();
    expect(preview.calls.at(-1)?.request).toMatchObject({
      macroState: state({ mood: "tense", turn: "1" }, { seen: "yes" }),
      messages: [
        { role: "user", content: "I am Ash, calm.", name: "Ash" },
        { role: "assistant", content: raw },
        { role: "user", content: "Again", name: "Ash" },
      ],
    });
    preview.calls.at(-1)?.answer({ ok: true, prompt: promptWith(state({ mood: "bogus" })) });
    await previewing;
    expect(store.getState().preview.status).toBe("ready");
    expect(store.getState().macroState).toEqual(
      state({ mood: "calm", turn: "1" }, { seen: "yes" }),
    );

    // The second turn starts from the committed state, the model's own text going back as written.
    const second = store.getState().send();
    await tick();
    expect(reply.calls[1]?.request.macroState).toEqual(
      state({ mood: "tense", turn: "1" }, { seen: "yes" }),
    );
    expect(reply.calls[1]?.request.messages[1]).toEqual({
      role: "assistant",
      content: raw,
      macroEligible: true,
      scanText: "Turn 1",
    });
    reply.finish();
    await second;
    expect(store.getState().macroState).toEqual(
      state({ mood: "tense", turn: "1" }, { seen: "yes" }),
    );
  });

  it("leaves the state alone when the prompt carries no macro state", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("{{setvar::a::1}}Hi");
    const sending = store.getState().send();
    await tick();
    reply.push({ text: "Hello", prompt: inspected("x") });
    reply.finish();
    await sending;
    expect(store.getState().macroState).toEqual(state({ a: "1" }));
  });

  it("commits only the greeting shown, each from the same base, and a refill never adds up", () => {
    const { store } = macroStore();
    let evaluations = 0;
    const evaluate = (base: MacroState): GreetingChoice[] => {
      evaluations += 1;
      return ["{{addvar::n::1}}One.", "{{setglobalvar::picked::two}}Two."].map((raw, at) => ({
        key: `card:${at}`,
        ...fillChatText(raw, {
          character: null,
          persona: null,
          clock: CLOCK,
          pickSeed: SEED,
          random: () => 0.5,
          macroState: base,
        }),
        rawText: raw,
      }));
    };
    store.getState().setGreetingChoices(evaluate);
    expect(last(store.getState())?.text).toBe("One.");
    expect(store.getState().macroState).toEqual(state({ n: "1" }));
    store.getState().swipe(1);
    expect(store.getState().macroState).toEqual(state({}, { picked: "two" }));
    // A persona change refills from the base the first fill used.
    store.getState().setGreetingChoices(evaluate);
    store.getState().pickGreeting(0);
    expect(store.getState().macroState).toEqual(state({ n: "1" }));
    // An edited greeting is the user's: nothing fills it again.
    store.getState().edit(assistant(store.getState()).id, "Mine.");
    store.getState().setGreetingChoices(evaluate);
    expect(evaluations).toBe(2);
    expect(shownReply(assistant(store.getState())).rawText).toBeUndefined();
    store.getState().clear();
    expect(store.getState().macroState).toEqual(state({}));
  });

  it("does not bring a deleted greeting back on a refill", () => {
    const { store } = macroStore();
    store.getState().setGreetings(["One."]);
    store.getState().remove(assistant(store.getState()).id);
    store.getState().setGreetings(["One."]);
    expect(store.getState().messages).toEqual([]);
  });

  it("Clear and pagehide drop local and global variables; late writes of the old chat are dropped", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("{{setvar::a::1}}{{setglobalvar::b::2}}Hi");
    const sending = store.getState().send();
    await tick();
    expect(store.getState().macroState).toEqual(state({ a: "1" }, { b: "2" }));
    store.getState().clear();
    expect(store.getState().macroState).toEqual(state({}));
    reply.push({ text: "{{setvar::late::1}}x", prompt: promptWith(state({ late: "1" })) });
    reply.finish();
    await sending;
    expect(store.getState().macroState).toEqual(state({}));
    expect(store.getState().messages).toEqual([]);
  });

  it("a send whose subject loads after Clear sends nothing and commits nothing", async () => {
    let release: (result: SubjectResult) => void = () => {};
    const { store, reply } = macroStore(
      () =>
        new Promise<SubjectResult>((resolve) => {
          release = resolve;
        }),
    );
    store.getState().setDraft("{{setvar::a::1}}Hi");
    const sending = store.getState().send();
    store.getState().clear();
    release(loaded());
    await sending;
    expect(reply.calls).toHaveLength(0);
    expect(store.getState().macroState).toEqual(state({}));
  });

  it("keeps the draft and says why when the subject does not load or the macros leave nothing", async () => {
    let result: SubjectResult = { ok: false };
    const { store, reply } = macroStore(async () => result);
    store.getState().setDraft("{{setvar::a::1}}Hi");
    await store.getState().send();
    expect(store.getState()).toMatchObject({
      draft: "{{setvar::a::1}}Hi",
      macroNotice: "unavailable",
      messages: [],
    });
    result = loaded();
    store.getState().setDraft("{{setvar::a::1}}");
    expect(store.getState().macroNotice).toBeNull();
    await store.getState().send();
    expect(store.getState()).toMatchObject({ draft: "{{setvar::a::1}}", macroNotice: "empty" });
    expect(store.getState().macroState).toEqual(state({}));
    expect(reply.calls).toHaveLength(0);
  });

  it("keeps an empty composer unsent", async () => {
    const { store, reply } = macroStore(async () => loaded(subjectAs("Ash")));
    for (const text of ["", "   "]) {
      store.getState().setDraft(text);
      await store.getState().send();
      expect(reply.calls).toHaveLength(0);
      expect(store.getState().draft).toBe(text);
    }
  });

  it("fills {{authorsNote}} in sent text from the selected preset's note, on or off", async () => {
    const preset = defaultPromptPreset();
    const withNote = (text: string, enabled: boolean): MacroSubject =>
      subjectAs("Ash", {
        preset: { ...preset, authorsNote: { ...DEFAULT_AUTHORS_NOTE, text, enabled } },
      });
    let subject = withNote("Keep the fog thick.", true);
    const { store, reply } = macroStore(async () => loaded(subject));
    const sent = async (draft: string) => {
      store.getState().setDraft(draft);
      const sending = store.getState().send();
      await tick();
      const content = reply.calls.at(-1)?.request.messages.at(-1)?.content;
      reply.push("A");
      reply.finish();
      await sending;
      return content;
    };
    expect(await sent("Note: {{authorsNote}}")).toBe("Note: Keep the fog thick.");
    subject = withNote("Keep the fog thick.", false);
    expect(await sent("Off: {{authorsNote}}")).toBe("Off: Keep the fog thick.");
    // Another preset chosen, or this one saved with new text: the next send reads it.
    subject = withNote("Let the rain fall.", true);
    expect(await sent("Now: {{authorsNote}}")).toBe("Now: Let the rain fall.");
  });

  it("keeps each message's speaker when the persona changes or is deleted", async () => {
    let subject = subjectAs("Ash");
    const { store, reply } = macroStore(async () => loaded(subject));
    store.getState().setDraft("hello");
    const first = store.getState().send();
    await tick();
    reply.push("A");
    reply.finish();
    await first;
    subject = subjectAs("Wren");
    store.getState().setDraft("again");
    const second = store.getState().send();
    await tick();
    reply.finish();
    await second;
    subject = subjectAs(null);
    store.getState().setDraft("alone");
    const third = store.getState().send();
    await tick();
    expect(
      reply.calls[2]?.request.messages.flatMap((turn) => (turn.role === "user" ? [turn.name] : [])),
    ).toEqual(["Ash", "Wren", "User"]);
    reply.finish();
    await third;
  });

  it("continues the reply as written and fills only what the continuation adds", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("{{setvar::mood::calm}}Go");
    const sending = store.getState().send();
    await tick();
    reply.push("She is {{getvar::mood}}");
    reply.finish();
    await sending;
    expect(shownReply(assistant(store.getState()))).toMatchObject({ text: "She is calm" });
    const continuing = store.getState().continueReply();
    await tick();
    expect(reply.calls[1]?.request).toMatchObject({
      generationType: "continue",
      messages: [
        { role: "user", content: "Go" },
        { role: "assistant", content: "She is {{getvar::mood}}" },
      ],
    });
    reply.push({ text: "{{setvar::mood::wary}}and {{getvar::mood}}.", prompt: continuedPrompt() });
    reply.finish();
    await continuing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "She is calm and wary.",
      rawText: "She is {{getvar::mood}} {{setvar::mood::wary}}and {{getvar::mood}}.",
    });
    expect(store.getState().macroState).toEqual(state({ mood: "wary" }));
  });

  it("a failed Replace keeps the reply as it was; an edit makes the edited text the one sent", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.push("{{setvar::x::1}}Hi");
    reply.finish();
    await sending;
    const before = shownReply(assistant(store.getState()));
    expect(before).toMatchObject({ text: "Hi", rawText: "{{setvar::x::1}}Hi" });
    const replacing = store.getState().regenerate();
    await tick();
    reply.push("{{setvar::x::2}}Other");
    reply.finish(new Error("upstream"));
    await replacing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "Hi",
      rawText: "{{setvar::x::1}}Hi",
      failed: "replace",
    });
    expect(store.getState().macroState).toEqual(state({ x: "1" }));
    store.getState().edit(assistant(store.getState()).id, "Edited {{char}}");
    expect(shownReply(assistant(store.getState())).rawText).toBeUndefined();
    store.getState().setDraft("next");
    const next = store.getState().send();
    await tick();
    expect(reply.calls[2]?.request.messages[1]).toEqual({
      role: "assistant",
      content: "Edited {{char}}",
    });
    reply.finish();
    await next;
  });

  it("fills Write for me's draft once it ends, and commits it once", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("");
    const writing = store.getState().impersonate();
    await tick();
    expect(reply.calls[0]?.request.generationType).toBe("impersonate");
    reply.push("{{setvar::w::1}}I wave");
    await tick();
    expect(store.getState().draft).toBe("{{setvar::w::1}}I wave");
    expect(store.getState().macroState).toEqual(state({}));
    reply.push("{{setvar::w::1}}I wave, {{user}}.");
    reply.finish();
    await writing;
    expect(store.getState().draft).toBe("I wave, Ash.");
    expect(store.getState().macroState).toEqual(state({ w: "1" }));
  });

  it("a retry after a sign-in never fills the sent message again", async () => {
    const session = { signedIn: true };
    const { store, reply } = macroStore(async () => loaded(), session);
    store.getState().setDraft("{{addvar::n::1}}Hi");
    const sending = store.getState().send();
    await tick();
    session.signedIn = false;
    reply.finish(Object.assign(new Error("signed out"), { reason: "signed_out" }));
    await sending;
    expect(store.getState().pending).toMatchObject({ mode: "reply", type: "normal" });
    session.signedIn = true;
    const resumed = store.getState().resume();
    await tick();
    expect(reply.calls).toHaveLength(2);
    expect(reply.calls[1]?.request).toMatchObject({
      generationType: "normal",
      macroState: state({ n: "1" }),
      messages: [{ role: "user", content: "Hi" }],
    });
    reply.push("Back.");
    reply.finish();
    await resumed;
    expect(store.getState().macroState).toEqual(state({ n: "1" }));
  });

  it("sends the honest runtime: the prompt's first kept turn, the alternate and the idle time", async () => {
    let clockNow = CLOCK.now;
    const reply = controlledReply();
    const store = createChatStore(reply.streamReply, () => selectionOf(), {
      clock: () => ({ ...CLOCK, now: clockNow }),
      fetchPreview: controlledPreview().fetchPreview,
      isMobile: () => true,
    });
    store.getState().setDraft("one");
    const first = store.getState().send();
    reply.push({ text: "A", prompt: { ...inspected("x"), firstIncludedMessageId: 0 } });
    reply.finish();
    await first;
    clockNow += 3 * 60 * 60 * 1000;
    store.getState().setDraft("two");
    const second = store.getState().send();
    expect(reply.calls[1]?.request.macroRuntime).toEqual({
      firstIncludedMessageId: 0,
      firstDisplayedMessageId: 0,
      isMobile: true,
      idleDuration: "3 hours",
      input: "",
    });
    reply.push("B");
    reply.finish();
    await second;
    const swiping = store.getState().swipe(1);
    reply.push("C");
    reply.finish();
    await swiping;
    store.getState().setDraft("draft");
    const continuing = store.getState().continueReply();
    expect(reply.calls[3]?.request.macroRuntime).toMatchObject({
      currentSwipeId: 1,
      lastSwipeId: 1,
      input: "draft",
    });
    reply.finish();
    await continuing;
  });

  it("sends the greeting as shown, its counter once; a generated reply goes as written, even one that shows nothing", async () => {
    const { store, reply } = macroStore();
    const raw = "Hello{{incvar::n}}";
    const evaluate = (base: MacroState): GreetingChoice[] => [
      {
        key: "card:0",
        ...fillChatText(raw, {
          character: null,
          persona: null,
          clock: CLOCK,
          pickSeed: SEED,
          random: () => 0.5,
          macroState: base,
        }),
        rawText: raw,
      },
    ];
    store.getState().setGreetingChoices(evaluate);
    // A refill (a persona change) starts from the same base: the counter never adds up.
    store.getState().setGreetingChoices(evaluate);
    expect(shownReply(assistant(store.getState()))).toMatchObject({ text: "Hello1", rawText: raw });
    expect(store.getState().macroState).toEqual(state({ n: "1" }));

    store.getState().setDraft("one");
    const first = store.getState().send();
    await tick();
    reply.push("{{setvar::seen::1}}");
    reply.finish();
    await first;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "",
      rawText: "{{setvar::seen::1}}",
    });
    store.getState().setDraft("two");
    const second = store.getState().send();
    await tick();
    expect(reply.calls[0]?.request.messages).toEqual([
      { role: "assistant", content: "Hello1" },
      { role: "user", content: "one", name: "Ash" },
    ]);
    expect(reply.calls[1]?.request.messages).toEqual([
      { role: "assistant", content: "Hello1" },
      { role: "user", content: "one", name: "Ash" },
      { role: "assistant", content: "{{setvar::seen::1}}", macroEligible: true, scanText: "" },
      { role: "user", content: "two", name: "Ash" },
    ]);
    expect(reply.calls[1]?.request.macroState).toEqual(state({ n: "1", seen: "1" }));
    reply.finish();
    await second;
    expect(store.getState().macroState).toEqual(state({ n: "1", seen: "1" }));
  });

  it("fills the model's runtime: the selection's for a message, the sent prompt's for the output", async () => {
    const runtime = { model: "model-a", window: 2_000, reserve: 200 };
    const { store, reply } = macroStore(async () => loaded(subjectAs("Ash", { runtime })));
    const macros = "{{model}} {{maxContextTokens}}/{{maxResponseTokens}}/{{maxPrompt}}";
    store.getState().setDraft(`On ${macros}`);
    const sending = store.getState().send();
    await tick();
    expect(store.getState().messages[0]).toMatchObject({ text: "On model-a 2000/200/1800" });
    // The prompt says what the request was built with; a change of catalog meanwhile is not read.
    reply.push({ text: "", prompt: inspected("x") });
    reply.push(`Out ${macros}`);
    reply.finish();
    await sending;
    expect(shownReply(assistant(store.getState())).text).toBe("Out model-a 1000/100/900");
  });

  it("keeps the draft and says the model needs a window when none is known; the preview is refused alike", async () => {
    const { store, reply, preview } = macroStore(
      async (): Promise<SubjectResult> => ({ ok: false, reason: "context_window_unknown" }),
    );
    store.getState().setDraft("{{setvar::a::1}}Hi");
    await store.getState().send();
    expect(store.getState()).toMatchObject({
      draft: "{{setvar::a::1}}Hi",
      macroNotice: "window",
      messages: [],
    });
    await store.getState().requestPreview();
    expect(preview.calls).toHaveLength(0);
    expect(store.getState().preview).toEqual({
      status: "context_window_unknown",
      prompt: null,
      draftIndex: null,
    });
    expect(store.getState().macroState).toEqual(state({}));
    expect(reply.calls).toHaveLength(0);
  });

  it("a preparation from before Clear neither holds up the new chat nor lets it send twice", async () => {
    const releases: ((result: SubjectResult) => void)[] = [];
    const { store, reply } = macroStore(
      () =>
        new Promise<SubjectResult>((resolve) => {
          releases.push(resolve);
        }),
    );
    store.getState().setDraft("old");
    const old = store.getState().send();
    store.getState().clear();
    store.getState().setDraft("new");
    const fresh = store.getState().send();
    expect(releases).toHaveLength(2);
    // The old chat's subject arrives while the new one's still loads: Send still waits for it.
    releases[0]?.(loaded());
    await old;
    await store.getState().send();
    expect(releases).toHaveLength(2);
    releases[1]?.(loaded());
    await tick();
    expect(reply.calls).toHaveLength(1);
    expect(store.getState().messages.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ text: "new" }),
    ]);
    expect(store.getState().macroNotice).toBeNull();
    reply.finish();
    await fresh;
  });

  /** A subject that loads at once, or, while held, once released. */
  function heldSubject() {
    let held = false;
    const waiting: (() => void)[] = [];
    return {
      subject: (): Promise<SubjectResult> =>
        held
          ? new Promise((resolve) => waiting.push(() => resolve(loaded())))
          : Promise.resolve(loaded()),
      hold: () => {
        held = true;
      },
      release: () => {
        held = false;
        for (const resolve of waiting.splice(0)) resolve();
      },
    };
  }

  /** A chat answered "A", then "B" as a second alternate, shown. */
  async function twoAlternates(held: ReturnType<typeof heldSubject>) {
    const ready = macroStore(held.subject);
    const { store, reply } = ready;
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.push("A");
    reply.finish();
    await sending;
    const swiping = store.getState().swipe(1);
    await tick();
    reply.push("B");
    reply.finish();
    await swiping;
    return ready;
  }

  const texts = (state: ChatState) => assistant(state).replies.map((r) => r.text);

  it("Replace, Continue and a new alternate act only on the alternate shown when chosen, never one switched to meanwhile", async () => {
    const held = heldSubject();
    const { store, reply } = await twoAlternates(held);
    const calls = reply.calls.length;
    // Replace B, then show A while its subject loads: neither is replaced.
    held.hold();
    const replacing = store.getState().regenerate();
    await store.getState().swipe(-1);
    held.release();
    await replacing;
    expect(texts(store.getState())).toEqual(["A", "B"]);
    expect(assistant(store.getState()).shown).toBe(0);
    expect(store.getState().macroNotice).toBe("changed");
    // Continue A, then show B: neither is continued.
    held.hold();
    const continuing = store.getState().continueReply();
    await store.getState().swipe(1);
    held.release();
    await continuing;
    expect(texts(store.getState())).toEqual(["A", "B"]);
    // A new alternate after B, then show A: none is added.
    held.hold();
    const another = store.getState().swipe(1);
    await store.getState().swipe(-1);
    held.release();
    await another;
    expect(texts(store.getState())).toEqual(["A", "B"]);
    expect(reply.calls).toHaveLength(calls);
    // Unchanged meanwhile, it goes.
    const replaced = store.getState().regenerate();
    await tick();
    expect(reply.calls).toHaveLength(calls + 1);
    expect(store.getState().macroNotice).toBeNull();
    reply.push("C");
    reply.finish();
    await replaced;
    expect(texts(store.getState())).toEqual(["C", "B"]);
  });

  it("an edit or a delete while the subject loads keeps what the owner did", async () => {
    const held = heldSubject();
    const { store, reply } = await twoAlternates(held);
    const calls = reply.calls.length;
    held.hold();
    const replacing = store.getState().regenerate();
    store.getState().edit(assistant(store.getState()).id, "B, edited");
    held.release();
    await replacing;
    expect(texts(store.getState())).toEqual(["A", "B, edited"]);
    expect(store.getState().macroNotice).toBe("changed");
    held.hold();
    const continuing = store.getState().continueReply();
    store.getState().remove(assistant(store.getState()).id);
    held.release();
    await continuing;
    expect(store.getState().messages.map((message) => message.role)).toEqual(["user"]);
    expect(reply.calls).toHaveLength(calls);
    // Clear meanwhile: nothing of the old chat comes back.
    store.getState().undoDelete();
    held.hold();
    const cleared = store.getState().continueReply();
    store.getState().clear();
    held.release();
    await cleared;
    expect(store.getState()).toMatchObject({ messages: [], macroNotice: null });
    expect(reply.calls).toHaveLength(calls);
  });

  it("discards an echoed edited prefix before filling only the new continuation", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.push("Hi");
    reply.finish();
    await sending;
    const literal = "{{setvar::x::5}}Edited";
    store.getState().edit(assistant(store.getState()).id, literal);
    const continuing = store.getState().continueReply();
    await tick();
    for (const text of ["{{setvar::x::5}}", literal]) {
      reply.push({ text, prompt: continuedPrompt() });
      await tick();
      expect(shownReply(assistant(store.getState())).text).toBe(literal);
      expect(store.getState().macroState).toEqual(state({}));
    }
    reply.push({ text: `${literal} {{incvar::n}} more`, prompt: continuedPrompt() });
    await tick();
    expect(shownReply(assistant(store.getState())).text).toBe(`${literal} {{incvar::n}} more`);
    reply.finish();
    await continuing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: `${literal} 1 more`,
      rawText: `${literal} {{incvar::n}} more`,
      macroPrefixLength: `${literal} `.length,
    });
    expect(store.getState().macroState).toEqual(state({ n: "1" }));
  });

  it("does not execute a literal edited macro when stopped during its echo", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.push("Hi");
    reply.finish();
    await sending;
    const literal = "{{setvar::x::5}}Edited";
    store.getState().edit(assistant(store.getState()).id, literal);
    const before = shownReply(assistant(store.getState()));
    const continuing = store.getState().continueReply();
    await tick();
    reply.push({ text: "{{setvar::x::5}}", prompt: continuedPrompt() });
    await tick();
    expect(shownReply(assistant(store.getState())).text).toBe(literal);
    store.getState().stop();
    reply.finish();
    await continuing;
    expect(shownReply(assistant(store.getState()))).toEqual({ ...before, status: "stopped" });
    expect(store.getState().macroState).toEqual(state({}));
  });

  it.each([" ", "\n"])(
    "joins an echoed continuation after %j in streamed, final and raw text",
    async (whitespace) => {
      const { store, reply } = macroStore();
      store.getState().setDraft("hello");
      const original = `She waits${whitespace}`;
      const raw = `{{setvar::mood::calm}}${original}`;
      const sending = store.getState().send();
      await tick();
      reply.push(raw);
      reply.finish();
      await sending;
      const continuing = store.getState().continueReply();
      await tick();
      for (const text of ["She", "She waits"]) {
        reply.push({ text, prompt: continuedPrompt() });
        await tick();
        expect(shownReply(assistant(store.getState()))).toMatchObject({
          text: original,
          rawText: raw,
          status: "streaming",
        });
      }
      const suffix = "again{{incvar::n}}.";
      reply.push({ text: `She waits ${suffix}`, prompt: continuedPrompt() });
      await tick();
      expect(shownReply(assistant(store.getState()))).toMatchObject({
        text: original + suffix,
        rawText: raw + suffix,
        status: "streaming",
      });
      reply.finish();
      await continuing;
      expect(shownReply(assistant(store.getState()))).toMatchObject({
        text: `${original}again1.`,
        rawText: raw + suffix,
        status: "complete",
        generated: true,
      });
      expect(store.getState().macroState).toEqual(state({ mood: "calm", n: "1" }));
    },
  );

  it("keeps a real suffix matching the reply start and preserves generated raw text", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("hello");
    const raw = "{{setvar::mood::calm}}She waits ";
    const sending = store.getState().send();
    await tick();
    reply.push(raw);
    reply.finish();
    await sending;
    const continuing = store.getState().continueReply();
    await tick();
    reply.push({ text: "She waitsShe", prompt: continuedPrompt() });
    await tick();
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "She waits She",
      rawText: `${raw}She`,
      status: "streaming",
    });
    reply.finish();
    await continuing;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "She waits She",
      rawText: `${raw}She`,
      generated: true,
      status: "complete",
    });
    expect(store.getState().macroState).toEqual(state({ mood: "calm" }));
  });

  it("continues an edited reply: its text stays as written, only what the model adds is filled, then and in later requests", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.push("Hi");
    reply.finish();
    await sending;
    const id = assistant(store.getState()).id;
    const literal = "{{setvar::x::5}}Edited";
    store.getState().edit(id, literal);
    const continuing = store.getState().continueReply();
    await tick();
    expect(reply.calls[1]?.request.messages[1]).toEqual({ role: "assistant", content: literal });
    reply.push({ text: "{{incvar::n}} more", prompt: continuedPrompt() });
    reply.finish();
    await continuing;
    // The edited text and the join after it stay as written.
    const prefix = `${literal} `.length;
    const once = `${literal} {{incvar::n}} more`;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: `${literal} 1 more`,
      rawText: once,
      generated: true,
      macroPrefixLength: prefix,
    });
    expect(store.getState().macroState).toEqual(state({ n: "1" }));

    // Continued again: the raw text grows, the literal start stays.
    const again = store.getState().continueReply();
    await tick();
    expect(reply.calls[2]?.request.messages[1]).toEqual({
      role: "assistant",
      content: once,
      macroEligible: true,
      scanText: `${literal} 1 more`,
      macroPrefixLength: prefix,
    });
    reply.push({ text: "{{incvar::n}}!", prompt: continuedPrompt() });
    reply.finish();
    await again;
    const twice = `${once} {{incvar::n}}!`;
    const continued = shownReply(assistant(store.getState()));
    expect(continued).toMatchObject({
      text: `${literal} 1 more 2!`,
      rawText: twice,
      generated: true,
      macroPrefixLength: prefix,
    });
    expect(store.getState().macroState).toEqual(state({ n: "2" }));

    // A failed Continue leaves it exactly as it was.
    const failing = store.getState().continueReply();
    await tick();
    reply.push({ text: "{{incvar::n}} lost", prompt: continuedPrompt() });
    reply.finish(new Error("upstream"));
    await failing;
    expect(shownReply(assistant(store.getState()))).toEqual({ ...continued, failed: "continue" });
    expect(store.getState().macroState).toEqual(state({ n: "2" }));

    // The next request sends the literal start and the model's text to fill again.
    store.getState().setDraft("next");
    const next = store.getState().send();
    await tick();
    expect(reply.calls.at(-1)?.request.messages[1]).toEqual({
      role: "assistant",
      content: twice,
      macroEligible: true,
      scanText: `${literal} 1 more 2!`,
      macroPrefixLength: prefix,
    });
    reply.finish();
    await next;

    // Edited again, it is the user's text once more: sent as written.
    store.getState().edit(id, "Plain {{char}}");
    const edited = store.getState().messages[1];
    if (edited?.role !== "assistant") throw new Error("no reply");
    expect(shownReply(edited)).not.toHaveProperty("generated");
    expect(shownReply(edited)).not.toHaveProperty("rawText");
    expect(shownReply(edited)).not.toHaveProperty("macroPrefixLength");
  });

  it("a Continue of an edited reply that fails, stops or waits for a sign-in leaves it literal; resumed, it adds", async () => {
    const session = { signedIn: true };
    const { store, reply } = macroStore(async () => loaded(), session);
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.push("Hi");
    reply.finish();
    await sending;
    const literal = "Edited {{char}}";
    store.getState().edit(assistant(store.getState()).id, literal);
    const edited = shownReply(assistant(store.getState()));

    const failing = store.getState().continueReply();
    await tick();
    reply.push({ text: "{{incvar::n}}", prompt: continuedPrompt() });
    reply.finish(new Error("upstream"));
    await failing;
    expect(shownReply(assistant(store.getState()))).toEqual({ ...edited, failed: "continue" });

    const stopping = store.getState().continueReply();
    await tick();
    store.getState().stop();
    reply.finish();
    await stopping;
    expect(shownReply(assistant(store.getState()))).toEqual({ ...edited, status: "stopped" });

    const waiting = store.getState().continueReply();
    await tick();
    session.signedIn = false;
    reply.finish(Object.assign(new Error("signed out"), { reason: "signed_out" }));
    await waiting;
    expect(shownReply(assistant(store.getState()))).toEqual({ ...edited, status: "stopped" });
    expect(store.getState().macroState).toEqual(state({}));

    session.signedIn = true;
    const resumed = store.getState().resume();
    await tick();
    expect(reply.calls.at(-1)?.request.messages[1]).toEqual({
      role: "assistant",
      content: literal,
    });
    reply.push({ text: "{{incvar::n}}", prompt: continuedPrompt() });
    reply.finish();
    await resumed;
    await tick();
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: `${literal} 1`,
      rawText: `${literal} {{incvar::n}}`,
      generated: true,
      macroPrefixLength: `${literal} `.length,
      status: "complete",
    });
    expect(store.getState().macroState).toEqual(state({ n: "1" }));
  });

  it("keeps a reply whose macros go past their limits as the model wrote it, literal from then on, with none of its effects", async () => {
    const { store, reply } = macroStore();
    const overflowing = [
      // A variable past its size limit, after one that would have been set.
      `{{setvar::kept::1}}{{setvar::big::${"x".repeat(70_000)}}}Too much`,
      // Output past its limit.
      `{{setvar::big::${"x".repeat(60_000)}}}${"{{getvar::big}}".repeat(20)}`,
    ];
    for (const [index, raw] of overflowing.entries()) {
      store.getState().setDraft(`turn ${index}`);
      const sending = store.getState().send();
      await tick();
      reply.push(raw);
      reply.finish();
      await sending;
      const shown = shownReply(assistant(store.getState()));
      expect(shown).toMatchObject({ text: raw, status: "complete" });
      expect(shown).not.toHaveProperty("generated");
      expect(shown).not.toHaveProperty("rawText");
      expect(store.getState().macroNotice).toBe("output");
      expect(store.getState().macroState).toEqual(state({}));
    }
    // The next generation goes, each of them sent as shown, never filled again.
    store.getState().setDraft("next");
    const next = store.getState().send();
    await tick();
    expect(store.getState().macroNotice).toBeNull();
    expect(
      reply.calls.at(-1)?.request.messages.filter((turn) => turn.role === "assistant"),
    ).toEqual(overflowing.map((content) => ({ role: "assistant", content })));
    // A setter that shows nothing is still the model's: filled, and sent again as written.
    reply.push("{{setvar::ok::1}}");
    reply.finish();
    await next;
    expect(shownReply(assistant(store.getState()))).toMatchObject({
      text: "",
      rawText: "{{setvar::ok::1}}",
      generated: true,
    });
    expect(store.getState().macroState).toEqual(state({ ok: "1" }));
  });

  it("a continuation whose macros go past their limits keeps the reply as shown, literal, and the next generation goes", async () => {
    const { store, reply } = macroStore();
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.push("{{setvar::a::1}}She waits");
    reply.finish();
    await sending;
    const continuing = store.getState().continueReply();
    await tick();
    const added = `{{setvar::b::1}}{{setvar::big::${"x".repeat(70_000)}}}and waits`;
    reply.push({ text: added, prompt: continuedPrompt() });
    reply.finish();
    await continuing;
    const shown = shownReply(assistant(store.getState()));
    expect(shown).toMatchObject({ text: `She waits ${added}`, status: "complete" });
    expect(shown).not.toHaveProperty("generated");
    expect(shown).not.toHaveProperty("rawText");
    expect(shown).not.toHaveProperty("macroPrefixLength");
    expect(store.getState().macroNotice).toBe("output");
    expect(store.getState().macroState).toEqual(state({ a: "1" }));

    store.getState().setDraft("next");
    const next = store.getState().send();
    await tick();
    expect(reply.calls.at(-1)?.request.messages[1]).toEqual({
      role: "assistant",
      content: `She waits ${added}`,
    });
    reply.push("Onward.");
    reply.finish();
    await next;
    expect(last(store.getState())).toMatchObject({ text: "Onward.", status: "complete" });
  });

  it("says a greeting did not load only while the chat waits for one; a fill, Clear or a reply ends it", async () => {
    const { store, reply } = macroStore();
    store.getState().setGreetingFailed(true);
    expect(store.getState().greetingFailed).toBe(true);
    store.getState().setGreetings(["One."]);
    expect(store.getState().greetingFailed).toBe(false);
    // An untouched greeting still waits for its refill.
    store.getState().setGreetingFailed(true);
    expect(store.getState().greetingFailed).toBe(true);
    store.getState().clear();
    expect(store.getState().greetingFailed).toBe(false);
    store.getState().setDraft("hello");
    const sending = store.getState().send();
    await tick();
    reply.finish();
    await sending;
    store.getState().setGreetingFailed(true);
    expect(store.getState().greetingFailed).toBe(false);
  });
});

describe("memory", () => {
  const CHARACTER = "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b";
  const E1 = "6b2f3c4d-5e6f-4a71-8b2c-3d4e5f6a7b8c";
  const E2 = "7c3a4d5e-6f7a-4b82-9c3d-4e5f6a7b8c9d";
  const B = "8e1c3d2f-5a4b-4c6d-9e7f-1b2c3d4e5f60";
  /** 25 estimated tokens: four turns of it reach a span of 100, two do not. */
  const turn = (letter: string) => letter.repeat(100);

  const answered = (id: string, recap: string[], turns = 4): RememberOutcome => {
    const response: RememberResponse = {
      episode: {
        id,
        characterId: CHARACTER,
        seq: 0,
        kind: "episode",
        title: `Memory ${id.slice(0, 2)}`,
        summary: "What happened.",
        cues: [],
        pinned: false,
        turns,
        chapterId: null,
        revision: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      notebook: {
        enabled: true,
        notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
        opening: "> Location: The quay, dusk\n\nMira waits by the boats.",
        revision: 1,
        updatedAt: 0,
      },
      recap,
    };
    return { ok: true, response };
  };

  /** Loads the macros' subject at once, or, between `hold` and `release`, waits. */
  function subjectLoader() {
    let gate: Promise<void> | null = null;
    let open = () => {};
    return {
      load: async (): Promise<SubjectResult> => {
        await gate;
        return {
          ok: true,
          subject: {
            character: null,
            persona: null,
            preset: defaultPromptPreset(),
            prefer: { preferCharacterPrompt: true, preferCharacterInstructions: true },
          },
        };
      },
      hold: () => {
        gate = new Promise((resolve) => {
          open = () => resolve();
        });
      },
      release: () => {
        gate = null;
        open();
      },
    };
  }

  /**
   * A chat with a character whose memory is on: span 100 tokens, the newest
   * `keepTurns` messages kept (two by default), on `model`, its actions
   * loading `subject` when given.
   */
  function memoryChat({
    keepTurns = 2,
    model = "model-a",
    subject,
  }: {
    keepTurns?: number;
    model?: string | null;
    subject?: () => Promise<SubjectResult>;
  } = {}) {
    const reply = controlledReply();
    const preview = controlledPreview();
    const calls: {
      request: RememberRequest;
      signal: AbortSignal;
      receive?: (accounting: CallAccounting) => void;
      answer: (outcome: RememberOutcome) => void;
    }[] = [];
    const forgets: { id: string; answer: (forgot: boolean) => void }[] = [];
    const changed: string[] = [];
    /** The notebook row each change brought, when a memory landed. */
    const notebooks: (MemoryState | undefined)[] = [];
    const memory = { enabled: true };
    const session = { signedIn: true, resumable: true };
    const store = createChatStore(
      reply.streamReply,
      () => selectionOf({ characterId: CHARACTER, model }),
      {
        clock: () => CLOCK,
        pickSeed: () => SEED,
        cacheKey: () => cacheKeyOf(0),
        now: () => now,
        fetchPreview: preview.fetchPreview,
        signedIn: () => session.signedIn,
        resumable: () => session.resumable,
        ...(subject === undefined ? {} : { subject }),
        memory: {
          enabled: (id) => id === CHARACTER && memory.enabled,
          settings: () => ({ spanTokens: 100, keepTurns, memoryModel: null, reasoning: null }),
          remember: (request, signal, receive) =>
            new Promise((resolve) =>
              calls.push({
                request,
                signal,
                answer: resolve,
                ...(receive === undefined ? {} : { receive }),
              }),
            ),
          forget: (id) => new Promise((resolve) => forgets.push({ id, answer: resolve })),
          changed: (id, notebook) => {
            changed.push(id);
            notebooks.push(notebook);
          },
        },
      },
    );
    /** One exchange: the user's message and a reply that completes (or fails). */
    const exchange = async (user: string, answer: string | Error) => {
      store.getState().setDraft(user);
      const sending = store.getState().send();
      // A send loading its subject streams once it loaded.
      if (subject !== undefined) await tick();
      if (answer instanceof Error) {
        reply.finish(answer);
      } else {
        reply.push(answer);
        reply.finish();
      }
      await sending;
    };
    return {
      store,
      reply,
      preview,
      calls,
      forgets,
      changed,
      notebooks,
      memory,
      session,
      exchange,
    };
  }

  /** Three exchanges: the first four messages are a full span, the last two kept out. */
  async function grown() {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    await chat.exchange(turn("e"), turn("f"));
    return chat;
  }

  /** Remembers the first span with the episode `id`: held, its turns still sent. */
  async function held(id = E1) {
    const chat = await grown();
    chat.calls[0]?.answer(answered(id, []));
    await tick();
    return chat;
  }

  /** Two held spans: E1 over the first four messages, E2 over the next four. */
  async function twoHeld() {
    const chat = await held(E1);
    await chat.exchange(turn("g"), turn("h"));
    await chat.exchange(turn("i"), turn("j"));
    chat.calls[1]?.answer(answered(E2, []));
    await tick();
    return chat;
  }

  /**
   * One exchange whose prompt reports `fold` and carries `states`, as the
   * server answers once the history no longer fits.
   */
  async function foldingExchange(
    chat: ReturnType<typeof memoryChat>,
    user: string,
    fold: { spans: number; turns: number },
    states: { lorebookState?: LorebookState; eventsState?: EventsState } = {},
    before?: () => void,
  ) {
    chat.store.getState().setDraft(user);
    const sending = chat.store.getState().send();
    before?.();
    chat.reply.push({
      text: "reply",
      prompt: { ...inspected(user), memoryFold: fold, lorebookState: null, ...states },
    });
    chat.reply.finish();
    await sending;
  }

  it("keeps memory and chapter receipts with the triggering generation after another reply", async () => {
    const chat = await grown();
    const generation = chat.store
      .getState()
      .usage.running.find((call) => call.purpose === "memory.remember")?.generation;
    expect(generation).toBeTruthy();
    await chat.exchange(turn("g"), turn("h"));
    const calls: CallAccounting["calls"] = ["memory.remember", "memory.chapter"].map((purpose) => ({
      id: crypto.randomUUID(),
      purpose: purpose as "memory.remember" | "memory.chapter",
      model: "model-a",
      status: "completed",
      usage: { inputTokens: 50 },
    }));
    chat.calls[0]?.receive?.({ calls, truncated: false });
    chat.calls[0]?.answer(answered(E1, []));
    await tick();
    expect(
      chat.store
        .getState()
        .usage.calls.filter((call) => calls.some((record) => record.id === call.record.id))
        .map((call) => call.generation),
    ).toEqual([generation, generation]);
    expect(generation).not.toBe(
      chat.store.getState().usage.calls.findLast((call) => call.purpose === "narration")
        ?.generation,
    );
  });

  it("remembers once the unremembered turns reach the span, not before", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    // Two turns of 25 tokens are below the span; the newest two messages are kept out.
    expect(chat.calls).toHaveLength(0);
    await chat.exchange(turn("e"), turn("f"));
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.request).toEqual({
      characterId: CHARACTER,
      model: "model-a",
      turns: ["a", "b", "c", "d"].map((letter, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: turn(letter),
      })),
      episodes: [],
      held: [],
      attempt: expect.any(String),
    });
    expect(chat.store.getState().memory).toMatchObject({ status: "remembering", boundary: 4 });
  });

  it("Remember now takes a span below the size, but never fewer than two turns", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.store.getState().rememberNow();
    // Both messages are the newest two: nothing is left to remember.
    expect(chat.calls).toHaveLength(0);
    await chat.exchange(turn("c"), turn("d"));
    void chat.store.getState().rememberNow();
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual([
      turn("a"),
      turn("b"),
    ]);
  });

  it.each([false, true])(
    "sends only cast context from a snapshot at/before the memory boundary, available=%s",
    async (available) => {
      const chat = memoryChat();
      await chat.exchange("First", "First reply");
      await chat.exchange("Second", "Second reply");
      const replies = chat.store
        .getState()
        .messages.flatMap((message) =>
          message.role === "assistant" ? [shownReply(message).id] : [],
        );
      const castEntry = {
        id: E1,
        role: "minor" as const,
        aka: ["Old Noor"],
        anchor: { ...emptyCastAnchor("Noor", "female"), hair: "long black hair" },
        state: emptyCastState(true),
      };
      chat.store.setState((state) => ({
        cast: {
          ...state.cast,
          snapshots: {
            ...(available
              ? { [replies[0] ?? ""]: { register: { entries: [castEntry] }, usage: null, at: 1 } }
              : {}),
            [replies[1] ?? ""]: {
              register: {
                entries: [
                  {
                    ...castEntry,
                    developments: { hair: "future-silver-canary" },
                    continuity: { voice: "future-voice-canary" },
                  },
                ],
              },
              usage: null,
              at: 2,
            },
          },
          corrections: { [E1]: { anchor: { age: "44" }, state: {} } },
        },
      }));
      void chat.store.getState().rememberNow();
      const request = chat.calls[0]?.request;
      expect(chat.calls).toHaveLength(1);
      if (available) {
        expect(request?.castContext).toEqual([
          { anchor: { name: "Noor", gender: "female", age: "44", hair: "long black hair" } },
        ]);
      } else expect(request?.castContext).toBeUndefined();
      expect(JSON.stringify(request?.castContext ?? [])).not.toContain("future-");
      chat.calls[0]?.answer(answered(E1, []));
      await tick();
    },
  );

  it("runs one call at a time", async () => {
    const chat = await grown();
    void chat.store.getState().rememberNow();
    await chat.exchange(turn("g"), turn("h"));
    expect(chat.calls).toHaveLength(1);
  });

  it("remembers the ending with the newest turns, whatever its size", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    // Below the span, and the newest two would be kept out of an ordinary call.
    expect(chat.calls).toHaveLength(0);
    const ending = chat.store.getState().rememberEnding();
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual(
      ["a", "b", "c", "d"].map(turn),
    );
    chat.calls[0]?.answer(answered(E1, []));
    expect(await ending).toEqual({ status: "done" });
    expect(chat.store.getState().memory.held).toMatchObject([{ id: E1, from: 0, to: 4 }]);
    // Nothing is left to remember: a second ending sends nothing.
    expect(await chat.store.getState().rememberEnding()).toEqual({ status: "done" });
    expect(chat.calls).toHaveLength(1);
  });

  it("waits for a memory call already running, then remembers the rest of the ending", async () => {
    const chat = await grown();
    expect(chat.calls).toHaveLength(1);
    const ending = chat.store.getState().rememberEnding();
    await tick();
    // The running call answers first; nothing else goes out meanwhile.
    expect(chat.calls).toHaveLength(1);
    chat.calls[0]?.answer(answered(E1, []));
    await tick();
    expect(chat.calls).toHaveLength(2);
    expect(chat.calls[1]?.request).toMatchObject({ episodes: [], held: [E1] });
    expect(chat.calls[1]?.request.turns.map((sent) => sent.content)).toEqual([
      turn("e"),
      turn("f"),
    ]);
    chat.calls[1]?.answer(answered(E2, [], 2));
    expect(await ending).toEqual({ status: "done" });
    expect(chat.store.getState().memory.held).toMatchObject([
      { id: E1, from: 0, to: 4 },
      { id: E2, from: 4, to: 6 },
    ]);
  });

  it("keeps the chat as it was when the ending is not written, and tries again", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    const messages = chat.store.getState().messages;
    const ending = chat.store.getState().rememberEnding();
    chat.calls[0]?.answer({ ok: false, reason: "memory_failed", lost: false });
    expect(await ending).toEqual({ status: "failed", reason: "memory_failed" });
    expect(chat.store.getState().messages).toBe(messages);
    expect(chat.store.getState().memory).toMatchObject({ held: [], horizon: 0, status: "failed" });

    const again = chat.store.getState().rememberEnding();
    expect(chat.calls).toHaveLength(2);
    expect(chat.calls[1]?.request.turns).toHaveLength(4);
    chat.calls[1]?.answer(answered(E1, []));
    expect(await again).toEqual({ status: "done" });
    expect(chat.store.getState().memory).toMatchObject({ status: "idle", held: [{ id: E1 }] });
  });

  it("lets a reply streaming at the ending settle, then remembers it whole", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    chat.store.getState().setDraft(turn("c"));
    const sending = chat.store.getState().send();
    chat.reply.push("The tide ");
    await tick();
    const ending = chat.store.getState().rememberEnding();
    await tick();
    expect(chat.calls).toHaveLength(0);
    // Each update carries the reply so far.
    chat.reply.push("The tide turned.");
    chat.reply.finish();
    await sending;
    await tick();
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.request.turns.at(-1)?.content).toBe("The tide turned.");
    chat.calls[0]?.answer(answered(E1, [], 4));
    expect(await ending).toEqual({ status: "done" });
  });

  it("waits for a Forget under way, then remembers the turns it freed", async () => {
    const chat = await held(E1);
    void chat.store.getState().forgetLatest();
    const ending = chat.store.getState().rememberEnding();
    await tick();
    expect(chat.calls).toHaveLength(1);
    chat.forgets[0]?.answer(true);
    await tick();
    expect(chat.calls[1]?.request.turns).toHaveLength(6);
    chat.calls[1]?.answer(answered(E2, [], 6));
    expect(await ending).toEqual({ status: "done" });
  });

  it("fails the ending without a model to write it", async () => {
    const chat = memoryChat({ model: null });
    await chat.exchange(turn("a"), turn("b"));
    expect(await chat.store.getState().rememberEnding()).toEqual({
      status: "failed",
      reason: "no_model",
    });
    expect(chat.calls).toHaveLength(0);
  });

  it("cancels the ending when the chat is cleared under it", async () => {
    const chat = await grown();
    const ending = chat.store.getState().rememberEnding();
    chat.store.getState().clear();
    expect(chat.calls[0]?.signal.aborted).toBe(true);
    chat.calls[0]?.answer(answered(E1, []));
    expect(await ending).toEqual({ status: "cancelled" });
  });

  it("remembers a single turn left after the call under way", async () => {
    const chat = memoryChat({ keepTurns: 1 });
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    await chat.exchange(turn("e"), turn("f"));
    expect(chat.calls).toHaveLength(1);
    const ending = chat.store.getState().rememberEnding();
    chat.calls[0]?.answer(answered(E1, [], 5));
    await tick();
    expect(chat.calls[1]?.request.turns.map((sent) => sent.content)).toEqual([turn("f")]);
    chat.calls[1]?.answer(answered(E2, [], 1));
    expect(await ending).toEqual({ status: "done" });
    expect(chat.store.getState().memory.held).toMatchObject([{ to: 5 }, { to: 6 }]);
  });

  it("offers to remember an ending of a single unremembered turn", async () => {
    const chat = memoryChat();
    expect(endingToRemember(chat.store.getState())).toBe(false);
    chat.store.getState().setDraft(turn("a"));
    const sending = chat.store.getState().send();
    chat.reply.finish(new Error("upstream"));
    await sending;
    // The failed reply is not a turn: one is left, and that is enough.
    expect(endingToRemember(chat.store.getState())).toBe(true);
  });

  it("keeps a lost ending's turns read-only, newer ones open, and holds the memory over the turns it was written from", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    const ending = chat.store.getState().rememberEnding();
    chat.calls[0]?.answer({ ok: false, reason: "unreachable", lost: true });
    expect(await ending).toEqual({ status: "failed", reason: "unreachable" });
    // Kept chatting: the server may have written the memory, so its turns stay as they were sent.
    expect(lockedBefore(chat.store.getState())).toBe(2);
    const messages = chat.store.getState().messages;
    const [first, reply] = messages;
    if (first === undefined || reply === undefined) throw new Error("no message");
    chat.store.getState().edit(first.id, "changed");
    chat.store.getState().edit(reply.id, "changed");
    chat.store.getState().startEdit(reply.id);
    chat.store.getState().remove(reply.id);
    chat.store.getState().removeFrom(first.id);
    await chat.store.getState().swipe(1);
    await chat.store.getState().regenerate();
    await chat.store.getState().continueReply();
    expect(chat.store.getState().editing).toBeNull();
    expect(chat.store.getState().messages).toBe(messages);
    expect(chat.reply.calls).toHaveLength(1);

    // The composer still sends; the next reply sends the same attempt over the same turns, so a
    // memory the server wrote is answered, not written again.
    await chat.exchange(turn("c"), turn("d"));
    expect(chat.calls).toHaveLength(2);
    expect(chat.calls[1]?.request.attempt).toBe(chat.calls[0]?.request.attempt);
    expect(chat.calls[1]?.request.turns).toEqual(chat.calls[0]?.request.turns);
    // The turns after the span stay open meanwhile.
    const newer = chat.store.getState().messages[2];
    chat.store.getState().edit(newer?.id ?? "", "edited");
    expect(view(chat.store.getState())[2]?.text).toBe("edited");

    chat.calls[1]?.answer(answered(E1, [], 2));
    await tick();
    expect(chat.store.getState().memory).toMatchObject({
      held: [{ id: E1, from: 0, to: 2 }],
      status: "idle",
      pending: null,
    });
    expect(view(chat.store.getState()).map((message) => message.text)).toEqual([
      turn("a"),
      turn("b"),
      "edited",
      turn("d"),
    ]);
  });

  it("opens a lost ending's turns again once a refusal says nothing was written", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    const ending = chat.store.getState().rememberEnding();
    chat.calls[0]?.answer({ ok: false, reason: "unreachable", lost: true });
    await ending;
    const again = chat.store.getState().rememberEnding();
    expect(chat.calls[1]?.request.attempt).toBe(chat.calls[0]?.request.attempt);
    chat.calls[1]?.answer({ ok: false, reason: "memory_failed", lost: false });
    expect(await again).toEqual({ status: "failed", reason: "memory_failed" });
    expect(chat.store.getState().memory).toMatchObject({ status: "failed", pending: null });
    expect(lockedBefore(chat.store.getState())).toBe(0);
    const [first] = chat.store.getState().messages;
    chat.store.getState().edit(first?.id ?? "", "changed");
    expect(view(chat.store.getState())[0]?.text).toBe("changed");
  });

  it("sends a lost one-turn ending again from Remember now", async () => {
    const chat = memoryChat({ keepTurns: 1 });
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    await chat.exchange(turn("e"), turn("f"));
    const ending = chat.store.getState().rememberEnding();
    chat.calls[0]?.answer(answered(E1, [], 5));
    await tick();
    chat.calls[1]?.answer({ ok: false, reason: "unreachable", lost: true });
    expect(await ending).toMatchObject({ status: "failed" });
    void chat.store.getState().rememberNow();
    expect(chat.calls[2]?.request.attempt).toBe(chat.calls[1]?.request.attempt);
    expect(chat.calls[2]?.request.turns.map((sent) => sent.content)).toEqual([turn("f")]);
  });

  /** The actions that write over the newest reply once their subject loaded. */
  const rewrites: [string, (chat: ReturnType<typeof memoryChat>) => Promise<void>][] = [
    ["Regenerate", (chat) => chat.store.getState().regenerate()],
    ["A new alternate", (chat) => chat.store.getState().swipe(1)],
    ["Continue", (chat) => chat.store.getState().continueReply()],
  ];
  const raced = rewrites.flatMap(([action, start]) =>
    (["running", "lost"] as const).map((call) => [action, call, start] as const),
  );

  it.each(raced)(
    "%s loading its subject leaves the reply the ending took as it was sent, its call %s",
    async (_, call, start) => {
      const loader = subjectLoader();
      const chat = memoryChat({ subject: loader.load });
      await chat.exchange(turn("a"), turn("b"));
      const messages = chat.store.getState().messages;
      loader.hold();
      const acting = start(chat);
      // Clear's dialog remembers the ending while the action's subject loads.
      const ending = chat.store.getState().rememberEnding();
      expect(chat.calls).toHaveLength(1);
      expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual([
        turn("a"),
        turn("b"),
      ]);
      expect(lockedBefore(chat.store.getState())).toBe(2);
      if (call === "lost") {
        chat.calls[0]?.answer({ ok: false, reason: "unreachable", lost: true });
        expect(await ending).toEqual({ status: "failed", reason: "unreachable" });
      }

      loader.release();
      await acting;
      // Nothing went out or changed: the same reply, its alternates and text, still locked.
      expect(chat.reply.calls).toHaveLength(1);
      expect(chat.store.getState().generating).toBe(false);
      expect(chat.store.getState().messages).toBe(messages);
      expect(lockedBefore(chat.store.getState())).toBe(2);

      if (call === "running") {
        chat.calls[0]?.answer(answered(E1, [], 2));
        expect(await ending).toEqual({ status: "done" });
        expect(chat.store.getState().memory.held).toMatchObject([{ id: E1, from: 0, to: 2 }]);
      } else {
        // The retry sends the same attempt over the turns as they were sent.
        void chat.store.getState().rememberNow();
        expect(chat.calls).toHaveLength(2);
        expect(chat.calls[1]?.request.attempt).toBe(chat.calls[0]?.request.attempt);
        expect(chat.calls[1]?.request.turns).toEqual(chat.calls[0]?.request.turns);
      }
      expect(view(chat.store.getState()).map((message) => message.text)).toEqual([
        turn("a"),
        turn("b"),
      ]);
    },
  );

  /** What the transport throws when the sign-in redirect answered; the tab is signed out. */
  const signedOut = (chat: ReturnType<typeof memoryChat>) => {
    chat.session.signedIn = false;
    return Object.assign(new Error("Generation failed (signed_out)"), { reason: "signed_out" });
  };

  /** Sends a third turn whose reply is refused as signed out and waits; then signs in again. */
  const refused = async (chat: ReturnType<typeof memoryChat>) => {
    chat.store.getState().setDraft(turn("c"));
    const sending = chat.store.getState().send();
    await tick();
    chat.reply.finish(signedOut(chat));
    await sending;
    expect(last(chat.store.getState())?.status).toBe("waiting");
    chat.session.signedIn = true;
  };

  /** Resumes the waiting reply, which streams `turn("d")` in place. */
  const resumes = async (chat: ReturnType<typeof memoryChat>) => {
    const resumed = chat.store.getState().resume();
    await tick();
    expect(chat.reply.calls).toHaveLength(3);
    expect(chat.reply.calls[2]?.request.messages.at(-1)).toMatchObject({
      role: "user",
      content: turn("c"),
    });
    chat.reply.push(turn("d"));
    expect(await resumed).toBe(true);
    chat.reply.finish();
    await tick();
    expect(chat.store.getState().pending).toBeNull();
    expect(view(chat.store.getState()).map((message) => message.text)).toEqual(
      ["a", "b", "c", "d"].map(turn),
    );
  };

  it("leaves a slot waiting for a sign-in out of the ending, so its reply goes at once and stays open", async () => {
    const chat = memoryChat({ subject: subjectLoader().load });
    await chat.exchange(turn("a"), turn("b"));
    await refused(chat);
    // The blank slot is no turn: the span, for the call and the screen, ends before it.
    expect(spanToRemember(chat.store.getState(), 0)).toEqual({ from: 0, to: 3, again: null });
    const ending = chat.store.getState().rememberEnding();
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual(
      ["a", "b", "c"].map(turn),
    );
    expect(lockedBefore(chat.store.getState())).toBe(3);
    // Nothing of it is locked: the renewal's resume sends it while the call runs.
    await resumes(chat);

    chat.calls[0]?.answer(answered(E1, [], 3));
    await tick();
    expect(chat.store.getState().memory.held).toMatchObject([{ id: E1, from: 0, to: 3 }]);
    // The reply that went is the rest of the ending, remembered next.
    expect(chat.calls[1]?.request.turns.map((sent) => sent.content)).toEqual([turn("d")]);
    chat.calls[1]?.answer(answered(E2, [], 1));
    expect(await ending).toEqual({ status: "done" });
  });

  /**
   * Asks `action` to write over the newest reply, which the sign-in redirect
   * refuses before anything arrives: the reply shows as it was, waiting.
   * Then the session is back.
   */
  const refusedRewrite = async (
    chat: ReturnType<typeof memoryChat>,
    action: (chat: ReturnType<typeof memoryChat>) => Promise<void>,
  ) => {
    const acting = action(chat);
    await tick();
    chat.reply.finish(signedOut(chat));
    await acting;
    expect(chat.store.getState().pending).not.toBeNull();
    chat.session.signedIn = true;
  };

  /** A memory call's answer that says nothing was written. */
  const notWritten: RememberOutcome = { ok: false, reason: "memory_failed", lost: false };

  const heldBack = [
    ["Replace", (chat: ReturnType<typeof memoryChat>) => chat.store.getState().regenerate()],
    ["Continue", (chat: ReturnType<typeof memoryChat>) => chat.store.getState().continueReply()],
  ] as const;
  const lockEnds = ["refused", "reset", "forgotten"] as const;
  const heldUntil = heldBack.flatMap(([name, action]) =>
    lockEnds.map((end) => [name, end, action] as const),
  );

  it.each(heldUntil)(
    "sends a sign-in's %s the ending took on its own, once, when its memory is %s",
    async (name, end, action) => {
      const chat = memoryChat({ subject: subjectLoader().load });
      await chat.exchange(turn("a"), turn("b"));
      await refusedRewrite(chat, action);
      const { pending, messages } = chat.store.getState();
      const ending = chat.store.getState().rememberEnding();
      // The reply shown is a turn: the ending takes it, and locks it.
      expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual([
        turn("a"),
        turn("b"),
      ]);
      expect(lockedBefore(chat.store.getState())).toBe(2);
      if (end === "forgotten") {
        chat.calls[0]?.answer(answered(E1, [], 2));
        expect(await ending).toEqual({ status: "done" });
      }

      // The renewal's resume is refused at once and leaves it waiting, the reply as it was.
      expect(await chat.store.getState().resume()).toBe(false);
      await tick();
      expect(chat.reply.calls).toHaveLength(2);
      expect(chat.store.getState().pending).toBe(pending);
      expect(chat.store.getState().messages).toBe(messages);

      if (end === "refused") {
        chat.calls[0]?.answer(notWritten);
        expect(await ending).toEqual({ status: "failed", reason: "memory_failed" });
      } else if (end === "reset") {
        chat.store.getState().memoryReset();
      } else {
        void chat.store.getState().forgetLatest();
        chat.forgets[0]?.answer(true);
      }
      await tick();
      // Nobody asked again: the lock ending sent it.
      expect(lockedBefore(chat.store.getState())).toBe(0);
      expect(chat.reply.calls).toHaveLength(3);
      expect(chat.reply.calls[2]?.request.generationType).toBe(
        name === "Replace" ? "regenerate" : "continue",
      );
      chat.reply.push("More.");
      chat.reply.finish();
      await tick();
      expect(chat.reply.calls).toHaveLength(3);
      expect(chat.store.getState().pending).toBeNull();
      expect(last(chat.store.getState())?.text).toContain("More.");
      if (end === "reset") {
        // The aborted call's late answer is the old memory's; the ending gave way.
        chat.calls[0]?.answer(answered(E1, [], 2));
        expect(await ending).toEqual({ status: "cancelled" });
      }
    },
  );

  it("keeps it waiting while a lost answer still locks it, and sends it once a retry is refused", async () => {
    const chat = memoryChat({ subject: subjectLoader().load });
    await chat.exchange(turn("a"), turn("b"));
    await refusedRewrite(chat, (current) => current.store.getState().regenerate());
    const ending = chat.store.getState().rememberEnding();
    expect(await chat.store.getState().resume()).toBe(false);
    chat.calls[0]?.answer({ ok: false, reason: "unreachable", lost: true });
    expect(await ending).toEqual({ status: "failed", reason: "unreachable" });
    await tick();
    expect(lockedBefore(chat.store.getState())).toBe(2);
    expect(chat.reply.calls).toHaveLength(2);

    void chat.store.getState().rememberNow();
    expect(chat.calls[1]?.request.attempt).toBe(chat.calls[0]?.request.attempt);
    chat.calls[1]?.answer(notWritten);
    await tick();
    expect(chat.reply.calls).toHaveLength(3);
    expect(chat.reply.calls[2]?.request.generationType).toBe("regenerate");
  });

  it.each(["signed out", "waiting for its saves"] as const)(
    "keeps it waiting when the lock ends while %s, for the renewal to send",
    async (state) => {
      const chat = memoryChat({ subject: subjectLoader().load });
      await chat.exchange(turn("a"), turn("b"));
      await refusedRewrite(chat, (current) => current.store.getState().regenerate());
      const { pending } = chat.store.getState();
      const ending = chat.store.getState().rememberEnding();
      expect(await chat.store.getState().resume()).toBe(false);
      if (state === "signed out") chat.session.signedIn = false;
      else chat.session.resumable = false;
      chat.calls[0]?.answer(notWritten);
      await ending;
      await tick();
      expect(lockedBefore(chat.store.getState())).toBe(0);
      expect(chat.reply.calls).toHaveLength(2);
      expect(chat.store.getState().pending).toBe(pending);

      chat.session.signedIn = true;
      chat.session.resumable = true;
      const resumed = chat.store.getState().resume();
      await tick();
      expect(chat.reply.calls).toHaveLength(3);
      chat.reply.push("More.");
      expect(await resumed).toBe(true);
      chat.reply.finish();
      await tick();
      expect(chat.reply.calls).toHaveLength(3);
    },
  );

  it("sends nothing once the chat is cleared or another generation took its place", async () => {
    const cleared = memoryChat({ subject: subjectLoader().load });
    await cleared.exchange(turn("a"), turn("b"));
    await refusedRewrite(cleared, (current) => current.store.getState().regenerate());
    const ending = cleared.store.getState().rememberEnding();
    expect(await cleared.store.getState().resume()).toBe(false);
    cleared.store.getState().clear();
    cleared.calls[0]?.answer(notWritten);
    expect(await ending).toEqual({ status: "cancelled" });
    await tick();
    expect(cleared.reply.calls).toHaveLength(2);
    expect(cleared.store.getState().pending).toBeNull();

    // Write for me, refused too, is the one waiting now: the Replace the ending held is not sent.
    const replaced = memoryChat({ subject: subjectLoader().load });
    await replaced.exchange(turn("a"), turn("b"));
    await refusedRewrite(replaced, (current) => current.store.getState().regenerate());
    const second = replaced.store.getState().rememberEnding();
    expect(await replaced.store.getState().resume()).toBe(false);
    await refusedRewrite(replaced, (current) => current.store.getState().impersonate());
    const { pending } = replaced.store.getState();
    expect(pending).toEqual({ mode: "impersonate" });
    replaced.calls[0]?.answer(notWritten);
    await second;
    await tick();
    expect(lockedBefore(replaced.store.getState())).toBe(0);
    expect(replaced.reply.calls).toHaveLength(3);
    expect(replaced.store.getState().pending).toBe(pending);
  });

  it("resumes a sign-in's reply past a lost ending's span", async () => {
    const chat = memoryChat({ subject: subjectLoader().load });
    await chat.exchange(turn("a"), turn("b"));
    const ending = chat.store.getState().rememberEnding();
    chat.calls[0]?.answer({ ok: false, reason: "unreachable", lost: true });
    await ending;
    await refused(chat);
    expect(lockedBefore(chat.store.getState())).toBe(2);
    await resumes(chat);
  });

  /** Opens an edit of the message at `index` and types `text` into it, unsaved. */
  const editAt = (chat: ReturnType<typeof memoryChat>, index: number, text: string) => {
    const message = chat.store.getState().messages[index];
    if (message === undefined) throw new Error("no message");
    chat.store.getState().startEdit(message.id);
    chat.store.getState().setEditText(text);
    return message.id;
  };

  it("holds Remember now while an edit in its span is open, then remembers the saved text", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    const id = editAt(chat, 0, turn("z"));
    await chat.store.getState().rememberNow();
    // Nothing went out or locked: the correction stays the edit's.
    expect(chat.calls).toHaveLength(0);
    expect(chat.store.getState().memory).toMatchObject({ status: "idle", pending: null });
    expect(lockedBefore(chat.store.getState())).toBe(0);
    expect(chat.store.getState().editing).toMatchObject({ id, text: turn("z") });

    expect(chat.store.getState().saveEdit()).toBe(true);
    void chat.store.getState().rememberNow();
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual([
      turn("z"),
      turn("b"),
    ]);
  });

  it.each([
    ["saved", "saveEdit", turn("z")],
    ["cancelled", "cancelEdit", turn("a")],
  ] as const)(
    "holds the automatic call while an edit in its span is open, and makes it once the edit is %s",
    async (_, close, first) => {
      const chat = memoryChat();
      await chat.exchange(turn("a"), turn("b"));
      await chat.exchange(turn("c"), turn("d"));
      editAt(chat, 0, turn("z"));
      // Past the span: the call would go now, but the edit holds it.
      await chat.exchange(turn("e"), turn("f"));
      expect(chat.calls).toHaveLength(0);
      expect(chat.store.getState().editing?.text).toBe(turn("z"));

      chat.store.getState()[close]();
      await tick();
      expect(chat.calls).toHaveLength(1);
      expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual([
        first,
        turn("b"),
        turn("c"),
        turn("d"),
      ]);
      chat.calls[0]?.answer(answered(E1, []));
      await tick();
      expect(chat.store.getState().memory.held).toMatchObject([{ id: E1, from: 0, to: 4 }]);
    },
  );

  it("asks again for the automatic call an edit held once its message is deleted", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    const id = editAt(chat, 0, turn("z"));
    await chat.exchange(turn("e"), turn("f"));
    await chat.exchange(turn("g"), turn("h"));
    expect(chat.calls).toHaveLength(0);

    chat.store.getState().remove(id);
    expect(chat.store.getState().editing).toBeNull();
    await tick();
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual(
      ["b", "c", "d", "e", "f"].map(turn),
    );
  });

  it("stays held by another edit opened in its span, and goes once, when one opens past it", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    editAt(chat, 0, turn("z"));
    await chat.exchange(turn("e"), turn("f"));
    // Another edit in the span takes the first one's place, its unsaved text gone: still held.
    const inside = editAt(chat, 1, "Corrected.");
    await tick();
    expect(chat.calls).toHaveLength(0);
    expect(chat.store.getState().editing).toMatchObject({ id: inside, text: "Corrected." });

    // One past it: the call goes over the turns as they are, and the edit stays open.
    const outside = editAt(chat, 4, "Kept open.");
    await tick();
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual(
      ["a", "b", "c", "d"].map(turn),
    );
    expect(chat.store.getState().editing).toMatchObject({ id: outside, text: "Kept open." });
    // Closing it later asks for nothing more.
    chat.store.getState().cancelEdit();
    await tick();
    expect(chat.calls).toHaveLength(1);
  });

  it("leaves the automatic call an edit of the newest reply held to the Replace that ended it, once", async () => {
    const chat = memoryChat({ keepTurns: 0 });
    await chat.exchange(turn("a"), turn("b"));
    chat.store.getState().setDraft(turn("c"));
    const sending = chat.store.getState().send();
    chat.reply.push(turn("d"));
    await tick();
    // An edit of the newest reply open as it settles holds the call over all four turns.
    editAt(chat, 3, "Corrected.");
    chat.reply.finish();
    await sending;
    expect(chat.calls).toHaveLength(0);

    const replacing = chat.store.getState().regenerate();
    await tick();
    // The Replace ended the edit; the reply streaming asks once it settles, not before.
    expect(chat.store.getState().editing).toBeNull();
    expect(chat.calls).toHaveLength(0);
    chat.reply.push(turn("x"));
    chat.reply.finish();
    await replacing;
    await tick();
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual(
      ["a", "b", "c", "x"].map(turn),
    );
  });

  it("is not held by an edit of a newer message, which stays open after the memory lands", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    // The newest two messages are kept out of Remember now's span.
    const id = editAt(chat, 3, "Kept open.");
    void chat.store.getState().rememberNow();
    expect(chat.calls).toHaveLength(1);
    chat.calls[0]?.answer(answered(E1, [], 2));
    await tick();
    expect(chat.store.getState().memory.held).toMatchObject([{ id: E1, from: 0, to: 2 }]);
    expect(chat.store.getState().editing).toMatchObject({ id, text: "Kept open." });
    expect(chat.store.getState().saveEdit()).toBe(true);
    expect(view(chat.store.getState()).at(-1)?.text).toBe("Kept open.");
  });

  it("measures the hold over a lost answer's own span when it goes again", async () => {
    const chat = await grown();
    chat.calls[0]?.answer({ ok: false, reason: "unreachable", lost: true });
    await tick();
    // Past the lost span [0, 4), which the retry sends again whatever the newest are now.
    const id = editAt(chat, 4, "Kept open.");
    expect(spanToRemember(chat.store.getState(), 2)).toMatchObject({ from: 0, to: 4 });
    expect(editHolds(chat.store.getState(), { from: 0, to: 4 })).toBe(false);
    await chat.exchange(turn("g"), turn("h"));
    expect(chat.calls).toHaveLength(2);
    expect(chat.calls[1]?.request.attempt).toBe(chat.calls[0]?.request.attempt);
    expect(chat.store.getState().editing).toMatchObject({ id, text: "Kept open." });
  });

  it("opens no edit in a lost ending's span, so its retry is never held; a newer edit stays open", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    const ending = chat.store.getState().rememberEnding();
    chat.calls[0]?.answer({ ok: false, reason: "unreachable", lost: true });
    await ending;
    editAt(chat, 0, turn("z"));
    expect(chat.store.getState().editing).toBeNull();
    await chat.exchange(turn("c"), turn("d"));
    expect(chat.calls).toHaveLength(2);
    expect(chat.calls[1]?.request.attempt).toBe(chat.calls[0]?.request.attempt);
    expect(chat.calls[1]?.request.turns).toEqual(chat.calls[0]?.request.turns);

    // Lost again, with an edit open past its span: Remember now goes over the same span at once.
    chat.calls[1]?.answer({ ok: false, reason: "unreachable", lost: true });
    await tick();
    const id = editAt(chat, 2, "Kept open.");
    expect(editHolds(chat.store.getState(), spanToRemember(chat.store.getState(), 2))).toBe(false);
    void chat.store.getState().rememberNow();
    expect(chat.calls).toHaveLength(3);
    expect(chat.calls[2]?.request.attempt).toBe(chat.calls[0]?.request.attempt);
    expect(chat.calls[2]?.request.turns).toEqual(chat.calls[0]?.request.turns);
    expect(chat.store.getState().editing).toMatchObject({ id, text: "Kept open." });
  });

  it("holds the ending while an edit among its turns is open: nothing written, the chat as it was", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), turn("b"));
    // The newest reply belongs to the ending, though Remember now would keep it out.
    const id = editAt(chat, 1, "Corrected.");
    const messages = chat.store.getState().messages;
    expect(await chat.store.getState().rememberEnding()).toEqual({ status: "editing" });
    // Asked again, it answers the same at once: no loop, no call.
    expect(await chat.store.getState().rememberEnding()).toEqual({ status: "editing" });
    expect(chat.calls).toHaveLength(0);
    expect(chat.store.getState().messages).toBe(messages);
    expect(chat.store.getState().editing).toMatchObject({ id, text: "Corrected." });
    expect(chat.store.getState().memory).toMatchObject({ status: "idle", pending: null });
    expect(lockedBefore(chat.store.getState())).toBe(0);

    expect(chat.store.getState().saveEdit()).toBe(true);
    const ending = chat.store.getState().rememberEnding();
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual([
      turn("a"),
      "Corrected.",
    ]);
    chat.calls[0]?.answer(answered(E1, [], 2));
    expect(await ending).toEqual({ status: "done" });
  });

  it("brings the notebook row a landed memory left to the memory's change", async () => {
    const chat = await held();
    expect(chat.changed).toEqual([CHARACTER]);
    expect(chat.notebooks).toEqual([
      expect.objectContaining({
        revision: 1,
        opening: "> Location: The quay, dusk\n\nMira waits by the boats.",
      }),
    ]);
  });

  it("tells each request whether the chat opens on the memory's opening", async () => {
    const chat = memoryChat();
    const { store } = chat;
    store.getState().setGreetingChoices(() => [
      { content: "> Location: The quay\n\nMira waits.", key: MEMORY_GREETING },
      { content: "Hello.", key: "card:0" },
    ]);
    const previewed = () => {
      void store.getState().requestPreview();
      return chat.preview.calls.at(-1)?.request.memoryState?.continued;
    };
    expect(previewed()).toBe(true);
    // The card's own greeting is a new scene; the opening again picks up the last.
    await store.getState().swipe(1);
    expect(previewed()).toBe(false);
    await store.getState().swipe(-1);
    expect(previewed()).toBe(true);
    // Edited, it is still the opening.
    const greeting = assistant(store.getState());
    store.getState().edit(greeting.id, "> Location: The quay\n\nMira waits, cold.");
    expect(previewed()).toBe(true);
    await chat.exchange("hello", "reply");
    expect(chat.reply.calls.at(-1)?.request.memoryState?.continued).toBe(true);
    // Deleted, nothing opens the chat.
    store.getState().remove(greeting.id);
    expect(previewed()).toBe(false);
    await chat.exchange("again", "reply");
    expect(chat.reply.calls.at(-1)?.request.memoryState?.continued).toBe(false);
  });

  it("sends a card greeting's chat as a new scene from the first request", async () => {
    const chat = memoryChat();
    chat.store.getState().setGreetings(["Hello."]);
    await chat.exchange("hello", "reply");
    expect(chat.reply.calls[0]?.request.memoryState?.continued).toBe(false);
  });

  it("holds a remembered span in the next request and preview, its turns still sent and read-only", async () => {
    const chat = await held();
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 0,
      held: [{ id: E1, title: "Memory 6b", from: 0, to: 4 }],
      boundary: null,
      recap: [],
      foldedLatest: null,
      status: "idle",
      pending: null,
    });
    expect(chat.changed).toEqual([CHARACTER]);
    const [first] = chat.store.getState().messages;
    chat.store.getState().edit(first?.id ?? "", "changed");
    chat.store.getState().startEdit(first?.id ?? "");
    expect(chat.store.getState().messages[0]).toEqual(first);
    expect(chat.store.getState().editing).toBeNull();

    void chat.store.getState().requestPreview();
    const previewed = chat.preview.calls.at(-1)?.request;
    expect(previewed?.memoryState).toEqual({
      recap: [],
      folded: 0,
      foldedUsers: 0,
      held: [{ id: E1, turns: 4 }],
      continued: false,
    });
    expect(previewed?.messages.map((sent) => sent.content)).toEqual(
      ["a", "b", "c", "d", "e", "f"].map(turn),
    );

    await chat.exchange("next", "reply");
    const sent = chat.reply.calls.at(-1)?.request;
    expect(sent?.memoryState).toEqual({
      recap: [],
      folded: 0,
      foldedUsers: 0,
      held: [{ id: E1, turns: 4 }],
      continued: false,
    });
    expect(sent?.messages).toHaveLength(7);
    // The next span starts where the held one ends.
    void chat.store.getState().rememberNow();
    expect(chat.calls[1]?.request).toMatchObject({ episodes: [], held: [E1] });
    expect(chat.calls[1]?.request.turns.map((turn) => turn.content)).toEqual([
      turn("e"),
      turn("f"),
    ]);
  });

  it("holds up to the span's last message, a failed reply inside it included, counting the turns sent", async () => {
    const chat = memoryChat();
    await chat.exchange(turn("a"), new Error("upstream"));
    await chat.exchange(turn("c"), turn("d"));
    await chat.exchange(turn("e"), turn("f"));
    void chat.store.getState().rememberNow();
    // Four messages, three turns: the failed reply is not sent.
    expect(chat.calls[0]?.request.turns.map((sent) => sent.content)).toEqual([
      turn("a"),
      turn("c"),
      turn("d"),
    ]);
    chat.calls[0]?.answer(answered(E1, [], 3));
    await tick();
    expect(chat.store.getState().memory.held).toMatchObject([{ id: E1, from: 0, to: 4 }]);
    await chat.exchange("next", "reply");
    const sent = chat.reply.calls.at(-1)?.request;
    expect(sent?.memoryState?.held).toEqual([{ id: E1, turns: 3 }]);
    expect(sent?.messages.map((message) => message.content)).toEqual([
      turn("a"),
      turn("c"),
      turn("d"),
      turn("e"),
      turn("f"),
      "next",
    ]);
  });

  it("keeps the span read-only while it is remembered, and held after", async () => {
    const chat = await grown();
    const [first] = chat.store.getState().messages;
    if (first === undefined) throw new Error("no message");
    chat.store.getState().edit(first.id, "changed");
    chat.store.getState().remove(first.id);
    chat.store.getState().startEdit(first.id);
    expect(chat.store.getState().messages[0]).toEqual(first);
    expect(chat.store.getState().editing).toBeNull();

    // The newest messages stay editable meanwhile.
    const newest = chat.store.getState().messages.at(-2);
    chat.store.getState().edit(newest?.id ?? "", "edited");
    expect(view(chat.store.getState()).at(-2)?.text).toBe("edited");

    chat.calls[0]?.answer(answered(E1, []));
    await tick();
    chat.store.getState().edit(first.id, "changed");
    expect(chat.store.getState().messages[0]).toEqual(first);
  });

  it("keeps the span read-only after a lost answer, so the retry sends the same turns", async () => {
    const chat = await grown();
    const first = chat.calls[0];
    first?.answer({ ok: false, reason: "unreachable", lost: true });
    await tick();
    const [message] = chat.store.getState().messages;
    if (message === undefined) throw new Error("no message");
    chat.store.getState().edit(message.id, "changed");
    chat.store.getState().remove(message.id);
    expect(chat.store.getState().messages[0]).toEqual(message);

    void chat.store.getState().rememberNow();
    const again = chat.calls[1];
    expect(again?.request.attempt).toBe(first?.request.attempt);
    expect(again?.request.turns).toEqual(first?.request.turns);
    // A refusal drops the attempt: the span is live again.
    again?.answer({ ok: false, reason: "memory_failed", lost: false });
    await tick();
    chat.store.getState().edit(message.id, "changed");
    expect(view(chat.store.getState())[0]?.text).toBe("changed");
  });

  it("asks again with the same attempt and span after a lost answer, a new attempt after a refusal", async () => {
    const chat = await grown();
    const first = chat.calls[0];
    first?.answer({ ok: false, reason: "unreachable", lost: true });
    await tick();
    expect(chat.store.getState().memory).toMatchObject({
      status: "failed",
      boundary: 4,
      pending: { attempt: first?.request.attempt, boundary: 4, from: 0 },
    });

    // A message sent meanwhile does not move the span.
    await chat.exchange(turn("g"), turn("h"));
    const again = chat.calls[1];
    expect(again?.request.attempt).toBe(first?.request.attempt);
    expect(again?.request.turns).toEqual(first?.request.turns);

    again?.answer({ ok: false, reason: "memory_failed", lost: false });
    await tick();
    expect(chat.store.getState().memory).toMatchObject({
      status: "failed",
      failure: "memory_failed",
      pending: null,
    });
    // An upstream failure is tried again with the next reply, under a new attempt, over the grown span.
    await chat.exchange(turn("i"), turn("j"));
    const third = chat.calls[2];
    expect(third?.request.attempt).not.toBe(first?.request.attempt);
    expect(third?.request.turns.length).toBeGreaterThan(first?.request.turns.length ?? 0);

    third?.answer({ ok: false, reason: "prompt_too_long", lost: false });
    await tick();
    // A refusal another call would repeat waits for Try again.
    await chat.exchange(turn("k"), turn("l"));
    expect(chat.calls).toHaveLength(3);
    void chat.store.getState().rememberNow();
    expect(chat.calls).toHaveLength(4);
  });

  it("asks again with the next reply after a memory_off refusal while memory still reads on", async () => {
    const chat = await grown();
    // Forget, or off and on again, in another tab moved memory under the call before it wrote
    // anything (a memory written is the answer): nothing folds, and the span is asked for again.
    chat.calls[0]?.answer({ ok: false, reason: "memory_off", lost: false });
    await tick();
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 0,
      status: "failed",
      failure: "memory_off",
      pending: null,
    });
    expect(chat.changed).toEqual([CHARACTER]);
    await chat.exchange(turn("g"), turn("h"));
    expect(chat.calls).toHaveLength(2);
    expect(chat.calls[1]?.request.attempt).not.toBe(chat.calls[0]?.request.attempt);

    // Memory that really is off reloads as off: nothing more goes out.
    chat.calls[1]?.answer({ ok: false, reason: "memory_off", lost: false });
    await tick();
    chat.memory.enabled = false;
    await chat.exchange(turn("i"), turn("j"));
    expect(chat.calls).toHaveLength(2);
  });

  it("draws a new attempt over the unremembered span once the memory before a lost answer is gone", async () => {
    const chat = await held(E1);
    await chat.exchange(turn("g"), turn("h"));
    await chat.exchange(turn("i"), turn("j"));
    const lost = chat.calls[1];
    expect(lost?.request.turns[0]?.content).toBe(turn("e"));
    lost?.answer({ ok: false, reason: "unreachable", lost: true });
    await tick();
    expect(chat.store.getState().memory.pending).toMatchObject({ boundary: 8, from: 4 });

    // The latest memory leaves (another tab deleted it): its turns are no longer remembered,
    // and the lost attempt goes.
    chat.store.getState().episodeGone(E1);
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 0,
      status: "idle",
      boundary: null,
      pending: null,
    });

    await chat.exchange(turn("k"), turn("l"));
    const fresh = chat.calls[2];
    expect(fresh?.request.attempt).not.toBe(lost?.request.attempt);
    expect(fresh?.request.turns.map((sent) => sent.content)).toEqual(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(turn),
    );
    expect(chat.store.getState().memory.pending).toMatchObject({ boundary: 10, from: 0 });
  });

  it("Clear aborts the call and drops its late answer", async () => {
    const chat = await grown();
    chat.store.getState().clear();
    expect(chat.calls[0]?.signal.aborted).toBe(true);
    chat.calls[0]?.answer(answered(E1, []));
    await tick();
    expect(chat.store.getState().memory).toEqual(NO_MEMORY);
    expect(chat.store.getState().messages).toEqual([]);
  });

  it("Forget frees the latest held span, then unfolds the latest folded one", async () => {
    const chat = await twoHeld();
    expect(chat.store.getState().memory.held).toMatchObject([
      { id: E1, from: 0, to: 4 },
      { id: E2, from: 4, to: 8 },
    ]);
    // The first span folds in a request; the second stays held.
    await foldingExchange(chat, "next", { spans: 1, turns: 4 });
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 4,
      recap: [E1],
      foldedLatest: { id: E1, from: 0 },
    });

    // Forget the held latest: its turns are still sent, no longer remembered.
    let forgetting = chat.store.getState().forgetLatest();
    expect(chat.forgets.map((forget) => forget.id)).toEqual([E2]);
    chat.forgets[0]?.answer(true);
    await forgetting;
    expect(chat.store.getState().memory).toMatchObject({ horizon: 4, held: [], recap: [E1] });

    // Then the folded latest: its turns unfold.
    forgetting = chat.store.getState().forgetLatest();
    expect(chat.forgets.at(-1)?.id).toBe(E1);
    chat.forgets.at(-1)?.answer(true);
    await forgetting;
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 0,
      held: [],
      recap: [],
      foldedLatest: null,
    });
    void chat.store.getState().requestPreview();
    expect(chat.preview.calls.at(-1)?.request.messages).toHaveLength(12);
  });

  it("merges a held memory deleted elsewhere into the next held span", async () => {
    const chat = await twoHeld();
    chat.store.getState().episodeGone(E1);
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 0,
      held: [{ id: E2, from: 0, to: 8 }],
      recap: [],
    });
    void chat.store.getState().requestPreview();
    expect(chat.preview.calls.at(-1)?.request.memoryState?.held).toEqual([{ id: E2, turns: 8 }]);
  });

  it("Forget changes nothing once the chat or the latest memory moved on", async () => {
    const chat = await held(E1);
    const forgetting = chat.store.getState().forgetLatest();
    chat.store.getState().clear();
    await chat.exchange(turn("a"), turn("b"));
    await chat.exchange(turn("c"), turn("d"));
    await chat.exchange(turn("e"), turn("f"));
    chat.calls[1]?.answer(answered(E2, []));
    await tick();
    chat.forgets[0]?.answer(true);
    await forgetting;
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 0,
      held: [{ id: E2, from: 0, to: 4 }],
    });
  });

  it("unfolds, drops what it holds and stops sending the recap once memory is off", async () => {
    const chat = await held();
    await foldingExchange(chat, "next", { spans: 1, turns: 4 });
    expect(chat.store.getState().memory.horizon).toBe(4);
    chat.memory.enabled = false;
    chat.store.getState().memoryReset();
    expect(chat.store.getState().memory).toEqual(NO_MEMORY);
    await chat.exchange("again", "reply");
    const sent = chat.reply.calls.at(-1)?.request;
    expect(sent).not.toHaveProperty("memoryState");
    expect(sent?.messages).toHaveLength(9);
  });

  it("applies a send's fold: the horizon to the span's end, its memory to the recap, the states as returned", async () => {
    const chat = await held(E1);
    const lorebookState: LorebookState = {
      characterId: CHARACTER,
      effects: [{ index: 1, digest: "bb", start: 1 }],
    };
    const eventsState: EventsState = { characterId: CHARACTER, fired: [{ id: B, start: 1 }] };
    await foldingExchange(chat, "next", { spans: 1, turns: 4 }, { lorebookState, eventsState });
    const state = chat.store.getState();
    expect(state.memory).toMatchObject({
      horizon: 4,
      held: [],
      recap: [E1],
      foldedLatest: { id: E1, title: "Memory 6b", from: 0 },
    });
    // The prompt's states are relative to the history it kept, which is the tab's now.
    expect(state.lorebookState).toEqual(lorebookState);
    expect(state.eventsState).toEqual(eventsState);
    expect(state.lastSent).toMatchObject({ foldedTurns: 0, speakers: [null, null, null] });
    expect(promptFoldedTurns(state)).toBe(0);

    await chat.exchange("again", "reply");
    const sent = chat.reply.calls.at(-1)?.request;
    expect(sent?.memoryState).toEqual({
      recap: [E1],
      folded: 4,
      foldedUsers: 2,
      held: [],
      continued: false,
    });
    expect(sent?.messages.map((message) => message.content)).toEqual([
      turn("e"),
      turn("f"),
      "next",
      "reply",
      "again",
    ]);
  });

  it("applies no fold after a Forget meanwhile, and moves the returned states back over the turns", async () => {
    const chat = await held(E1);
    const lorebookState: LorebookState = {
      characterId: CHARACTER,
      effects: [{ index: 1, digest: "bb", start: 1 }],
    };
    const eventsState: EventsState = { characterId: CHARACTER, fired: [{ id: B, start: 1 }] };
    await foldingExchange(
      chat,
      "next",
      { spans: 1, turns: 4 },
      { lorebookState, eventsState },
      () => {
        // Forgotten while the reply is under way: the held span the server folds is gone.
        void chat.store.getState().forgetLatest();
        chat.forgets[0]?.answer(true);
      },
    );
    await tick();
    const state = chat.store.getState();
    expect(state.memory).toMatchObject({ horizon: 0, held: [], recap: [], foldedLatest: null });
    expect(state.lorebookState?.effects).toEqual([{ index: 1, digest: "bb", start: 5 }]);
    expect(state.eventsState?.fired).toEqual([{ id: B, start: 5 }]);
    expect(state.lastSent?.foldedTurns).toBe(4);
    expect(promptFoldedTurns(state)).toBe(4);

    await chat.exchange("again", "reply");
    expect(chat.reply.calls.at(-1)?.request.messages).toHaveLength(9);
  });

  /** A user message at even indices, a reply (failed when asked) at odd ones. */
  const numbered = (index: number, failed = false): ChatMessage =>
    index % 2 === 0
      ? { id: `u${index}`, role: "user", text: `m${index}`, personaId: null, sentAt: 0 }
      : {
          id: `r${index}`,
          role: "assistant",
          greeting: false,
          edited: false,
          replies: [
            {
              id: `a${index}`,
              text: `m${index}`,
              reasoning: "",
              thoughtMs: null,
              status: failed ? "failed" : "complete",
            },
          ],
          shown: 0,
        };

  it("keeps an event that fired inside an applied fold as returned, and unfolds it to its reply", async () => {
    const chat = await held(E1);
    // Fired on "b", folded with "c" and "d" after it: one folded reply follows it.
    const eventsState: EventsState = {
      characterId: CHARACTER,
      fired: [{ id: B, start: -3, foldedReplies: 1 }],
    };
    await foldingExchange(chat, "next", { spans: 1, turns: 4 }, { eventsState });
    expect(chat.store.getState().eventsState).toEqual(eventsState);
    void chat.store.getState().requestPreview();
    let previewed = chat.preview.calls.at(-1)?.request;
    expect(previewed?.eventsState).toEqual(eventsState);
    expect(previewed?.memoryState).toEqual({
      recap: [E1],
      folded: 4,
      foldedUsers: 2,
      held: [],
      continued: false,
    });

    const forgetting = chat.store.getState().forgetLatest();
    chat.forgets.at(-1)?.answer(true);
    await forgetting;
    expect(chat.store.getState().eventsState?.fired).toEqual([{ id: B, start: 1 }]);
    void chat.store.getState().requestPreview();
    previewed = chat.preview.calls.at(-1)?.request;
    expect(previewed?.memoryState).toEqual({
      recap: [],
      folded: 0,
      foldedUsers: 0,
      held: [],
      continued: false,
    });
  });

  it("unfolds by the replies crossed, users and failed replies not counted", () => {
    const chat = memoryChat();
    // Sent turns u0 r1 u2 u4 r5 u6 r7: the failed r3 is not sent. Five are folded, three users.
    chat.store.setState({
      messages: Array.from({ length: 8 }, (_, index) => numbered(index, index === 3)),
      memory: {
        ...NO_MEMORY,
        horizon: 6,
        recap: [E1, E2],
        foldedLatest: { id: E2, title: "Two", from: 2 },
      },
      // Fired on r1; r5 is the one folded reply after it.
      eventsState: { characterId: CHARACTER, fired: [{ id: B, start: -4, foldedReplies: 1 }] },
    });
    void chat.store.getState().requestPreview();
    expect(chat.preview.calls.at(-1)?.request.memoryState).toEqual({
      recap: [E1, E2],
      folded: 5,
      foldedUsers: 3,
      held: [],
      continued: false,
    });

    // u2, the failed r3, u4 and r5 unfold: three turns, one of them a reply.
    chat.store.getState().episodeGone(E2);
    expect(chat.store.getState().memory.horizon).toBe(2);
    expect(chat.store.getState().eventsState?.fired).toEqual([
      { id: B, start: -1, foldedReplies: 0 },
    ]);
    void chat.store.getState().requestPreview();
    expect(chat.preview.calls.at(-1)?.request.memoryState).toEqual({
      recap: [E1],
      folded: 2,
      foldedUsers: 1,
      held: [],
      continued: false,
    });
  });

  it("restores the returned states to the chat's coordinates after a reset while the fold was in flight", async () => {
    const chat = memoryChat();
    chat.store.setState({
      messages: Array.from({ length: 8 }, (_, index) => numbered(index)),
      memory: {
        ...NO_MEMORY,
        horizon: 2,
        recap: [E1],
        foldedLatest: { id: E1, title: "One", from: 0 },
        held: [{ id: E2, title: "Two", from: 2, to: 6 }],
      },
    });
    // The server folds u2 r3 u4 r5: the event fired on r3, with r5 folded after it.
    const eventsState: EventsState = {
      characterId: CHARACTER,
      fired: [{ id: B, start: -3, foldedReplies: 1 }],
    };
    const lorebookState: LorebookState = {
      characterId: CHARACTER,
      effects: [{ index: 1, digest: "bb", start: -3 }],
    };
    await foldingExchange(
      chat,
      "next",
      { spans: 1, turns: 4 },
      { eventsState, lorebookState },
      // Reset while the reply is under way: the tab unfolds what it had folded before.
      () => chat.store.getState().memoryReset(),
    );
    const state = chat.store.getState();
    expect(state.memory).toMatchObject({ horizon: 0, held: [], recap: [] });
    // r3 is turn 3 of the whole history again, no longer folded.
    expect(state.eventsState?.fired).toEqual([{ id: B, start: 3 }]);
    expect(state.lorebookState?.effects).toEqual([{ index: 1, digest: "bb", start: 3 }]);
  });

  it("leaves a preview's fold unapplied, its draft index and trim point after the turns it folded", async () => {
    const chat = await held(E1);
    chat.store.getState().setDraft("draft");
    void chat.store.getState().requestPreview();
    await tick();
    const call = chat.preview.calls.at(-1);
    expect(call?.request.messages).toHaveLength(7);
    call?.answer({
      ok: true,
      prompt: { ...inspected("draft"), memoryFold: { spans: 1, turns: 4 } },
    });
    await tick();
    const state = chat.store.getState();
    expect(state.memory).toMatchObject({ horizon: 0, held: [{ id: E1 }], recap: [] });
    expect(state.preview).toMatchObject({ status: "ready", draftIndex: 2 });
    expect(promptFoldedTurns(state)).toBe(4);
  });

  it("keeps a lost answer's attempt through a server fold, and an answer that lands after one", async () => {
    const chat = await held(E1);
    await chat.exchange(turn("g"), turn("h"));
    await chat.exchange(turn("i"), turn("j"));
    const lost = chat.calls[1];
    lost?.answer({ ok: false, reason: "unreachable", lost: true });
    await tick();
    expect(chat.store.getState().memory.pending).toMatchObject({ from: 4, boundary: 8 });

    // A request folds the held span: the horizon moves, the remembered end does not.
    await foldingExchange(chat, "next", { spans: 1, turns: 4 });
    expect(chat.store.getState().memory).toMatchObject({ horizon: 4, recap: [E1] });
    const again = chat.calls[2];
    expect(again?.request.attempt).toBe(lost?.request.attempt);
    expect(again?.request.turns).toEqual(lost?.request.turns);
    expect(again?.request).toMatchObject({ episodes: [E1], held: [] });

    // The answer arrives: its span is held after the folded one, the recap kept.
    again?.answer(answered(E2, [E1]));
    await tick();
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 4,
      held: [{ id: E2, from: 4, to: 8 }],
      recap: [E1],
      status: "idle",
      pending: null,
    });
  });

  it("keeps the memories a request folded while a memory call ran", async () => {
    const chat = await held(E1);
    await chat.exchange(turn("g"), turn("h"));
    await chat.exchange(turn("i"), turn("j"));
    const running = chat.calls[1];
    expect(running?.request).toMatchObject({ episodes: [], held: [E1] });
    await foldingExchange(chat, "next", { spans: 1, turns: 4 });
    // The server answers the recap the call sent, without the episode it folded meanwhile.
    running?.answer(answered(E2, []));
    await tick();
    expect(chat.store.getState().memory).toMatchObject({
      horizon: 4,
      held: [{ id: E2, from: 4, to: 8 }],
      recap: [E1],
    });
  });

  it("draws a new attempt once a Forget frees the held span before a lost answer", async () => {
    const chat = await twoHeld();
    await chat.exchange(turn("k"), turn("l"));
    await chat.exchange(turn("m"), turn("n"));
    const lost = chat.calls[2];
    lost?.answer({ ok: false, reason: "unreachable", lost: true });
    await tick();
    // Deleted elsewhere: the latest held span frees its turns, and the attempt goes with it.
    chat.store.getState().episodeGone(E2);
    expect(chat.store.getState().memory).toMatchObject({ held: [{ id: E1 }], pending: null });
    await chat.exchange(turn("o"), turn("p"));
    const fresh = chat.calls[3];
    expect(fresh?.request.attempt).not.toBe(lost?.request.attempt);
    expect(fresh?.request.turns[0]?.content).toBe(turn("e"));
  });

  it("folds held spans itself when a request would pass the turn or byte limit", async () => {
    const chat = memoryChat();
    const message = (index: number, text = `m${index}`): ChatMessage =>
      index % 2 === 0
        ? { id: `u${index}`, role: "user", text, personaId: null, sentAt: 0 }
        : {
            id: `r${index}`,
            role: "assistant",
            greeting: false,
            edited: false,
            replies: [
              { id: `a${index}`, text, reasoning: "", thoughtMs: null, status: "complete" },
            ],
            shown: 0,
          };
    const spans = [
      { id: E1, title: "One", from: 0, to: 4 },
      { id: E2, title: "Two", from: 4, to: 8 },
    ];
    // Past the turn limit by three: the first span's four turns fold, the second stays held.
    chat.store.setState({
      messages: Array.from({ length: 10_003 }, (_, index) => message(index)),
      memory: { ...NO_MEMORY, held: spans },
    });
    void chat.store.getState().requestPreview();
    let request = chat.preview.calls.at(-1)?.request;
    expect(request?.messages).toHaveLength(9_999);
    expect(request?.memoryState).toEqual({
      recap: [E1],
      folded: 4,
      foldedUsers: 2,
      held: [{ id: E2, turns: 4 }],
      continued: false,
    });
    expect(chat.store.getState().memory).toMatchObject({ horizon: 4, foldedLatest: { id: E1 } });

    // Past the byte limit: the held span with the long turn folds.
    chat.store.setState({
      messages: Array.from({ length: 9 }, (_, index) =>
        message(index, index === 1 ? "x".repeat(9 * 1024 * 1024) : `m${index}`),
      ),
      memory: { ...NO_MEMORY, held: spans },
    });
    void chat.store.getState().requestPreview();
    request = chat.preview.calls.at(-1)?.request;
    expect(request?.messages).toHaveLength(5);
    expect(request?.memoryState?.held).toEqual([{ id: E2, turns: 4 }]);
  });

  it("folds the oldest held spans past the held bound, so roll-up keeps a chat's memories bounded", async () => {
    const chat = memoryChat();
    const count = MEMORY_LIMITS.held + 2;
    const messages: ChatMessage[] = Array.from({ length: count * 2 }, (_, index) =>
      index % 2 === 0
        ? { id: `u${index}`, role: "user", text: `m${index}`, personaId: null, sentAt: 0 }
        : {
            id: `r${index}`,
            role: "assistant",
            greeting: false,
            edited: false,
            replies: [
              {
                id: `a${index}`,
                text: `m${index}`,
                reasoning: "",
                thoughtMs: null,
                status: "complete",
              },
            ],
            shown: 0,
          },
    );
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    const held = ids.map((id, index) => ({
      id,
      title: `T${index}`,
      from: index * 2,
      to: index * 2 + 2,
    }));
    chat.store.setState({ messages, memory: { ...NO_MEMORY, held } });
    void chat.store.getState().requestPreview();
    const request = chat.preview.calls.at(-1)?.request;
    expect(request?.memoryState?.held).toHaveLength(MEMORY_LIMITS.held);
    expect(request?.memoryState?.recap).toEqual(ids.slice(0, 2));
    expect(request?.messages).toHaveLength(MEMORY_LIMITS.held * 2);
  });
});

describe("scenes", () => {
  const CHARACTER_ID = "6f0c1b8e-2d4f-4c1a-9b3e-5a7d8c9e0f12";
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = (index = 0): ArtStreamEvent => ({
    type: "image",
    index,
    png: PNG,
  });
  const done: ArtStreamEvent = { type: "done" };

  /** A chat with the scene's requests answered by hand; `card` and `status` change in place. */
  function sceneChat() {
    const reply = controlledReply();
    const preview = controlledPreview();
    const selection = selectionOf({ characterId: CHARACTER_ID, personaId: "ash" });
    const session = { signedIn: true };
    const status: { now: CreatorArtStatus | Error } = { now: { state: "ready" } };
    const settings: { imagePromptModel: string | null } = { imagePromptModel: null };
    const subjects: string[] = [];
    const card = { ...blankCard("Ava"), description: "Tall, with copper hair." };
    const calls: {
      request: SceneRequest;
      signal: AbortSignal;
      receive?: (accounting: CallAccounting) => void;
      send: (event: ArtStreamEvent) => void;
      end: () => void;
    }[] = [];
    const streamScene = async (
      request: SceneRequest,
      signal: AbortSignal,
      receive?: (accounting: CallAccounting) => void,
    ) => {
      const queue: ArtStreamEvent[] = [];
      let ended = false;
      let wake = () => {};
      calls.push({
        request,
        signal,
        ...(receive === undefined ? {} : { receive }),
        send: (event) => {
          queue.push(event);
          wake();
        },
        end: () => {
          ended = true;
          wake();
        },
      });
      return (async function* () {
        while (true) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })();
    };
    const store = createChatStore(reply.streamReply, () => selection, {
      clock: () => CLOCK,
      pickSeed: () => SEED,
      cacheKey: () => cacheKeyOf(0),
      now: () => now,
      fetchPreview: preview.fetchPreview,
      signedIn: () => session.signedIn,
      scene: {
        streamScene,
        artStatus: async () => {
          if (status.now instanceof Error) throw status.now;
          return status.now;
        },
        workflow: () => "krea2-second",
        imagePromptModel: () => settings.imagePromptModel,
        subject: async (characterId): Promise<SceneSubject | null> => {
          subjects.push(characterId);
          return { card, persona: "Ash" };
        },
      },
    });
    /** One exchange: the user's line and the reply to it. */
    const exchange = async (user: string, answer: string) => {
      store.getState().setDraft(user);
      const sending = store.getState().send();
      reply.push(answer);
      reply.finish();
      await sending;
    };
    const press = async () => {
      store.getState().pictureScene();
      await tick();
    };
    const item = () => store.getState().scenes.at(-1);
    const paint = async () => {
      await press();
      calls.at(-1)?.send(image());
      calls.at(-1)?.send(done);
      await tick();
    };
    return {
      store,
      reply,
      preview,
      selection,
      session,
      status,
      settings,
      subjects,
      calls,
      exchange,
      press,
      item,
      paint,
    };
  }

  it("associates scene prompt accounting with the reply captured when the scene was scheduled", async () => {
    const chat = sceneChat();
    await chat.exchange("First", "First reply");
    const generation = chat.store
      .getState()
      .usage.calls.find((call) => call.purpose === "narration")?.generation;
    await chat.press();
    const id = crypto.randomUUID();
    chat.calls[0]?.receive?.({
      calls: [
        {
          id,
          purpose: "scene.prompt",
          model: "m",
          status: "completed",
          usage: { inputTokens: 40 },
        },
      ],
      truncated: false,
    });
    chat.calls[0]?.send(image());
    chat.calls[0]?.send(done);
    await tick();
    expect(
      chat.store.getState().usage.calls.find((call) => call.record.id === id)?.generation,
    ).toBe(generation);
    expect(chat.store.getState().usage.running).toEqual([]);
  });

  it("never reach a generation, a preview or a memory span: they are the same before and after a picture", async () => {
    const chat = sceneChat();
    await chat.exchange("We walk to the lake.", "Ava kneels by the water.");
    void chat.store.getState().requestPreview();
    const before = {
      preview: chat.preview.calls.at(-1)?.request,
      remembered: rememberableTurns(chat.store.getState(), 0),
    };
    await chat.paint();
    expect(chat.item()).toMatchObject({ run: { status: "complete" }, png: PNG });
    void chat.store.getState().requestPreview();
    expect(chat.preview.calls.at(-1)?.request).toEqual(before.preview);
    expect(rememberableTurns(chat.store.getState(), 0)).toEqual(before.remembered);

    await chat.exchange("And then?", "She smiles.");
    const sent = JSON.stringify(chat.reply.calls.at(-1)?.request);
    expect(sent).not.toContain(PNG.toBase64());
    expect(chat.reply.calls.at(-1)?.request.messages).toHaveLength(3);
  });

  it("follow the newest message and send the moment from the card and the shown turns", async () => {
    const chat = sceneChat();
    await chat.exchange("We walk to the lake.", "Ava kneels by the water.");
    await chat.press();
    const { request } = chat.calls[0] ?? {};
    expect(chat.item()?.anchorId).toBe(chat.store.getState().messages.at(-1)?.id);
    expect(request).toMatchObject({
      model: "model-a",
      workflow: "krea2-second",
      characterId: CHARACTER_ID,
      kind: "subject",
    });
    expect(request?.source).toContain("Tall, with copper hair.");
    expect(request?.source).toContain("Ash: We walk to the lake.");
    expect(request?.source).toContain("Ava: Ava kneels by the water.");
    expect(chat.store.getState().messages).toHaveLength(2);
  });

  it("take Settings' image prompt model over the chat's when one is set", async () => {
    const chat = sceneChat();
    await chat.exchange("We walk to the lake.", "Ava kneels by the water.");
    chat.settings.imagePromptModel = "model-b";
    await chat.paint();
    chat.settings.imagePromptModel = null;
    await chat.press();
    expect(chat.calls.map((call) => call.request.model)).toEqual(["model-b", "model-a"]);
  });

  it.each([
    ["a second image", [image(), image()]],
    ["another index", [image(1)]],
    ["done without an image", []],
    ["an error after the image", [image(), { type: "error", code: "comfyui" } as const]],
  ])("fail on %s and keep no bytes", async (_, events: ArtStreamEvent[]) => {
    const chat = sceneChat();
    await chat.exchange("Hi", "Hello");
    await chat.press();
    for (const event of events) chat.calls[0]?.send(event);
    chat.calls[0]?.send(done);
    await tick();
    expect(chat.item()?.run.status).toBe("failed");
    expect(chat.item()?.png).toBeUndefined();
  });

  it("are refused while a reply or another picture is on its way, and without a character, model or turn", async () => {
    const chat = sceneChat();
    await chat.press();
    chat.store.getState().setGreetings(["Hello there."]);
    chat.selection.characterId = null;
    await chat.press();
    chat.selection.characterId = CHARACTER_ID;
    chat.selection.model = null;
    await chat.press();
    expect(chat.store.getState().scenes).toEqual([]);

    chat.selection.model = "model-a";
    chat.store.getState().setDraft("Hi");
    const sending = chat.store.getState().send();
    await chat.press();
    expect(chat.store.getState().scenes).toEqual([]);
    chat.reply.finish();
    await sending;

    await chat.press();
    await chat.press();
    expect(chat.store.getState().scenes).toHaveLength(1);
    expect(chat.calls).toHaveLength(1);
  });

  it("are stopped before their request is aborted, by Stop the picture and by the chat's Stop, and a new press works after", async () => {
    const chat = sceneChat();
    await chat.exchange("Hi", "Hello");
    for (const stop of [
      () => chat.store.getState().stopScene(),
      () => chat.store.getState().stop(),
    ]) {
      await chat.press();
      const call = chat.calls.at(-1);
      let seen: string | undefined;
      call?.signal.addEventListener("abort", () => {
        seen = chat.item()?.run.status;
      });
      stop();
      expect(seen).toBe("stopped");
      call?.send(image());
      call?.send(done);
      await tick();
      expect(chat.item()).toMatchObject({ run: { status: "stopped" } });
      expect(chat.item()?.png).toBeUndefined();
    }
    await chat.paint();
    expect(chat.store.getState().scenes.map((item) => item.run.status)).toEqual([
      "stopped",
      "stopped",
      "complete",
    ]);
  });

  it("go with Clear, before their request is aborted, and a late picture lands nowhere", async () => {
    const chat = sceneChat();
    await chat.exchange("Hi", "Hello");
    await chat.press();
    const call = chat.calls[0];
    let seen: number | undefined;
    call?.signal.addEventListener("abort", () => {
      seen = chat.store.getState().scenes.length;
    });
    chat.store.getState().clear();
    expect(seen).toBe(0);
    call?.send(image());
    call?.send(done);
    await tick();
    expect(chat.store.getState().scenes).toEqual([]);
  });

  it("go with the message they follow, for good, and one on its way is aborted", async () => {
    const chat = sceneChat();
    await chat.exchange("Hi", "Hello");
    await chat.paint();
    await chat.exchange("Again", "Once more");
    await chat.press();
    const [first, second] = chat.store.getState().messages;
    const reply = chat.store.getState().messages.at(-1);
    chat.store.getState().remove(reply?.id ?? "");
    expect(chat.calls.at(-1)?.signal.aborted).toBe(true);
    expect(chat.store.getState().scenes).toHaveLength(1);
    chat.store.getState().undoDelete();
    expect(chat.store.getState().messages).toHaveLength(4);
    expect(chat.store.getState().scenes).toHaveLength(1);

    chat.store.getState().removeFrom(first?.id ?? "");
    expect(chat.store.getState().scenes).toEqual([]);
    expect(second).toBeDefined();
  });

  it("skip without a ready ComfyUI and go again in place from their snapshot on Try again", async () => {
    const chat = sceneChat();
    await chat.exchange("Hi", "Hello");
    chat.status.now = { state: "unavailable", reason: "unreachable" };
    await chat.press();
    const id = chat.item()?.id;
    expect(chat.item()?.run).toEqual({ status: "skipped", reason: "unavailable" });
    expect(chat.calls).toHaveLength(0);

    // The chat moves on; Try again pictures the moment it was asked for.
    await chat.exchange("Later", "Much later");
    chat.status.now = { state: "ready" };
    chat.store.getState().retryScene(id ?? "");
    await tick();
    expect(chat.store.getState().scenes).toHaveLength(1);
    expect(chat.item()?.id).toBe(id);
    expect(chat.calls[0]?.request.source).not.toContain("Much later");
    expect(chat.subjects).toHaveLength(1);
    chat.calls[0]?.send(image());
    chat.calls[0]?.send(done);
    await tick();
    expect(chat.item()?.run.status).toBe("complete");
  });

  it("wait for a sign-in and go once on the renewal; Stop or Clear meanwhile ends the wait", async () => {
    const chat = sceneChat();
    await chat.exchange("Hi", "Hello");
    chat.status.now = new SignedOut();
    await chat.press();
    expect(chat.item()?.run).toEqual({ status: "waiting" });
    chat.status.now = { state: "ready" };
    chat.store.getState().resumeScene();
    chat.store.getState().resumeScene();
    await tick();
    expect(chat.calls).toHaveLength(1);
    chat.calls[0]?.send(image());
    chat.calls[0]?.send(done);
    await tick();
    expect(chat.item()?.run.status).toBe("complete");

    chat.status.now = new SignedOut();
    await chat.press();
    chat.store.getState().stopScene();
    chat.store.getState().resumeScene();
    await tick();
    expect(chat.item()?.run).toEqual({ status: "stopped" });

    chat.store.getState().retryScene(chat.item()?.id ?? "");
    await tick();
    expect(chat.item()?.run).toEqual({ status: "waiting" });
    chat.store.getState().clear();
    chat.status.now = { state: "ready" };
    chat.store.getState().resumeScene();
    await tick();
    expect(chat.store.getState().scenes).toEqual([]);
    expect(chat.calls).toHaveLength(1);
  });

  it("count as the user's content, even beside an untouched greeting", async () => {
    const chat = sceneChat();
    chat.store.getState().setGreetings(["Hello there."]);
    chat.store.getState().setDraft("");
    expect(hasChatContent(chat.store.getState())).toBe(false);
    const untouched = chat.store.getState();
    await chat.paint();
    expect(hasChatContent(chat.store.getState())).toBe(true);
    // A chat switch waiting on the persona list gives way to the picture.
    expect(contentChangedSince(untouched, chat.store.getState())).toBe(true);
  });

  it("are hidden only once they are not on their way", async () => {
    const chat = sceneChat();
    await chat.exchange("Hi", "Hello");
    await chat.press();
    const id = chat.item()?.id ?? "";
    chat.store.getState().hideScene(id);
    expect(chat.store.getState().scenes).toHaveLength(1);
    chat.store.getState().stopScene();
    chat.store.getState().hideScene(id);
    expect(chat.store.getState().scenes).toEqual([]);
  });
});
