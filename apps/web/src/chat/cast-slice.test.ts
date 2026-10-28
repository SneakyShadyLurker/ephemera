import {
  blankCard,
  CAST_LIMITS,
  type CallAccounting,
  type CastChanges,
  type CastSheet,
  type CastUpdateRequest,
  type CharacterMemory,
  castAnchorsText,
  castRegisterSchema,
  effectiveCastAnchor,
  emptyNotebook,
  type GenerateRequest,
  type PreviewRequest,
  type ReasoningEffort,
  type SceneRequest,
} from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import type { CastFailure, CastSheetOutcome, CastUpdateOutcome } from "../cast/queries.ts";
import { tick } from "../testing.ts";
import { currentRegister, memoryContextAt, stale } from "./cast-slice.ts";
import type { StreamScene } from "./scene-slice.ts";
import {
  type AssistantMessage,
  type ChatState,
  createChatStore,
  type Selection,
  type StreamReply,
  shownReply,
} from "./store.ts";

const CLOCK = { now: Date.UTC(2026, 9, 25, 20, 0), timeZone: "Europe/Berlin" };
const CHARACTER = "6f0c1b8e-2d4f-4c1a-9b3e-5a7d8c9e0f12";
const OTHER_CHARACTER = "7a1d2c9f-3e5a-4d2b-8c4f-6b8e9d0a1f23";
const FINGERPRINT = "f".repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The keeper's answer naming `name` present, with these state fields. */
const upsert = (name: string, state: Record<string, string> = {}): CastChanges => ({
  cast: { [name]: { gender: "female", role: "principal", anchor: { age: "30" }, state } },
  absent: [],
});

const names = (state: ChatState) => currentRegister(state).entries.map((e) => e.anchor.name);
const entry = (state: ChatState, name: string) =>
  currentRegister(state).entries.find((e) => e.anchor.name === name);
const replyMessage = (state: ChatState, nth: number) =>
  state.messages.filter((m): m is AssistantMessage => m.role === "assistant")[nth];
const shownId = (state: ChatState, nth: number) => {
  const message = replyMessage(state, nth);
  return message === undefined ? undefined : shownReply(message).id;
};

/** A chat with a character whose replies, keeper calls and sheet requests the test answers. */
function castChat(
  loadMemory?: (characterId: string) => Promise<CharacterMemory | undefined>,
  replyStream?: StreamReply,
  sceneStream?: StreamScene,
) {
  const selection: Selection = {
    model: "model-a",
    samplerPresetId: null,
    promptPresetId: null,
    characterId: CHARACTER,
    personaId: null,
    reasoning: null,
  };
  /** How the next replies end; "complete" when the script is empty. */
  const script: ("complete" | "stop" | "fail")[] = [];
  const generated: GenerateRequest[] = [];
  const previews: PreviewRequest[] = [];
  const keeper: {
    request: CastUpdateRequest;
    signal: AbortSignal;
    settle: (outcome: CastUpdateOutcome) => void;
    receive?: (accounting: CallAccounting) => void;
  }[] = [];
  const sheets: {
    characterId: string;
    signal: AbortSignal;
    settle: (outcome: CastSheetOutcome) => void;
  }[] = [];
  const scenes: SceneRequest[] = [];
  const castSettings = {
    model: "cast-model" as string | null,
    reasoning: null as ReasoningEffort | null,
  };
  let replies = 0;
  let ids = 100;
  const streamReply: StreamReply = (request, signal) => {
    generated.push(request);
    if (replyStream !== undefined) return replyStream(request, signal);
    const end = script.shift() ?? "complete";
    replies += 1;
    const text = `reply ${replies}`;
    return (async function* () {
      if (end === "fail") throw new Error("upstream");
      yield { text };
      if (end === "stop") store.getState().stop();
    })();
  };
  const store = createChatStore(streamReply, () => selection, {
    clock: () => CLOCK,
    pickSeed: () => 1,
    cacheKey: () => uuid(1),
    fetchPreview: async (request) => {
      previews.push(request);
      return { ok: false, error: "unavailable" };
    },
    cast: {
      ...(loadMemory === undefined ? {} : { memory: loadMemory }),
      update: (request, signal, receive) => {
        const answer = deferred<CastUpdateOutcome>();
        keeper.push({
          request,
          signal,
          settle: answer.resolve,
          ...(receive === undefined ? {} : { receive }),
        });
        return answer.promise;
      },
      sheet: (characterId, _request, signal) => {
        const answer = deferred<CastSheetOutcome>();
        sheets.push({ characterId, signal, settle: answer.resolve });
        return answer.promise;
      },
      settings: () => castSettings,
      newId: () => uuid(ids++),
      player: () => "Rowan",
    },
    scene: {
      streamScene: async (request, signal) => {
        scenes.push(request);
        if (sceneStream !== undefined) return sceneStream(request, signal);
        throw new Error("comfyui");
      },
      artStatus: async () => ({ state: "ready" }),
      workflow: () => "w",
      imagePromptModel: () => null,
      subject: async () => ({ card: blankCard("Ava"), persona: "Rowan" }),
    },
  });
  const state = () => store.getState();
  return {
    store,
    state,
    selection,
    script,
    generated,
    previews,
    keeper,
    sheets,
    scenes,
    castSettings,
    say: async (text: string) => {
      state().setDraft(text);
      await state().send();
      await tick();
    },
    answer: async (changes: CastChanges, at = -1) => {
      keeper.at(at)?.settle({
        ok: true,
        response: { changes, usage: { inputTokens: 40, cachedTokens: 30, outputTokens: 6 } },
      });
      await tick();
    },
    refuse: async (reason: CastFailure, at = -1) => {
      keeper.at(at)?.settle({ ok: false, reason });
      await tick();
    },
    sheet: async (entries: CastSheet["entries"], at = -1, current = true) => {
      sheets.at(at)?.settle({
        ok: true,
        current,
        sheet: {
          characterId: CHARACTER,
          fingerprint: FINGERPRINT,
          entries,
          revision: 0,
          updatedAt: 0,
        },
      });
      await tick();
    },
  };
}

const SHEET_ENTRY = {
  id: uuid(1),
  role: "principal" as const,
  aka: [],
  anchor: {
    name: "Ava Lind",
    gender: "female" as const,
    age: "29",
    ethnicity: "",
    skin: "",
    face: "",
    experience: "",
    relationship: "",
    height: "",
    weight: "",
    build: "",
    hair: "copper",
    eyes: "",
    intimate: "",
    personality: "",
    fetishes: "",
  },
};

describe("cast keeper calls", () => {
  it.each(["length", "content-filter"] as const)(
    "invalidates a completed reply's old snapshot after a partial %s Continue",
    async (finishReason) => {
      let call = 0;
      const chat = castChat(undefined, async function* () {
        call++;
        yield call === 1 ? { text: "Complete story" } : { text: "Added story", finishReason };
      });
      await chat.say("Hi");
      await chat.answer(upsert("Ilse"));
      expect(stale(chat.state())).toBe(false);
      await chat.state().continueReply();
      await tick();
      expect(chat.keeper).toHaveLength(1);
      expect(stale(chat.state())).toBe(true);
    },
  );

  it("keeps a late keeper receipt attached to its scheduled generation", async () => {
    const chat = castChat();
    await chat.say("First");
    const first = chat.keeper[0];
    const generation = chat
      .state()
      .usage.running.find((call) => call.purpose === "cast.update")?.generation;
    expect(generation).toBeTruthy();
    await chat.say("Second");
    first?.receive?.({
      calls: [
        {
          id: uuid(999),
          purpose: "cast.update",
          model: "cast-model",
          status: "completed",
          usage: { inputTokens: 40 },
        },
      ],
      truncated: false,
    });
    first?.settle({ ok: true, response: { changes: upsert("Ilse"), usage: { inputTokens: 40 } } });
    await tick();
    expect(chat.state().usage.calls.find((call) => call.record.id === uuid(999))?.generation).toBe(
      generation,
    );
    expect(
      chat.state().usage.calls.find((call) => call.record.id === uuid(999))?.generation,
    ).not.toBe(
      chat.state().usage.calls.findLast((call) => call.purpose === "narration")?.generation,
    );
  });
  it.each(["length", "content-filter"] as const)(
    "waits to catch up a %s ending until a later complete reply",
    async (finishReason) => {
      let call = 0;
      const chat = castChat(undefined, async function* () {
        call++;
        yield call <= 2 ? { text: "Partial story", finishReason } : { text: "Finished story" };
      });
      await chat.say("Hi");
      expect(chat.keeper).toHaveLength(0);
      const partial = replyMessage(chat.state(), 0);
      expect(partial && shownReply(partial)).toMatchObject({ status: "complete", finishReason });
      await chat.state().continueReply();
      await tick();
      expect(chat.keeper).toHaveLength(0);
      expect(call).toBe(2);
      await chat.state().continueReply();
      await tick();
      expect(chat.keeper).toHaveLength(1);
      expect(chat.keeper[0]?.request.turns.map((turn) => turn.content)).toContain(
        "Partial story Finished story",
      );
    },
  );
  it("read each complete reply from the last good snapshot, and none after a stopped one", async () => {
    const chat = castChat();
    await chat.say("Hi");
    expect(chat.keeper).toHaveLength(1);
    expect(chat.keeper[0]?.request).toMatchObject({
      characterId: CHARACTER,
      model: "cast-model",
      mode: "update",
      sheetFingerprint: null,
      register: { entries: [] },
      turns: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "reply 1" },
      ],
    });
    expect(chat.state().cast.status).toBe("updating");
    await chat.answer(upsert("Ilse Brandt", { outfit: "red dress" }));
    expect(names(chat.state())).toEqual(["Ilse Brandt"]);
    expect(chat.state().cast.lastCall).toMatchObject({
      model: "cast-model",
      usage: { inputTokens: 40, cachedTokens: 30, outputTokens: 6 },
    });

    // The base carries the owner's corrections over the previous snapshot.
    chat.state().correctCast(uuid(100), { anchor: { hair: "black" } });
    await chat.say("Next");
    expect(chat.keeper[1]?.request.register.entries[0]?.anchor).toMatchObject({
      name: "Ilse Brandt",
      hair: "black",
    });
    expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual(["Next", "reply 2"]);

    // A failed call leaves no snapshot: the next one catches up from the last good one.
    await chat.refuse("cast_failed");
    expect(chat.state().cast).toMatchObject({
      status: "failed",
      failure: "cast_failed",
      failures: 1,
    });
    expect(stale(chat.state())).toBe(true);
    await chat.say("Third");
    expect(chat.keeper[2]?.request.turns.map((turn) => turn.content)).toEqual([
      "Next",
      "reply 2",
      "Third",
      "reply 3",
    ]);

    chat.script.push("stop");
    await chat.say("Fourth");
    expect(chat.keeper).toHaveLength(3);
  });

  it("joins active retries, preserves covered snapshots and fences late answers after Clear", async () => {
    const chat = castChat();
    await chat.say("Hi");
    chat.state().retryCast();
    chat.state().retryCast();
    expect(chat.keeper).toHaveLength(1);
    expect(chat.keeper[0]?.signal.aborted).toBe(false);
    await chat.answer(upsert("Noor"));
    const snapshot = chat.state().cast.snapshots[shownId(chat.state(), 0) ?? ""];
    expect(names(chat.state())).toEqual(["Noor"]);
    expect(chat.state().cast.status).toBe("idle");
    chat.state().retryCast();
    chat.state().retryCast();
    await tick();
    expect(chat.keeper).toHaveLength(1);
    expect(chat.state().cast.snapshots[shownId(chat.state(), 0) ?? ""]).toBe(snapshot);
    await chat.say("Next");
    chat.state().retryCast();
    chat.state().clear();
    expect(chat.keeper[1]?.signal.aborted).toBe(true);
    await chat.answer(upsert("Late"), 1);
    expect(chat.state().cast.snapshots).toEqual({});
    expect(chat.state().cast.activeCall).toBeNull();
  });

  it("shrinks the oldest prefix repeatedly, then processes every remaining turn", async () => {
    const chat = castChat();
    await chat.say("One");
    await chat.refuse("cast_failed");
    await chat.say("Two");
    expect(chat.keeper[1]?.request.turns).toHaveLength(4);
    await chat.refuse("prompt_too_long");
    expect(chat.keeper[2]?.request.turns.map((turn) => turn.content)).toEqual(["One", "reply 1"]);
    await chat.refuse("prompt_too_long");
    expect(chat.keeper[3]?.request.turns.map((turn) => turn.content)).toEqual(["One"]);
    for (const texts of [["One"], ["reply 1", "Two", "reply 2"]]) {
      expect(chat.keeper.at(-1)?.request.turns.map((turn) => turn.content)).toEqual(texts);
      expect(chat.state().cast.snapshots).toEqual({});
      await chat.answer(upsert("Noor", { injuries: "broken leg" }));
    }
    expect(chat.state().cast.status).toBe("idle");
    expect(entry(chat.state(), "Noor")?.state.injuries).toBe("broken leg");
    expect(chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""]).toBeDefined();

    await chat.say("Third");
    await chat.refuse("prompt_too_long");
    await chat.refuse("prompt_too_long");
    expect(chat.state().cast).toMatchObject({ status: "failed", failure: "prompt_too_long" });
  });

  it("go out with the generate and preview requests only once the register has entries", async () => {
    const chat = castChat();
    await chat.say("Hi");
    expect(chat.generated[0]).not.toHaveProperty("cast");
    await chat.state().requestPreview();
    expect(chat.previews.at(-1)).not.toHaveProperty("cast");
    await chat.answer(upsert("Ilse"));
    await chat.state().requestPreview();
    expect(chat.previews.at(-1)?.cast?.entries.map((e) => e.anchor.name)).toEqual(["Ilse"]);
    await chat.say("Next");
    expect(chat.generated[1]?.cast?.entries.map((e) => e.anchor.name)).toEqual(["Ilse"]);
  });
});

