import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const SWAP = "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

/**
 * The quiet card of the app's notices (the sign-in notice, a sheet's conflict
 * notice): a title, one or two sentences and outline actions. `docked` sits
 * in a column's own slot; `float` rises over content with the overlay shadow.
 * From tablet up the actions stand beside the text, unless `stacked` (a
 * narrow column such as a dialog's) keeps them under it. `swapKey` changes
 * when the text changes, so it fades in.
 */
export function NoticeCard({
  title,
  body,
  actions,
  placement,
  stacked = false,
  swapKey,
  role = "status",
  ...data
}: {
  title: ReactNode;
  body: ReactNode;
  actions?: ReactNode;
  placement: "dock" | "float";
  stacked?: boolean;
  swapKey?: string;
  role?: "status" | "alert";
} & Record<`data-${string}`, string>) {
  return (
    <div
      role={role}
      {...data}
      className={cn(
        "grid gap-2 overflow-clip rounded-lg border border-rush bg-surface px-4 py-3 [interpolate-size:allow-keywords]",
        !stacked && "tablet:grid-cols-[minmax(0,1fr)_auto] tablet:items-center tablet:gap-x-4",
        placement === "float" && "shadow-overlay",
        "arrive",
      )}
    >
      <div key={swapKey} className={cn("grid gap-0.5", SWAP)}>
        <p className="flex items-center gap-2 font-medium text-ink text-ui">{title}</p>
        <p className="text-pretty text-note text-reed">{body}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
