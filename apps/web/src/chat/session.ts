import {
  type CharacterMemory,
  castModelOf,
  castReasoningOf,
  DEFAULT_PROMPT_REASONING,
  defaultPromptPreset,
  effectiveWindow,
  type MemoryState,
  replyReserve,
  type Settings,
} from "@ephemera/core";
import { type FetchQueryOptions, hashKey, type QueryKey } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { useStore } from "zustand";
import { isCoarsePointer } from "@/app/form-factor.ts";
import { queryClient } from "@/app/query.ts";
import { isNotFound, modelsQuery } from "../api.ts";
import { ensureCastSheet, updateCast } from "../cast/queries.ts";
import { characterQuery } from "../characters/queries.ts";
import { artStatusQuery } from "../creator/queries.ts";
import {
  deleteEpisode,
  memoryOnIn,
  memoryQuery,
  publishMemoryState,
  refreshMemory,
  remember,
} from "../memory/queries.ts";
import { personaQuery } from "../personas/queries.ts";
import { presetQuery, presetsQuery } from "../presets/queries.ts";
import { currentSettings } from "../settings/settings.ts";
import { identity } from "../signin/identity.ts";
import { SignedOut, signIn } from "../signin/signin.ts";
import type { SceneSubject } from "./scene-slice.ts";
import { streamScene } from "./scene-stream.ts";
import {
  browserClock,
  type ChatState,
  createChatStore,
  type FetchPreview,
  hasChatContent,
  type Selection,
  type StreamReply,
  type SubjectResult,
} from "./store.ts";

/** The AI SDK stream decoder: with the first message or preview, not with the page. */
export const loadTransport = () => import("./transport.ts");

const streamReply: StreamReply = async function* (request, signal) {
  const transport = await loadTransport();
  yield* transport.streamReply(request, signal);
};
const fetchPreview: FetchPreview = async (request, signal) => {
  const transport = await loadTransport();
  return transport.fetchPreview(request, signal);
};

/**
 * The chosen prompt preset's Add to Prompts, from the cached preset list;
 * unknown while the list is missing or out of date.
 */
function presetReasoning(id: string | null): Selection["reasoning"] {
  if (id === null) return DEFAULT_PROMPT_REASONING;
  const { queryKey } = presetsQuery("prompt");
  if (queryClient.getQueryState(queryKey)?.isInvalidated !== false) return null;
  return queryClient.getQueryData(queryKey)?.find((preset) => preset.id === id)?.reasoning ?? null;
}

/** A value read from the query cache, and whether the cache holds another one since. */
interface Read<T> {
  value: T;
  moved: () => boolean;
}

/** Structural sharing keeps an unchanged refresh's value: only a real change has moved. */
const readOf = <T>(queryKey: QueryKey, value: T): Read<T> => ({
  value,
  moved: () => queryClient.getQueryData(queryKey) !== value,
});

const unmoved = () => false;

type Loaded<T> = { ok: true; value: T | null; moved: () => boolean } | { ok: false };

/**
 * A query as an action reads it: the cached data until it is invalidated (an
 * unchanged card of several MB is not fetched again), a refresh under way
 * awaited rather than its older data, fetched when missing.
 */
async function fetchCurrent<T, K extends QueryKey>(
  options: FetchQueryOptions<T, Error, T, K>,
  staleTime: FetchQueryOptions<T, Error, T, K>["staleTime"] = Number.POSITIVE_INFINITY,
): Promise<Read<T>> {
  const refreshing = queryClient.getQueryState(options.queryKey)?.fetchStatus === "fetching";
  const loaded = await queryClient.fetchQuery({
    ...options,
    staleTime: refreshing ? 0 : staleTime,
  });
  // A refresh's promise returns its parsed value before structural sharing;
  // use the cache's value so a greeting sees the same card as its observer.
  return readOf(options.queryKey, queryClient.getQueryData<T>(options.queryKey) ?? loaded);
}

/** The ids a subject is read for: the selection without the preset's reasoning. */
export type SubjectIds = Omit<Selection, "reasoning">;

/**
 * The saved entities a subject reads, each one's query or null when none is
 * chosen: the character, the persona, the prompt preset and, only once a
 * model is chosen, the sampler preset.
 */
export const subjectQueries = (ids: SubjectIds) => ({
  character: ids.characterId === null ? null : characterQuery(ids.characterId),
  persona: ids.personaId === null ? null : personaQuery(ids.personaId),
  prompt: ids.promptPresetId === null ? null : presetQuery("prompt", ids.promptPresetId),
  sampler:
    ids.model === null || ids.samplerPresetId === null
      ? null
      : presetQuery("sampler", ids.samplerPresetId),
});

