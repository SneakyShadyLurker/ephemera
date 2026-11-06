/**
 * Adapted from AI Elements' Conversation (registry, 2026-09-28): the
 * transcript download is removed (chats are never saved), the scroll button
 * is our labelled Latest control, and growth while streaming is followed
 * instantly so the view never lags behind the text. use-stick-to-bottom
 * watches only the content's size, so a scroller that shrinks (the phone
 * keyboard opening) keeps its tail in view through `KeepTail` while the story is locked.
 */

import {
  type ComponentProps,
  createContext,
  type RefObject,
  use,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { StickToBottom, useStickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { LatestIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type ConversationProps = Omit<ComponentProps<typeof StickToBottom>, "instance">;

/** Transient reading intent and one focus handoff, owned by this mounted conversation. */
const ConversationReading = createContext<{
  following: () => boolean;
  movement: RefObject<number>;
  rejoin: RefObject<{ version: number; movement: number }>;
  restoringFocus: RefObject<boolean>;
  focusRestored: (target: HTMLElement) => void;
  restoreScrollTop: (top: number) => void;
  restoreTail: () => void;
} | null>(null);

export function useConversationReading() {
  const reading = use(ConversationReading);
  if (!reading) throw new Error("Reading intent needs a Conversation");
  return reading;
}

/**
 * While the story is locked to the bottom, a scroller that gets shorter keeps the bottom in
 * view. The lock is the library's live `state.isAtBottom`: any scroll up by the owner clears it,
 * even a slight one, and Latest or a send sets it again. The context's `isAtBottom` is no lock:
 * it also holds a little way up, near the bottom.
 */
function KeepTail({ escaped }: { escaped: RefObject<boolean> }) {
  const { scrollRef, contentRef, state, scrollToBottom, stopScroll } = useStickToBottomContext();
  const { movement, restoringFocus, restoreScrollTop } = useConversationReading();
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let scrollbar = false;
    let touchY: number | undefined;
    const onPointerDown = (event: PointerEvent) => {
      // A native scrollbar drag is owner input; layout clamping is not.
      scrollbar =
        event.target === scroller &&
        event.clientX >=
          scroller.getBoundingClientRect().right -
            Math.max(16, scroller.offsetWidth - scroller.clientWidth);
    };
    const onPointerUp = () => {
      scrollbar = false;
    };
    // The library defers scroll escapes until after resize observers. Release the lock before
    // a pending follow frame or a simultaneous viewport shrink can overwrite an upward scroll.
    const onScroll = (event: Event) => {
      if (event.target !== scroller) return;
      const top = scroller.scrollTop;
      const end = scroller.scrollHeight - scroller.clientHeight;
      // A late library write may leave its target one pixel short after our
      // resize callback. Only its marked write is ours; an owner pixel still escapes.
      if (
        !escaped.current &&
        state.isAtBottom &&
        top === state.ignoreScrollToTop &&
        end > top &&
        end - top <= 1
      ) {
        restoreScrollTop(end);
        return;
      }
      const previous = Math.max(state.lastScrollTop ?? top, state.ignoreScrollToTop ?? top);
      if (
        top < previous &&
        top !== state.ignoreScrollToTop &&
        // A shorter story or taller viewport may clamp the scroll position to its new end.
        top < scroller.scrollHeight - scroller.clientHeight &&
        !state.animation?.ignoreEscapes
      ) {
        if (scrollbar) movement.current++;
        stopScroll();
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || state.animation?.ignoreEscapes) return;
      let target = event.target instanceof Element ? event.target : null;
      while (target !== null && target !== scroller) {
        if (
          /(auto|scroll)/.test(getComputedStyle(target).overflowY) &&
          target.scrollHeight > target.clientHeight
        )
          return;
        target = target.parentElement;
      }
      if (target === scroller && scroller.scrollHeight > scroller.clientHeight) {
        movement.current++;
        stopScroll();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        event.target.closest(
          'textarea, input, [contenteditable="true"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (scroller.scrollHeight <= scroller.clientHeight) return;
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        movement.current++;
        stopScroll();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
      let target = event.target instanceof Element ? event.target : null;
      while (target !== null && target !== scroller) {
        if (
          /(auto|scroll)/.test(getComputedStyle(target).overflowY) &&
          target.scrollHeight > target.clientHeight
        ) {
          touchY = undefined;
          return;
        }
        target = target.parentElement;
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (
        next !== undefined &&
        touchY !== undefined &&
        next > touchY &&
        !state.animation?.ignoreEscapes &&
        scroller.scrollHeight > scroller.clientHeight
      ) {
        movement.current++;
        stopScroll();
      }
      touchY = next;
    };
    const onFocusIn = (event: FocusEvent) => {
      if (restoringFocus.current) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
      const plate = target.closest<HTMLElement>("[data-speaker]");
      const turn = plate?.closest<HTMLElement>("[data-message]");
      if (!plate || !turn) return;
      const edge = Number.parseFloat(getComputedStyle(plate).top) || 0;
      const top = scroller.getBoundingClientRect().top;
      if (target.getBoundingClientRect().top >= top + edge) return;
      // A sticky plate's More overhangs its text. Native focus considers that
      // box visible, even inside the occlusion strip. Reveal its turn with the
      // existing focus clearance, without moving focus or the action's layout.
      const clearance = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || edge;
      movement.current++;
      stopScroll();
      scroller.scrollTop += turn.getBoundingClientRect().top - top - clearance;
    };
    scroller.addEventListener("scroll", onScroll, { capture: true, passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("focusin", onFocusIn);
    scroller.addEventListener("pointerdown", onPointerDown);
    scroller.addEventListener("pointerup", onPointerUp);
    scroller.addEventListener("pointercancel", onPointerUp);
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    const observer = new ResizeObserver(() => {
      // A negative content resize can make the library re-lock an escaped view.
      // Reconcile that callback before its next animation frame, using the same
      // stop API as user escape. Only Latest/send explicitly release this intent.
      if (escaped.current) stopScroll();
      else if (state.isAtBottom) {
        // The library's target is one pixel short. Our Latest affordance reflects
        // the physical end, so a following view takes that final pixel as well.
        restoreScrollTop(scroller.scrollHeight - scroller.clientHeight);
        void scrollToBottom({ animation: "instant", preserveScrollPosition: true });
      }
    });
    observer.observe(scroller);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll, true);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("focusin", onFocusIn);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("pointerup", onPointerUp);
      scroller.removeEventListener("pointercancel", onPointerUp);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
    };
  }, [
    scrollRef,
    contentRef,
    state,
    scrollToBottom,
    stopScroll,
    escaped,
    movement,
    restoringFocus,
    restoreScrollTop,
  ]);
  return null;
}

/** The one scroll owner for the thread: follows the bottom until the owner scrolls away. */
export const Conversation = ({
  className,
  children,
  initial = "instant",
  resize = "instant",
  ...props
}: ConversationProps) => {
  const instance = useStickToBottom({ initial, resize });
  const { scrollRef, stopScroll: stop, scrollToBottom: follow } = instance;
  const live = useRef(instance.state);
  // Intent belongs to this scroll owner alone. The library may reset its public
  // escaped state on shrink; this ref lets KeepTail reconcile that known case.
  const escaped = useRef(false);
  const movement = useRef(0);
  const rejoin = useRef({ version: 0, movement: 0 });
  const restoringFocus = useRef(false);
  const adoptFollowing = useCallback(() => {
    escaped.current = false;
    const scroller = scrollRef.current;
    if (scroller) scroller.style.overflowAnchor = "none";
    // Adopt the current origin through the library's public setter, so an
    // already-queued layout scroll is not mistaken for an upward escape.
    const origin = live.current.scrollTop;
    live.current.scrollTop = origin;
  }, [scrollRef]);
  const restoreScrollTop = useCallback((top: number) => {
    live.current.scrollTop = top;
  }, []);
  const restoreTail = useCallback(() => {
    // Undo preserves the chosen intent; it is not another owner rejoin.
    adoptFollowing();
    void follow("instant");
    const scroller = scrollRef.current;
    if (scroller) live.current.scrollTop = scroller.scrollHeight - scroller.clientHeight;
  }, [adoptFollowing, follow, scrollRef]);
  const stopScroll = useCallback(() => {
    escaped.current = true;
    const scroller = scrollRef.current;
    if (scroller) scroller.style.overflowAnchor = "auto";
    stop();
  }, [scrollRef, stop]);
  const scrollToBottom = useCallback<typeof instance.scrollToBottom>(
    (options) => {
      if (typeof options !== "object" || !options.preserveScrollPosition) {
        rejoin.current = { version: rejoin.current.version + 1, movement: movement.current };
        adoptFollowing();
      }
      const followed = follow(options);
      void Promise.resolve(followed).then((atEnd) => {
        const scroller = scrollRef.current;
        if (atEnd && !escaped.current && scroller && live.current.isAtBottom)
          live.current.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      });
      return followed;
    },
    [scrollRef, follow, adoptFollowing],
  );
  return (
    <StickToBottom
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      instance={{
        ...instance,
        // scrollToBottom reacquires the lock before a scroll event clears the
        // library's escaped flag, including a one-pixel rejoin at its target.
        escapedFromLock: instance.escapedFromLock && !instance.state.isAtBottom,
        stopScroll,
        scrollToBottom,
      }}
      role="log"
      {...props}
    >
      {(context) => (
        <ConversationReading
          value={{
            following: () => !escaped.current && live.current.isAtBottom,
            movement,
            rejoin,
            restoringFocus,
            restoreScrollTop,
            restoreTail,
            focusRestored: (target) => {
              restoringFocus.current = true;
              target.focus({ preventScroll: true });
              restoringFocus.current = false;
            },
          }}
        >
          {typeof children === "function" ? children(context) : children}
          <KeepTail escaped={escaped} />
        </ConversationReading>
      )}
    </StickToBottom>
  );
};

export const ConversationContent = ({
  className,
  scrollClassName,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content
    scrollClassName={cn("min-h-0 flex-1 [overflow-anchor:none]", scrollClassName)}
    className={cn("flex flex-col", className)}
    {...props}
  />
);

/** Shown only when there is real content below the visible story, regardless of follow intent. */
export const ConversationScrollButton = ({
  className,
  onKeyboardUse,
}: {
  className?: string;
  /** Latest disappears once used; keyboard focus needs somewhere to go. */
  onKeyboardUse?: () => void;
}) => {
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottomContext();
  const [atEnd, setAtEnd] = useState(true);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const update = () =>
      setAtEnd(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 0.5);
    let frame = 0;
    // Read after the resize batch: the library can briefly write its one-pixel
    // target before KeepTail restores the physical end in that same batch.
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  }, [scrollRef, contentRef]);
  // Always rendered, so at the bottom it leaves on `arrive`'s hidden state and returns from its start.
  return (
    <div className="max-tablet:h-11 max-tablet:shrink-0 tablet:contents">
      <div
        hidden={atEnd}
        inert={atEnd}
        className={cn(
          // Above the turns' sticky nameplates, which pass behind it while the story scrolls.
          "relative grid h-11 place-items-center arrive tablet:absolute tablet:bottom-3 tablet:left-1/2 tablet:-translate-x-1/2 tablet:z-(--z-raised)",
          className,
        )}
      >
        <Button
          variant="outline"
          className="bg-surface shadow-overlay"
          onClick={(event) => {
            const byKeyboard = event.currentTarget.matches(":focus-visible");
            void scrollToBottom(scrollBehavior());
            if (byKeyboard) onKeyboardUse?.();
          }}
        >
          <LatestIcon />
          Latest
        </Button>
      </div>
    </div>
  );
};
