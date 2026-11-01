import type { CreatorArtStatus, CreatorCardEvent, CreatorKind } from "@ephemera/core";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { SignedOut } from "../signin/signin.ts";
import { ART_EMPTY, type ArtSliceState, createArtSlice, type StreamArt } from "./art-slice.ts";
import type { StreamBrainstorm } from "./brainstorm-slice.ts";
import { createCreatorStore } from "./store.ts";

const ANSWER = [
  "<name>Ada Reed</name>",
  "<description><ada_reed><backgroundstory>Grew up in Testtown.</backgroundstory>",
  "<appearance>Tall, placeholder build.</appearance><personality>Calm.</personality>",
  "<vocabulary>Short sentences.</vocabulary></ada_reed></description>",
  "<firstMessage>Ada looks up.</firstMessage>",
  "<creatorNotes>A placeholder pitch.</creatorNotes>",
].join("\n");

/** The brainstorm these tests never start. */
const noIdeas: StreamBrainstorm = async () => (async function* () {})();

describe("the creator's art slice", () => {
  it.each(["subject", "group", "scenario"] as const)(
    "snapshots composition before async preflight for %s and only sends it for Subject",
    async (kind: CreatorKind) => {
      let ready = () => {};
      const status = new Promise<CreatorArtStatus>((resolve) => {
        ready = () => resolve({ state: "ready" });
      });
      const streamArt = vi.fn<StreamArt>(async () => (async function* () {})());
      const store = createStore<ArtSliceState>()((set, get) => ({
        epoch: 0,
        ...ART_EMPTY,
        ...createArtSlice(set, get, {
          streamArt,
          artStatus: () => status,
          subject: () => ({
            kind,
            source: "Notes",
            model: "model-a",
            reasoning: "provider-default",
          }),
          locked: () => false,
          register: () => () => {},
        }),
      }));
      store.getState().setArtComposition("diptych");
      store.getState().requestArt();
      store.getState().setArtComposition("regular");
      ready();
      await vi.waitFor(() => expect(streamArt).toHaveBeenCalledOnce());
      const request = streamArt.mock.calls[0]?.[0];
      if (kind === "subject") expect(request).toMatchObject({ composition: "diptych" });
      else expect(request).not.toHaveProperty("composition");
      expect(store.getState().artComposition).toBe("regular");
    },
  );

  it.each(["subject", "group", "scenario"] as const)(
    "snapshots the look before async preflight for %s and sends it for Subject and Group only, never Auto",
    async (kind: CreatorKind) => {
      let ready = () => {};
      const status = new Promise<CreatorArtStatus>((resolve) => {
        ready = () => resolve({ state: "ready" });
      });
      const streamArt = vi.fn<StreamArt>(async () => (async function* () {})());
      const store = createStore<ArtSliceState>()((set, get) => ({
        epoch: 0,
        ...ART_EMPTY,
        ...createArtSlice(set, get, {
          streamArt,
          artStatus: () => status,
          subject: () => ({
            kind,
            source: "Notes",
            model: "model-a",
            reasoning: "provider-default",
          }),
          locked: () => false,
          register: () => () => {},
        }),
      }));
      store.getState().setArtLook("film");
      store.getState().requestArt();
      store.getState().setArtLook("auto");
      ready();
      await vi.waitFor(() => expect(store.getState().art?.status).toBe("failed"));
      const request = streamArt.mock.calls[0]?.[0];
      if (kind === "scenario") expect(request).not.toHaveProperty("look");
      else expect(request).toMatchObject({ look: "film" });

      store.getState().requestArt();
      await vi.waitFor(() => expect(streamArt).toHaveBeenCalledTimes(2));
      expect(streamArt.mock.calls[1]?.[0]).not.toHaveProperty("look");
    },
  );

  it("Stop ends a run waiting for the sign-in, and the creator's pending with it", async () => {
    const streamArt = vi.fn(async () => {
      throw new Error("Nothing is painted here");
    });
    const store = createCreatorStore({
      streamBrainstorm: noIdeas,
      streamCard: async () =>
        (async function* (): AsyncGenerator<CreatorCardEvent> {
          yield { type: "delta", text: ANSWER };
          yield { type: "result", validation: { ok: true }, tokens: [] };
        })(),
      streamArt,
      artStatus: async () => {
        throw new SignedOut();
      },
      saveCard: async () => ({ ok: true }),
      savePortrait: async () => ({ ok: true, version: 1 }),
    });
    store.getState().choose("subject");
    store.getState().setDescription("A placeholder lighthouse keeper");
    store.getState().create("model-a", "provider-default", null);
    await vi.waitFor(() =>
      expect(store.getState()).toMatchObject({ pending: "art", art: { status: "waiting" } }),
    );

    store.getState().stopArt();
    expect(store.getState()).toMatchObject({
      pending: null,
      artPending: false,
      art: { status: "stopped" },
    });
    store.getState().resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().art).toEqual({ status: "stopped" });
    expect(streamArt).not.toHaveBeenCalled();
  });
});
