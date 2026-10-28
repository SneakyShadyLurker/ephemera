import {
  entryActivation,
  entrySettings,
  entryTitle,
  LOREBOOK_RULES,
  type Lorebook,
  type LorebookEntry,
} from "@ephemera/core";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { NextIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { SearchField } from "@/components/ui/search-field";
import { Switch, SwitchField } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { countOf, formatCount } from "@/lib/text";
import {
  bookSettings,
  entriesToFix,
  entryKeyProblems,
  findEntries,
  type ListGroup,
  listOrder,
  type ShownGroup,
} from "./book.ts";
import { entryCues, percent, poolsText, SHARED_BUDGET } from "./copy.ts";
import { ActivationMark } from "./marks.tsx";

const HELP = "text-pretty text-note text-reed";
/** Keywords a row shows before "and N more"; the line truncates anyway. */
const ROW_KEYS = 6;

/**
 * What stands between the entries placed before and after the definition:
 * the character whose card holds the book, or, for a library book read with
 * whichever characters it is linked to, the definition itself.
 */
export type ListBand = { kind: "character"; id: string; name: string } | { kind: "definition" };

interface ListProps {
  band: ListBand;
  book: Lorebook;
  /** React keys of the entries, parallel to them. */
  keys: string[];
  open: number | null;
  onOpen: (index: number) => void;
  onBook: (change: Partial<Lorebook>) => void;
  onEnabled: (index: number, enabled: boolean) => void;
  /** Find text and scroll position, kept while an entry is open on narrow screens. */
  find: { query: string; toFix: boolean };
  onFind: (find: { query: string; toFix: boolean }) => void;
  /** A row to focus: the next one after a removal, or the one an entry was opened from. */
  focusRequest: { index: number } | null;
}

/** The list's inline padding, shared with the lorebook header's frames. */
export const LIST_INSET = { start: "pl-5 tablet:pl-6", end: "pr-5 tablet:pr-6" } as const;
export const LIST_X = cn(LIST_INSET.start, LIST_INSET.end);

/** The id around the book's Chaining switch, which an entry's "Open book settings" focuses. */
const CHAINING_ID = "book-chaining";

/** Focuses the book's Chaining switch, scrolled into view. */
export function focusChaining() {
  const control = document.querySelector<HTMLElement>(`#${CHAINING_ID} [role="switch"]`);
  control?.focus({ preventScroll: true });
  control?.scrollIntoView({ block: "nearest" });
}

/** The book's reading rules: scan depth and budget, blank meaning the defaults, and Chaining. */
function BookSettings({ book, onBook }: Pick<ListProps, "book" | "onBook">) {
  const { depth, effectiveDepth: shownDepth, budget, chaining } = bookSettings(book);
  return (
    <section aria-label="How the book is read" className={cn(LIST_X, "grid gap-3 pt-5 pb-4")}>
      <div className="grid gap-3 tablet:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <span className="text-note text-reed">Scan depth, in messages</span>
          <NumberField
            label="Scan depth"
            value={depth}
            min={0}
            max={LOREBOOK_RULES.maxScanDepth}
            inputClassName="placeholder:text-reed"
            onValueChange={(value) =>
              onBook({ scanDepth: value === null ? undefined : Math.trunc(value) })
            }
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <span className="text-note text-reed">Token budget</span>
          <NumberField
            label="Token budget"
            value={budget}
            min={0}
            step={128}
            inputClassName="placeholder:text-reed"
            onValueChange={(value) =>
              onBook({ tokenBudget: value === null || value <= 0 ? undefined : Math.trunc(value) })
            }
          />
        </div>
      </div>
      <p className={HELP}>
        {shownDepth === 0
          ? "No message is read for keywords; only constant entries go in."
          : `Keywords are looked for in the last ${countOf(shownDepth, "message")}.`}{" "}
        {budget === null
          ? "Entries fill up to a quarter of the model's context window."
          : `Entries fill up to ${formatCount(budget)} tokens, never more than a quarter of the model's context window.`}{" "}
        {SHARED_BUDGET}{" "}
        {chaining
          ? "Entries' text is also read for keywords, so one entry can bring in another."
          : "Entries' text isn't read for keywords."}
        {depth === null && " Empty fields use the defaults."}
      </p>
      <div id={CHAINING_ID} className="border-rush border-t pt-3">
        <SwitchField
          label="Chaining"
          description="Entries can bring in other entries their text mentions"
          checked={chaining}
          onCheckedChange={(on) => onBook({ recursiveScanning: on })}
        />
      </div>
    </section>
  );
}

/** Focuses an entry's row in the list, scrolled into view. */
function focusRow(list: HTMLElement | null, index: number | undefined) {
  if (index === undefined) return;
  const row = list?.querySelector<HTMLElement>(`[data-entry="${index}"] [data-row]`);
  row?.focus({ preventScroll: true });
  // Rows off screen are skipped by content-visibility; bring the focused one into view.
  row?.scrollIntoView({ block: "nearest" });
}

const GROUP_TEXT: Record<ListGroup, { label: string; meta?: string }> = {
  before: { label: "Before the character" },
  after: { label: "After the character" },
  examples: { label: "With the example dialogue" },
  authorsNote: { label: "With the Author's Note" },
  chat: {
    label: "In the chat",
    meta: "Entries in the chat sit among the messages, deepest first",
  },
  notSent: { label: "Not sent" },
};

/**
 * The entry list: settings, a sticky Find, then the entries in the order the
 * prompt speaks them, around the character's band and, below a chat history
 * band, those joined into the Author's Note or placed among the messages.
 */
export function EntryList(props: ListProps) {
  const { book, keys, open, find, onFind, focusRequest } = props;
  const _findId = useId();
  const query = useDeferredValue(find.query);
  // Typing in an entry changes the book with every key; the list follows a moment later,
  // so the editor never waits for thousands of rows to be sorted and checked. Only while
  // the entries stay where they are: after an add, a removal or an undo (each gives the
  // entries new keys) the rows' indexes, which their actions use, must be the book's own.
  const deferredBook = useDeferredValue(book);
  const deferredKeys = useDeferredValue(keys);
  const listed = deferredKeys === keys ? deferredBook : book;
  const shown = findEntries(listed.entries, query, find.toFix);
  const toFix = entriesToFix(listed.entries);
  const order = listOrder(shown);
  // Rows that arrive after the list first shows (a placement change, a new entry) fade in;
  // nothing animates on load.
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  const [focus, setFocus] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  // One tab stop: the row last focused, else the open one, else the first.
  const stop = [focus, open].find((index) => index !== null && order.includes(index)) ?? order[0];
  const filtering = query.trim() !== "" || find.toFix;

  useEffect(() => {
    if (focusRequest === null) return;
    setFocus(focusRequest.index);
    focusRow(list.current, focusRequest.index);
  }, [focusRequest]);

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    // Only keys on a row move or switch; a row's own switch keeps its keys.
    if (!(event.target instanceof Element) || event.target.closest("[data-row]") === null) return;
    const current = order.indexOf(focus ?? stop ?? -1);
    const move = (to: number) => {
      event.preventDefault();
      focusRow(list.current, order[Math.max(0, Math.min(order.length - 1, to))]);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(current + 1);
      case "ArrowUp":
        return move(current - 1);
      case "Home":
        return move(0);
      case "End":
        return move(order.length - 1);
      case "ArrowRight":
        if (focus !== null) {
          event.preventDefault();
          props.onOpen(focus);
        }
        return;
      case " ": {
        const entry = focus === null ? undefined : book.entries[focus];
        if (focus === null || entry === undefined) return;
        event.preventDefault();
        props.onEnabled(focus, !entry.enabled);
        return;
      }
    }
  };

  const rows = (group: ShownGroup) =>
    group.indexes.map((index) => {
      // The groups and order follow the deferred book; a row shows its entry as it is now
      // (its index is the book's own: `listed` lags only while the keys are unchanged).
      const entry = book.entries[index];
      const key = keys[index] ?? String(index);
      if (entry === undefined) return null;
      return (
        <Row
          // A row that changes group is a new row there: it fades in rather than glides.
          key={`${group.group}:${key}`}
          index={index}
          entry={entry}
          open={open === index}
          tabStop={stop === index}
          arrives={settled}
          onFocus={setFocus}
          onOpen={props.onOpen}
          onEnabled={props.onEnabled}
        />
      );
    });
  const group = (id: ListGroup) => {
    const found = shown.find((item) => item.group === id);
    if (found === undefined) return null;
    return (
      <>
        <GroupHead
          label={GROUP_TEXT[id].label}
          meta={GROUP_TEXT[id].meta}
          count={found.indexes.length}
          total={found.total}
          filtering={filtering}
        />
        {rows(found)}
      </>
    );
  };
  const chatRegion = shown.some((item) => item.group === "authorsNote" || item.group === "chat");

  return (
    <div className="grid pb-10">
      <BookSettings book={book} onBook={props.onBook} />
      <div className={cn(LIST_X, "sticky top-0 z-10 flex items-center gap-2 bg-canvas pt-2 pb-3")}>
        <SearchField
          label="Find entries"
          value={find.query}
          placeholder="Find by title, keyword or text"
          onChange={(event) => onFind({ ...find, query: event.target.value })}
          className="flex-1"
        />
        {toFix > 0 && (
          <Button
            variant="outline"
            aria-pressed={find.toFix}
            onClick={() => onFind({ ...find, toFix: !find.toFix })}
            className="text-ember aria-pressed:bg-error-surface"
          >
            {formatCount(toFix)} to fix
          </Button>
        )}
      </div>
      {order.length === 0 && filtering ? (
        <div className={cn(LIST_X, "grid justify-items-start gap-2 border-rush border-t pt-5")}>
          <p className="text-reed text-ui">No entries match.</p>
          <Button variant="outline" onClick={() => onFind({ query: "", toFix: false })}>
            Clear find
          </Button>
        </div>
      ) : (
        <ol
          ref={list}
          aria-label="Entries in prompt order"
          onKeyDown={onKeyDown}
          className="grid border-rush border-t"
        >
          {group("before")}
          {props.band.kind === "character" ? (
            <CharacterBand id={props.band.id} name={props.band.name} />
          ) : (
            <DefinitionBand />
          )}
          {group("after")}
          {group("examples")}
          {chatRegion && <ChatBand />}
          {group("authorsNote")}
          {group("chat")}
          {group("notSent")}
        </ol>
      )}
    </div>
  );
}

