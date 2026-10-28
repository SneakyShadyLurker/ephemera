import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn";

function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props<string>) {
  return (
    <ToggleGroupPrimitive
      className={cn("inline-flex gap-0.5 rounded-md border border-rush p-0.5", className)}
      {...props}
    />
  );
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
        "press rounded-sm text-reed hover:bg-surface-hover hover:text-ink data-pressed:bg-surface-selected data-pressed:text-ink",
        labelled
          ? "inline-flex h-8 items-center gap-2 px-3 text-ui touch:h-11"
          : "grid size-8 place-items-center touch:size-10",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
