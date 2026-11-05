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
 *
 * Primary: one commit per view or panel. Outline: entity commands (Chat,
 * AI Rework, New art, Remember now). Quiet: icon and label navigation,
 * panels and collection verbs. Link: inline actions beside the line they
 * affect (Dismiss, Undo, Show details, Change, Brainstorm, Make default).
 * Danger: destructive actions.
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
        /**
         * A text action: its words in ink, as every actionable label, told from
         * the reed explanation around it by a quiet underline that darkens under
         * the pointer.
         */
        link: "border-transparent font-normal text-ink underline decoration-control-edge underline-offset-4 hover:decoration-current disabled:no-underline data-disabled:no-underline",
      },
      size: {
        default: "h-9 px-3.5 touch:h-11 touch:px-4",
        icon: "size-9 touch:size-11",
        /** A compact text action beside a line it acts on (Dismiss, Undo, Show details): 32px, 44px on touch. */
        text: "h-8 px-2 text-note touch:h-11",
        /**
         * A text action set in the line it acts on (Try again, Undo, Show all):
         * as tall as its words, so the line keeps its leading, and a plate
         * grows its target to at least 24px, 44px on touch. The caller may
         * set the line's type size.
         */
        inline:
          "h-auto rounded-sm px-0 text-note after:absolute after:-inset-x-1 after:-inset-y-1 touch:after:-inset-x-2.5 touch:after:-inset-y-3.5",
      },
    },
    /* An outline needs a little more room inside its edge. */
    compoundVariants: [{ variant: "outline", size: "text", class: "px-2.5" }],
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
      className={cn(
        buttonVariants({
          variant: variant ?? (size === "text" || size === "inline" ? "link" : undefined),
          size,
        }),
        className,
      )}
      {...props}
    />
  );
}

export { Button, buttonVariants };
