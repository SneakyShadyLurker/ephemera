import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { POPUP_EDGE } from "@/components/ui/positioner";
import { cn } from "@/lib/cn";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
/** A visible title, for a surface that names itself in its own header. */
const PopoverTitle = PopoverPrimitive.Title;

/**
 * A non-modal surface under its trigger, labelled by a visually hidden title
 * (or by a `PopoverTitle` among its children when `title` is left out).
 * `className` resizes it (a working surface such as the rework's composer);
 * `anchor` hangs it from an element other than a trigger; `side`,
 * `initialFocus`, `finalFocus` and `collisionAvoidance` are Base UI's.
 */
function PopoverContent({
  title,
  children,
  align = "start",
  side,
  className,
  anchor,
  collisionAvoidance,
  initialFocus,
  finalFocus,
}: {
  title?: string;
  children: ReactNode;
  align?: PopoverPrimitive.Positioner.Props["align"];
  side?: PopoverPrimitive.Positioner.Props["side"];
  className?: string;
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  collisionAvoidance?: PopoverPrimitive.Positioner.Props["collisionAvoidance"];
  initialFocus?: PopoverPrimitive.Popup.Props["initialFocus"];
  finalFocus?: PopoverPrimitive.Popup.Props["finalFocus"];
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        sideOffset={6}
        collisionPadding={POPUP_EDGE}
        align={align}
        side={side}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className="z-(--z-overlay)"
      >
        <PopoverPrimitive.Popup
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          className={cn(
            "pop flex max-h-[min(26rem,var(--available-height))] w-72 flex-col rounded-lg border border-rush bg-surface p-1 shadow-overlay outline-none",
            className,
          )}
        >
          {title !== undefined && (
            <PopoverPrimitive.Title className="sr-only">{title}</PopoverPrimitive.Title>
          )}
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTitle, PopoverTrigger };
