import { lorebookFieldsSchema, type StoredLorebook } from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { forgetScroll } from "@/app/KeptScroll.tsx";
import { isNotFound } from "../api.ts";
import { charactersQuery } from "../characters/queries.ts";
import {
  type BookContext,
  type BookFields,
  type BookSource,
  LorebookEditor,
} from "../lorebook/LorebookEditor.tsx";
import { useReload } from "../sheet/ConflictNotice.tsx";
import { SheetActions } from "../sheet/SheetActions.tsx";
import { SheetLoading, SheetMissing, useSheetState } from "../sheet/SheetFrame.tsx";
import { BookHead } from "./BookHead.tsx";
import { deleteText, linkedCharacters } from "./library.ts";
import { bookArrivals, setNotice, setOpened } from "./library-state.ts";
import {
  deleteLorebook,
  duplicateLorebook,
  libraryQuery,
  lorebookQuery,
  refreshLibrary,
  saveLorebook,
} from "./queries.ts";

/*
 * A library lorebook: the shared editor with the library as its source,
 * under the book's own name, description and linked characters. Book data,
 * never chat content.
 */

/** What this screen saves: the book's name and the whole book, as the API validates them. */
const fieldsSchema: z.ZodType<BookFields> = z.strictObject({
  name: lorebookFieldsSchema.shape.name,
  book: lorebookFieldsSchema.shape.book,
});

export function BookScreen({
  id,
  entry,
  onEntry,
}: {
  id: string;
  entry: number | undefined;
  onEntry: (entry: number | undefined, push: boolean) => void;
}) {
  const query = useQuery({ ...lorebookQuery(id), refetchOnMount: "always" });
  const [round, reload] = useReload(() => query.refetch());
  const state = useSheetState(id, query);
  if (state === "error") {
    return (
      <SheetMissing
        back={{ to: "/lorebooks", label: "Lorebooks" }}
        noun="lorebook"
        notFound={isNotFound(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (state === "loading" || query.data === undefined) return <SheetLoading />;
  return (
    <LibraryBook
      key={`${id}:${round}`}
      stored={query.data}
      onReload={reload}
      entry={entry}
      onEntry={onEntry}
    />
  );
}

function LibraryBook({
  stored,
  onReload,
  entry,
  onEntry,
}: {
  stored: StoredLorebook;
  onReload: () => Promise<void>;
  entry: number | undefined;
  onEntry: (entry: number | undefined, push: boolean) => void;
}) {
  const queryClient = useQueryClient();
  // What brought the owner here (a copy, a duplicate, a new book), taken once.
  const [arrival] = useState(() => bookArrivals.take(stored.id));
  const [notice, setBookNotice] = useState<{ text: string; failed: boolean } | null>(
    arrival.notice === undefined ? null : { text: arrival.notice, failed: false },
  );
  const source: BookSource<StoredLorebook> = {
    id: stored.id,
    revision: stored.revision,
    name: stored.name,
    book: stored.book,
    noun: "lorebook",
    title: (name) => name.trim() || "Lorebook",
    back: { to: "/lorebooks", label: "Lorebooks" },
    band: { kind: "definition" },
    empty:
      "Background and events the model reads with the characters this book is linked to. An entry can apply always, on keywords or by chance.",
    save: {
      schema: fieldsSchema,
      labels: { name: "The name", book: "The lorebook" },
      wholeLabel: "The lorebook",
      save: (saveId, patch, revision) =>
        saveLorebook(
          saveId,
          {
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.book === undefined || patch.book === null ? {} : { book: patch.book }),
          },
          revision,
        ),
      onSaved: (saveId, saved) => {
        queryClient.setQueryData(lorebookQuery(saveId).queryKey, saved);
        void refreshLibrary(queryClient);
      },
    },
    onReload,
    head: (context) => (
      <BookHead
        id={stored.id}
        context={context}
        selectName={arrival.selectName === true}
        notice={notice}
        onDismiss={() => setBookNotice(null)}
      />
    ),
    actions: (context) => (
      <BookActions
        id={stored.id}
        context={context}
        onError={(text) => setBookNotice({ text, failed: true })}
      />
    ),
  };
  return <LorebookEditor source={source} entry={entry} onEntry={onEntry} />;
}

/** Duplicate, Export as JSON and Delete, with the characters that lose the book named. */
function BookActions({
  id,
  context,
  onError,
}: {
  id: string;
  context: BookContext;
  onError: (text: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const library = useQuery(libraryQuery);
  const characters = useQuery(charactersQuery);
  const name = context.name.trim() || "this lorebook";
  const losing = linkedCharacters(library.data?.links ?? [], id, characters.data ?? []).map(
    (character) => character.name,
  );

  const duplicate = {
    copy: () => duplicateLorebook(id),
    open: async (copy: string) => {
      await refreshLibrary(queryClient);
      setOpened(null);
      bookArrivals.arriveAt({ id: copy, notice: "Duplicated. The copy has no links." });
      void navigate({ to: "/lorebooks/$id", params: { id: copy } });
    },
  };

  const remove = async () => {
    if (!(await deleteLorebook(id))) return false;
    context.discard();
    queryClient.removeQueries({ queryKey: lorebookQuery(id).queryKey });
    await refreshLibrary(queryClient);
    setOpened(null);
    setNotice(`Deleted ${name}.`);
    forgetScroll("lorebooks");
    void navigate({ to: "/lorebooks" });
    return true;
  };

  return (
    <SheetActions
      name={context.name}
      label="Lorebook actions"
      flush={context.flush}
      onError={onError}
      duplicate={duplicate}
      exports={[{ label: "Export as JSON", file: { kind: "lorebook", id } }]}
      deleteTitle={`Delete ${name}?`}
      deleteDescription={deleteText(losing)}
      onDelete={remove}
    />
  );
}
