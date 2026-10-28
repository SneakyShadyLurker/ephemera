import type { EmbeddedLorebook } from "@ephemera/core";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useId, useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { GLIDE } from "@/app/glide.ts";
import { useOnScreen } from "@/app/KeptScroll.tsx";
import { DeleteIcon, DuplicateIcon, ExportIcon, MoreIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { countOf } from "@/lib/text";
import { ActivationCounts } from "../lorebook/marks.tsx";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import { ExportLink } from "../signin/ExportLink.tsx";
import { Leaves } from "./Leaves.tsx";
import { deleteText, type LinkedCharacter, linkedText, type BookRow as Row } from "./library.ts";
import { setOpened, useLibrary } from "./library-state.ts";

/** The shared-element name that carries a book's name between its library row and its editor. */
export const NAME_TRANSITION = "lorebook-name";

/** A row's hairline and its trailing actions beside the link, never inside it. */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-rush border-b";
const LINK =
  "group grid min-h-16 min-w-0 items-center gap-x-6 gap-y-1 rounded-sm px-1 py-2.5 outline-none hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--dusk-line)]";
const NAME =
  "truncate font-semibold text-ink text-ui decoration-control-edge underline-offset-4 group-hover:underline";

/** Who carries a book: a few portraits and the count, or "Not linked". */
function Linked({ characters, className }: { characters: LinkedCharacter[]; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2 text-meta", className)}>
      <Leaves characters={characters} small />
      <span className={characters.length === 0 ? "text-reed" : "text-ink"}>
        {linkedText(characters.length)}
      </span>
    </span>
  );
}

/**
 * One library book: its name, its counts with their marks, and the
 * characters it is linked to; a stable trailing column on desktop, wrapping
 * with the counts on tablet, a line of its own on phones. The name carries
 * the shared transition into the editor while this is the book last opened
 * and its row is in view; otherwise the screens crossfade.
 */
export function BookRow({
  row,
  arrived,
  onDuplicate,
  onDelete,
  onError,
}: {
  row: Row;
  /** Imported in this visit. */
  arrived: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onError: (text: string) => void;
}) {
  const { book, characters } = row;
  const metaId = useId();
  const name = book.name.trim() || "Untitled lorebook";
  const opened = useLibrary((state) => state.opened === book.id);
  const nameRef = useRef<HTMLSpanElement>(null);
  // On return the name glides back only into a row that is on screen.
  const inView = useOnScreen(nameRef, opened);
  const style: CSSProperties | undefined =
    opened && inView ? { viewTransitionName: NAME_TRANSITION } : undefined;
  return (
    <li data-book={book.id} className={ROW}>
      <Link
        to="/lorebooks/$id"
        params={{ id: book.id }}
        aria-label={name}
        aria-describedby={metaId}
        onClick={() => setOpened(book.id)}
        className={cn(LINK, "desktop:grid-cols-[minmax(0,1fr)_16rem]")}
      >
        <span className="grid min-w-0 gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span ref={nameRef} style={style} title={book.name} className={cn(NAME, GLIDE)}>
              {name}
            </span>
            {arrived && (
              <span className="shrink-0 rounded-sm bg-surface-selected px-1.5 text-ink text-meta transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
                Imported
              </span>
            )}
          </span>
          <span
            id={metaId}
            className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-meta text-reed"
          >
            <ActivationCounts counts={book} />
            <Linked characters={characters} className="max-tablet:basis-full desktop:hidden" />
          </span>
        </span>
        <Linked characters={characters} className="hidden justify-end desktop:flex" />
      </Link>
      <BookMenu
        row={row}
        name={name}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onError={onError}
      />
    </li>
  );
}

function BookMenu({
  row,
  name,
  onDuplicate,
  onDelete,
  onError,
}: {
  row: Row;
  name: string;
  onDuplicate: () => void;
  onDelete: () => void;
  onError: (text: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="icon" aria-label={`More for ${name}`} />}>
          <MoreIcon />
        </MenuTrigger>
        <MenuContent label={`Actions for ${name}`}>
          <MenuItem onClick={onDuplicate}>
            <DuplicateIcon size={16} />
            Duplicate
          </MenuItem>
          <MenuLinkItem
            closeOnClick
            render={
              <ExportLink
                file={{ kind: "lorebook", id: row.book.id }}
                name={row.book.name}
                onError={onError}
              />
            }
          >
            <ExportIcon size={16} />
            Export as JSON
          </MenuLinkItem>
          <MenuSeparator />
          <MenuItem danger onClick={() => setConfirm(true)}>
            <DeleteIcon size={16} />
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${name}?`}
        description={deleteText(row.characters.map((character) => character.name))}
        confirm="Delete"
        onConfirm={onDelete}
      />
    </>
  );
}

/**
 * A book saved in a character's card: the character's portrait and the
 * book's entry count; the row opens that card's lorebook. Copy to library
 * makes an independent copy, linked to no one.
 */
export function EmbeddedRow({
  book,
  portrait,
  copying,
  onCopy,
}: {
  book: EmbeddedLorebook;
  portrait: number | null;
  copying: boolean;
  onCopy: () => void;
}) {
  const phone = useFormFactor() === "phone";
  const title = `${book.name.trim() || "A character"}'s lorebook`;
  const metaId = useId();
  return (
    <li className={ROW}>
      <Link
        to="/characters/$id/lorebook"
        params={{ id: book.characterId }}
        aria-label={title}
        aria-describedby={metaId}
        className={cn(LINK, "grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3")}
      >
        <PortraitLeaf id={book.characterId} name={book.name} version={portrait} className="w-5" />
        <span className="grid min-w-0 gap-1">
          <span title={title} className={NAME}>
            {title}
          </span>
          <span id={metaId} className="text-meta text-reed">
            {book.entries === 0 ? "No entries" : countOf(book.entries, "entry", "entries")}
          </span>
        </span>
      </Link>
      {/* The visible words lead the name, so speech input finds the button by them. */}
      <Button
        aria-label={`Copy to library: ${title}`}
        disabled={copying}
        onClick={onCopy}
        size={phone ? "icon" : "default"}
      >
        <DuplicateIcon size={16} />
        {!phone && "Copy to library"}
      </Button>
    </li>
  );
}
