import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useShallow } from "zustand/shallow";
import { ART_WIDTH } from "@/app/EmptyState.tsx";
import { useFormFactor } from "@/app/form-factor.ts";
import { MotionScope } from "@/app/motion.tsx";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Illustration } from "@/components/illustration.tsx";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { charactersQuery } from "../characters/queries.ts";
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
  lockedBefore,
  messageIds,
  nextPrompt,
  nthSentId,
  promptFoldedTurns,
  rememberedEnd,
  storyEmpty,
} from "./store.ts";
import { FoldLine, Tombstone, TrimMarker } from "./ThreadMarks.tsx";
import { Turn } from "./Turn.tsx";

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
  // The portrait belongs to the latest reply on every screen; -1 while none is.
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
      <FollowWriting />
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
          {presenceAt === -1 && <Presence placement={phone ? "band" : "float"} />}
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
                          presence={index === presenceAt}
                        />
                        {/* The newest message's pictures follow its actions, below. */}
                        {index < ids.length - 1 && <SceneItems anchorId={id} enter={settled} />}
                      </>
                    )}
                  </Fragment>
                ))}
                <SeamSlot here={seam !== null && seam >= ids.length} />
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
      <div
        aria-hidden="true"
        className="story-top-edge pointer-events-none absolute inset-x-0 top-0 z-(--z-raised) h-3"
      />
      <ConversationScrollButton onKeyboardUse={() => composer.current?.focus()} />
      <NameShown ids={ids} horizon={horizon} shown={shown} />
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
  useLayoutEffect(() => {
    const started = writing && !wasWriting.current;
    wasWriting.current = writing;
    if (!started) return;
    // Submission and the following resize use the same instant anchor. A spring
    // toward the old bottom would still be moving when the first words arrive.
    void scrollToBottom("instant");
  }, [writing, scrollToBottom]);
  return null;
}

/**
 * Marks the chat (`data-name-shown` on its <main>) while a character's
 * nameplate shows in the story, stuck under the header or anywhere in view,
 * so the header's title, the same name, gives way (ScreenHeader
 * `yieldsTitle`). A stuck nameplate stays in view while its turn does, so
 * one observer watches the character's nameplates against the scroller,
 * renewed when the turns change (`ids`, or folded turns shown or hidden by
 * `horizon` and `shown`, which leave `ids` as they are) or the scroller's
 * height does. A renewal keeps the mark until the new observer answers, so
 * the title does not blink; only leaving the chat, or no nameplate to
 * watch, clears it.
 */
function NameShown({
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
    return () => chat?.removeAttribute("data-name-shown");
  }, [scrollRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids`, `horizon` and `shown` change the turns to watch.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const chat = scroller?.closest("main");
    if (!scroller || !content || !chat) return;
    const inView = new Set<Element>();
    let observer: IntersectionObserver | undefined;
    const watch = () => {
      observer?.disconnect();
      inView.clear();
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.5) inView.add(entry.target);
            else inView.delete(entry.target);
          }
          chat.toggleAttribute("data-name-shown", inView.size > 0);
        },
        {
          root: scroller,
          rootMargin: `-${Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75}px 0px 0px 0px`,
          threshold: [0, 0.5],
        },
      );
      const names = content.querySelectorAll(
        '[data-message][data-role="assistant"] [data-speaker][data-voice="story"] .nameplate-name',
      );
      // With nothing to watch the observer never answers, so no name shows.
      if (names.length === 0) chat.removeAttribute("data-name-shown");
      for (const name of names) observer.observe(name);
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
 * run (no character chosen) it opens with the lit desk at the hero's size,
 * then choosing a model while none is
 * chosen (ModelStep), in room left above the invitation: the step sits at
 * the room's foot, so once a model is chosen nothing else moves. Then the
 * invitation in the story's own voice, and choosing a character in the
 * gallery, optional; with none saved yet, creating one there instead.
 * With a character the presence beside it is the welcome, and a missing
 * model is the notice's above the composer (ModelNotice).
 */
function EmptyStory({ composer }: { composer: RefObject<HTMLTextAreaElement | null> }) {
  const character = useChatCharacter();
  const chosen = useSetting((settings) => settings.characterId) !== null;
  useEmptyStoryEdge(chosen);
  const characters = useQuery(charactersQuery);
  return (
    <div className="grid content-start justify-items-start transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
      {character === undefined ? (
        <>
          <Illustration name="empty-chat" className={ART_WIDTH.hero} />
          <div className="grid min-h-[max(14dvh,--spacing(40))] content-end self-stretch">
            {!chosen && <ModelStep composer={composer} />}
          </div>
          <p className="voice-story text-heading tablet:text-title-phone">
            Write the first line, or choose a character.
          </p>
          {/* Arrives once the library has answered, so its words never change under the eye. */}
          <div className="arrive mt-4" hidden={characters.isPending}>
            <Link to="/characters" className={buttonVariants({ variant: "outline" })}>
              {characters.data?.length === 0 ? "Create a character" : "Choose a character"}
            </Link>
          </div>
        </>
      ) : (
        <p className="voice-story text-heading tablet:text-title-phone">Write the first line.</p>
      )}
    </div>
  );
}

/**
 * The scroll library stops one pixel before the physical bottom. A browser's
 * scroll-into-view of the first model picker rounds to the physical edge even
 * when it is already visible. Align the empty welcome to that same edge after
 * a resize, through the scroll owner's setter, so its first interaction is still.
 */
function useEmptyStoryEdge(chosen: boolean) {
  const { scrollRef, contentRef, state } = useStickToBottomContext();
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (chosen || !scroll || !content) return;
    let frame = 0;
    const align = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (state.isAtBottom) state.scrollTop = scroll.scrollHeight - scroll.clientHeight;
      });
    };
    const observer = new ResizeObserver(align);
    observer.observe(scroll);
    observer.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [chosen, scrollRef, contentRef, state]);
}
