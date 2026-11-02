import {
  type ArtStreamEvent,
  type CallAccounting,
  type CharacterCard,
  type ChatTurn,
  type CreatorArtStatus,
  type CreatorErrorCode,
  type CreatorKind,
  imagePromptModelOf,
  type SceneRequest,
  savedCardKind,
  sceneExcerpt,
  sceneSource,
} from "@ephemera/core";
import type { StoreApi } from "zustand/vanilla";
import type { ArtImage, ArtPhase, ArtRun } from "../creator/art-slice.ts";
import { SignedOut } from "../signin/signin.ts";
import type { UsageHandle } from "./usage.ts";

/*
 * Picture this scene (PRINCIPLES.md 1): one picture of the chat's current
 * moment per press, shown in the thread after the message it follows. The
 * turns it was asked from, the source written from them and the picture's
 * PNG bytes are chat content, held in tab memory on the item and nowhere
 * else: no URL, no Blob, no storage. The items live beside `messages`, never
 * in them, so no generation, preview, inspector or memory request can carry
 * them. Clear, Stop, `pagehide` and deleting the message they follow end
 * them; nothing late lands in a chat that moved on.
 */

export type StreamScene = (
  request: SceneRequest,
  signal: AbortSignal,
  onAccounting?: (accounting: CallAccounting) => void,
) => Promise<AsyncIterable<ArtStreamEvent>>;

/** What a scene is written from besides the turns: the chat character's card and the persona's name. */
export interface SceneSubject {
  card: CharacterCard;
  /** The persona the chat is with; null for none, which the excerpt calls "You". */
  persona: string | null;
}

export interface SceneDeps {
  streamScene: StreamScene;
  /** The portrait status when a picture starts; it is asked for only when ready. */
  artStatus: (workflow: string) => Promise<CreatorArtStatus>;
  /** The workflow Settings chose, read when the button is pressed. */
  workflow: () => string;
  /** Settings' image prompt model, read when the button is pressed; null uses the chat's. */
  imagePromptModel: () => string | null;
  /** The card and persona, loaded when a picture first starts; null when the character is gone. */
  subject: (characterId: string, personaId: string | null) => Promise<SceneSubject | null>;
}

/**
 * What an item is asked from, taken when the button is pressed and kept for
 * Paint it again: the chat's shown turns then, and once the card is read, the
 * source written from them. Chat content.
 */
interface SceneSnapshot {
  generation?: string | null;
  characterId: string;
  personaId: string | null;
  model: string;
  workflow: string;
  turns: ChatTurn[];
  /** The people present then, as the cast register had them (`castPeopleNotes`); "" for none. */
  people?: string;
  /** Built on the first run from the card and `turns`; every later run sends it as it is. */
  written?: { kind: CreatorKind; source: string; name: string };
}

/**
 * Where an item stands, in the art run's words: not asked for, being
 * painted, waiting for a sign-in, stopped, failed, or complete with its PNG.
 */
export type SceneRun = ArtRun;

export interface SceneItem {
  id: string;
  /** The message it follows: the newest one when the button was pressed. */
  anchorId: string;
  run: SceneRun;
  request: SceneSnapshot;
  /** The one picture, once whole; never a partial one. */
  png?: ArtImage;
}

export interface SceneSliceState {
  /** Beside `messages`, never in them. */
  scenes: SceneItem[];
  /** Pictures the moment after the newest message; refused while a reply or a picture is on its way. */
  pictureScene: () => void;
  /** Paints a failed, stopped or skipped item again in place, from its snapshot. */
  retryScene: (id: string) => void;
  /** Ends the picture on its way, if any; the item stays, stopped. */
  stopScene: () => void;
  /** Removes an item that is not on its way. */
  hideScene: (id: string) => void;
  /** Sends the picture a sign-in interrupted once more, if it still waits. */
  resumeScene: () => void;
}

