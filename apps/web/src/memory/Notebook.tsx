import {
  MEMORY_LIMITS,
  type MemoryState,
  memoryNotebookSchema,
  memoryStateSchema,
} from "@ephemera/core";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useReducer, useRef, useState } from "react";
import { z } from "zod";
import { useCoarsePointer } from "@/app/form-factor.ts";
import { CloseIcon, PlusIcon, RegenerateIcon, UndoIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { REMEMBERING } from "../chat/MemorySeam.tsx";
import { chatStore } from "../chat/session.ts";
import { currentSettings, useSettings } from "../settings/settings.ts";
import { useAutosave } from "../sheet/autosave.ts";
import { SHEET_GRID } from "../sheet/fields.ts";
import { MemoryFailureAction } from "./FailureAction.tsx";
import { FAILURE_ACTION_LABEL, openingFailureNote } from "./failure.ts";
import {
  type OpeningWrite,
  type OpeningWriteEvent,
  openingRequestFor,
  openingWriteAfter,
  regenerateReason,
} from "./memory.ts";
import { publishMemoryState, saveMemoryState, writeOpening } from "./queries.ts";

/*
 * The notebook, where things stand: the situation as a few sentences, the
 * next chat's opening beside it, the relationships, the facts, the open
 * threads and the cast as lines, edited in place and saved as they change on
 * the sheets' one autosave. The autosave knows a missing name as
 * "nothing to save yet"; the notebook always has something to save, so the
 * situation plays the name and may be empty.
 */

type NotebookFields = {
  name: string;
  opening: string;
  relationships: string[];
  facts: string[];
  threads: string[];
  cast: string[];
};

/**
 * Blank lines are lines being written: they stay on screen and are not saved.
 * A cast line is saved as written within its bounds; one that does not read
 * as a person seeds no chat (`readMemoryCastLine`), so it is not refused here.
 */
const lines = (schema: typeof memoryNotebookSchema.shape.facts) =>
  z
    .array(z.string())
    .transform((list) => list.map((line) => line.trim()).filter((line) => line !== ""))
    .pipe(schema);

const saveSchema: z.ZodType<NotebookFields> = z.strictObject({
  name: memoryNotebookSchema.shape.situation,
  opening: memoryStateSchema.shape.opening,
  relationships: lines(memoryNotebookSchema.shape.relationships),
  facts: lines(memoryNotebookSchema.shape.facts),
  threads: lines(memoryNotebookSchema.shape.threads),
  cast: lines(memoryNotebookSchema.shape.cast.unwrap()),
});

const LABELS: Record<keyof NotebookFields, string> = {
  name: "The situation",
  opening: "The next chat's opening",
  relationships: "A relationship",
  facts: "A fact",
  threads: "An open thread",
  cast: "A cast line",
};

/** The notebook row's text as last saved: the notebook and the next chat's opening. */
type NotebookText = Pick<MemoryState, "notebook" | "opening">;

/**
 * Saves a notebook edit against `revision`: the notebook whole and the
 * opening, each the changed parts over `base`, the row as last saved.
 */
export function saveNotebook(
  characterId: string,
  base: NotebookText,
  patch: Partial<NotebookFields>,
  revision: number,
) {
  const { notebook } = base;
  return saveMemoryState(
    characterId,
    {
      notebook: {
        situation: patch.name ?? notebook.situation,
        relationships: patch.relationships ?? notebook.relationships,
        facts: patch.facts ?? notebook.facts,
        threads: patch.threads ?? notebook.threads,
        cast: patch.cast ?? notebook.cast,
      },
      opening: patch.opening ?? base.opening,
    },
    revision,
  );
}

/**
 * The notebook's fields and their autosave. The server takes the notebook
 * whole, so a save carries the changed parts over the notebook as last
 * saved (`saveNotebook`). `onSeen` reports each revision this editor saved.
 */
export function useNotebook(characterId: string, state: MemoryState, onSeen: (n: number) => void) {
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<NotebookFields>(() => ({
    name: state.notebook.situation,
    opening: state.opening,
    relationships: state.notebook.relationships,
    facts: state.notebook.facts,
    threads: state.notebook.threads,
    cast: state.notebook.cast,
  }));
  const saved = useRef<NotebookText>(state);
  const autosave = useAutosave<NotebookFields, MemoryState>({
    id: characterId,
    revision: state.revision,
    fields,
    schema: saveSchema,
    labels: LABELS,
    wholeLabel: "The notebook",
    save: (id, patch, revision) => saveNotebook(id, saved.current, patch, revision),
    onSaved: (id, next) => {
      saved.current = next;
      onSeen(next.revision);
      void publishMemoryState(queryClient, id, next);
      chatStore.getState().schedulePreview();
    },
  });
  const edit = (patch: Partial<NotebookFields>) => {
    setFields((current) => ({ ...current, ...patch }));
    autosave.touch(...(Object.keys(patch) as (keyof NotebookFields)[]));
  };
  return { fields, edit, autosave };
}

/**
 * Memory prose, open on the page: muted as it reads, in ink while written.
 * A pointer over it brings up the field's edge and a faint wash, and the
 * text darkens, so it reads as editable before it is clicked; focus makes
 * it a field outright.
 */
const PROSE_FIELD =
  "w-full cursor-text resize-none rounded-md border border-transparent bg-transparent px-2 py-1 font-story text-reed text-turn [field-sizing:content] outline-none transition-[border-color,background-color,color,box-shadow] duration-(--duration-quick) ease-fade placeholder:text-reed hover:border-rush hover:bg-surface-hover hover:text-ink focus:border-dusk-line focus:bg-surface focus:text-ink focus:shadow-focus read-only:cursor-default read-only:hover:border-transparent read-only:hover:bg-transparent read-only:hover:text-reed";

const MARGIN_LABEL =
  "mb-2 font-semibold text-ink text-ui tablet:mb-0 tablet:pt-1.5 tablet:text-right";

/** Line breaks of any kind: a relationship, a fact, a thread or a cast line is one line. */
const BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/g;

/**
 * What Regenerate needs of the screen: the character, whether its memory
 * is on and holds anything to write from (as saved), and what to do before
 * the call reads the saved notebook: save the edits on their way, false
 * when they could not be (a conflict, a field refused, a failed save).
 */
interface OpeningSource {
  characterId: string;
  name: string;
  on: boolean;
  remembered: boolean;
  beforeWrite: () => Promise<boolean>;
}

/**
 * The notebook's fields; `readOnly` holds them as they are (memory turning
 * off). While Regenerate writes the opening they are held the same way, so
 * no edit lands under an answer written from the notebook before it.
 */
export function NotebookEditor({
  fields,
  readOnly = false,
  source,
  onChange,
}: {
  fields: NotebookFields;
  readOnly?: boolean;
  /** Regenerate's source; without one the opening is edited by hand alone. */
  source?: OpeningSource;
  onChange: (patch: Partial<NotebookFields>) => void;
}) {
  const situationId = useId();
  const [write, dispatch] = useReducer(openingWriteAfter, { kind: "idle" });
  const writing = write.kind === "writing";
  const held = readOnly || writing;
  return (
    <>
      <div className={SHEET_GRID}>
        <label htmlFor={situationId} className={MARGIN_LABEL}>
          Situation
        </label>
        <textarea
          id={situationId}
          value={fields.name}
          readOnly={held}
          aria-busy={writing}
          maxLength={MEMORY_LIMITS.situation}
          placeholder="Where the story stands now, in a few sentences."
          onChange={(event) => onChange({ name: event.target.value })}
          // On touch, with no pointer to bring up its edge, the field keeps its lower rule at rest.
          className={cn(PROSE_FIELD, "-mx-2 min-h-13 touch:border-b-rush", writing && REMEMBERING)}
        />
      </div>
      <OpeningField
        opening={fields.opening}
        readOnly={readOnly}
        write={write}
        dispatch={dispatch}
        source={source}
        onChange={(opening) => onChange({ opening })}
      />
      <Lines
        label="Relationships"
        item="relationship"
        lines={fields.relationships}
        max={MEMORY_LIMITS.relationships}
        readOnly={held}
        pending={writing}
        onChange={(relationships) => onChange({ relationships })}
      />
      <Lines
        label="Facts"
        item="fact"
        lines={fields.facts}
        max={MEMORY_LIMITS.facts}
        readOnly={held}
        pending={writing}
        onChange={(facts) => onChange({ facts })}
      />
      <Lines
        label="Open threads"
        item="thread"
        lines={fields.threads}
        max={MEMORY_LIMITS.threads}
        readOnly={held}
        pending={writing}
        onChange={(threads) => onChange({ threads })}
      />
      <Lines
        label="Cast"
        item="cast line"
        lines={fields.cast}
        max={MEMORY_LIMITS.cast}
        maxLength={MEMORY_LIMITS.castLine}
        readOnly={held}
        pending={writing}
        help={
          <>
            People the story invented and keeps meeting, one per line in JSON: a name, a gender
            (female, male or other) and only details that stay fixed, never what they are doing. For
            example,{" "}
            <code className="break-all">
              {'{"name":"Ilse Brandt","gender":"female","age":"31","hair":"black bob"}'}
            </code>
            . A line that does not read this way stays here but brings no one into a new chat.
          </>
        }
        onChange={(cast) => onChange({ cast })}
      />
    </>
  );
}

/** A quiet action in a line of small text beside the field, 44px on touch, as a failure's way out is. */
const OPENING_ACTION = "h-8 gap-1.5 px-2 text-ink text-note touch:h-11";

/**
 * The next chat's opening, edited by hand, or written again from what is
 * remembered by Regenerate beside its label. While it writes, the notebook
 * holds still and breathes; written, the new text goes through the
 * notebook's own edit, so autosave keeps it, and Undo puts the previous text
 * back the same way until the opening is edited or written again. A
 * failure says why under the field. The text lives here and in the
 * notebook's saved row only; leaving, another character or memory turning
 * off ends the call, and its answer goes nowhere. `write` is the editor's,
 * which holds the other fields while it runs.
 */
function OpeningField({
  opening,
  readOnly,
  write,
  dispatch,
  source,
  onChange,
}: {
  opening: string;
  readOnly: boolean;
  write: OpeningWrite;
  dispatch: (event: OpeningWriteEvent) => void;
  source: OpeningSource | undefined;
  onChange: (opening: string) => void;
}) {
  const fieldId = useId();
  const helpId = useId();
  const reasonId = useId();
  const coarse = useCoarsePointer();
  const settings = useSettings();
  const running = useRef<AbortController | null>(null);
  const characterId = source?.characterId;
  // Leaving the screen, or another character, ends the call; its answer goes nowhere.
  useEffect(() => {
    if (characterId === undefined) return;
    return () => {
      running.current?.abort();
      running.current = null;
    };
  }, [characterId]);
  // Memory turning off ends the call too: its answer would land in a notebook closing.
  useEffect(() => {
    if (!readOnly || running.current === null) return;
    running.current.abort();
    running.current = null;
    dispatch({ type: "stopped" });
  }, [readOnly, dispatch]);
  const writing = write.kind === "writing";
  const reason =
    source === undefined
      ? null
      : regenerateReason({
          name: source.name,
          on: source.on,
          remembered: source.remembered,
          model: openingRequestFor(settings)?.model ?? null,
        });
  const regenerate = async () => {
    if (source === undefined || writing || readOnly) return;
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    dispatch({ type: "start" });
    // The call reads the saved notebook: edits on their way are saved first, or it waits.
    const saved = await source.beforeWrite();
    if (controller.signal.aborted || running.current !== controller) return;
    if (!saved) {
      running.current = null;
      return dispatch({ type: "failed", reason: "unsaved" });
    }
    const request = openingRequestFor(currentSettings());
    if (request === null) {
      running.current = null;
      return dispatch({ type: "failed", reason: "no_model" });
    }
    const accounting = chatStore.getState().trackUsage("memory.opening", request.model);
    let received = false;
    const outcome = await writeOpening(
      source.characterId,
      request,
      controller.signal,
      (receipt) => {
        received = true;
        accounting.receive(receipt);
      },
    );
    accounting.finish(
      received
        ? undefined
        : outcome.ok
          ? "completed"
          : controller.signal.aborted
            ? "aborted"
            : ["unreachable", "timeout", "memory_failed", "upstream_busy"].includes(outcome.reason)
              ? "failed"
              : undefined,
    );
    if (controller.signal.aborted || running.current !== controller) return;
    running.current = null;
    if (!outcome.ok) return dispatch({ type: "failed", reason: outcome.reason });
    dispatch({ type: "written", previous: opening });
    onChange(outcome.opening);
  };
  const note = write.kind === "failed" ? openingFailureNote(write.reason) : null;
  const button = source !== undefined && (
    <Button
      variant="quiet"
      className={cn(OPENING_ACTION, "-mr-2")}
      disabled={reason !== null || writing || readOnly}
      focusableWhenDisabled
      aria-describedby={coarse && reason !== null ? reasonId : undefined}
      onClick={() => void regenerate()}
    >
      <RegenerateIcon size={16} />
      {writing ? "Writing…" : "Regenerate"}
    </Button>
  );
  return (
    <div className={SHEET_GRID}>
      <div className="mb-2 flex items-center justify-between gap-2 tablet:mb-0 tablet:flex-col tablet:items-end tablet:justify-start tablet:gap-1">
        <label htmlFor={fieldId} className={cn(MARGIN_LABEL, "mb-0")}>
          Next chat opens with
        </label>
        {button !== false &&
          (reason === null || coarse ? button : <Tooltip label={reason}>{button}</Tooltip>)}
      </div>
      <div className="grid gap-1">
        <textarea
          id={fieldId}
          value={opening}
          readOnly={readOnly || writing}
          aria-busy={writing}
          maxLength={MEMORY_LIMITS.opening}
          aria-describedby={helpId}
          onChange={(event) => {
            dispatch({ type: "edited" });
            onChange(event.target.value);
          }}
          className={cn(PROSE_FIELD, "-mx-2 min-h-13 touch:border-b-rush", writing && REMEMBERING)}
        />
        {/* One region for what Regenerate did, so each change is announced; empty, it takes no room. */}
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-1 text-note text-reed empty:hidden [&>p]:py-1.5"
        >
          {writing && (
            <p className="sr-only">Writing a new opening from what {source?.name} remembers…</p>
          )}
          {write.kind === "done" && (
            <>
              <p>A new opening is written.</p>
              <Button
                variant="quiet"
                className={OPENING_ACTION}
                disabled={readOnly}
                onClick={() => {
                  if (readOnly) return;
                  onChange(write.previous);
                  dispatch({ type: "edited" });
                }}
              >
                <UndoIcon size={16} />
                Undo
              </Button>
            </>
          )}
          {note !== null && source !== undefined && (
            <>
              <p className="text-pretty">{note.text}</p>
              {note.action === "retry" ? (
                <Button
                  variant="quiet"
                  className={OPENING_ACTION}
                  disabled={reason !== null || readOnly}
                  onClick={() => void regenerate()}
                >
                  {FAILURE_ACTION_LABEL.retry}
                </Button>
              ) : (
                <MemoryFailureAction action={note.action} characterId={source.characterId} />
              )}
            </>
          )}
          {coarse && reason !== null && write.kind === "idle" && (
            <p id={reasonId} className="text-pretty">
              Regenerate waits. {reason}
            </p>
          )}
        </div>
        <p id={helpId} className="text-pretty text-note text-reed">
          Where the next chat begins: a Location line, then one sentence placing everyone. Empty,
          the card's own greeting opens it.
        </p>
      </div>
    </div>
  );
}

/**
 * Where focus goes once the line `at` of `length` is removed: `then` when
 * given (Backspace's line before), else the line that takes its place, else
 * the line before; null when none is left, for the Add button.
 */
export function focusAfterRemoval(at: number, length: number, then?: number): number | null {
  const left = length - 1;
  if (left === 0) return null;
  return Math.min(then ?? at, left - 1);
}

/**
 * A ruled list of lines: each edits in place; Enter starts the next line,
 * Backspace in an empty line removes it, and focus follows to the line
 * that takes its place, or to Add once the last is gone. `help`, when
 * given, describes every line under the list.
 */
function Lines({
  label,
  item,
  lines: list,
  max,
  maxLength = MEMORY_LIMITS.line,
  readOnly,
  pending,
  help,
  onChange,
}: {
  label: string;
  item: string;
  lines: string[];
  max: number;
  /** Characters of one line. */
  maxLength?: number;
  readOnly: boolean;
  /** Held while the opening is written: the lines breathe as its field does. */
  pending: boolean;
  help?: ReactNode;
  onChange: (lines: string[]) => void;
}) {
  const helpId = useId();
  const fields = useRef<(HTMLTextAreaElement | null)[]>([]);
  const add = useRef<HTMLButtonElement>(null);
  /** The line to focus once it renders; "add" for the Add button. */
  const [focusAt, setFocusAt] = useState<number | "add" | null>(null);
  useEffect(() => {
    if (focusAt === null) return;
    (focusAt === "add" ? add.current : fields.current[focusAt])?.focus();
    setFocusAt(null);
  }, [focusAt]);
  const full = list.length >= max;
  const insert = (at: number) => {
    if (full) return;
    onChange([...list.slice(0, at), "", ...list.slice(at)]);
    setFocusAt(at);
  };
  /** Removes a line; focus follows as `focusAfterRemoval` says. */
  const remove = (at: number, then?: number) => {
    onChange(list.filter((_, other) => other !== at));
    setFocusAt(focusAfterRemoval(at, list.length, then) ?? "add");
  };
  return (
    <fieldset className={cn(SHEET_GRID, "min-w-0")} aria-busy={pending}>
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className={MARGIN_LABEL}>
        {label}
      </span>
      <div className="grid justify-items-start gap-1">
        {list.length > 0 && (
          <ul className={cn("grid w-full", pending && REMEMBERING)}>
            {list.map((line, at) => (
              // Lines have no identity but their place; focus follows the place.
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a line is its position in the list.
                key={at}
                className="group/line flex min-w-0 items-start gap-1 border-rush border-b py-1"
              >
                <textarea
                  ref={(element) => {
                    fields.current[at] = element;
                  }}
                  rows={1}
                  aria-label={`${label}, line ${at + 1}`}
                  value={line}
                  readOnly={readOnly}
                  maxLength={maxLength}
                  aria-describedby={help === undefined ? undefined : helpId}
                  onKeyDown={(event) => {
                    if (readOnly || isComposing(event)) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      insert(at + 1);
                    } else if (event.key === "Backspace" && line === "") {
                      event.preventDefault();
                      remove(at, Math.max(0, at - 1));
                    }
                  }}
                  onChange={(event) => {
                    const next = [...list];
                    next[at] = event.target.value.replace(BREAKS, " ");
                    onChange(next);
                  }}
                  className={cn(PROSE_FIELD, "-ml-2")}
                />
                <Button
                  size="icon"
                  aria-label={`Remove this ${item}`}
                  disabled={readOnly}
                  onClick={() => remove(at)}
                  className="size-8 opacity-0 transition-opacity duration-(--duration-quick) ease-fade focus-visible:opacity-100 group-focus-within/line:opacity-100 group-hover/line:opacity-100 touch:size-11 touch:opacity-100"
                >
                  <CloseIcon size={16} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button
          ref={add}
          variant="quiet"
          className="-ml-3.5 gap-1.5"
          disabled={full || readOnly}
          focusableWhenDisabled
          onClick={() => insert(list.length)}
        >
          <PlusIcon size={16} />
          {full ? `${max} ${item}s is the most a notebook keeps` : `Add a ${item}`}
        </Button>
        {help !== undefined && (
          <p id={helpId} className="text-pretty text-note text-reed">
            {help}
          </p>
        )}
      </div>
    </fieldset>
  );
}
