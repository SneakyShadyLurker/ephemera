import { EVENT_LIMITS, type EventFields, type StoredEvent } from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { countOf } from "@/lib/text";
import { charactersQuery } from "../characters/queries.ts";
import { SettingsRow } from "../lorebook/SettingsRow.tsx";
import { isFailure } from "../sheet/autosave.ts";
import { useLeaveGuard } from "../sheet/SheetFrame.tsx";
import { EventRow, type RowSaving } from "./EventRow.tsx";
import {
  createEvent,
  EVENT_LIMIT_REACHED,
  EVENTS_KEY,
  eventsQuery,
  refreshEvents,
} from "./queries.ts";
import { eventsSummary } from "./rule.ts";

/*
 * Events on the Lorebooks screen: one line the story is given now and then,
 * by chance. One row above the lorebooks, closed until opened; inside,
 * newest first, each event edited in place and saved as it changes.
 * Definitions only; which event fired where is chat content and never here.
 */

/** How long a deleted event's Undo stays, unless held by focus or the pointer. */
const UNDO_MS = 8_000;

const LIMIT_NOTE = `${EVENT_LIMITS.events} events is the most Ephemera keeps. Delete one to add another.`;

/** A new event in this visit: its row key, and its id once its first save made it. */
type Draft = { key: string; id: string | null };

/**
 * A saved event the list no longer has (deleted elsewhere) while its row was
 * shown: as last seen and where its row stood. Kept only until that row says
 * it holds nothing unsaved, or its owner discards the edits.
 */
type Orphan = { key: string; event: StoredEvent; at: number };

type Row = { key: string; stored: StoredEvent | null; gone: boolean };

/** New events first, then the saved ones newest first; each orphan keeps its row where it stood. */
function listRows(
  stored: readonly StoredEvent[],
  drafts: readonly Draft[],
  orphans: readonly Orphan[],
): Row[] {
  const byId = new Map(stored.map((event) => [event.id, event]));
  const draftIds = new Set(drafts.flatMap((draft) => (draft.id === null ? [] : [draft.id])));
  const lost = new Map(
    orphans.filter((orphan) => !byId.has(orphan.event.id)).map((orphan) => [orphan.key, orphan]),
  );
  const rows: Row[] = [
    ...drafts.map((draft) => {
      const orphan = lost.get(draft.key);
      lost.delete(draft.key);
      return {
        key: draft.key,
        stored: orphan?.event ?? (draft.id === null ? null : (byId.get(draft.id) ?? null)),
        gone: orphan !== undefined,
      };
    }),
    ...stored
      .filter((event) => !draftIds.has(event.id))
      .map((event) => ({ key: event.id, stored: event, gone: false })),
  ];
  for (const orphan of [...lost.values()].sort((a, b) => a.at - b.at)) {
    rows.splice(Math.min(orphan.at, rows.length), 0, {
      key: orphan.key,
      stored: orphan.event,
      gone: true,
    });
  }
  return rows;
}

/**
 * The orphans once the list reads `listed`: those listed again leave, and
 * every row shown with a saved event (`previous`) whose event is no longer
 * listed joins. A new event's row joins only once the list had shown it.
 */
function orphansAfter(
  previous: readonly Row[],
  listed: readonly StoredEvent[],
  orphans: readonly Orphan[],
): readonly Orphan[] {
  const ids = new Set(listed.map((event) => event.id));
  const kept = orphans.filter((orphan) => !ids.has(orphan.event.id));
  const known = new Set(kept.map((orphan) => orphan.key));
  const lost = previous.flatMap((row, at) =>
    row.stored === null || known.has(row.key) || ids.has(row.stored.id)
      ? []
      : [{ key: row.key, event: row.stored, at }],
  );
  return lost.length === 0 && kept.length === orphans.length ? orphans : [...kept, ...lost];
}

/**
 * A deleted event's place in the list, with what Undo brings back and the
 * one id it brings it back under, so a retried Undo never makes two; and
 * its Undo's progress, which belongs to this removal alone.
 */
export type Removed = {
  key: string;
  at: number;
  text: string;
  fields: EventFields;
  restoreId: string;
  /** Undo's request is on its way. */
  restoring: boolean;
  /** Why the last Undo did not restore it. */
  failure: string | null;
};

