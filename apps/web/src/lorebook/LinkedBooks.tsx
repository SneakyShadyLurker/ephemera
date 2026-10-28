import { LOREBOOK_LINKS } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ChoicePicker } from "@/app/ChoicePicker.tsx";
import { LorebookIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { byName } from "@/lib/find";
import { booksOf, LINKS_FULL_TEXT, linksFull } from "../lorebooks/library.ts";
import { createLorebook, libraryQuery, type NewLorebook } from "../lorebooks/queries.ts";
import { useLinks } from "../lorebooks/useLinks.ts";
import { creations } from "../sheet/creation.ts";
import { entriesText } from "./marks.tsx";

const HELP = "text-pretty text-note text-reed";

const NEW_NAME = "New lorebook";

/**
 * The character sheet's library books: the ones linked to this character,
 * in the order they are read, each to open or unlink, and a picker of the
 * library's books with New lorebook. Off for a character not saved yet and
 * while an AI Rework holds the sheet, as the card's own book is.
 */
export function LinkedBooks({
  id,
  name,
  locked,
}: {
  id: string | null;
  name: string;
  locked: boolean;
}) {
  const library = useQuery({ ...libraryQuery, enabled: id !== null });
  const links = useLinks();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // The character whose New lorebook is on its way.
  const [creatingFor, setCreating] = useState<string | null>(null);
  const creating = id !== null && creatingFor === id;
  const [createFailed, setCreateFailed] = useState<string | null>(null);
  // New lorebook: one id and name per character until made and linked.
  const [creates] = useState(() => creations<NewLorebook>());
  const list = useRef<HTMLDivElement>(null);
  const off = id === null || locked || library.data === undefined;
  const allLinks = library.data?.links ?? [];
  const books = library.data?.lorebooks ?? [];
  const linkedIds = id === null ? [] : booksOf(allLinks, id);
  const linked = linkedIds.flatMap((bookId) => {
    const book = books.find((item) => item.id === bookId);
    return book === undefined ? [] : [book];
  });
  const full = id !== null && linksFull(allLinks, id);

  const unlink = async (bookId: string, bookName: string) => {
    if (id === null) return;
    const at = linkedIds.indexOf(bookId);
    const next = linkedIds[at + 1] ?? linkedIds[at - 1];
    if (
      !(await links.change({ lorebookId: bookId, characterId: id, character: name, linked: false }))
    )
      return;
    setDone(`Unlinked ${bookName}. It stays in your library.`);
    // Focus goes to the next book's Unlink, else to Link a lorebook.
    const target =
      next === undefined
        ? null
        : list.current?.querySelector<HTMLElement>(`[data-linked="${next}"] button`);
    (target ?? list.current?.querySelector<HTMLElement>("[data-link-trigger] button"))?.focus();
  };

  /**
   * New lorebook, made and linked as one intent per character: the book's id
   * and name are held until both the create and the link are acknowledged,
   * so a retry after a lost answer or a failed link sends the same book again
   * (stored once) and links it, never a second one. A held book the owner
   * has linked meanwhile from the picker is done: New makes another.
   */
  const createAndLink = async () => {
    if (id === null || locked || full) return;
    const characterId = id;
    // Another New for this character on its way answers undefined.
    const outcome = await creates.run(`new:${characterId}`, async ({ held, take, release }) => {
      if (held !== undefined && linkedIds.includes(held.id)) release();
      setCreating(characterId);
      setCreateFailed(null);
      links.clearError();
      const makeAndLink = async () => {
        const book = take({ name: NEW_NAME });
        const created = await createLorebook(book.id, book.payload.name);
        if (!created.ok) {
          setCreateFailed(`Not created: ${created.reason}.`);
          return created;
        }
        // A refused or failed link says why itself (links.error) and reloads the library.
        const ok = await links.change({
          lorebookId: created.id,
          characterId,
          character: name,
          linked: true,
        });
        return { ok };
      };
      return makeAndLink().finally(() => setCreating((now) => (now === characterId ? null : now)));
    });
    if (!outcome?.ok) return;
    setOpen(false);
    // The held book may have been renamed since it was made, so this names none.
    setDone(`Created a lorebook and linked it to ${name}.`);
  };

  const choices = [...books]
    .sort((a, b) => byName(a.name, b.name))
    .map((book) => {
      const isLinked = linkedIds.includes(book.id);
      const pending = id === null ? undefined : links.pendingOf(book.id, id);
      const unavailable = !isLinked && full;
      return {
        id: book.id,
        name: book.name,
        checked: pending ?? isLinked,
        pending: pending !== undefined,
        disabled: unavailable,
        note: unavailable ? LINKS_FULL_TEXT : entriesText(book),
        leaf: <LorebookIcon size={16} className="mx-0.5 text-reed" />,
      };
    });

  return (
    <div ref={list} className="grid gap-3">
      <h3 className="font-medium text-ink text-ui">Linked from your library</h3>
      {linked.length > 0 && (
        <ul aria-label="Linked lorebooks" className="grid border-rush border-t">
          {linked.map((book) => (
            <li
              key={book.id}
              data-linked={book.id}
              className="flex min-h-14 items-center gap-3 border-rush border-b py-2 arrive"
            >
              <LorebookIcon size={16} className="shrink-0 text-reed" />
              <span className="grid min-w-0 flex-1">
                {off ? (
                  <span title={book.name} className="truncate text-ink text-ui">
                    {book.name}
                  </span>
                ) : (
                  <Link
                    to="/lorebooks/$id"
                    params={{ id: book.id }}
                    title={book.name}
                    className="truncate text-ink text-ui underline decoration-control-edge underline-offset-4 hover:decoration-ink"
                  >
                    {book.name}
                  </Link>
                )}
                <span className="text-meta text-reed">{entriesText(book)}</span>
              </span>
              <Button
                aria-label={`Unlink ${book.name}`}
                disabled={off || (id !== null && links.pendingOf(book.id, id) !== undefined)}
                onClick={() => void unlink(book.id, book.name)}
              >
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3" data-link-trigger="">
        <ChoicePicker
          trigger={
            <>
              <PlusIcon size={16} />
              Link a lorebook
            </>
          }
          disabled={off}
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) setCreateFailed(null);
          }}
          title={`Lorebooks linked to ${name}`}
          sheetTitle="Linked lorebooks"
          findLabel="Find a lorebook"
          empty="No lorebooks in your library yet."
          noMatch="No lorebook matches."
          choices={choices}
          onToggle={(choice, checked) => {
            if (id === null) return;
            setDone(null);
            void links.change({
              lorebookId: choice.id,
              characterId: id,
              character: name,
              linked: checked,
            });
          }}
          notice={
            (links.error ?? createFailed) !== null && (
              <p role="alert" className="px-2.5 pb-1.5 text-ember text-note">
                {links.error ?? createFailed}
              </p>
            )
          }
          footer={
            <div className="border-rush border-t p-1.5">
              <Button
                className="w-full justify-start"
                disabled={full || creating}
                onClick={() => void createAndLink()}
              >
                <PlusIcon size={16} />
                {creating ? "Creating…" : "New lorebook"}
              </Button>
              {full && <p className="px-2.5 pb-1 text-meta text-reed">{LINKS_FULL_TEXT}</p>}
            </div>
          }
        />
        {linked.length > 0 && (
          <span className="text-meta text-reed">{linkedCountText(linked.length)}</span>
        )}
      </div>
      <p role="status" className={cn(HELP, "empty:hidden")}>
        {done}
      </p>
      {links.error !== null && !open && (
        <p role="alert" className="text-ember text-note">
          {links.error}
        </p>
      )}
      <p className={HELP}>
        Read with every chat with {name}, after the book in the card. Unlinking keeps the book in
        your library. Linked lorebooks are not part of an exported card.
      </p>
    </div>
  );
}

const linkedCountText = (count: number) => `${count} of ${LOREBOOK_LINKS} linked`;
