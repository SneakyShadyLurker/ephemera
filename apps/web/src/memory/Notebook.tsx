import {
  CAST_ANCHOR_FIELDS,
  CAST_LIMITS,
  type CastAnchorField,
  type CastGender,
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
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { CAST_FIELD_LABELS } from "../chat/cast-ui.ts";
import { chatStore } from "../chat/session.ts";
import { currentSettings, useSettings } from "../settings/settings.ts";
import { useAutosave } from "../sheet/autosave.ts";
import { FIELD, HELP, NOTEBOOK_GRID, sheetLabel } from "../sheet/fields.ts";
import {
  CAST_GENDERS,
  type CastLinePerson,
  castLineDetails,
  castLineLength,
  castLinePerson,
  castLineText,
} from "./cast-line.ts";
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
 * threads as lines and the cast as people, edited in place and saved as they change on
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

const MARGIN_LABEL = sheetLabel("line");

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
      <div className={NOTEBOOK_GRID}>
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
          className={cn(PROSE_FIELD, "-mx-2 min-h-13 touch:border-b-rush")}
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
      <CastLines
        lines={fields.cast}
        readOnly={held}
        pending={writing}
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
 * holds still and a light passes along the field's lower edge; written, the new text goes through the
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
    <div className={NOTEBOOK_GRID}>
      <div className="mb-2 flex items-center justify-between gap-2 tablet:mb-0 tablet:flex-col tablet:items-end tablet:justify-start tablet:gap-1">
        <label htmlFor={fieldId} className={cn(MARGIN_LABEL, "mb-0")}>
          Next chat opens with
        </label>
        {button !== false &&
          (reason === null || coarse ? button : <Tooltip label={reason}>{button}</Tooltip>)}
      </div>
      <div className="grid gap-1">
        {/* While it is written, one light passes along the field's lower edge; the others hold still. */}
        <div className="relative grid">
          <textarea
            id={fieldId}
            value={opening}
            readOnly={readOnly || writing}
            aria-busy={writing}
            maxLength={MEMORY_LIMITS.opening}
            placeholder="A Location line, then one sentence placing everyone."
            aria-describedby={helpId}
            onChange={(event) => {
              dispatch({ type: "edited" });
              onChange(event.target.value);
            }}
            className={cn(PROSE_FIELD, "-mx-2 min-h-13 touch:border-b-rush")}
          />
          {writing && <span aria-hidden="true" className="lamplight-edge" />}
        </div>
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
        <p id={helpId} className={HELP}>
          Where the next chat begins. Empty, the card's own greeting opens it.
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
 * that takes its place, or to Add once the last is gone.
 */
function Lines({
  label,
  item,
  lines: list,
  max,
  readOnly,
  pending,
  onChange,
}: {
  label: string;
  item: string;
  lines: string[];
  max: number;
  readOnly: boolean;
  /** Held while the opening is written. */
  pending: boolean;
  onChange: (lines: string[]) => void;
}) {
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
    <fieldset className={cn(NOTEBOOK_GRID, "min-w-0")} aria-busy={pending}>
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className={MARGIN_LABEL}>
        {label}
      </span>
      <div className="grid justify-items-start gap-1">
        {list.length > 0 && (
          <ul className="grid w-full">
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
                  maxLength={MEMORY_LIMITS.line}
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
      </div>
    </fieldset>
  );
}

/** A cast detail's words after its label, in the line under a person's name. */
const detailText = (person: CastLinePerson, field: CastAnchorField) =>
  `${CAST_FIELD_LABELS[field].toLowerCase()} ${person[field]?.trim()}`;

/** A small labelled field of a person's form, as the sheet's small fields are. */
const SMALL_FIELD = cn(FIELD, "h-9 py-0 text-ui touch:h-11");

/**
 * The cast: people the story invented and keeps meeting, each a row that
 * reads as their name and fixed details and opens into a form of the same
 * details. What is stored stays a line per person in the same shape; a
 * line that does not read as one that seeds a chat (`castLinePerson`) stays
 * here as written text. Each person opened is held as edited, so one with
 * no name yet keeps what is set while their line is blank and unsaved, and
 * while another is open.
 */
function CastLines({
  lines: list,
  readOnly,
  pending,
  onChange,
}: {
  lines: string[];
  readOnly: boolean;
  /** Held while the opening is written. */
  pending: boolean;
  onChange: (lines: string[]) => void;
}) {
  const helpId = useId();
  const add = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLElement | null)[]>([]);
  /** The person whose form is open. */
  const [open, setOpen] = useState<number | null>(null);
  /** Each person opened, by row, as edited: the same as their line once it has a name. */
  const [drafts, setDrafts] = useState<ReadonlyMap<number, CastLinePerson>>(new Map());
  const keep = (at: number, person: CastLinePerson) =>
    setDrafts((held) => new Map(held).set(at, person));
  /** Where focus goes once it renders: a row, its form's first field, or Add. */
  const [focusAt, setFocusAt] = useState<number | "add" | null>(null);
  useEffect(() => {
    if (focusAt === null) return;
    (focusAt === "add" ? add.current : rows.current[focusAt])?.focus();
    setFocusAt(null);
  }, [focusAt]);
  const full = list.length >= MEMORY_LIMITS.cast;
  const set = (at: number, line: string) =>
    onChange(list.map((old, other) => (other === at ? line : old)));
  const remove = (at: number) => {
    onChange(list.filter((_, other) => other !== at));
    setOpen(null);
    // The rows after it move up one, and their drafts with them.
    setDrafts(
      (held) =>
        new Map(
          [...held]
            .filter(([row]) => row !== at)
            .map(([row, person]) => [row > at ? row - 1 : row, person]),
        ),
    );
    setFocusAt(focusAfterRemoval(at, list.length) ?? "add");
  };
  return (
    <fieldset className={cn(NOTEBOOK_GRID, "min-w-0")} aria-busy={pending}>
      <legend className="sr-only">Cast</legend>
      <span aria-hidden="true" className={MARGIN_LABEL}>
        Cast
      </span>
      <div className="grid justify-items-start gap-1">
        {list.length > 0 && (
          <ul className="grid w-full">
            {list.map((line, at) => {
              const draft = drafts.get(at);
              const person: CastLinePerson | null =
                draft !== undefined && castLineText(draft) === line
                  ? draft
                  : line.trim() === ""
                    ? { name: "", gender: "female" }
                    : castLinePerson(line);
              const removeButton = (
                <Button
                  size="icon"
                  aria-label="Remove this cast line"
                  disabled={readOnly}
                  onClick={() => remove(at)}
                  className="size-8 opacity-0 transition-opacity duration-(--duration-quick) ease-fade focus-visible:opacity-100 group-focus-within/line:opacity-100 group-hover/line:opacity-100 touch:size-11 touch:opacity-100"
                >
                  <CloseIcon size={16} />
                </Button>
              );
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a line is its position in the list.
                <li key={at} className="group/line border-rush border-b py-1">
                  {person === null ? (
                    <div className="flex min-w-0 items-start gap-1">
                      <textarea
                        ref={(element) => {
                          rows.current[at] = element;
                        }}
                        rows={1}
                        aria-label={`Cast, line ${at + 1}`}
                        aria-describedby={helpId}
                        value={line}
                        readOnly={readOnly}
                        maxLength={MEMORY_LIMITS.castLine}
                        onChange={(event) => {
                          const next = event.target.value.replace(BREAKS, " ");
                          set(at, next);
                          // Repaired into a person, or cleared to start one, the line opens as
                          // their form (the rows' own rule), keeping focus in it.
                          if (next.trim() === "" || castLinePerson(next) !== null) {
                            setOpen(at);
                            setFocusAt(at);
                          }
                        }}
                        className={cn(PROSE_FIELD, "-ml-2 font-mono text-note")}
                      />
                      {removeButton}
                    </div>
                  ) : open === at ? (
                    <CastPersonForm
                      person={person}
                      readOnly={readOnly}
                      first={(element) => {
                        rows.current[at] = element;
                      }}
                      onChange={(next) => {
                        keep(at, next);
                        set(at, castLineText(next));
                      }}
                      onDone={() => {
                        setOpen(null);
                        setFocusAt(at);
                      }}
                      remove={removeButton}
                    />
                  ) : (
                    <div className="flex min-w-0 items-start gap-1">
                      <button
                        ref={(element) => {
                          rows.current[at] = element;
                        }}
                        type="button"
                        aria-expanded={false}
                        onClick={() => {
                          setOpen(at);
                          keep(at, person);
                          setFocusAt(at);
                        }}
                        className="-ml-2 grid min-w-0 flex-1 gap-0.5 rounded-md px-2 py-1 text-left row"
                      >
                        <span className="font-story text-ink text-turn">
                          {person.name?.trim() || "Unnamed"}
                        </span>
                        <span className={HELP}>
                          {[
                            person.gender?.trim() &&
                              `${person.gender.charAt(0).toUpperCase()}${person.gender.slice(1)}`,
                            ...castLineDetails(person).map((field) => detailText(person, field)),
                          ]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </button>
                      {removeButton}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Button
          ref={add}
          variant="quiet"
          className="-ml-3.5 gap-1.5"
          disabled={full || readOnly}
          focusableWhenDisabled
          onClick={() => {
            if (full) return;
            onChange([...list, ""]);
            setOpen(list.length);
            keep(list.length, { name: "", gender: "female" });
            setFocusAt(list.length);
          }}
        >
          <PlusIcon size={16} />
          {full ? `${MEMORY_LIMITS.cast} people is the most a notebook keeps` : "Add a person"}
        </Button>
        <p id={helpId} className={HELP}>
          People the story invented and keeps meeting: a name, a gender and only details that stay
          fixed, never what they are doing. A person without a name is not kept. A line that does
          not read as a person stays as written and brings no one into a new chat.
        </p>
      </div>
    </fieldset>
  );
}

/**
 * One person's details, edited in place; Done folds them back into their row.
 * Their line holds `MEMORY_LIMITS.castLine` characters, all fields together,
 * so an edit that would pass it is refused and the form says why.
 */
function CastPersonForm({
  person,
  readOnly,
  first,
  onChange,
  onDone,
  remove,
}: {
  person: CastLinePerson;
  readOnly: boolean;
  /** Takes the name field, which focus lands on as the form opens. */
  first: (element: HTMLInputElement | null) => void;
  onChange: (person: CastLinePerson) => void;
  onDone: () => void;
  remove: ReactNode;
}) {
  const genderId = useId();
  const [full, setFull] = useState(false);
  const change = (next: CastLinePerson) => {
    const fits = castLineLength(next) <= MEMORY_LIMITS.castLine;
    setFull(!fits);
    if (fits) onChange(next);
  };
  const field = (key: string, label: string, maxLength: number, ref?: typeof first) => (
    <label key={key} className="grid gap-1.5">
      <span className="text-note text-reed">{label}</span>
      <input
        ref={ref}
        value={person[key] ?? ""}
        autoComplete="off"
        maxLength={maxLength}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        onChange={(event) => change({ ...person, [key]: event.target.value })}
        className={SMALL_FIELD}
      />
    </label>
  );
  return (
    <div className="grid gap-3 py-2 transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0">
      <div className="grid gap-3 tablet:grid-cols-[minmax(0,1fr)_9rem]">
        {field("name", "Name", CAST_LIMITS.name, first)}
        <div className="grid gap-1.5">
          <span id={genderId} className="text-note text-reed">
            Gender
          </span>
          <Select
            value={person.gender ?? null}
            items={GENDER_LABELS}
            readOnly={readOnly}
            onValueChange={(gender) => {
              if (typeof gender === "string") change({ ...person, gender });
            }}
          >
            <SelectTrigger aria-labelledby={genderId} placeholder="Gender" />
            <SelectContent label="Genders">
              {CAST_GENDERS.map((gender) => (
                <SelectItem key={gender} value={gender}>
                  {GENDER_LABELS[gender]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-3 tablet:grid-cols-2">
        {CAST_ANCHOR_FIELDS.map((key) => field(key, CAST_FIELD_LABELS[key], CAST_LIMITS.field))}
      </div>
      <p role="status" className="text-note text-ember empty:sr-only">
        {full &&
          `This person's details are at the ${MEMORY_LIMITS.castLine.toLocaleString("en")} characters a cast line holds. Shorten one to add more.`}
      </p>
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
        {remove}
      </div>
    </div>
  );
}

const GENDER_LABELS: Record<CastGender, string> = {
  female: "Female",
  male: "Male",
  other: "Other",
};
