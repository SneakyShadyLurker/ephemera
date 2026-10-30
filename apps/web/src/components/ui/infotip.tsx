import type { ReactNode } from "react";
import { InfoIcon } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";

/**
 * More about one setting, behind a small info icon: opens on hover (after a
 * short delay, closing a beat late so the pointer can cross into it), on
 * Enter or Space and on tap; Escape closes it and focus returns to the icon.
 * The popup is named by `label`, visually hidden, and holds `children` alone.
 * The trigger is named "About {label}" and never sits inside a `<label>`.
 */
export function Infotip({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={300}
        closeDelay={100}
        aria-label={`About ${label}`}
        className={cn(
          // 24px hit area (44 on touch) around a 14px icon, pulled in so the line keeps its rhythm.
          "press relative -my-0.5 ml-1 inline-grid size-6 align-middle shrink-0 place-items-center rounded-full text-reed hover:text-ink focus-visible:text-ink data-popup-open:text-ink touch:after:absolute touch:after:-inset-2.5",
          className,
        )}
      >
        <InfoIcon size={16} className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent title={label} className="p-3">
        <div className="grid gap-2 text-pretty text-note text-reed">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