/**
 * Applies an Undo's outcome to the removal `key`: `patch`, or null once it
 * is restored. A removal no longer shown (another event deleted since, or
 * the line lapsed) is left as it is.
 */
export const settleRemoval =
  (key: string, patch: Partial<Pick<Removed, "restoring" | "failure">> | null) =>
  (current: Removed | null): Removed | null =>
    current?.key !== key ? current : patch === null ? null : { ...current, ...patch };

const SAVED = { kind: "saved" } as const;

/**
 * One leave guard for every row: leaving saves them all first, and asks
 * only when one could not be, saying why in the words of the first that failed.
 */
export function leaveGuardOf(rows: readonly RowSaving[]) {
  const stuck = rows.find((row) => isFailure(row.status, row.creating));
  return {
    status: stuck?.status ?? SAVED,
    creating: stuck?.creating ?? false,
    hasUnsaved: () => rows.some((row) => row.hasUnsaved()),
    flush: async () => {
      const flushed = await Promise.all(
        rows.filter((row) => row.hasUnsaved()).map((row) => row.flush()),
      );
      return flushed.every(Boolean);
    },
  };
}

export function EventsSection() {
  const queryClient = useQueryClient();
  const events = useQuery(eventsQuery);
  const characters = useQuery(charactersQuery);
  /** Closed on arrival: one row above the lorebooks, however many events it holds. */
  const [shown, setShown] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** Rows new in this visit (made or brought back), which arrive with motion. */
  const [arrived, setArrived] = useState<readonly string[]>([]);
  const [removed, setRemoved] = useState<Removed | null>(null);
  /** The removal shown now, for an Undo that completes after another one. */
  const shownRemoval = useRef<string | null>(null);
  useEffect(() => {
    shownRemoval.current = removed?.key ?? null;
  }, [removed]);
  /** Each row's saving, by row key: one leave guard and the closed row's summary read them. */
  const [saving, setSaving] = useState<ReadonlyMap<string, RowSaving>>(new Map());
  /** A row to focus once it renders: Undo's restored event. */
  const [focusRow, setFocusRow] = useState<string | null>(null);

  const [orphans, setOrphans] = useState<readonly Orphan[]>([]);
  // A list without an event its row showed (deleted elsewhere): the row stays mounted, as last
  // seen, until it says whether edits keep it.
  const [seen, setSeen] = useState(events.data);
  if (events.data !== seen) {
    setSeen(events.data);
    if (seen !== undefined && events.data !== undefined) {
      setOrphans(orphansAfter(listRows(seen, drafts, orphans), events.data, orphans));
    }
  }

  const stored = events.data ?? [];
  const rows = listRows(stored, drafts, orphans);
  const count = stored.length + drafts.filter((draft) => draft.id === null).length;
  const atLimit = count >= EVENT_LIMITS.events;
  const allCharacters = characters.data ?? [];
  const names = new Map(allCharacters.map((character) => [character.id, character.name]));
  const empty = events.data !== undefined && rows.length === 0 && removed === null;
  // A failed refetch keeps the list and its editors; only a first load that failed replaces them.
  const failed = events.isError && events.data === undefined;
  const rowsSaving = [...saving.values()];
  const unsaved = rowsSaving.filter((row) => row.failing).length;

  const reportSaving = (key: string, row: RowSaving | null) =>
    setSaving((current) => {
      const next = new Map(current);
      if (row === null) next.delete(key);
      else next.set(key, row);
      return next;
    });
  const guard = leaveGuardOf(rowsSaving);
  const leaveGuard = useLeaveGuard(guard, () => {}, guard.creating, "event");

  useEffect(() => {
    if (focusRow === null) return;
    const target = document.querySelector<HTMLElement>(
      `[data-event="${focusRow}"] [data-disclosure]`,
    );
    if (target === null) return;
    target.focus();
    setFocusRow(null);
  });

  const setRowOpen = (key: string, next: boolean) =>
    setOpen((current) => {
      const changed = new Set(current);
      if (next) changed.add(key);
      else changed.delete(key);
      return changed;
    });

  const add = () => {
    const key = crypto.randomUUID();
    setRemoved(null);
    setDrafts((current) => [{ key, id: null }, ...current]);
    setArrived((current) => [...current, key]);
    setRowOpen(key, true);
  };

  /** A row gone for good (deleted, or given up after a deletion elsewhere): nothing keeps it now. */
  const forget = (key: string) => {
    setOrphans((current) => current.filter((orphan) => orphan.key !== key));
    setDrafts((current) => current.filter((draft) => draft.key !== key));
    setOpen((current) => {
      if (!current.has(key)) return current;
      const changed = new Set(current);
      changed.delete(key);
      return changed;
    });
  };

  const removeRow = (key: string, at: number, restore: EventFields | null) => {
    forget(key);
    // Gone from the list at once; the reload confirms it (a new event's id may not be listed yet).
    const id = rows[at]?.stored?.id;
    if (id !== undefined) {
      queryClient.setQueryData<StoredEvent[]>(EVENTS_KEY, (list) =>
        list?.filter((event) => event.id !== id),
      );
    }
    void refreshEvents(queryClient);
    if (restore === null) {
      // Never saved: nothing to bring back; focus goes to the neighbour.
      focusNeighbour(at, key);
      return;
    }
    setRemoved({
      key: crypto.randomUUID(),
      at,
      text: restore.text,
      fields: restore,
      restoreId: crypto.randomUUID(),
      restoring: false,
      failure: null,
    });
  };

  /** After the row at `at` went: the row now in its place, the one before, or New event. */
  const focusNeighbour = (at: number, gone: string) => {
    const left = rows.filter((row) => row.key !== gone);
    const next = left[at] ?? left[at - 1];
    if (next === undefined) {
      // The button renders again in the heading or the empty state after this update.
      requestAnimationFrame(() => newButton.current?.focus());
    } else setFocusRow(next.key);
  };

  const undo = async () => {
    if (removed === null || removed.restoring) return;
    // Every outcome applies to this removal only, whatever was deleted meanwhile.
    const { key, restoreId, fields } = removed;
    setRemoved(settleRemoval(key, { restoring: true }));
    const outcome = await createEvent(restoreId, fields);
    if (!outcome.ok) {
      setRemoved(
        settleRemoval(key, {
          restoring: false,
          failure:
            outcome.reason === EVENT_LIMIT_REACHED
              ? LIMIT_NOTE
              : `Not restored: ${outcome.reason}.`,
        }),
      );
      return;
    }
    await refreshEvents(queryClient);
    const shown = shownRemoval.current === key;
    setRemoved(settleRemoval(key, null));
    setArrived((current) => [...current, outcome.id]);
    // Focus follows only an Undo still on screen, never away from another one.
    if (shown) setFocusRow(outcome.id);
  };

  /** Closing the section ends a deleted event's Undo: hidden, its line cannot lapse on its own. */
  const showSection = (next: boolean) => {
    setShown(next);
    if (!next) setRemoved(null);
  };

  const lapse = () => {
    if (removed === null) return;
    setRemoved(null);
    const active = document.activeElement;
    // Focus that was on Undo (or nowhere) goes on; focus the owner moved elsewhere stays.
    if (active === null || active === document.body || active.closest("[data-removed]") !== null) {
      const next = rows[removed.at] ?? rows[removed.at - 1];
      if (next === undefined) requestAnimationFrame(() => newButton.current?.focus());
      else setFocusRow(next.key);
    }
  };

  const newEvent = (
    <Button
      ref={newButton}
      variant="outline"
      disabled={atLimit}
      focusableWhenDisabled
      onClick={add}
    >
      <PlusIcon size={16} />
      New event
    </Button>
  );

  const items = rows.map((row, at) => (
    <EventRow
      key={row.key}
      rowKey={row.key}
      stored={row.stored}
      characters={characters.data}
      names={names}
      open={open.has(row.key)}
      onOpenChange={(next) => setRowOpen(row.key, next)}
      refetch={() => events.refetch()}
      onCreated={(id) => {
        setDrafts((current) =>
          current.map((draft) => (draft.key === row.key ? { ...draft, id } : draft)),
        );
        void refreshEvents(queryClient);
      }}
      onSaved={(saved) =>
        queryClient.setQueryData<StoredEvent[]>(EVENTS_KEY, (list) =>
          list?.map((event) => (event.id === saved.id ? saved : event)),
        )
      }
      onRemoved={(restore) => removeRow(row.key, at, restore)}
      onSaving={reportSaving}
      arrived={arrived.includes(row.key)}
      gone={row.gone}
      onGone={forget}
      onDiscard={() => {
        forget(row.key);
        focusNeighbour(at, row.key);
      }}
    />
  ));
  if (removed !== null) {
    items.splice(
      Math.min(removed.at, items.length),
      0,
      <RemovedRow
        key={removed.key}
        text={removed.text}
        failure={removed.failure}
        restoring={removed.restoring}
        onUndo={() => void undo()}
        onLapse={lapse}
      />,
    );
  }

  return (
    <section aria-label="Events">
      <SettingsRow
        label="Events"
        answer={
          failed
            ? "Could not be loaded"
            : events.data === undefined
              ? ""
              : eventsSummary(stored, unsaved)
        }
        open={shown}
        onOpenChange={showSection}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="grid min-w-0 flex-1 basis-64 gap-1">
            <p className="max-w-help text-pretty text-note text-reed">
              One line the story is given now and then, by chance.
            </p>
            {atLimit && <p className="max-w-help text-pretty text-note text-reed">{LIMIT_NOTE}</p>}
          </div>
          {!empty && !failed && newEvent}
        </div>
        {events.isError && !failed && (
          <p className="text-note text-reed">The events could not be refreshed.</p>
        )}
        {failed ? (
          <div role="alert" className="grid justify-items-start gap-2">
            <p className="text-ember text-note">The events could not be loaded.</p>
            <Button variant="outline" onClick={() => void events.refetch()}>
              Try again
            </Button>
          </div>
        ) : events.data === undefined ? (
          <div aria-busy="true" className="min-h-16" />
        ) : empty ? (
          <div className="grid justify-items-start gap-3">
            <p className="max-w-empty text-pretty text-reed text-ui">
              No events yet. An event is one line the story is given now and then, such as
              'Introduce a new character'.
            </p>
            {newEvent}
          </div>
        ) : (
          <ul aria-label="Events" className="grid border-rush border-t">
            {items}
          </ul>
        )}
      </SettingsRow>
      {/* Hidden in the closed row, a failed save is said here, where it can be seen. */}
      {!shown && unsaved > 0 && (
        <p role="alert" className="pb-3 text-pretty text-ember text-note">
          {countOf(unsaved, "event")} {unsaved === 1 ? "is" : "are"} not saved. Open Events to
          retry.
        </p>
      )}
      {leaveGuard}
    </section>
  );
}

