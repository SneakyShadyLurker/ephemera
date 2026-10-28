import { type ArtStreamEvent, type ModelInfo, savedCardArtSource } from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamArt } from "../creator/art-slice.ts";
import type { PortraitResult } from "../portraits/queries.ts";
import { SignedOut } from "../signin/signin.ts";
import { tick } from "../testing.ts";
import { createSheetArtStore, type SheetArtBinding, type SheetArtCard } from "./store.ts";

/** Streams the test drives by hand; `push`/`finish` target the latest call. */
function controlled<Event>() {
  const calls: {
    signal: AbortSignal;
    request: unknown;
    push: (event: Event) => void;
    finish: (error?: Error) => void;
  }[] = [];
  const open = async (request: unknown, signal: AbortSignal): Promise<AsyncIterable<Event>> => {
    const queue: Event[] = [];
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
    push: (event: Event) => calls.at(-1)?.push(event),
    finish: (error?: Error) => calls.at(-1)?.finish(error),
  };
}

/** The batch's portrait `index`, told apart by its length (8 bytes and `index` more). */
const PORTRAIT = (index: number) =>
  Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(index).fill(0)]);

const ID = "0b0f3e3c-6d1e-4a51-9a8e-6f1c1d7f9a01";
const OTHER_ID = "7c3a1f52-2b8d-4c3e-8f0a-5d9e2b4c6a12";

const FIELDS: SheetArtCard["fields"] = {
  name: "The Lighthouse",
  description: "Ada is tall, with copper hair and a grey coat.",
  personality: "Calm. Dry. Patient.",
  scenario: "A lighthouse at dusk.",
  firstMessage: "Ada looks up from the lamp.",
  tags: ["Scenario"],
};

const MODELS: Record<string, ModelInfo> = {
  vision: { id: "vision", contextWindow: null, outputLimit: null, reasoning: null, images: true },
  text: { id: "text", contextWindow: null, outputLimit: null, reasoning: null, images: false },
};

function setup({
  saved = "vision" as string | null,
  imagePrompt = null as string | null,
  locked = false,
  status = async () => ({ state: "ready" as const }),
}: {
  saved?: string | null;
  imagePrompt?: string | null;
  locked?: boolean;
  status?: () => Promise<{ state: "ready" }>;
} = {}) {
  const art = controlled<ArtStreamEvent>();
  const uploads: { id: string; bytes: number; signal: AbortSignal }[] = [];
  const answers: (PortraitResult | Promise<PortraitResult>)[] = [];
  const context = { saved, imagePrompt, locked };
  const store = createSheetArtStore({
    streamArt: art.open as StreamArt,
    artStatus: status,
    workflow: () => "krea2-second",
    savedModel: () => context.saved,
    imagePromptModel: () => context.imagePrompt,
    modelInfo: async (model) => MODELS[model],
    savePortrait: async (id, png, signal) => {
      uploads.push({ id, bytes: png.length, signal });
      return answers.shift() ?? { ok: true, version: 7 };
    },
    reworkLocked: () => context.locked,
    writing: () => {},
  });
  return { store, art, uploads, answers, context };
}

/** A binding to the character `id` whose card is `card`; `portraits` records what it was told. */
function bind(id = ID, card: Partial<SheetArtCard> = {}) {
  const portraits: number[] = [];
  const binding: SheetArtBinding = {
    characterId: id,
    card: () => ({ fields: FIELDS, portrait: 3, ...card }),
    onPortrait: (version) => portraits.push(version),
  };
  return { binding, portraits };
}

