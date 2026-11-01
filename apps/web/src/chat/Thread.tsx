import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useShallow } from "zustand/shallow";
import { useFormFactor } from "@/app/form-factor.ts";
import { MotionScope } from "@/app/motion.tsx";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { setSessionOpen } from "@/app/ui.ts";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useSetting } from "../settings/settings.ts";
import { useChatCharacter } from "./character.ts";
import { SCRIPT_FRAME } from "./frame.ts";
import { SeamSlot, seamIndex } from "./MemorySeam.tsx";
import { ModelStep } from "./ModelNotice.tsx";
import { loadMarkdown } from "./markdown-chunk.ts";
import { Presence } from "./Presence.tsx";
import { SceneItems } from "./Scene.tsx";
import { useChat } from "./session.ts";
import {
  type ChatState,
  lastReply,
  lockedBefore,
  messageIds,
  nextPrompt,
  nthSentId,
  promptFoldedTurns,
  rememberedEnd,
  shownReply,
  storyEmpty,
} from "./store.ts";
import { FoldLine, Tombstone, TrimMarker } from "./ThreadMarks.tsx";
import { Turn } from "./Turn.tsx";
import { GreetingActions, ReplyActions } from "./TurnActions.tsx";

/**
 * Where the next prompt starts once the window is full: the first sent turn,
 * and how many are left out. A fold the prompt made and the tab did not
 * leaves its turns out ahead of the trim.
 */
function trimPoint(state: ChatState): { before: string; count: number } | null {
  const prompt = nextPrompt(state);
  if (!prompt) return null;
  const count = prompt.history.total - prompt.history.sent;
  if (count <= 0) return null;
  const before = nthSentId(state.messages, state.memory.horizon, promptFoldedTurns(state) + count);
  return before === undefined ? null : { before, count };
}

/**
 * The story so far; the one scroll owner follows new text until the owner
 * scrolls away. Turns folded into memories show only when the owner asks,
 * dimmed and read-only, above the seam.
 */
export function Thread({ composer }: { composer: RefObject<HTMLTextAreaElement | null> }) {
  // Ids only, so a streaming turn re-renders itself, not the thread.
  const ids = useChat(useShallow(messageIds));
  const generating = useChat((state) => state.generating);
  // Where the tombstone goes: at the deleted messages' place, or after the reply an alternate left.
  const deletedAt = useChat((state) =>
    state.deleted === null
      ? null
      : state.deleted.kind === "messages"
        ? state.deleted.index
        : state.messages.length,
  );
  const phone = useFormFactor() === "phone";
  const trim = useChat(useShallow(trimPoint));
  const horizon = useChat((state) => state.memory.horizon);
  const shown = useChat((state) => state.memory.shown);
  // Shown, the folded turns end where the held ones, still sent, begin.
  const foldEnd = useChat((state) =>
    state.memory.horizon > 0 && state.memory.horizon < rememberedEnd(state.memory)
      ? state.memory.horizon
      : null,
  );
  const seam = useChat((state) => seamIndex(state.memory));
  // From tablet up the portrait floats at the head of the latest reply shown; -1 while none is.
  const latestReply = useChat((state) =>
    state.messages.findLastIndex(
      (message, index) =>
        message.role === "assistant" && (index >= state.memory.horizon || state.memory.shown),
    ),
  );
  const held = usePresenceHeld();
  const [presenceAt, setPresenceAt] = useState(latestReply);
  if (!held && presenceAt !== latestReply) setPresenceAt(latestReply);
  const locked = useChat(lockedBefore);
  const trailingTombstone = deletedAt !== null && deletedAt >= ids.length;
  // Turns already present when the thread mounts (returning from another screen) do not replay their entrance.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(true);
    void loadMarkdown();
  }, []);

  return (
    // Busy while a reply streams, so screen readers announce it once complete, not per fragment.
    <Conversation aria-label="Story" aria-busy={generating}>
      <ConversationContent
        // Phones keep no reserved scrollbar gutter, so the story keeps its 20px margins.
        scrollClassName="overscroll-contain [scroll-timeline:--thread] max-tablet:[scrollbar-gutter:auto]!"
        className={cn(SCRIPT_FRAME, "min-h-full pt-6 pb-8")}
      >
        {/*
         * A flow root, so a portrait floated beside an empty story stays inside it, and the
         * story's container: its prose measure and the portrait's column follow its width.
         */}
        <div className="@container/story flow-root">
          {phone ? (
            <Presence placement="band" />
          ) : (
            presenceAt === -1 && <Presence placement="float" />
          )}
          {ids.length === 0 ? (
            deletedAt === null && <EmptyStory composer={composer} />
          ) : (
            <MotionScope>
              {/* The one column never grows past the story's width, whatever a turn holds. */}
              <ol className="grid grid-cols-[minmax(0,1fr)] gap-8 tablet:gap-10">
                {ids.map((id, index) => (
                  <Fragment key={id}>
                    {deletedAt === index && <Tombstone />}
                    <SeamSlot here={seam === index} />
                    {shown && foldEnd === index && <FoldLine />}
                    {trim?.before === id && <TrimMarker count={trim.count} />}
                    {(index >= horizon || shown) && (
                      <>
                        <Turn
                          id={id}
                          index={index}
                          enter={settled}
                          last={index === ids.length - 1}
                          folded={index < horizon}
                          locked={index < locked}
                          presence={!phone && index === presenceAt}
                        />
                        {/* The newest message's pictures follow its actions, below. */}
                        {index < ids.length - 1 && <SceneItems anchorId={id} enter={settled} />}
                      </>
                    )}
                  </Fragment>
                ))}
                <SeamSlot here={seam !== null && seam >= ids.length} />
                <LastReplyActions key={ids.at(-1)} />
                {(ids.length - 1 >= horizon || shown) && (
                  <SceneItems anchorId={ids.at(-1) ?? ""} enter={settled} />
                )}
              </ol>
            </MotionScope>
          )}
          {trailingTombstone && (
            <ol
              className={cn(
                "grid grid-cols-[minmax(0,1fr)] gap-8 tablet:gap-10",
                ids.length > 0 && "mt-8 tablet:mt-10",
              )}
            >
              <Tombstone />
            </ol>
          )}
        </div>
      </ConversationContent>
      <ConversationScrollButton onKeyboardUse={() => composer.current?.focus()} />
      <FollowWriting />
      <NameStuck ids={ids} horizon={horizon} shown={shown} />
    </Conversation>
  );
}

