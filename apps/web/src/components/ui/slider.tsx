import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/cn";

/**
 * One value on a track. The filled part is Ink; the thumb is a surface disc
 * with the control edge; it grows while held and takes the focus ring while
 * its input has keyboard focus. A range that spans zero (`centered`) has no
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
            className="relative block size-4 rounded-full border border-control-edge bg-surface shadow-[0_1px_2px_var(--shadow-overlay)] outline-none transition-[box-shadow,scale] duration-(--duration-quick) ease-fade after:absolute after:-inset-3.5 has-[:focus-visible]:focus-ring data-dragging:scale-110 motion-reduce:transition-[box-shadow] touch:size-5"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
