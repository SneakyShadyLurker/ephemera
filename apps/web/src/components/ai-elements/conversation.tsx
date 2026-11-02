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
 * even a slight one, and Latest or a send sets it again. (The context's `isAtBottom` also holds
 * near the bottom, and `escapedFromLock` can outlast a return through Latest.)
 */
function KeepTail() {
  const { scrollRef, state, scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    let height = scroller.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = scroller.clientHeight;
      if (next < height && state.isAtBottom) void scrollToBottom("instant");
      height = next;
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollRef, state, scrollToBottom]);
  return null;
}

/** The one scroll owner for the thread: follows the bottom until the owner scrolls away. */
export const Conversation = ({ className, children, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative min-h-0 flex-1", className)}
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
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content className={cn("flex flex-col", className)} {...props} />
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
    <div
      hidden={isAtBottom}
      inert={isAtBottom}
      className={cn(
        // Above the turns' sticky nameplates, which pass behind it while the story scrolls.
        "absolute bottom-3 left-1/2 z-(--z-raised) -translate-x-1/2 arrive",
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
  );
};
