import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  type CharacterMemory,
  episodeFieldsSchema,
  MEMORY_LIMITS,
  type StoredEpisode,
} from "@ephemera/core";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { useCoarsePointer, useFormFactor } from "@/app/form-factor.ts";
import { CloseIcon } from "@/components/icons";
import { ConfirmDialog, DIALOG_SURFACE, SCRIM } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { SwitchField } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { countOf } from "@/lib/text";
import { NoticeCard } from "../app/NoticeCard.tsx";
import { chatStore, useChat } from "../chat/session.ts";
import { latestMemory } from "../chat/store.ts";
import { KeywordsField } from "../lorebook/KeywordsField.tsx";
import { isFailure, saveStatusText, useAutosave } from "../sheet/autosave.ts";
import { ConflictNotice, useReload } from "../sheet/ConflictNotice.tsx";
import { FIELD } from "../sheet/fields.ts";
import { useLeaveGuard } from "../sheet/SheetFrame.tsx";
import { notReached } from "../signin/signin.ts";
import { cueProblem, episodeOverLimit } from "./memory.ts";
import { deleteEpisode, MEMORY_KEY, memoryQuery, refreshMemory, saveEpisode } from "./queries.ts";

/*
 * One memory, open to edit: its title, summary, cues and whether it is
 * always in the prompt, saved as they change on the sheets' one autosave.
 * The autosave knows a missing name as "nothing to save yet"; the title
 * plays that part, carried as `name`.
 */

type EpisodeSaveFields = { name: string; summary: string; cues: string[]; pinned: boolean };

const { title, ...others } = episodeFieldsSchema.shape;
const saveSchema: z.ZodType<EpisodeSaveFields> = z.strictObject({ name: title, ...others });

const LABELS: Record<keyof EpisodeSaveFields, string> = {
  name: "The title",
  summary: "The summary",
  cues: "Cues",
  pinned: "Always in the prompt",
};

/** A field over its limit, in the words the editor and the screen's header both say. */
const overLimit = (key: keyof EpisodeSaveFields, fields: EpisodeSaveFields) =>
  key === "pinned" ? undefined : episodeOverLimit(key, fields.cues);

const fieldsOf = (episode: StoredEpisode): EpisodeSaveFields => ({
  name: episode.title,
  summary: episode.summary,
  cues: episode.cues,
  pinned: episode.pinned,
});

/** Cues are plain words and names: a comma always separates them. */
const splitCues = (text: string) =>
  text
    .split(",")
    .map((cue) => cue.trim())
    .filter((cue) => cue !== "");

const LABEL = "font-medium text-ink text-ui";

/**
 * A conflict's Reload: the character's memory fetched again, now. Failed
 * (offline, the server unavailable), it reports so, and the unsaved fields
 * and the conflict stay.
 */
export async function reloadMemory(
  queryClient: QueryClient,
  characterId: string,
): Promise<{ isSuccess: boolean }> {
  try {
    await queryClient.fetchQuery({ ...memoryQuery(characterId), staleTime: 0 });
    return { isSuccess: true };
  } catch {
    return { isSuccess: false };
  }
}
const turnsText = (turns: number) => countOf(turns, "turn");

/** Opens the editor of a memory by its id; `members` is how many memories a chapter gathers. */
export type OpenEpisode = (episodeId: string, members?: number) => void;

/** The chat's one memory editor, which the seam asks for wherever it stands. */
export const OpenEpisodeContext = createContext<OpenEpisode | null>(null);

interface Opened {
  characterId: string;
  episodeId: string;
  members: number;
  session: unknown;
}

/**
 * The editor of one memory, owned once at a level that stays put (the
 * memory screen's book, the chat), so what moves beneath it (a newer
 * notebook, a new memory moving the seam) neither closes nor retargets it:
 * it edits the memory whose id it was opened with. It closes, saving first,
 * when the character changes or `session` (the chat's epoch, which a Clear
 * advances) is no longer the one it opened in, and when that memory is
 * deleted elsewhere, unless edits here could not be saved: then it stays,
 * with its text, until the owner closes it. `onDeleted` hears of a memory
 * deleted here before the editor closes, and gives focus its place once it
 * has (`focus`); without it focus returns to what opened the editor.
 */
export function useEpisodeEditor(
  characterId: string | null,
  session?: unknown,
  onDeleted?: (episodeId: string) => () => void,
): [ReactNode, OpenEpisode] {
  const [opened, setOpened] = useState<Opened | null>(null);
  const open: OpenEpisode = (episodeId, members = 0) => {
    if (characterId !== null) setOpened({ characterId, episodeId, members, session });
  };
  const editor =
    opened === null ? null : (
      <EpisodeEditor
        key={opened.episodeId}
        characterId={opened.characterId}
        episodeId={opened.episodeId}
        members={opened.members}
        dismissed={opened.characterId !== characterId || opened.session !== session}
        onDeleted={onDeleted}
        onClose={() => setOpened(null)}
      />
    );
  return [editor, open];
}