describe("chronological cast catch-up", () => {
  it.each([
    ["correction", "failed"],
    ["sheet", "failed"],
    ["correction", "streaming"],
    ["sheet", "streaming"],
  ] as const)("recovers B under new %s context behind empty %s C", async (context, ending) => {
    const finish = deferred<void>();
    let count = 0;
    let hold = false;
    const chat = castChat(undefined, async function* () {
      if (hold) {
        if (ending === "streaming") await finish.promise;
        throw new Error("upstream");
      }
      yield { text: `reply ${++count}` };
    });
    await chat.say("Base");
    await chat.answer(upsert("Noor"));
    chat.castSettings.model = null;
    for (let i = 0; i < 7; i++) await chat.say(`Missed ${i}`);
    const target = shownId(chat.state(), 7) ?? "";
    const generation = chat
      .state()
      .usage.calls.findLast((call) => call.purpose === "narration")?.generation;
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.answer(upsert("Private output"));
    const oldCall = chat.keeper.length - 1;
    hold = true;
    const sending = chat.say("Empty C");
    await tick();
    const empty = shownId(chat.state(), 8) ?? "";
    if (context === "correction")
      chat.state().correctCast(uuid(100), { state: { outfit: "coat" } });
    else await chat.sheet([SHEET_ENTRY]);
    await tick();
    expect(chat.keeper[oldCall]?.signal.aborted).toBe(true);
    expect(chat.keeper).toHaveLength(oldCall + 2);
    if (context === "sheet") expect(chat.keeper.at(-1)?.request.sheetFingerprint).toBe(FINGERPRINT);
    else expect(chat.keeper.at(-1)?.request.register.entries[0]?.state.outfit).toBe("coat");
    expect(
      chat.state().usage.running.find((call) => call.purpose === "cast.update")?.generation,
    ).toBe(generation);
    // C changes object identity after the replacement reservation. B owns only its prefix.
    finish.resolve();
    await sending;
    await chat.answer(upsert("Late output"), oldCall);
    await chat.answer({ cast: {}, absent: [] });
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.keeper).toHaveLength(oldCall + 3);
    expect(chat.state().cast.snapshots[target]).toBeDefined();
    expect(chat.state().cast.snapshots[empty]).toBeUndefined();
    expect(
      chat.keeper
        .slice(oldCall + 1)
        .flatMap((call) => call.request.turns.map((turn) => turn.content)),
    ).toEqual(Array.from({ length: 7 }, (_, i) => [`Missed ${i}`, `reply ${i + 2}`]).flat());
    expect(names(chat.state())).not.toContain("Late output");
  });

  it("coalesces C completing before a context handoff dispatch into one latest target", async () => {
    const finish = deferred<void>();
    let count = 0;
    let hold = false;
    const chat = castChat(undefined, async function* () {
      if (hold) await finish.promise;
      yield { text: `reply ${++count}` };
    });
    await chat.say("Base");
    await chat.answer(upsert("Noor"));
    chat.castSettings.model = null;
    for (let i = 0; i < 7; i++) await chat.say(`Missed ${i}`);
    const older = shownId(chat.state(), 7) ?? "";
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    hold = true;
    const sending = chat.say("C");
    await tick();
    // endReply publishes C before invoking cast.replied. A context change in that gap
    // must leave exactly one latest-target dispatch to the completion callback.
    let corrected = false;
    const unsubscribe = chat.store.subscribe((state) => {
      const newest = replyMessage(state, 8);
      if (corrected || newest === undefined || shownReply(newest).status !== "complete") return;
      corrected = true;
      state.correctCast(uuid(100), { state: { outfit: "coat" } });
    });
    finish.resolve();
    await sending;
    unsubscribe();
    expect(corrected).toBe(true);
    const newest = shownId(chat.state(), 8) ?? "";
    expect(chat.keeper).toHaveLength(3);
    expect(chat.keeper[1]?.signal.aborted).toBe(true);
    await chat.answer({ cast: {}, absent: [] });
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.keeper).toHaveLength(4);
    expect(chat.state().cast.snapshots[older]).toBeUndefined();
    expect(chat.state().cast.snapshots[newest]).toBeDefined();
    expect(
      chat.keeper.slice(2).flatMap((call) => call.request.turns.map((turn) => turn.content)),
    ).toEqual([
      ...Array.from({ length: 7 }, (_, i) => [`Missed ${i}`, `reply ${i + 2}`]).flat(),
      "C",
      "reply 9",
    ]);
  });

  it("drains queued B even when later C fails empty", async () => {
    const chat = castChat();
    await chat.say("A");
    await chat.say("B");
    const target = shownId(chat.state(), 1) ?? "";
    chat.script.push("fail");
    await chat.say("C");
    await chat.answer(upsert("Noor"), 0);
    expect(chat.keeper).toHaveLength(2);
    expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual(["B", "reply 2"]);
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.state().cast.snapshots[target]).toBeDefined();
    expect(chat.keeper).toHaveLength(2);
  });

  it.each(["unchanged", "model", "effort"] as const)(
    "joins queued B on repeated retry with %s context",
    async (context) => {
      const chat = castChat();
      await chat.say("Running A");
      await chat.say("Queued B");
      const target = shownId(chat.state(), 1) ?? "";
      if (context === "model") chat.castSettings.model = "other-model";
      else if (context === "effort") chat.castSettings.reasoning = "high";
      chat.state().retryCast();
      chat.state().retryCast();
      await tick();
      expect(chat.keeper[0]?.signal.aborted).toBe(context !== "unchanged");
      expect(chat.keeper).toHaveLength(context === "unchanged" ? 1 : 2);
      await chat.answer(upsert("Noor"), 0);
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual(
        context === "unchanged"
          ? ["Queued B", "reply 2"]
          : ["Running A", "reply 1", "Queued B", "reply 2"],
      );
      expect(chat.keeper[1]?.request).toMatchObject({
        model: context === "model" ? "other-model" : "cast-model",
        ...(context === "effort" ? { reasoning: "high" } : {}),
      });
      await chat.answer(upsert("Current"));
      expect(chat.keeper).toHaveLength(2);
      expect(chat.state().cast.snapshots[target]).toBeDefined();
      expect(names(chat.state())).toContain("Current");
      if (context !== "unchanged") expect(names(chat.state())).not.toContain("Noor");
    },
  );

  it.each(["length", "content-filter"] as const)(
    "never admits partial %s C on explicit retry",
    async (finishReason) => {
      let count = 0;
      const chat = castChat(undefined, async function* () {
        yield ++count === 1 ? { text: "Complete B" } : { text: "Partial C", finishReason };
      });
      await chat.say("B");
      await chat.refuse("cast_failed");
      const target = shownId(chat.state(), 0) ?? "";
      await chat.say("C");
      chat.state().retryCast();
      await tick();
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual([
        "B",
        "Complete B",
      ]);
      await chat.answer(upsert("Noor"));
      expect(Object.keys(chat.state().cast.snapshots)).toEqual([target]);
      expect(stale(chat.state())).toBe(true);
    },
  );

  it.each(["retry", "regenerate", "continue"] as const)(
    "preserves older B behind empty failed C on %s",
    async (action) => {
      const chat = castChat();
      await chat.say("B");
      const target = shownId(chat.state(), 0) ?? "";
      await chat.refuse("cast_failed");
      chat.script.push("fail");
      await chat.say("C");
      chat.state().retryCast();
      await tick();
      expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual(["B", "reply 1"]);
      await chat.answer(upsert("Noor"));
      const snapshot = chat.state().cast.snapshots[target];
      expect(snapshot).toBeDefined();
      if (action === "retry") return;
      if (action === "regenerate") {
        chat.script.push("fail");
        await chat.state().regenerate();
      } else await chat.state().continueReply();
      await tick();
      expect(chat.state().cast.snapshots[target]).toBe(snapshot);
      expect(names(chat.state())).toEqual(["Noor"]);
      expect(chat.keeper).toHaveLength(2);
    },
  );

  it.each(["correction", "sheet"] as const)(
    "hands a newly split call to the queued target before dispatching under stale %s context",
    async (context) => {
      const chat = castChat();
      await chat.say("Base");
      await chat.answer(upsert("Noor"));
      await chat.say("Running A");
      const older = shownId(chat.state(), 1) ?? "";
      await chat.say("Queued B");
      const newest = shownId(chat.state(), 2) ?? "";
      expect(chat.keeper).toHaveLength(2);
      if (context === "correction")
        chat.state().correctCast(uuid(100), { state: { outfit: "blue robe" } });
      else await chat.sheet([SHEET_ENTRY]);
      expect(chat.keeper[1]?.signal.aborted).toBe(false);
      await chat.refuse("prompt_too_long", 1);
      expect(chat.keeper).toHaveLength(3);
      expect(chat.keeper[2]?.request.turns.map((turn) => turn.content)).toEqual([
        "Running A",
        "reply 2",
        "Queued B",
        "reply 3",
      ]);
      if (context === "correction")
        expect(chat.keeper[2]?.request.register.entries[0]?.state.outfit).toBe("blue robe");
      else {
        expect(chat.keeper[2]?.request.sheetFingerprint).toBe(FINGERPRINT);
        expect(
          chat.keeper[2]?.request.register.entries.map((person) => person.anchor.name),
        ).toEqual(["Noor", "Ava Lind"]);
      }
      expect(
        chat.state().usage.running.find((call) => call.purpose === "cast.update")?.generation,
      ).toBe(chat.state().usage.calls.findLast((call) => call.purpose === "narration")?.generation);
      await chat.answer({ cast: {}, absent: [] });
      expect(chat.state().cast.snapshots[older]).toBeUndefined();
      expect(chat.state().cast.snapshots[newest]).toBeDefined();
      expect(chat.keeper).toHaveLength(3);
      expect(chat.state().cast.status).toBe("idle");
    },
  );

  it.each(["model", "effort"] as const)(
    "hands a running single call's queued target to the current %s exactly once",
    async (context) => {
      const chat = castChat();
      await chat.say("Running A");
      await chat.say("Queued B");
      const newest = shownId(chat.state(), 1) ?? "";
      if (context === "model") chat.castSettings.model = "other-model";
      else chat.castSettings.reasoning = "high";
      await chat.answer(upsert("Stale output"), 0);
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.request).toMatchObject({
        model: context === "model" ? "other-model" : "cast-model",
        ...(context === "effort" ? { reasoning: "high" } : {}),
      });
      expect(chat.keeper[1]?.request.turns).toHaveLength(4);
      expect(chat.state().cast.snapshots).toEqual({});
      await chat.refuse("cast_failed");
      await tick();
      expect(chat.keeper).toHaveLength(2);
      expect(chat.state().cast).toMatchObject({ status: "failed", failures: 1 });
      chat.state().retryCast();
      await tick();
      await chat.answer(upsert("Current output"));
      expect(Object.keys(chat.state().cast.snapshots)).toEqual([newest]);
      expect(chat.state().cast).toMatchObject({ status: "idle", failure: null, failures: 0 });
    },
  );

  it("waits for a Try again's new sheet before rebuilding its failed private prefix", async () => {
    const chat = castChat();
    await chat.say("Base");
    await chat.answer(upsert("Noor"));
    chat.castSettings.model = null;
    for (let i = 0; i < 7; i++) await chat.say(`Missed ${i}`);
    const newest = shownId(chat.state(), 7) ?? "";
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.answer(upsert("Private output"));
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await chat.refuse("timeout");
    // Both operations failed. Reserve the keeper without spending on the old canon.
    chat.state().retryCast();
    await tick();
    expect(chat.sheets).toHaveLength(2);
    expect(chat.keeper).toHaveLength(3);
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.keeper).toHaveLength(4);
    expect(chat.keeper[3]?.request.sheetFingerprint).toBe(FINGERPRINT);
    expect(chat.keeper[3]?.request.turns).toHaveLength(CAST_LIMITS.turns);
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.keeper[4]?.request.turns).toHaveLength(2);
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.keeper).toHaveLength(5);
    expect(chat.state().cast.snapshots[newest]).toBeDefined();
    expect(names(chat.state())).toEqual(["Noor", "Ava Lind"]);
    expect(chat.state().cast.status).toBe("idle");
  });

  it.each(["correction", "sheet", "memory"] as const)(
    "preserves an unfittable failed continuation's Try again state after %s without starting work",
    async (context) => {
      const chat = castChat();
      await chat.say("Base");
      await chat.answer(upsert("Noor"));
      chat.castSettings.model = null;
      for (let i = 0; i < 7; i++) await chat.say(`Missed ${i}`);
      chat.castSettings.model = "cast-model";
      chat.state().retryCast();
      await tick();
      await chat.answer(upsert("Private output"));
      await chat.refuse("prompt_too_long");
      expect(chat.keeper.at(-1)?.request.turns).toHaveLength(1);
      await chat.refuse("prompt_too_long");
      const failed = chat.state().cast;
      const calls = chat.keeper.length;
      if (context === "correction")
        chat.state().correctCast(uuid(100), { state: { outfit: "coat" } });
      else if (context === "sheet") await chat.sheet([SHEET_ENTRY]);
      else chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE]));
      await tick();
      expect(chat.keeper).toHaveLength(calls);
      expect(chat.state().cast).toMatchObject({
        status: "failed",
        failure: failed.failure,
        failures: failed.failures,
        activeCall: null,
      });
      expect(stale(chat.state())).toBe(true);
      chat.state().retryCast();
      await tick();
      expect(chat.keeper.at(-1)?.request.turns[0]?.content).toBe("Missed 0");
      expect(chat.keeper.at(-1)?.request.turns).toHaveLength(CAST_LIMITS.turns);
      expect(
        chat.keeper.at(-1)?.request.register.entries.map((person) => person.anchor.name),
      ).not.toContain("Private output");
    },
  );

  it.each(["retry", "append"] as const)(
    "repacks small suffixes after a large turn and a failed batch on %s",
    async (extension) => {
      const chat = castChat();
      const large = "Oversized early turn. ".repeat(500);
      await chat.say(large);
      await chat.refuse("cast_failed");
      chat.castSettings.model = null;
      for (let i = 0; i < 3; i++) await chat.say(`Small ${i}`);
      chat.castSettings.model = "cast-model";
      chat.state().retryCast();
      await tick();
      for (const size of [8, 4, 2]) {
        expect(chat.keeper.at(-1)?.request.turns).toHaveLength(size);
        await chat.refuse("prompt_too_long");
      }
      expect(chat.keeper.at(-1)?.request.turns.map((turn) => turn.content)).toEqual([large]);
      const successful = [chat.keeper.at(-1)?.request];
      await chat.answer(upsert("Noor", { injuries: "broken leg" }));
      expect(chat.keeper.at(-1)?.request.turns).toHaveLength(7);
      await chat.refuse("timeout");
      if (extension === "append") await chat.say("Extended after failure");
      else {
        chat.state().retryCast();
        await tick();
      }
      expect(chat.keeper.at(-1)?.request.turns).toHaveLength(extension === "append" ? 9 : 7);
      expect(chat.keeper.at(-1)?.request.register.entries[0]?.state.injuries).toBe("broken leg");
      successful.push(chat.keeper.at(-1)?.request);
      await chat.answer({ cast: {}, absent: [] });
      expect(successful.flatMap((request) => request?.turns.map((turn) => turn.content))).toEqual(
        chat
          .state()
          .messages.map((message) =>
            message.role === "user" ? message.text : shownReply(message).text,
          ),
      );
      expect(chat.state().cast.status).toBe("idle");
      expect(stale(chat.state())).toBe(false);
    },
  );

  it("carries departure and injury through more than twelve missed turns and an intermediate failure", async () => {
    const chat = castChat();
    await chat.say("Noor arrives");
    await chat.answer(upsert("Noor"));
    const before = chat.state().cast.snapshots;
    chat.castSettings.model = null;
    for (let i = 0; i < 8; i++)
      await chat.say(i === 0 ? "Noor breaks her leg and leaves" : `Later ${i}`);
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    const prefix = chat.keeper.at(-1)?.request.turns;
    expect(prefix).toHaveLength(CAST_LIMITS.turns);
    expect(prefix?.[0]?.content).toBe("Noor breaks her leg and leaves");
    const departed: CastChanges = {
      ...upsert("Noor", { injuries: "broken leg" }),
      absent: ["Noor"],
    };
    await chat.answer(departed);
    expect(chat.state().cast.snapshots).toEqual(before);
    expect(chat.state().cast.status).toBe("updating");
    expect(chat.keeper.at(-1)?.request.turns).toHaveLength(4);
    expect(chat.keeper.at(-1)?.request.register.entries[0]?.state).toMatchObject({
      present: false,
      injuries: "broken leg",
    });
    await chat.refuse("unreachable");
    expect(chat.state().cast.snapshots).toEqual(before);
    expect(stale(chat.state())).toBe(true);

    chat.state().retryCast();
    await tick();
    expect(chat.keeper.at(-1)?.request.turns.map((turn) => turn.content)).toEqual([
      "Later 6",
      "reply 8",
      "Later 7",
      "reply 9",
    ]);
    expect(chat.keeper).toHaveLength(4);
    expect(chat.keeper.at(-1)?.request.register.entries[0]?.state).toMatchObject({
      present: false,
      injuries: "broken leg",
    });
    await chat.answer({ cast: {}, absent: [] });
    expect(entry(chat.state(), "Noor")?.state).toMatchObject({
      present: false,
      injuries: "broken leg",
    });
    expect(stale(chat.state())).toBe(false);
  });

  it("finishes an earlier gap while appends coalesce, then covers the newest target without rereading", async () => {
    const chat = castChat();
    await chat.say("Base");
    await chat.answer(upsert("Noor"));
    chat.castSettings.model = null;
    for (let i = 0; i < 8; i++) await chat.say(`Missed ${i}`);
    const target = shownId(chat.state(), 8) ?? "";
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.say("Appended during batch one");
    expect(chat.keeper).toHaveLength(2);
    expect(chat.keeper[1]?.signal.aborted).toBe(false);
    await chat.answer(upsert("Noor", { injuries: "broken leg" }));
    expect(chat.keeper).toHaveLength(3);
    await chat.say("Appended during batch two");
    await chat.say("Newest target");
    const newest = shownId(chat.state(), 11) ?? "";
    expect(chat.keeper).toHaveLength(3);
    expect(chat.keeper[2]?.signal.aborted).toBe(false);
    expect(chat.state().cast.snapshots[target]).toBeUndefined();
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.state().cast.snapshots[target]).toBeDefined();
    expect(chat.state().cast.snapshots[newest]).toBeUndefined();
    expect(chat.keeper).toHaveLength(4);
    expect(chat.keeper[3]?.request.turns).toHaveLength(6);
    expect(chat.keeper[3]?.request.register.entries[0]?.state.injuries).toBe("broken leg");
    const actual = chat.keeper
      .slice(1)
      .flatMap((call) => call.request.turns.map((turn) => turn.content));
    expect(actual).toEqual(
      chat
        .state()
        .messages.slice(2)
        .map((message) => (message.role === "user" ? message.text : shownReply(message).text)),
    );
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.state().cast.snapshots[newest]).toBeDefined();
    expect(chat.state().cast.status).toBe("idle");
    expect(stale(chat.state())).toBe(false);
  });

  it("extends a failed batch continuation on a later append and keeps private identities and bookkeeping", async () => {
    const chat = castChat();
    await chat.say("Base");
    await chat.answer(upsert("Noor"));
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    chat.castSettings.model = null;
    for (let i = 0; i < 8; i++) await chat.say(`Missed ${i}`);
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.answer({
      cast: { Noor: { state: { outfit: "towel" } }, Wren: { gender: "female" } },
      absent: [],
    });
    const wren = chat.keeper
      .at(-1)
      ?.request.register.entries.find((person) => person.anchor.name === "Wren");
    expect(wren?.id).toBeDefined();
    expect(names(chat.state())).toEqual(["Noor"]);
    await chat.refuse("timeout");
    await chat.say("Extended target");
    expect(chat.keeper).toHaveLength(4);
    expect(chat.keeper.at(-1)?.request.turns.map((turn) => turn.content)).toEqual([
      "Missed 6",
      "reply 8",
      "Missed 7",
      "reply 9",
      "Extended target",
      "reply 10",
    ]);
    expect(
      chat.keeper.at(-1)?.request.register.entries.find((person) => person.anchor.name === "Wren")
        ?.id,
    ).toBe(wren?.id);
    await chat.answer({ cast: {}, absent: [] });
    expect(entry(chat.state(), "Wren")?.id).toBe(wren?.id);
    expect(entry(chat.state(), "Noor")?.state.outfit).toBe("towel");
    expect(chat.state().cast.corrections[uuid(100)]?.state).toBeUndefined();
  });

  it.each([
    "user edit",
    "assistant edit",
    "user deletion",
    "assistant deletion",
    "Undo",
    "Clear",
    "character",
    "persona",
    "model",
    "effort",
    "sheet",
    "memory",
    "correction",
    "revert",
    "removal",
    "restore",
  ] as const)("discards a completed private prefix on %s", async (fence) => {
    const chat = castChat();
    await chat.say("Base");
    await chat.answer(upsert("Noor", { outfit: "red dress" }));
    if (fence === "revert") chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    if (fence === "restore") chat.state().removeCast(uuid(100));
    chat.castSettings.model = null;
    for (let i = 0; i < 8; i++) await chat.say(`Missed ${i}`);
    if (fence === "Undo") chat.state().remove(chat.state().messages[2]?.id ?? "");
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.answer(upsert("Private person"));
    const pending = chat.keeper.length - 1;
    const target = shownId(chat.state(), 8) ?? "";
    // Undo must remain available, so its fence is exercised without another send.
    if (fence !== "Undo") await chat.say("Queued newest");
    const queued = shownId(chat.state(), 9) ?? "";
    if (fence === "user edit" || fence === "assistant edit")
      chat
        .state()
        .edit(chat.state().messages[fence === "user edit" ? 2 : 3]?.id ?? "", "Edited source");
    else if (fence === "user deletion" || fence === "assistant deletion")
      chat.state().remove(chat.state().messages[fence === "user deletion" ? 2 : 3]?.id ?? "");
    else if (fence === "Undo") chat.state().undoDelete();
    else if (fence === "Clear") chat.state().clear();
    else if (fence === "character") chat.selection.characterId = OTHER_CHARACTER;
    else if (fence === "persona") chat.selection.personaId = uuid(5);
    else if (fence === "model") chat.castSettings.model = "other-model";
    else if (fence === "effort") chat.castSettings.reasoning = "high";
    else if (fence === "sheet") await chat.sheet([SHEET_ENTRY]);
    else if (fence === "memory") chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE]));
    else if (fence === "correction")
      chat.state().correctCast(uuid(100), { state: { outfit: "blue robe" } });
    else if (fence === "revert") chat.state().revertCast(uuid(100), "outfit");
    else if (fence === "removal") chat.state().removeCast(uuid(100));
    else chat.state().restoreCast(uuid(100));
    await chat.answer(upsert("Late output"), pending);
    expect(chat.state().cast.snapshots[target]).toBeUndefined();
    expect(chat.state().cast.snapshots[queued]).toBeUndefined();
    expect(names(chat.state())).not.toContain("Private person");
    expect(names(chat.state())).not.toContain("Late output");
    // Context changes hand the authorized target to a fresh prefix.
    const restarts = [
      "model",
      "effort",
      "sheet",
      "memory",
      "correction",
      "revert",
      "removal",
      "restore",
    ].includes(fence);
    if (!restarts) {
      expect(chat.keeper).toHaveLength(pending + 1);
      expect(chat.state().cast.activeCall).toBeNull();
      chat.state().retryCast();
      await tick();
    }
    if (fence === "Clear") expect(chat.keeper).toHaveLength(pending + 1);
    else {
      expect(chat.keeper).toHaveLength(pending + 2);
      const request = chat.keeper.at(-1)?.request;
      expect(request?.turns).toHaveLength(CAST_LIMITS.turns);
      expect(request?.turns[0]?.content).toBe(
        fence === "user edit"
          ? "Edited source"
          : fence === "user deletion"
            ? "reply 2"
            : "Missed 0",
      );
      expect(request?.register.entries.map((person) => person.anchor.name)).not.toContain(
        "Private person",
      );
      if (["correction", "revert", "removal", "restore"].includes(fence))
        expect(chat.keeper[pending]?.signal.aborted).toBe(true);
    }
  });

  it("restarts a queued newest reply after corrections without committing an old private prefix", async () => {
    const chat = castChat();
    await chat.say("Base");
    await chat.answer(upsert("Noor", { outfit: "red dress" }));
    chat.castSettings.model = null;
    for (let i = 0; i < 8; i++) await chat.say(`Missed ${i}`);
    const oldTarget = shownId(chat.state(), 8) ?? "";
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.answer(upsert("Private person"));
    const oldCall = chat.keeper.length - 1;
    await chat.say("Queued newest");
    const newest = shownId(chat.state(), 9) ?? "";
    chat.state().correctCast(uuid(100), { anchor: { hair: "silver" } });
    chat.state().correctCast(uuid(100), { state: { outfit: "blue robe" } });
    chat.state().revertCast(uuid(100), "hair");
    expect(chat.keeper[oldCall]?.signal.aborted).toBe(true);
    await tick();
    expect(chat.keeper).toHaveLength(oldCall + 2);
    expect(chat.keeper.at(-1)?.request.turns[0]?.content).toBe("Missed 0");
    expect(chat.keeper.at(-1)?.request.register.entries).toHaveLength(1);
    expect(chat.keeper.at(-1)?.request.register.entries[0]).toMatchObject({
      anchor: { name: "Noor", hair: "" },
      state: { outfit: "blue robe" },
    });
    await chat.answer(upsert("Late output"), oldCall);
    expect(chat.state().cast.snapshots[oldTarget]).toBeUndefined();
    expect(chat.state().cast.snapshots[newest]).toBeUndefined();
    await chat.answer({ cast: { Noor: { state: { outfit: "coat" } } }, absent: [] });
    expect(chat.keeper.at(-1)?.request.turns).toHaveLength(6);
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.keeper).toHaveLength(oldCall + 3);
    expect(chat.state().cast.snapshots[oldTarget]).toBeUndefined();
    expect(chat.state().cast.snapshots[newest]).toBeDefined();
    expect(names(chat.state())).toEqual(["Noor"]);
    expect(entry(chat.state(), "Noor")?.state.outfit).toBe("coat");
    expect(stale(chat.state())).toBe(false);
  });

  it.each([
    "Clear",
    "source",
    "deletion",
    "character",
    "persona",
    "model null",
    "model",
    "effort",
    "sheet",
    "memory",
  ])(
    "checks current source, identity and context for a correction's scheduled restart on %s",
    async (fence) => {
      const chat = castChat();
      await chat.say("Base");
      await chat.answer(upsert("Noor"));
      chat.castSettings.model = null;
      for (let i = 0; i < 7; i++) await chat.say(`Missed ${i}`);
      chat.castSettings.model = "cast-model";
      chat.state().retryCast();
      await tick();
      await chat.say("Queued newest");
      // Let the sheet completion land between the correction and its restart microtask.
      if (fence === "sheet") {
        chat.sheets[0]?.settle({
          ok: true,
          current: true,
          sheet: {
            characterId: CHARACTER,
            fingerprint: FINGERPRINT,
            entries: [SHEET_ENTRY],
            revision: 0,
            updatedAt: 0,
          },
        });
        await Promise.resolve();
      }
      chat.state().correctCast(uuid(100), { state: { outfit: "coat" } });
      if (fence === "Clear") chat.state().clear();
      else if (fence === "source") chat.state().edit(chat.state().messages[2]?.id ?? "", "Edited");
      else if (fence === "deletion") chat.state().remove(chat.state().messages[2]?.id ?? "");
      else if (fence === "character") chat.selection.characterId = OTHER_CHARACTER;
      else if (fence === "persona") chat.selection.personaId = uuid(5);
      else if (fence === "model null") chat.castSettings.model = null;
      else if (fence === "model") chat.castSettings.model = "other-model";
      else if (fence === "effort") chat.castSettings.reasoning = "high";
      else if (fence === "memory")
        chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE]));
      await chat.answer(upsert("Late output"), 1);
      const restarts = ["model", "effort", "sheet", "memory"].includes(fence);
      expect(chat.keeper).toHaveLength(restarts ? 3 : 2);
      expect(chat.keeper[1]?.signal.aborted).toBe(true);
      if (restarts) {
        expect(chat.state().cast.activeCall).not.toBeNull();
        expect(chat.keeper[2]?.request.model).toBe(
          fence === "model" ? "other-model" : "cast-model",
        );
        if (fence === "effort") expect(chat.keeper[2]?.request.reasoning).toBe("high");
        if (fence === "sheet") expect(chat.keeper[2]?.request.sheetFingerprint).toBe(FINGERPRINT);
        if (fence === "memory") expect(chat.keeper[2]?.request.register.entries).toHaveLength(2);
      } else expect(chat.state().cast.activeCall).toBeNull();
      expect(names(chat.state())).not.toContain("Late output");
      expect(Object.keys(chat.state().cast.snapshots)).toHaveLength(fence === "Clear" ? 0 : 1);
    },
  );

  it("restarts the active multibatch target after corrections without a queued new reply", async () => {
    const chat = castChat();
    await chat.say("Base");
    await chat.answer(upsert("Noor"));
    chat.castSettings.model = null;
    for (let i = 0; i < 7; i++) await chat.say(`Missed ${i}`);
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.answer(upsert("Private output"));
    const newest = shownId(chat.state(), 7) ?? "";
    const oldCall = chat.keeper.length - 1;
    chat.state().correctCast(uuid(100), { state: { outfit: "coat" } });
    await chat.answer(upsert("Late output"), oldCall);
    expect(chat.keeper).toHaveLength(oldCall + 2);
    expect(chat.keeper[oldCall]?.signal.aborted).toBe(true);
    expect(chat.keeper.at(-1)?.request.turns[0]?.content).toBe("Missed 0");
    expect(chat.keeper.at(-1)?.request.register.entries[0]?.state.outfit).toBe("coat");
    await chat.answer({ cast: {}, absent: [] });
    await chat.answer({ cast: {}, absent: [] });
    expect(
      chat.keeper
        .slice(oldCall + 1)
        .flatMap((call) => call.request.turns.map((turn) => turn.content)),
    ).toEqual(
      chat
        .state()
        .messages.slice(2)
        .map((message) => (message.role === "user" ? message.text : shownReply(message).text)),
    );
    expect(Object.keys(chat.state().cast.snapshots)).toEqual([shownId(chat.state(), 0), newest]);
    expect(chat.keeper).toHaveLength(oldCall + 3);
    expect(names(chat.state())).toEqual(["Noor"]);
    expect(stale(chat.state())).toBe(false);
  });

  it.each(["Clear", "character", "persona"])("fences partial batches on %s", async (fence) => {
    const chat = castChat();
    await chat.say("First turn");
    await chat.refuse("cast_failed");
    chat.castSettings.model = null;
    for (let i = 0; i < 6; i++) await chat.say(`Turn ${i}`);
    chat.castSettings.model = "cast-model";
    chat.state().retryCast();
    await tick();
    await chat.answer(upsert("Partial"));
    expect(chat.keeper).toHaveLength(3);
    expect(chat.state().cast.snapshots).toEqual({});
    if (fence === "Clear") chat.state().clear();
    else if (fence === "character") chat.selection.characterId = OTHER_CHARACTER;
    else chat.selection.personaId = uuid(5);
    await chat.answer(upsert("Late"));
    expect(chat.state().cast.snapshots).toEqual({});
    expect(chat.state().cast.activeCall).toBeNull();
    expect(chat.state().cast.status).toBe("idle");
  });
});

