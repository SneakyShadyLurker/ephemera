import type { ComponentProps } from "react";
import { EditIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

/** The open prose face keeps a quiet editing cue even before focus. */
export function ProseField({ className, readOnly, ...props }: ComponentProps<"textarea">) {
  return (
    <span className="relative grid min-w-0 w-full">
      <textarea {...props} readOnly={readOnly} className={cn(className, "pr-8")} />
      {!readOnly && (
        <EditIcon size={16} className="pointer-events-none absolute top-2 right-2 text-reed" />
      )}
    </span>
  );
}