/**
 * The editor of the memory `episodeId`, as the memory query has it now (as
 * last seen once it is gone). A conflict's Reload fetches the memory again
 * and remounts the dialog on the saved episode.
 */
function EpisodeEditor({
  characterId,
  episodeId,
  members,
  dismissed,
  onDeleted,
  onClose,
}: {
  characterId: string;
  episodeId: string;
  members: number;
  dismissed: boolean;
  onDeleted: ((episodeId: string) => () => void) | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // The owner's screen already keeps the memory fresh; opening the editor fetches nothing.
  const { data } = useQuery({ ...memoryQuery(characterId), refetchOnMount: false });
  const found = data?.episodes.find((episode) => episode.id === episodeId);
  const [seen, setSeen] = useState(found);
  if (found !== undefined && found !== seen) setSeen(found);
  const [round, reload] = useReload(() => reloadMemory(queryClient, characterId));
  const episode = found ?? seen;
  if (episode === undefined) return null;
  return (
    <EpisodeDialog
      key={round}
      episode={episode}
      members={members}
      dismissed={dismissed}
      gone={data !== undefined && found === undefined}
      onReload={reload}
      onDeleted={onDeleted}
      onClose={onClose}
    />
  );
}

function EpisodeDialog({
  episode,
  members,
  dismissed,
  gone,
  onReload,
  onDeleted,
  onClose,
}: {
  episode: StoredEpisode;
  members: number;
  /** Its owner moved on (another character, a cleared chat): the dialog saves what it can and closes. */
  dismissed: boolean;
  /** The memory was deleted elsewhere: the dialog closes once nothing here is left unsaved. */
  gone: boolean;
  onReload: () => Promise<void>;
  onDeleted: ((episodeId: string) => () => void) | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  /** Set once this memory is deleted here: where focus goes once the editor has closed. */
  const afterDelete = useRef<(() => void) | null>(null);
  const [fields, setFields] = useState(() => fieldsOf(episode));
  /** A close that could not save: the next one leaves the edits behind. */
  const [warned, setWarned] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  /** Deleted elsewhere with edits here that could not be saved: they stay until the owner gives them up. */
  const [orphaned, setOrphaned] = useState(false);
  // The open chat's latest memory, folded: deleting it brings its turns back into the story.
  const unfolds = useChat((state) => {
    const latest = latestMemory(state.memory);
    return latest?.id === episode.id && !latest.held;
  });
  // The memory being written starts where this one ends: this one stays until it lands.
  const held = useChat(
    (state) =>
      latestMemory(state.memory)?.id === episode.id &&
      (state.memory.status === "remembering" || state.memory.pending !== null),
  );
  const titleId = useId();
  const summaryId = useId();
  const heldId = useId();
  const titleField = useRef<HTMLTextAreaElement>(null);

  const changed = () => {
    void refreshMemory(queryClient, episode.characterId);
    chatStore.getState().schedulePreview();
  };

  const autosave = useAutosave<EpisodeSaveFields, StoredEpisode>({
    id: episode.id,
    revision: episode.revision,
    fields,
    schema: saveSchema,
    labels: LABELS,
    overLimit,
    wholeLabel: "The memory",
    save: (id, { name, ...rest }, revision) =>
      saveEpisode(id, name === undefined ? rest : { ...rest, title: name }, revision),
    onSaved: (_id, saved) => {
      // The saved memory is in the cache at once, so nothing reads the older one until the refresh.
      queryClient.setQueryData<CharacterMemory>(MEMORY_KEY(saved.characterId), (current) =>
        current === undefined
          ? current
          : {
              ...current,
              episodes: current.episodes.map((other) => (other.id === saved.id ? saved : other)),
            },
      );
      changed();
    },
  });
  const { status, flush } = autosave;
  // Leaving the screen saves first, as a sheet does; only an edit that could not be saved asks.
  const leaveGuard = useLeaveGuard(autosave, () => {}, false, "memory");

  useEffect(() => {
    if (!dismissed && !gone) return;
    void flush()
      .catch(() => false)
      .then((saved) => {
        if (saved || dismissed) setOpen(false);
        else setOrphaned(true);
      });
  }, [dismissed, gone, flush]);

  /** The owner gives up the edits of a memory deleted elsewhere. */
  const discard = () => {
    autosave.discard();
    setOpen(false);
  };

  const edit = (patch: Partial<EpisodeSaveFields>) => {
    setWarned(false);
    setFields((current) => ({ ...current, ...patch }));
    autosave.touch(...(Object.keys(patch) as (keyof EpisodeSaveFields)[]));
  };

  const close = async () => {
    if (warned || (await autosave.flush())) setOpen(false);
    else setWarned(true);
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteFailed(false);
    // Stop saving, keeping the edits, until the deletion has answered.
    autosave.pause();
    await autosave.settle();
    if (!(await deleteEpisode(episode.id))) {
      setDeleting(false);
      setDeleteFailed(true);
      autosave.resume();
      return;
    }
    autosave.discard();
    // Before the list moves: the row's neighbours are read while it is still there.
    afterDelete.current = onDeleted?.(episode.id) ?? null;
    chatStore.getState().episodeGone(episode.id);
    changed();
    setOpen(false);
  };

  const saveText =
    status.kind === "needs-name"
      ? "Not saved: add a title"
      : status.kind === "saved"
        ? null
        : // The conflict's notice below explains; the line only says nothing is saved.
          status.kind === "conflict" || orphaned
          ? "Not saved"
          : saveStatusText(status, false, "memory");
  const failing = isFailure(status, false);
  const cuesWrong = cueProblem(fields.cues);
  const chapter = episode.kind === "chapter";
  const description = chapter
    ? `A chapter gathering ${countOf(members, "memory", "memories")}, ${turnsText(episode.turns)} in all.`
    : `Written from ${turnsText(episode.turns)} of a chat.`;

  const footer = (
    <>
      <div className="grid gap-2">
        <p
          role="status"
          className={cn(
            "min-h-4.5 text-pretty text-note empty:hidden",
            failing || deleteFailed ? "text-ember" : "text-reed",
          )}
        >
          {deleteFailed
            ? `Not deleted: ${notReached()}.`
            : saveText === null
              ? ""
              : `${saveText}.${warned ? " Close again to leave without saving." : ""}`}
        </p>
        {held && (
          <p id={heldId} className="text-pretty text-note text-reed">
            A memory is being written; delete this one after it lands.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="quiet"
          className="-ml-3.5"
          disabled={deleting || held}
          focusableWhenDisabled
          aria-describedby={held ? heldId : undefined}
          onClick={() => setConfirming(true)}
        >
          Delete this memory
        </Button>
        <Button variant="outline" disabled={deleting} onClick={() => void close()}>
          Done
        </Button>
      </div>
    </>
  );

  return (
    <>
      <EditorPanel
        open={open}
        title="Edit the memory"
        description={description}
        closeLabel="Close the memory"
        initialFocus={titleField}
        restoreFocus={() => afterDelete.current === null}
        onClose={() => void close()}
        onClosed={() => {
          afterDelete.current?.();
          onClose();
        }}
        footer={footer}
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          <div className="grid gap-1.5">
            <label htmlFor={titleId} className={LABEL}>
              Title
            </label>
            <textarea
              ref={titleField}
              id={titleId}
              rows={1}
              value={fields.name}
              maxLength={MEMORY_LIMITS.title}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) event.preventDefault();
              }}
              onChange={(event) => edit({ name: event.target.value.replace(/[\r\n]+/g, " ") })}
              className={cn(FIELD, "font-semibold font-story text-lead")}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={summaryId} className={LABEL}>
              Summary
            </label>
            <textarea
              id={summaryId}
              value={fields.summary}
              maxLength={chapter ? MEMORY_LIMITS.chapterSummary : MEMORY_LIMITS.summary}
              onChange={(event) => edit({ summary: event.target.value })}
              // Grows with its text to a bound, then scrolls inside, so the cues stay within reach.
              className={cn(FIELD, "max-h-[min(18rem,36dvh)] min-h-32 font-story")}
            />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
            <KeywordsField
              label="Cues"
              item="cue"
              split={splitCues}
              maxLength={MEMORY_LIMITS.cue}
              keys={fields.cues}
              problems={[]}
              dimmed={false}
              help="Names, places and things that bring this memory back when a chat mentions them."
              onChange={(cues) => edit({ cues })}
            />
            {cuesWrong !== null && (
              <p className="text-pretty text-ember text-note [overflow-wrap:anywhere] arrive">
                {cuesWrong}
              </p>
            )}
          </div>
          <SwitchField
            label="Always in the prompt"
            description="Recalled in every chat, whatever the story is about."
            checked={fields.pinned}
            onCheckedChange={(pinned) => edit({ pinned })}
          />
          {orphaned && (
            <NoticeCard
              role="alert"
              data-orphaned=""
              placement="dock"
              stacked
              title="Deleted elsewhere"
              body="This memory was deleted in another tab or by Forget everything, so the edits here cannot be saved. Copy anything you want to keep, then close it."
              actions={
                <Button variant="outline" className="px-2.5" onClick={discard}>
                  Discard and close
                </Button>
              }
            />
          )}
          {!orphaned && status.kind === "conflict" && (
            <ConflictNotice
              noun="memory"
              placement="inline"
              onReload={onReload}
              onKeepMine={() => void autosave.keepMine()}
            />
          )}
        </div>
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete this memory?"
          description={`“${episode.title}” is deleted for good.${
            chapter ? " The memories it gathers stay." : ""
          }${unfolds ? ` Its ${turnsText(episode.turns)} return to the story.` : ""}`}
          confirm="Delete"
          onConfirm={() => void remove()}
        />
      </EditorPanel>
      {leaveGuard}
    </>
  );
}

/**
 * The editor's frame: its title and a close button above, the fields in
 * the one scroller, Delete and Done kept in view below. A centred dialog
 * from tablet up; on phones the shared bottom sheet (components/ui/drawer),
 * clear of the safe areas, that a swipe down closes. Either asks `onClose`
 * to close, which saves first and may keep it open; `onClosed` runs once it
 * has left. `restoreFocus` false leaves focus to `onClosed` (a deleted
 * memory's row is gone). It opens mounted, so it enters from its starting
 * style rather than Base UI's.
 */
function EditorPanel({
  open,
  title,
  description,
  closeLabel,
  initialFocus,
  restoreFocus,
  onClose,
  onClosed,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  closeLabel: string;
  initialFocus: RefObject<HTMLElement | null>;
  restoreFocus: () => boolean;
  onClose: () => void;
  onClosed: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const phone = useFormFactor() === "phone";
  // On touch, the panel itself takes focus, so opening it never raises the keyboard.
  const coarse = useCoarsePointer();
  const popup = useRef<HTMLDivElement>(null);
  const change = (next: boolean) => {
    if (!next) onClose();
  };
  const complete = (next: boolean) => {
    if (!next) onClosed();
  };
  const focus = {
    initialFocus: coarse ? popup : initialFocus,
    finalFocus: () => restoreFocus(),
  };
  const TITLE = "text-balance font-semibold text-heading text-ink";
  const DESCRIPTION = "text-pretty text-reed text-ui";
  const closeButton = <Button size="icon" aria-label={closeLabel} className="-mt-1 -mr-2" />;
  /** The header, in the frame's own title, description and close: the sheet's on phones, the dialog's otherwise. */
  const header = (heading: ReactNode, close: ReactNode) => (
    <header
      className={cn(
        "header-hairline flex shrink-0 items-start gap-3 border-b",
        phone ? "px-5 pt-1 pb-3" : "px-6 pt-5 pb-4",
      )}
    >
      <div className="grid min-w-0 flex-1 gap-1">{heading}</div>
      {close}
    </header>
  );
  const body = (
    <>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain [scroll-timeline:--thread]",
          phone ? "px-5 py-4" : "px-6 py-5",
        )}
      >
        {children}
      </div>
      <footer
        className={cn(
          "grid shrink-0 gap-2 border-rush border-t pt-3",
          phone ? "px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" : "px-6 pb-4",
        )}
      >
        {footer}
      </footer>
    </>
  );

  if (phone) {
    return (
      <Drawer
        open={open}
        onOpenChange={change}
        onOpenChangeComplete={complete}
        swipeDirection="down"
        showSwipeHandle
        keyboardAware
      >
        <DrawerContent
          ref={popup}
          {...focus}
          className="[timeline-scope:--thread] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-0.75rem-env(safe-area-inset-top))]"
        >
          {header(
            <>
              <DrawerTitle className={TITLE}>{title}</DrawerTitle>
              <DrawerDescription className={DESCRIPTION}>{description}</DrawerDescription>
            </>,
            <DrawerClose render={closeButton}>
              <CloseIcon />
            </DrawerClose>,
          )}
          {body}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={change} onOpenChangeComplete={complete}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className={cn(SCRIM, "starting:opacity-0")} />
        <DialogPrimitive.Popup
          ref={popup}
          {...focus}
          className={cn(
            DIALOG_SURFACE,
            "flex flex-col [--dialog-width:36rem] [timeline-scope:--thread] starting:translate-y-(--rise) starting:opacity-0",
          )}
        >
          {header(
            <>
              <DialogPrimitive.Title className={TITLE}>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className={DESCRIPTION}>
                {description}
              </DialogPrimitive.Description>
            </>,
            <DialogPrimitive.Close render={closeButton}>
              <CloseIcon />
            </DialogPrimitive.Close>,
          )}
          {body}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