function GroupHead({
  label,
  meta,
  count,
  total,
  filtering,
}: {
  label: string;
  meta: string | undefined;
  count: number;
  total: number;
  filtering: boolean;
}) {
  return (
    <li className={cn(LIST_X, "grid gap-0.5 pt-4 pb-1.5")}>
      <span className="flex items-baseline gap-2">
        <span className="font-medium text-ink text-note">{label}</span>
        <span className="text-meta text-reed tabular-nums">
          {filtering ? `${formatCount(count)} of ${formatCount(total)}` : formatCount(total)}
        </span>
      </span>
      {meta !== undefined && <span className="text-pretty text-meta text-reed">{meta}</span>}
    </li>
  );
}

/** Where the chat history begins: entries below it are sent with or among the messages. */
function ChatBand() {
  return (
    <li className="relative mx-5 mt-4 mb-2 border-control-edge border-y py-2.5 pl-4 before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-0.5 before:rounded-full before:bg-control-edge tablet:mx-6 dark:bg-surface">
      <span className="block font-medium text-ink text-ui">Chat history</span>
      <span className="block text-meta text-reed">Your messages and the replies</span>
    </li>
  );
}

/** Where the character's own definition sits: the entries fall on either side of it. */
function CharacterBand({ id, name }: { id: string; name: string }) {
  return (
    <li className="relative mx-5 my-2 border-control-edge border-y tablet:mx-6 dark:bg-surface">
      <Link
        to="/characters/$id"
        params={{ id }}
        tabIndex={-1}
        className="block py-2.5 pl-4 before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-0.5 before:rounded-full before:bg-control-edge hover:bg-surface-hover"
      >
        <span className="block truncate font-medium text-ink text-ui italic">{name}</span>
        <span className="block text-meta text-reed">Description, personality and scenario</span>
      </Link>
    </li>
  );
}

