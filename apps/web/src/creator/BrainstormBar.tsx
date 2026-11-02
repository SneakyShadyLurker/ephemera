import { useEffect, useRef } from "react";
import { SCROLL_GUTTERS } from "@/app/Screen.tsx";
import { StopIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { COLUMN } from "./Choose.tsx";
import { useCreator } from "./session.ts";

/**
 * The brainstorm's bar under the scroller while a round runs, as the
 * showcase's Keep bar: one Stop, which takes focus from the control that
 * sent the round. What arrived stays as the list.
 */
export function BrainstormBar() {
  const stop = useCreator((state) => state.stopIdeas);
  const button = useRef<HTMLButtonElement>(null);

  // The submit that sent the round is gone or disabled: focus moves here, unless the owner is elsewhere.
  useEffect(() => {
    const active = document.activeElement;
    const main = button.current?.closest("main");
    if (active === null || active === document.body || main?.contains(active)) {
      button.current?.focus({ preventScroll: true });
    }
  }, []);

  return (
    // The scroller's gutters above it, so the bar's frame keeps the column's edges.
    <div
      className={cn(
        "shrink-0 border-rush border-t bg-canvas pb-[env(safe-area-inset-bottom)] arrive",
        SCROLL_GUTTERS,
      )}
    >
      <div className={cn(COLUMN, "flex justify-end py-3")}>
        <Button ref={button} variant="outline" onClick={stop} className="max-tablet:w-full">
          <StopIcon size={16} />
          Stop
        </Button>
      </div>
    </div>
  );
}