/** New art pressed, and a whole batch of four arriving. */
async function paint(context: ReturnType<typeof setup>) {
  const calls = context.art.calls.length;
  context.store.getState().requestArt();
  await vi.waitFor(() => expect(context.art.calls).toHaveLength(calls + 1));
  for (let index = 0; index < 4; index++)
    context.art.push({ type: "image", index, png: PORTRAIT(index) });
  context.art.push({ type: "done" });
  context.art.finish();
  await vi.waitFor(() => expect(context.store.getState().art?.status).toBe("complete"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sheet-art store", () => {
  it("keeps a composition-only session on reopen, sends it for Subject and clears it with the session", async () => {
    const context = setup();
    const bound = bind(ID, { fields: { ...FIELDS, tags: ["Subject"] } }).binding;
    context.store.getState().open(bound);
    expect(context.store.getState().artComposition).toBe("regular");
    context.store.getState().setArtComposition("diptych");
    context.store.getState().open(bound);
    expect(context.store.getState().artComposition).toBe("diptych");
    await paint(context);
    expect(context.art.calls[0]?.request).toMatchObject({ composition: "diptych" });
    context.store.getState().setKind("group");
    await paint(context);
    expect(context.art.calls[1]?.request).not.toHaveProperty("composition");
    context.store.getState().setArtComposition("diptych");
    context.store.getState().clear();
    expect(context.store.getState().artComposition).toBe("regular");
  });
  it("keeps a look-only session on reopen, sends it for Subject and clears it with the session", async () => {
    const context = setup();
    const bound = bind(ID, { fields: { ...FIELDS, tags: ["Subject"] } }).binding;
    context.store.getState().open(bound);
    expect(context.store.getState().artLook).toBe("auto");
    context.store.getState().setArtLook("film");
    context.store.getState().open(bound);
    expect(context.store.getState().artLook).toBe("film");
    await paint(context);
    expect(context.art.calls[0]?.request).toMatchObject({ look: "film" });
    context.store.getState().setKind("scenario");
    expect(context.store.getState().artLook).toBe("auto");
    context.store.getState().setArtLook("monochrome");
    context.store.getState().clear();
    expect(context.store.getState().artLook).toBe("auto");
  });
  it("opens on the kind from the card's tags", () => {
    const context = setup();
    context.store
      .getState()
      .open(bind(ID, { fields: { ...FIELDS, tags: ["Multiple Subjects"] } }).binding);
    expect(context.store.getState()).toMatchObject({ characterId: ID, kind: "group" });
  });

  it("sends the saved card's source, kind, saved model and workflow, with the stored portrait", async () => {
    const context = setup();
    context.store.getState().open(bind().binding);
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).toEqual({
      kind: "scenario",
      model: "vision",
      // A Scenario's cover letters the card's title.
      source: savedCardArtSource("scenario", FIELDS, "The Lighthouse"),
      workflow: "krea2-second",
      reference: { characterId: ID },
    });
    expect(context.art.calls[0]?.request).toMatchObject({
      source: expect.stringMatching(/^<Title>\nThe Lighthouse\n<\/Title>/),
    });
  });

  it("starts from Settings' image prompt model over the saved one, the portrait following it", async () => {
    const context = setup({ imagePrompt: "text" });
    context.store.getState().open(bind().binding);
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).toMatchObject({ model: "text" });
    expect(context.art.calls[0]?.request).not.toHaveProperty("reference");
  });

  it("sends no portrait when switched off, for a text-only model, or without one", async () => {
    const context = setup();
    context.store.getState().open(bind().binding);
    context.store.getState().setReference(false);
    // The owner's choice survives a change of model.
    context.store.getState().setArtModel("vision");
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).not.toHaveProperty("reference");
    context.store.getState().stopArt();

    const text = setup({ saved: "text" });
    text.store.getState().open(bind().binding);
    text.store.getState().requestArt();
    await vi.waitFor(() => expect(text.art.calls).toHaveLength(1));
    expect(text.art.calls[0]?.request).not.toHaveProperty("reference");

    const none = setup();
    none.store.getState().open(bind(ID, { portrait: null }).binding);
    none.store.getState().requestArt();
    await vi.waitFor(() => expect(none.art.calls).toHaveLength(1));
    expect(none.art.calls[0]?.request).not.toHaveProperty("reference");
  });

  it("decides the portrait for the model it sends", async () => {
    const context = setup({ saved: "text" });
    context.store.getState().open(bind().binding);
    context.store.getState().setArtModel("vision");
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    expect(context.art.calls[0]?.request).toMatchObject({
      model: "vision",
      reference: { characterId: ID },
    });
  });

  it("fails without a model or anything to paint from, sending nothing, and refuses while unbound", async () => {
    const unbound = setup();
    unbound.store.getState().requestArt();
    await tick();
    expect(unbound.store.getState().art).toBeNull();

    const noModel = setup({ saved: null });
    noModel.store.getState().open(bind().binding);
    noModel.store.getState().requestArt();
    expect(noModel.store.getState().art).toEqual({ status: "failed", code: "no_model" });

    const blank = setup();
    // A title alone gives a Scenario cover nothing to picture.
    const empty = {
      name: "The Lighthouse",
      description: "",
      personality: "",
      scenario: "",
      firstMessage: "",
      tags: ["Scenario"],
    };
    blank.store.getState().open(bind(ID, { fields: empty }).binding);
    blank.store.getState().requestArt();
    expect(blank.store.getState().art).toEqual({ status: "failed", code: "empty" });

    await tick();
    expect([unbound, noModel, blank].map((context) => context.art.calls.length)).toEqual([0, 0, 0]);
  });

  it("waits while a rework holds the portrait, and while its own Use saves", async () => {
    const context = setup();
    context.store.getState().open(bind().binding);
    await paint(context);
    context.context.locked = true;
    context.store.getState().requestArt();
    expect(await context.store.getState().use()).toBe(false);
    await tick();
    expect(context.art.calls).toHaveLength(1);
    expect(context.uploads).toHaveLength(0);

    context.context.locked = false;
    let answer: (result: PortraitResult) => void = () => {};
    context.answers.push(new Promise((resolve) => (answer = resolve)));
    const using = context.store.getState().use();
    expect(context.store.getState().useRun).toEqual({ status: "saving" });
    context.store.getState().requestArt();
    await tick();
    expect(context.art.calls).toHaveLength(1);
    answer({ ok: false, reason: "That image could not be read.", signedOut: false });
    await using;
  });

  it("resumes a run the sign-in refused, unless a rework holds it or Stop ended it", async () => {
    let refusals = 2;
    const context = setup({
      status: async () => {
        if (refusals-- > 0) throw new SignedOut();
        return { state: "ready" };
      },
    });
    context.store.getState().open(bind().binding);
    context.store.getState().requestArt();
    await vi.waitFor(() =>
      expect(context.store.getState()).toMatchObject({
        artPending: true,
        art: { status: "waiting" },
      }),
    );
    context.context.locked = true;
    context.store.getState().resumeArt();
    await tick();
    expect(context.store.getState().art).toEqual({ status: "waiting" });
    context.context.locked = false;

    context.store.getState().stopArt();
    expect(context.store.getState()).toMatchObject({
      artPending: false,
      art: { status: "stopped" },
    });
    context.store.getState().resumeArt();
    await tick();
    expect(context.store.getState().art).toEqual({ status: "stopped" });
    expect(context.art.calls).toHaveLength(0);
  });

  it("keeps the same character's session on opening again, and drops it for another", async () => {
    const context = setup();
    context.store.getState().open(bind().binding);
    context.store.getState().setArtDirection("by candlelight");
    await paint(context);
    context.store.getState().select(2);

    const reopened = bind(ID, { fields: { ...FIELDS, description: "Ada, now grey-haired." } });
    context.store.getState().open(reopened.binding);
    expect(context.store.getState()).toMatchObject({
      artDirection: "by candlelight",
      selected: 2,
      images: expect.any(Array),
    });
    expect(context.store.getState().images).toHaveLength(4);
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(2));
    expect(context.art.calls[1]?.request).toMatchObject({
      source: savedCardArtSource(
        "scenario",
        { ...FIELDS, description: "Ada, now grey-haired." },
        FIELDS.name,
      ),
    });

    const running = context.art.calls[1];
    context.store.getState().open(bind(OTHER_ID).binding);
    expect(running?.signal.aborted).toBe(true);
    expect(context.store.getState()).toMatchObject({
      characterId: OTHER_ID,
      art: null,
      images: [],
      artDirection: "",
    });
  });

  it("drops a late batch from an older epoch", async () => {
    const context = setup();
    context.store.getState().open(bind().binding);
    context.store.getState().requestArt();
    await vi.waitFor(() => expect(context.art.calls).toHaveLength(1));
    const batch = context.art.calls[0];
    context.store.getState().clear();
    for (let index = 0; index < 4; index++)
      batch?.push({ type: "image", index, png: PORTRAIT(index) });
    batch?.push({ type: "done" });
    await tick();
    expect(context.store.getState()).toMatchObject({ art: null, images: [] });
  });

  it("binds again after pagehide's clear, and a fresh run works", async () => {
    const context = setup();
    context.store.getState().open(bind().binding);
    await paint(context);
    context.store.getState().clear();
    expect(context.store.getState().characterId).toBeNull();
    context.store.getState().requestArt();
    await tick();
    expect(context.art.calls).toHaveLength(1);

    context.store.getState().open(bind().binding);
    await paint(context);
    expect(context.store.getState().images).toHaveLength(4);
  });

  it("uploads the chosen candidate with a deadline, tells the sheet, then drops the session", async () => {
    const context = setup();
    const { binding, portraits } = bind();
    context.store.getState().open(binding);
    await paint(context);
    context.store.getState().select(2);
    expect(await context.store.getState().use()).toBe(true);
    expect(context.uploads).toEqual([{ id: ID, bytes: 10, signal: expect.any(AbortSignal) }]);
    expect(portraits).toEqual([7]);
    expect(context.store.getState()).toMatchObject({
      characterId: null,
      images: [],
      useRun: null,
    });
  });

  it("changes nothing when the upload answers after the session was dropped", async () => {
    const context = setup();
    const { binding, portraits } = bind();
    context.store.getState().open(binding);
    await paint(context);
    let answer: (result: PortraitResult) => void = () => {};
    context.answers.push(new Promise((resolve) => (answer = resolve)));
    const using = context.store.getState().use();
    context.store.getState().clear();
    answer({ ok: true, version: 8 });
    expect(await using).toBe(false);
    expect(portraits).toEqual([]);
    expect(context.store.getState().useRun).toBeNull();
  });

  it("keeps the batch when the upload fails, saying why, and a deadline as such", async () => {
    const context = setup();
    context.store.getState().open(bind().binding);
    await paint(context);
    context.answers.push({ ok: false, reason: "That image is too large.", signedOut: false });
    expect(await context.store.getState().use()).toBe(false);
    expect(context.store.getState().useRun).toEqual({
      status: "failed",
      reason: "That image is too large.",
    });
    expect(context.store.getState().images).toHaveLength(4);

    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    context.answers.push({ ok: false, reason: "Ephemera could not be reached.", signedOut: false });
    await context.store.getState().use();
    expect(context.store.getState().useRun).toEqual({
      status: "failed",
      reason: "The upload took too long.",
    });
  });

  it("waits for the sign-in when it refused the upload, and retries once on renewal", async () => {
    const context = setup();
    const { binding, portraits } = bind();
    context.store.getState().open(binding);
    await paint(context);
    context.answers.push({ ok: false, reason: "You're signed out.", signedOut: true });
    expect(await context.store.getState().use()).toBe(false);
    expect(context.store.getState()).toMatchObject({
      useRun: { status: "waiting" },
      usePending: true,
    });
    context.store.getState().resumeUse();
    await vi.waitFor(() => expect(portraits).toEqual([7]));
    context.store.getState().resumeUse();
    await tick();
    expect(context.uploads).toHaveLength(2);
  });

  it("holds the choice and the art while a Use waits for the sign-in, so the renewal sends the one Use was pressed on", async () => {
    const context = setup();
    const { binding, portraits } = bind();
    context.store.getState().open(binding);
    await paint(context);
    context.store.getState().select(1);
    context.answers.push({ ok: false, reason: "You're signed out.", signedOut: true });
    await context.store.getState().use();
    expect(context.store.getState().useRun).toEqual({ status: "waiting" });
    context.store.getState().select(3);
    context.store.getState().requestArt();
    await tick();
    expect(context.store.getState().selected).toBe(1);
    expect(context.art.calls).toHaveLength(1);
    context.store.getState().resumeUse();
    await vi.waitFor(() => expect(portraits).toEqual([7]));
    expect(context.uploads.map((upload) => upload.bytes)).toEqual([9, 9]);
  });
});