/**
 * A reply or continuation starting brings the view back to the newest text
 * and follows it again, however far the owner had scrolled away. Impersonate
 * writes into the composer, so the story keeps its place. A thread mounting
 * mid-reply is already placed at the bottom by the scroll owner.
 */
function FollowWriting() {
  const { scrollToBottom } = useStickToBottomContext();
  const writing = useChat(
    (state) => state.generationMode === "reply" || state.generationMode === "continue",
  );
  const wasWriting = useRef(writing);
  useEffect(() => {
    const started = writing && !wasWriting.current;
    wasWriting.current = writing;
    if (!started) return;
    void scrollToBottom(scrollBehavior());
  }, [writing, scrollToBottom]);
  return null;
}

/** Where a nameplate sticks: its `top` in styles.css (`nameplate`), and a pixel below it. */
const STUCK_LINE = 13;

/**
 * Marks the chat (`data-name-stuck` on its <main>) while a character's
 * nameplate is stuck under the header, so the header's title, the same
 * name, gives way (ScreenHeader `yieldsTitle`). A nameplate sticks while its
 * turn crosses the line it sticks at, so one observer watches the
 * character's turns against a band one pixel high there, renewed when the
 * turns change (`ids`, or folded turns shown or hidden by `horizon` and
 * `shown`, which leave `ids` as they are) or the scroller's height does.
 * A renewal keeps the mark until the new observer answers, so the title
 * does not blink; only leaving the chat, or no turn to watch, clears it.
 */