/** A library book's band: the definition of whichever character it is read with. */
function DefinitionBand() {
  return (
    <li className="relative mx-5 my-2 border-control-edge border-y py-2.5 pl-4 before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-0.5 before:rounded-full before:bg-control-edge tablet:mx-6 dark:bg-surface">
      <span className="block font-medium text-ink text-ui">Character definition</span>
      <span className="block text-meta text-reed">
        The linked character's description, personality and scenario
      </span>
    </li>
  );
}

function Row({
  index,
  entry,
  open,
  tabStop,
  arrives,
  onFocus,
  onOpen,
  onEnabled,
}: {
  index: number;
  entry: LorebookEntry;
  open: boolean;
  tabStop: boolean;
  /** Fades in when it mounts: after the list first showed. */
  arrives: boolean;
  onFocus: (index: number) => void;
  onOpen: (index: number) => void;
  onEnabled: (index: number, enabled: boolean) => void;
}) {
  const title = entryTitle(entry, index);
  const bad = new Set(entryKeyProblems(entry).map((problem) => problem.key));
  const settings = entrySettings(entry);
  const cues = entryCues(entry, settings);
  const cuesId = useId();
  const poolsId = useId();
  const pools = settings.poolNames;
  return (
    <li
      data-entry={index}
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)_auto] items-center pr-3 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto] tablet:pr-4",
        open && "bg-surface-selected",
        arrives && "transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0",
      )}
    >
      {open && (
        <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-ink" />
      )}
      <button
        type="button"
        data-row=""
        tabIndex={tabStop ? 0 : -1}
        aria-label={`Edit ${title}`}
        aria-describedby={pools.length > 0 ? `${poolsId} ${cuesId}` : cuesId}
        aria-current={open ? "true" : undefined}
        onFocus={() => onFocus(index)}
        onClick={() => onOpen(index)}
        className="grid min-h-14 min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm py-2 pl-3 text-left outline-none hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--dusk-line)] tablet:pl-4"
      >
        <span className="self-baseline pt-px text-right text-meta text-reed tabular-nums">
          {entry.insertionOrder}
        </span>
        <span className="grid min-w-0">
          <span
            className={cn(
              "truncate text-ui transition-colors duration-(--duration-quick) ease-fade",
              entry.enabled ? "text-ink" : "text-reed",
            )}
          >
            {title}
            {pools.length > 0 && (
              // Its event pools, quiet beside the title; the line truncates them first.
              <span id={poolsId} className="text-meta text-reed">
                <span aria-hidden="true"> · </span>
                {poolsText(pools)}
              </span>
            )}
          </span>
          <span id={cuesId} className="truncate text-meta text-reed">
            {cues.map((cue) => (
              <span key={cue.text} className={cue.ink ? "text-ink" : undefined}>
                {cue.text},{" "}
              </span>
            ))}
            <ActivationMark
              activation={entryActivation(entry, settings)}
              off={!entry.enabled}
              className="mr-1 inline-block align-[-0.1875rem]"
            />
            {entry.constant === true ? (
              settings.chance === null ? (
                <span className="text-ink">Always on</span>
              ) : (
                <>
                  <span className="text-ink">By chance</span>,{" "}
                  <span className="tabular-nums">{percent(settings.chance)}</span>
                </>
              )
            ) : entry.keys.length === 0 ? (
              "No keywords"
            ) : (
              <>
                {entry.keys.slice(0, ROW_KEYS).map((key, at) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: an imported book may repeat a key
                  <span key={`${at}-${key}`}>
                    {at > 0 && ", "}
                    <span
                      className={cn(
                        "underline decoration-dotted underline-offset-3",
                        bad.has(key) ? "text-ember decoration-ember" : "decoration-control-edge",
                      )}
                    >
                      {key}
                    </span>
                  </span>
                ))}
                {entry.keys.length > ROW_KEYS &&
                  `, and ${formatCount(entry.keys.length - ROW_KEYS)} more`}
              </>
            )}
          </span>
        </span>
        <NextIcon size={16} className="text-reed" />
      </button>
      <label className="grid size-9 place-items-center touch:size-11">
        <span className="sr-only">{title} enabled</span>
        <Switch
          size="sm"
          tabIndex={-1}
          checked={entry.enabled}
          onCheckedChange={(enabled) => onEnabled(index, enabled)}
        />
      </label>
    </li>
  );
}
