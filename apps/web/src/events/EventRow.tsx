import { Collapsible } from "@base-ui/react/collapsible";
import {
  type CharacterSummary,
  EVENT_LIMITS,
  type EventFields,
  eventFieldsSchema,
  type StoredEvent,
} from "@ephemera/core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { NoticeCard } from "../app/NoticeCard.tsx";
import { isFailure, type SaveStatus, saveStatusText, useAutosave } from "../sheet/autosave.ts";
import { ConflictNotice, useReload } from "../sheet/ConflictNotice.tsx";
import { type EventSaveFields, eventSaving, fromSaveFields, toSaveFields } from "./autosave.ts";
import { EventEditor } from "./EventEditor.tsx";
import { deleteEvent } from "./queries.ts";
import { ruleSentence, scopeSummary } from "./rule.ts";

/** A new event's fields: often enough to notice, quiet for a while after, everyone, on. */
const NEW_EVENT: EventFields = {
  text: "",
  chance: 5,
  cooldown: 10,
  enabled: true,
  scope: { kind: "all" },
};

/** The fields of a stored event, without what the server keeps about it. */
export const fieldsOf = ({ text, chance, cooldown, enabled, scope }: StoredEvent): EventFields => ({
  text,
  chance,
  cooldown,
  enabled,
  scope,
});

/** A fade for text that changed in place: it shows the change without moving anything. */
export const SWAP = "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

const LIMIT_TEXT = `Not saved: ${EVENT_LIMITS.events} events is the most Ephemera keeps. Delete one to add another.`;

/** What a row tells its section about saving: for the one leave guard and the closed row. */
export interface RowSaving {
  status: SaveStatus;
  creating: boolean;
  /** The row says it could not save (or delete): a notice the closed section must surface. */
  failing: boolean;
  hasUnsaved: () => boolean;
  flush: () => Promise<boolean>;
}

/** A new event with a blank instruction holds nothing to keep: its row discards it on closing. */
const NOTHING_UNSAVED = () => false;

/**
 * What a row reports of its saving. A new event whose instruction is blank
 * never blocks leaving; an existing one whose instruction was cleared, or one
 * deleted elsewhere with edits here, is not saved, like a failed save, and
 * the closed section says so.
 */
export function rowSaving(
  autosave: Pick<RowSaving, "status" | "hasUnsaved" | "flush">,
  { creating, blank, failure }: { creating: boolean; blank: boolean; failure: string | null },
): RowSaving {
  const { status, hasUnsaved, flush } = autosave;
  return {
    status,
    creating,
    failing:
      failure !== null ||
      status.kind === "conflict" ||
      status.kind === "gone" ||
      (status.kind === "needs-name" && !creating),
    hasUnsaved: creating && blank ? NOTHING_UNSAVED : hasUnsaved,
    flush,
  };
}

interface EventRowProps {
  /** The row's key in the list, on its element for focus. */
  rowKey: string;
  /** The saved event, or null for a new one not saved yet. */
  stored: StoredEvent | null;
  /** Every character, or undefined until the list has loaded. */
  characters: readonly CharacterSummary[] | undefined;
  names: ReadonlyMap<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refetches the list; a conflict's Reload then reopens the row on the saved event. */
  refetch: () => Promise<{ isSuccess: boolean }>;
  /** The first save of a new event made it under this id. */
  onCreated: (id: string) => void;
  onSaved: (saved: StoredEvent) => void;
  /** Deleted (or never saved): the fields Undo can bring back, null when there is nothing to. */
  onRemoved: (restore: EventFields | null) => void;
  /** The row's saving as it changes, by its key; null once the row is gone. */
  onSaving: (rowKey: string, saving: RowSaving | null) => void;
  /** A new row: arrives with the list's motion and focuses its instruction. */
  arrived: boolean;
  /** The saved event is no longer listed (deleted elsewhere); `stored` is as last seen. */
  gone: boolean;
  /** Gone with nothing unsaved here: the row goes with its event, by its key. */
  onGone: (rowKey: string) => void;
  /** Gone with edits here, which the owner gave up: the row goes. */
  onDiscard: () => void;
}

const GONE = { kind: "gone" } as const;

const SAVE_KEYS = Object.keys(toSaveFields(NEW_EVENT)) as (keyof EventSaveFields)[];

/**
 * One event: its instruction, its rule as a sentence and its scope, with an
 * on/off switch beside the disclosure, never inside it. Open, it edits in
 * place. A conflict's Reload remounts the row on the saved event; the open
 * state stays with the list. Deleted elsewhere, a row with nothing unsaved
 * goes; one with edits stays as it was, saving nothing, until Discard edits.
 */
