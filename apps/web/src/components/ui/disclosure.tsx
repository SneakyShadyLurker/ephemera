import { Collapsible } from "@base-ui/react/collapsible";
import type { ReactNode } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

/*
 * Expansion has one owner: a native `<details className="disclosure">`
 * where a summary can be the control, and otherwise a Base UI Collapsible
 * whose panel carries `unfold` (styles.css), so height and opacity ease
 * the same way everywhere.
 */

/**
 * The chevron of a disclosure's control (styles.css `disclosure-chevron`):
 * it turns as its `<details>`, its Collapsible trigger or its expanded
 * button opens, on the spring, and at once under reduced motion. It points
 * down and turns up; a caller may set `--chevron-closed` and
 * `--chevron-open` for other angles.
 */
export function DisclosureChevron({ className }: { className?: string }) {
  return <ChevronDownIcon size={16} className={cn("disclosure-chevron shrink-0", className)} />;
}

/**
 * Its children while `show`, growing in from no height and folding away
 * again; a fade only under reduced motion. For what a state reveals rather
 * than a trigger beside it; a control that toggles it says so with
 * `aria-expanded` and `aria-controls={id}`. What folds away is inert at
 * once; `keepMounted` keeps the closed content in the document, hidden.
 */
export function Unfold({
  show,
  id,
  className,
  keepMounted = false,
  children,
}: {
  show: boolean;
  id?: string;
  className?: string;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root open={show}>
      <Collapsible.Panel
        id={id}
        keepMounted={keepMounted}
        // Closing, or kept closed, it is out of reach and out of the accessibility tree at once.
        inert={!show}
        aria-hidden={show ? undefined : true}
        className={cn("unfold", className)}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
