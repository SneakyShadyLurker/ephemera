/**
 * Adapted from AI Elements' Conversation (registry, 2026-09-28): the
 * transcript download is removed (chats are never saved), the scroll button
 * is our labelled Latest control, and growth while streaming is followed
 * instantly so the view never lags behind the text.
 */

import type { ComponentProps } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { LatestIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type ConversationProps = ComponentProps<typeof StickToBottom>;

/** The one scroll owner for the thread: follows the bottom until the owner scrolls away. */
export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative min-h-0 flex-1", className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
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
  if (isAtBottom) return null;
  return (
    <div
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
