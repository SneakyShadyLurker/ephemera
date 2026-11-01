import { Collapsible } from "@base-ui/react/collapsible";
import { type ReactNode, useId } from "react";
import { DisclosureChevron } from "@/components/ui/disclosure";
import { cn } from "@/lib/cn";

/** A row's trigger: its tint on hover and its ring on focus, inside the panel's clip. */
const TRIGGER = "-mx-2 rounded-md px-2 text-left row touch:min-h-14";

/**
 * One of the entry editor's four questions: a full-width button named by the
 * question and described by its current answer, and the settings under it.
 * Closed by default and never opened by the screen; a closed panel stays
 * mounted but inert, out of the tab order. The panel grows on the height
 * spring and fades; reduced motion keeps the fade alone. A `compact` row
 * (Events on the library) is as wide as its words, its chevron beside the label.
 */
export function SettingsRow({
  label,
  answer,
  open,
  onOpenChange,
  compact = false,
  children,
}: {
  label: string;
  answer: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
  children: ReactNode;
}) {
  const labelId = useId();
  const answerId = useId();
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} className="border-rush border-t">
      {compact ? (
        <Collapsible.Trigger
          aria-labelledby={labelId}
          aria-describedby={answerId}
          className={cn(TRIGGER, "flex min-h-11 w-fit max-w-full items-center gap-2 py-2.5")}
        >
          <span id={labelId} className="font-medium text-ink text-ui">
            {label}
          </span>
          <DisclosureChevron className="text-reed" />
          <span id={answerId} className="min-w-0 text-pretty text-note text-reed">
            {answer}
          </span>
        </Collapsible.Trigger>
      ) : (
        <Collapsible.Trigger
          aria-labelledby={labelId}
          aria-describedby={answerId}
          className={cn(
            TRIGGER,
            "grid min-h-12 w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-3",
          )}
        >
          <span className="grid min-w-0 gap-0.5 @xl:grid-cols-[10.5rem_minmax(0,1fr)] @xl:items-baseline @xl:gap-x-4">
            <span id={labelId} className="font-medium text-ink text-ui">
              {label}
            </span>
            <span id={answerId} className="text-pretty text-note text-reed">
              {answer}
            </span>
          </span>
          <DisclosureChevron className="mt-0.5 text-reed" />
        </Collapsible.Trigger>
      )}
      <Collapsible.Panel keepMounted inert={!open} className="-mx-1.5 unfold">
        {/* The inset keeps focus rings inside the clipped panel. */}
        <div className="grid gap-4 px-1.5 pt-1 pb-6">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
