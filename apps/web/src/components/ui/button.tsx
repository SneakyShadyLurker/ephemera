import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/** An outlined button keeps its outline while disabled, in the disabled controls' Rush (number fields, switches). */
const DISABLED_OUTLINE = "disabled:border-rush data-disabled:border-rush";

/**
 * 36px on fine pointers, 44px on touch; disabled uses its own tokens, never
 * opacity, and keeps the button's shape: an outlined one stays outlined. A
 * disabled button that keeps focus (`focusableWhenDisabled`) has no
 * `:disabled`, only Base UI's `data-disabled`, so both are styled.
 */
const buttonVariants = cva(
  "press relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium text-ui disabled:cursor-default disabled:bg-transparent disabled:text-text-disabled data-disabled:cursor-default data-disabled:bg-transparent data-disabled:text-text-disabled [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "border-transparent bg-dusk text-on-dusk hover:bg-dusk-hover",
        quiet: "border-transparent text-reed hover:bg-surface-hover hover:text-ink",
        outline: `border-control-edge text-ink hover:bg-surface-hover ${DISABLED_OUTLINE}`,
        danger: `border-ember text-ember hover:bg-error-surface ${DISABLED_OUTLINE}`,
        dangerSolid: "border-transparent bg-ember text-canvas hover:bg-ember/90",
      },
      size: {
        default: "h-9 px-3.5 touch:h-11 touch:px-4",
        icon: "size-9 touch:size-11",
      },
    },
    defaultVariants: { variant: "quiet", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
