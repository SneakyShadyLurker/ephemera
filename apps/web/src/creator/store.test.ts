import type { ArtStreamEvent, CreatorArtStatus, CreatorCardEvent } from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignedOut } from "../signin/signin.ts";
import { controlled, tick } from "../testing.ts";
import type { StreamArt } from "./art-slice.ts";
import type { StreamBrainstorm } from "./brainstorm-slice.ts";
import { keepAndLeave } from "./keep.ts";
import { type CreatorDeps, createCreatorStore, hasUnsavedCard, type StreamCard } from "./store.ts";

/** The brainstorm these tests never start. */
const noIdeas: StreamBrainstorm = async () => (async function* () {})();

const inner = [
  "<backgroundstory>Grew up in Testtown.</backgroundstory>",
  "<appearance>Tall, placeholder build.</appearance>",
  "<personality>Calm.</personality>",
  "<vocabulary>Short sentences.</vocabulary>",
].join("");
const ANSWER = [
  "<name>Ada Reed</name>",
  `<description><ada_reed>${inner}</ada_reed></description>`,
  "<firstMessage>Location: a lighthouse, dusk.\nAda looks up.</firstMessage>",
  "<creatorNotes>A placeholder pitch.</creatorNotes>",
].join("\n");

const VALID: CreatorCardEvent = { type: "result", validation: { ok: true }, tokens: [] };
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Another batch's bytes, told apart from the first by their length. */
const OTHER_PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
/** The first batch's portrait `index`, told apart by its length (8 bytes and `index` more). */
const PORTRAIT = (index: number) =>
  Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(index).fill(0)]);

/** Keep's saves, answering as told: what each call received and what it returned. */
function saves() {
  const cards: { id: string; name: string; tags: string[] }[] = [];
  const portraits: { id: string; bytes: number }[] = [];
  const answers = { card: [] as boolean[], portrait: [] as boolean[] };
  const deps: Pick<CreatorDeps, "saveCard" | "savePortrait"> = {
    saveCard: async (id, fields) => {
      cards.push({ id, name: fields.name, tags: fields.tags });
      return answers.card.shift() === false ? { ok: false, reason: "unreachable" } : { ok: true };
    },
    savePortrait: async (id, png) => {
      portraits.push({ id, bytes: png.length });
      return answers.portrait.shift() === false
        ? { ok: false, reason: "That image could not be read." }
        : { ok: true, version: 1 };
    },
  };
  return { cards, portraits, answers, deps };
}

function setup(
  status: CreatorArtStatus = { state: "ready" },
  signedIn = () => true,
  extra: Partial<CreatorDeps> = {},
) {
  const card = controlled<CreatorCardEvent>();
  const art = controlled<ArtStreamEvent>();
  const saved = saves();
  const checked: string[] = [];
  const store = createCreatorStore({
    streamBrainstorm: noIdeas,
    streamCard: card.open as StreamCard,
    streamArt: art.open as StreamArt,
    artStatus: async (workflow) => {
      checked.push(workflow);
      return status;
    },
    workflow: () => "krea2-second",
    signedIn,
    ...saved.deps,
    ...extra,
  });
  const start = () => {
    store.getState().choose("subject");
    store.getState().setDescription("A placeholder lighthouse keeper");
    store.getState().create("model-a", "provider-default", null);
  };
  return { store, card, art, start, saved, checked };
}

