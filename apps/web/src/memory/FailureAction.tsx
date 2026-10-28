import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { chatStore } from "../chat/session.ts";
import { FAILURE_ACTION_LABEL, type FailureAction } from "./failure.ts";

/** A quiet action in a line of small text, 44px on touch. */
const ACTION = cn(buttonVariants({ variant: "quiet" }), "h-8 px-2 text-ink text-note touch:h-11");

/**
 * A failed memory call's way out (`failureNote`), on the seam and on the
 * memory screen: Try again, the Settings that size the call, or the memory
 * screen to make room, which knows it came from the chat.
 */
export function MemoryFailureAction({
  action,
  characterId,
}: {
  action: FailureAction;
  characterId: string;
}) {
  if (action === null) return null;
  const label = FAILURE_ACTION_LABEL[action];
  switch (action) {
    case "retry":
      return (
        <Button
          variant="quiet"
          className={ACTION}
          onClick={() => void chatStore.getState().rememberNow()}
        >
          {label}
        </Button>
      );
    case "window":
    case "settings":
      return (
        <Link to="/settings" className={ACTION}>
          {label}
        </Link>
      );
    case "memory":
      return (
        <Link
          to="/characters/$id/memory"
          params={{ id: characterId }}
          search={{ from: "chat" }}
          className={ACTION}
        >
          {label}
        </Link>
      );
  }
}