/**
 * Where a deleted event was: what went, with Undo, said as a status. Focus
 * moves to Undo; the line stays while it holds focus or the pointer, then
 * leaves after a while, its height closing with a fade (a fade alone under
 * reduced motion).
 */
function RemovedRow({
  text,
  failure,
  restoring,
  onUndo,
  onLapse,
}: {
  text: string;
  failure: string | null;
  /** Undo's request is on its way: Undo waits for it. */
  restoring: boolean;
  onUndo: () => void;
  onLapse: () => void;
}) {
  const undoButton = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const held = hovered || focused || restoring || failure !== null;
  useEffect(() => {
    undoButton.current?.focus();
  }, []);
  useEffect(() => {
    if (held) {
      setLeaving(false);
      return;
    }
    const timer = setTimeout(() => setLeaving(true), UNDO_MS);
    return () => clearTimeout(timer);
  }, [held]);
  return (
    <li
      data-removed=""
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget && event.propertyName === "opacity")
          onLapse();
      }}
      className={cn(
        "overflow-clip border-rush border-b transition-[height,opacity] duration-(--duration-panel-out) ease-spring [interpolate-size:allow-keywords] motion-reduce:transition-opacity starting:opacity-0",
        leaving ? "h-0 opacity-0" : "h-auto",
      )}
    >
      <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5">
        <p role="status" className="min-w-0 flex-1 basis-48 truncate text-reed text-ui">
          Deleted {text}.
        </p>
        <Button
          ref={undoButton}
          variant="outline"
          disabled={restoring}
          focusableWhenDisabled
          onClick={onUndo}
        >
          Undo
        </Button>
        {failure !== null && (
          <p role="alert" className="basis-full text-pretty text-ember text-note">
            {failure}
          </p>
        )}
      </div>
    </li>
  );
}
