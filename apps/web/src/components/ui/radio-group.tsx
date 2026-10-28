import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/cn";

/** One choice of several, named by `aria-labelledby` or a label around its radios. */
function RadioGroup<Value>({ className, ...props }: RadioGroupPrimitive.Props<Value>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid gap-1", className)}
      {...props}
    />
  );
}

/**
 * A real radio: 16px round, Ink when chosen, its dot in the canvas colour,
 * the hit area grown on touch, as the checkbox is.
 */
function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={cn(
        "relative grid size-4 shrink-0 place-items-center rounded-full border border-control-edge bg-surface transition-colors duration-(--duration-quick) ease-fade after:absolute after:-inset-2.5 data-checked:border-ink data-checked:bg-ink data-disabled:border-rush data-disabled:bg-rush touch:size-5",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="size-1.5 rounded-full bg-canvas transition-[opacity,scale] duration-(--duration-quick) ease-spring motion-reduce:transition-opacity data-ending-style:scale-50 data-ending-style:opacity-0 data-starting-style:scale-50 data-starting-style:opacity-0 touch:size-2" />
    </RadioPrimitive.Root>
  );
}

export { Radio, RadioGroup };
