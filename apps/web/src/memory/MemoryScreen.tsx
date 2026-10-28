import {
  type CharacterMemory,
  type MemoryState,
  memoryIsOn,
  memoryStateOf,
  notebookHasContent,
} from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useCoarsePointer, useFormFactor } from "@/app/form-factor.ts";
import { SCROLL_GUTTERS } from "@/app/Screen.tsx";
import { MoreIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { countOf } from "@/lib/text";
import { isNotFound } from "../api.ts";
import { characterQuery } from "../characters/queries.ts";
import { chatStore, useChat } from "../chat/session.ts";
import { currentSettings, useSetting, useSettings } from "../settings/settings.ts";
import { isFailure, type SaveStatus } from "../sheet/autosave.ts";
import { ConflictNotice } from "../sheet/ConflictNotice.tsx";
import { SHEET_GRID } from "../sheet/fields.ts";
import {
  type BackTarget,
  LeaveGuardScope,
  SaveState,
  type ScreenSaving,
  SHEET_FRAME,
  SheetHeaderFrame,
  SheetLoading,
  SheetMissing,
  SheetNotice,
  useLeaveGuard,
  useLeaveGuardScope,
  useSheetState,
} from "../sheet/SheetFrame.tsx";
import { notReached } from "../signin/signin.ts";
import { type OpenEpisode, reloadMemory, useEpisodeEditor } from "./EpisodeEditor.tsx";
import { EpisodeList } from "./EpisodeList.tsx";
import { MemoryFailureAction } from "./FailureAction.tsx";
import { failureNote } from "./failure.ts";
import { MEMORY_KEPT, MemorySwitch } from "./MemorySection.tsx";
import { countsText, rememberable, rememberNowHeld, rowAfterDelete } from "./memory.ts";
import { NotebookEditor, useNotebook } from "./Notebook.tsx";
import { forgetMemory, MEMORY_KEY, memoryQuery, refreshMemory } from "./queries.ts";
import { Unfold } from "./Unfold.tsx";

/*
 * A character's memory, as its own screen beside the sheet: the notebook at
 * the top, edited in place, then the memories, newest first. Character data
 * only; the open chat survives the visit, and Remember now works on it.
 */

/** Where the screen was opened from: the chat's Memory mark, or (undefined) the character's sheet. */
type MemoryFrom = "chat" | undefined;

/** Back to the chat that opened the screen, else to the character's sheet. */
const backTo = (id: string, name: string, from: MemoryFrom): BackTarget =>
  from === "chat" ? { to: "/", label: "Chat" } : { to: "/characters/$id", id, label: name };

export function MemoryScreen({ id, from }: { id: string; from?: MemoryFrom }) {
  const character = useQuery(characterQuery(id));
  const memory = useQuery({ ...memoryQuery(id), refetchOnMount: "always" });
  const state = useSheetState(id, memory);
  // As useSheetState: only a character that never loaded is an error, so a failed background
  // refetch never takes the loaded editors, and their unsaved edits, away.
  if ((character.isError && character.data === undefined) || state === "error") {
    const gone = isNotFound(character.error) || isNotFound(memory.error);
    return (
      <SheetMissing
        back={
          from === "chat" ? { to: "/", label: "Chat" } : { to: "/characters", label: "Characters" }
        }
        noun={gone ? "character" : "memory"}
        notFound={gone}
        onRetry={() => {
          void character.refetch();
          void memory.refetch();
        }}
      />
    );
  }
  if (state === "loading" || memory.data === undefined || character.data === undefined) {
    return <SheetLoading />;
  }
  return <MemoryBook id={id} name={character.data.card.name} memory={memory.data} from={from} />;
}

/**
 * The screen for a loaded character and memory: the book while memory is on
 * (every character, until turned off), the invitation once it is off; one
 * screen across the swap, so the switch keeps focus and the notebook keeps
 * its edits. The one memory editor lives here, above both, so nothing the
 * book redraws closes it.
 */
export function MemoryBook({
  id,
  name,
  memory,
  from,
}: {
  id: string;
  name: string;
  memory: CharacterMemory;
  from?: MemoryFrom;
}) {
  const [episodeEditor, openEpisode] = useEpisodeEditor(id, undefined, focusAfterDelete);
  // The notebook and an open memory save on their own; leaving asks once for both, and the
  // header says how both stand.
  const [reportSaving, leaveGuard, saving] = useLeaveGuardScope();
  return (
    <LeaveGuardScope value={reportSaving}>
      <Book id={id} name={name} memory={memory} from={from} saving={saving} onOpen={openEpisode} />
      {episodeEditor}
      {leaveGuard}
    </LeaveGuardScope>
  );
}

/** The screen's title, the list's heading: where focus goes when what held it is gone. */
const SCREEN_TITLE = "memory-title";
const MEMORIES_HEADING = "memories-heading";

const focusById = (...ids: string[]) => {
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element !== null) return element.focus();
  }
};

