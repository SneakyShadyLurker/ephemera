/**
 * Adapted from AI Elements' Conversation (registry, 2026-09-28): the
 * transcript download is removed (chats are never saved), the scroll button
 * is our labelled Latest control, and growth while streaming is followed
 * instantly so the view never lags behind the text. use-stick-to-bottom
 * watches only the content's size, so a scroller that shrinks (the phone
 * keyboard opening) keeps its tail in view through `KeepTail` while the story is locked.
 */

import { type ComponentProps, type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { StickToBottom, useStickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { LatestIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type ConversationProps = Omit<ComponentProps<typeof StickToBottom>, "instance">;

/**
 * While the story is locked to the bottom, a scroller that gets shorter keeps the bottom in
 * view. The lock is the library's live `state.isAtBottom`: any scroll up by the owner clears it,
 * even a slight one, and Latest or a send sets it again. The context's `isAtBottom` is no lock:
 * it also holds a little way up, near the bottom.
 */
function KeepTail({ escaped }: { escaped: RefObject<boolean> }) {
  const { scrollRef, contentRef, state, scrollToBottom, stopScroll } = useStickToBottomContext();
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    // The library defers scroll escapes until after resize observers. Release the lock before
    // a pending follow frame or a simultaneous viewport shrink can overwrite an upward scroll.
    const onScroll = (event: Event) => {
      if (event.target !== scroller) return;
      const top = scroller.scrollTop;
      const previous = Math.max(state.lastScrollTop ?? top, state.ignoreScrollToTop ?? top);
      if (
        top < previous &&
        top !== state.ignoreScrollToTop &&
        // A shorter story or taller viewport may clamp the scroll position to its new end.
        top < scroller.scrollHeight - scroller.clientHeight &&
        !state.animation?.ignoreEscapes
      ) {
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
      if (target === scroller && scroller.scrollHeight > scroller.clientHeight) stopScroll();
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
      )
        stopScroll();
    };
    const onFocusIn = (event: FocusEvent) => {
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
      stopScroll();
      scroller.scrollTop += turn.getBoundingClientRect().top - top - clearance;
    };
    scroller.addEventListener("scroll", onScroll, { capture: true, passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("focusin", onFocusIn);
    const observer = new ResizeObserver(() => {
      // A negative content resize can make the library re-lock an escaped view.
      // Reconcile that callback before its next animation frame, using the same
      // stop API as user escape. Only Latest/send explicitly release this intent.
      if (escaped.current) stopScroll();
      else if (state.isAtBottom)
        void scrollToBottom({ animation: "instant", preserveScrollPosition: true });
    });
    observer.observe(scroller);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll, true);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("focusin", onFocusIn);
    };
  }, [scrollRef, contentRef, state, scrollToBottom, stopScroll, escaped]);
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
  const stopScroll = useCallback(() => {
    escaped.current = true;
    const scroller = scrollRef.current;
    if (scroller) scroller.style.overflowAnchor = "auto";
    stop();
  }, [scrollRef, stop]);
  const scrollToBottom = useCallback<typeof instance.scrollToBottom>(
    (options) => {
      if (typeof options !== "object" || !options.preserveScrollPosition) {
        escaped.current = false;
        const scroller = scrollRef.current;
        if (scroller) scroller.style.overflowAnchor = "none";
        // Explicit rejoin adopts the current position before the library's next
        // frame. Its public setter marks any already-queued scroll as ours;
        // an upward pixel after this point still escapes synchronously.
        const origin = live.current.scrollTop;
        live.current.scrollTop = origin;
      }
      return follow(options);
    },
    [scrollRef, follow],
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
        <>
          {typeof children === "function" ? children(context) : children}
          <KeepTail escaped={escaped} />
        </>
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

/** Shown only when the owner has scrolled away from the newest text. */
export const ConversationScrollButton = ({
  className,
  onKeyboardUse,
}: {
  className?: string;
  /** Latest disappears once used; keyboard focus needs somewhere to go. */
  onKeyboardUse?: () => void;
}) => {
  const { isAtBottom, escapedFromLock, scrollToBottom } = useStickToBottomContext();
  const following = isAtBottom && !escapedFromLock;
  // Always rendered, so at the bottom it leaves on `arrive`'s hidden state and returns from its start.
  return (
    <div className="max-tablet:h-11 max-tablet:shrink-0 tablet:contents">
      <div
        hidden={following}
        inert={following}
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
