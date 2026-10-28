import { CARD_LIMITS, type ReworkCard, type ReworkEvent } from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import { SignedOut } from "../signin/signin.ts";
import { tick } from "../testing.ts";
import {
  acceptedChanges,
  createReworkStore,
  isLocked,
  leftByUndo,
  ReworkRefused,
  type StreamRework,
} from "./store.ts";

/** A stream the test drives by hand; `push`/`finish` target the latest call. */
function controlled() {
  const calls: {
    signal: AbortSignal;
    request: unknown;
    push: (event: ReworkEvent) => void;
    finish: (error?: Error) => void;
  }[] = [];
  const open: StreamRework = async (request, signal) => {
    const queue: ReworkEvent[] = [];
    let done: { error?: Error } | undefined;
    let wake: () => void = () => {};
    calls.push({
      request,
      signal,
      push: (event) => {
        queue.push(event);
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
    open,
    calls,
    push: (event: ReworkEvent) => calls.at(-1)?.push(event),
    finish: (error?: Error) => calls.at(-1)?.finish(error),
  };
}

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const PERSONA = "00000000-0000-4000-8000-000000000003";

const CARD: ReworkCard = {
  name: "Ada Reed",
  description: "Ada is 24. She graduated in 2009 and keeps the placeholder light.",
  personality: "Calm.",
  scenario: "",
  firstMessage: "Ada looks up.",
  alternateGreetings: ["Rain."],
  exampleDialogue: "",
  systemPrompt: "",
  postHistoryInstructions: "",
  creatorNotes: "",
  tags: ["drama"],
  characterNote: null,
  lorebook: null,
};

const block = (field: string, find: string, replace: string) =>
  `<change>\n<field>${field}</field>\n<why>Placeholder reason.</why>\n<find>${find}</find>\n<replace>${replace}</replace>\n</change>\n`;

const BLOCKS = [
  block("description", "is 24", "is 34"),
  block("description", "graduated in 2009", "graduated in 2011"),
  block("personality", "Calm.", "Calm and dry."),
  block("entry_new_1", "", "The placeholder harbour."),
  block("entry_new_1_name", "", "Harbour"),
  block("nickname", "", "Ace"),
];
const ANSWER = `${BLOCKS.join("")}<summary>Placeholder summary.</summary>`;

function setup(signedIn = () => true) {
  const stream = controlled();
  const writing = vi.fn<(writing: boolean) => void>();
  const store = createReworkStore({ streamRework: stream.open, signedIn, writing });
  const start = (card: ReworkCard = CARD) => {
    store.getState().open(ID);
    store.getState().setRequest("Make her a decade older.");
    store.getState().start({
      characterId: ID,
      model: "model-a",
      reasoning: store.getState().reasoning,
      personaId: null,
      portrait: false,
      card,
    });
  };
  return { store, stream, writing, start };
}

/** A complete answer under review. */
async function reviewed(context: ReturnType<typeof setup>) {
  context.start();
  await tick();
  context.stream.push({ type: "delta", text: ANSWER });
  context.stream.push({ type: "result", problems: [] });
  context.stream.finish();
  await vi.waitFor(() => expect(context.store.getState().phase).toBe("review"));
}

describe("rework store", () => {
  it("sends the request with the card as it stood", async () => {
    const { store, stream } = setup();
    store.getState().open(ID);
    store.getState().setRequest("Make her a decade older.");
    store.getState().start({
      characterId: ID,
      model: "model-a",
      reasoning: "high",
      personaId: PERSONA,
      portrait: true,
      card: CARD,
    });
    await tick();
    expect(stream.calls[0]?.request).toEqual({
      characterId: ID,
      model: "model-a",
      reasoning: "high",
      request: "Make her a decade older.",
      personaId: PERSONA,
      portrait: true,
      card: CARD,
    });
  });

  it("omits reasoning at the model default", async () => {
    const { stream, start } = setup();
    start();
    await tick();
    expect(stream.calls[0]?.request).not.toHaveProperty("reasoning");
  });

  it("reads each change once, as its block closes, placed against the card as sent", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    const counts: number[] = [];
    for (let at = 0; at < ANSWER.length; at += 7) {
      stream.push({ type: "delta", text: ANSWER.slice(at, at + 7) });
      await tick();
      const closed = ANSWER.slice(0, at + 7).split("</change>").length - 1;
      expect(store.getState().changes).toHaveLength(closed);
      counts.push(store.getState().changes.length);
    }
    expect(counts.at(-1)).toBe(BLOCKS.length);
    const changes = store.getState().changes;
    expect(changes.map((change) => change.ok)).toEqual([true, true, true, true, true, false]);
    for (const change of changes) {
      if (!change.ok || change.change.field.kind !== "text") continue;
      const { start: from, end, find } = change.change;
      expect(CARD[change.change.field.key]).toSatisfy(
        (text: unknown) => typeof text === "string" && text.slice(from, end) === find,
      );
    }
    // The parts of one new entry go together; a change that was not placed is never accepted.
    expect(changes.map((change) => change.group)).toEqual([
      "description",
      "description",
      "personality",
      "entry_new_1",
      "entry_new_1",
      "nickname",
    ]);
    expect(changes.map((change) => change.decision)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "rejected",
    ]);
  });

  it("decides a conversion and the fields it clears together", async () => {
    const { store, stream, start } = setup();
    start({ ...CARD, scenario: "Ada waits at the gate." });
    await tick();
    const decisions = () => store.getState().changes.map((change) => change.decision);
    stream.push({
      type: "delta",
      text:
        block("description", "", "<ada_reed>Calm and dry.</ada_reed>") +
        block("personality", "", ""),
    });
    await tick();
    expect(decisions()).toEqual(["accepted", "accepted"]);

    store.getState().reject(0);
    expect(decisions()).toEqual(["rejected", "rejected"]);
    // A clearing that arrives after the owner decided takes its conversion's decision.
    stream.push({ type: "delta", text: block("scenario", "", "") });
    await tick();
    expect(decisions()).toEqual(["rejected", "rejected", "rejected"]);

    // Accepting a clearing accepts its conversion; rejecting one alone leaves the conversion.
    store.getState().accept(1);
    expect(decisions()).toEqual(["accepted", "accepted", "rejected"]);
    store.getState().reject(1);
    expect(decisions()).toEqual(["accepted", "rejected", "rejected"]);
  });

  it("completes with the summary and the problems the server found", async () => {
    const context = setup();
    await reviewed(context);
    expect(context.store.getState()).toMatchObject({
      phase: "review",
      ended: "complete",
      failure: null,
      summary: "Placeholder summary.",
      problems: [],
    });
  });

  it("Stop keeps what arrived and ignores what comes after", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({ type: "delta", text: BLOCKS.slice(0, 2).join("") });
    await tick();
    store.getState().stop();
    expect(stream.calls[0]?.signal.aborted).toBe(true);
    stream.push({ type: "delta", text: BLOCKS[2] ?? "" });
    await tick();
    expect(store.getState()).toMatchObject({ phase: "review", ended: "stopped" });
    expect(store.getState().changes).toHaveLength(2);
  });

  it("an error keeps the changes that arrived, with its code", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({ type: "delta", text: BLOCKS[0] ?? "" });
    stream.push({ type: "error", code: "upstream" });
    await vi.waitFor(() => expect(store.getState().ended).toBe("failed"));
    expect(store.getState()).toMatchObject({ phase: "review", failure: "upstream" });
    expect(store.getState().changes).toHaveLength(1);
  });

  it("a stream that ends without a result failed", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({ type: "delta", text: BLOCKS[0] ?? "" });
    stream.finish();
    await vi.waitFor(() => expect(store.getState().ended).toBe("failed"));
    expect(store.getState().failure).toBe("stream");
  });

  it("accepts and rejects one change, or a new entry's parts together", async () => {
    const context = setup();
    await reviewed(context);
    const { store } = context;
    store.getState().reject(1);
    expect(store.getState().changes[1]?.decision).toBe("rejected");
    store.getState().accept(1);
    expect(store.getState().changes[1]?.decision).toBe("accepted");
    store.getState().setGroup("entry_new_1", "rejected");
    expect(
      store
        .getState()
        .changes.slice(3, 5)
        .map((change) => change.decision),
    ).toEqual(["rejected", "rejected"]);
    // A change that was not placed cannot be accepted.
    store.getState().accept(5);
    expect(store.getState().changes[5]?.decision).toBe("rejected");
    expect(acceptedChanges(store.getState()).map((change) => change.at)).toEqual([0, 1, 2]);
  });

  it("a new entry's parts that arrive after its group was decided take that decision", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({ type: "delta", text: block("entry_new_1", "", "The placeholder harbour.") });
    await vi.waitFor(() => expect(store.getState().changes).toHaveLength(1));
    store.getState().setGroup("entry_new_1", "rejected");
    stream.push({
      type: "delta",
      text: [
        block("entry_new_1_name", "", "Harbour"),
        block("entry_new_1_keys", "", "harbour, quay"),
        block("entry_new_2", "", "The placeholder mill."),
      ].join(""),
    });
    await vi.waitFor(() => expect(store.getState().changes).toHaveLength(4));
    expect(store.getState().changes.map((change) => change.decision)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "accepted",
    ]);
    expect(acceptedChanges(store.getState()).map((change) => change.at)).toEqual([3]);
  });

  it("an answer cut off before it finished ends as a cut stream, keeping what arrived", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({ type: "delta", text: `${BLOCKS[0]}<change>\n<field>personality</field>` });
    stream.push({ type: "result", problems: ["incomplete", "no_summary"] });
    stream.finish();
    await vi.waitFor(() => expect(store.getState().phase).toBe("review"));
    expect(store.getState()).toMatchObject({
      ended: "failed",
      failure: "stream",
      problems: ["incomplete", "no_summary"],
    });
    expect(acceptedChanges(store.getState())).toHaveLength(1);
  });

  it("an answer with neither a change nor a summary is cut, not unchanged", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({ type: "delta", text: "I will rework" });
    stream.push({ type: "result", problems: ["no_summary"] });
    stream.finish();
    await vi.waitFor(() => expect(store.getState().phase).toBe("review"));
    expect(store.getState()).toMatchObject({ ended: "failed", failure: "stream", changes: [] });
  });

  it("a missing summary alone does not stop a review with changes", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({ type: "delta", text: BLOCKS.slice(0, 2).join("") });
    stream.push({ type: "result", problems: ["no_summary"] });
    stream.finish();
    await vi.waitFor(() => expect(store.getState().phase).toBe("review"));
    expect(store.getState()).toMatchObject({ ended: "complete", failure: null, summary: null });
    expect(store.getState().changes).toHaveLength(2);
  });

  it("applies only the accepted changes and keeps an Undo snapshot, nothing else", async () => {
    const context = setup();
    await reviewed(context);
    const { store } = context;
    store.getState().reject(2);
    store.getState().setGroup("entry_new_1", "rejected");
    const result = store.getState().apply();
    expect(result?.touched).toEqual(["description"]);
    expect(result?.next).toEqual({
      description: "Ada is 34. She graduated in 2011 and keeps the placeholder light.",
    });
    expect(store.getState()).toMatchObject({
      phase: "applied",
      request: "",
      base: null,
      answer: "",
      changes: [],
      applied: {
        written: result?.next,
        previous: { description: CARD.description },
        count: 2,
        undone: null,
      },
    });
    expect(isLocked(store.getState())).toBe(false);
  });

  it("keeps the review when the accepted changes would break a field, and names it", async () => {
    const description = `Head. ${"x".repeat(CARD_LIMITS.textLength - 12)} Tail.`;
    const { store, stream, start } = setup();
    start({ ...CARD, description });
    await tick();
    // Placed together they fit: the first change makes room for the second.
    stream.push({
      type: "delta",
      text: `${block("description", "Head. ", "")}${block("description", " Tail.", " Tails, end.")}<summary>S.</summary>`,
    });
    stream.push({ type: "result", problems: [] });
    stream.finish();
    await vi.waitFor(() => expect(store.getState().phase).toBe("review"));
    expect(acceptedChanges(store.getState())).toHaveLength(2);
    store.getState().reject(0);
    expect(store.getState().apply()).toBeNull();
    expect(store.getState()).toMatchObject({
      phase: "review",
      applyProblem: { field: "Description", kind: "too_long" },
      applied: null,
    });
    expect(store.getState().changes).toHaveLength(2);
    // Another decision clears it; with the room restored, Apply writes.
    store.getState().accept(0);
    expect(store.getState().applyProblem).toBeNull();
    expect(store.getState().apply()?.next.description).toHaveLength(CARD_LIMITS.textLength);
    expect(store.getState().phase).toBe("applied");
  });

  it("Undo restores the fields not typed in since, and names the ones it left", async () => {
    const context = setup();
    await reviewed(context);
    const { store } = context;
    store.getState().setGroup("entry_new_1", "rejected");
    const result = store.getState().apply();
    const written = { ...CARD, ...result?.next };
    expect(leftByUndo(store.getState(), written)).toEqual([]);
    const typed = { ...written, personality: `${written.personality} More.` };
    expect(leftByUndo(store.getState(), typed)).toEqual(["Personality"]);
    expect(store.getState().undo(typed)).toEqual({ description: CARD.description });
    expect(store.getState().applied?.undone).toEqual({
      restored: 2,
      skipped: ["Personality"],
      kept: [],
    });
    // Once only.
    expect(store.getState().undo(written)).toEqual({});
    store.getState().finish();
    expect(store.getState()).toMatchObject({ phase: "idle", applied: null });
  });

  it("Undo leaves a conversion whole when a field it cleared was typed in since", async () => {
    const { store, stream, start } = setup();
    start();
    await tick();
    stream.push({
      type: "delta",
      text: `${block("description", "", "<ada_reed>Calm.</ada_reed>")}${block("personality", "", "")}<summary>Converted.</summary>`,
    });
    stream.push({ type: "result", problems: [] });
    stream.finish();
    await vi.waitFor(() => expect(store.getState().phase).toBe("review"));
    const result = store.getState().apply();
    const written = { ...CARD, ...result?.next };
    expect(written.personality).toBe("");
    const typed = { ...written, personality: "New." };
    expect(leftByUndo(store.getState(), typed)).toEqual(["Personality", "Description"]);
    // The description keeps the old personality's text, so it stays as applied.
    expect(store.getState().undo(typed)).toEqual({});
    expect(store.getState().applied?.undone).toEqual({
      restored: 0,
      skipped: ["Personality"],
      kept: ["Description"],
    });
  });

  it("compares lists and the book by identity", async () => {
    const context = setup();
    await reviewed(context);
    const { store } = context;
    const result = store.getState().apply();
    const written = { ...CARD, ...result?.next };
    expect(result?.touched).toContain("lorebook");
    const retyped = { ...written, lorebook: structuredClone(written.lorebook) };
    expect(leftByUndo(store.getState(), retyped)).toEqual(["Lorebook"]);
  });

  it("Discard keeps the request and composer choices, drops the run and ignores a late delta", async () => {
    const { store, stream, start } = setup();
    store.getState().open(ID);
    store.getState().setModel("model-a");
    store.getState().setReasoning("high");
    store.getState().setPortrait(true);
    start();
    await tick();
    stream.push({ type: "delta", text: BLOCKS[0] ?? "" });
    await tick();
    const epoch = store.getState().epoch;
    store.getState().discard();
    expect(stream.calls[0]?.signal.aborted).toBe(true);
    stream.push({ type: "delta", text: BLOCKS[1] ?? "" });
    await tick();
    expect(store.getState()).toMatchObject({
      phase: "idle",
      request: "Make her a decade older.",
      model: "model-a",
      reasoning: "high",
      portrait: true,
      base: null,
      answer: "",
      changes: [],
      ended: null,
    });
    expect(store.getState().epoch).toBeGreaterThan(epoch);
  });

  it("clear empties the request too; another character's sheet clears, the same one keeps", () => {
    const { store } = setup();
    expect(store.getState().reasoning).toBe("provider-default");
    store.getState().open(ID);
    store.getState().setRequest("Make her a decade older.");
    store.getState().setReasoning("high");
    store.getState().open(ID);
    expect(store.getState().request).toBe("Make her a decade older.");
    expect(store.getState().reasoning).toBe("high");
    store.getState().open(OTHER_ID);
    expect(store.getState()).toMatchObject({
      characterId: OTHER_ID,
      request: "",
      reasoning: "provider-default",
    });
    store.getState().setRequest("Another request.");
    store.getState().setReasoning("low");
    store.getState().clear();
    expect(store.getState()).toMatchObject({
      characterId: null,
      request: "",
      reasoning: "provider-default",
    });
  });

  it("another rework ends the last Apply's Undo", async () => {
    const context = setup();
    await reviewed(context);
    context.store.getState().apply();
    context.store.getState().setRequest("Now make her taller.");
    context.store.getState().start({
      characterId: ID,
      model: "model-a",
      reasoning: "provider-default",
      personaId: null,
      portrait: false,
      card: CARD,
    });
    expect(context.store.getState()).toMatchObject({ phase: "working", applied: null });
  });

  it("binds the sheet's character again after a clear (back/forward restore) and starts", async () => {
    const { store, stream } = setup();
    store.getState().open(ID);
    store.getState().clear();
    expect(store.getState().characterId).toBeNull();
    const options = {
      characterId: ID,
      model: "model-a",
      reasoning: "provider-default" as const,
      personaId: null,
      portrait: false,
      card: CARD,
    };
    // Nothing to send: no run, and the composer stays.
    expect(store.getState().start(options)).toBe(false);
    store.getState().setRequest("Make her a decade older.");
    expect(store.getState().start({ ...options, characterId: OTHER_ID })).toBe(true);
    expect(store.getState().characterId).toBe(OTHER_ID);
    store.getState().discard();
    // Another character's sheet cannot start a run in this session.
    expect(store.getState().start(options)).toBe(false);
    store.getState().clear();
    store.getState().setRequest("Make her a decade older.");
    expect(store.getState().start(options)).toBe(true);
    await tick();
    expect(stream.calls.at(-1)?.request).toMatchObject({ characterId: ID });
    expect(store.getState().phase).toBe("working");
    // A run under way: a second start begins nothing.
    expect(store.getState().start(options)).toBe(false);
  });

  it("tells a refused request from a cut answer: too large to send, or not valid", async () => {
    for (const reason of ["payload_too_large", "invalid_request"] as const) {
      const { store, stream, start } = setup();
      start();
      await tick();
      stream.finish(new ReworkRefused(reason));
      await vi.waitFor(() => expect(store.getState().phase).toBe("review"));
      expect(store.getState()).toMatchObject({ ended: "failed", failure: reason, changes: [] });
    }
  });

  it("waits for a sign-in that refused the run before any event, then sends it once more", async () => {
    let signedIn = false;
    const { store, stream, start } = setup(() => signedIn);
    store.getState().open(ID);
    store.getState().setReasoning("high");
    start();
    await tick();
    stream.finish(new SignedOut());
    await vi.waitFor(() => expect(store.getState().phase).toBe("waiting"));
    expect(isLocked(store.getState())).toBe(true);
    store.getState().setReasoning("low");
    store.getState().setModel("model-b");
    signedIn = true;
    store.getState().resume();
    await tick();
    expect(stream.calls).toHaveLength(2);
    expect(stream.calls[1]?.request).toEqual(stream.calls[0]?.request);
    expect(stream.calls[1]?.request).toMatchObject({ model: "model-a", reasoning: "high" });
    expect(store.getState().phase).toBe("working");
    store.getState().resume();
    await tick();
    expect(stream.calls).toHaveLength(2);
  });

  it("locks the sheet while working, waiting and under review only", async () => {
    const context = setup();
    expect(isLocked(context.store.getState())).toBe(false);
    context.start();
    expect(isLocked(context.store.getState())).toBe(true);
    await tick();
    context.stream.push({ type: "delta", text: ANSWER });
    context.stream.push({ type: "result", problems: [] });
    await vi.waitFor(() => expect(context.store.getState().phase).toBe("review"));
    expect(isLocked(context.store.getState())).toBe(true);
    context.store.getState().apply();
    expect(isLocked(context.store.getState())).toBe(false);
  });

  it("tells the lamp only while the model is writing", async () => {
    const context = setup();
    await reviewed(context);
    expect(context.writing.mock.calls).toEqual([[true], [false]]);
    context.store.getState().clear();
    expect(context.writing).toHaveBeenCalledTimes(2);
  });
});