describe("cast source mutations", () => {
  it("cancels a reserved keeper start when an older user source changes before readiness", async () => {
    const memory = deferred<CharacterMemory | undefined>();
    let loads = 0;
    const chat = castChat(() => (++loads === 1 ? Promise.resolve(undefined) : memory.promise));
    await chat.say("Original source");
    await chat.refuse("cast_failed");
    chat.state().retryCast();
    chat.state().retryCast();
    expect(loads).toBe(2);
    chat.state().edit(chat.state().messages[0]?.id ?? "", "Changed before ready");
    memory.resolve(undefined);
    await tick();
    expect(chat.keeper).toHaveLength(1);
    expect(chat.state().cast.snapshots).toEqual({});
    expect(chat.state().cast.activeCall).toBeNull();
    chat.state().retryCast();
    await tick();
    expect(chat.keeper.at(-1)?.request.turns[0]?.content).toBe("Changed before ready");
    await chat.answer(upsert("Noor"));
    expect(names(chat.state())).toEqual(["Noor"]);
  });

  for (const role of ["user", "assistant"] as const) {
    it(`invalidates an older ${role} turn and its dependents, rebuilding from the preceding snapshot`, async () => {
      const chat = castChat();
      await chat.say("Base");
      await chat.answer({
        cast: { Noor: { gender: "female" }, Wren: { gender: "female" } },
        absent: [],
      });
      const base = shownId(chat.state(), 0) ?? "";
      chat.state().correctCast(uuid(100), { anchor: { hair: "silver" } });
      chat.state().removeCast(uuid(101));
      await chat.say("Mara arrives");
      await chat.answer(upsert("Mara"));
      await chat.say("Later");
      await chat.answer({ cast: {}, absent: [] });
      const source = chat.state().messages[role === "user" ? 2 : 3];
      chat.state().edit(source?.id ?? "", "Mara arrives, corrected");
      expect(Object.keys(chat.state().cast.snapshots)).toEqual([base]);
      expect(stale(chat.state())).toBe(true);
      chat.state().retryCast();
      await tick();
      const request = chat.keeper.at(-1)?.request;
      expect(request?.turns).toHaveLength(4);
      expect(request?.turns[role === "user" ? 0 : 1]?.content).toBe("Mara arrives, corrected");
      expect(request?.register.entries.map((entry) => entry.anchor.name)).toEqual(["Noor", "Mara"]);
      expect(request?.register.entries[0]?.anchor.hair).toBe("silver");
      await chat.answer({ cast: { Mara: { state: { mood: "calm" } }, Wren: {} }, absent: [] });
      expect(entry(chat.state(), "Mara")?.id).toBe(uuid(102));
      expect(entry(chat.state(), "Noor")?.anchor.hair).toBe("silver");
      expect(names(chat.state())).not.toContain("Wren");
    });

    it(`restores dependent snapshots and fences pending work when an older ${role} is deleted and undone`, async () => {
      const chat = castChat();
      await chat.say("Base");
      await chat.answer(upsert("Base"));
      await chat.say("Older");
      await chat.answer(upsert("Noor"));
      await chat.say("Newest");
      await chat.answer(upsert("Wren"));
      const before = chat.state().cast.snapshots;
      await chat.say("Uncovered");
      chat.state().retryCast();
      await tick();
      const oldCall = chat.keeper.length - 1;
      chat.state().remove(chat.state().messages[role === "user" ? 2 : 3]?.id ?? "");
      expect(chat.keeper[oldCall]?.signal.aborted).toBe(true);
      expect(Object.keys(chat.state().cast.snapshots)).toEqual([shownId(chat.state(), 0)]);
      chat.state().retryCast();
      await tick();
      const deletedCall = chat.keeper.length - 1;
      chat.state().undoDelete();
      expect(chat.keeper[deletedCall]?.signal.aborted).toBe(true);
      expect(chat.state().cast.snapshots).toEqual(before);
      await chat.answer(upsert("Late deletion"), deletedCall);
      await chat.answer(upsert("Late original"), oldCall);
      expect(chat.state().cast.snapshots).toEqual(before);
    });

    it(`aborts and fences a pending keeper when its older ${role} source changes`, async () => {
      const chat = castChat();
      await chat.say("Older");
      await chat.answer(upsert("Noor"));
      await chat.say("Newest");
      const pending = chat.keeper.length - 1;
      chat.state().edit(chat.state().messages[role === "user" ? 0 : 1]?.id ?? "", "Changed source");
      expect(chat.keeper[pending]?.signal.aborted).toBe(true);
      expect(chat.state().cast.activeCall).toBeNull();
      await chat.answer(upsert("Stale"), pending);
      expect(chat.state().cast.snapshots).toEqual({});
      chat.state().retryCast();
      await tick();
      expect(chat.keeper.at(-1)?.request.turns[role === "user" ? 0 : 1]?.content).toBe(
        "Changed source",
      );
      await chat.answer(upsert("Noor"));
      expect(names(chat.state())).toEqual(["Noor"]);
    });
  }

  it("restores dependent recovery metadata when deletion of an older user turn is undone", async () => {
    const chat = castChat();
    await chat.say("Noor arrives");
    await chat.answer(upsert("Noor"));
    chat.state().correctCast(uuid(100), { anchor: { name: "Nora" }, state: { outfit: "coat" } });
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Edited arrival");
    const user = chat.state().messages[0]?.id ?? "";
    chat.state().remove(user);
    chat.state().undoDelete();
    chat.state().retryCast();
    await tick();
    expect(chat.keeper.at(-1)?.request.register.entries[0]).toMatchObject({
      id: uuid(100),
      anchor: { name: "Nora" },
      state: { outfit: "coat", present: false },
    });
    await chat.answer({ cast: { Nora: { state: { mood: "calm" } } }, absent: [] });
    expect(entry(chat.state(), "Nora")?.id).toBe(uuid(100));
  });
});

describe("cast snapshots", () => {
  it("follow the shown alternate; one without a snapshot reads stale", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("First"));
    await chat.state().swipe(1);
    await chat.answer(upsert("Second"));
    expect(names(chat.state())).toEqual(["Second"]);
    await chat.state().swipe(-1);
    expect(names(chat.state())).toEqual(["First"]);
    expect(stale(chat.state())).toBe(false);
    await chat.state().swipe(1);
    await chat.state().swipe(1);
    await chat.refuse("cast_failed");
    expect(names(chat.state())).toEqual([]);
    expect(stale(chat.state())).toBe(true);
  });

  it("keep a replaced alternate's snapshot until the Regenerate completes, and put it back when it fails", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("First"));
    const first = shownId(chat.state(), 0) ?? "";
    chat.script.push("fail");
    await chat.state().regenerate();
    expect(shownId(chat.state(), 0)).toBe(first);
    expect(names(chat.state())).toEqual(["First"]);
    await chat.state().regenerate();
    expect(chat.state().cast.snapshots[first]).toBeUndefined();
    await chat.answer(upsert("Again"));
    expect(names(chat.state())).toEqual(["Again"]);
  });

  it("are replaced by a Continue, which reads the whole continued reply", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("First"));
    await chat.state().continueReply();
    await tick();
    expect(chat.keeper[1]?.request.register.entries).toEqual([]);
    expect(chat.keeper[1]?.request.turns.at(-1)?.content).toBe("reply 1 reply 2");
    // The previous snapshot shows while the call runs.
    expect(names(chat.state())).toEqual(["First"]);
    await chat.answer(upsert("Continued"));
    expect(names(chat.state())).toEqual(["Continued"]);
  });

  it("go when the newest reply is edited, and a late answer for its old text is dropped", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("First"));
    await chat.say("Next");
    const second = replyMessage(chat.state(), 1)?.id ?? "";
    chat.state().edit(second, "edited");
    await chat.answer(upsert("Late"));
    expect(names(chat.state())).toEqual(["First"]);
    expect(stale(chat.state())).toBe(true);

    // Editing an earlier reply also invalidates snapshots derived from it.
    await chat.state().retryCast();
    await chat.answer(upsert("Second"));
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "earlier edit");
    expect(chat.state().cast.snapshots).toEqual({});
    expect(names(chat.state())).toEqual([]);
  });

  it("move with a deleted tail and come back with Undo", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("First"));
    await chat.say("Next");
    await chat.answer(upsert("Second"));
    const second = shownId(chat.state(), 1) ?? "";
    chat.state().removeFrom(chat.state().messages[2]?.id ?? "");
    expect(chat.state().cast.snapshots[second]).toBeUndefined();
    expect(names(chat.state())).toEqual(["First"]);
    chat.state().undoDelete();
    expect(names(chat.state())).toEqual(["First", "Second"]);

    // Deleting an earlier reply invalidates its dependent snapshots; Undo restores them.
    chat.state().remove(chat.state().messages[1]?.id ?? "");
    expect(chat.state().cast.snapshots[second]).toBeUndefined();
    chat.state().undoDelete();
    expect(chat.state().cast.snapshots[second]).toBeDefined();
  });

  it("seed from the greeting once the sheet lands, and again after a refill", async () => {
    const chat = castChat();
    chat.state().setGreetings(["Hello there"]);
    expect(chat.sheets).toHaveLength(1);
    expect(chat.state().cast.sheetStatus).toBe("loading");
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.keeper[0]?.request).toMatchObject({
      mode: "seed",
      sheetFingerprint: FINGERPRINT,
      turns: [{ role: "assistant", content: "Hello there" }],
    });
    expect(chat.keeper[0]?.request.register.entries.map((e) => e.anchor.name)).toEqual([
      "Ava Lind",
    ]);
    await chat.answer(upsert("Ava Lind", { outfit: "coat" }));
    const greeting = shownId(chat.state(), 0) ?? "";
    expect(chat.state().cast.snapshots[greeting]).toBeDefined();

    chat.state().setGreetings(["Hello again"]);
    expect(chat.sheets).toHaveLength(1);
    expect(chat.state().cast.snapshots[greeting]).toBeUndefined();
    expect(chat.keeper).toHaveLength(2);
    expect(chat.keeper[1]?.request.turns).toEqual([{ role: "assistant", content: "Hello again" }]);
  });

  it("keep the greeting's snapshot through a refill to the same text (the chat shown again)", async () => {
    const chat = castChat();
    chat.state().setGreetings(["Hello there"]);
    await chat.sheet([SHEET_ENTRY]);
    await chat.answer(upsert("Ava Lind", { outfit: "coat" }));
    const greeting = shownId(chat.state(), 0) ?? "";

    chat.state().setGreetings(["Hello there"]);
    expect(chat.state().cast.snapshots[greeting]).toBeDefined();
    expect(chat.keeper).toHaveLength(1);
    expect(entry(chat.state(), "Ava Lind")?.state.outfit).toBe("coat");
  });
});