/**
 * Once the memory `deleted` is deleted on this screen: reads the rows shown
 * now, before the list moves, and gives what focuses the row after it (the
 * one before at the end, the list's heading once none is left) when the
 * editor has closed. Rows a deleted chapter gathers move with it, so they
 * are passed over.
 */
function focusAfterDelete(deleted: string): () => void {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-memory-list] [data-episode]")];
  const gathering = rows.find((row) => row.dataset.episode === deleted)?.closest("li");
  const shown = rows
    .filter((row) => row.dataset.episode === deleted || !gathering?.contains(row))
    .map((row) => row.dataset.episode ?? "");
  const target = rowAfterDelete(shown, deleted);
  return () => {
    const row =
      target === null
        ? null
        : document.querySelector<HTMLElement>(`[data-memory-list] [data-episode="${target}"]`);
    if (row !== null) row.focus();
    else focusById(MEMORIES_HEADING, SCREEN_TITLE);
  };
}

/** The screen's header and its one scrolling body. */
function MemoryFrame({
  id,
  name,
  memory,
  from,
  saving,
  onForgotten,
  children,
  after,
}: {
  id: string;
  name: string;
  memory: CharacterMemory;
  from: MemoryFrom;
  /** How the notebook and an open memory stand, while either is shown. */
  saving: ScreenSaving | null;
  /** After Forget everything, with the memory as the server left it. */
  onForgotten?: (memory: CharacterMemory) => void;
  children: ReactNode;
  /** Kept at the end of the body, sticky above the bottom (a save conflict). */
  after?: ReactNode;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const phone = useFormFactor() === "phone";
  // On phones what is not saved says so in the title's place, as a sheet's header does.
  const failing = phone && saving !== null && isFailure(saving.status, false);
  const on = memoryIsOn(memory.state);
  const notebook = memory.state?.notebook;
  // Something to forget: a memory, a notebook with anything in it, or the next chat's opening.
  const remembered =
    memory.episodes.length > 0 ||
    (notebook !== undefined && notebookHasContent(notebook)) ||
    (memory.state?.opening.trim() ?? "") !== "";
  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <SheetHeaderFrame back={backTo(id, name, from)} frame={SHEET_FRAME.form}>
        <div className="min-w-0 flex-1 px-2">
          {failing ? (
            <SaveState status={saving.status} creating={false} noun={saving.noun} short />
          ) : (
            <h1
              id={SCREEN_TITLE}
              tabIndex={-1}
              className="truncate font-semibold text-ink text-lead outline-none"
            >
              Memory
            </h1>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {saving !== null && !failing && (
            <span className="px-2 max-tablet:sr-only">
              <SaveState status={saving.status} creating={false} noun={saving.noun} />
            </span>
          )}
          {on && <RememberNow id={id} name={name} />}
          {remembered && (
            <ForgetEverything
              id={id}
              name={name}
              memory={memory}
              onFailed={setNotice}
              onForgotten={(answer) => {
                onForgotten?.(answer);
                // The menu that held focus is gone with what it forgot: the screen's title takes it.
                requestAnimationFrame(() => focusById(SCREEN_TITLE, MEMORIES_HEADING));
              }}
            />
          )}
        </div>
      </SheetHeaderFrame>
      <div
        data-skip-target=""
        tabIndex={-1}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
          after !== undefined && "scroll-pb-40",
        )}
      >
        {/* One column at the frame's width: nothing inside, however long and unbroken, widens it. */}
        <div
          className={cn(
            SHEET_FRAME.form,
            "grid grid-cols-[minmax(0,1fr)] gap-10 pt-4 pb-16 tablet:pt-8",
          )}
        >
          {notice !== null && (
            <div className={SHEET_GRID}>
              <div />
              <SheetNotice notice={notice} onDismiss={() => setNotice(null)} />
            </div>
          )}
          {children}
          {after}
        </div>
      </div>
    </main>
  );
}

