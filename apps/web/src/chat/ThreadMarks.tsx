import { useEffect, useRef } from "react";
import { UndoIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useChatCharacter } from "./character.ts";
import { openInspector } from "./open-inspector.ts";
import { chatStore, useChat } from "./session.ts";
import type { Deleted } from "./store.ts";

/** What the tombstone says was deleted. */
function deletedText(deleted: Deleted, character: string): string {
  if (deleted.kind === "alternate") return `One of ${character}'s alternate replies was deleted.`;
  const [first] = deleted.messages;
  if (deleted.messages.length > 1) return `${deleted.messages.length} messages were deleted.`;
  if (first === undefined || first.role === "user") return "Your message was deleted.";
  return first.greeting
    ? `${character}'s greeting was deleted.`
    : `${character}'s reply was deleted.`;
}

/**
 * Where a deleted message was: a dashed slip with Undo, until the next change
 * to the messages. Focus moves to Undo when the Delete control went with the
 * message.
 */
export function Tombstone() {
  const deleted = useChat((state) => state.deleted);
  const character = useChatCharacter()?.name ?? "The model";
  const undo = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (deleted !== null && (document.activeElement === document.body || !document.activeElement)) {
      undo.current?.focus();
    }
  }, [deleted]);
  if (deleted === null) return null;
  const what = deletedText(deleted, character);
  return (
    <li className="transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
      <div
        role="status"
        className="flex min-h-9 items-center gap-2 rounded-lg border border-control-edge border-dashed py-1 pr-1 pl-3.5 text-note text-reed"
      >
        <span className="flex-1">{what}</span>
        <Button
          ref={undo}
          variant="quiet"
          onClick={() => chatStore.getState().undoDelete()}
          className="h-8 gap-1.5 px-2 text-ink touch:h-11"
        >
          <UndoIcon size={16} />
          Undo
        </Button>
      </div>
    </li>
  );
}

/** Once the window is full: the prompt starts below this rule; the story above is not sent. */
export function TrimMarker({ count }: { count: number }) {
  return (
    <li data-trim-marker="">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-reed">
        <span className="h-px min-w-8 flex-1 bg-control-edge" />
        <span>
          The {count === 1 ? "message" : `${count} messages`} above {count === 1 ? "is" : "are"}{" "}
          left out: the context window is full.
        </span>
        <Button
          variant="quiet"
          onClick={() => void openInspector()}
          className="h-8 px-2 text-meta text-ink touch:h-11"
        >
          Open prompt
        </Button>
      </div>
    </li>
  );
}

/**
 * While the folded turns are shown: where they end and the held ones begin,
 * remembered too but still sent while the window holds them.
 */
export function FoldLine() {
  return (
    <li
      data-fold-line=""
      className="transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0"
    >
      <div className="flex items-center gap-3 text-meta text-reed">
        <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-control-edge" />
        <span>Folded above. Remembered, and still sent, below.</span>
        <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-control-edge" />
      </div>
    </li>
  );
}