/** What the chat store lends the slice. */
interface SceneHost {
  /** The chat's character, persona and model now. */
  chosen: () => { characterId: string | null; personaId: string | null; model: string | null };
  /** The turns the chat shows after its folded ones, the newest message's id, the people present. */
  moment: () => {
    turns: ChatTurn[];
    anchorId: string | undefined;
    people: string;
    generation?: string | null;
  };
  trackUsage?: (model: string, generation: string | null) => UsageHandle;
  generating: () => boolean;
  signedIn: () => boolean;
  /** Registers a controller with the store's in-flight set; returns its release. */
  register: (controller: AbortController) => () => void;
}

type SceneStore = SceneSliceState & { epoch: number };

/** A run that is on its way: being painted or waiting for a sign-in. */
export const onItsWay = (run: SceneRun) => run.status === "running" || run.status === "waiting";

const failed = (code: CreatorErrorCode | "stream"): SceneRun => ({ status: "failed", code });

export function createSceneSlice(
  set: StoreApi<SceneStore>["setState"],
  get: StoreApi<SceneStore>["getState"],
  deps: SceneDeps | undefined,
  host: SceneHost,
) {
  /** The item on its way and its request; one at a time. */
  let active: { id: string; controller: AbortController } | undefined;
  /** The item a sign-in refused waits for one renewal. */
  let pending = false;

  const find = (id: string) => get().scenes.find((item) => item.id === id);
  const update = (id: string, patch: Partial<SceneItem>) =>
    set((state) => ({
      scenes: state.scenes.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  const busy = () => host.generating() || get().scenes.some((item) => onItsWay(item.run));

  /** The item's state is written before its request is aborted, so no aborted write decides it. */
  const settle = (keep: (item: SceneItem) => boolean, ended: SceneRun | null) => {
    const ending = active;
    const items = get().scenes;
    const touched = items.filter((item) => !keep(item));
    if (touched.length === 0) return;
    if (touched.some((item) => item.run.status === "waiting")) pending = false;
    set({
      scenes:
        ended === null
          ? items.filter(keep)
          : items.map((item) => (keep(item) ? item : { ...item, run: ended })),
    });
    if (ending !== undefined && touched.some((item) => item.id === ending.id)) {
      active = undefined;
      ending.controller.abort();
    }
  };

  const runScene = async (id: string, retried = false) => {
    const item = find(id);
    if (deps === undefined || item === undefined) return;
    const { epoch } = get();
    pending = false;
    const controller = new AbortController();
    const release = host.register(controller);
    active = { id, controller };
    const current = () =>
      get().epoch === epoch && !controller.signal.aborted && find(id) !== undefined;
    const started = performance.now();
    const progress = (phase: ArtPhase, value: number, max: number, position?: number) =>
      update(id, {
        run: {
          status: "running",
          phase,
          value,
          max,
          ...(position === undefined ? {} : { position }),
          started,
          heard: performance.now(),
        },
      });
    progress("status", 0, 1);
    let accounting: UsageHandle | undefined;
    let received = false;
    let signedOut = false;
    let promptComplete = false;
    try {
      let { request } = item;
      let { written } = request;
      if (written === undefined) {
        const subject = await deps.subject(request.characterId, request.personaId);
        if (!current()) return;
        if (subject === null) {
          update(id, { run: failed("not_found") });
          return;
        }
        const { card } = subject;
        const names = { user: subject.persona ?? "You", char: card.name };
        const kind = savedCardKind(card.tags);
        written = {
          kind,
          name: card.name,
          source: sceneSource({
            kind,
            card,
            excerpt: sceneExcerpt(request.turns, names),
            names,
            ...(request.people === undefined ? {} : { people: request.people }),
          }),
        };
        request = { ...request, written };
        update(id, { request });
      }
      // An unknown status skips the picture; a sign-in refusal waits for the renewal below.
      const status = await deps.artStatus(request.workflow).catch((error: unknown) => {
        if (error instanceof SignedOut) throw error;
        return undefined;
      });
      if (!current()) return;
      if (status?.state !== "ready") {
        update(id, { run: { status: "skipped", reason: status?.state ?? "unknown" } });
        return;
      }
      // ComfyUI answered; the server writes the image prompt first.
      progress("prompt", 0, 1);
      accounting = host.trackUsage?.(request.model, request.generation ?? null);
      const events = await deps.streamScene(
        {
          model: request.model,
          workflow: request.workflow,
          characterId: request.characterId,
          kind: written.kind,
          source: written.source,
        },
        controller.signal,
        (receipt) => {
          received = true;
          accounting?.receive(receipt);
        },
      );
      // Exactly one image, index 0, then done: anything else fails the item and drops the bytes.
      let png: ArtImage | undefined;
      for await (const event of events) {
        if (!current()) return;
        if (event.type === "progress") {
          if (event.phase === "prompt" && event.value === event.max) promptComplete = true;
          progress(event.phase, event.value, event.max, event.position);
        } else if (event.type === "image") {
          if (png !== undefined || event.index !== 0) {
            update(id, { run: failed("stream") });
            return;
          }
          png = event.png;
          progress("receiving", 1, 1);
        } else if (event.type === "error") {
          update(id, { run: failed(event.code) });
          return;
        } else {
          update(
            id,
            png === undefined ? { run: failed("stream") } : { run: { status: "complete" }, png },
          );
          return;
        }
      }
      if (current()) update(id, { run: failed("stream") });
    } catch (error) {
      if (!current()) return;
      if (error instanceof SignedOut) {
        signedOut = true;
        // It waits for the renewal, or goes again now for a stale refusal.
        update(id, { run: { status: "waiting" } });
        pending = true;
        if (error.stale && host.signedIn() && !retried) get().resumeScene();
      } else {
        update(id, { run: failed("stream") });
      }
    } finally {
      accounting?.finish(
        received || signedOut
          ? undefined
          : controller.signal.aborted
            ? "aborted"
            : promptComplete
              ? "completed"
              : "failed",
      );
      release();
      if (active?.controller === controller) active = undefined;
    }
  };

  const actions: SceneSliceState = {
    scenes: [],

    pictureScene: () => {
      if (deps === undefined || busy()) return;
      const chosen = host.chosen();
      const { characterId, personaId } = chosen;
      const model = imagePromptModelOf(null, deps.imagePromptModel(), chosen.model);
      const { turns, anchorId, people, generation } = host.moment();
      if (characterId === null || model === null || anchorId === undefined || turns.length === 0) {
        return;
      }
      const now = performance.now();
      const item: SceneItem = {
        id: crypto.randomUUID(),
        anchorId,
        run: { status: "running", phase: "status", value: 0, max: 1, started: now, heard: now },
        request: {
          characterId,
          personaId,
          model,
          workflow: deps.workflow(),
          turns,
          people,
          ...(generation === undefined ? {} : { generation }),
        },
      };
      set((state) => ({ scenes: [...state.scenes, item] }));
      void runScene(item.id);
    },

    retryScene: (id) => {
      const item = find(id);
      if (item === undefined || busy()) return;
      const { status } = item.run;
      if (status === "failed" || status === "stopped" || status === "skipped") void runScene(id);
    },

    stopScene: () => settle((item) => !onItsWay(item.run), { status: "stopped" }),

    hideScene: (id) => {
      const item = find(id);
      if (item === undefined || onItsWay(item.run)) return;
      set((state) => ({ scenes: state.scenes.filter((scene) => scene.id !== id) }));
    },

    resumeScene: () => {
      const waiting = get().scenes.find((item) => item.run.status === "waiting");
      if (pending && waiting !== undefined) void runScene(waiting.id, true);
    },
  };

  return {
    actions,
    /** Drops the items following any message `gone` names; one on its way is aborted after. */
    drop: (gone: (anchorId: string) => boolean) => settle((item) => !gone(item.anchorId), null),
  };
}
