import {
  type PersonaFields,
  type PersonaPatch,
  type PersonaSummary,
  personasResponseSchema,
  type StoredPersona,
  storedPersonaSchema,
} from "@ephemera/core";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { api, entityError, entityRetry } from "../api.ts";
import {
  type CreateOutcome,
  type CreateResult,
  creating,
  duplicating,
  removing,
  SAVE_TIMEOUT_MS,
  type SaveResult,
  saving,
} from "../sheet/saving.ts";

/*
 * Server data for personas. Personas are not chat content, so they may sit in
 * the query cache, which lives in memory only. Persona text is untrusted and
 * always rendered as text (PRINCIPLES.md 3).
 */

export const personasQuery = queryOptions({
  queryKey: ["personas"],
  queryFn: async ({ signal }): Promise<PersonaSummary[]> => {
    const response = await api.personas.$get(undefined, { init: { signal } });
    if (!response.ok) throw new Error("unavailable");
    return personasResponseSchema.parse(await response.json()).personas;
  },
});

export const personaQuery = (id: string) =>
  queryOptions({
    queryKey: ["personas", id],
    // A missing persona is final; only other failures are worth a retry.
    retry: entityRetry,
    queryFn: async ({ signal }): Promise<StoredPersona> => {
      const response = await api.personas[":id"].$get({ param: { id } }, { init: { signal } });
      if (!response.ok) throw entityError(response.status);
      return storedPersonaSchema.parse(await response.json());
    },
  });

/** The persona a character goes with, from the list; null without one. */
export function boundPersona(personas: PersonaSummary[] | undefined, characterId: string | null) {
  if (characterId === null) return null;
  return personas?.find((persona) => persona.characterIds.includes(characterId))?.id ?? null;
}

/** Creates a persona under a client-chosen id, so a retry after a lost response is harmless. */
export function createPersona(id: string, fields: PersonaFields): Promise<CreateResult> {
  return creating((init) => api.personas.$post({ json: { id, fields } }, { init }));
}

/** Saves edited fields against `revision`; the saved persona carries its new revision. */
export function savePersona(
  id: string,
  patch: PersonaPatch,
  revision: number,
): Promise<SaveResult<StoredPersona>> {
  return saving(
    (init) => api.personas[":id"].$patch({ param: { id }, json: { ...patch, revision } }, { init }),
    async (response) => storedPersonaSchema.parse(await response.json()),
  );
}

/** Duplicates the persona: the copy's id, or why there is none. */
export function duplicatePersona(id: string): Promise<CreateOutcome> {
  return duplicating((options) => api.personas[":id"].duplicate.$post({ param: { id } }, options));
}

/** Deletes the persona; false when the server did not (already gone counts as deleted). */
export function deletePersona(id: string): Promise<boolean> {
  return removing((init) => api.personas[":id"].$delete({ param: { id } }, init));
}

/** Which persona a character goes with (null: none); false when the server did not change it. */
export async function bindCharacter(
  characterId: string,
  personaId: string | null,
): Promise<boolean> {
  try {
    const response = await api.personas.bindings[":characterId"].$put(
      { param: { characterId }, json: { personaId } },
      { init: { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) } },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** After any change: the list and that persona reload in the background. */
export function refreshPersonas(queryClient: QueryClient, id?: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: personasQuery.queryKey, exact: true }),
    id === undefined
      ? undefined
      : queryClient.invalidateQueries({ queryKey: personaQuery(id).queryKey }),
  ]).then(() => undefined);
}