export function EventRow(props: EventRowProps) {
  const [round, reload] = useReload(props.refetch);
  return <EventRowBody key={round} {...props} onReload={reload} />;
}

function EventRowBody({
  rowKey,
  stored,
  characters,
  names,
  open,
  onOpenChange,
  onCreated,
  onSaved,
  onRemoved,
  onSaving,
  arrived,
  gone,
  onGone,
  onDiscard,
  onReload,
}: EventRowProps & { onReload: () => Promise<void> }) {
  const [fields, setFields] = useState<EventSaveFields>(() =>
    toSaveFields(stored === null ? NEW_EVENT : fieldsOf(stored)),
  );
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  /** A deletion is on its way: one at a time, so the event is removed (and restorable) once. */
  const deleting = useRef(false);
  const [removing, setRemoving] = useState(false);
  /** The average fades only after the owner changes the numbers here, never on opening. */
  const [lively, setLively] = useState(false);
  const id = stored?.id ?? createdId;
  const autosave = useAutosave<EventSaveFields, StoredEvent>({
    id: stored?.id ?? null,
    revision: stored?.revision ?? 0,
    fields,
    ...eventSaving(() => setLimited(true)),
    onCreated: (created) => {
      setCreatedId(created);
      onCreated(created);
    },
    onSaved: (_id, saved) => onSaved(saved),
  });
  const { status, pause, resume, settle, isUnsaved } = autosave;
  const creating = id === null;
  /** Deleted elsewhere with edits here: they stay, saving nothing, until the owner discards them. */
  const [orphaned, setOrphaned] = useState(false);
  const unsaved = autosave.hasUnsaved;
  useLayoutEffect(() => {
    // A deletion from here decides the row itself: removed with its Undo, or kept when it failed.
    if (removing) return;
    if (!gone) {
      // Listed (again), or a deletion here failed: saving goes on.
      setOrphaned(false);
      resume();
      return;
    }
    // Before paint: a row with nothing unsaved goes with its event, so it is never seen gone.
    if (!unsaved()) {
      onGone(rowKey);
      return;
    }
    pause();
    setOrphaned(true);
    let live = true;
    // A save on its way may carry every edit here: once it settles, a row left with none goes too.
    void settle().then(() => {
      if (live && !SAVE_KEYS.some((key) => isUnsaved(key))) onGone(rowKey);
    });
    return () => {
      live = false;
    };
  }, [gone, removing, rowKey, onGone, unsaved, settle, isUnsaved, pause, resume]);

  const change = (patch: Partial<EventSaveFields>) => {
    if ("chance" in patch || "cooldown" in patch) setLively(true);
    setLimited(false);
    setFields((current) => ({ ...current, ...patch }));
    autosave.touch(...(Object.keys(patch) as (keyof EventSaveFields)[]));
  };

  const remove = async () => {
    if (deleting.current) return;
    deleting.current = true;
    setRemoving(true);
    setDeleteFailed(false);
    // A save may be on its way (a new event's first one): stop saving, keeping the edits,
    // wait for it, and delete what it made.
    autosave.pause();
    const saved = await autosave.settle();
    if (saved !== null && !(await deleteEvent(saved))) {
      // Still here: once the deletion ends, the row saves again unless the list no longer has
      // its event, and leaving still asks.
      deleting.current = false;
      setRemoving(false);
      setDeleteFailed(true);
      return;
    }
    autosave.discard();
    // What Undo brings back: the fields as they are now, or as last saved when those are blank.
    const now = eventFieldsSchema.safeParse(fromSaveFields(fields));
    onRemoved(
      saved === null ? null : now.success ? now.data : stored === null ? null : fieldsOf(stored),
    );
  };

  const instructionId = useId();
  const ruleId = useId();
  const scopeId = useId();
  const blank = fields.name.trim() === "";
  const instruction = blank ? (stored === null ? "New event" : "No instructions") : fields.name;
  const rule = ruleSentence(fields);
  const scope = scopeSummary(fields.scope, names);
  const failure = limited
    ? LIMIT_TEXT
    : deleteFailed
      ? "Not deleted: Ephemera could not be reached."
      : // Orphaned, its notice says why nothing saves; a retry could not.
        !orphaned &&
          status.kind !== "conflict" &&
          status.kind !== "needs-name" &&
          isFailure(status, creating)
        ? saveStatusText(status, creating, "event")
        : null;
  // Orphaned, the edits cannot be saved: the section and leaving say so, whatever the autosave last said.
  const reported = orphaned ? GONE : status;
  const { failing, hasUnsaved, flush } = rowSaving(
    { status: reported, hasUnsaved: autosave.hasUnsaved, flush: autosave.flush },
    { creating, blank, failure },
  );
  useEffect(() => {
    onSaving(rowKey, { status: reported, creating, failing, hasUnsaved, flush });
  }, [onSaving, rowKey, reported, creating, failing, hasUnsaved, flush]);
  useEffect(() => () => onSaving(rowKey, null), [onSaving, rowKey]);

  return (
    <li data-event={rowKey} className={cn("border-rush border-b", arrived && "arrive")}>
      <Collapsible.Root
        open={open}
        onOpenChange={(next) => {
          // A new event left blank goes when its row closes; a saved one stays, not saved, and says so.
          if (!next && blank && creating) void remove();
          else onOpenChange(next);
        }}
      >
        {/* The switch sits over the trigger's middle column: a sibling with its own touch area. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-3">
          <Collapsible.Trigger
            data-disclosure=""
            aria-labelledby={instructionId}
            aria-describedby={`${ruleId} ${scopeId}`}
            className="group/row col-span-3 col-start-1 row-start-1 grid min-h-16 grid-cols-subgrid items-start gap-y-1 rounded-sm px-1 py-3 text-left outline-none hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--dusk-line)] touch:py-3.5"
          >
            <span
              id={instructionId}
              title={blank ? undefined : fields.name}
              className={cn(
                "col-start-1 row-start-1 truncate font-medium text-ui",
                fields.enabled && !blank ? "text-ink" : "text-reed",
              )}
            >
              {instruction}
            </span>
            <ChevronDownIcon
              size={16}
              className="col-start-3 row-start-1 mt-0.5 text-reed transition-[rotate] duration-(--duration-arrive) ease-spring group-data-panel-open/row:rotate-180 motion-reduce:transition-none"
            />
            <span
              id={ruleId}
              className="col-span-3 col-start-1 row-start-2 text-pretty text-note text-reed tablet:col-span-1"
            >
              <RuleText rule={rule} lively={lively} />
            </span>
            <span
              id={scopeId}
              className="col-span-3 col-start-1 row-start-3 text-pretty text-note text-reed tablet:col-span-1"
            >
              {scope}
            </span>
          </Collapsible.Trigger>
          {/* Its own grid item: the switch renders an input beside itself, which must not take a cell. */}
          <div className="col-start-2 row-start-1 mt-3 flex touch:mt-3.5">
            <Switch
              aria-label={`Enable ${instruction}`}
              checked={fields.enabled}
              disabled={fields.name.trim() === ""}
              onCheckedChange={(enabled) => change({ enabled })}
            />
          </div>
        </div>
        {orphaned && (
          <div className="px-1 pb-3">
            <NoticeCard
              role="alert"
              data-orphaned=""
              placement="dock"
              title="Deleted elsewhere"
              body="This event was deleted in another tab, so the edits here cannot be saved. Copy anything you want to keep, then discard them."
              actions={
                <Button
                  variant="outline"
                  className="px-2.5"
                  onClick={() => {
                    autosave.discard();
                    onDiscard();
                  }}
                >
                  Discard edits
                </Button>
              }
            />
          </div>
        )}
        {!orphaned && status.kind === "needs-name" && (
          <p className="px-1 pb-3 text-note text-reed">Write the instruction to save this event.</p>
        )}
        {failure !== null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-3">
            <p role="alert" className="text-pretty text-ember text-note">
              {failure}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                if (deleteFailed) void remove();
                else {
                  setLimited(false);
                  void autosave.flush();
                }
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {!orphaned && status.kind === "conflict" && (
          <ConflictNotice
            noun="event"
            placement="footer"
            onReload={onReload}
            onKeepMine={() => void autosave.keepMine()}
          />
        )}
        <Collapsible.Panel
          keepMounted
          inert={!open}
          className="-mx-1.5 h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-panel-in) ease-spring data-ending-style:h-0 data-starting-style:h-0 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-[opacity] motion-reduce:duration-(--duration-quick) motion-reduce:ease-fade [&[hidden]]:hidden"
        >
          {/* The inset keeps focus rings inside the clipped panel. */}
          <div className="px-2.5 pt-1 pb-6">
            <EventEditor
              fields={fields}
              characters={characters}
              rule={<RuleText rule={rule} lively={lively} />}
              focusOnMount={arrived}
              onChange={change}
              deleting={removing}
              onDelete={() => void remove()}
            />
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </li>
  );
}

/** The rule sentence; its average fades in when the numbers change, in the same place. */
function RuleText({ rule, lively }: { rule: ReturnType<typeof ruleSentence>; lively: boolean }) {
  if (rule.average === null) return rule.lead;
  return (
    <>
      {rule.lead}{" "}
      <span key={rule.average} className={cn("tabular-nums", lively && SWAP)}>
        {rule.average}
      </span>
    </>
  );
}