describe("cast corrections", () => {
  async function withIlse() {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Ilse", { outfit: "red dress" }));
    return chat;
  }

  it.each([
    ["anchor", "correction"],
    ["state", "correction"],
    ["anchor", "revert"],
    ["state", "revert"],
  ] as const)("keeps a queued newest reply through a single-call %s %s", async (kind, action) => {
    const chat = await withIlse();
    const patch =
      kind === "anchor" ? { anchor: { hair: "silver" } } : { state: { outfit: "coat" } };
    const field = kind === "anchor" ? "hair" : "outfit";
    if (action === "revert") chat.state().correctCast(uuid(100), patch);
    await tick();
    expect(chat.keeper).toHaveLength(1);
    await chat.say("A");
    const earlier = shownId(chat.state(), 1) ?? "";
    await chat.say("B");
    const newest = shownId(chat.state(), 2) ?? "";
    expect(chat.keeper).toHaveLength(2);
    if (action === "correction") chat.state().correctCast(uuid(100), patch);
    else chat.state().revertCast(uuid(100), field);
    expect(chat.keeper[1]?.signal.aborted).toBe(false);
    await chat.answer({ cast: { Ilse: { state: { mood: "calm" } } }, absent: [] }, 1);
    expect(chat.state().cast.snapshots[earlier]).toBeDefined();
    expect(chat.state().cast.snapshots[newest]).toBeUndefined();
    expect(chat.keeper).toHaveLength(3);
    const expected =
      action === "correction"
        ? kind === "anchor"
          ? "silver"
          : "coat"
        : kind === "anchor"
          ? ""
          : "red dress";
    const current = entry(chat.state(), "Ilse");
    const sent = chat.keeper[2]?.request.register.entries[0];
    expect(kind === "anchor" ? current?.anchor.hair : current?.state.outfit).toBe(expected);
    expect(kind === "anchor" ? sent?.anchor.hair : sent?.state.outfit).toBe(expected);
    expect(chat.keeper[2]?.request.turns.map((turn) => turn.content)).toEqual(["B", "reply 3"]);
    await chat.answer({ cast: { Ilse: { state: { outfit: "towel" } } }, absent: [] });
    expect(chat.state().cast.snapshots[newest]).toBeDefined();
    expect(chat.keeper).toHaveLength(3);
    expect(entry(chat.state(), "Ilse")?.state.outfit).toBe("towel");
    if (kind === "anchor") expect(entry(chat.state(), "Ilse")?.anchor.hair).toBe(expected);
    expect(stale(chat.state())).toBe(false);
  });

  it("hold for anchors; a state correction yields to the next snapshot", async () => {
    const chat = await withIlse();
    chat.state().correctCast(uuid(100), { anchor: { age: "41", eyes: "green" } });
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    expect(entry(chat.state(), "Ilse")?.anchor).toMatchObject({ age: "41", eyes: "green" });
    await chat.say("Next");
    expect(chat.keeper[1]?.request.register.entries[0]?.state.outfit).toBe("grey coat");
    await chat.answer({
      cast: { Ilse: { anchor: { age: "20" }, state: { outfit: "nothing" } } },
      absent: [],
    });
    expect(entry(chat.state(), "Ilse")?.anchor.age).toBe("41");
    expect(entry(chat.state(), "Ilse")?.state.outfit).toBe("nothing");
    expect(chat.state().cast.corrections[uuid(100)]?.state).toEqual({});
  });

  it("on anchors stay out of later snapshots: a Revert shows the recorded value again", async () => {
    const chat = await withIlse();
    chat.state().correctCast(uuid(100), { anchor: { age: "41", name: "Ilse Brandt" } });
    await chat.say("Next");
    expect(chat.keeper[1]?.request.register.entries[0]?.anchor).toMatchObject({
      name: "Ilse Brandt",
      age: "41",
    });
    await chat.answer({
      cast: { "Ilse Brandt": { anchor: { age: "20", hair: "black" }, state: { mood: "calm" } } },
      absent: [],
    });
    expect(entry(chat.state(), "Ilse Brandt")?.anchor).toMatchObject({ age: "41", hair: "black" });
    const snapshot = chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""];
    expect(snapshot?.register.entries[0]?.anchor).toMatchObject({ name: "Ilse", age: "30" });
    chat.state().revertCast(uuid(100), "age");
    chat.state().revertCast(uuid(100), "name");
    expect(entry(chat.state(), "Ilse")?.anchor).toMatchObject({ age: "30", hair: "black" });
    expect(entry(chat.state(), "Ilse")?.state.mood).toBe("calm");
  });

  it("made while a call runs survive it and go into the next base", async () => {
    const chat = await withIlse();
    await chat.say("Next");
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    await chat.answer({ cast: { Ilse: { state: { outfit: "towel" } } }, absent: [] });
    expect(entry(chat.state(), "Ilse")?.state.outfit).toBe("grey coat");
    await chat.say("Third");
    expect(chat.keeper[2]?.request.register.entries[0]?.state.outfit).toBe("grey coat");
  });

  it("are taken back by revertCast", async () => {
    const chat = await withIlse();
    chat.state().correctCast(uuid(100), { anchor: { age: "41" }, state: { outfit: "coat" } });
    chat.state().revertCast(uuid(100), "age");
    expect(entry(chat.state(), "Ilse")?.anchor.age).toBe("30");
    expect(entry(chat.state(), "Ilse")?.state.outfit).toBe("coat");
    chat.state().revertCast(uuid(100), "outfit");
    expect(entry(chat.state(), "Ilse")?.state.outfit).toBe("red dress");
    expect(chat.state().cast.corrections).toEqual({});
  });

  it("remove an entry from requests and the keeper's base; a re-mention does not add it again, and restore brings it back", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer({
      cast: { "Ilse Brandt": { gender: "female" }, Mara: { gender: "female" } },
      absent: [],
    });
    chat.state().removeCast(uuid(100));
    expect(names(chat.state())).toEqual(["Mara"]);
    await chat.state().requestPreview();
    expect(chat.previews.at(-1)?.cast?.entries.map((e) => e.anchor.name)).toEqual(["Mara"]);
    await chat.say("Next");
    expect(chat.generated[1]?.cast?.entries.map((e) => e.anchor.name)).toEqual(["Mara"]);
    expect(chat.keeper[1]?.request.register.entries.map((e) => e.anchor.name)).toEqual(["Mara"]);
    await chat.answer({ cast: { Ilse: { state: { outfit: "coat" } } }, absent: [] });
    expect(names(chat.state())).toEqual(["Mara"]);
    const snapshot = chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""];
    expect(snapshot?.register.entries.filter((e) => e.anchor.name.startsWith("Ilse"))).toHaveLength(
      1,
    );
    chat.state().restoreCast(uuid(100));
    expect(names(chat.state())).toEqual(["Ilse Brandt", "Mara"]);
    expect(entry(chat.state(), "Ilse Brandt")?.state.present).toBe(true);
  });
});

describe("cast sheet", () => {
  it("landing after a send overlays the register without a seed; the next call names its fingerprint", async () => {
    const chat = castChat();
    chat.state().setGreetings(["Hello"]);
    await chat.say("Hi");
    expect(chat.keeper[0]?.request.sheetFingerprint).toBeNull();
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.keeper).toHaveLength(1);
    // The overlay applies at once, while the keeper call runs.
    expect(names(chat.state())).toEqual(["Ava Lind"]);
    await chat.answer(upsert("Ilse"));
    expect(names(chat.state())).toEqual(["Ilse", "Ava Lind"]);
    await chat.say("Next");
    expect(chat.generated[1]?.cast?.entries.map((e) => e.anchor.name)).toEqual([
      "Ilse",
      "Ava Lind",
    ]);
    expect(chat.keeper[1]?.request.sheetFingerprint).toBe(FINGERPRINT);
  });

  it("is dropped after Clear or a character change, and a failed one names no fingerprint", async () => {
    const chat = castChat();
    chat.state().setGreetings(["Hello"]);
    chat.state().clear();
    expect(chat.sheets[0]?.signal.aborted).toBe(true);
    await chat.sheet([SHEET_ENTRY], 0);
    expect(chat.state().cast.sheet).toBeNull();

    chat.state().setGreetings(["Hello"]);
    chat.selection.characterId = OTHER_CHARACTER;
    await chat.sheet([SHEET_ENTRY], 1);
    expect(chat.state().cast.sheet).toBeNull();

    chat.selection.characterId = CHARACTER;
    chat.state().clear();
    chat.state().setGreetings(["Hello"]);
    chat.sheets.at(-1)?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    expect(chat.state().cast.sheetStatus).toBe("failed");
    await chat.say("Hi");
    expect(chat.keeper.at(-1)?.request.sheetFingerprint).toBeNull();
  });
});

describe("cast sheet and the chat's character", () => {
  it("is asked for when a chat starts with a character without greetings; the first reply is read", async () => {
    const chat = castChat();
    chat.state().setGreetings([]);
    expect(chat.sheets.map((sheet) => sheet.characterId)).toEqual([CHARACTER]);
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.keeper).toHaveLength(0);
    await chat.say("Hi");
    expect(chat.generated[0]?.cast?.entries.map((e) => e.anchor.name)).toEqual(["Ava Lind"]);
    expect(chat.keeper[0]?.request).toMatchObject({
      mode: "update",
      sheetFingerprint: FINGERPRINT,
    });
  });

  it("follows a character changed in a chat under way", async () => {
    const chat = castChat();
    chat.state().setGreetings([]);
    await chat.sheet([SHEET_ENTRY]);
    await chat.say("Hi");
    await chat.answer(upsert("Ilse"));
    chat.selection.characterId = OTHER_CHARACTER;
    await chat.say("Next");
    expect(chat.sheets.map((sheet) => sheet.characterId)).toEqual([CHARACTER, OTHER_CHARACTER]);
    expect(chat.generated[1]?.cast?.entries.map((e) => e.anchor.name)).toEqual([
      "Ava Lind",
      "Ilse",
    ]);
    expect(chat.keeper[1]?.request).toMatchObject({
      characterId: OTHER_CHARACTER,
      sheetFingerprint: null,
    });
    expect(chat.state().cast).toMatchObject({ sheet: null, sheetStatus: "loading" });
    const other = {
      ...SHEET_ENTRY,
      id: uuid(2),
      anchor: { ...SHEET_ENTRY.anchor, name: "Noor Haddad" },
    };
    await chat.sheet([other]);
    expect(names(chat.state())).toEqual(["Ava Lind", "Ilse", "Noor Haddad"]);
  });
});

describe("cast people in a scene", () => {
  it("go with the scene as they were at the press, its retry included", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Ilse", { outfit: "red dress" }));
    chat.state().pictureScene();
    await tick();
    expect(chat.scenes[0]?.source).toContain("<people>");
    expect(chat.scenes[0]?.source).toContain("red dress");
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    chat.state().retryScene(chat.state().scenes[0]?.id ?? "");
    await tick();
    expect(chat.scenes[1]?.source).toBe(chat.scenes[0]?.source);
  });
});

describe("cast fixes", () => {
  it("keep the ids a Continue's reply gave, with their corrections and removal", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer({
      cast: { Noor: { gender: "female", anchor: { age: "30" } }, Wren: { gender: "female" } },
      absent: [],
    });
    chat.state().correctCast(uuid(100), { anchor: { hair: "silver" } });
    chat.state().removeCast(uuid(101));
    await chat.state().continueReply();
    await tick();
    await chat.answer({ cast: { Noor: { state: { mood: "calm" } }, Wren: {} }, absent: [] });
    expect(currentRegister(chat.state()).entries.map((e) => [e.id, e.anchor.name])).toEqual([
      [uuid(100), "Noor"],
    ]);
    expect(entry(chat.state(), "Noor")?.anchor.hair).toBe("silver");
    expect(entry(chat.state(), "Noor")?.state.mood).toBe("calm");
  });

  it("keep the ids an edited newest reply gave when it is read again", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Noor"));
    chat.state().correctCast(uuid(100), { anchor: { hair: "silver" } });
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "edited");
    expect(stale(chat.state())).toBe(true);
    chat.state().retryCast();
    await chat.answer(upsert("Noor", { mood: "calm" }));
    expect(currentRegister(chat.state()).entries.map((e) => e.id)).toEqual([uuid(100)]);
    expect(entry(chat.state(), "Noor")?.anchor.hair).toBe("silver");
  });

  it("leave a state correction reverted while the call ran out of its snapshot", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Ilse", { outfit: "red dress" }));
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    await chat.say("Next");
    expect(chat.keeper[1]?.request.register.entries[0]?.state.outfit).toBe("grey coat");
    chat.state().revertCast(uuid(100), "outfit");
    await chat.answer({ cast: { Ilse: { state: { mood: "calm" } } }, absent: [] });
    expect(entry(chat.state(), "Ilse")?.state).toMatchObject({ outfit: "red dress", mood: "calm" });
  });

  it("cut a correction to the register's bounds, so the next request stays valid", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Ilse"));
    chat.state().correctCast(uuid(100), {
      anchor: { hair: "long ".repeat(100) },
      state: { outfit: "x".repeat(CAST_LIMITS.field + 50) },
    });
    chat.state().correctCast(uuid(100), { anchor: { name: " " } });
    expect(castRegisterSchema.safeParse(currentRegister(chat.state())).success).toBe(true);
    expect(entry(chat.state(), "Ilse")?.anchor.hair.length).toBeLessThanOrEqual(CAST_LIMITS.field);
  });

  it("acknowledge no sheet read from the card as it was", async () => {
    const chat = castChat();
    chat.state().setGreetings(["Hello"]);
    await chat.sheet([SHEET_ENTRY], -1, false);
    expect(chat.state().cast).toMatchObject({ sheet: null, sheetStatus: "failed" });
    expect(chat.keeper).toHaveLength(0);
  });

  it("let a Continue stopped after adding text read stale, for the next call to catch up", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Ilse"));
    chat.script.push("stop");
    await chat.state().continueReply();
    await tick();
    expect(chat.keeper).toHaveLength(1);
    expect(stale(chat.state())).toBe(true);
    await chat.say("Next");
    expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual([
      "Hi",
      "reply 1 reply 2",
      "Next",
      "reply 3",
    ]);
  });

  it("schedule a preview when a snapshot or a sheet lands and on every correction", async () => {
    const chat = castChat();
    chat.state().setGreetings([]);
    await chat.say("Hi");
    const scheduled = vi.fn();
    chat.store.setState({ schedulePreview: scheduled });
    const schedules = async (act: () => unknown) => {
      scheduled.mockClear();
      await act();
      return scheduled.mock.calls.length > 0;
    };
    expect(await schedules(() => chat.sheet([SHEET_ENTRY]))).toBe(true);
    expect(await schedules(() => chat.answer(upsert("Ilse")))).toBe(true);
    const correct = () => chat.state().correctCast(uuid(100), { anchor: { hair: "red" } });
    expect(await schedules(correct)).toBe(true);
    expect(await schedules(() => chat.state().revertCast(uuid(100), "hair"))).toBe(true);
    expect(await schedules(() => chat.state().removeCast(uuid(100)))).toBe(true);
    expect(await schedules(() => chat.state().restoreCast(uuid(100)))).toBe(true);
  });
});

describe("identities across a catch-up", () => {
  /** Noor and Wren introduced by the newest reply; Noor corrected, Wren removed. */
  async function introduced() {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer({
      cast: {
        Noor: { gender: "female", state: { outfit: "red dress" } },
        Wren: { gender: "female" },
      },
      absent: [],
    });
    chat.state().correctCast(uuid(100), { anchor: { hair: "silver" } });
    chat.state().removeCast(uuid(101));
    return chat;
  }
  const catchUp = { cast: { Noor: { state: { mood: "calm" } }, Wren: {} }, absent: [] };
  const expectKept = (chat: ReturnType<typeof castChat>) => {
    const snapshot = chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""];
    expect(snapshot?.register.entries.map((e) => e.id)).toEqual([uuid(100), uuid(101)]);
    expect(currentRegister(chat.state()).entries.map((e) => e.id)).toEqual([uuid(100)]);
    expect(entry(chat.state(), "Noor")?.anchor.hair).toBe("silver");
    expect(entry(chat.state(), "Noor")?.state.mood).toBe("calm");
  };

  it("survive an edit of the newest reply and the next message", async () => {
    const chat = await introduced();
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Noor and Wren, edited");
    await chat.say("Next");
    expect(chat.keeper[1]?.request.turns).toHaveLength(4);
    await chat.answer(catchUp);
    expectKept(chat);
  });

  it("survive a Continue stopped after adding text and the next message", async () => {
    const chat = await introduced();
    chat.script.push("stop");
    await chat.state().continueReply();
    await tick();
    await chat.say("Next");
    expect(chat.keeper[1]?.request.turns).toHaveLength(4);
    await chat.answer(catchUp);
    expectKept(chat);
  });

  it("survive an edit, a deletion of that reply and its Undo", async () => {
    const chat = await introduced();
    const reply = replyMessage(chat.state(), 0)?.id ?? "";
    chat.state().edit(reply, "Noor and Wren, edited");
    chat.state().remove(reply);
    chat.state().undoDelete();
    expect(stale(chat.state())).toBe(true);
    await chat.say("Next");
    await chat.answer(catchUp);
    expectKept(chat);
  });

  it("keep a state correction on an entry the re-read reply introduced", async () => {
    const chat = await introduced();
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Noor and Wren, edited");
    await chat.say("Next");
    expect(chat.keeper[1]?.request.register.entries[0]).toMatchObject({
      id: uuid(100),
      anchor: { hair: "silver" },
      state: { present: false, outfit: "grey coat", injuries: "" },
    });
    await chat.answer(catchUp);
    expect(entry(chat.state(), "Noor")?.state).toMatchObject({ outfit: "grey coat", mood: "calm" });
  });

  it("lets the catch-up supersede the corrected field it sent", async () => {
    const chat = await introduced();
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Noor and Wren, edited");
    await chat.say("Next");
    expect(chat.keeper[1]?.request.register.entries[0]?.state.outfit).toBe("grey coat");
    await chat.answer({ cast: { Noor: { state: { outfit: "towel" } } }, absent: [] });
    const snapshot = () => chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""];
    expect(snapshot()?.register.entries[0]).toMatchObject({
      id: uuid(100),
      state: { outfit: "towel" },
    });
    expect(entry(chat.state(), "Noor")?.state.outfit).toBe("towel");
    expect(chat.state().cast.corrections[uuid(100)]?.state).toEqual({});

    await chat.say("Third");
    expect(chat.keeper[2]?.request.register.entries[0]?.state.outfit).toBe("towel");
    await chat.answer({ cast: { Noor: { state: { outfit: "nothing" } } }, absent: [] });
    expect(chat.state().cast.corrections[uuid(100)]?.state).toEqual({});
    expect(entry(chat.state(), "Noor")?.state.outfit).toBe("nothing");
  });
});

