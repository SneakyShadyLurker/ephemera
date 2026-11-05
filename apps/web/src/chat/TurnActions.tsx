import { useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import {
  CastIcon,
  ChevronDownIcon,
  DeleteIcon,
  EditIcon,
  NextIcon,
  PreviousIcon,
  RegenerateIcon,
} from "@/components/icons";
import { MoreButton } from "@/components/more-button.tsx";
import { Button } from "@/components/ui/button";
import {
  DRAWER_ROW,
  Drawer,
  DrawerCloseIcon,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { KeyHint } from "@/components/ui/key-hint";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useSignedIn } from "../signin/hooks.ts";
import { openCast, useCastVisible } from "./cast-ui.ts";
import { appendAlternate, swipe } from "./Swipe.tsx";
import { chatStore, useChat } from "./session.ts";
import { type AssistantMessage, canGenerateAlternate, shownReply } from "./store.ts";

/** Compact icon buttons for message actions; 44px on touch. */
const ICON = "size-11";
const LABELLED =
  "size-11 gap-1.5 p-0 text-note touch:p-0 @min-[22rem]/reply-actions:w-auto @min-[22rem]/reply-actions:px-1.5";
/** The reply footer's occupied slot, also reserved while its controls wait for a reply. */
export const REPLY_ACTION_ROW = "@container/reply-actions flex h-11 items-center gap-1";

const edit = (id: string) => chatStore.getState().startEdit(id);
const remove = (id: string) => chatStore.getState().remove(id);
const removeFrom = (id: string) => chatStore.getState().removeFrom(id);
const removeAlternate = () => chatStore.getState().removeAlternate();

function IconAction({
  label,
  shortcut,
  onClick,
  disabled,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} {...(shortcut === undefined ? {} : { shortcut })}>
      <Button size="icon" aria-label={label} disabled={disabled} onClick={onClick} className={ICON}>
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * A message's menu: Edit, Delete and the rest. On the last reply it also
 * holds Replace and, with alternates, Delete this alternate. On the newest
 * message, while the cast has someone to list, Cast opens its record
 * surface at the roster, hung from this menu's button.
 */
function MoreMenu({
  id,
  label,
  busy = false,
  replace,
  alternates = false,
  className = ICON,
}: {
  id: string;
  label: string;
  busy?: boolean;
  /** The last reply's Replace, and whether it can run now. */
  replace?: { disabled: boolean };
  alternates?: boolean;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  // Cast takes focus to its own surface; the closing menu must not take it back.
  const toCast = useRef(false);
  const newest = useChat((state) => state.messages.at(-1)?.id === id);
  const cast = useCastVisible() && newest;
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) toCast.current = false;
      }}
    >
      {/* On its plate everywhere, so every More in the chat reads as the same control. */}
      <MenuTrigger
        render={
          <MoreButton
            ref={trigger}
            aria-label={label}
            disabled={busy}
            className={className}
            data-edit-for={id}
          />
        }
      />
      <MenuContent label={label} finalFocus={() => !toCast.current}>
        <MenuItem onClick={() => edit(id)}>
          <EditIcon size={16} />
          Edit
        </MenuItem>
        {replace && (
          <MenuItem
            disabled={replace.disabled}
            aria-keyshortcuts="Control+Enter"
            onClick={() => void chatStore.getState().regenerate()}
          >
            <RegenerateIcon size={16} />
            <span className="flex-1">Replace this reply</span>
            <KeyHint className="text-meta text-reed">
              <span aria-hidden="true">Ctrl Enter</span>
            </KeyHint>
          </MenuItem>
        )}
        {cast && (
          <MenuItem
            onClick={() => {
              toCast.current = true;
              openCast(null, trigger.current);
            }}
          >
            <CastIcon size={16} />
            Cast
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem danger onClick={() => remove(id)}>
          <DeleteIcon size={16} />
          Delete
        </MenuItem>
        {alternates && (
          <MenuItem danger onClick={removeAlternate}>
            <DeleteIcon size={16} />
            Delete this alternate
          </MenuItem>
        )}
        <MenuItem danger onClick={() => removeFrom(id)}>
          <DeleteIcon size={16} />
          Delete from here
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * Kept out of sight while anything is written (the thread is busy) and on the
 * last reply, whose own row has them, in CSS alone: a streaming reply then
 * changes nothing in the turns before it.
 */
const QUIET_WHEN =
  "[[aria-busy=true]_&]:invisible [li:has(+li[data-reply-actions])_&]:hidden [li:has([data-reply-actions])_&]:hidden";

/**
 * A turn's one More button. Tablet and desktop: just outside the story's
 * right edge, level with the first line, revealed by hover or focus within
 * the turn on fine pointers (and while its menu is open), always shown on
 * touch. Phones (`inPlate`): in the nameplate's row, at the end of the
 * character's hairline or beside the owner's name, so it sticks with the
 * name and a short turn is not followed by a row of its own. Its height
 * hangs outside the row, which keeps the name's line height.
 */
export function TurnActions({
  id,
  speaker,
  inPlate = false,
}: {
  id: string;
  speaker: string;
  inPlate?: boolean;
}) {
  return (
    <div
      className={cn(
        inPlate
          ? "-my-1.5 flex shrink-0 touch:-my-2.5"
          : "absolute top-0.5 -right-11 opacity-0 transition-opacity duration-(--duration-quick) ease-fade group-focus-within:opacity-100 group-hover:opacity-100 has-data-popup-open:opacity-100 touch:opacity-100",
        QUIET_WHEN,
      )}
    >
      <MoreMenu id={id} label={`More actions, ${speaker}`} className="size-9 touch:size-11" />
    </div>
  );
}

const Divider = () => <span aria-hidden="true" className="mr-1.5 h-4 w-px bg-rush" />;

/**
 * Under the last reply: New reply, Continue (when there is text to continue)
 * and More, which holds Replace, Edit and the deletes. The alternates' pager
 * (previous, `2 / 4`, next, or New reply on the last one) shows only once
 * there are two. One busy policy: nothing here starts while a generation runs.
 */
export function ReplyActions({ message }: { message: AssistantMessage }) {
  const busy = useChat((state) => state.generating);
  // Signed out, stepping still works; anything that generates waits for the session.
  const writable = useSignedIn();
  const continuing = useChat((state) => state.generationMode === "continue");
  const canGenerate = useChat(canGenerateAlternate);
  const reply = shownReply(message);
  const count = message.replies.length;
  const atLast = message.shown === count - 1;
  const canContinue = reply.text !== "" && reply.status !== "failed";
  // A reply that failed before any text is replaced in place: New reply would keep it as an empty alternate.
  const newReply =
    reply.status === "failed" && reply.text === "" ? null : (
      <Tooltip label="Write another reply">
        <Button
          variant="quiet"
          disabled={busy || !canGenerate || !writable}
          onClick={() => void appendAlternate()}
          className={LABELLED}
        >
          <RegenerateIcon size={16} className="@min-[22rem]/reply-actions:hidden" />
          <span className="sr-only @min-[22rem]/reply-actions:not-sr-only">New reply</span>
        </Button>
      </Tooltip>
    );
  return (
    <div className={REPLY_ACTION_ROW}>
      {count > 1 ? (
        <fieldset className="flex shrink-0 items-center gap-0">
          <legend className="sr-only">Replies</legend>
          <IconAction
            label="Previous reply"
            onClick={() => void swipe(-1)}
            disabled={busy || message.shown === 0}
          >
            <PreviousIcon size={16} />
          </IconAction>
          <span className="min-w-9 text-center text-meta text-reed tabular-nums">
            <span aria-hidden="true">
              {message.shown + 1} / {count}
            </span>
            <span className="sr-only">
              Reply {message.shown + 1} of {count}
            </span>
          </span>
          <IconAction label="Next reply" onClick={() => void swipe(1)} disabled={busy || atLast}>
            <NextIcon size={16} />
          </IconAction>
        </fieldset>
      ) : null}
      {newReply}
      {continuing ? (
        <p className="flex size-11 shrink-0 items-center justify-center text-note text-reed @min-[22rem]/reply-actions:w-auto @min-[22rem]/reply-actions:px-1.5">
          <NextIcon size={16} className="@min-[22rem]/reply-actions:hidden" />
          <span className="sr-only @min-[22rem]/reply-actions:not-sr-only">Continuing…</span>
        </p>
      ) : (
        canContinue && (
          <Tooltip label="Continue this reply" shortcut="Alt Enter">
            <Button
              variant="quiet"
              disabled={busy || !writable}
              onClick={() => void chatStore.getState().continueReply()}
              className={LABELLED}
            >
              <NextIcon size={16} className="@min-[22rem]/reply-actions:hidden" />
              <span className="sr-only @min-[22rem]/reply-actions:not-sr-only">Continue</span>
            </Button>
          </Tooltip>
        )
      )}
      <MoreMenu
        id={message.id}
        label="More actions"
        busy={busy}
        replace={{ disabled: !canGenerate || !writable }}
        alternates={count > 1}
      />
    </div>
  );
}

/** The first line or so of a greeting, for the picker. */
const opening = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Under the greeting while it is the whole chat: its alternates, stepped by
 * the arrows or picked by their opening lines (a menu; a sheet on phones).
 * Swiping stops at the last greeting.
 */
export function GreetingActions({ message }: { message: AssistantMessage }) {
  const phone = useFormFactor() === "phone";
  const busy = useChat((state) => state.generating);
  const count = message.replies.length;
  const label = `Greeting ${message.shown + 1} of ${count}`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {count > 1 && (
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">Greetings</legend>
          <IconAction
            label="Previous greeting"
            onClick={() => void swipe(-1)}
            disabled={busy || message.shown === 0}
          >
            <PreviousIcon size={16} />
          </IconAction>
          {phone ? (
            <GreetingSheet message={message} label={label} />
          ) : (
            <GreetingMenu message={message} label={label} />
          )}
          <IconAction
            label="Next greeting"
            onClick={() => void swipe(1)}
            disabled={busy || message.shown === count - 1}
          >
            <NextIcon size={16} />
          </IconAction>
        </fieldset>
      )}
      <div className="flex items-center gap-0.5">
        {count > 1 && <Divider />}
        <MoreMenu id={message.id} label="More actions" busy={busy} />
      </div>
    </div>
  );
}

const PICKER_ROW =
  "grid min-h-11 grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-2 py-2 text-ui [&>span:last-child]:line-clamp-2";

function GreetingMenu({ message, label }: { message: AssistantMessage; label: string }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="text" variant="quiet" className="gap-1.5 tabular-nums" />}>
        {label}
        <ChevronDownIcon size={16} />
      </MenuTrigger>
      <MenuContent
        label="Greetings"
        align="start"
        className="max-h-[min(20rem,var(--available-height))]"
      >
        <MenuRadioGroup
          value={message.shown}
          onValueChange={(value) => chatStore.getState().pickGreeting(Number(value))}
        >
          {message.replies.map((reply, index) => (
            <MenuRadioItem
              key={reply.id}
              value={index}
              className="h-auto min-h-11 items-start py-2"
            >
              <span className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2">
                <span className="pt-px text-note text-reed tabular-nums">{index + 1}</span>
                <span className="line-clamp-2">{opening(reply.text)}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function GreetingSheet({ message, label }: { message: AssistantMessage; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen} swipeDirection="down" showSwipeHandle>
      <Button
        size="text"
        variant="quiet"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="gap-1.5 tabular-nums"
      >
        {label}
        <ChevronDownIcon size={16} />
      </Button>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Greetings</DrawerTitle>
          <DrawerCloseIcon label="Close greetings" />
        </DrawerHeader>
        <ol
          aria-label="Greetings"
          className="grid overflow-y-auto px-2 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          {message.replies.map((reply, index) => (
            <li key={reply.id}>
              <button
                type="button"
                aria-current={index === message.shown ? "true" : undefined}
                onClick={() => {
                  chatStore.getState().pickGreeting(index);
                  setOpen(false);
                }}
                className={cn(
                  DRAWER_ROW,
                  PICKER_ROW,
                  "px-2.5",
                  index === message.shown && "bg-surface-selected hover:bg-surface-selected",
                )}
              >
                <span className="pt-px text-note text-reed tabular-nums">{index + 1}</span>
                <span className="text-ink">{opening(reply.text)}</span>
              </button>
            </li>
          ))}
        </ol>
      </DrawerContent>
    </Drawer>
  );
}
