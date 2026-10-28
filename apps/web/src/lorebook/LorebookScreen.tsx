import { type CharacterCard, lorebookSchema } from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { countOf } from "@/lib/text";
import { isNotFound } from "../api.ts";
import {
  characterQuery,
  type SavedCharacter,
  saveCharacter,
  updateCachedCharacter,
} from "../characters/queries.ts";
import { refreshLibrary } from "../lorebooks/queries.ts";
import { useReload } from "../sheet/ConflictNotice.tsx";
import { SheetActions } from "../sheet/SheetActions.tsx";
import { SheetLoading, SheetMissing, useSheetState } from "../sheet/SheetFrame.tsx";
import {
  type BookContext,
  type BookFields,
  type BookSource,
  LorebookEditor,
} from "./LorebookEditor.tsx";

/*
 * A character's lorebook, the one in its card: the shared editor with the
 * card as its source. The whole book is saved into the card through the one
 * character patch.
 */

/** What this screen saves: the book alone; the name only types the autosave. */
const fieldsSchema: z.ZodType<BookFields> = z.strictObject({
  name: z.string(),
  book: lorebookSchema.nullable(),
});

export function LorebookScreen({
  id,
  entry,
  onEntry,
}: {
  id: string;
  entry: number | undefined;
  onEntry: (entry: number | undefined, push: boolean) => void;
}) {
  const query = useQuery({ ...characterQuery(id), refetchOnMount: "always" });
  const [round, reload] = useReload(() => query.refetch());
  const state = useSheetState(id, query);
  if (state === "error") {
    return (
      <SheetMissing
        back={{ to: "/characters", label: "Characters" }}
        noun="character"
        notFound={isNotFound(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (state === "loading" || query.data === undefined) return <SheetLoading />;
  return (
    <CardLorebook
      key={`${id}:${round}`}
      id={id}
      card={query.data.card}
      revision={query.data.revision}
      onReload={reload}
      entry={entry}
      onEntry={onEntry}
    />
  );
}

function CardLorebook({
  id,
  card,
  revision,
  onReload,
  entry,
  onEntry,
}: {
  id: string;
  card: CharacterCard;
  /** The loaded character's revision; the sheet and this screen edit the same one. */
  revision: number;
  onReload: () => Promise<void>;
  entry: number | undefined;
  onEntry: (entry: number | undefined, push: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const source: BookSource<SavedCharacter> = {
    id,
    revision,
    name: card.name,
    book: card.lorebook ?? null,
    noun: "character",
    title: () => "Lorebook",
    back: { to: "/characters/$id", id, label: card.name },
    band: { kind: "character", id, name: card.name },
    empty: `Background the model reads when its keywords come up in the chat, placed before or after ${card.name}'s definition.`,
    save: {
      schema: fieldsSchema,
      labels: { name: "Name", book: "The lorebook" },
      wholeLabel: "The card",
      save: (saveId, patch, saveRevision) =>
        saveCharacter(
          saveId,
          patch.book === undefined ? {} : { lorebook: patch.book },
          saveRevision,
        ),
      onSaved: (saved, character) => {
        updateCachedCharacter(queryClient, saved, character);
        // The library lists the books in cards with their counts.
        void refreshLibrary(queryClient);
      },
    },
    onReload,
    onRemoved: () => void navigate({ to: "/characters/$id", params: { id } }),
    actions: (context) => <RemoveBook name={card.name} context={context} />,
  };
  return <LorebookEditor source={source} entry={entry} onEntry={onEntry} />;
}

/** The card's book can be removed from it, behind a confirmation, on the shared sheet actions. */
function RemoveBook({ name, context }: { name: string; context: BookContext }) {
  if (!context.exists) return null;
  const entries =
    context.entries === 1
      ? "Its one entry is"
      : `All ${countOf(context.entries, "entry", "entries")} are`;
  return (
    <SheetActions
      name={context.name}
      label="Lorebook actions"
      // Removing is an edit of the card, saved by the editor, which says how that went.
      onError={() => {}}
      deleteLabel="Remove lorebook"
      deleteTitle="Remove the lorebook?"
      deleteDescription={`${entries} removed from ${name}'s card. Export the card first to keep a copy.`}
      onDelete={async () => {
        context.removeBook();
        return true;
      }}
    />
  );
}
