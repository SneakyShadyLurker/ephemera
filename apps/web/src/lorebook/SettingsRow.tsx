import { Collapsible } from "@base-ui/react/collapsible";
import { type ReactNode, useId } from "react";
import { ChevronDownIcon } from "@/components/icons";

/**
 * One of the entry editor's four questions: a full-width button named by the
 * question and described by its current answer, and the settings under it.
 * Closed by default and never opened by the screen; a closed panel stays
 * mounted but inert, out of the tab order. The panel grows on the height
 * spring and fades; reduced motion keeps the fade alone.
 */
export function SettingsRow({
  label,
  answer,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  answer: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const labelId = useId();
  const answerId = useId();
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} className="border-rush border-t">
      <Collapsible.Trigger
        aria-labelledby={labelId}
        aria-describedby={answerId}
        className="group/row -mx-2 grid min-h-12 w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-3 text-left outline-none hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--dusk-line)] touch:min-h-14"
      >
        <span className="grid min-w-0 gap-0.5 @xl:grid-cols-[10.5rem_minmax(0,1fr)] @xl:items-baseline @xl:gap-x-4">
          <span id={labelId} className="font-medium text-ink text-ui">
            {label}
          </span>
          <span id={answerId} className="text-pretty text-note text-reed">
            {answer}
          </span>
        </span>
        <ChevronDownIcon
          size={16}
          className="mt-0.5 text-reed transition-[rotate] duration-(--duration-arrive) ease-spring group-data-panel-open/row:rotate-180 motion-reduce:transition-none"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel
        keepMounted
        inert={!open}
        className="-mx-1.5 h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-panel-in) ease-spring data-ending-style:h-0 data-starting-style:h-0 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-[opacity] motion-reduce:duration-(--duration-quick) motion-reduce:ease-fade [&[hidden]]:hidden"
      >
        {/* The inset keeps focus rings inside the clipped panel. */}
        <div className="grid gap-4 px-1.5 pt-1 pb-6">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