describe("the chat's identity index", () => {
  /** Noor and Wren introduced by the newest reply; Noor corrected, Wren removed. */
  async function introduced() {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer({
      cast: { Noor: { gender: "female" }, Wren: { gender: "female" } },
      absent: [],
    });
    chat.state().correctCast(uuid(100), { anchor: { hair: "silver" } });
    chat.state().removeCast(uuid(101));
    return chat;
  }
  const ids = (chat: ReturnType<typeof castChat>) =>
    Object.values(chat.state().cast.snapshots).flatMap((snapshot) =>
      snapshot.register.entries.map((e) => e.id),
    );

  it("keeps a removed person removed after a catch-up that left her out", async () => {
    const chat = await introduced();
    chat.script.push("stop");
    await chat.state().continueReply();
    await tick();
    await chat.say("Next");
    await chat.answer({ cast: { Noor: { state: { mood: "calm" } } }, absent: [] });
    await chat.say("Third");
    await chat.answer({ cast: { Wren: { state: { mood: "back" } } }, absent: [] });
    expect(names(chat.state())).toEqual(["Noor"]);
    expect(new Set(ids(chat))).toEqual(new Set([uuid(100), uuid(101)]));
    expect(entry(chat.state(), "Noor")?.anchor.hair).toBe("silver");
  });

  it("keeps a person's id after the reply that caught her up is deleted", async () => {
    const chat = await introduced();
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Noor, edited");
    await chat.say("Next");
    await chat.answer({ cast: { Noor: { state: { mood: "calm" } } }, absent: [] });
    // The catch-up's reply goes; the edited one has no snapshot either now.
    chat.state().removeFrom(chat.state().messages[2]?.id ?? "");
    expect(Object.keys(chat.state().cast.snapshots)).toEqual([]);
    await chat.say("Again");
    await chat.answer({ cast: { Noor: { state: { mood: "warm" } } }, absent: [] });
    expect(currentRegister(chat.state()).entries.map((e) => e.id)).toEqual([uuid(100)]);
    expect(entry(chat.state(), "Noor")?.anchor.hair).toBe("silver");
  });

  it("forgets every identity on Clear", async () => {
    const chat = await introduced();
    chat.state().clear();
    await chat.say("Hi");
    await chat.answer({ cast: { Noor: { gender: "female" } }, absent: [] });
    expect(currentRegister(chat.state()).entries.map((e) => e.id)).toEqual([uuid(102)]);
  });
});

describe("a sheet that could not be read", () => {
  it.each(["failed", "null", "identical"] as const)(
    "queues reselected B1 behind A's paid prefix until its explicit sheet reload is %s",
    async (reload) => {
      const chat = castChat();
      chat.store.setState({
        cast: { ...chat.state().cast, sheet: { fingerprint: FINGERPRINT, entries: [] } },
      });
      await chat.say("A");
      const a = shownId(chat.state(), 0) ?? "";
      await chat.refuse("prompt_too_long");
      await chat.answer(upsert("Noor", { mood: "paid prefix" }));
      const active = chat.keeper[2];
      await chat.say("B");
      const b1 = shownId(chat.state(), 1) ?? "";
      await chat.state().swipe(1);
      const b2 = shownId(chat.state(), 1) ?? "";
      await chat.state().swipe(-1);
      expect(shownId(chat.state(), 1)).toBe(b1);
      chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
      await tick();
      chat.state().retryCast();
      chat.state().retryCast();
      await tick();
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper).toHaveLength(3);
      expect(active?.signal.aborted).toBe(false);
      expect(chat.state().cast.snapshots).toEqual({});

      // A can finish while the new target's explicit sheet barrier is still held.
      await chat.answer({ cast: {}, absent: [] }, 2);
      expect(chat.state().cast.snapshots[a]).toBeDefined();
      expect(chat.keeper).toHaveLength(3);
      if (reload === "failed") chat.sheets[1]?.settle({ ok: false, reason: "timeout" });
      else if (reload === "null") chat.sheets[1]?.settle({ ok: true, current: true, sheet: null });
      else await chat.sheet([]);
      await tick();
      expect(chat.keeper).toHaveLength(4);
      expect(chat.keeper[3]?.request.turns.map((turn) => turn.content)).toEqual(["B", "reply 2"]);
      expect(chat.keeper[3]?.request.register.entries[0]?.state.mood).toBe("paid prefix");
      await chat.answer({ cast: {}, absent: [] });
      expect(Object.keys(chat.state().cast.snapshots)).toEqual([a, b1]);
      expect(chat.state().cast.snapshots[b2]).toBeUndefined();
      expect(chat.keeper).toHaveLength(4);
      expect(active?.signal.aborted).toBe(false);
    },
  );

  it.each(
    (["model", "effort"] as const).flatMap((context) =>
      (["failed", "null", "identical", "changed"] as const).map(
        (reload) => [context, reload] as const,
      ),
    ),
  )(
    "waits for the %s replacement's explicit sheet reload to settle as %s",
    async (context, reload) => {
      const chat = castChat();
      chat.store.setState({
        cast: { ...chat.state().cast, sheet: { fingerprint: FINGERPRINT, entries: [] } },
      });
      await chat.say("A");
      const target = shownId(chat.state(), 0) ?? "";
      chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
      await tick();
      if (context === "model") chat.castSettings.model = "other-model";
      else chat.castSettings.reasoning = "high";
      chat.state().retryCast();
      chat.state().retryCast();
      await tick();
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper[0]?.signal.aborted).toBe(true);
      expect(chat.keeper).toHaveLength(1);
      // Both late old-model output and repeated clicks must leave the barrier intact.
      await chat.answer(upsert("Late output"), 0);
      chat.state().retryCast();
      expect(chat.keeper).toHaveLength(1);
      chat.castSettings.model = "current-model";
      if (reload === "failed") chat.sheets[1]?.settle({ ok: false, reason: "timeout" });
      else if (reload === "null") chat.sheets[1]?.settle({ ok: true, current: true, sheet: null });
      else await chat.sheet(reload === "identical" ? [] : [SHEET_ENTRY]);
      await tick();
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.request).toMatchObject({
        model: "current-model",
        sheetFingerprint: reload === "null" ? null : FINGERPRINT,
        ...(context === "effort" ? { reasoning: "high" } : {}),
      });
      expect(chat.keeper[1]?.request.register.entries.map((entry) => entry.anchor.name)).toEqual(
        reload === "changed" ? ["Ava Lind"] : [],
      );
      await chat.answer(upsert("Noor"));
      expect(Object.keys(chat.state().cast.snapshots)).toEqual([target]);
      expect(names(chat.state())).not.toContain("Late output");
      expect(chat.keeper).toHaveLength(2);
    },
  );

  it.each(["pending", "active"] as const)(
    "reloads a failed sheet after a persona switch invalidates the %s keeper without a memory overlay",
    async (phase) => {
      const memory = deferred<CharacterMemory | undefined>();
      const disabled = remembered([], 1, false);
      let loads = 0;
      const chat = castChat(() =>
        phase === "pending"
          ? ++loads === 1
            ? Promise.resolve(undefined)
            : memory.promise
          : Promise.resolve(disabled),
      );
      await chat.say("First");
      const target = shownId(chat.state(), 0) ?? "";
      if (phase === "pending") {
        await chat.refuse("cast_failed");
        chat.state().retryCast();
        await tick();
        expect(loads).toBe(2);
      }
      chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
      await tick();
      expect(chat.state().cast.memory).toBeNull();
      expect(chat.state().cast.sheetStatus).toBe("failed");
      expect(chat.keeper).toHaveLength(1);

      chat.selection.personaId = uuid(5);
      await chat.state().requestPreview();
      chat.state().retryCast();
      chat.state().retryCast();
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper).toHaveLength(1);
      if (phase === "pending") memory.resolve(disabled);
      else {
        expect(chat.keeper[0]?.signal.aborted).toBe(true);
        await chat.answer(upsert("Old persona output"), 0);
      }
      await tick();
      expect(chat.state().cast.memory).toBeNull();
      expect(chat.state().cast.snapshots).toEqual({});
      expect(chat.keeper).toHaveLength(1);

      await chat.sheet([]);
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.request).toMatchObject({
        personaId: uuid(5),
        sheetFingerprint: FINGERPRINT,
        turns: [
          { role: "user", content: "First" },
          { role: "assistant", content: "reply 1" },
        ],
      });
      chat.state().retryCast();
      chat.state().retryCast();
      await tick();
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.signal.aborted).toBe(false);
      await chat.answer(upsert("Current persona output"));
      expect(Object.keys(chat.state().cast.snapshots)).toEqual([target]);
      expect(names(chat.state())).toEqual(["Current persona output"]);
      expect(stale(chat.state())).toBe(false);
      expect(chat.keeper).toHaveLength(2);
      expect(chat.sheets).toHaveLength(2);
    },
  );

  it("attaches a joined retry's sheet barrier while the prefix awaits notebook readiness", async () => {
    const memory = deferred<CharacterMemory | undefined>();
    let loads = 0;
    const chat = castChat(() => (++loads === 1 ? Promise.resolve(remembered([])) : memory.promise));
    await chat.say("A");
    await chat.refuse("cast_failed");
    chat.state().receiveCastMemory(CHARACTER, undefined);
    // The first click reserves A while its notebook reload holds keeper readiness.
    chat.state().retryCast();
    await tick();
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    chat.state().retryCast();
    chat.state().retryCast();
    expect(chat.sheets).toHaveLength(2);
    memory.resolve(undefined);
    await tick();
    expect(chat.keeper).toHaveLength(1);
    await chat.sheet([]);
    expect(chat.keeper).toHaveLength(2);
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.keeper).toHaveLength(2);
  });

  it("lets a pending older prefix become ready while its queued retry waits for the sheet", async () => {
    const memory = deferred<CharacterMemory | undefined>();
    const completion = deferred<void>();
    let loads = 0;
    let replies = 0;
    const chat = castChat(
      () => (++loads === 1 ? Promise.resolve(remembered([])) : memory.promise),
      async function* () {
        replies += 1;
        yield { text: `reply ${replies}` };
        if (replies === 2) await completion.promise;
      },
    );
    await chat.say("A");
    await chat.refuse("cast_failed");
    const sending = chat.say("B");
    await tick();
    chat.state().receiveCastMemory(CHARACTER, undefined);
    chat.state().retryCast();
    completion.resolve();
    await sending;
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    chat.state().retryCast();
    chat.state().retryCast();
    expect(chat.sheets).toHaveLength(2);
    memory.resolve(undefined);
    await tick();
    expect(chat.keeper).toHaveLength(2);
    expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual(["A", "reply 1"]);
    await chat.answer(upsert("Noor"));
    expect(chat.keeper).toHaveLength(2);
    await chat.sheet([]);
    expect(chat.keeper).toHaveLength(3);
    expect(chat.keeper[2]?.request.turns.map((turn) => turn.content)).toEqual(["B", "reply 2"]);
    expect(chat.keeper[2]?.request.register.entries.map((entry) => entry.anchor.name)).toEqual([
      "Noor",
    ]);
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.keeper).toHaveLength(3);
  });

  it("drops a joined invalid-context replacement if its source changes during the explicit sheet wait", async () => {
    const chat = castChat();
    await chat.say("A");
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    chat.castSettings.model = "other-model";
    chat.state().retryCast();
    await tick();
    expect(chat.keeper).toHaveLength(1);
    chat.state().edit(chat.state().messages[0]?.id ?? "", "Changed A");
    await chat.sheet([SHEET_ENTRY]);
    await chat.answer(upsert("Late output"), 0);
    expect(chat.keeper).toHaveLength(1);
    expect(chat.state().cast.snapshots).toEqual({});
    expect(chat.state().cast.activeCall).toBeNull();
    expect(names(chat.state())).not.toContain("Late output");
  });

  it.each([
    [null, "failed"],
    [null, "null"],
    [null, "changed entries"],
    ["sheet", "failed"],
    ["sheet", "identical"],
    ["sheet", "changed entries"],
    ["sheet", "changed fingerprint"],
  ] as const)(
    "joins the first keeper's paid prefix with prior %s and reload %s",
    async (prior, reload) => {
      const chat = castChat();
      if (prior !== null)
        chat.store.setState({
          cast: {
            ...chat.state().cast,
            sheet: { fingerprint: FINGERPRINT, entries: [SHEET_ENTRY] },
          },
        });
      await chat.say("Noor arrives");
      const target = shownId(chat.state(), 0) ?? "";
      await chat.refuse("prompt_too_long");
      expect(chat.keeper[1]?.request.turns).toHaveLength(1);
      await chat.answer(upsert("Noor", { mood: "private prefix" }));
      expect(chat.keeper).toHaveLength(3);
      const pending = chat.keeper[2];
      const acknowledged = chat.state().cast.sheet;
      const before = names(chat.state());
      expect(before).not.toContain("Noor");
      chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
      await tick();
      chat.state().retryCast();
      chat.state().retryCast();
      await tick();
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper).toHaveLength(3);
      expect(pending?.signal.aborted).toBe(false);
      expect(chat.state().cast.sheet).toBe(acknowledged);
      expect(chat.state().cast.snapshots[target]).toBeUndefined();
      if (reload === "failed") chat.sheets[1]?.settle({ ok: false, reason: "timeout" });
      else if (reload === "null") chat.sheets[1]?.settle({ ok: true, current: true, sheet: null });
      else {
        chat.sheets[1]?.settle({
          ok: true,
          current: true,
          sheet: {
            characterId: CHARACTER,
            fingerprint: reload === "changed fingerprint" ? "a".repeat(64) : FINGERPRINT,
            entries: [
              {
                ...SHEET_ENTRY,
                anchor: {
                  ...SHEET_ENTRY.anchor,
                  hair: reload === "changed entries" ? "silver" : SHEET_ENTRY.anchor.hair,
                },
              },
            ],
            revision: 5,
            updatedAt: 5,
          },
        });
      }
      await tick();
      if (reload.startsWith("changed")) {
        expect(pending?.signal.aborted).toBe(true);
        expect(chat.keeper).toHaveLength(4);
        expect(chat.keeper[3]?.request.turns.map((turn) => turn.content)).toEqual([
          "Noor arrives",
          "reply 1",
        ]);
        expect(
          chat.keeper[3]?.request.register.entries.map((entry) => entry.anchor.name),
        ).not.toContain("Noor");
        chat.state().retryCast();
        await chat.answer(upsert("Late output"), 2);
        expect(chat.state().cast.snapshots[target]).toBeUndefined();
        await chat.answer(upsert("Noor", { mood: "current canon" }));
        expect(chat.keeper).toHaveLength(4);
        expect(entry(chat.state(), "Noor")?.state.mood).toBe("current canon");
        expect(names(chat.state())).not.toContain("Late output");
      } else {
        expect(pending?.signal.aborted).toBe(false);
        expect(chat.keeper).toHaveLength(3);
        expect(chat.state().cast.sheet).toBe(acknowledged);
        await chat.answer({ cast: {}, absent: [] });
        expect(chat.keeper).toHaveLength(3);
        expect(entry(chat.state(), "Noor")?.state.mood).toBe("private prefix");
      }
      expect(chat.state().cast.snapshots[target]).toBeDefined();
    },
  );

  it.each(["failed", "null", "changed"] as const)(
    "leaves the active first single keeper running while its sheet reload is %s",
    async (reload) => {
      const chat = castChat();
      await chat.say("First");
      chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
      await tick();
      chat.state().retryCast();
      chat.state().retryCast();
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper).toHaveLength(1);
      expect(chat.keeper[0]?.signal.aborted).toBe(false);
      if (reload === "failed") chat.sheets[1]?.settle({ ok: false, reason: "timeout" });
      else if (reload === "null") chat.sheets[1]?.settle({ ok: true, current: true, sheet: null });
      else await chat.sheet([SHEET_ENTRY]);
      await tick();
      expect(chat.keeper[0]?.signal.aborted).toBe(false);
      await chat.answer(upsert("Noor"));
      expect(chat.keeper).toHaveLength(1);
      expect(names(chat.state())).toEqual(reload === "changed" ? ["Noor", "Ava Lind"] : ["Noor"]);
    },
  );

  it.each([
    "length",
    "content-filter",
    "stopped",
    "empty failed",
    "streaming",
    "Continue",
  ] as const)("does not redo covered B when failed C1 is hidden by %s", async (ending) => {
    const finish = deferred<void>();
    let count = 0;
    const chat = castChat(undefined, async function* () {
      count += 1;
      if (count <= 2) {
        yield { text: `reply ${count}` };
        return;
      }
      if (ending === "empty failed") throw new Error("upstream");
      yield {
        text: "unfinished",
        ...(["length", "content-filter"].includes(ending)
          ? { finishReason: ending as "length" | "content-filter" }
          : {}),
      };
      if (ending === "stopped") chat.state().stop();
      if (ending === "streaming" || ending === "Continue") {
        await finish.promise;
        throw new Error("upstream");
      }
    });
    await chat.say("B");
    await chat.answer(upsert("Noor"));
    const target = shownId(chat.state(), 0) ?? "";
    const snapshot = chat.state().cast.snapshots[target];
    await chat.say("C1");
    const failedReply = shownId(chat.state(), 1);
    await chat.refuse("upstream_busy");
    const sending = ending === "Continue" ? chat.state().continueReply() : chat.state().swipe(1);
    await tick();
    const failure = { status: "failed", failure: "upstream_busy", failures: 1 };
    expect(chat.state().cast).toMatchObject(failure);
    chat.state().retryCast();
    chat.state().retryCast();
    await tick();
    expect(chat.keeper).toHaveLength(2);
    expect(chat.state().cast.snapshots[target]).toBe(snapshot);
    expect(names(chat.state())).toEqual(["Noor"]);
    expect(chat.state().cast).toMatchObject(failure);
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    chat.state().retryCast();
    chat.state().retryCast();
    expect(chat.sheets).toHaveLength(2);
    expect(chat.keeper).toHaveLength(2);
    chat.sheets[1]?.settle({ ok: true, current: true, sheet: null });
    await tick();
    expect(chat.keeper).toHaveLength(2);
    expect(chat.state().cast.snapshots[target]).toBe(snapshot);
    expect(chat.state().cast).toMatchObject(failure);
    finish.resolve();
    await sending;
    if (ending !== "Continue") {
      await chat.state().swipe(-1);
      expect(shownId(chat.state(), 1)).toBe(failedReply);
      expect(chat.state().cast).toMatchObject(failure);
      chat.state().retryCast();
      await tick();
      expect(chat.keeper).toHaveLength(3);
      expect(chat.keeper[2]?.request.turns.map((turn) => turn.content)).toEqual(["C1", "reply 2"]);
    }
    expect(chat.state().cast.snapshots[target]).toBe(snapshot);
  });

  it.each(["loaded", "failed"] as const)(
    "recovers idle stale B behind empty C with one Try again when the sheet %s",
    async (outcome) => {
      const chat = castChat();
      await chat.say("B source");
      const target = shownId(chat.state(), 0) ?? "";
      chat.script.push("fail");
      await chat.say("Empty C");
      // Invalidate the first, still-uncommitted keeper without creating a failed checkpoint.
      chat.state().edit(chat.state().messages[0]?.id ?? "", "Edited B source");
      chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
      await tick();
      expect(chat.state().cast).toMatchObject({
        status: "idle",
        sheetStatus: "failed",
        snapshots: {},
      });
      expect(stale(chat.state())).toBe(true);
      chat.state().retryCast();
      chat.state().retryCast();
      await tick();
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper).toHaveLength(1);
      if (outcome === "loaded") await chat.sheet([SHEET_ENTRY]);
      else {
        chat.sheets[1]?.settle({ ok: false, reason: "cast_failed" });
        await tick();
      }
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual([
        "Edited B source",
        "reply 1",
      ]);
      expect(chat.keeper[1]?.request.sheetFingerprint).toBe(
        outcome === "loaded" ? FINGERPRINT : null,
      );
      expect(chat.keeper[1]?.request.register.entries.map((person) => person.anchor.name)).toEqual(
        outcome === "loaded" ? ["Ava Lind"] : [],
      );
      const generation = chat
        .state()
        .usage.calls.find((call) => call.purpose === "narration")?.generation;
      expect(
        chat.state().usage.running.find((call) => call.purpose === "cast.update")?.generation,
      ).toBe(generation);
      await chat.answer(upsert("Late output"), 0);
      await chat.answer({ cast: {}, absent: [] });
      await tick();
      expect(chat.state().cast.snapshots[target]).toBeDefined();
      expect(stale(chat.state())).toBe(false);
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper).toHaveLength(2);
      expect(names(chat.state())).not.toContain("Late output");
    },
  );

  it("reloads a failed sheet without redoing current B behind empty failed C", async () => {
    const chat = castChat();
    await chat.say("B");
    await chat.answer(upsert("Noor"));
    const target = shownId(chat.state(), 0) ?? "";
    const snapshot = chat.state().cast.snapshots[target];
    chat.script.push("fail");
    await chat.say("C");
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    chat.state().retryCast();
    await tick();
    expect(chat.sheets).toHaveLength(2);
    expect(chat.keeper).toHaveLength(1);
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.keeper).toHaveLength(1);
    expect(chat.state().cast.snapshots[target]).toEqual(snapshot);
    expect(names(chat.state())).toEqual(["Noor", "Ava Lind"]);
  });

  it.each(["Clear", "source", "deletion", "Undo", "character", "persona", "model null"] as const)(
    "rejects explicit keeper intent invalidated by %s while its sheet reload waits",
    async (fence) => {
      const chat = castChat();
      await chat.say("B");
      chat.state().edit(chat.state().messages[0]?.id ?? "", "Edited B");
      if (fence === "Undo") chat.state().remove(chat.state().messages[0]?.id ?? "");
      chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
      await tick();
      chat.state().retryCast();
      await tick();
      expect(chat.sheets).toHaveLength(2);
      expect(chat.keeper).toHaveLength(1);
      if (fence === "Clear") chat.state().clear();
      else if (fence === "source")
        chat.state().edit(chat.state().messages[0]?.id ?? "", "Changed again");
      else if (fence === "deletion") chat.state().remove(replyMessage(chat.state(), 0)?.id ?? "");
      else if (fence === "Undo") chat.state().undoDelete();
      else if (fence === "character") chat.selection.characterId = OTHER_CHARACTER;
      else if (fence === "persona") chat.selection.personaId = uuid(5);
      else chat.castSettings.model = null;
      await chat.sheet([SHEET_ENTRY]);
      await chat.answer(upsert("Late output"), 0);
      expect(chat.state().cast.snapshots).toEqual({});
      expect(chat.state().cast.activeCall).toBeNull();
      expect(chat.keeper).toHaveLength(1);
      expect(chat.sheets).toHaveLength(2);
    },
  );

  it("keeps a coalesced newer completion waiting for the explicitly reloaded sheet", async () => {
    const chat = castChat();
    await chat.say("B");
    await chat.refuse("cast_failed");
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    chat.state().retryCast();
    await chat.say("C");
    const target = shownId(chat.state(), 1) ?? "";
    // A notebook context handoff transfers both target and the explicit sheet barrier.
    chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE]));
    await tick();
    expect(chat.keeper).toHaveLength(1);
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.keeper).toHaveLength(2);
    expect(chat.keeper[1]?.request.sheetFingerprint).toBe(FINGERPRINT);
    expect(chat.keeper[1]?.request.turns.map((turn) => turn.content)).toEqual([
      "B",
      "reply 1",
      "C",
      "reply 2",
    ]);
    await chat.answer({ cast: {}, absent: [] });
    expect(Object.keys(chat.state().cast.snapshots)).toEqual([target]);
    expect(chat.keeper).toHaveLength(2);
  });

  it("is asked for again by the next trigger after it came back stale, and then acknowledged", async () => {
    const chat = castChat();
    chat.state().setGreetings(["Hello"]);
    await chat.sheet([SHEET_ENTRY], -1, false);
    expect(chat.state().cast.sheetStatus).toBe("failed");
    await chat.say("Hi");
    expect(chat.sheets).toHaveLength(2);
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.state().cast).toMatchObject({
      sheetStatus: "idle",
      sheet: { fingerprint: FINGERPRINT },
    });
    expect(names(chat.state())).toEqual(["Ava Lind"]);
  });

  it("is read again by Try again, without a keeper call", async () => {
    const chat = castChat();
    chat.state().setGreetings([]);
    chat.sheets.at(-1)?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    expect(chat.state().cast.sheetStatus).toBe("failed");
    chat.state().retryCast();
    expect(chat.sheets).toHaveLength(2);
    expect(chat.keeper).toHaveLength(0);
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.state().cast.sheetStatus).toBe("idle");
  });
});

