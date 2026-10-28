import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

/** A real checkbox: 16px square, Ink when checked, the hit area grown on touch. */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "relative grid size-4 shrink-0 place-items-center rounded-[4px] border border-control-edge bg-surface text-canvas transition-colors duration-(--duration-quick) ease-fade after:absolute after:-inset-2.5 data-checked:border-ink data-checked:bg-ink data-disabled:border-rush data-disabled:bg-rush touch:size-5",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="transition-[opacity,scale] duration-(--duration-quick) ease-spring motion-reduce:transition-opacity data-ending-style:scale-75 data-ending-style:opacity-0 data-starting-style:scale-75 data-starting-style:opacity-0">
        <CheckIcon size={16} className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