function NameStuck({
  ids,
  horizon,
  shown,
}: {
  ids: readonly string[];
  horizon: number;
  shown: boolean;
}) {
  const { scrollRef, contentRef } = useStickToBottomContext();
  useEffect(() => {
    const chat = scrollRef.current?.closest("main");
    return () => chat?.removeAttribute("data-name-stuck");
  }, [scrollRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids`, `horizon` and `shown` change the turns to watch.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const chat = scroller?.closest("main");
    if (!scroller || !content || !chat) return;
    const crossing = new Set<Element>();
    let observer: IntersectionObserver | undefined;
    const watch = () => {
      observer?.disconnect();
      crossing.clear();
      const below = Math.max(0, scroller.clientHeight - STUCK_LINE - 1);
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) crossing.add(entry.target);
            else crossing.delete(entry.target);
          }
          chat.toggleAttribute("data-name-stuck", crossing.size > 0);
        },
        { root: scroller, rootMargin: `-${STUCK_LINE}px 0px -${below}px 0px` },
      );
      const turns = content.querySelectorAll('[data-message][data-role="assistant"]');
      // With no turn to watch the observer never answers, so nothing is stuck.
      if (turns.length === 0) chat.removeAttribute("data-name-stuck");
      for (const turn of turns) observer.observe(turn);
    };
    const resized = new ResizeObserver(watch);
    resized.observe(scroller);
    return () => {
      resized.disconnect();
      observer?.disconnect();
    };
  }, [scrollRef, contentRef, ids, horizon, shown]);
  return null;
}

const PRESENCE_FOCUS = "[data-presence], [data-portrait-viewer]";

/**
 * Whether focus is on the portrait or in its viewer. The portrait keeps its
 * place meanwhile: moving it remounts it, which would close an open viewer
 * and drop focus. Focus arriving holds it at once; leaving is read a frame
 * later, so the hop between the viewer and its trigger never reads as focus
 * leaving.
 */
function usePresenceHeld() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let frame = 0;
    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(PRESENCE_FOCUS) === null)
        return;
      cancelAnimationFrame(frame);
      setHeld(true);
    };
    const onFocusOut = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setHeld(document.activeElement?.closest(PRESENCE_FOCUS) != null),
      );
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return held;
}

/** Said wherever the chat invites the first line: nothing here is kept. */
const RETENTION = "This conversation isn't saved. Refreshing or closing this tab clears it.";

/**
 * By the composer while the story is empty: nothing written here is kept.
 * It leaves with the first line, and the story takes its room, so the
 * composer stays where it is.
 */
export function RetentionNote() {
  const empty = useChat(storyEmpty);
  if (!empty) return null;
  return (
    <div className={SCRIPT_FRAME}>
      <p className="max-w-empty pb-2 text-pretty text-note text-reed transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
        {RETENTION}
      </p>
    </div>
  );
}

/**
 * The empty story, one composition on the story's own column. On a first
 * run (no character chosen) it opens with choosing a model while none is
 * chosen (ModelStep), in room left above the invitation: the step sits at
 * the room's foot, so once a model is chosen nothing else moves. Then the
 * invitation in the story's own voice, and choosing a character, optional.
 * With a character the presence beside it is the welcome, and a missing
 * model is the notice's above the composer (ModelNotice).
 */
function EmptyStory({ composer }: { composer: RefObject<HTMLTextAreaElement | null> }) {
  const character = useChatCharacter();
  const chosen = useSetting((settings) => settings.characterId) !== null;
  return (
    <div className="grid content-start justify-items-start transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
      {character === undefined ? (
        <>
          <div className="grid min-h-[max(14dvh,--spacing(40))] content-end self-stretch">
            {!chosen && <ModelStep composer={composer} />}
          </div>
          <p className="voice-story text-heading tablet:text-title-phone">
            Write the first line, or choose a character.
          </p>
          <Button variant="outline" className="mt-4" onClick={() => setSessionOpen(true)}>
            Choose a character
          </Button>
        </>
      ) : (
        <p className="voice-story text-heading tablet:text-title-phone">Write the first line.</p>
      )}
    </div>
  );
}

/**
 * The last reply's actions, as their own row below it: shown once the reply
 * settles, so nothing below a streaming reply moves, and keyed by the reply,
 * so a new last reply brings a new row instead of moving the old one. A
 * greeting without alternates has no row: its own More carries Edit and Delete.
 */
function LastReplyActions() {
  const message = useChat((state) => lastReply(state));
  const editing = useChat((state) => state.editing !== null && state.editing.id === message?.id);
  // Remembered, or being remembered: read-only.
  const locked = useChat(
    (state) =>
      message !== undefined &&
      (state.messages.at(-1) !== message || state.messages.length - 1 < lockedBefore(state)),
  );
  if (
    message === undefined ||
    locked ||
    (message.greeting && message.replies.length === 1) ||
    editing ||
    shownReply(message).status === "streaming" ||
    shownReply(message).status === "waiting"
  )
    return null;
  return (
    <li
      data-reply-actions=""
      className="-mt-6 -ml-2 transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0 tablet:-mt-8"
    >
      {message.greeting ? (
        <GreetingActions message={message} />
      ) : (
        <ReplyActions message={message} />
      )}
    </li>
  );
}
