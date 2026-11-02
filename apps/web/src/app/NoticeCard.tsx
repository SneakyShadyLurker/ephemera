import { AnimatePresence, domAnimation, useIsPresent } from "motion/react";
import * as m from "motion/react-m";
import type { FocusEventHandler, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { fade, MotionScope, spring } from "./motion.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const SWAP = "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

type NoticeFrameProps = {
  ref?: Ref<HTMLDivElement>;
  onFocusCapture?: FocusEventHandler<HTMLDivElement>;
  className?: string | undefined;
};

/** One stable slot: content changes in place; removal retains its last rendered contents. */
export function NoticeSlot<T>({
  value,
  children,
  ...props
}: NoticeFrameProps & { value: T | null; children: (value: T) => ReactNode }) {
  return (
    <MotionScope features={domAnimation}>
      <AnimatePresence>
        {value !== null && (
          <NoticePresenter key="notice" {...props}>
            {children(value)}
          </NoticePresenter>
        )}
      </AnimatePresence>
    </MotionScope>
  );
}

/** The retained notice becomes unavailable immediately, then folds or fades out. */
function NoticePresenter({
  className,
  children,
  ...props
}: NoticeFrameProps & { children: ReactNode }) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return (
    <m.div
      {...props}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={{ height: reduced ? "auto" : 0, opacity: 0, overflow: "clip" }}
      animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
      exit={{ height: reduced ? "auto" : 0, opacity: 0, overflow: "clip" }}
      transition={{
        height: spring(present ? "--duration-panel-in" : "--duration-panel-out"),
        opacity: fade(present ? "--duration-panel-in" : "--duration-panel-out"),
      }}
      className={cn(!present && "overflow-clip", className)}
    >
      {children}
    </m.div>
  );
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
