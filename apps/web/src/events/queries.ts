import {
  type EventFields,
  eventLimitSchema,
  eventsResponseSchema,
  type StoredEvent,
  storedEventSchema,
} from "@ephemera/core";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { api } from "../api.ts";
import {
  type CreateOutcome,
  failureOf,
  failureWords,
  removing,
  SAVE_TIMEOUT_MS,
  type SaveFailure,
  type SaveResult,
  saving,
  thrownFailure,
} from "../sheet/saving.ts";

/*
 * Server data for events: their definitions, newest first, in memory only
 * like every query. Which event fired where is chat content and lives in
 * the chat store, never here.
 */

export const EVENTS_KEY = ["events"] as const;

export const eventsQuery = queryOptions({
  queryKey: EVENTS_KEY,
  queryFn: async ({ signal }): Promise<StoredEvent[]> => {
    const response = await api.events.$get(undefined, { init: { signal } });
    if (!response.ok) throw new Error("unavailable");
    return eventsResponseSchema.parse(await response.json()).events;
  },
});

/** Why a create did not happen, in words after "Not created: ". */
export const EVENT_LIMIT_REACHED = "limit reached";

/** Why a create was refused: a save failure, or the user's events at the limit (final). */
type EventCreateFailure = Exclude<SaveFailure, "conflict"> | "limit";

/**
 * Creates an event under a client-chosen id, so a retry after a lost response
 * is harmless: the autosave of a new event's row retries with the same id.
 */
export async function postEvent(
  id: string,
  fields: EventFields,
): Promise<{ ok: true } | { ok: false; reason: EventCreateFailure }> {
  try {
    const response = await api.events.$post(
      { json: { id, ...fields } },
      { init: { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) } },
    );
    if (response.ok) return { ok: true };
    if (response.status === 409) {
      // Final: the user has as many events as Ephemera keeps; a retry would be refused again.
      const body: unknown = await response.json().catch(() => undefined);
      if (eventLimitSchema.safeParse(body).success) return { ok: false, reason: "limit" };
    }
    return { ok: false, reason: failureOf(response.status) };
  } catch (error) {
    return { ok: false, reason: thrownFailure(error) };
  }
}

/**
 * Creates an event under `id`, with why it was not created in words. A
 * caller that may try again keeps the id, so a retry never makes a second one.
 */
export async function createEvent(id: string, fields: EventFields): Promise<CreateOutcome> {
  const outcome = await postEvent(id, fields);
  return outcome.ok
    ? { ok: true, id }
    : {
        ok: false,
        reason: outcome.reason === "limit" ? EVENT_LIMIT_REACHED : failureWords(outcome.reason),
      };
}

/** Saves some of an event's fields against `revision`; the saved event carries its new revision. */
export function saveEvent(
  id: string,
  patch: Partial<EventFields>,
  revision: number,
): Promise<SaveResult<StoredEvent>> {
  return saving(
    (init) => api.events[":id"].$patch({ param: { id }, json: { ...patch, revision } }, { init }),
    async (response) => storedEventSchema.parse(await response.json()),
  );
}

/** Deletes an event; false when the server did not (already gone counts as deleted). */
export function deleteEvent(id: string): Promise<boolean> {
  return removing((init) => api.events[":id"].$delete({ param: { id } }, init));
}

/** After any change to an event: the list reloads in the background. */
export function refreshEvents(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: EVENTS_KEY, exact: true });
}
