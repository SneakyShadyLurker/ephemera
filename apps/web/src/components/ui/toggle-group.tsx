import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn";

/*
 * The segmented control's one skin, for toggles (ToggleGroup) and radios
 * (radio-group.tsx RadioSegments) alike: a hairline well with a 2px inset
 * and gap, segments 32px tall on fine pointers and 44px on touch, the
 * chosen one on the selected surface in full ink.
 */
export const SEGMENTS = "gap-0.5 rounded-md border border-rush p-0.5";
export const SEGMENT = "press rounded-sm text-reed hover:bg-surface-hover hover:text-ink";
/** A segment holding a word, or an icon and a word. */
export const SEGMENT_LABELLED = "h-8 items-center gap-2 px-3 text-ui touch:h-11";

function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props<string>) {
  return <ToggleGroupPrimitive className={cn("inline-flex", SEGMENTS, className)} {...props} />;
}

/**
 * One option; the pressed one gets the selected surface and full ink. Icon
 * options are square; `labelled` options are an icon and a word, or a word.
 */
function ToggleGroupItem({
  className,
  labelled = false,
  ...props
}: Toggle.Props<string> & { labelled?: boolean }) {
  return (
    <Toggle
      className={cn(
        SEGMENT,
        "data-pressed:bg-surface-selected data-pressed:text-ink",
        labelled
          ? cn("inline-flex", SEGMENT_LABELLED)
          : "grid size-8 place-items-center touch:size-11",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
