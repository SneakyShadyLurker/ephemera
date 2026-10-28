import {
  type ImportResponse,
  importResponseSchema,
  type Library,
  type Lorebook,
  libraryResponseSchema,
  type StoredLorebook,
  storedLorebookSchema,
} from "@ephemera/core";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { createImportQueue, type FileImport, importFile } from "@/app/importing";
import { api, entityError, entityHref, entityRetry } from "../api.ts";
import {
  type CreateOutcome,
  createOutcome,
  creating,
  duplicating,
  removing,
  type SaveResult,
  saving,
  unsafeOptions,
} from "../sheet/saving.ts";
import { withLink } from "./library.ts";

/*
 * Server data for library lorebooks: the library (books, the books in cards
 * and every character's links) and one book, in memory only like every
 * query. Book text is untrusted and always rendered as text.
 */

/** The library's query key; each book's key extends it. */
export const LIBRARY_KEY = ["lorebooks"] as const;

export const libraryQuery = queryOptions({
  queryKey: LIBRARY_KEY,
  queryFn: async ({ signal }): Promise<Library> => {
    const response = await api.lorebooks.$get(undefined, { init: { signal } });
    if (!response.ok) throw new Error("unavailable");
    return libraryResponseSchema.parse(await response.json());
  },
});

export const lorebookQuery = (id: string) =>
  queryOptions({
    queryKey: [...LIBRARY_KEY, id],
    // A missing book is final; only other failures are worth a retry.
    retry: entityRetry,
    queryFn: async ({ signal }): Promise<StoredLorebook> => {
      const response = await api.lorebooks[":id"].$get({ param: { id } }, { init: { signal } });
      if (!response.ok) throw entityError(response.status);
      // Validated at the boundary; core owns the native response schema.
      return storedLorebookSchema.parse(await response.json());
    },
  });

/** A download link's address for one native lorebook JSON file. */
export function lorebookExportUrl(id: string): string {
  return entityHref(api.lorebooks[":id"].export, id);
}

/** What a new library book is made of: its name and, for a copy, the book itself. */
export interface NewLorebook {
  name: string;
  book?: Lorebook;
}

/**
 * Creates a book under a client-chosen id, so a retry after a lost response
 * that passes the same id (sheet/creation.ts) is harmless.
 */
export async function createLorebook(
  id: string,
  name: string,
  book?: Lorebook,
): Promise<CreateOutcome> {
  const result = await creating((init) =>
    api.lorebooks.$post({ json: { id, name, ...(book === undefined ? {} : { book }) } }, { init }),
  );
  // Invalid or too large is final for this book: a retry sends it read afresh.
  return createOutcome(id, result);
}

/** Saves the name, the whole book or both against `revision`; the saved book carries its new revision. */
export function saveLorebook(
  id: string,
  patch: { name?: string; book?: Lorebook },
  revision: number,
): Promise<SaveResult<StoredLorebook>> {
  return saving(
    (init) =>
      api.lorebooks[":id"].$patch({ param: { id }, json: { ...patch, revision } }, { init }),
    async (response) => storedLorebookSchema.parse(await response.json()),
  );
}

/** Duplicates a book without its links. */
export function duplicateLorebook(id: string): Promise<CreateOutcome> {
  return duplicating((options) => api.lorebooks[":id"].duplicate.$post({ param: { id } }, options));
}

/** Deletes a book and its links; false when the server did not (already gone counts as deleted). */
export function deleteLorebook(id: string): Promise<boolean> {
  return removing((init) => api.lorebooks[":id"].$delete({ param: { id } }, init));
}

/** A link's outcome: made or undone, refused at the limit, one side gone, or not reached. */
type LinkOutcome = "done" | "full" | "gone" | "failed";

/** Links or unlinks a book and a character; linking an existing link, or unlinking a missing one, is done. */
export async function setLink(
  lorebookId: string,
  characterId: string,
  linked: boolean,
): Promise<LinkOutcome> {
  const route = api.lorebooks[":id"].characters[":characterId"];
  const param = { param: { id: lorebookId, characterId } };
  try {
    const response = linked
      ? await route.$put(param, unsafeOptions())
      : await route.$delete(param, unsafeOptions());
    if (response.ok) return "done";
    if (response.status === 409) return "full";
    // Unlinking what is not linked leaves what was asked for.
    if (response.status === 404) return linked ? "gone" : "done";
    return "failed";
  } catch {
    return "failed";
  }
}

/** The cached library with one link made or undone, at once, before the server's list comes back. */
export function updateCachedLink(
  queryClient: QueryClient,
  lorebookId: string,
  characterId: string,
  linked: boolean,
): void {
  queryClient.setQueryData<Library>(libraryQuery.queryKey, (library) =>
    library === undefined
      ? library
      : { ...library, links: withLink(library.links, characterId, lorebookId, linked) },
  );
}

/**
 * After any change to a book or a link: the library and that book reload in
 * the background. The chat's preview reads a character's linked books on the
 * server, from its store, so nothing cached for it changes; the card's own
 * book is the character's cache (characters/queries.ts).
 */
export function refreshLibrary(queryClient: QueryClient, id?: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: libraryQuery.queryKey, exact: true }),
    id === undefined
      ? undefined
      : queryClient.invalidateQueries({ queryKey: lorebookQuery(id).queryKey }),
  ]).then(() => undefined);
}

/** One file's import: the book made and what changed on the way, or why it was refused. */
export type LorebookImport = FileImport<ImportResponse>;

/** Every refusal the import route can answer in words, so a new one fails the typecheck here. */
type ImportRefusal = InferResponseType<typeof api.lorebooks.import.$post, 422>["error"];

const IMPORT_REASONS: Record<ImportRefusal, string> = {
  not_json: "it isn't valid JSON",
  not_a_lorebook: "it isn't an Ephemera lorebook or a SillyTavern World Info file",
  field_too_long: "an entry is longer than Ephemera allows",
  invalid: "it isn't a lorebook Ephemera can read",
};

/** Imports one World Info or lorebook file; never throws, so a batch reports every file. */
export function importLorebook(file: File): Promise<LorebookImport> {
  return importFile(
    file,
    (init) => api.lorebooks.import.$post({ form: { file } }, { init }),
    IMPORT_REASONS,
    (body) => importResponseSchema.safeParse(body).data,
  );
}

/** The library's imports, one file at a time. */
export const lorebookImports = createImportQueue(importLorebook);