describe("what the identity index lends", () => {
  it("lends no state to an alternate whose base lacks her", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Noor", { outfit: "red dress", injuries: "broken arm" }));
    await chat.state().swipe(1);
    expect(chat.keeper[1]?.request.register.entries).toEqual([]);
    await chat.answer({ cast: { Noor: { state: { mood: "calm" } } }, absent: [] });
    expect(currentRegister(chat.state()).entries.map((e) => e.id)).toEqual([uuid(100)]);
    expect(entry(chat.state(), "Noor")?.state).toMatchObject({
      outfit: "",
      injuries: "",
      mood: "calm",
    });
  });

  it("bakes no correction the request did not carry: Revert shows the recorded value", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Noor", { outfit: "red dress" }));
    chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
    await chat.state().swipe(1);
    await chat.answer({ cast: { Noor: { state: { mood: "calm" } } }, absent: [] });
    expect(entry(chat.state(), "Noor")?.state.outfit).toBe("grey coat");
    chat.state().revertCast(uuid(100), "outfit");
    expect(entry(chat.state(), "Noor")?.state).toMatchObject({ outfit: "", mood: "calm" });
  });

  it("keeps one id when an alternate's base knows her by an earlier name", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer({ cast: { Ilse: { gender: "female" } }, absent: [] });
    await chat.say("Next");
    await chat.answer({ cast: { Maren: { was: "Ilse" } }, absent: [] });
    // Another alternate of the second reply: its base still has her as Ilse.
    await chat.state().swipe(1);
    await chat.answer({ cast: { Maren: {} }, absent: [] });
    expect(currentRegister(chat.state()).entries.map((e) => [e.id, e.anchor.name, e.aka])).toEqual([
      [uuid(100), "Maren", ["Ilse"]],
    ]);
    await chat.say("Third");
    await chat.answer({ cast: { Maren: { state: { mood: "calm" } } }, absent: [] });
    const ids = Object.values(chat.state().cast.snapshots).flatMap((snapshot) =>
      snapshot.register.entries.map((e) => e.id),
    );
    expect(new Set(ids)).toEqual(new Set([uuid(100)]));
  });

  it("leaves no sheet failure once no character is chosen", async () => {
    const chat = castChat();
    chat.state().setGreetings([]);
    chat.sheets.at(-1)?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    expect(chat.state().cast.sheetStatus).toBe("failed");
    chat.selection.characterId = null;
    await chat.say("Hi");
    expect(chat.state().cast).toMatchObject({ sheet: null, sheetStatus: "idle" });
    expect(chat.sheets).toHaveLength(1);
  });
});

describe("development ownership", () => {
  const transition: CastChanges = {
    cast: {
      Noor: {
        developments: {
          hair: { value: "short black hair", evidence: "cut her hair short" },
          age: { value: "31", evidence: "turned 31" },
        },
        continuity: { voice: { value: "calls Rowan captain", evidence: "Captain, come home." } },
      },
    },
    absent: [],
  };
  const establish = async () => {
    const chat = castChat();
    await chat.say("First meeting");
    await chat.answer({
      cast: { Noor: { gender: "female", anchor: { age: "30", hair: "long black hair" } } },
      absent: [],
    });
    const baseline = castAnchorsText(currentRegister(chat.state()));
    await chat.say("Noor cut her hair short and turned 31. Captain, come home.");
    await chat.answer(transition);
    return { chat, baseline };
  };
  const hair = (chat: ReturnType<typeof castChat>) => {
    const found = entry(chat.state(), "Noor");
    return found === undefined ? undefined : effectiveCastAnchor(found).hair;
  };

  it("preserves baseline bytes and makes correction reset reveal recorded developments", async () => {
    const { chat, baseline } = await establish();
    expect(castAnchorsText(currentRegister(chat.state()))).toBe(baseline);
    expect(hair(chat)).toBe("short black hair");
    chat.state().correctCast(uuid(100), { anchor: { hair: "", age: "44", skin: "" } });
    expect(hair(chat)).toBe("");
    await chat.say("Noor cut her hair short and turned 31. Captain, come home.");
    await chat.answer({
      cast: { Noor: { ...transition.cast.Noor, anchor: { skin: "invented fill" } } },
      absent: [],
    });
    expect(hair(chat)).toBe("");
    chat.state().revertCast(uuid(100), "hair");
    chat.state().revertCast(uuid(100), "age");
    chat.state().revertCast(uuid(100), "skin");
    expect(hair(chat)).toBe("short black hair");
    const found = entry(chat.state(), "Noor");
    expect(found === undefined ? undefined : effectiveCastAnchor(found).age).toBe("31");
    expect(found?.anchor.skin).toBe("");
    expect(castAnchorsText(currentRegister(chat.state()))).toBe(baseline);
  });

  it("does not bake a corrected development into a call when Revert happens while it runs", async () => {
    const { chat } = await establish();
    chat.state().correctCast(uuid(100), { anchor: { hair: "silver" } });
    await chat.say("Noor cut her hair short.");
    chat.state().revertCast(uuid(100), "hair");
    await chat.answer({ cast: {}, absent: [] });
    expect(hair(chat)).toBe("short black hair");
  });

  it("restores exact developments and continuity on deletion Undo and cast-removal Undo", async () => {
    const { chat } = await establish();
    chat.state().remove(replyMessage(chat.state(), 1)?.id ?? "");
    expect(hair(chat)).toBe("long black hair");
    chat.state().undoDelete();
    expect(hair(chat)).toBe("short black hair");
    expect(entry(chat.state(), "Noor")?.continuity?.voice).toBe("calls Rowan captain");
    chat.state().removeCast(uuid(100));
    expect(entry(chat.state(), "Noor")).toBeUndefined();
    chat.state().restoreCast(uuid(100));
    expect(hair(chat)).toBe("short black hair");
  });

  for (const invalidation of ["edit", "stopped Continue", "alternate"] as const) {
    it(`recovers identity without future developments after ${invalidation}`, async () => {
      const { chat } = await establish();
      chat.state().correctCast(uuid(100), { anchor: { relationship: "owner's bond" } });
      if (invalidation === "edit") {
        chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Revised beginning");
        await chat.say("Next");
      } else if (invalidation === "stopped Continue") {
        // Invalidate the initial baseline too, so all-chat identity recovery is exercised.
        chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Revised beginning");
        chat.script.push("stop");
        await chat.state().continueReply();
        await chat.say("Next");
      } else {
        chat.state().remove(replyMessage(chat.state(), 0)?.id ?? "");
        await chat.state().swipe(1);
      }
      const sent = chat.keeper
        .at(-1)
        ?.request.register.entries.find((entry) => entry.id === uuid(100));
      expect(sent?.developments).toBeUndefined();
      expect(sent?.continuity).toBeUndefined();
      await chat.answer({ cast: { Noor: {} }, absent: [] });
      expect(entry(chat.state(), "Noor")?.id).toBe(uuid(100));
      expect(hair(chat)).toBe("long black hair");
      expect(entry(chat.state(), "Noor")?.continuity).toBeUndefined();
      expect(entry(chat.state(), "Noor")?.anchor.relationship).toBe("owner's bond");
    });
  }

  it("archival context uses the newest shown snapshot at/before the boundary and owner precedence", async () => {
    const { chat } = await establish();
    const atBaseline = memoryContextAt(chat.state(), 2);
    expect(atBaseline?.[0]?.anchor.hair).toBe("long black hair");
    expect(atBaseline?.[0]?.continuity).toBeUndefined();
    expect(memoryContextAt(chat.state(), 0)).toBeUndefined();
    chat.state().correctCast(uuid(100), { anchor: { hair: "owner silver" } });
    const context = memoryContextAt(chat.state(), 4);
    expect(context?.[0]?.anchor.hair).toBe("owner silver");
    expect(context?.[0]?.continuity?.voice).toBe("calls Rowan captain");
    expect(JSON.stringify(context)).not.toContain(uuid(100));
    expect(JSON.stringify(context)).not.toContain('"state"');
    chat.state().removeCast(uuid(100));
    expect(memoryContextAt(chat.state(), 4)).toBeUndefined();
  });
});

describe("a removal undone while the keeper reads", () => {
  it("applies the answer to her as named, not as a removed placeholder", async () => {
    const chat = castChat();
    await chat.say("Hi");
    await chat.answer(upsert("Noor", { outfit: "red dress" }));
    chat.state().removeCast(uuid(100));
    await chat.state().continueReply();
    await tick();
    expect(chat.keeper[1]?.request.register.entries).toEqual([]);
    chat.state().restoreCast(uuid(100));
    await chat.answer({ cast: { Noor: { state: { outfit: "coat", mood: "calm" } } }, absent: [] });
    expect(currentRegister(chat.state()).entries.map((e) => e.id)).toEqual([uuid(100)]);
    expect(entry(chat.state(), "Noor")?.state).toMatchObject({
      present: true,
      outfit: "coat",
      mood: "calm",
    });
  });
});

describe("corrected catch-up inputs", () => {
  for (const discarded of ["alternate", "deleted reply"] as const) {
    for (const invalidation of ["edit", "stopped Continue"] as const) {
      it(`recovers only the ${invalidation} snapshot, excluding a discarded ${discarded} at capacity`, async () => {
        const chat = castChat();
        await chat.say("First branch");
        await chat.answer(upsert("Discarded A"));
        if (discarded === "alternate") await chat.state().swipe(1);
        else {
          chat.state().remove(replyMessage(chat.state(), 0)?.id ?? "");
          await chat.say("Current branch");
        }
        const changes: CastChanges = { cast: {}, absent: [] };
        for (let i = 0; i < 39; i++) changes.cast[`Current ${i}`] = { gender: "female" };
        changes.cast["Current B"] = { gender: "female", state: { outfit: "old dress" } };
        await chat.answer(changes);
        const b = entry(chat.state(), "Current B");
        expect(b).toBeDefined();
        chat
          .state()
          .correctCast(b?.id ?? "", { anchor: { name: "Corrected B" }, state: { outfit: "coat" } });
        const message = replyMessage(chat.state(), 0);
        if (invalidation === "edit") {
          chat.state().edit(message?.id ?? "", "Edited once");
          chat.state().edit(message?.id ?? "", "Edited twice");
        } else {
          chat.script.push("stop");
          await chat.state().continueReply();
        }
        // Deleting an invalidated reply hides its membership; Undo restores it, not a snapshot.
        chat.state().remove(message?.id ?? "");
        chat.state().undoDelete();
        await chat.say("Next");
        const sent = chat.keeper.at(-1)?.request.register.entries ?? [];
        expect(sent).toHaveLength(40);
        expect(sent.some((entry) => entry.anchor.name === "Discarded A")).toBe(false);
        expect(sent.find((entry) => entry.id === b?.id)).toMatchObject({
          anchor: { name: "Corrected B" },
          state: { present: false, outfit: "coat" },
        });
        await chat.answer({ cast: { "Corrected B": { state: { outfit: "robe" } } }, absent: [] });
        expect(entry(chat.state(), "Corrected B")).toMatchObject({
          id: b?.id,
          state: { outfit: "robe" },
        });
        // The successful snapshot consumed the gap. Deleting it cannot revive its old candidates.
        chat.state().remove(replyMessage(chat.state(), 1)?.id ?? "");
        await chat.say("After deletion");
        expect(chat.keeper.at(-1)?.request.register.entries).toEqual([]);
      });
    }
  }

  it("plain deletion never supplies catch-up identities and Clear drops pending recovery", async () => {
    const chat = castChat();
    await chat.say("First");
    await chat.answer(upsert("Deleted A"));
    chat.state().remove(replyMessage(chat.state(), 0)?.id ?? "");
    await chat.say("Second");
    expect(chat.keeper.at(-1)?.request.register.entries).toEqual([]);
    await chat.answer(upsert("Current B"));
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Edited");
    chat.state().remove(replyMessage(chat.state(), 0)?.id ?? "");
    await chat.say("Without Undo");
    expect(chat.keeper.at(-1)?.request.register.entries).toEqual([]);
    chat.state().clear();
    await chat.say("New chat");
    expect(chat.keeper.at(-1)?.request.register.entries).toEqual([]);
  });

  for (const kind of ["edit", "stopped Continue"] as const) {
    it(`sends the corrected field after ${kind}, then accepts a keeper change to it`, async () => {
      const chat = castChat();
      await chat.say("Hi");
      await chat.answer(upsert("Noor", { outfit: "red dress", injuries: "old wound" }));
      chat.state().correctCast(uuid(100), {
        state: { outfit: "grey coat" },
        anchor: { hair: "silver", name: "Noor Haddad" },
      });
      if (kind === "edit") chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "edited");
      else {
        chat.script.push("stop");
        await chat.state().continueReply();
      }
      await chat.say("Next");
      expect(chat.keeper[1]?.request.register.entries[0]).toMatchObject({
        id: uuid(100),
        anchor: { name: "Noor Haddad", hair: "silver" },
        state: { present: false, outfit: "grey coat", injuries: "" },
      });
      await chat.answer({ cast: { "Noor Haddad": { state: { outfit: "towel" } } }, absent: [] });
      expect(entry(chat.state(), "Noor Haddad")?.state.outfit).toBe("towel");
      expect(chat.state().cast.corrections[uuid(100)]?.state).toEqual({});
      chat.state().revertCast(uuid(100), "hair");
      expect(entry(chat.state(), "Noor Haddad")?.anchor.hair).toBe("");
    });

    it(`keeps a newer correction made during the ${kind} catch-up`, async () => {
      const chat = castChat();
      await chat.say("Hi");
      await chat.answer(upsert("Noor", { outfit: "red dress" }));
      chat.state().correctCast(uuid(100), { state: { outfit: "grey coat" } });
      if (kind === "edit") chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "edited");
      else {
        chat.script.push("stop");
        await chat.state().continueReply();
      }
      await chat.say("Next");
      expect(chat.keeper[1]?.request.register.entries[0]?.state.outfit).toBe("grey coat");
      chat.state().correctCast(uuid(100), { state: { outfit: "blue robe" } });
      await chat.answer({ cast: { Noor: { state: { outfit: "towel" } } }, absent: [] });
      expect(entry(chat.state(), "Noor")?.state.outfit).toBe("blue robe");
      await chat.say("Third");
      expect(chat.keeper[2]?.request.register.entries[0]?.state.outfit).toBe("blue robe");
      await chat.answer({ cast: { Noor: { state: { outfit: "nothing" } } }, absent: [] });
      expect(entry(chat.state(), "Noor")?.state.outfit).toBe("nothing");
    });
  }
});

