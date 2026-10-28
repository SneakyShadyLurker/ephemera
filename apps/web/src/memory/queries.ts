import {
  type CallAccounting,
  type CharacterMemory,
  characterMemorySchema,
  type EpisodeFields,
  type MemoryNotebook,
  type MemoryRefusal,
  type MemoryState,
  memoryIsOn,
  memoryStateSchema,
  type OpeningRefusal,
  type OpeningRequest,
  openingRefusalSchema,
  openingResponseSchema,
  type RememberRequest,
  type RememberResponse,
  rememberRefusalSchema,
  rememberResponseSchema,
  type StoredEpisode,
  storedEpisodeSchema,
} from "@ephemera/core";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { api, entityError, entityRetry, isNotFound } from "../api.ts";
import { type CallFailure, settled } from "../model-call.ts";
import { removing, type SaveResult, saving, unsafeOptions } from "../sheet/saving.ts";

/*
 * Server data for a character's memory: the notebook row and the episodes,
 * in memory only like every query. Which turns a memory covered and which
 * chat it came from are chat content and live in the chat store, never here.
 */

export const MEMORY_KEY = (characterId: string) => ["memory", characterId] as const;

/**
 * A character's memory (core's `CharacterMemory`): its notebook row (null
 * while nothing needed one; memory is on then) and its episodes, oldest first.
 */

/**
 * Whether memory is on for a character as its memory query stands (a
 * `useQuery` result or the cache's query state): the default (core
 * `memoryIsOn`) once loaded, and never before it first loads, so nothing
 * carries or writes memory on a guess. A character deleted elsewhere is off:
 * its refetch fails `not_found` while the memory it loaded before stays. A
 * memory loaded before any other failed refetch still counts.
 */
export const memoryOnIn = (
  query: { data: CharacterMemory | undefined; error: Error | null } | undefined,
): boolean => query?.data !== undefined && !isNotFound(query.error) && memoryIsOn(query.data.state);

export const memoryQuery = (characterId: string) =>
  queryOptions({
    queryKey: MEMORY_KEY(characterId),
    // A character that is gone is final ("not_found"): it has no memory, on or off.
    retry: entityRetry,
    queryFn: async ({ signal }): Promise<CharacterMemory> => {
      const response = await api.memory.characters[":id"].$get(
        { param: { id: characterId } },
        { init: { signal } },
      );
      if (!response.ok) throw entityError(response.status);
      return characterMemorySchema.parse(await response.json());
    },
  });

/**
 * Turns memory on or off, or rewrites the notebook or the next chat's
 * opening, against `revision`; a character without a notebook row is at
 * revision 0, and this creates it.
 */
export function saveMemoryState(
  characterId: string,
  patch: { enabled?: boolean; notebook?: MemoryNotebook; opening?: string },
  revision: number,
): Promise<SaveResult<MemoryState>> {
  return saving(
    (init) =>
      api.memory.characters[":id"].$patch(
        { param: { id: characterId }, json: { ...patch, revision } },
        { init },
      ),
    async (response) => memoryStateSchema.parse(await response.json()),
  );
}

/**
 * Forgets everything the character remembers: the memory as the server left
 * it (the emptied notebook at its new revision, no memories); "gone" for a
 * character that no longer exists, whose memory went with it; null when the
 * server did not forget.
 */
export async function forgetMemory(characterId: string): Promise<CharacterMemory | "gone" | null> {
  try {
    const response = await api.memory.characters[":id"].$delete(
      { param: { id: characterId } },
      unsafeOptions(),
    );
    if (response.status === 404) return "gone";
    if (!response.ok) return null;
    return characterMemorySchema.parse(await response.json());
  } catch {
    return null;
  }
}

/** Saves some of an episode's fields against `revision`; the saved episode carries its new revision. */
export function saveEpisode(
  id: string,
  patch: Partial<EpisodeFields>,
  revision: number,
): Promise<SaveResult<StoredEpisode>> {
  return saving(
    (init) =>
      api.memory.episodes[":id"].$patch({ param: { id }, json: { ...patch, revision } }, { init }),
    async (response) => storedEpisodeSchema.parse(await response.json()),
  );
}

