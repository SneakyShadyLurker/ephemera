import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { MinusIcon, PlusIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

const STEPPER =
  "press grid h-full w-8 shrink-0 place-items-center text-reed hover:bg-surface-hover hover:text-ink data-disabled:text-text-disabled data-disabled:hover:bg-transparent touch:w-11";

/**
 * A number with Minus and Plus beside it; arrow keys step, Shift steps large.
 * On touch the group is 44px inside its border, so each stepper is a full
 * 44px target.
 * The value is formatted by Intl (tabular figures), never typed free-form.
 */
function NumberField({
  className,
  inputClassName,
  label,
  describedBy,
  inputMode,
  placeholder,
  ...props
}: NumberFieldPrimitive.Root.Props & {
  inputClassName?: string;
  /**
   * The keypad on touch. Unset, Base UI picks "decimal" on iOS for a field from 0 and
   * "numeric" elsewhere; a field with decimals asks "decimal" for Android too.
   */
  inputMode?: "numeric" | "decimal";
  label?: string;
  /** The id of text that describes the number, such as a sentence built from it. */
  describedBy?: string;
  /** What an empty field shows, for a number that may be left unset. */
  placeholder?: string;
}) {
  return (
    <NumberFieldPrimitive.Root
      data-slot="number-field"
      className={cn("min-w-0", className)}
      {...props}
    >
      <NumberFieldPrimitive.Group className="flex h-9 overflow-hidden rounded-md border border-control-edge bg-surface transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade focus-within:border-dusk-line focus-within:shadow-focus data-disabled:border-rush touch:h-[calc(--spacing(11)+2px)]">
        <NumberFieldPrimitive.Decrement
          aria-label={label ? `Decrease ${label}` : "Decrease"}
          className={STEPPER}
        >
          <MinusIcon size={16} />
        </NumberFieldPrimitive.Decrement>
        <NumberFieldPrimitive.Input
          aria-label={label}
          aria-describedby={describedBy}
          {...(inputMode === undefined ? {} : { inputMode })}
          {...(placeholder === undefined ? {} : { placeholder })}
          className={cn(
            "min-w-0 flex-1 bg-transparent px-1 text-center text-ink text-ui tabular-nums outline-none placeholder:text-reed data-disabled:text-text-disabled",
            inputClassName,
          )}
        />
        <NumberFieldPrimitive.Increment
          aria-label={label ? `Increase ${label}` : "Increase"}
          className={STEPPER}
        >
          <PlusIcon size={16} />
        </NumberFieldPrimitive.Increment>
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  );
}

export { NumberField };
