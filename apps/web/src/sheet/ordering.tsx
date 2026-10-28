import { LazyMotion } from "motion/react";
import { type ReactNode, useRef } from "react";
import { motionFeatures, SPRING } from "@/app/motion.tsx";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { ChevronDownIcon, ChevronUpIcon, MoveDownIcon, MoveUpIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/*
 * Ordered rows that open one at a time (alternate greetings, prompt
 * blocks). Chevrons only open and close; arrows only move. No drag: every
 * move has buttons, which the keyboard and touch reach alike.
 */

/** Moves one item to a new index. */
export function moved<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/**
 * Around a list whose rows glide. A reorder is applied at once, like any
 * edit; the rows then glide to their places with Motion's layout animation.
 * (A reorder inside a React transition that waited on a view transition let
 * an edit made meanwhile be committed and then overwritten by the older state.)
 */
export function Glides({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={motionFeatures()} strict>
      {children}
    </LazyMotion>
  );
}

/**
 * A row's glide: the calm spring without overshoot. Reduced motion is read
 * live (Motion reads it once per element), and the transition is read when
 * each glide starts, so rows stop moving the moment it is switched on.
 */
export function useGlide() {
  const reduce = useReducedMotion();
  return {
    layout: "position" as const,
    transition: { layout: reduce ? { duration: 0 } : SPRING },
  };
}

/** Move earlier and Move later: short arrows, never chevrons. */
export function MoveButtons({
  earlierLabel,
  laterLabel,
  canMoveEarlier,
  canMoveLater,
  onEarlier,
  onLater,
}: {
  earlierLabel: string;
  laterLabel: string;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  onEarlier: () => void;
  onLater: () => void;
}) {
  return (
    <>
      <Button size="icon" aria-label={earlierLabel} disabled={!canMoveEarlier} onClick={onEarlier}>
        <MoveUpIcon size={16} />
      </Button>
      <Button size="icon" aria-label={laterLabel} disabled={!canMoveLater} onClick={onLater}>
        <MoveDownIcon size={16} />
      </Button>
    </>
  );
}

/**
 * The open row's heading: a button with an upward chevron that closes it.
 * `children` is the row's name.
 */
export function CloseRow({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded
      onClick={onClose}
      className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-sm text-left font-medium text-ink text-ui hover:bg-surface-hover touch:min-h-11"
    >
      <span className="truncate">{children}</span>
      <ChevronUpIcon size={16} className="shrink-0 text-reed" />
    </button>
  );
}

/** A closed row: the whole row opens it, its chevron on every width. */
export function OpenRow({
  label,
  onOpen,
  className,
  children,
}: {
  label: string;
  onOpen: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={false}
      aria-label={label}
      onClick={onOpen}
      className={cn(
        "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-sm text-left hover:bg-surface-hover touch:min-h-12",
        className,
      )}
    >
      {children}
      <ChevronDownIcon size={16} className="shrink-0 text-reed" />
    </button>
  );
}

/**
 * Moves a row to a numbered position. Not a form: a sheet is one form
 * already, and forms cannot nest. Enter moves, Escape cancels.
 */
export function MoveToPosition({
  current,
  count,
  onMove,
  onCancel,
}: {
  current: number;
  count: number;
  onMove: (position: number) => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const submit = () => onMove(Number(field.current?.value));
  return (
    <div className="flex flex-1 items-center gap-2">
      <label className="flex items-center gap-2 text-ink text-ui">
        Move to position
        <input
          ref={field}
          type="number"
          min={1}
          max={count}
          defaultValue={current}
          // biome-ignore lint/a11y/noAutofocus: the menu item that opens this control moves focus here
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          className="h-9 w-16 rounded-md border border-control-edge bg-surface px-2 text-ink tabular-nums touch:h-11"
        />
      </label>
      <span className="text-meta text-reed">of {count}</span>
      <Button variant="outline" onClick={submit}>
        Move
      </Button>
      <Button onClick={onCancel}>Cancel</Button>
    </div>
  );
}