/**
 * A chosen entity from the query cache, fetched when missing: none when
 * nothing is chosen or it is gone (as the server reads it), not ok when it
 * could not be loaded.
 */
async function saved<T, K extends QueryKey>(
  options: FetchQueryOptions<T, Error, T, K> | null,
): Promise<Loaded<T>> {
  if (options === null) return { ok: true, value: null, moved: unmoved };
  try {
    return { ok: true, ...(await fetchCurrent(options)) };
  } catch (error) {
    return isNotFound(error) ? { ok: true, value: null, moved: unmoved } : { ok: false };
  }
}

/** The settings a subject reads besides the selection are as they were when it started loading. */
const sameReads = (before: Settings, after: Settings, model: string | null) =>
  before.preferCharacterPrompt === after.preferCharacterPrompt &&
  before.preferCharacterInstructions === after.preferCharacterInstructions &&
  (model === null ||
    (before.contextWindows[model] === after.contextWindows[model] &&
      before.contextLimits[model] === after.contextLimits[model]));

/**
 * What the browser's macros read for a selection, from the same saved
 * entities, catalog and settings the server reads, with the runtime it
 * resolves: the selection's model, its window, and the sampler preset's reply
 * length (the model's own when none is chosen or it is gone). Without a known
 * window an action is refused; a greeting (`runtime` optional) fills without
 * one.
 */
async function loadSubject(
  selection: Selection,
  runtime: "required" | "optional",
): Promise<SubjectResult> {
  const settings = currentSettings();
  const { model } = selection;
  const reads = subjectQueries(selection);
  const [character, persona, preset, sampler, catalog] = await Promise.all([
    saved(reads.character),
    saved(reads.persona),
    saved(reads.prompt),
    saved(reads.sampler),
    // A refresh that fails keeps the last catalog that loaded, as the server and the composer
    // do; without any, only a window set in Settings is known.
    model === null
      ? undefined
      : fetchCurrent(modelsQuery, modelsQuery.staleTime).catch(() =>
          readOf(modelsQuery.queryKey, queryClient.getQueryData(modelsQuery.queryKey)),
        ),
  ]);
  if (!sameReads(settings, currentSettings(), model)) return { ok: false, reason: "changed" };
  if (!character.ok || !persona.ok || !preset.ok || !sampler.ok) return { ok: false };
  // A save or refresh landed while another read still waited: what was read is out of date.
  if ([character, persona, preset, sampler, catalog].some((read) => read?.moved() === true)) {
    return { ok: false, reason: "changed" };
  }
  const window = model === null ? null : effectiveWindow(model, catalog?.value, settings);
  if (window === null && runtime === "required") {
    return { ok: false, reason: "context_window_unknown" };
  }
  const { preferCharacterPrompt, preferCharacterInstructions } = settings;
  const stored = preset.value;
  return {
    ok: true,
    subject: {
      character: character.value?.card ?? null,
      persona:
        persona.value === null
          ? null
          : { name: persona.value.name, description: persona.value.description },
      // Without a chosen (or with a deleted) preset the server builds from the built-in default.
      preset:
        stored === null
          ? defaultPromptPreset()
          : {
              name: stored.name,
              blocks: stored.blocks,
              actions: stored.actions,
              reasoning: stored.reasoning,
              authorsNote: stored.authorsNote,
            },
      prefer: { preferCharacterPrompt, preferCharacterInstructions },
      ...(model === null || window === null
        ? {}
        : {
            runtime: {
              model,
              window: window.tokens,
              reserve: replyReserve(sampler.value?.values.maxOutputTokens ?? null, window.tokens),
            },
          }),
    },
  };
}

/**
 * What a scene picture is written from: the chat character's card and the
 * persona's name, from the query cache, fetched when missing. None when the
 * character is gone; a sign-in refusal waits for the renewal, another
 * failure fails the picture.
 */