/** "What Mira remembers", set as the character's name is in the story, with its rule to the edge. */
function Heading({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className={SHEET_GRID}>
      <div />
      <div className="grid min-w-0 gap-1.5">
        <h2 className="flex items-center gap-3.5 font-semibold font-story text-heading text-ink after:mt-px after:h-px after:min-w-6 after:flex-1 after:bg-rush">
          <span className="min-w-0 text-balance">What {name} remembers</span>
        </h2>
        <div className="grid min-w-0">{children}</div>
      </div>
    </div>
  );
}

/** The notebook's saving, as its editor reports it to the screen's header and conflict notice. */
interface NotebookReport {
  status: SaveStatus;
  keepMine: () => Promise<boolean>;
  hasUnsaved: () => boolean;
  flush: () => Promise<boolean>;
}

/**
 * The book, memory on or off. On: the notebook, edited in place, then the
 * memories. Off: what memory does and what it keeps. The switch stays where
 * it is across the swap, and what changes unfolds or folds away. A newer
 * notebook (a memory written meanwhile) remounts the notebook's editor
 * alone, so the list and an open memory editor stay as they are. Memory
 * turned off elsewhere leaves the notebook, and its saving, in place until
 * its edits are saved, so none is lost.
 */
function Book({
  id,
  name,
  memory,
  from,
  saving,
  onOpen,
}: {
  id: string;
  name: string;
  memory: CharacterMemory;
  from: MemoryFrom;
  saving: ScreenSaving | null;
  onOpen: OpenEpisode;
}) {
  const queryClient = useQueryClient();
  const on = memoryIsOn(memory.state);
  /** The notebook row as the memory query has it now. */
  const state = memoryStateOf(memory.state);
  // A memory written elsewhere while nothing here is unsaved remounts the notebook on it.
  const [round, setRound] = useState(0);
  const [notebook, setNotebook] = useState<NotebookReport | null>(null);
  const remount = () => setRound((current) => current + 1);
  // Turning memory off closes the notebook: its edits are saved first, or memory stays on.
  const saveNotebook = async () =>
    notebook === null || !notebook.hasUnsaved() || (await notebook.flush());
  // While memory turns off the notebook takes no edits: one typed after its save would be lost.
  const [closing, setClosing] = useState(false);
  // Memory back on opens the notebook to edits again.
  const [wasOn, setWasOn] = useState(on);
  if (on !== wasOn) {
    setWasOn(on);
    if (on) setClosing(false);
  }
  // The revision Forget everything left: the notebook starts over on it, unsaved edits and all.
  const [forgottenAt, setForgottenAt] = useState<number | null>(null);
  const forgotten = (answer: CharacterMemory) => {
    if (answer.state === null) remount();
    else setForgottenAt(answer.state.revision);
  };
  // Off, the notebook stays only while its edits are on their way or could not be saved.
  const holding = notebook !== null && notebook.status.kind !== "saved";
  const [now] = useState(Date.now);
  return (
    <MemoryFrame
      id={id}
      name={name}
      memory={memory}
      from={from}
      saving={saving}
      onForgotten={forgotten}
      after={
        notebook?.status.kind === "conflict" ? (
          <ConflictNotice
            noun="notebook"
            onReload={async () => {
              const { isSuccess } = await reloadMemory(queryClient, id);
              if (isSuccess) remount();
            }}
            onKeepMine={() => void notebook.keepMine()}
          />
        ) : undefined
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)]">
        <Heading name={name}>
          <Unfold show={!on}>
            <p className="max-w-help text-pretty pb-5 font-story text-reed text-turn">
              Memory is off, so {name} forgets each chat when it ends. Turned back on, {name} keeps
              the story as it grows: what happened, scene by scene, and where things stand, in every
              chat to come.
            </p>
          </Unfold>
          <div className={cn("max-w-help", on && "mt-2")}>
            <MemorySwitch
              id={id}
              name={name}
              state={memory.state}
              description={
                on
                  ? `On: ${name} remembers every chat as it grows. Turned off, each chat is forgotten when it ends; what is remembered stays. ${MEMORY_KEPT}`
                  : MEMORY_KEPT
              }
              beforeOff={saveNotebook}
              onTurningOff={setClosing}
            />
          </div>
          <Unfold show={!on && memory.episodes.length > 0}>
            <p className="max-w-help pt-5 text-note text-reed">
              {countsText(memory.episodes, now)} Kept while memory is off.
            </p>
          </Unfold>
          {on && <RememberingLine id={id} />}
          {on && <RememberNowReason id={id} name={name} />}
        </Heading>
        <Unfold show={on || holding}>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-10 pt-10">
            {!on && (
              <p role="status" className={cn(SHEET_GRID, "text-pretty text-note text-reed")}>
                <span className="max-tablet:hidden" />
                <span>
                  Memory was turned off elsewhere. The notebook stays here until its edits are
                  saved.
                </span>
              </p>
            )}
            <NotebookPart
              key={round}
              id={id}
              name={name}
              on={on}
              remembered={notebookHasContent(state.notebook) || memory.episodes.length > 0}
              state={state}
              readOnly={closing}
              resetAt={forgottenAt}
              onReport={setNotebook}
              onRemount={remount}
            />
            {on && (
              <section aria-labelledby={MEMORIES_HEADING} className={SHEET_GRID}>
                <h2
                  id={MEMORIES_HEADING}
                  tabIndex={-1}
                  className="mb-2 font-semibold text-ink text-ui outline-none tablet:mb-0 tablet:pt-4.5 tablet:text-right"
                >
                  Memories
                </h2>
                <EpisodeList episodes={memory.episodes} onOpen={onOpen} />
              </section>
            )}
          </div>
        </Unfold>
      </div>
    </MemoryFrame>
  );
}

