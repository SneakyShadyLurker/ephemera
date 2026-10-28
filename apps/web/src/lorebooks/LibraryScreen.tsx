import type { EmbeddedLorebook } from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { HeaderAction } from "@/app/Browse.tsx";
import { useFormFactor } from "@/app/form-factor.ts";
import { importProgress, JSON_FILE_TYPES } from "@/app/importing";
import { KeptScroll } from "@/app/KeptScroll.tsx";
import { SCROLL_GUTTERS, ScreenHeader } from "@/app/Screen.tsx";
import { DropOverlay, useFileDrop } from "@/components/file-drop";
import { ImportIcon, LorebookIcon, PlusIcon } from "@/components/icons";
import { ImportReportLine } from "@/components/import-report";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/cn";
import { characterQuery, charactersQuery } from "../characters/queries.ts";
import { EventsSection } from "../events/EventsSection.tsx";
import { type Attempt, creations } from "../sheet/creation.ts";
import type { CreateOutcome } from "../sheet/saving.ts";
import { notReached } from "../signin/signin.ts";
import { BookRow, EmbeddedRow } from "./BookRow.tsx";
import { copiedName, libraryRows, type BookRow as Row } from "./library.ts";
import { bookArrivals, setFind, setOpened, takeNotice, useLibrary } from "./library-state.ts";
import {
  createLorebook,
  deleteLorebook,
  duplicateLorebook,
  libraryQuery,
  lorebookImports,
  lorebookQuery,
  type NewLorebook,
  refreshLibrary,
} from "./queries.ts";

/*
 * The library: the owner's lorebooks by name, each with how its entries go
 * in and who it is linked to, then the books saved in character cards. New,
 * Import (by picker or drop), one Find over book and character names, and
 * each row's own actions beside it. Book data and names, never chat content.
 */

/** The list's frame, which the header shares (as on Presets). */
const FRAME = "mx-auto w-full max-w-wide px-5 tablet:px-8";

const NEW_NAME = "New lorebook";

const EMPTY_TEXT =
  "Background and events for your characters. An entry can apply always, on keywords or by chance.";