const remembered = (lines: string[], revision = 1, enabled = true): CharacterMemory => ({
  state: {
    enabled,
    notebook: { ...emptyNotebook(), cast: lines },
    opening: "",
    revision,
    updatedAt: revision,
  },
  episodes: [],
});
const NPC_LINE = JSON.stringify({ name: "Ilse Brandt", gender: "female", hair: "black bob" });

describe("remembered cast seeds", () => {
  for (const greeting of [false, true]) {
    it(`replaces an interrupted ${greeting ? "greeting" : "reply"} keeper once with the latest overlay`, async () => {
      const chat = castChat(async () => remembered([]));
      chat.state().setGreetings(greeting ? ["Hello"] : []);
      await chat.sheet([]);
      if (!greeting) await chat.say("Hi");
      const replyId = shownId(chat.state(), 0) ?? "";
      expect(chat.keeper).toHaveLength(1);
      chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 2));
      chat
        .state()
        .receiveCastMemory(
          CHARACTER,
          remembered([JSON.stringify({ name: "Wren", gender: "female" })], 3),
        );
      expect(chat.keeper[0]?.signal.aborted).toBe(true);
      await chat.answer(upsert("Stale person"), 0);
      expect(chat.keeper).toHaveLength(2);
      expect(chat.keeper[1]?.signal.aborted).toBe(false);
      expect(chat.keeper[1]?.request.register.entries.map((person) => person.anchor.name)).toEqual([
        "Wren",
      ]);
      expect(chat.state().cast.snapshots[replyId]).toBeUndefined();
      await chat.answer(upsert("Wren", { outfit: "coat" }));
      expect(chat.state().cast.snapshots[replyId]).toBeDefined();
      expect(entry(chat.state(), "Wren")?.state.outfit).toBe("coat");
      expect(names(chat.state())).not.toContain("Stale person");
      expect(chat.keeper).toHaveLength(2);
    });
  }

  for (const fence of ["Clear", "character", "edit", "newer reply", "stopped reply"] as const) {
    it(`handles an overlay replacement with ${fence}`, async () => {
      const chat = castChat(async () => remembered([]));
      await chat.say("Hi");
      const oldReply = shownId(chat.state(), 0) ?? "";
      chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 2));
      if (fence === "Clear") chat.state().clear();
      else if (fence === "character") chat.selection.characterId = OTHER_CHARACTER;
      else if (fence === "edit")
        chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Edited reply");
      else {
        if (fence === "stopped reply") chat.script.push("stop");
        await chat.say("Next");
      }
      await chat.answer(upsert("Stale person"), 0);
      expect(chat.state().cast.snapshots[oldReply]).toBeUndefined();
      expect(names(chat.state())).not.toContain("Stale person");
      if (fence === "newer reply" || fence === "stopped reply") {
        // The replacement owns B's prefix while C streams. Later eligible C queues
        // normally; a stopped C stays visibly stale without cancelling B's authority.
        expect(chat.keeper).toHaveLength(2);
        expect(chat.keeper[1]?.request.turns.at(-1)?.content).toBe("reply 1");
        await chat.answer(upsert("B person"));
        expect(chat.state().cast.snapshots[oldReply]).toBeDefined();
        if (fence === "newer reply") {
          expect(chat.keeper).toHaveLength(3);
          expect(chat.keeper[2]?.request.turns.at(-1)?.content).toBe("reply 2");
          await chat.answer(upsert("New person"));
          expect(chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""]).toBeDefined();
        } else {
          expect(chat.keeper).toHaveLength(2);
          expect(chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""]).toBeUndefined();
          expect(stale(chat.state())).toBe(true);
        }
      } else expect(chat.keeper).toHaveLength(1);
    });
  }

  for (const greeting of [false, true]) {
    it(`leaves an interrupted ${greeting ? "greeting" : "reply"} keeper's failed replacement for explicit Try again`, async () => {
      const chat = castChat(async () => remembered([]));
      chat.state().setGreetings(greeting ? ["Hello"] : []);
      await chat.sheet([]);
      if (!greeting) await chat.say("Hi");
      chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 2));
      await tick();
      expect(chat.keeper).toHaveLength(2);
      await chat.refuse("cast_failed");
      chat.state().receiveCastMemory(CHARACTER, remembered([], 3));
      await tick();
      expect(chat.keeper).toHaveLength(2);
      expect(chat.state().cast.status).toBe("failed");
      chat.state().retryCast();
      await tick();
      expect(chat.keeper).toHaveLength(3);
    });
  }

  it("does not replace an old character's keeper when the new character's notebook arrives", async () => {
    const chat = castChat(async () => remembered([]));
    await chat.say("Hi");
    chat.selection.characterId = OTHER_CHARACTER;
    chat.state().receiveCastMemory(OTHER_CHARACTER, remembered([NPC_LINE]));
    await tick();
    expect(chat.keeper).toHaveLength(1);
    expect(chat.keeper[0]?.signal.aborted).toBe(true);
    await chat.answer(upsert("Stale person"), 0);
    expect(chat.state().cast.snapshots).toEqual({});
  });

  it("reserves one greeting keeper when sheet and notebook complete in the same tick", async () => {
    const memory = deferred<CharacterMemory | undefined>();
    const chat = castChat(() => memory.promise);
    chat.state().setGreetings(["Hello"]);
    const sheet = chat.sheet([SHEET_ENTRY]);
    memory.resolve(remembered([NPC_LINE]));
    await sheet;
    await tick();
    expect(chat.keeper).toHaveLength(1);
    expect(chat.keeper[0]?.signal.aborted).toBe(false);
    expect(chat.keeper[0]?.request.register.entries.map((person) => person.anchor.name)).toEqual([
      "Ava Lind",
      "Ilse Brandt",
    ]);
    await chat.answer(upsert("Ava Lind"));
    expect(chat.keeper).toHaveLength(1);
  });

  it("supersedes a pending greeting start with its refilled text", async () => {
    const chat = castChat(async () => remembered([NPC_LINE]));
    chat.state().setGreetings(["Hello"]);
    await chat.sheet([SHEET_ENTRY]);
    await chat.answer({ cast: {}, absent: [] });
    chat.state().setGreetings(["Hello again"]);
    expect(chat.keeper).toHaveLength(1);
    chat.state().setGreetings(["Newest hello"]);
    await tick();
    expect(chat.keeper).toHaveLength(2);
    expect(chat.keeper[1]?.request.turns).toEqual([{ role: "assistant", content: "Newest hello" }]);
  });

  it("drops a reserved greeting start on Clear", async () => {
    const chat = castChat(async () => remembered([NPC_LINE]));
    chat.state().setGreetings(["Hello"]);
    await chat.sheet([SHEET_ENTRY]);
    await chat.answer({ cast: {}, absent: [] });
    chat.state().setGreetings(["Hello again"]);
    chat.state().clear();
    await tick();
    expect(chat.keeper).toHaveLength(1);
    expect(chat.state().cast.snapshots).toEqual({});
  });

  it("recovers all nine established identities before admitting 32 unused notebook seeds", async () => {
    const chat = castChat(async () => remembered([]));
    chat.state().setGreetings([]);
    await chat.sheet([]);
    await chat.say("First");
    const people = Array.from({ length: 9 }, (_, i) => `Known ${i}`);
    await chat.answer({
      cast: Object.fromEntries(people.map((name) => [name, { gender: "female" }])),
      absent: [],
    });
    const ids = currentRegister(chat.state()).entries.map((person) => person.id);
    const ninth = ids[8] ?? "";
    chat.state().receiveCastMemory(
      CHARACTER,
      remembered(
        Array.from({ length: 32 }, (_, i) =>
          JSON.stringify({ name: `Remembered ${i}`, gender: "female" }),
        ),
        2,
      ),
    );
    chat.state().correctCast(ninth, { state: { outfit: "coat" } });
    chat.state().edit(replyMessage(chat.state(), 0)?.id ?? "", "Edited first reply");
    await chat.say("Catch up");
    const sent = chat.keeper.at(-1)?.request.register.entries ?? [];
    expect(sent).toHaveLength(40);
    expect(sent.slice(0, 9).map((person) => person.id)).toEqual(ids);
    expect(sent[8]).toMatchObject({ id: ninth, state: { outfit: "coat", present: false } });
    expect(sent.at(-1)?.anchor.name).toBe("Remembered 30");
    await chat.answer({ cast: { "Known 8": { state: { outfit: "robe" } } }, absent: [] });
    expect(entry(chat.state(), "Known 8")).toMatchObject({ id: ninth, state: { outfit: "robe" } });
    expect(chat.state().cast.corrections[ninth]).toBeUndefined();
  });

  it("recomposes unused seeds around a delayed eight-person sheet and an established live NPC", async () => {
    const chat = castChat(async () =>
      remembered(
        Array.from({ length: 32 }, (_, i) =>
          JSON.stringify({ name: `Remembered ${i}`, gender: "female" }),
        ),
      ),
    );
    await chat.say("First");
    await chat.answer(upsert("Live NPC", { outfit: "dress" }));
    const live = entry(chat.state(), "Live NPC")?.id ?? "";
    chat.state().correctCast(live, { anchor: { hair: "silver" }, state: { outfit: "coat" } });
    const sheet = Array.from({ length: 8 }, (_, i) => ({
      ...SHEET_ENTRY,
      id: uuid(i + 1),
      anchor: { ...SHEET_ENTRY.anchor, name: `Card ${i}` },
    }));
    await chat.sheet(sheet);
    const expected = [
      "Live NPC",
      ...sheet.map((person) => person.anchor.name),
      ...Array.from({ length: 31 }, (_, i) => `Remembered ${i}`),
    ];
    expect(names(chat.state())).toEqual(expected);
    expect(entry(chat.state(), "Live NPC")).toMatchObject({
      id: live,
      anchor: { hair: "silver" },
      state: { outfit: "coat" },
    });
    chat.state().removeCast(live);
    expect(names(chat.state())).toEqual(expected.slice(1));
    chat.state().restoreCast(live);
    await chat.say("Next");
    expect(chat.keeper[1]?.request.register.entries.map((person) => person.anchor.name)).toEqual(
      expected,
    );
    await chat.answer({ cast: {}, absent: [] });
    expect(names(chat.state())).toEqual(expected);
    expect(entry(chat.state(), "Live NPC")).toMatchObject({ id: live, state: { outfit: "coat" } });
    chat.state().revertCast(live, "hair");
    expect(entry(chat.state(), "Live NPC")?.anchor.hair).toBe("");
  });

  it.each(["edit", "off", "Forget"])("retains card adoption after %s", async (change) => {
    const chat = castChat(async () =>
      remembered([NPC_LINE, JSON.stringify({ name: "Unused", gender: "female" })]),
    );
    await chat.say("First");
    await chat.answer({ cast: {}, absent: [] });
    const id = entry(chat.state(), "Ilse Brandt")?.id ?? "";
    await chat.sheet([{ ...SHEET_ENTRY, anchor: { ...SHEET_ENTRY.anchor, name: "Ilse Brandt" } }]);
    chat.state().removeFrom(chat.state().messages[0]?.id ?? "");
    chat.state().undoDelete();
    expect(entry(chat.state(), "Ilse Brandt")?.id).toBe(id);
    chat.state().correctCast(id, { anchor: { hair: "silver" }, state: { outfit: "coat" } });
    const corrected = { id, anchor: { hair: "silver" }, state: { outfit: "coat" } };
    expect(entry(chat.state(), "Ilse Brandt")).toMatchObject(corrected);
    chat.state().removeCast(id);
    await chat.say("Next");
    await chat.answer({ cast: {}, absent: [] });
    const lines = change === "edit" ? ['{"name":"Wren","gender":"female"}'] : [];
    chat.state().receiveCastMemory(CHARACTER, remembered(lines, 2, change !== "off"));
    expect(names(chat.state())).not.toContain("Ilse Brandt");
    expect(names(chat.state())).not.toContain("Unused");
    chat.state().removeFrom(chat.state().messages[2]?.id ?? "");
    chat.state().undoDelete();
    expect(names(chat.state())).not.toContain("Ilse Brandt");
    chat.state().restoreCast(id);
    expect(entry(chat.state(), "Ilse Brandt")).toMatchObject(corrected);
    await chat.say("Restored");
    await chat.answer({ cast: {}, absent: [] });
    expect(names(chat.state()).filter((name) => name === "Ilse Brandt")).toHaveLength(1);
    expect(entry(chat.state(), "Ilse Brandt")).toMatchObject({ id, state: { outfit: "coat" } });
    chat.state().revertCast(id, "hair");
    expect(entry(chat.state(), "Ilse Brandt")?.anchor.hair).toBe("copper");
  });

  it.each(["edit", "off", "Forget"])("keeps affirmed state after %s", async (change) => {
    const chat = castChat(async () => remembered([NPC_LINE]));
    await chat.say("First");
    await chat.answer({ cast: {}, absent: [] });
    await chat.sheet([]);
    const id = entry(chat.state(), "Ilse Brandt")?.id ?? "";
    chat.state().correctCast(id, { state: { outfit: "coat" } });
    for (const text of ["Next", "Again"]) {
      await chat.say(text);
      expect(chat.keeper.at(-1)?.request.register.entries).toMatchObject([
        { id, state: { outfit: "coat" } },
      ]);
      await chat.answer({ cast: {}, absent: [] });
      expect(chat.state().cast.corrections[id]).toBeUndefined();
      expect(entry(chat.state(), "Ilse Brandt")).toMatchObject({ id, state: { outfit: "coat" } });
    }
    const lines = change === "edit" ? ['{"name":"Wren","gender":"female"}'] : [];
    chat.state().receiveCastMemory(CHARACTER, remembered(lines, 2, change !== "off"));
    expect(entry(chat.state(), "Ilse Brandt")).toMatchObject({ id, state: { outfit: "coat" } });
    chat.state().removeFrom(chat.state().messages[2]?.id ?? "");
    chat.state().undoDelete();
    expect(entry(chat.state(), "Ilse Brandt")).toMatchObject({ id, state: { outfit: "coat" } });
  });

  it.each(["refill", "swipe", "new"])("seeds a %s after failure", async (change) => {
    const chat = castChat(async () => remembered([NPC_LINE]));
    chat.state().setGreetings(["Hello", "Other hello"]);
    await chat.sheet([]);
    await chat.refuse("cast_failed");
    chat.state().setGreetings(["Hello", "Other hello"]);
    await tick();
    expect(chat.keeper).toHaveLength(1);
    if (change === "swipe") chat.state().pickGreeting(1);
    else {
      if (change === "new") chat.state().setGreetings([]);
      chat.state().setGreetings(["Changed hello"]);
    }
    await tick();
    expect(chat.keeper).toHaveLength(2);
    expect(chat.keeper[1]?.request.turns.at(-1)?.content).toBe(
      change === "swipe" ? "Other hello" : "Changed hello",
    );
    await chat.refuse("cast_failed");
    if (change === "swipe") chat.state().pickGreeting(0);
    else chat.state().setGreetings(["Changed hello"]);
    await tick();
    expect(chat.keeper).toHaveLength(2);
    chat.state().retryCast();
    await tick();
    expect(chat.keeper).toHaveLength(3);
  });

  for (const lines of [[], [NPC_LINE]]) {
    it(`bounds greeting retries without a model and ${lines.length} remembered people`, async () => {
      const chat = castChat(async () => remembered(lines));
      chat.castSettings.model = null;
      chat.state().setGreetings(["Hello"]);
      await tick();
      expect(chat.sheets).toHaveLength(0);
      expect(chat.keeper).toHaveLength(0);
      expect(chat.state().cast.sheetStatus).toBe("failed");
      await tick();
      expect(chat.keeper).toHaveLength(0);
      chat.castSettings.model = "cast-model";
      chat.state().retryCast();
      expect(chat.sheets).toHaveLength(1);
      await chat.sheet([]);
      expect(chat.keeper).toHaveLength(1);
    });
  }

  it("does not let a failed sheet completion retry itself through the greeting", async () => {
    const chat = castChat(async () => remembered([]));
    chat.state().setGreetings(["Hello"]);
    await tick();
    chat.sheets[0]?.settle({ ok: false, reason: "cast_failed" });
    await tick();
    expect(chat.sheets).toHaveLength(1);
    expect(chat.keeper).toHaveLength(1);
    await chat.refuse("cast_failed");
    await tick();
    expect(chat.sheets).toHaveLength(1);
    expect(chat.keeper).toHaveLength(1);
    chat.state().retryCast();
    expect(chat.sheets).toHaveLength(2);
  });

  it("keeps a failed keeper's retry usable after a notebook change", async () => {
    const chat = castChat(async () => remembered([]));
    await chat.say("Hi");
    await chat.refuse("cast_failed");
    chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 2));
    expect(chat.state().cast).toMatchObject({
      status: "failed",
      failure: "cast_failed",
      failures: 1,
    });
    chat.state().retryCast();
    await tick();
    expect(chat.keeper).toHaveLength(2);
    await chat.answer({ cast: {}, absent: [] });
    expect(chat.state().cast.status).toBe("idle");
  });

  for (const change of ["edit", "off", "Forget"] as const) {
    it(`retains a renamed established seed after notebook ${change} and preserves anchor Revert`, async () => {
      const chat = castChat(async () => remembered([NPC_LINE]));
      await chat.say("Hi");
      const id = entry(chat.state(), "Ilse Brandt")?.id ?? "";
      chat.state().correctCast(id, { anchor: { name: "Noor Haddad", hair: "silver" } });
      // The first call did not read the correction. Run one that does.
      await chat.answer({ cast: {}, absent: [] });
      await chat.say("Next");
      await chat.answer({ cast: { "Noor Haddad": { state: { outfit: "coat" } } }, absent: [] });
      chat
        .state()
        .receiveCastMemory(
          CHARACTER,
          remembered(
            change === "edit" ? [JSON.stringify({ name: "Wren", gender: "female" })] : [],
            2,
            change !== "off",
          ),
        );
      expect(entry(chat.state(), "Noor Haddad")).toMatchObject({
        id,
        anchor: { hair: "silver" },
        state: { outfit: "coat" },
      });
      chat.state().revertCast(id, "name");
      chat.state().revertCast(id, "hair");
      expect(entry(chat.state(), "Ilse Brandt")).toMatchObject({
        id,
        anchor: { hair: "black bob" },
        state: { outfit: "coat" },
      });
    });
  }

  it("preserves an active scene paint when the notebook cast changes", async () => {
    const finish = deferred<void>();
    let painting: AbortSignal | undefined;
    const chat = castChat(
      async () => remembered([]),
      undefined,
      async (_request, signal) => {
        painting = signal;
        return (async function* () {
          await finish.promise;
          yield { type: "done" as const };
        })();
      },
    );
    await chat.say("Hi");
    await chat.answer({ cast: {}, absent: [] });
    chat.state().pictureScene();
    await tick();
    expect(painting).toBeDefined();
    chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 2));
    expect(painting?.aborted).toBe(false);
    expect(chat.state().scenes[0]?.run.status).toBe("running");
    finish.resolve();
    await tick();
    expect(painting?.aborted).toBe(false);
  });
  for (const populated of [false, true]) {
    const lines = populated ? [NPC_LINE] : [];
    // Reordered JSON fields and whitespace describe the same normalized seed.
    const unchangedLines = populated
      ? ['{ "hair": "black bob", "gender": "female", "name": "Ilse Brandt" }']
      : [];

    it(`keeps an in-flight keeper and snapshots when only the ${populated ? "populated" : "empty"} notebook cast's revision advances`, async () => {
      const chat = castChat(async () => remembered(lines));
      chat.state().setGreetings([]);
      await chat.sheet([]);
      await chat.say("Hi");
      await chat.answer(upsert("Noor", { outfit: "coat" }));
      await chat.say("Next");
      const before = chat.state().cast;
      const updated = remembered(unchangedLines, 2);
      if (updated.state !== null) {
        updated.state.notebook.situation = "The next morning";
        updated.state.notebook.relationships = ["Noor trusts Rowan"];
        updated.state.opening = "A new day begins";
      }
      chat.state().receiveCastMemory(CHARACTER, updated);
      expect(chat.state().cast.memory).toMatchObject({ revision: 2 });
      expect(chat.state().cast.memory?.entries).toBe(before.memory?.entries);
      expect(chat.state().cast.snapshots).toBe(before.snapshots);
      expect(chat.state().cast.activeCall).toBe(before.activeCall);
      expect(chat.state().cast.status).toBe("updating");
      expect(chat.keeper[1]?.signal.aborted).toBe(false);
      await chat.answer(upsert("Noor", { outfit: "robe" }));
      expect(entry(chat.state(), "Noor")?.state.outfit).toBe("robe");
      expect(chat.state().cast.activeCall).toBeNull();
      expect(chat.state().cast.snapshots[shownId(chat.state(), 1) ?? ""]).toBeDefined();
    });

    for (const changed of [false, true]) {
      it(`preserves a streaming generation when the ${populated ? "populated" : "empty"} cast ${changed ? "changes" : "only advances its notebook revision"}`, async () => {
        const finish = deferred<void>();
        const signals: AbortSignal[] = [];
        const chat = castChat(
          async () => remembered(lines),
          (_request, signal) => {
            signals.push(signal);
            return (async function* () {
              yield { text: "In progress" };
              await finish.promise;
              if (signal.aborted) return;
              yield { text: "The completed reply" };
            })();
          },
        );
        chat.state().setGreetings([]);
        await chat.sheet([]);
        const sending = chat.say("Hi");
        await tick();
        expect(chat.state().generating).toBe(true);
        expect(replyMessage(chat.state(), 0)?.replies[0]).toMatchObject({
          text: "In progress",
          status: "streaming",
        });
        const before = chat.state().cast;
        chat
          .state()
          .receiveCastMemory(
            CHARACTER,
            remembered(
              changed ? [JSON.stringify({ name: "Wren", gender: "female" })] : unchangedLines,
              2,
            ),
          );
        expect(chat.state().cast.memory?.revision).toBe(2);
        expect(signals[0]?.aborted).toBe(false);
        expect(chat.state().generating).toBe(true);
        if (!changed) {
          expect(chat.state().generating).toBe(true);
          expect(chat.state().cast.snapshots).toBe(before.snapshots);
          expect(chat.state().cast.memory?.entries).toBe(before.memory?.entries);
        }
        finish.resolve();
        await sending;
        expect(chat.state().generating).toBe(false);
        expect(replyMessage(chat.state(), 0)?.replies[0]).toMatchObject({
          text: "The completed reply",
          status: "complete",
        });
        expect(chat.keeper).toHaveLength(1);
        expect(chat.keeper[0]?.request.register.entries.map((entry) => entry.anchor.name)).toEqual(
          changed ? ["Wren"] : populated ? ["Ilse Brandt"] : [],
        );
      });
    }
  }

  it("sends a bounded full register without evicting established people for notebook seeds", async () => {
    const chat = castChat(async () => remembered([]));
    chat.state().setGreetings([]);
    await chat.sheet([]);
    await chat.say("Hi");
    const namesBefore = Array.from({ length: CAST_LIMITS.entries }, (_, i) => `Known ${i}`);
    await chat.answer({
      cast: Object.fromEntries(namesBefore.map((name) => [name, { gender: "female" }])),
      absent: [],
    });
    chat.state().receiveCastMemory(
      CHARACTER,
      remembered(
        Array.from({ length: 32 }, (_, i) =>
          JSON.stringify({ name: `Remembered ${i}`, gender: "female" }),
        ),
        2,
      ),
    );
    expect(names(chat.state())).toEqual(namesBefore);
    await chat.say("Next");
    expect(chat.generated[1]?.cast?.entries.map((entry) => entry.anchor.name)).toEqual(namesBefore);
    expect(chat.keeper[1]?.request.register.entries).toHaveLength(40);
  });
  it("locks a generation waiting for the notebook and honors Stop before any upstream request", async () => {
    const memory = deferred<CharacterMemory | undefined>();
    const chat = castChat(() => memory.promise);
    const sending = chat.say("Hi");
    await tick();
    expect(chat.state().generating).toBe(true);
    await chat.say("Duplicate");
    expect(chat.generated).toHaveLength(0);
    chat.state().stop();
    await sending;
    expect(chat.generated).toHaveLength(0);
    expect(chat.state().generating).toBe(false);
    expect(chat.sheets[0]?.signal.aborted).toBe(false);
    chat.state().setDraft("Can interact");
    expect(chat.state().draft).toBe("Can interact");
    const next = chat.state().send();
    await tick();
    expect(chat.state().generating).toBe(true);
    chat.state().stop();
    await next;
    chat.state().clear();
    memory.resolve(remembered([NPC_LINE]));
    await tick();
    expect(chat.generated).toHaveLength(0);
    expect(chat.state().messages).toEqual([]);
    expect(names(chat.state())).toEqual([]);
  });
  for (const first of ["sheet", "memory"] as const) {
    it(`waits for both sources when ${first} lands first and seeds only once`, async () => {
      const memory = deferred<CharacterMemory | undefined>();
      const load = vi.fn(() => memory.promise);
      const chat = castChat(load);
      chat.state().setGreetings(["Hello"]);
      if (first === "sheet") await chat.sheet([SHEET_ENTRY]);
      else {
        memory.resolve(remembered([NPC_LINE]));
        await tick();
      }
      expect(chat.keeper).toHaveLength(0);
      if (first === "sheet") memory.resolve(remembered([NPC_LINE]));
      else await chat.sheet([SHEET_ENTRY]);
      await tick();
      expect(chat.keeper).toHaveLength(1);
      expect(
        chat.keeper[0]?.request.register.entries.map((entry) => [
          entry.anchor.name,
          entry.role,
          entry.state.present,
        ]),
      ).toEqual([
        ["Ava Lind", "principal", false],
        ["Ilse Brandt", "minor", false],
      ]);
      await chat.answer({ cast: {}, absent: [] });
      await chat.say("Hi");
      expect(load).toHaveBeenCalledTimes(1);
      expect(chat.generated[0]?.cast?.entries[1]?.anchor.hair).toBe("black bob");
    });
  }

  it("waits for the notebook before the first generation even when the sheet is ready", async () => {
    const memory = deferred<CharacterMemory | undefined>();
    const chat = castChat(() => memory.promise);
    const sending = chat.say("Hi");
    await chat.sheet([SHEET_ENTRY]);
    expect(chat.generated).toHaveLength(0);
    memory.resolve(
      remembered([
        JSON.stringify({ name: "Ava Lind", gender: "female", hair: "black" }),
        NPC_LINE,
        "invalid {",
      ]),
    );
    await sending;
    expect(
      chat.generated[0]?.cast?.entries.map((entry) => [entry.anchor.name, entry.anchor.hair]),
    ).toEqual([
      ["Ava Lind", "copper"],
      ["Ilse Brandt", "black bob"],
    ]);
  });

  it("sends remembered anchors while the sheet is pending, then overlays it without duplicate identities", async () => {
    const chat = castChat(async () =>
      remembered([JSON.stringify({ name: "Ava Lind", gender: "female", hair: "black" }), NPC_LINE]),
    );
    chat.state().setGreetings(["Hello"]);
    await tick();
    expect(chat.state().cast.sheetStatus).toBe("loading");
    expect(chat.keeper).toHaveLength(0);

    await chat.say("Hi");
    expect(chat.generated).toHaveLength(1);
    expect(
      chat.generated[0]?.cast?.entries.map((entry) => [entry.anchor.name, entry.anchor.hair]),
    ).toEqual([
      ["Ava Lind", "black"],
      ["Ilse Brandt", "black bob"],
    ]);
    expect(chat.keeper).toHaveLength(1);
    expect(chat.keeper[0]?.request).toMatchObject({ mode: "update", sheetFingerprint: null });
    await chat.answer(upsert("Ava Lind", { outfit: "coat" }));
    const avaId = entry(chat.state(), "Ava Lind")?.id;
    const ilseId = entry(chat.state(), "Ilse Brandt")?.id;
    expect(avaId).toBeDefined();
    expect(ilseId).toBeDefined();
    expect(chat.sheets[0]?.signal.aborted).toBe(false);

    await chat.sheet([SHEET_ENTRY]);
    expect(names(chat.state())).toEqual(["Ava Lind", "Ilse Brandt"]);
    expect(entry(chat.state(), "Ava Lind")).toMatchObject({
      id: avaId,
      anchor: { hair: "copper" },
      state: { outfit: "coat", present: true },
    });
    expect(entry(chat.state(), "Ilse Brandt")?.id).toBe(ilseId);
    expect(chat.keeper).toHaveLength(1);

    await chat.say("Next");
    const entries = chat.generated[1]?.cast?.entries ?? [];
    expect(entries.map((entry) => entry.id)).toEqual([avaId, ilseId]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(chat.keeper[1]?.request.sheetFingerprint).toBe(FINGERPRINT);
  });

  it("keeps card-only failure usable and retries memory without changing admitted ids", async () => {
    const load = vi
      .fn<NonNullable<Parameters<typeof castChat>[0]>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(remembered([NPC_LINE]));
    const chat = castChat(load);
    chat.state().setGreetings(["Hello"]);
    await chat.sheet([SHEET_ENTRY]);
    await tick();
    expect(chat.keeper[0]?.request.register.entries.map((entry) => entry.anchor.name)).toEqual([
      "Ava Lind",
    ]);
    await chat.answer({ cast: {}, absent: [] });
    await chat.say("Hi");
    expect(names(chat.state())).toEqual(["Ava Lind", "Ilse Brandt"]);
    const id = entry(chat.state(), "Ilse Brandt")?.id;
    await chat.answer({ cast: {}, absent: [] });
    await chat.say("Again");
    expect(entry(chat.state(), "Ilse Brandt")?.id).toBe(id);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores disabled memory and never seeds the player", async () => {
    const chat = castChat(async () => remembered([NPC_LINE], 1, false));
    chat.state().setGreetings([]);
    await chat.sheet([]);
    await chat.say("Hi");
    expect(names(chat.state())).toEqual([]);
    chat.selection.personaId = uuid(8);
    chat
      .state()
      .receiveCastMemory(
        CHARACTER,
        remembered(
          [
            JSON.stringify({ name: "Rowan", gender: "other" }),
            JSON.stringify({ name: "{{user}}", gender: "other" }),
            NPC_LINE,
          ],
          2,
        ),
      );
    expect(names(chat.state())).toEqual(["Ilse Brandt"]);
  });

  it("refilters remembered people when the selected persona becomes known", async () => {
    const load = vi.fn(async () =>
      remembered([JSON.stringify({ name: "Rowan", gender: "other" }), NPC_LINE]),
    );
    const chat = castChat(load);
    chat.state().setGreetings([]);
    await chat.sheet([]);
    await tick();
    expect(names(chat.state())).toEqual(["Rowan", "Ilse Brandt"]);
    chat.selection.personaId = uuid(8);
    await chat.say("Hi");
    expect(chat.generated[0]?.cast?.entries.map((entry) => entry.anchor.name)).toEqual([
      "Ilse Brandt",
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("fences Clear and character switches and gives the next chat fresh seed ids", async () => {
    const loads: ReturnType<typeof deferred<CharacterMemory | undefined>>[] = [];
    const chat = castChat(async () => {
      const load = deferred<CharacterMemory | undefined>();
      loads.push(load);
      return load.promise;
    });
    chat.state().setGreetings([]);
    chat.state().clear();
    loads[0]?.resolve(remembered([NPC_LINE]));
    await chat.sheet([]);
    expect(names(chat.state())).toEqual([]);
    chat.state().setGreetings([]);
    loads[1]?.resolve(remembered([NPC_LINE]));
    await chat.sheet([]);
    await tick();
    const first = entry(chat.state(), "Ilse Brandt")?.id;
    expect(first).toBeDefined();
    chat.state().clear();
    chat.state().setGreetings([]);
    chat.selection.characterId = OTHER_CHARACTER;
    loads[2]?.resolve(remembered([NPC_LINE]));
    await chat.sheet([]);
    expect(names(chat.state())).toEqual([]);
    chat.selection.characterId = CHARACTER;
    chat.state().clear();
    chat.state().setGreetings([]);
    loads[3]?.resolve(remembered([NPC_LINE]));
    await chat.sheet([]);
    await tick();
    expect(entry(chat.state(), "Ilse Brandt")?.id).not.toBe(first);
  });

  it("replaces edited seed-only people, fences old keeper answers, and keeps established people on Forget", async () => {
    const chat = castChat(async () =>
      remembered([NPC_LINE, JSON.stringify({ name: "Wren", gender: "female" })]),
    );
    chat.state().setGreetings(["Hello"]);
    await chat.sheet([]);
    await tick();
    chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 2));
    expect(chat.keeper[0]?.signal.aborted).toBe(true);
    await chat.answer({ cast: { Wren: {} }, absent: [] }, 0);
    expect(names(chat.state())).toEqual(["Ilse Brandt"]);
    chat.state().retryCast();
    await tick();
    await chat.answer({ cast: { "Ilse Brandt": { state: { outfit: "coat" } } }, absent: [] });
    const id = entry(chat.state(), "Ilse Brandt")?.id;
    chat.state().receiveCastMemory(CHARACTER, remembered([], 3));
    expect(entry(chat.state(), "Ilse Brandt")).toMatchObject({ id, state: { outfit: "coat" } });
    await chat.say("Next");
    expect(chat.keeper.at(-1)?.request.register.entries.map((entry) => entry.anchor.name)).toEqual([
      "Ilse Brandt",
    ]);
  });

  it("does not restore seed-only people from snapshots after disable or a pending older load", async () => {
    const pending = deferred<CharacterMemory | undefined>();
    const chat = castChat(() => pending.promise);
    chat.state().setGreetings([]);
    chat.state().receiveCastMemory(CHARACTER, remembered([], 2, false));
    pending.resolve(remembered([NPC_LINE], 1));
    await chat.sheet([]);
    await tick();
    expect(names(chat.state())).toEqual([]);
    chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 3));
    await chat.say("Hi");
    await chat.answer({ cast: {}, absent: [] });
    chat.state().receiveCastMemory(CHARACTER, remembered([NPC_LINE], 4, false));
    expect(names(chat.state())).toEqual([]);
    await chat.say("Again");
    await chat.answer({ cast: {}, absent: [] });
    expect(names(chat.state())).toEqual([]);
  });

  it("Undo cannot restore a deleted seed-only overlay from a removed reply's saved snapshot", async () => {
    const chat = castChat(async () => remembered([NPC_LINE]));
    chat.state().setGreetings([]);
    await chat.sheet([]);
    await chat.say("Hi");
    await chat.answer({ cast: {}, absent: [] });
    chat.state().remove(replyMessage(chat.state(), 0)?.id ?? "");
    chat.state().receiveCastMemory(CHARACTER, remembered([], 2));
    chat.state().undoDelete();
    expect(names(chat.state())).toEqual([]);
  });
});
