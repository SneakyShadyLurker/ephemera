import type {
  ArtStreamEvent,
  BrainstormOption,
  CreatorBrainstormEvent,
  CreatorBrainstormRequest,
  CreatorCardEvent,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { SignedOut } from "../signin/signin.ts";
import { controlled, tick } from "../testing.ts";
import type { StreamArt } from "./art-slice.ts";
import type { StreamBrainstorm } from "./brainstorm-slice.ts";
import { createCreatorStore, hasUnsavedCard, keeping, type StreamCard } from "./store.ts";

/** Idea `n` of a list told apart by `tag`. */
const idea = (n: number, tag = "a"): BrainstormOption => ({
  pitch: `Idea ${n} of list ${tag}`,
  brief: `A placeholder brief ${n} of list ${tag}.`,
});
const list = (tag: string, count = 10) => Array.from({ length: count }, (_, n) => idea(n + 1, tag));

function setup(streamBrainstorm?: StreamBrainstorm, signedIn = () => true) {
  const ideas = controlled<CreatorBrainstormEvent>();
  const card = controlled<CreatorCardEvent>();
  const store = createCreatorStore({
    streamBrainstorm: streamBrainstorm ?? (ideas.open as StreamBrainstorm),
    streamCard: card.open as StreamCard,
    streamArt: controlled<ArtStreamEvent>().open as StreamArt,
    artStatus: async () => ({ state: "off" }),
    signedIn,
    saveCard: async () => ({ ok: true }),
    savePortrait: async () => ({ ok: true, version: 1 }),
  });
  const state = () => store.getState();
  const session = () => store.getState().brainstorm;
  const request = (index = -1) => ideas.calls.at(index)?.request as CreatorBrainstormRequest;
  /** Writes `options` as the current round's lines and its result. */
  const answer = async (options: BrainstormOption[]) => {
    options.forEach((option, index) => {
      ideas.push({ type: "option", index, option });
    });
    ideas.push({ type: "result", options });
    ideas.finish();
    await tick();
  };
  /** A first round classified as `kind` with the list `tag`. */
  const first = async (tag = "a", kind: "subject" | "group" | "scenario" = "scenario") => {
    state().askIdeas("Something slow and tense", "model-a", "provider-default");
    await tick();
    ideas.push({ type: "kind", kind });
    await answer(list(tag));
  };
  return { store, ideas, card, state, session, request, answer, first };
}

describe("brainstorm slice", () => {
  it("classifies, shows the kind, fills in the ideas and settles on the result", async () => {
    const context = setup();
    context.state().openBrainstorm();
    expect(context.state().stage).toBe("brainstorm");
    context.state().askIdeas("Something slow and tense", "model-a", "high");
    expect(context.session()).toMatchObject({
      request: "Something slow and tense",
      status: "classifying",
      kind: null,
    });
    await tick();
    expect(context.request()).toEqual({
      description: "Something slow and tense",
      rounds: [],
      model: "model-a",
      reasoning: "high",
    });
    context.ideas.push({ type: "kind", kind: "scenario" });
    context.ideas.push({ type: "thinking" });
    await tick();
    expect(context.session()).toMatchObject({
      kind: "scenario",
      status: "writing",
      thinking: true,
    });
    context.ideas.push({ type: "option", index: 0, option: idea(1) });
    context.ideas.push({ type: "option", index: 1, option: idea(2) });
    await tick();
    expect(context.session().incoming).toEqual([idea(1), idea(2)]);
    expect(context.session().options).toEqual([]);
    await context.answer(list("a").slice(2));
    expect(context.session()).toMatchObject({ status: "complete", incoming: [], failure: null });
    expect(context.session().options).toEqual(list("a").slice(2));
  });

  it("a retry empties the ideas so far and marks the round retried", async () => {
    const context = setup();
    context.state().askIdeas("A mood", "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "kind", kind: "subject" });
    context.ideas.push({ type: "option", index: 0, option: idea(1) });
    context.ideas.push({ type: "retry" });
    await tick();
    expect(context.session()).toMatchObject({ incoming: [], retried: true, status: "writing" });
  });

  it("feedback rounds carry the shown list with what was said, the last three only", async () => {
    const context = setup();
    await context.first("a");
    for (const tag of ["b", "c", "d"]) {
      context.state().adjustIdeas(`Keep 3, list ${tag}`, "model-a", "provider-default");
      expect(context.session().status).toBe("writing");
      await tick();
      await context.answer(list(tag));
    }
    context.state().adjustIdeas("  ", "model-b", "provider-default");
    await tick();
    expect(context.request()).toEqual({
      description: "Something slow and tense",
      kind: "scenario",
      rounds: [
        { kind: "scenario", options: list("b"), feedback: "Keep 3, list c" },
        { kind: "scenario", options: list("c"), feedback: "Keep 3, list d" },
        { kind: "scenario", options: list("d") },
      ],
      model: "model-b",
    });
    // A feedback round never changes the kind.
    expect(context.session().kind).toBe("scenario");
  });

  it("a kind switch sends the new kind with the shown list and no feedback", async () => {
    const context = setup();
    await context.first("a");
    context.state().switchIdeasKind("subject", "model-a", "provider-default");
    expect(context.session()).toMatchObject({ kind: "subject", status: "writing" });
    await tick();
    expect(context.request()).toMatchObject({
      kind: "subject",
      rounds: [{ kind: "scenario", options: list("a") }],
    });
    expect(context.request().rounds[0]).not.toHaveProperty("feedback");
    await context.answer(list("b"));
    expect(context.session()).toMatchObject({ kind: "subject", options: list("b") });
    expect(context.session().rounds).toEqual([{ kind: "scenario", options: list("a") }]);
  });

  it("an attempt stopped before any idea is no round, and the next one classifies again", async () => {
    const context = setup();
    context.state().askIdeas("A mood", "model-a", "provider-default");
    await tick();
    context.state().stopIdeas();
    expect(context.session()).toMatchObject({ status: "stopped", kind: null, options: [] });
    expect(context.ideas.calls[0]?.signal.aborted).toBe(true);
    context.state().adjustIdeas("", "model-a", "provider-default");
    expect(context.session().status).toBe("classifying");
    await tick();
    expect(context.request()).toEqual({ description: "A mood", rounds: [], model: "model-a" });
  });

  it("an unclear kind fails unselected, and choosing one runs the brainstorm as a first round", async () => {
    const context = setup();
    context.state().askIdeas("A mood", "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "error", code: "kind_unclear" });
    context.ideas.finish();
    await tick();
    expect(context.session()).toMatchObject({
      status: "failed",
      failure: "kind_unclear",
      kind: null,
    });
    context.state().switchIdeasKind("group", "model-a", "provider-default");
    await tick();
    expect(context.request()).toEqual({
      description: "A mood",
      kind: "group",
      rounds: [],
      model: "model-a",
    });
  });

  it("a failed replacement round restores the previous list and kind, and adds no round", async () => {
    const context = setup();
    await context.first("a");
    context.state().switchIdeasKind("group", "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "option", index: 0, option: idea(1, "b") });
    context.ideas.push({ type: "error", code: "cut" });
    context.ideas.finish();
    await tick();
    expect(context.session()).toMatchObject({
      status: "failed",
      failure: "cut",
      kind: "scenario",
      options: list("a"),
      incoming: [],
      rounds: [],
    });
    // The next round works from the last real list, once.
    context.state().adjustIdeas("Darker", "model-a", "provider-default");
    await tick();
    expect(context.request().rounds).toEqual([
      { kind: "scenario", options: list("a"), feedback: "Darker" },
    ]);
  });

  it("a stream that ends before its result fails as a broken stream", async () => {
    const context = setup();
    await context.first("a");
    context.state().adjustIdeas("", "model-a", "provider-default");
    await tick();
    context.ideas.finish();
    await tick();
    expect(context.session()).toMatchObject({
      status: "failed",
      failure: "stream",
      options: list("a"),
    });
  });

  it("Stop keeps the ideas that arrived as the list, and late events change nothing", async () => {
    const context = setup();
    await context.first("a");
    context.state().adjustIdeas("Darker", "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "option", index: 0, option: idea(1, "b") });
    context.ideas.push({ type: "option", index: 1, option: idea(2, "b") });
    await tick();
    context.state().stopIdeas();
    expect(context.session()).toMatchObject({
      status: "stopped",
      arrived: 2,
      options: [idea(1, "b"), idea(2, "b")],
      incoming: [],
      rounds: [{ kind: "scenario", options: list("a"), feedback: "Darker" }],
    });
    const before = context.session();
    context.ideas.calls.at(-1)?.push({ type: "option", index: 2, option: idea(3, "b") });
    context.ideas.calls.at(-1)?.push({ type: "retry" });
    context.ideas.calls.at(-1)?.push({ type: "result", options: list("c") });
    await tick();
    expect(context.session()).toEqual(before);
  });

  it("Stop with nothing arrived on a replacement round restores the previous list and kind", async () => {
    const context = setup();
    await context.first("a");
    context.state().switchIdeasKind("subject", "model-a", "provider-default");
    await tick();
    context.state().stopIdeas();
    expect(context.session()).toMatchObject({
      status: "stopped",
      arrived: 0,
      kind: "scenario",
      options: list("a"),
      rounds: [],
    });
  });

  it.each([
    ["resetIdeas", "brainstorm"],
    ["clear", "choose"],
    ["leave", "choose"],
  ] as const)("%s aborts the round and ignores its late events", async (action, stage) => {
    const context = setup();
    context.state().openBrainstorm();
    await context.first("a");
    context.state().adjustIdeas("", "model-a", "provider-default");
    await tick();
    context.state().setIdeasFeedback("Darker");
    const round = context.ideas.calls.at(-1);
    context.state()[action]();
    expect(round?.signal.aborted).toBe(true);
    expect(context.state().stage).toBe(stage);
    expect(context.session()).toMatchObject({
      status: "idle",
      request: "",
      kind: null,
      options: [],
      rounds: [],
      draft: "",
      feedback: "",
    });
    round?.push({ type: "option", index: 0, option: idea(1, "late") });
    round?.push({ type: "result", options: list("late") });
    await tick();
    expect(context.session()).toMatchObject({ status: "idle", options: [], incoming: [] });
  });

  it.each(["clear", "leave"] as const)(
    "%s lets go of a running round, so nothing can send its drafts again",
    async (action) => {
      const context = setup();
      await context.first("a");
      context.state().adjustIdeas("Darker", "model-a", "provider-default");
      await tick();
      context.state()[action]();
      // Even a session that claimed to wait would find no round left to send.
      context.store.setState({ brainstorm: { ...context.session(), status: "waiting" } });
      context.state().resumeIdeas();
      await tick();
      expect(context.ideas.calls).toHaveLength(2);
    },
  );

  it.each(["clear", "leave"] as const)(
    "%s lets go of a round waiting for the sign-in",
    async (action) => {
      let calls = 0;
      const context = setup((async () => {
        calls++;
        throw new SignedOut();
      }) as StreamBrainstorm);
      context.state().askIdeas("A mood", "model-a", "provider-default");
      await tick();
      expect(context.session().status).toBe("waiting");
      context.state()[action]();
      context.store.setState({ brainstorm: { ...context.session(), status: "waiting" } });
      context.state().resumeIdeas();
      await tick();
      expect(calls).toBe(1);
    },
  );

  it("leave lands on Describe when a kind was chosen, without the session", async () => {
    const context = setup();
    context.state().choose("group");
    context.state().openBrainstorm();
    await context.first("a");
    context.state().leave();
    expect(context.state().stage).toBe("describe");
    expect(context.session().options).toEqual([]);
  });

  it.each(["returnToDescription", "discard"] as const)(
    "%s keeps the session, so the card's idea is still one Back away",
    async (action) => {
      const context = setup();
      context.state().openBrainstorm();
      await context.first("a", "subject");
      context.state().pickIdea(2, 120);
      context.state().create("model-a", "provider-default", null);
      await tick();
      context.state()[action]();
      expect(context.state()).toMatchObject({
        stage: "describe",
        card: null,
        description: idea(3).brief,
      });
      expect(context.session()).toMatchObject({
        status: "complete",
        kind: "subject",
        options: list("a"),
        picked: 2,
        scroll: 120,
      });
      context.state().backToIdeas();
      expect(context.state().stage).toBe("brainstorm");
    },
  );

  it("a pick opens Describe with the brief, and Back to ideas remembers the edit", async () => {
    const context = setup();
    context.state().openBrainstorm();
    await context.first("a", "scenario");
    context.state().setArtLook("film");
    context.state().pickIdea(2, 480);
    expect(context.state()).toMatchObject({
      stage: "describe",
      kind: "scenario",
      description: idea(3).brief,
      artLook: "auto",
      artComposition: "regular",
    });
    expect(context.session()).toMatchObject({ picked: 2, scroll: 480 });

    context.state().setDescription("My own take on idea 3");
    context.state().backToIdeas();
    expect(context.state().stage).toBe("brainstorm");
    expect(context.session().edits).toEqual({ 2: "My own take on idea 3" });

    context.state().pickIdea(4, 0);
    expect(context.state().description).toBe(idea(5).brief);
    context.state().backToIdeas();
    // An idea left as written remembers nothing.
    expect(context.session().edits).toEqual({ 2: "My own take on idea 3" });
    context.state().pickIdea(2, 0);
    expect(context.state().description).toBe("My own take on idea 3");
  });

  it("a pick is refused while a round runs", async () => {
    const context = setup();
    context.state().openBrainstorm();
    await context.first("a");
    context.state().adjustIdeas("", "model-a", "provider-default");
    context.state().pickIdea(0, 0);
    expect(context.state().stage).toBe("brainstorm");
    expect(context.session().picked).toBeNull();
  });

  it("pick, Back to ideas, then New ideas resets the pick and the edits with the new list", async () => {
    const context = setup();
    context.state().openBrainstorm();
    await context.first("a");
    context.state().pickIdea(0, 120);
    context.state().setDescription("Edited");
    context.state().backToIdeas();
    context.state().adjustIdeas("", "model-a", "provider-default");
    await tick();
    // The list on show keeps its pick until the new one arrives.
    expect(context.session()).toMatchObject({ picked: 0, edits: { 0: "Edited" } });
    await context.answer(list("b"));
    expect(context.session()).toMatchObject({ picked: null, edits: {}, scroll: 0 });
  });

  it("Change during a round stops it and keeps the list", async () => {
    const context = setup();
    context.state().openBrainstorm();
    await context.first("a");
    context.state().switchIdeasKind("subject", "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "option", index: 0, option: idea(1, "b") });
    await tick();
    context.state().change();
    expect(context.ideas.calls.at(-1)?.signal.aborted).toBe(true);
    expect(context.state().stage).toBe("choose");
    expect(context.session()).toMatchObject({
      status: "stopped",
      kind: "subject",
      options: [idea(1, "b")],
    });
    context.state().openBrainstorm();
    expect(context.state().stage).toBe("brainstorm");
    expect(context.session().request).toBe("Something slow and tense");
  });

  it("Edit request returns to Ask with the text and the list kept", async () => {
    const context = setup();
    await context.first("a");
    context.state().editIdeasRequest();
    expect(context.session()).toMatchObject({
      status: "idle",
      request: "Something slow and tense",
      options: list("a"),
    });
  });

  it("keeps the unsent Ask text through Change, a pick and Back to ideas", async () => {
    const context = setup();
    context.state().openBrainstorm();
    context.state().setIdeasDraft("Something half typed");
    context.state().change();
    context.state().openBrainstorm();
    expect(context.session().draft).toBe("Something half typed");
    // A blank request sends nothing and keeps what was typed.
    context.state().setIdeasDraft("   ");
    context.state().askIdeas("   ", "model-a", "provider-default");
    expect(context.ideas.calls).toHaveLength(0);
    expect(context.session().draft).toBe("   ");

    await context.first("a");
    // The request sent is what Edit request brings back.
    expect(context.session().draft).toBe("Something slow and tense");
    context.state().pickIdea(0, 0);
    context.state().backToIdeas();
    context.state().editIdeasRequest();
    context.state().setIdeasDraft("Something slow and tense, at sea");
    context.state().change();
    context.state().openBrainstorm();
    expect(context.session()).toMatchObject({
      status: "idle",
      request: "Something slow and tense",
      draft: "Something slow and tense, at sea",
    });
  });

  it("keeps the unsent feedback until a round gives a list", async () => {
    const context = setup();
    context.state().openBrainstorm();
    await context.first("a");
    context.state().setIdeasFeedback("Darker");
    context.state().pickIdea(1, 0);
    context.state().backToIdeas();
    context.state().change();
    context.state().openBrainstorm();
    expect(context.session().feedback).toBe("Darker");

    // A failed round leaves it to send again.
    context.state().adjustIdeas(context.session().feedback, "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "error", code: "cut" });
    context.ideas.finish();
    await tick();
    expect(context.session()).toMatchObject({ status: "failed", feedback: "Darker" });

    // Stopped before any idea, nothing was heard either.
    context.state().adjustIdeas("Darker", "model-a", "provider-default");
    await tick();
    context.state().stopIdeas();
    expect(context.session()).toMatchObject({ status: "stopped", feedback: "Darker" });

    // Stopped with ideas, they are the list it asked for.
    context.state().adjustIdeas("Darker", "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "option", index: 0, option: idea(1, "b") });
    await tick();
    context.state().stopIdeas();
    expect(context.session()).toMatchObject({ status: "stopped", feedback: "" });

    context.state().setIdeasFeedback("Keep 1");
    context.state().adjustIdeas("Keep 1", "model-a", "provider-default");
    await tick();
    expect(context.session().feedback).toBe("Keep 1");
    await context.answer(list("c"));
    expect(context.session()).toMatchObject({ status: "complete", feedback: "" });
  });

  it("keeps feedback typed while a round runs when its list arrives", async () => {
    const context = setup();
    await context.first("a");
    context.state().setIdeasFeedback("Darker");
    context.state().adjustIdeas("Darker", "model-a", "provider-default");
    await tick();
    context.state().setIdeasFeedback("Now lighter");
    await context.answer(list("b"));
    expect(context.session()).toMatchObject({ status: "complete", feedback: "Now lighter" });
  });

  it("keeps feedback typed while a round runs when Stop makes its ideas the list", async () => {
    const context = setup();
    await context.first("a");
    context.state().setIdeasFeedback("Darker");
    context.state().adjustIdeas("Darker", "model-a", "provider-default");
    await tick();
    context.ideas.push({ type: "option", index: 0, option: idea(1, "b") });
    await tick();
    context.state().setIdeasFeedback("Now lighter");
    context.state().stopIdeas();
    expect(context.session()).toMatchObject({ status: "stopped", feedback: "Now lighter" });
  });

  it("a kind tile after a pick opens Describe as a tile, and leaves the idea's edit alone", async () => {
    const context = setup();
    context.state().openBrainstorm();
    await context.first("a");
    context.state().pickIdea(2, 0);
    context.state().setDescription("My take on idea 3");
    context.state().backToIdeas();
    context.state().change();
    context.state().choose("group");
    expect(context.state().stage).toBe("describe");
    expect(context.session().picked).toBeNull();
    context.state().setDescription("A tile's own text");
    // Back to ideas belongs to a pick; from a tile it does nothing.
    context.state().backToIdeas();
    expect(context.state().stage).toBe("describe");
    expect(context.session().edits).toEqual({ 2: "My take on idea 3" });
  });

  it("a round refused by the sign-in waits, and goes out once when resumed", async () => {
    const ideas = controlled<CreatorBrainstormEvent>();
    let refusals = 1;
    const context = setup((async (request: unknown, signal: AbortSignal) => {
      if (refusals-- > 0) throw new SignedOut();
      return ideas.open(request, signal);
    }) as StreamBrainstorm);
    context.state().askIdeas("A mood", "model-a", "provider-default");
    await tick();
    expect(context.state()).toMatchObject({
      pending: "brainstorm",
      brainstorm: { status: "waiting" },
    });
    context.state().resume();
    await tick();
    expect(ideas.calls).toHaveLength(1);
    expect(ideas.calls[0]?.request).toEqual({
      description: "A mood",
      rounds: [],
      model: "model-a",
    });
    expect(context.state()).toMatchObject({
      pending: null,
      brainstorm: { status: "classifying" },
    });
    context.state().resume();
    await tick();
    expect(ideas.calls).toHaveLength(1);
  });

  it("a stale refusal with a live sign-in goes again at once, and only once", async () => {
    const ideas = controlled<CreatorBrainstormEvent>();
    let calls = 0;
    const context = setup((async (request: unknown, signal: AbortSignal) => {
      calls++;
      // The renewal landed while the request was out; its refusal arrives after.
      if (calls === 1) throw new SignedOut(true);
      return ideas.open(request, signal);
    }) as StreamBrainstorm);
    context.state().askIdeas("A mood", "model-a", "provider-default");
    // A renewal before the rejection finds nothing waiting.
    context.state().resume();
    await tick();
    await tick();
    expect(calls).toBe(2);
    expect(ideas.calls).toHaveLength(1);
    expect(context.state()).toMatchObject({
      pending: null,
      brainstorm: { status: "classifying" },
    });
  });

  it("Stop ends a round waiting for the sign-in, and never resumes it", async () => {
    let calls = 0;
    const context = setup((async () => {
      calls++;
      throw new SignedOut();
    }) as StreamBrainstorm);
    context.state().askIdeas("A mood", "model-a", "provider-default");
    await tick();
    expect(context.state().pending).toBe("brainstorm");
    context.state().stopIdeas();
    expect(context.state()).toMatchObject({ pending: null, brainstorm: { status: "stopped" } });
    context.state().resume();
    await tick();
    expect(calls).toBe(1);
  });

  it("a brainstorm leaves no unsaved card and no Keep", async () => {
    const context = setup();
    await context.first("a");
    expect(hasUnsavedCard(context.state())).toBe(false);
    expect(keeping(context.state())).toBe(false);
  });
});