/**
 * The notebook's editor on the revision it opened, reporting its saving to
 * the screen. A newer revision while nothing here is unsaved, or the one
 * Forget everything left (`resetAt`) whatever is unsaved, asks the screen to
 * remount it on that one.
 */
function NotebookPart({
  id,
  name,
  on,
  remembered,
  state,
  readOnly,
  resetAt,
  onReport,
  onRemount,
}: {
  id: string;
  name: string;
  on: boolean;
  /** The saved notebook holds something, or the book a memory: Regenerate has something to write from. */
  remembered: boolean;
  state: MemoryState;
  readOnly: boolean;
  resetAt: number | null;
  onReport: (report: NotebookReport) => void;
  onRemount: () => void;
}) {
  // The newest revision this editor holds: the one it opened, or the last it saved.
  const known = useRef(state.revision);
  const { fields, edit, autosave } = useNotebook(id, state, (revision) => {
    known.current = revision;
  });
  const { hasUnsaved, status, keepMine, flush } = autosave;
  useEffect(() => {
    if (state.revision > known.current && (!hasUnsaved() || state.revision === resetAt)) {
      onRemount();
    }
  }, [state.revision, resetAt, hasUnsaved, onRemount]);
  useEffect(
    () => onReport({ status, keepMine, hasUnsaved, flush }),
    [status, keepMine, hasUnsaved, flush, onReport],
  );
  const leaveGuard = useLeaveGuard(autosave, () => {}, false, "notebook");
  return (
    <div className="grid gap-6">
      <NotebookEditor
        fields={fields}
        readOnly={readOnly}
        source={{
          characterId: id,
          name,
          on,
          remembered,
          // Regenerate reads the saved notebook: edits on their way go first.
          beforeWrite: async () => !hasUnsaved() || (await flush()),
        }}
        onChange={edit}
      />
      {leaveGuard}
    </div>
  );
}

/**
 * While the open chat with this character is remembering, or failed to:
 * said under the heading, with the failure's way out. Empty, it takes no
 * room (its region stays, so what it says next is announced).
 */
function RememberingLine({ id }: { id: string }) {
  const chosen = useSetting((settings) => settings.characterId) === id;
  const status = useChat((state) => state.memory.status);
  const failure = useChat((state) => state.memory.failure);
  const note = failureNote(failure);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-1 text-note text-reed empty:-mt-1.5 [&>p]:py-1.5"
    >
      {chosen && status === "remembering" && <p>Remembering…</p>}
      {chosen && status === "failed" && (
        <>
          <p className="text-pretty">{note.text}</p>
          {/* The memory screen is here already: a full book's way out is this screen. */}
          <MemoryFailureAction
            action={note.action === "memory" ? null : note.action}
            characterId={id}
          />
        </>
      )}
    </div>
  );
}

