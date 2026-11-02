import {
  type CharacterPatch,
  type CharacterSummary,
  charactersResponseSchema,
  type ImportResponse,
  importResponseSchema,
  type SheetFields,
  type StoredCharacter,
  savedCharacterResponseSchema,
  storedCharacterSchema,
} from "@ephemera/core";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { type FileImport, importFile } from "@/app/importing";
import { api, entityError, entityHref, entityRetry } from "../api.ts";
import { CAST_SHEET_KEY } from "../cast/queries.ts";
import { LIBRARY_KEY } from "../lorebooks/queries.ts";
import {
  type CreateOutcome,
  type CreateResult,
  creating,
  duplicating,
  removing,
  type SaveResult,
  saving,
} from "../sheet/saving.ts";

/*
 * Server data for characters. Character cards are not chat content, so they
 * may sit in the query cache; the cache itself lives in memory only.
 */

export const charactersQuery = queryOptions({
  queryKey: ["characters"],
  queryFn: async ({ signal }): Promise<CharacterSummary[]> => {
    const response = await api.characters.$get(undefined, { init: { signal } });
    if (!response.ok) throw new Error("unavailable");
    return charactersResponseSchema.parse(await response.json()).characters;
  },
});

export const characterQuery = (id: string) =>
  queryOptions({
    queryKey: ["characters", id],
    // A missing character is final; only other failures are worth a retry.
    retry: entityRetry,
    queryFn: async ({ signal }): Promise<StoredCharacter> => {
      const response = await api.characters[":id"].$get({ param: { id } }, { init: { signal } });
      if (!response.ok) throw entityError(response.status);
      // Validated at the boundary; core owns the native response schema.
      return storedCharacterSchema.parse(await response.json());
    },
  });

/** A download link's address for one card file. */
export function exportUrl(id: string, format: "png" | "json"): string {
  const routes = api.characters[":id"];
  return entityHref(format === "png" ? routes["export.png"] : routes["export.json"], id);
}

/** Creates a character under a client-chosen id, so a retry after a lost response is harmless. */
export function createCharacter(id: string, fields: SheetFields): Promise<CreateResult> {
  return creating((init) => api.characters.$post({ json: { id, fields } }, { init }));
}

/** What a saved edit answers: the whole card and its new revision. */
export type SavedCharacter = Pick<StoredCharacter, "card" | "revision">;

/** Saves edited fields against `revision`; the reason tells the sheet what to say. */
export function saveCharacter(
  id: string,
  patch: CharacterPatch,
  revision: number,
): Promise<SaveResult<SavedCharacter>> {
  return saving(
    (init) =>
      api.characters[":id"].$patch({ param: { id }, json: { ...patch, revision } }, { init }),
    async (response) => savedCharacterResponseSchema.parse(await response.json()),
  );
}

/**
 * Keeps the cached sheet in step with what was saved (its card and revision),
 * so returning to it, or opening its lorebook, never starts from older text or
 * an older revision.
 */
export function updateCachedCharacter(
  queryClient: QueryClient,
  id: string,
  change: Partial<Pick<StoredCharacter, "card" | "portrait" | "revision">>,
): void {
  queryClient.setQueryData(characterQuery(id).queryKey, (current) =>
    current === undefined ? current : { ...current, ...change },
  );
  // A saved card may no longer match its cast sheet's fingerprint: the sheet asks again.
  if (change.card !== undefined)
    void queryClient.invalidateQueries({ queryKey: CAST_SHEET_KEY(id) });
}

/**
 * Duplicates the character: the copy's id, or why there is none (too large
 * when the copy's name would take a card at the size limit past it).
 */
export function duplicateCharacter(id: string): Promise<CreateOutcome> {
  return duplicating((options) =>
    api.characters[":id"].duplicate.$post({ param: { id } }, options),
  );
}

/** Deletes the character; false when the server did not (already gone counts as deleted). */
export function deleteCharacter(id: string): Promise<boolean> {
  return removing((init) => api.characters[":id"].$delete({ param: { id } }, init));
}

/** One file's native import report, what was fitted to the limits included. */
export type ImportOutcome = FileImport<ImportResponse>;

/** Every refusal the import route can answer in words, so a new one fails the typecheck here. */
type ImportRefusal = InferResponseType<typeof api.characters.import.$post, 422>["error"];

const IMPORT_REASONS: Record<ImportRefusal, string> = {
  not_json: "it is not a character card",
  not_a_card: "it is not a character card",
  no_name: "the card has no name",
  field_too_long: "a field is over the size limit",
  unsupported_image: "its image is not PNG, JPEG or WebP",
  invalid_image: "its image could not be read",
  invalid: "the card is not valid",
};

/** Imports one card file; never throws, so a batch reports every file. */
export function importCard(file: File): Promise<ImportOutcome> {
  return importFile(
    file,
    (init) => api.characters.import.$post({ form: { file } }, { init }),
    IMPORT_REASONS,
    (body) => importResponseSchema.safeParse(body).data,
  );
}

/** After any change: the list, the lorebook library and that character reload in the background. */
export function refreshCharacters(queryClient: QueryClient, id?: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: charactersQuery.queryKey, exact: true }),
    // The lorebook library lists characters' links and card books (lorebooks/queries.ts).
    queryClient.invalidateQueries({ queryKey: LIBRARY_KEY, exact: true }),
    id === undefined
      ? undefined
      : queryClient.invalidateQueries({ queryKey: characterQuery(id).queryKey }),
    // The card may have changed (Rework apply, the creator's Keep): its cast sheet asks again.
    id === undefined ? undefined : queryClient.invalidateQueries({ queryKey: CAST_SHEET_KEY(id) }),
  ]).then(() => undefined);
}
