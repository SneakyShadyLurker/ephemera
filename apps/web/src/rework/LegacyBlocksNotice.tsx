import { legacyBlocks } from "@ephemera/core";
import { useId, useState } from "react";
import { LampFlameIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { fitsRework, legacyBlockLabels, offerText, prefillOffer } from "./offer.ts";
import { reworkStore } from "./session.ts";

/**
 * The Description section's offer to rework a card whose description holds
 * top-level blocks folded in from an older card format: what was folded in,
 * and a button that opens the AI Rework composer with the request written
 * (one the owner typed is kept). Derived from the live description, so it
 * leaves once the blocks do (Apply, a hand edit) and returns with them
 * (Undo); it opens and closes its height with a fade, a fade at full height
 * under reduced motion, then gone. The button waits on the same gates as the header's AI
 * Rework, and on a description too long for Rework to take.
 */
export function LegacyBlocksNotice({
  description,
  id,
  locked,
  portraitChanging,
  onCompose,
}: {
  description: string;
  /** The character's id; null until the sheet's first save. */
  id: string | null;
  /** An AI Rework works or is under review. */
  locked: boolean;
  /** The portrait is being uploaded, removed or replaced by New art. */
  portraitChanging: boolean;
  /** Opens the AI Rework composer. */
  onCompose: () => void;
}) {
  const textId = useId();
  const labels = legacyBlockLabels(legacyBlocks(description));
  const current = labels.length === 0 ? null : offerText(labels);
  /** The sentence last shown, kept while the notice closes. */
  const [shown, setShown] = useState(current);
  if (current !== null && current !== shown) setShown(current);
  if (shown === null) return null;

  const leaving = current === null;
  const fits = fitsRework(description);
  return (
    <div
      inert={leaving}
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget && event.propertyName === "opacity")
          setShown(null);
      }}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--duration-panel-in) ease-spring motion-reduce:transition-[opacity,grid-template-rows] motion-reduce:[transition-duration:var(--duration-quick),0s] motion-reduce:[transition-delay:0s,var(--duration-quick)] starting:grid-rows-[0fr] starting:opacity-0",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
    >
      <div className="min-h-0 overflow-clip">
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-dusk-line border-l-2 py-0.5 pl-3.5">
          <p id={textId} className="min-w-0 flex-1 basis-64 text-pretty text-ink text-note">
            {shown}
            {!fits && " Shorten the description below the limit to rework it."}
          </p>
          <Button
            variant="outline"
            size="text"
            aria-describedby={textId}
            disabled={id === null || locked || portraitChanging || !fits}
            onClick={() => {
              prefillOffer(reworkStore.getState());
              onCompose();
            }}
          >
            <LampFlameIcon size={14} />
            Rework this card
          </Button>
        </div>
      </div>
    </div>
  );
}