export function LibraryScreen() {
  const phone = useFormFactor() === "phone";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const library = useQuery(libraryQuery);
  const characters = useQuery(charactersQuery);
  const find = useLibrary((state) => state.find);
  const _findId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const findField = useRef<HTMLInputElement>(null);
  // What was just done, said once; a delete in the editor leaves its words for here.
  const [notice, setNotice] = useState(takeNotice);
  const [failure, setFailure] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // New and each card's copy: one id and book per intent until the server acknowledges it.
  const [creates] = useState(() => creations<NewLorebook>());
  const reports = lorebookImports.use((state) => state.report);
  const importing = lorebookImports.use((state) => state.importing);
  // New rows carry "Imported" until the next visit; kept in memory only.
  const [arrived, setArrived] = useState<string[]>([]);

  const done = (text: string) => {
    setFailure(null);
    setNotice(text);
  };
  const failed = (text: string) => {
    setNotice(null);
    setFailure(text);
  };

  const importFiles = (files: File[]) =>
    void lorebookImports.add(files, async (outcome) => {
      setArrived((ids) => [...ids, outcome.id]);
      await refreshLibrary(queryClient);
    });
  const { dragging, dropTarget } = useFileDrop(importFiles);

  /**
   * After the server acknowledged a new book: the list reloads and the book
   * opens. Awaited inside the creation, so New and Copy stay held until the
   * route has changed; a failure here leaves the book made and listed, and
   * never makes it again.
   */
  const openCreated = async (arrival: Parameters<typeof bookArrivals.arriveAt>[0]) => {
    try {
      await refreshLibrary(queryClient);
      setOpened(null);
      bookArrivals.arriveAt(arrival);
      await navigate({ to: "/lorebooks/$id", params: { id: arrival.id } });
    } catch {
      // The book is in the list; it opens from its row.
    }
  };

  const create = async () => {
    // Another New on its way answers undefined: it opens its book.
    const outcome = await creates.run("new", async ({ take }) => {
      setCreating(true);
      const make = async () => {
        const { id, payload } = take({ name: NEW_NAME });
        const created = await createLorebook(id, payload.name, payload.book);
        // A new book opens with its name selected, ready to be named.
        if (created.ok) await openCreated({ id: created.id, selectName: true });
        return created;
      };
      return make().finally(() => setCreating(false));
    });
    if (outcome?.ok === false) failed(`Not created: ${outcome.reason}.`);
  };

  const duplicate = async (row: Row) => {
    const copy = await duplicateLorebook(row.book.id);
    if (!copy.ok) return failed(`Not duplicated: ${copy.reason}.`);
    await refreshLibrary(queryClient);
    done(`Duplicated ${row.book.name}. The copy has no links.`);
  };

  const remove = async (row: Row, next: string | undefined) => {
    if (!(await deleteLorebook(row.book.id))) return failed(`Not deleted: ${notReached()}.`);
    queryClient.removeQueries({ queryKey: lorebookQuery(row.book.id).queryKey });
    await refreshLibrary(queryClient);
    done(`Deleted ${row.book.name}.`);
    // Focus goes to the row that took its place, else to Find.
    const target =
      next === undefined ? null : document.querySelector<HTMLElement>(`[data-book="${next}"] a`);
    (target ?? findField.current)?.focus();
  };

  const copy = async (book: EmbeddedLorebook) => {
    // A copy of this book on its way answers undefined: it opens the copy.
    const outcome = await creates.run(`copy:${book.characterId}`, async (attempt) => {
      setCopying(book.characterId);
      setFailure(null);
      const make = async () => {
        const created = await copyToLibrary(book, attempt);
        if (created.ok)
          await openCreated({
            id: created.id,
            notice: "Copied to library. The original stays in the character's card.",
          });
        return created;
      };
      return make().finally(() => setCopying((now) => (now === book.characterId ? null : now)));
    });
    if (outcome?.ok === false) failed(`Not copied: ${outcome.reason}.`);
  };

  /**
   * A card's book as a new library book of its own, linked to no one. A retry
   * sends the book read by the first attempt, under its id, without reading
   * the card again.
   */
  const copyToLibrary = async (
    book: EmbeddedLorebook,
    { held, take }: Attempt<NewLorebook>,
  ): Promise<CreateOutcome> => {
    let creation = held;
    if (creation === undefined) {
      const character = await queryClient
        .fetchQuery(characterQuery(book.characterId))
        .catch(() => null);
      if (character === null) return { ok: false, reason: notReached() };
      const embedded = character.card.lorebook;
      if (embedded === undefined) return { ok: false, reason: "the card has no lorebook any more" };
      creation = take({ name: copiedName(book.name), book: embedded });
    }
    return createLorebook(creation.id, creation.payload.name, creation.payload.book);
  };

  const portraits = new Map(
    (characters.data ?? []).map((character) => [character.id, character.portrait]),
  );
  const rows =
    library.data === undefined ? null : libraryRows(library.data, characters.data ?? [], find);
  const empty = library.data !== undefined && library.data.lorebooks.length === 0;
  const anything =
    library.data !== undefined &&
    (library.data.lorebooks.length > 0 || library.data.embedded.length > 0);
  const finding = find.trim() !== "";
  const noMatch = rows !== null && finding && rows.books.length === 0 && rows.embedded.length === 0;

  const actions = {
    import: () => picker.current?.click(),
    create: () => void create(),
  };

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col [timeline-scope:--thread]"
      {...dropTarget}
    >
      <input
        ref={picker}
        type="file"
        accept={JSON_FILE_TYPES}
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          importFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
      <ScreenHeader title="Lorebooks" frame={FRAME} gutters={SCROLL_GUTTERS}>
        <HeaderAction
          label="Import lorebook"
          text="Import"
          icon={ImportIcon}
          onClick={actions.import}
        />
        <HeaderAction
          label="New lorebook"
          icon={PlusIcon}
          variant={phone ? undefined : "outline"}
          disabled={creating}
          focusableWhenDisabled
          onClick={actions.create}
        />
      </ScreenHeader>
      <div
        data-skip-target=""
        tabIndex={-1}
        aria-busy={library.isPending || undefined}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
        )}
      >
        <KeptScroll id="lorebooks" ready={rows !== null && !library.isError} />
        <div className={cn(FRAME, "grid gap-8 pt-5 pb-12")}>
          {/* One line for what was just done; failures are said apart, in Ember. */}
          <p role="status" className="text-note text-reed empty:hidden">
            {importing !== null
              ? importProgress(importing)
              : copying !== null
                ? "Copying to library…"
                : notice}
          </p>
          {failure !== null && (
            <p role="alert" className="text-pretty text-ember text-note">
              {failure}
            </p>
          )}
          {reports.map((report) => (
            <ImportReportLine
              key={report.key}
              outcome={report}
              summary={
                report.ok ? `Imported ${report.name}. It is linked to no character yet.` : ""
              }
              onDismiss={() => lorebookImports.dismiss(report)}
            />
          ))}

          {/* Events are the owner's whatever the library holds: first, one row, and Find leaves them be. */}
          <EventsSection />

          {library.isError ? (
            <div role="alert" className="grid justify-items-start gap-2">
              <p className="text-ember text-note">The lorebooks could not be loaded.</p>
              <Button variant="outline" onClick={() => void library.refetch()}>
                Try again
              </Button>
            </div>
          ) : rows === null ? null : (
            <>
              {anything && (
                <div className="max-w-help">
                  <SearchField
                    ref={findField}
                    label="Find lorebooks and characters"
                    value={find}
                    placeholder="Find by book or character name"
                    onChange={(event) => setFind(event.target.value)}
                  />
                </div>
              )}
              {noMatch ? (
                <div className="grid justify-items-start gap-2 border-rush border-t pt-5">
                  <p className="text-reed text-ui">No lorebook or character matches.</p>
                  <Button variant="outline" onClick={() => setFind("")}>
                    Clear find
                  </Button>
                </div>
              ) : empty ? (
                <EmptyLibrary
                  creating={creating}
                  onImport={actions.import}
                  onCreate={actions.create}
                />
              ) : (
                rows.books.length > 0 && (
                  <ul aria-label="Lorebooks" className="grid border-rush border-t">
                    {rows.books.map((row, at) => (
                      <BookRow
                        onError={failed}
                        key={row.book.id}
                        row={row}
                        arrived={arrived.includes(row.book.id)}
                        onDuplicate={() => void duplicate(row)}
                        onDelete={() =>
                          void remove(row, (rows.books[at + 1] ?? rows.books[at - 1])?.book.id)
                        }
                      />
                    ))}
                  </ul>
                )
              )}
            </>
          )}
          {rows !== null && !noMatch && rows.embedded.length > 0 && (
            <section aria-labelledby="in-cards" className="grid gap-3">
              <div className="grid gap-1">
                <h2 id="in-cards" className="font-semibold text-ink text-lead">
                  In character cards
                </h2>
                <p className="max-w-help text-pretty text-note text-reed">
                  Saved inside a card and read only with its character. Copy one to the library to
                  link it to others.
                </p>
              </div>
              <ul aria-label="Lorebooks in character cards" className="grid border-rush border-t">
                {rows.embedded.map((book) => (
                  <EmbeddedRow
                    key={book.characterId}
                    book={book}
                    portrait={portraits.get(book.characterId) ?? null}
                    copying={copying === book.characterId}
                    onCopy={() => void copy(book)}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      {dragging && (
        <DropOverlay
          title="Drop lorebooks to import"
          hint="An Ephemera lorebook or SillyTavern World Info file, as JSON"
        />
      )}
    </main>
  );
}

/** No library book yet: what a lorebook is for and the two ways to start one. */
function EmptyLibrary({
  creating,
  onImport,
  onCreate,
}: {
  /** A new book is on its way: New waits for it. */
  creating: boolean;
  onImport: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="grid justify-items-start gap-3 border-rush border-t pt-8">
      <LorebookIcon size={24} className="text-reed" />
      <p className="max-w-empty text-pretty text-lead text-narration">{EMPTY_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={creating} focusableWhenDisabled onClick={onCreate}>
          <PlusIcon size={16} />
          New lorebook
        </Button>
        <Button onClick={onImport}>
          <ImportIcon size={16} />
          Import lorebook
        </Button>
      </div>
    </div>
  );
}
