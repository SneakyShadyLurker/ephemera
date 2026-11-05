/**
 * Adapted from AI Elements' Conversation (registry, 2026-09-28): the
 * transcript download is removed (chats are never saved), the scroll button
 * is our labelled Latest control, and growth while streaming is followed
 * instantly so the view never lags behind the text. use-stick-to-bottom
 * watches only the content's size, so a scroller that shrinks (the phone
 * keyboard opening) keeps its tail in view through `KeepTail` while the story is locked.
 */

import { type ComponentProps, useEffect } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { LatestIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type ConversationProps = ComponentProps<typeof StickToBottom>;

/**
 * While the story is locked to the bottom, a scroller that gets shorter keeps the bottom in
 * view. The lock is the library's live `state.isAtBottom`: any scroll up by the owner clears it,
 * even a slight one, and Latest or a send sets it again. The context's `isAtBottom` is no lock:
 * it also holds a little way up, near the bottom.
 */
function KeepTail() {
  const { scrollRef, state, scrollToBottom, stopScroll } = useStickToBottomContext();
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
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
        top < state.targetScrollTop &&
        !state.animation?.ignoreEscapes
      ) {
        stopScroll();
      }
    };
    scroller.addEventListener("scroll", onScroll, { capture: true, passive: true });
    let height = scroller.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = scroller.clientHeight;
      if (next < height && state.isAtBottom) void scrollToBottom("instant");
      height = next;
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll, true);
    };
  }, [scrollRef, state, scrollToBottom, stopScroll]);
  return null;
}

/** The one scroll owner for the thread: follows the bottom until the owner scrolls away. */
export const Conversation = ({ className, children, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex min-h-0 flex-1 flex-col", className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  >
    {(context) => (
      <>
        <KeepTail />
        {typeof children === "function" ? children(context) : children}
      </>
    )}
  </StickToBottom>
);

export const ConversationContent = ({
  className,
  scrollClassName,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content
    scrollClassName={cn("min-h-0 flex-1", scrollClassName)}
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
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  // Always rendered, so at the bottom it leaves on `arrive`'s hidden state and returns from its start.
  return (
    <div className="max-tablet:h-11 max-tablet:shrink-0 tablet:contents">
      <div
        hidden={isAtBottom}
        inert={isAtBottom}
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
