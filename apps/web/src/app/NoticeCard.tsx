import { type ComponentProps, type ReactNode, useState } from "react";
import { cn } from "@/lib/cn";

const SWAP = "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

/*
 * Notices share one exit contract: a notice arrives on its card's starting
 * style and leaves through `NoticeFold`, which folds its slot away while the
 * last text stays, then lets its owner unmount it. `useNoticeExit` keeps
 * that last text for an owner whose notice simply stops.
 */

/**
 * The shell a notice leaves in: while `leaving`, its height and opacity go
 * to nothing on `--duration-panel-out`, inert and hidden from assistive
 * technology, so what is below rises with
 * it; under reduced motion it only fades and keeps its height until gone.
 * `onLeft` runs once the fade has ended, for the owner to unmount it.
 */
export function NoticeFold({
  leaving,
  onLeft,
  className,
  children,
  ...props
}: {
  leaving: boolean;
  onLeft: () => void;
  className?: string | undefined;
  children: ReactNode;
} & Omit<ComponentProps<"div">, "onTransitionEnd" | "inert">) {
  return (
    <div
      {...props}
      inert={leaving}
      // Leaving, it is out of the accessibility tree at once: a notice replacing it is the one heard.
      aria-hidden={leaving || undefined}
      onTransitionEnd={(event) => {
        // Its own fade, not a transition inside it.
        if (leaving && event.target === event.currentTarget && event.propertyName === "opacity") {
          onLeft();
        }
      }}
      className={cn(
        "transition-[height,opacity] duration-(--duration-panel-out) ease-spring [interpolate-size:allow-keywords] motion-reduce:transition-opacity motion-reduce:ease-fade",
        leaving ? "h-0 overflow-clip opacity-0 motion-reduce:h-auto" : "h-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A notice slot's state for an owner whose notice simply stops: `shown`, the
 * value while there is one and the last one while it leaves; `leaving`; and
 * `end`, NoticeFold's `onLeft`. `key` tells one value from the next.
 */
export function useNoticeExit<T>(value: T | null, key: (value: T) => string) {
  const [kept, setKept] = useState<{ key: string; value: T } | null>(() =>
    value === null ? null : { key: key(value), value },
  );
  if (value !== null && kept?.key !== key(value)) setKept({ key: key(value), value });
  return {
    shown: value ?? kept?.value ?? null,
    leaving: value === null && kept !== null,
    end: () => setKept(null),
  };
}

/**
 * The quiet card of the app's notices (the sign-in notice, a sheet's conflict
 * notice): a title, one or two sentences and outline actions. `docked` sits
 * in a column's own slot; `float` rises over content with the overlay shadow.
 * From tablet up the actions stand beside the text, unless `stacked` (a
 * narrow column such as a dialog's) keeps them under it. `swapKey` changes
 * when the text changes, so it fades in. `bodyId` lets a control be
 * described by the body.
 */
export function NoticeCard({
  title,
  body,
  actions,
  placement,
  stacked = false,
  swapKey,
  role = "status",
  bodyId,
  ...data
}: {
  title: ReactNode;
  body: ReactNode;
  actions?: ReactNode;
  placement: "dock" | "float";
  stacked?: boolean;
  swapKey?: string;
  role?: "status" | "alert";
  bodyId?: string;
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
        <p id={bodyId} className="text-pretty text-note text-reed">
          {body}
        </p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
