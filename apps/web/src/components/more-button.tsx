import type { ComponentProps, ReactNode } from "react";
import { MoreIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * A lone icon control on a plate, a small bordered square on the surface, so
 * it reads as a control: the More of a turn, a row or a portrait, or with a
 * `mark` (any icon) the phone's navigation mark. The hit area is the icon
 * button's, 44px on touch; the plate takes the hover and open grounds. Props
 * reach the button, so it serves as a menu trigger's `render`.
 */
export function MoreButton({
  mark,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "size" | "variant"> & {
  /** Drawn on a larger plate in place of the dots. */
  mark?: ReactNode;
}) {
  return (
    <Button {...props} size="icon" className={cn("group/more hover:bg-transparent", className)}>
      <span
        className={cn(
          "grid place-items-center rounded-sm border border-rush bg-surface transition-colors duration-(--duration-quick) ease-fade group-hover/more:bg-surface-hover group-data-popup-open/more:bg-surface-hover",
          mark === undefined ? "h-6 w-7" : "size-8",
        )}
      >
        {mark ?? <MoreIcon size={16} />}
      </span>
    </Button>
  );
}
