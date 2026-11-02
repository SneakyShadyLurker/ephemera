import { useQuery } from "@tanstack/react-query";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { MemoryIcon } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { failureNote } from "../memory/failure.ts";
import { memoryOnIn, memoryQuery, type RememberFailure } from "../memory/queries.ts";
import { useSetting } from "../settings/settings.ts";
import { useChatCharacter } from "./character.ts";
import { chatStore, useChat } from "./session.ts";
import { endingToRemember } from "./store.ts";

/*
 * Remembering a chat's ending as it closes, for the dialogs that close it
 * (Clear, and starting a chat with someone else): while memory is on for
 * its character and a turn or more is unremembered, the dialog offers to
 * write them, the newest included, as one last memory before it goes.
 * The chat itself is still never kept; its ending becomes a memory.
 */

type Ending =
  | { status: "idle" }
  | { status: "remembering" }
  | { status: "editing" }
  | { status: "failed"; reason: RememberFailure };

/** Whether closing the chat offers to remember its ending. */
function useEndingToRemember(): boolean {
  const characterId = useSetting((settings) => settings.characterId);
  const memory = useQuery({
    ...memoryQuery(characterId ?? ""),
    enabled: characterId !== null,
  });
  const enough = useChat(endingToRemember);
  return characterId !== null && memoryOnIn(memory) && enough;
}

/**
 * One dialog's run of remembering the ending: `proceed` closes the chat once
 * it is written, and only while that run is still the dialog's (not reset,
 * not unmounted) and the chat is still the one it started on. A run the
 * chat moved on from (cleared, reset) ends quietly. An ending the server
 * refused leaves its turns open; one whose answer was lost keeps them
 * read-only, whether the dialog is still there or not (the store sees to
 * it), until Try again or a later call confirms or refuses it, or the chat
 * is cleared; turns after them and the composer stay open meanwhile.
 * An open message edit among the ending's turns holds it: nothing is
 * written, the chat stays, and the dialog says to save or cancel it first.
 */
function useRememberEnding(proceed: () => void) {
  const [ending, setEnding] = useState<Ending>({ status: "idle" });
  /** The run under way, by a token only it holds. */
  const run = useRef<object | null>(null);
  useEffect(
    () => () => {
      run.current = null;
    },
    [],
  );
  const remember = async () => {
    const token = {};
    run.current = token;
    const { epoch } = chatStore.getState();
    setEnding({ status: "remembering" });
    const outcome = await chatStore.getState().rememberEnding();
    if (run.current !== token) return;
    run.current = null;
    if (outcome.status === "failed") {
      setEnding(outcome);
      return;
    }
    if (outcome.status === "editing") {
      setEnding({ status: "editing" });
      return;
    }
    setEnding({ status: "idle" });
    if (outcome.status === "done" && chatStore.getState().epoch === epoch) proceed();
  };
  const reset = () => {
    run.current = null;
    setEnding({ status: "idle" });
  };
  return { ending, remember, reset };
}

/**
 * What remembering the ending is doing, under the dialog's description: the
 * memory mark while it is written, what holds it, or why it was not.
 */
function EndingStatus({ ending }: { ending: Ending }) {
  if (ending.status === "idle") return null;
  if (ending.status === "remembering") return <Remembering />;
  if (ending.status === "editing") {
    return (
      <p role="status" className={"arrive mt-4 text-pretty text-note text-reed"}>
        A message edit is still open. Keep chatting to save or cancel it first.
      </p>
    );
  }
  return (
    <p role="alert" className={"arrive mt-4 text-pretty text-ember text-note"}>
      {failureNote(ending.reason).text}
    </p>
  );
}

/** The status line while the ending is written, after the reply still streaming, if any. */
function Remembering() {
  const replying = useChat((state) => state.generating);
  return (
    <p role="status" className={"arrive mt-4 flex items-center gap-2 text-note text-reed"}>
      <MemoryIcon size={16} className="shrink-0 text-ink" />
      {replying
        ? "Waiting for the reply to finish, then remembering how this chat ended…"
        : "Remembering how this chat ended…"}
    </p>
  );
}

/**
 * The actions of a dialog that closes the chat, offering to remember its
 * ending: Keep chatting, the quiet way out without remembering, and the
 * remember action, Try again once it failed. Every one waits while the
 * ending is written.
 */
function EndingActions({
  ending,
  remember,
  without,
  onRemember,
  onWithout,
}: {
  ending: Ending;
  /** The primary action's name: "Remember and clear". */
  remember: string;
  /** The way out without remembering: "Clear without remembering". */
  without: string;
  onRemember: () => void;
  onWithout: () => void;
}) {
  const busy = ending.status === "remembering";
  return (
    <>
      <AlertDialogClose render={<Button variant="quiet" />} disabled={busy}>
        Keep chatting
      </AlertDialogClose>
      <Button variant="quiet" disabled={busy} onClick={onWithout}>
        {without}
      </Button>
      <Button variant="primary" disabled={busy} focusableWhenDisabled onClick={onRemember}>
        {ending.status === "failed" ? "Try again" : remember}
      </Button>
    </>
  );
}

/**
 * The confirmation before the chat is discarded (Clear, starting a chat
 * with someone else). While memory is on and the ending is unremembered it
 * offers to remember the ending first, held open while that is written, and
 * `proceed` discards the chat once it lands; otherwise Keep chatting or
 * the discard. `description.remembering` leads the sentence that says what
 * remembering keeps. Closing it starts the ending over.
 */
export function DiscardChatDialog({
  open,
  onOpenChange,
  proceed,
  title,
  description,
  labels,
  trigger,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proceed: () => void;
  title: string;
  description: { plain: string; remembering: string };
  /** The actions' names: "Remember and clear", "Clear without remembering", "Clear". */
  labels: { remember: string; without: string; confirm: string };
  trigger?: ReactElement;
  finalFocus?: Parameters<typeof AlertDialogContent>[0]["finalFocus"];
}) {
  const character = useChatCharacter();
  const offered = useEndingToRemember();
  const { ending, remember, reset } = useRememberEnding(proceed);
  const remembers = offered || ending.status !== "idle";
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // The ending being written holds the dialog open until it lands or fails.
        if (!next && ending.status === "remembering") return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      {trigger && <AlertDialogTrigger render={trigger} />}
      <AlertDialogContent
        title={title}
        description={
          remembers
            ? `${description.remembering} Remembering keeps how it ended as a memory${character ? ` of ${character.name}` : ""} for the next chat.`
            : description.plain
        }
        status={<EndingStatus ending={ending} />}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        {remembers ? (
          <EndingActions
            ending={ending}
            remember={labels.remember}
            without={labels.without}
            onRemember={() => void remember()}
            onWithout={() => {
              reset();
              proceed();
            }}
          />
        ) : (
          <>
            <AlertDialogClose render={<Button variant="quiet" />}>Keep chatting</AlertDialogClose>
            <AlertDialogClose render={<Button variant="dangerSolid" />} onClick={proceed}>
              {labels.confirm}
            </AlertDialogClose>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
