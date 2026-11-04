import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/cn";

/**
 * One value on a track. The filled part is Ink; the thumb is a surface disc
 * with the control edge, drawn inside a box as large as its target; it
 * grows while held and takes the focus ring while its input has keyboard
 * focus. A range that spans zero (`centered`) has no
 * fill, which would start at the minimum, and marks zero with a tick instead.
 * Name it with `thumbLabel`: the thumb holds the range input.
 */
function Slider({
  className,
  centered = false,
  thumbLabel,
  ...props
}: SliderPrimitive.Root.Props<number> & { centered?: boolean; thumbLabel: string }) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      thumbAlignment="edge"
      className={cn("w-full", className)}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-9 w-full touch-none select-none items-center touch:h-11">
        <SliderPrimitive.Track
          className={cn(
            "relative h-1 w-full rounded-full bg-[color-mix(in_oklab,var(--control-edge)_55%,transparent)]",
            centered &&
              "before:absolute before:top-1/2 before:left-1/2 before:h-3 before:w-px before:-translate-1/2 before:bg-control-edge",
          )}
        >
          {!centered && <SliderPrimitive.Indicator className="rounded-full bg-ink" />}
          <SliderPrimitive.Thumb
            aria-label={thumbLabel}
            className={cn(
              // The thumb's box is its target, 24px, 44px on touch, holding the range input; the disc is drawn inside it.
              "relative block size-6 rounded-full outline-none after:absolute after:-inset-2.5 touch:size-11 touch:after:inset-0",
              "before:absolute before:inset-1 before:rounded-full before:border before:border-control-edge before:bg-surface before:shadow-[0_1px_2px_var(--shadow-overlay)] before:transition-[scale] before:duration-(--duration-quick) before:ease-spring has-[:focus-visible]:before:focus-ring data-dragging:before:scale-(--grip-scale) touch:before:inset-3",
            )}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
