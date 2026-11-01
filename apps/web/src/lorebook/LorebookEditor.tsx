import {
  blankLorebook,
  type EntrySettingsPatch,
  entryTitle,
  type Lorebook,
  type LorebookEntry,
  newEntry,
} from "@ephemera/core";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { SCROLL_GUTTER_END, SCROLL_GUTTERS } from "@/app/Screen.tsx";
import { LorebookIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { type SaveStatus, useAutosave } from "../sheet/autosave.ts";
import type { AutosaveOptions } from "../sheet/autosave-controller.ts";
import { ConflictNotice } from "../sheet/ConflictNotice.tsx";
import { type BackTarget, SheetHeader, useLeaveGuard } from "../sheet/SheetFrame.tsx";
import {
  bookPools,
  bookSettings,
  findEntries,
  listOrder,
  type RemovedEntry,
  withEntry,
  withRestored,
  withSettings,
} from "./book.ts";
import { ENTRY_INSET, ENTRY_X, EntryEditor, EntryMenu, type EntryRow } from "./EntryEditor.tsx";
import { takeFollowedEntry } from "./EntryLink.tsx";
import { EntryList, focusChaining, LIST_INSET, LIST_X, type ListBand } from "./EntryList.tsx";

/*
 * One lorebook's editor, whatever holds the book: the book's reading rules
 * and its entries on either side of the character, and one entry's editor
 * beside them on desktop or in their place on narrower screens. Where the
 * book comes from and goes to is its source's (`BookSource`): a character's
 * card (LorebookScreen.tsx) or the library (lorebooks/BookScreen.tsx). Card
 * and book data, never chat content.
 */

/** What the editor saves: the book, and the name (a library book's own; a card's only types the autosave). */
export type BookFields = { name: string; book: Lorebook | null };

/** What the source's slots may read and change. */
export interface BookContext {
  name: string;
  onName: (name: string) => void;
  /** The book as edited; an empty one stands in while a card has none. */
  book: Lorebook;
  /** Whether there is a book: a card may have none yet. */
  exists: boolean;
  onBook: (change: Partial<Lorebook>) => void;
  entries: number;
  status: SaveStatus;
  /** Saves what is pending now; false when it could not be saved. */
  flush: () => Promise<boolean>;
  /** After a deletion: nothing more is saved. */
  discard: () => void;
  /** Removes the whole book; its source's `onRemoved` follows once the removal is saved. */
  removeBook: () => void;
}

/**
 * Where a book comes from and goes to: the loaded book and its revision, how
 * it saves, the way back, the title and noun, what the list's band shows,
 * and the source's own controls.
 */
export interface BookSource<Saved extends { revision: number }> {
  /** The id the autosave saves to. */
  id: string;
  revision: number;
  name: string;
  book: Lorebook | null;
  /** What the save state and its notices call the thing saved: "character", "lorebook". */
  noun: string;
  title: (name: string) => string;
  back: BackTarget;
  band: ListBand;
  /** The empty book's sentence. */
  empty: string;
  save: Pick<AutosaveOptions<BookFields, Saved>, "schema" | "labels" | "wholeLabel" | "save"> & {
    onSaved: (id: string, saved: Saved) => void;
  };
  /** Fetches the saved book and reopens the editor on it (a conflict's Reload). */
  onReload: () => Promise<void>;
  /** After `removeBook` is saved. */
  onRemoved?: () => void;
  /** Above the book's settings in the list pane (a library book's name and links). */
  head?: (context: BookContext) => ReactNode;
  /** The header's actions after Add entry, while the list shows. */
  actions: (context: BookContext) => ReactNode;
}

type Edited = { fields: BookFields; keys: string[] };

const newKey = (): string => crypto.randomUUID();

/**
 * The header's frames, on the pane's own padding: on desktop the list and
 * the editor beside it form one workspace anchored at the rail; on narrower
 * screens the active pane, the list or one entry, is centred.
 */
const FRAME = {
  split: cn(
    "w-full max-w-[calc(var(--container-entries)+var(--container-column))]",
    LIST_INSET.start,
    ENTRY_INSET.end,
  ),
  list: cn("mx-auto w-full max-w-column", LIST_X),
  entry: cn("mx-auto w-full max-w-column", ENTRY_X),
} as const;

export function LorebookEditor<Saved extends { revision: number }>({
  source,
  entry: requested,
  onEntry,
}: {
  source: BookSource<Saved>;
  entry: number | undefined;
  onEntry: (entry: number | undefined, push: boolean) => void;
}) {
  const factor = useFormFactor();
  const split = factor === "desktop";
  // The book and the React keys of its entries change together, in one update.
  const [edited, setEdited] = useState<Edited>(() => ({
    fields: { name: source.name, book: source.book },
    keys: (source.book?.entries ?? []).map(newKey),
  }));
  const { fields, keys } = edited;
  const book = fields.book;
  const entries = book?.entries ?? [];
  const [removed, setRemoved] = useState<(RemovedEntry & { key: string }) | null>(null);
  const [find, setFind] = useState({ query: "", toFix: false });
  /** A row the list focuses: after Remove, or on returning to the list on narrow screens. */
  const [focusRequest, setFocusRequest] = useState<{ index: number } | null>(null);
  const leaving = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  /** A new entry opens with focus in its title, once the editor is there. */
  const focusTitle = useRef(false);
  /** The editor rows open per entry (by React key), for this visit only. */
  const [openRows, setOpenRows] = useState<Record<string, readonly EntryRow[]>>({});
  /** An entry's "Open book settings" on narrow screens: the list returns with focus on Chaining. */
  const toChaining = useRef(false);
  const open = requested !== undefined && requested < entries.length ? requested : null;
  const current = open === null ? undefined : entries[open];
  // A link followed from a chat's report names an entry by an index that was right when the
  // report was made. If the entry there now has another title, the one entry with the
  // report's title opens instead, or the list when none or several have it.
  const [meant] = useState(takeFollowedEntry);
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked once, against the book as loaded.
  useEffect(() => {
    if (meant === null || meant.index !== requested) return;
    const titled = (index: number) => {
      const at = entries[index];
      return at !== undefined && entryTitle(at, index) === meant.title;
    };
    if (titled(meant.index)) return;
    const matches = entries.flatMap((_, index) => (titled(index) ? [index] : []));
    onEntry(matches.length === 1 ? matches[0] : undefined, false);
  }, []);
  useEffect(() => {
    if (!focusTitle.current || open === null) return;
    focusTitle.current = false;
    document.getElementById("entry-title")?.focus();
  }, [open]);

  // On narrow screens an entry replaces the list; closing it (Back, or the header's
  // Entries) brings the list back where it was, with focus on that entry's row.
  const previousOpen = useRef(open);
  useLayoutEffect(() => {
    const closed = previousOpen.current;
    previousOpen.current = open;
    if (split || open !== null || closed === null) return;
    if (scroller.current !== null) scroller.current.scrollTop = listScroll.current;
    if (toChaining.current) {
      toChaining.current = false;
      focusChaining();
      return;
    }
    setFocusRequest({ index: closed });
  }, [open, split]);

  const autosave = useAutosave<BookFields, Saved>({
    id: source.id,
    revision: source.revision,
    fields,
    ...source.save,
  });
  const leaveGuard = useLeaveGuard(
    autosave,
    (value) => {
      leaving.current = value;
    },
    false,
    source.noun,
  );

  /**
   * Every change is an update of the latest book, applied at once. Edits are
   * not run as transitions: an edit made while a reorder transition waited on
   * its view transition made React commit the two books in turn.
   */
  const updateBook = (update: (current: Lorebook | null) => Lorebook | null) =>
    setEdited((state) => ({
      ...state,
      fields: { ...state.fields, book: update(state.fields.book) },
    }));

  // Autosave saves each committed book it has not saved yet. Removing the whole
  // book saves the removal at once, then the source moves on.
  const { flush } = autosave;
  const { onRemoved } = source;
  const [removingBook, setRemovingBook] = useState(false);
  useLayoutEffect(() => {
    if (removingBook && fields.book === null) {
      setRemovingBook(false);
      void flush().then((saved) => {
        if (saved) onRemoved?.();
      });
    }
  }, [removingBook, fields.book, flush, onRemoved]);
  const change = (index: number, patch: Partial<LorebookEntry>) =>
    updateBook((latest) => withEntry(latest ?? blankLorebook(), index, patch));
  const changeSettings = (index: number, patch: EntrySettingsPatch) =>
    updateBook((latest) => withSettings(latest ?? blankLorebook(), index, patch));

  const add = () => {
    const key = newKey();
    setRemoved(null);
    setEdited((state) => {
      const base = state.fields.book ?? blankLorebook();
      return {
        fields: {
          ...state.fields,
          book: { ...base, entries: [...base.entries, newEntry(base.entries)] },
        },
        keys: [...state.keys, key],
      };
    });
    onEntry(entries.length, !split);
    focusTitle.current = true;
  };

  /** Inserts or removes around `target`, found by identity in the latest book. */
  const around = (
    target: LorebookEntry,
    splice: (list: LorebookEntry[], keyList: string[], at: number) => void,
  ) =>
    setEdited((state) => {
      const latest = state.fields.book;
      const at = latest?.entries.indexOf(target) ?? -1;
      if (latest === null || at === -1) return state;
      const list = [...latest.entries];
      const keyList = [...state.keys];
      splice(list, keyList, at);
      return {
        fields: { ...state.fields, book: { ...latest, entries: list } },
        keys: keyList,
      };
    });

  const duplicate = (index: number) => {
    const entrySource = entries[index];
    if (entrySource === undefined) return;
    const copy: LorebookEntry = {
      ...entrySource,
      id: newEntry(entries).id,
      comment: `${entryTitle(entrySource, index)} (copy)`.slice(0, 200),
    };
    const key = newKey();
    setRemoved(null);
    around(entrySource, (list, keyList, at) => {
      list.splice(at + 1, 0, copy);
      keyList.splice(at + 1, 0, key);
    });
    onEntry(index + 1, false);
  };

  const remove = (index: number) => {
    const target = entries[index];
    if (target === undefined) return;
    // Focus goes to the row after it in the list, or the one before the last.
    const order = listOrder(findEntries(entries, find.query, find.toFix));
    const at = order.indexOf(index);
    const next = order[at + 1] ?? order[at - 1];
    setRemoved({ entry: target, index, key: keys[index] ?? newKey() });
    around(target, (list, keyList, position) => {
      list.splice(position, 1);
      keyList.splice(position, 1);
    });
    setFocusRequest(next === undefined ? null : { index: next > index ? next - 1 : next });
    onEntry(undefined, false);
  };

  const undo = () => {
    if (removed === null) return;
    setEdited((state) => {
      const latest = state.fields.book ?? blankLorebook();
      const at = Math.min(removed.index, latest.entries.length);
      return {
        fields: { ...state.fields, book: withRestored(latest, removed) },
        keys: [...state.keys.slice(0, at), removed.key, ...state.keys.slice(at)],
      };
    });
    setRemoved(null);
    onEntry(Math.min(removed.index, entries.length), false);
  };

  const context: BookContext = {
    name: fields.name,
    onName: (name) => setEdited((state) => ({ ...state, fields: { ...state.fields, name } })),
    book: book ?? blankLorebook(),
    exists: book !== null,
    onBook: (patch) => updateBook((latest) => ({ ...(latest ?? blankLorebook()), ...patch })),
    entries: entries.length,
    status: autosave.status,
    flush: autosave.flush,
    discard: autosave.discard,
    removeBook: () => {
      setRemovingBook(true);
      setEdited((state) => ({ fields: { ...state.fields, book: null }, keys: [] }));
      setRemoved(null);
    },
  };

  // Per keystroke only what is on screen is checked: the open entry and the book itself.
  const inEntry = !split && current !== undefined;
  const entryTitleText = current === undefined || open === null ? "" : entryTitle(current, open);

  const entryMenu =
    current !== undefined && open !== null ? (
      <EntryMenu
        title={entryTitleText}
        onDuplicate={() => duplicate(open)}
        onRemove={() => remove(open)}
      />
    ) : null;

  const openKey = open === null ? undefined : keys[open];
  const settings = book === null ? null : bookSettings(book);
  const editor =
    current !== undefined && open !== null && openKey !== undefined ? (
      <EntryEditor
        key={openKey}
        entry={current}
        index={open}
        menu={split ? entryMenu : null}
        book={{
          depth: settings?.effectiveDepth ?? 0,
          chaining: settings?.chaining ?? false,
          pools: book === null ? [] : bookPools(book),
        }}
        openRows={openRows[openKey] ?? []}
        onRow={(row, isOpen) =>
          setOpenRows((rows) => {
            const others = (rows[openKey] ?? []).filter((item) => item !== row);
            return { ...rows, [openKey]: isOpen ? [...others, row] : others };
          })
        }
        onChange={(patch) => change(open, patch)}
        onSettings={(patch) => changeSettings(open, patch)}
        onOpenBookSettings={() => {
          if (split) {
            focusChaining();
          } else {
            toChaining.current = true;
            onEntry(undefined, false);
          }
        }}
      />
    ) : null;

  const undoLine = removed !== null && (
    <p role="status" className="flex items-center gap-2 text-note text-reed arrive">
      <span className="min-w-0 truncate">{entryTitle(removed.entry, removed.index)} removed.</span>
      <Button size="text" className="text-ink" onClick={undo}>
        Undo
      </Button>
    </p>
  );

  const list = (
    <>
      {source.head?.(context)}
      {undoLine && <div className={cn(LIST_X, "pt-4")}>{undoLine}</div>}
      {book === null || entries.length === 0 ? (
        <EmptyBook text={source.empty} onAdd={add} />
      ) : (
        <EntryList
          band={source.band}
          book={book}
          keys={keys}
          open={open}
          focusRequest={focusRequest}
          onOpen={(index) => {
            listScroll.current = scroller.current?.scrollTop ?? 0;
            onEntry(index, !split);
          }}
          onBook={context.onBook}
          onEnabled={(index, enabled) => change(index, { enabled })}
          find={find}
          onFind={setFind}
        />
      )}
    </>
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <SheetHeader
        back={inEntry ? { label: "Entries", onBack: () => onEntry(undefined, false) } : source.back}
        title={source.title(fields.name)}
        status={autosave.status}
        creating={false}
        noun={source.noun}
        frame={split ? FRAME.split : inEntry ? FRAME.entry : FRAME.list}
        // The single pane is centred; in the split only the editor's end keeps a gutter.
        gutters={split ? SCROLL_GUTTER_END : SCROLL_GUTTERS}
      >
        {inEntry ? (
          entryMenu
        ) : (
          <>
            <Button variant="outline" aria-label="Add entry" onClick={add}>
              <PlusIcon size={16} />
              {factor === "phone" ? "Add" : "Add entry"}
            </Button>
            {source.actions(context)}
          </>
        )}
      </SheetHeader>
      {split ? (
        <div className="flex min-h-0 flex-1">
          <div
            data-skip-target=""
            tabIndex={-1}
            className="w-entries shrink-0 overflow-y-auto border-rush border-r outline-none"
          >
            {list}
          </div>
          <div className={cn("min-w-0 flex-1 overflow-y-auto", SCROLL_GUTTER_END)}>
            {editor ??
              (entries.length > 0 && (
                <p className="px-10 pt-16 text-reed text-ui">Choose an entry to edit it.</p>
              ))}
          </div>
        </div>
      ) : (
        <div
          ref={scroller}
          data-skip-target=""
          tabIndex={-1}
          className={cn("min-h-0 flex-1 overflow-y-auto outline-none", SCROLL_GUTTERS)}
        >
          {inEntry ? editor : <div className="mx-auto max-w-column">{list}</div>}
        </div>
      )}
      {autosave.status.kind === "conflict" && (
        <ConflictNotice
          noun={source.noun}
          placement="footer"
          onReload={source.onReload}
          onKeepMine={autosave.keepMine}
        />
      )}
      {leaveGuard}
    </main>
  );
}

function EmptyBook({ text, onAdd }: { text: string; onAdd: () => void }) {
  return (
    <div className={cn(LIST_X, "grid justify-items-start gap-3 pt-10")}>
      <LorebookIcon size={24} className="text-reed" />
      <p className="max-w-help text-pretty text-lead text-narration">{text}</p>
      <Button variant="outline" onClick={onAdd}>
        <PlusIcon size={16} />
        Add the first entry
      </Button>
    </div>
  );
}