async function sceneSubject(
  characterId: string,
  personaId: string | null,
): Promise<SceneSubject | null> {
  const load = async <T>(read: () => Promise<Read<T>>): Promise<T | null> => {
    try {
      return (await read()).value;
    } catch (error) {
      if (error instanceof SignedOut) throw error;
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const [character, persona] = await Promise.all([
    load(() => fetchCurrent(characterQuery(characterId))),
    personaId === null ? null : load(() => fetchCurrent(personaQuery(personaId))),
  ]);
  return character === null ? null : { card: character.card, persona: persona?.name ?? null };
}

/** What a send, a generation or a preview reads: never without the model's window. */
export const chatSubject = (selection: Selection) => loadSubject(selection, "required");

/** What the greeting reads: the chosen model's runtime when known, the greeting without it. */
export const greetingSubject = (selection: Selection) => loadSubject(selection, "optional");

/** Whether memory is on for a character as its memory query stands in the cache (`memoryOnIn`). */
const memoryOnNow = (characterId: string): boolean =>
  memoryOnIn(queryClient.getQueryState(memoryQuery(characterId).queryKey));

/**
 * A character's memory changed; it reloads in the background. A memory that
 * landed brings the notebook row the server left (`publishMemoryState`).
 */
export function memoryChanged(characterId: string, notebook?: MemoryState): void {
  void (notebook === undefined
    ? refreshMemory(queryClient, characterId)
    : publishMemoryState(queryClient, characterId, notebook));
}

/** The single chat session of this tab; the model, presets, character and persona come from the saved settings. */
export const chatStore = createChatStore(
  streamReply,
  () => {
    const { model, samplerPresetId, promptPresetId, characterId, personaId } = currentSettings();
    return {
      model,
      samplerPresetId,
      promptPresetId,
      characterId,
      personaId,
      reasoning: presetReasoning(promptPresetId),
    };
  },
  {
    clock: browserClock,
    fetchPreview,
    signedIn: signIn.signedIn,
    resumable: () => signIn.savesSettled(),
    subject: chatSubject,
    // Read when an action fills its macros, so loading this module needs no window.
    isMobile: isCoarsePointer,
    memory: {
      // As last loaded: the chosen character's memory is fetched as soon as it is chosen; off until it is.
      enabled: (characterId) => memoryOnNow(characterId),
      settings: () => {
        const settings = currentSettings();
        return {
          spanTokens: settings.memorySpanTokens,
          keepTurns: settings.memoryKeepTurns,
          memoryModel: settings.memoryModel,
          reasoning: settings.memoryReasoning,
        };
      },
      remember,
      forget: deleteEpisode,
      changed: memoryChanged,
    },
    scene: {
      streamScene,
      // Asked when the button is pressed, so a status changed in Settings meanwhile counts.
      artStatus: (workflow) => queryClient.fetchQuery(artStatusQuery(workflow)),
      workflow: () => currentSettings().comfyuiWorkflow,
      imagePromptModel: () => currentSettings().imagePromptModel,
      subject: sceneSubject,
    },
    cast: {
      memory: async (characterId) => {
        try {
          return (await fetchCurrent(memoryQuery(characterId))).value;
        } catch {
          return undefined;
        }
      },
      update: updateCast,
      sheet: ensureCastSheet,
      // Read when a call starts, so a model changed in Settings meanwhile counts.
      settings: () => {
        const settings = currentSettings();
        return { model: castModelOf(settings), reasoning: castReasoningOf(settings) };
      },
      newId: () => crypto.randomUUID(),
      // As last loaded: the chosen persona is fetched with the chat.
      player: (personaId) =>
        queryClient.getQueryData(personaQuery(personaId).queryKey)?.name ?? null,
    },
  },
);

/**
 * The chosen character's memory follows the chat: another character unfolds
 * it and forgets its recap; memory turned off, or the character deleted
 * elsewhere, does too (Forget everything
 * keeps it on, so the Memory screen resets the chat itself); memory on, once
 * loaded, shows in the next preview; an episode of this chat deleted
 * elsewhere leaves its recap, the latest one unfolding its turns, and all of
 * them gone (Forget everything in another tab) unfolds the chat whole. A
 * newer notebook or memory revision (saved here or in another tab) rebuilds
 * the preview, so the meter and an open inspector show what goes out. The chosen
 * character's memory is loaded as soon as it is chosen, so a request knows
 * whether it is on.
 */
/** A character's memory revisions as one key: the notebook's, then each memory's by id. */
const memoryRevisions = ({ state, episodes }: CharacterMemory): string =>
  [state?.revision ?? -1, ...episodes.map((episode) => `${episode.id}:${episode.revision}`)].join(
    " ",
  );

function followMemory(): () => void {
  let characterId: string | null = null;
  let enabled = false;
  /** The revisions the last preview was built on: the notebook's and each memory's. */
  let revisions = "";
  /** The memory last read and its revisions: the same object holds the same revisions. */
  let read: { data: CharacterMemory; revisions: string } | null = null;
  return queryClient.getQueryCache().subscribe((event) => {
    const chosen = currentSettings().characterId;
    const switched = chosen !== characterId;
    if (switched) {
      characterId = chosen;
      enabled = false;
      revisions = "";
      read = null;
      chatStore.getState().memoryReset();
      if (chosen !== null) void queryClient.prefetchQuery(memoryQuery(chosen));
    }
    if (chosen === null) return;
    const { queryKey } = memoryQuery(chosen);
    const hash = hashKey(queryKey);
    // Every other query's events leave the chosen memory as it was; only a switch reads it anew.
    if (!switched && event.query.queryHash !== hash) return;
    const data = queryClient.getQueryData(queryKey);
    chatStore
      .getState()
      .receiveCastMemory(
        chosen,
        isNotFound(queryClient.getQueryState(queryKey)?.error) ? undefined : data,
      );
    if (data === undefined) return;
    const on = memoryOnNow(chosen);
    if (read?.data !== data) read = { data, revisions: memoryRevisions(data) };
    const seen = read.revisions;
    if (on !== enabled) {
      enabled = on;
      revisions = seen;
      if (on) chatStore.getState().schedulePreview();
      else chatStore.getState().memoryReset();
    } else if (on && seen !== revisions) {
      revisions = seen;
      chatStore.getState().schedulePreview();
    }
    // Only an answer the server just gave: a value set by hand may predate a memory that landed.
    if (
      !on ||
      event.type !== "updated" ||
      event.action.type !== "success" ||
      event.action.manual === true ||
      event.query.queryHash !== hash
    )
      return;
    const stored = new Set(data.episodes.map((episode) => episode.id));
    const { recap, held, foldedLatest } = chatStore.getState().memory;
    const carried = new Set([
      ...recap,
      ...held.map((span) => span.id),
      ...(foldedLatest === null ? [] : [foldedLatest.id]),
    ]);
    // None of them left (Forget everything, in another tab): the whole chat unfolds, not only
    // the latest memory's turns.
    if (carried.size > 0 && [...carried].every((id) => !stored.has(id))) {
      chatStore.getState().memoryReset();
      return;
    }
    for (const id of carried) if (!stored.has(id)) chatStore.getState().episodeGone(id);
  });
}
followMemory();

/**
 * The generation that waited goes out once, and a picture the sign-in
 * interrupted goes again beside it, only signed in and once the edits and
 * settings they depend on are saved; otherwise the resume stage runs them.
 */
function resumeIfReady(): void {
  if (!signIn.signedIn() || !signIn.savesSettled()) return;
  void chatStore.getState().resume();
  chatStore.getState().resumeScene();
}

/** The settings that choose what a subject reads (the selection, without the preset's reasoning). */
const sameSelection = (before: Settings, after: Settings) =>
  before.model === after.model &&
  before.samplerPresetId === after.samplerPresetId &&
  before.promptPresetId === after.promptPresetId &&
  before.characterId === after.characterId &&
  before.personaId === after.personaId;

/**
 * The next prompt's preview (the meter's numbers and the inspector's view)
 * follows the settings a subject reads, wherever they change; the store
 * follows the chat and the draft. A generation that waited without a model
 * goes out once one is chosen.
 */
function followSelection(): () => void {
  let settings = currentSettings();
  return queryClient.getQueryCache().subscribe(() => {
    const before = settings;
    settings = currentSettings();
    if (settings === before) return;
    if (sameSelection(before, settings) && sameReads(before, settings, settings.model)) return;
    chatStore.getState().schedulePreview();
    if (settings.model !== null && before.model !== settings.model) resumeIfReady();
  });
}
followSelection();

// Once the session is back, after edits and settings are saved: the generation that waited
// goes out once.
signIn.onRenewed(async () => {
  // A picture the sign-in interrupted goes again beside it.
  chatStore.getState().resumeScene();
  return (await chatStore.getState().resume()) ? "send" : undefined;
}, "resume");

// Signed in again: a refusal that arrived during the renewal is sent now, and the preview,
// which waits while signed out, follows the chat as it is.
signIn.store.subscribe((state, previous) => {
  if (state.phase !== "renewed" || previous.phase === "renewed") return;
  resumeIfReady();
  chatStore.getState().schedulePreview();
});

export function useChat<T>(selector: (state: ChatState) => T): T {
  return useStore(chatStore, selector);
}

/**
 * `pagehide` empties the chat synchronously, DOM included, so the
 * back/forward cache cannot restore it; leaving a non-empty chat asks first.
 */
export function installPageLifecycle(): void {
  window.addEventListener("pagehide", () => {
    flushSync(() => chatStore.getState().clear());
  });
  const guarded = identity.guard(() => hasChatContent(chatStore.getState()));
  window.addEventListener("beforeunload", (event) => {
    if (guarded()) event.preventDefault();
  });
}