/** A complete card and a whole batch of four. */
async function complete(context: ReturnType<typeof setup>) {
  context.start();
  await tick();
  context.card.push({ type: "delta", text: ANSWER });
  context.card.push(VALID);
  context.card.finish();
  await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
  for (let index = 0; index < 4; index++)
    context.art.push({ type: "image", index, png: PORTRAIT(index) });
  context.art.push({ type: "done" });
  context.art.finish();
  await vi.waitFor(() => expect(context.store.getState().art?.status).toBe("complete"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("creator store", () => {
  it("streams the card, then asks for art with the card's art source when portraits are ready", async () => {
    const context = setup();
    context.start();
    await tick();
    expect(context.card.calls[0]?.request).toEqual({
      kind: "subject",
      description: "A placeholder lighthouse keeper",
      model: "model-a",
    });
    context.card.push({ type: "delta", text: ANSWER.slice(0, 20) });
    await tick();
    expect(context.store.getState().card).toMatchObject({
      status: "writing",
      answer: ANSWER.slice(0, 20),
    });
    context.card.push({ type: "delta", text: ANSWER.slice(20) });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.store.getState().card?.status).toBe("complete");
    const request = context.art.calls[0]?.request as { source: string; kind: string };
    expect(request.kind).toBe("subject");
    expect(request.source).toContain("Tall, placeholder build.");
    expect(request.source).toContain("<Location>\nLocation: a lighthouse, dusk.\n</Location>");
    expect(request.source).not.toContain("Ada looks up.");
    // The model default sends no effort, for the card and its art alike.
    expect(request).not.toHaveProperty("reasoning");
    // The status checked and the art painted are the workflow the tab shows.
    expect(context.checked).toEqual(["krea2-second"]);
    expect(request).toMatchObject({ workflow: "krea2-second" });
  });

  it("marks the model thinking until its text arrives, keeping nothing of the thought", async () => {
    const context = setup();
    context.start();
    await tick();
    context.card.push({ type: "thinking" });
    await tick();
    expect(context.store.getState().card).toMatchObject({ thinking: true, answer: "" });
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.store.getState().card?.status).toBe("complete"));
    expect(context.store.getState().card?.answer).toBe(ANSWER);
  });

  it("drops the first draft on retry and writes the second in its place", async () => {
    const context = setup();
    context.start();
    await tick();
    context.card.push({ type: "thinking" });
    context.card.push({ type: "delta", text: "<name>Draft one</name>" });
    context.card.push({ type: "retry", problems: [{ code: "missing", section: "firstMessage" }] });
    await tick();
    expect(context.store.getState().card).toMatchObject({
      status: "writing",
      answer: "",
      thinking: false,
      retried: true,
    });
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.store.getState().card?.status).toBe("complete"));
    expect(context.store.getState().card?.answer).toBe(ANSWER);
    expect(context.card.calls).toHaveLength(1);
    // Rewrite starts over: no retry and no thinking carried along.
    context.store.getState().rewrite();
    expect(context.store.getState().card).toMatchObject({ retried: false, thinking: false });
  });

  it.each(["cut", "filtered", "too_large"] as const)(
    "fails a card that ended with %s, keeping what was written",
    async (code) => {
      const context = setup();
      context.start();
      await tick();
      context.card.push({ type: "delta", text: ANSWER.slice(0, 40) });
      context.card.push({ type: "error", code });
      context.card.finish();
      await vi.waitFor(() => expect(context.store.getState().card?.status).toBe("failed"));
      expect(context.store.getState().card).toMatchObject({
        failure: code,
        answer: ANSWER.slice(0, 40),
      });
      expect(context.art.calls).toHaveLength(0);
    },
  );

  it("sends the persona and effort chosen at Create, and Rewrite keeps them", async () => {
    const context = setup();
    const persona = "00000000-0000-4000-8000-000000000004";
    context.store.getState().choose("subject");
    context.store.getState().setDescription("My sister, a placeholder keeper");
    context.store.getState().create("model-a", "high", persona);
    await tick();
    context.store.getState().rewrite();
    await tick();
    expect(context.card.calls.map((call) => call.request)).toEqual([
      {
        kind: "subject",
        description: "My sister, a placeholder keeper",
        model: "model-a",
        reasoning: "high",
        personaId: persona,
      },
      {
        kind: "subject",
        description: "My sister, a placeholder keeper",
        model: "model-a",
        reasoning: "high",
        personaId: persona,
      },
    ]);
  });

  it("writes the image prompt at the card's effort", async () => {
    const context = setup();
    context.store.getState().choose("subject");
    context.store.getState().setDescription("A placeholder lighthouse keeper");
    context.store.getState().create("model-a", "high", null);
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).toMatchObject({ model: "model-a", reasoning: "high" });
  });

  it("writes the image prompt with Settings' image prompt model at the card's effort, below the session's choice", async () => {
    const context = setup({ state: "ready" }, () => true, { imagePromptModel: () => "model-b" });
    context.store.getState().choose("subject");
    context.store.getState().setDescription("A placeholder lighthouse keeper");
    context.store.getState().create("model-a", "high", null);
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).toMatchObject({ model: "model-b", reasoning: "high" });
    context.art.finish();
    await vi.waitFor(() => expect(context.store.getState().art?.status).not.toBe("running"));

    context.store.getState().setArtModel("model-c");
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    expect(context.art.calls[1]?.request).toMatchObject({ model: "model-c" });
  });

  it("keeps the batch apart until all four arrived, as bytes", async () => {
    const context = setup();
    await complete(context);
    expect(context.store.getState().art).toEqual({ status: "complete" });
    expect(context.store.getState().images.map((image) => image.length)).toEqual([8, 9, 10, 11]);
  });

  it("shows no partial batch: three images and done is a failure", async () => {
    const context = setup();
    context.start();
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    for (let index = 0; index < 3; index++) context.art.push({ type: "image", index, png: PNG });
    context.art.push({ type: "done" });
    await vi.waitFor(() =>
      expect(context.store.getState().art).toEqual({ status: "failed", code: "stream" }),
    );
  });

  it("skips the art when portraits are not ready, saying why", async () => {
    const context = setup({ state: "off" });
    context.start();
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    await vi.waitFor(() =>
      expect(context.store.getState().art).toEqual({ status: "skipped", reason: "off" }),
    );
    expect(context.art.calls).toHaveLength(0);
  });

  it("skips a MOSS workflow's art before generation when the health check reports its LoRA missing", async () => {
    const workflow = "moss-sample";
    const context = setup(
      { state: "missing", nodes: [], models: ["moss-sample-lora.safetensors"] },
      () => true,
      { workflow: () => workflow },
    );
    context.start();
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    await vi.waitFor(() =>
      expect(context.store.getState().art).toEqual({ status: "skipped", reason: "missing" }),
    );
    expect(context.checked).toEqual([workflow]);
    expect(context.art.calls).toHaveLength(0);
  });

  it("drops a late result from an older epoch", async () => {
    const context = setup();
    context.start();
    await tick();
    const old = context.card.calls[0];
    context.store.getState().rewrite();
    await tick();
    expect(old?.signal.aborted).toBe(true);
    old?.push({ type: "delta", text: "stale text" });
    old?.push(VALID);
    old?.finish();
    await tick();
    expect(context.store.getState().card).toMatchObject({ status: "writing", answer: "" });
    expect(context.art.calls).toHaveLength(0);

    context.store.getState().returnToDescription();
    context.card.push({ type: "delta", text: "late" });
    context.card.push(VALID);
    await tick();
    expect(context.store.getState().card).toBeNull();
    expect(context.art.calls).toHaveLength(0);
  });

  it("drops a late batch after the card is left", async () => {
    const context = setup();
    context.start();
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    const batch = context.art.calls[0];
    context.store.getState().returnToDescription();
    expect(batch?.signal.aborted).toBe(true);
    for (let index = 0; index < 4; index++) batch?.push({ type: "image", index, png: PNG });
    batch?.push({ type: "done" });
    await tick();
    expect(context.store.getState().art).toBeNull();
  });

  it("Stop keeps what was written and marks it stopped", async () => {
    const context = setup();
    context.start();
    await tick();
    context.card.push({ type: "delta", text: "<name>Ada" });
    await tick();
    context.store.getState().stop();
    expect(context.card.calls[0]?.signal.aborted).toBe(true);
    context.card.push({ type: "delta", text: " Reed" });
    await tick();
    expect(context.store.getState().card).toMatchObject({
      status: "stopped",
      answer: "<name>Ada",
    });
    expect(hasUnsavedCard(context.store.getState())).toBe(true);
  });

  it("reports a structurally invalid card and an upstream error", async () => {
    const context = setup();
    context.start();
    await tick();
    context.card.push({
      type: "result",
      validation: { ok: false, problems: [{ code: "missing", section: "firstMessage" }] },
      tokens: [],
    });
    await tick();
    expect(context.store.getState().card).toMatchObject({
      status: "invalid",
      problems: [{ code: "missing", section: "firstMessage" }],
    });

    context.store.getState().rewrite();
    await tick();
    context.card.push({ type: "error", code: "timeout" });
    await tick();
    expect(context.store.getState().card).toMatchObject({ status: "failed", failure: "timeout" });
  });

  it("clear empties the card, the images and the description", async () => {
    const context = setup();
    await complete(context);
    context.store.getState().clear();
    const state = context.store.getState();
    expect(state).toMatchObject({
      stage: "choose",
      kind: null,
      description: "",
      card: null,
      art: null,
      pending: null,
    });
  });

  it("the description survives leaving the route; the card and images do not", async () => {
    const context = setup();
    await complete(context);
    context.store.getState().returnToDescription();
    expect(context.store.getState()).toMatchObject({
      stage: "describe",
      kind: "subject",
      description: "A placeholder lighthouse keeper",
      card: null,
      art: null,
    });
    expect(hasUnsavedCard(context.store.getState())).toBe(false);
  });

  it("Discard drops the card and its images and keeps the description", async () => {
    const context = setup();
    await complete(context);
    context.store.getState().discard();
    expect(context.store.getState()).toMatchObject({
      stage: "describe",
      kind: "subject",
      description: "A placeholder lighthouse keeper",
      card: null,
      art: null,
      images: [],
    });
    expect(hasUnsavedCard(context.store.getState())).toBe(false);
  });

  it("New art writes the image prompt with the model and effort chosen for it, narrowed to what it offers", async () => {
    // model-b offers no xhigh, so its image prompt goes at the model default.
    const efforts: Record<string, string[]> = { "model-a": ["xhigh"], "model-b": ["low"] };
    const context = setup({ state: "ready" }, () => true, {
      artEffort: async (model, reasoning) =>
        efforts[model]?.includes(reasoning) ? reasoning : "provider-default",
    });
    context.store.getState().choose("subject");
    context.store.getState().setDescription("A placeholder lighthouse keeper");
    context.store.getState().create("model-a", "xhigh", null);
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).toMatchObject({ model: "model-a", reasoning: "xhigh" });
    context.art.finish();
    await vi.waitFor(() => expect(context.store.getState().art?.status).not.toBe("running"));

    context.store.getState().setArtModel("model-b");
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    const request = context.art.calls[1]?.request;
    expect(request).toMatchObject({ model: "model-b" });
    expect(request).not.toHaveProperty("reasoning");
    // The card itself is not written again, and keeps its own model.
    expect(context.card.calls).toHaveLength(1);
    expect(context.store.getState().card).toMatchObject({ model: "model-a", reasoning: "xhigh" });
    context.art.finish();
    await vi.waitFor(() => expect(context.store.getState().art?.status).not.toBe("running"));

    // An effort chosen for the image prompt goes in place of the card's.
    context.store.getState().setArtReasoning("low");
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(3));
    expect(context.art.calls[2]?.request).toMatchObject({ model: "model-b", reasoning: "low" });
  });

  it("New art sends the owner's direction trimmed, none while blank, and drops it with the card", async () => {
    const context = setup();
    await complete(context);
    expect(context.art.calls[0]?.request).not.toHaveProperty("direction");

    context.store.getState().setArtDirection("  Golden hour on a rooftop \n");
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    expect(context.art.calls[1]?.request).toMatchObject({ direction: "Golden hour on a rooftop" });
    context.art.finish();
    await vi.waitFor(() => expect(context.store.getState().art?.status).not.toBe("running"));
    // It stays for the next batch, to be refined.
    expect(context.store.getState().artDirection).toBe("  Golden hour on a rooftop \n");

    context.store.getState().setArtDirection("   ");
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(3));
    expect(context.art.calls[2]?.request).not.toHaveProperty("direction");
    context.art.finish();
    await vi.waitFor(() => expect(context.store.getState().art?.status).not.toBe("running"));

    context.store.getState().setArtDirection("A red silk dress");
    context.store.getState().rewrite();
    expect(context.store.getState().artDirection).toBe("");
    context.store.getState().setArtDirection("A red silk dress");
    context.store.getState().clear();
    expect(context.store.getState().artDirection).toBe("");
  });

  it("keeps Describe's composition for rewritten and recreated automatic batches until clear", async () => {
    const context = setup();
    context.store.getState().setArtComposition("diptych");
    await complete(context);
    expect(context.art.calls[0]?.request).toMatchObject({
      kind: "subject",
      composition: "diptych",
    });
    context.store.getState().rewrite();
    expect(context.store.getState().artComposition).toBe("diptych");
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    expect(context.art.calls[1]?.request).toMatchObject({ composition: "diptych" });

    context.store.getState().discard();
    expect(context.store.getState().artComposition).toBe("diptych");
    // Leaving Describe for Settings uses the same route-drop action.
    context.store.getState().returnToDescription();
    expect(context.store.getState().artComposition).toBe("diptych");
    context.store.getState().create("model-a", "provider-default", null);
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(3));
    expect(context.art.calls[2]?.request).toMatchObject({ composition: "diptych" });

    context.store.getState().clear();
    expect(context.store.getState().artComposition).toBe("regular");
  });

  it("keeps Describe's look across rewrite and back to Describe, resets it for Scenario and on clear", async () => {
    const context = setup();
    context.store.getState().setArtLook("film");
    await complete(context);
    expect(context.art.calls[0]?.request).toMatchObject({ kind: "subject", look: "film" });
    context.store.getState().rewrite();
    expect(context.store.getState().artLook).toBe("film");
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    expect(context.art.calls[1]?.request).toMatchObject({ look: "film" });

    context.store.getState().discard();
    expect(context.store.getState().artLook).toBe("film");
    context.store.getState().returnToDescription();
    expect(context.store.getState().artLook).toBe("film");
    context.store.getState().change();
    context.store.getState().choose("group");
    expect(context.store.getState().artLook).toBe("film");
    context.store.getState().change();
    context.store.getState().choose("scenario");
    expect(context.store.getState().artLook).toBe("auto");

    context.store.getState().choose("subject");
    context.store.getState().setArtLook("monochrome");
    context.store.getState().clear();
    expect(context.store.getState().artLook).toBe("auto");
  });

  it.each(["group", "scenario"] as const)("resets composition when choosing %s", (kind) => {
    const { store } = setup();
    store.getState().choose("subject");
    store.getState().setArtComposition("diptych");
    store.getState().change();
    store.getState().choose("subject");
    expect(store.getState().artComposition).toBe("diptych");
    store.getState().change();
    store.getState().choose(kind);
    expect(store.getState().artComposition).toBe("regular");
    store.getState().change();
    store.getState().choose("subject");
    expect(store.getState().artComposition).toBe("regular");
  });

  it("New art keeps the batch on show and its choice until the new batch is whole", async () => {
    const context = setup();
    await complete(context);
    context.store.getState().select(2);
    const shown = context.store.getState().images;

    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    context.art.push({ type: "progress", phase: "running", value: 3, max: 10 });
    context.art.push({ type: "image", index: 0, png: OTHER_PNG });
    // An arriving image is counted, never shown on its own.
    await vi.waitFor(() =>
      expect(context.store.getState().art).toMatchObject({
        status: "running",
        phase: "receiving",
        value: 1,
        max: 4,
      }),
    );
    expect(context.store.getState()).toMatchObject({ images: shown, selected: 2 });

    context.art.push({ type: "error", code: "comfyui" });
    await vi.waitFor(() =>
      expect(context.store.getState().art).toEqual({ status: "failed", code: "comfyui" }),
    );
    expect(context.store.getState()).toMatchObject({ images: shown, selected: 2 });

    // A whole batch replaces it, from its first portrait.
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(3));
    for (let index = 0; index < 4; index++)
      context.art.push({ type: "image", index, png: OTHER_PNG });
    context.art.push({ type: "done" });
    await vi.waitFor(() => expect(context.store.getState().art?.status).toBe("complete"));
    expect(context.store.getState().selected).toBe(0);
    expect(context.store.getState().images.map((image) => image.length)).toEqual([9, 9, 9, 9]);
  });

  it("Stop ends New art at once, keeps the batch on show and lets New art be asked again", async () => {
    const context = setup();
    await complete(context);
    context.store.getState().select(1);
    const shown = context.store.getState().images;

    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    context.art.push({ type: "progress", phase: "queued", value: 0, max: 1 });
    await vi.waitFor(() =>
      expect(context.store.getState().art).toMatchObject({ status: "running", phase: "queued" }),
    );
    const run = context.art.calls[1];
    context.store.getState().stopArt();
    expect(run?.signal.aborted).toBe(true);
    expect(context.store.getState()).toMatchObject({
      art: { status: "stopped" },
      images: shown,
      selected: 1,
    });

    // Nothing from the stopped run lands.
    for (let index = 0; index < 4; index++) run?.push({ type: "image", index, png: OTHER_PNG });
    run?.push({ type: "done" });
    await tick();
    expect(context.store.getState()).toMatchObject({ art: { status: "stopped" }, images: shown });

    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(3));
    expect(context.store.getState().art).toMatchObject({ status: "running" });
  });

  it("Keep retries a failed create under the same id, with the portrait chosen at the retry", async () => {
    const context = setup();
    await complete(context);
    context.store.getState().select(1);
    context.saved.answers.card.push(false);

    expect(await context.store.getState().keep()).toBe(false);
    expect(context.store.getState().keepRun).toMatchObject({
      status: "failed",
      saved: false,
      failure: { step: "card", reason: "unreachable" },
    });
    expect(context.saved.portraits).toHaveLength(0);

    // The card and its id hold; the portrait is the one chosen when the retry is pressed.
    context.store.getState().select(3);
    expect(await context.store.getState().keep()).toBe(true);
    const [first, second] = context.saved.cards;
    expect(first?.name).toBe("Ada Reed");
    // The kind chosen is the card's one tag.
    expect(first?.tags).toEqual(["Subject"]);
    expect(second?.id).toBe(first?.id);
    expect(context.saved.cards).toHaveLength(2);
    expect(context.saved.portraits).toEqual([{ id: first?.id, bytes: 11 }]);
    expect(context.store.getState().keepRun).toMatchObject({ status: "kept", portrait: 1 });
  });

  it("a failed portrait upload leaves the card kept, and the retry uploads alone", async () => {
    const context = setup();
    await complete(context);
    context.saved.answers.portrait.push(false);

    expect(await context.store.getState().keep()).toBe(false);
    expect(context.store.getState().keepRun).toMatchObject({
      status: "failed",
      saved: true,
      failure: { step: "portrait", reason: "That image could not be read." },
    });
    // The card is kept, so leaving loses nothing; the candidate stays on screen.
    expect(hasUnsavedCard(context.store.getState())).toBe(false);
    expect(context.store.getState().card?.status).toBe("complete");

    expect(await context.store.getState().keep()).toBe(true);
    expect(context.saved.cards).toHaveLength(1);
    expect(context.saved.portraits).toHaveLength(2);
    expect(context.saved.portraits[1]?.id).toBe(context.saved.cards[0]?.id);
  });

  it("a portrait upload that never answers ends at the timeout, and the retry uploads alone", async () => {
    const uploads: { id: string; bytes: number; signal: AbortSignal }[] = [];
    const context = setup({ state: "ready" }, () => true, {
      portraitTimeoutMs: 20,
      // The first upload ignores its signal and never answers; the second is saved.
      savePortrait: (id, png, signal) => {
        uploads.push({ id, bytes: png.length, signal });
        return uploads.length === 1
          ? new Promise<never>(() => {})
          : Promise.resolve({ ok: true as const, version: 2 });
      },
    });
    await complete(context);
    context.store.getState().select(2);

    expect(await context.store.getState().keep()).toBe(false);
    expect(uploads[0]?.signal.aborted).toBe(true);
    expect(context.store.getState().keepRun).toMatchObject({
      status: "failed",
      saved: true,
      failure: { step: "portrait", reason: "The upload took too long." },
    });
    // Nothing is locked any more; the card and the chosen candidate stay for the retry.
    expect(context.store.getState().card?.status).toBe("complete");
    expect(context.store.getState()).toMatchObject({ selected: 2 });
    expect(context.store.getState().images).toHaveLength(4);

    expect(await context.store.getState().keep()).toBe(true);
    expect(context.saved.cards).toHaveLength(1);
    const card = context.saved.cards[0]?.id;
    expect(uploads.map(({ id, bytes }) => ({ id, bytes }))).toEqual([
      { id: card, bytes: 10 },
      { id: card, bytes: 10 },
    ]);
    expect(context.store.getState().keepRun).toMatchObject({ status: "kept", portrait: 2 });
  });

  it("a portrait upload that throws fails the portrait step instead of leaving Keep saving", async () => {
    const context = setup({ state: "ready" }, () => true, {
      savePortrait: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await complete(context);

    expect(await context.store.getState().keep()).toBe(false);
    expect(context.store.getState().keepRun).toMatchObject({
      status: "failed",
      saved: true,
      failure: { step: "portrait" },
    });
    expect(context.saved.cards).toHaveLength(1);
  });

  it("locks the other actions while Keep saves, and keeps a card without art", async () => {
    const context = setup({ state: "off" });
    context.start();
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    await vi.waitFor(() => expect(context.store.getState().art?.status).toBe("skipped"));

    const keeping = context.store.getState().keep();
    expect(context.store.getState().keepRun?.status).toBe("saving");
    context.store.getState().rewrite();
    context.store.getState().discard();
    expect(context.store.getState().card?.status).toBe("complete");
    expect(await keeping).toBe(true);
    expect(context.saved.cards).toHaveLength(1);
    expect(context.saved.portraits).toHaveLength(0);
  });

  it("tags a kept Scenario card with its kind", async () => {
    const context = setup({ state: "off" });
    context.store.getState().choose("scenario");
    context.store.getState().setDescription("A placeholder valley");
    context.store.getState().create("model-a", "provider-default", null);
    await tick();
    context.card.push({
      type: "delta",
      text: [
        "<name>The Slate Valley</name>",
        "<description><Roleplay>A placeholder premise.</Roleplay><Setting>A town.</Setting><People>Millers.</People><Tone>Quiet.</Tone></description>",
        "<firstMessage>Location: the pass, dawn.\nFog sits in the valley.</firstMessage>",
        "<creatorNotes>A valley to enter.</creatorNotes>",
      ].join("\n"),
    });
    context.card.push(VALID);
    await vi.waitFor(() => expect(context.store.getState().art?.status).toBe("skipped"));

    expect(await context.store.getState().keep()).toBe(true);
    expect(context.saved.cards.map((card) => card.tags)).toEqual([["Scenario"]]);
  });

  it("a card refused by the sign-in waits, and goes out once when resumed", async () => {
    const context = setup();
    const card = controlled<CreatorCardEvent>();
    let refusals = 1;
    const store = createCreatorStore({
      streamBrainstorm: noIdeas,
      streamCard: (async (request: unknown, signal: AbortSignal) => {
        if (refusals-- > 0) throw new SignedOut();
        return card.open(request, signal);
      }) as StreamCard,
      streamArt: context.art.open as StreamArt,
      artStatus: async () => ({ state: "off" }),
      ...saves().deps,
    });
    store.getState().choose("scenario");
    store.getState().setDescription("A placeholder valley");
    store.getState().create("model-a", "provider-default", null);
    await tick();
    expect(store.getState()).toMatchObject({ pending: "card", card: { status: "waiting" } });
    store.getState().resume();
    await tick();
    expect(card.calls).toHaveLength(1);
    expect(store.getState()).toMatchObject({ pending: null, card: { status: "writing" } });
    store.getState().resume();
    await tick();
    expect(card.calls).toHaveLength(1);
  });

  it("a Keep whose session was left before it navigated neither navigates nor empties new work", async () => {
    const context = setup({ state: "off" });
    context.start();
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    await vi.waitFor(() => expect(context.store.getState().art?.status).toBe("skipped"));

    let settled = () => {};
    const leave = vi.fn(async () => {});
    const keeping = keepAndLeave(context.store, {
      settle: () =>
        new Promise<void>((resolve) => {
          settled = resolve;
        }),
      leave,
    });
    await vi.waitFor(() => expect(context.store.getState().keepRun?.status).toBe("kept"));
    // The owner leaves while the gallery refreshes, comes back and starts again.
    context.store.getState().returnToDescription();
    context.store.getState().setDescription("A new placeholder description");
    settled();
    await keeping;
    expect(leave).not.toHaveBeenCalled();
    expect(context.store.getState().description).toBe("A new placeholder description");
  });

  it("art whose status check the sign-in refused waits, and goes out once when resumed", async () => {
    const context = setup();
    let refusals = 1;
    const store = createCreatorStore({
      streamBrainstorm: noIdeas,
      streamCard: context.card.open as StreamCard,
      streamArt: context.art.open as StreamArt,
      artStatus: async () => {
        if (refusals-- > 0) throw new SignedOut();
        return { state: "ready" };
      },
      ...saves().deps,
    });
    store.getState().choose("subject");
    store.getState().setDescription("A placeholder lighthouse keeper");
    store.getState().create("model-a", "provider-default", null);
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() =>
      expect(store.getState()).toMatchObject({ pending: "art", art: { status: "waiting" } }),
    );
    expect(context.art.calls).toHaveLength(0);
    store.getState().resume();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(store.getState()).toMatchObject({ pending: null, art: { status: "running" } });
  });

  it("art whose model lookup the sign-in refused waits, and narrows the effort when resumed", async () => {
    let refusals = 1;
    const context = setup({ state: "ready" }, () => true, {
      artEffort: async () => {
        if (refusals-- > 0) throw new SignedOut();
        return "provider-default";
      },
    });
    context.store.getState().choose("subject");
    context.store.getState().setDescription("A placeholder lighthouse keeper");
    context.store.getState().create("model-a", "xhigh", null);
    await tick();
    context.card.push({ type: "delta", text: ANSWER });
    context.card.push(VALID);
    context.card.finish();
    await vi.waitFor(() =>
      expect(context.store.getState()).toMatchObject({
        pending: "art",
        art: { status: "waiting" },
      }),
    );
    expect(context.art.calls).toHaveLength(0);
    context.store.getState().resume();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).not.toHaveProperty("reasoning");
  });

  it("never resumes a request after Discard or leaving", async () => {
    const card = controlled<CreatorCardEvent>();
    let calls = 0;
    const store = createCreatorStore({
      streamBrainstorm: noIdeas,
      streamCard: (async () => {
        calls++;
        throw new SignedOut();
      }) as StreamCard,
      streamArt: controlled<ArtStreamEvent>().open as StreamArt,
      artStatus: async () => ({ state: "off" }),
      ...saves().deps,
    });
    store.getState().choose("subject");
    store.getState().setDescription("A placeholder");
    store.getState().create("model-a", "provider-default", null);
    await tick();
    expect(store.getState().pending).toBe("card");
    store.getState().returnToDescription();
    store.getState().resume();
    await tick();
    expect(calls).toBe(1);
    expect(card.calls).toHaveLength(0);
  });
});