/**
 * Why Remember now cannot run, or null when it can: no chat with this
 * character open, a memory already being written, too little to remember
 * yet, or a message edit still open among the turns it would take.
 */
function useRememberNowReason(id: string, name: string): string | null {
  const { characterId, memoryKeepTurns } = useSettings();
  const enough = useChat((state) => rememberable(state, memoryKeepTurns));
  const remembering = useChat((state) => state.memory.status === "remembering");
  const held = useChat((state) => rememberNowHeld(state, memoryKeepTurns));
  return characterId !== id
    ? `Open a chat with ${name} to remember it.`
    : remembering
      ? "A memory is being written."
      : !enough
        ? "The chat needs a few more turns first."
        : held
          ? "Save or cancel the message edit in Chat first."
          : null;
}

const REASON_ID = "remember-now-reason";

/**
 * Remembers the open chat now, whatever its size. Only for a chat with this
 * character that holds enough to remember; otherwise it says why: in its
 * tooltip under a pointer, and on touch, which has no hover, in a line
 * under the heading (`RememberNowReason`).
 */
function RememberNow({ id, name }: { id: string; name: string }) {
  const coarse = useCoarsePointer();
  const remembering = useChat((state) => state.memory.status === "remembering");
  const reason = useRememberNowReason(id, name);
  const button = (
    <Button
      variant="outline"
      disabled={reason !== null}
      focusableWhenDisabled
      aria-describedby={coarse && reason !== null && !remembering ? REASON_ID : undefined}
      onClick={() => void chatStore.getState().rememberNow()}
    >
      {remembering ? "Remembering…" : "Remember now"}
    </Button>
  );
  return reason === null || coarse ? button : <Tooltip label={reason}>{button}</Tooltip>;
}

/**
 * On touch, why Remember now waits, said under the heading where a pointer
 * would read its tooltip. Not while a memory is written: the line above
 * says so already.
 */
function RememberNowReason({ id, name }: { id: string; name: string }) {
  const coarse = useCoarsePointer();
  const remembering = useChat((state) => state.memory.status === "remembering");
  const reason = useRememberNowReason(id, name);
  if (!coarse || reason === null || remembering) return null;
  return (
    <p
      id={REASON_ID}
      className="text-pretty pt-1.5 text-note text-reed transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
    >
      Remember now waits. {reason}
    </p>
  );
}

/** Forget everything, behind a confirmation that names what goes. */
function ForgetEverything({
  id,
  name,
  memory,
  onFailed,
  onForgotten,
}: {
  id: string;
  name: string;
  memory: CharacterMemory;
  onFailed: (notice: string) => void;
  onForgotten: ((memory: CharacterMemory) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const count = memory.episodes.length;
  const forget = async () => {
    const forgotten = await forgetMemory(id);
    if (forgotten === null) return onFailed(`Not forgotten: ${notReached()}.`);
    // Memory stays as it was, so nothing else unfolds the open chat: every folded turn comes back.
    if (currentSettings().characterId === id) chatStore.getState().memoryReset();
    if (forgotten !== "gone") {
      // The server's answer, the emptied notebook at its real revision: the notebook starts over on it.
      queryClient.setQueryData<CharacterMemory>(MEMORY_KEY(id), forgotten);
      onForgotten?.(forgotten);
    }
    void refreshMemory(queryClient, id);
  };
  const on = memoryIsOn(memory.state);
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="icon" aria-label="Memory actions" />}>
          <MoreIcon />
        </MenuTrigger>
        <MenuContent label="Memory actions">
          <MenuItem danger onClick={() => setConfirm(true)}>
            Forget everything
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Forget everything ${name} remembers?`}
        description={`The notebook and ${countOf(count, "memory", "memories")} are deleted for good, and the open chat shows all its turns again. Memory stays ${
          on ? "on" : "off"
        } for ${name}.`}
        confirm="Forget everything"
        cancel="Keep them"
        onConfirm={() => void forget()}
      />
    </>
  );
}
