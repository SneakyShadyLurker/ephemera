import type { ComponentProps } from "react";
import { SearchIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { FOCUS_WITHIN } from "@/sheet/fields.ts";

/**
 * A find field: the search icon and the input in one bordered box, which
 * shows the focus. `label` names it for assistive technology; the
 * placeholder says what it matches. `className` places the box.
 */
export function SearchField({
  label,
  className,
  ...props
}: { label: string; className?: string } & Omit<
  ComponentProps<"input">,
  "type" | "className" | "aria-label"
>) {
  return (
    <label
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-lg border border-control-edge bg-surface px-2.5 touch:h-11",
        FOCUS_WITHIN,
        className,
      )}
    >
      <SearchIcon size={16} className="shrink-0 text-reed" />
      <input
        type="search"
        aria-label={label}
        autoComplete="off"
        {...props}
        className="min-w-0 flex-1 bg-transparent text-ink text-ui outline-none placeholder:text-reed"
      />
    </label>
  );
}