/** Deletes an episode; false when the server did not (already gone counts as deleted). */
export function deleteEpisode(id: string): Promise<boolean> {
  return removing((init) => api.memory.episodes[":id"].$delete({ param: { id } }, init));
}

/**
 * Why a memory call wrote nothing the tab can use. `unreachable` and
 * `signed_out` lost the answer (the server may have written the memory):
 * a retry sends the same attempt, so it gets that memory back. Every other
 * reason is the server's refusal, which dropped the attempt: a retry draws
 * a new one. `no_model` never reached the server: no model was chosen for
 * memory or the chat.
 */
export type RememberFailure = CallFailure<MemoryRefusal> | "no_model";

/** A memory call's outcome; `lost` says a retry reuses the attempt (see `RememberFailure`). */
export type RememberOutcome =
  | { ok: true; response: RememberResponse }
  | { ok: false; reason: RememberFailure; lost: boolean };

const failed = (reason: RememberFailure): RememberOutcome => ({
  ok: false,
  reason,
  lost: reason === "unreachable" || reason === "signed_out",
});

/**
 * One memory call. The span goes in the request body only (chat content, for
 * this request); the answer is the memory written and this chat's episodes
 * from now on. Once the model is asked the server answers 200 at once and
 * sends one JSON text when the call settles, blank lines before it: the
 * memory, or the refusal it came to.
 */
export async function remember(
  request: RememberRequest,
  signal: AbortSignal,
  onAccounting?: (accounting: CallAccounting) => void,
): Promise<RememberOutcome> {
  const outcome = await settled(
    () => api.memory.remember.$post({ json: request }, { init: { signal } }),
    rememberRefusalSchema,
    (body) => rememberResponseSchema.safeParse(body).data,
    onAccounting,
  );
  return outcome.ok ? { ok: true, response: outcome.value } : failed(outcome.reason);
}

/**
 * Why an opening call gave no opening: the server's refusal, or no answer
 * (`unreachable`, `signed_out`), or a request Ephemera refused or never
 * finished. Nothing was written either way: the call writes nothing.
 */
export type OpeningFailure = CallFailure<OpeningRefusal>;

/** An opening call's outcome: the opening written, the persona as `{{user}}`, or why not. */
type OpeningOutcome = { ok: true; opening: string } | { ok: false; reason: OpeningFailure };

/**
 * Writes the next chat's opening from what the character remembers. The
 * answer is the owner's to keep: it lives in the caller's state until the
 * notebook saves it, and the server keeps none of it. Once the model is
 * asked the server answers 200 at once and sends one JSON text when the call
 * settles, blank lines before it: the opening, or the refusal it came to.
 */
export async function writeOpening(
  characterId: string,
  request: OpeningRequest,
  signal: AbortSignal,
  onAccounting?: (accounting: CallAccounting) => void,
): Promise<OpeningOutcome> {
  const outcome = await settled(
    () =>
      api.memory.characters[":id"].opening.$post(
        { param: { id: characterId }, json: request },
        { init: { signal } },
      ),
    openingRefusalSchema,
    (body) => openingResponseSchema.safeParse(body).data?.opening,
    onAccounting,
  );
  return outcome.ok ? { ok: true, opening: outcome.value } : outcome;
}

/**
 * A write left the character's notebook row as `state`: the cache takes it at
 * once (so the next chat opens on its opening without waiting for the
 * reload), unless it already holds that revision or a newer one, since a late
 * or replayed answer never undoes a newer edit. Then it reloads.
 */
export function publishMemoryState(
  queryClient: QueryClient,
  characterId: string,
  state: MemoryState,
): Promise<void> {
  queryClient.setQueryData<CharacterMemory>(MEMORY_KEY(characterId), (current) =>
    current === undefined || (current.state?.revision ?? -1) >= state.revision
      ? undefined
      : { ...current, state },
  );
  return refreshMemory(queryClient, characterId);
}

/** After any change to a character's memory: it reloads in the background. */
export async function refreshMemory(queryClient: QueryClient, characterId: string): Promise<void> {
  const key = { queryKey: MEMORY_KEY(characterId), exact: true };
  // A fetch started before the change could answer with the book as it was and unfold what just landed.
  await queryClient.cancelQueries(key);
  await queryClient.invalidateQueries(key);
}
