import { fieldLabel, type ReworkCard, type Unplaced } from "@ephemera/core";
import { AnimatePresence, useIsPresent } from "motion/react";
import * as m from "motion/react-m";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { fade, MotionScope, spring } from "@/app/motion.tsx";
import { motionPx } from "@/app/motion-tokens.ts";
import { scrollBehavior, useReducedMotion } from "@/app/reduced-motion.ts";
import { LampFlameIcon, NextIcon, PreviousIcon, StopIcon, UndoIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DisclosureChevron, SUMMARY_LINE } from "@/components/ui/disclosure";
import { cn } from "@/lib/cn";
import { useModelChoice } from "../creator/Describe.tsx";
import type { SaveStatus } from "../sheet/autosave.ts";
import { useFirstChangeScroll } from "./arrival.ts";
import { isRefusal } from "./Composer.tsx";
import { changes, lineOf } from "./line.ts";
import { reviewOrder } from "./order.ts";
import { reworkStore, useRework } from "./session.ts";
import {
  type Applied,
  acceptedChanges,
  leftByUndo,
  type ReviewChange,
  type ReworkState,
} from "./store.ts";

/*
 * The rework's dock: one bar pinned under the sheet's scroller, its content
 * in a 40rem column. It carries the run (Stop), the review (Previous, Next,
 * Discard, Apply), its endings (stopped, failed, nothing to change) and the
 * applied state with Undo until Done. It rises on the spring when a run
 * starts and leaves on Done. One status node announces each transition;
 * failures go through an alert node instead.
 */

/** What a change that could not be placed says about why. */
const UNPLACED: Record<Unplaced, string> = {
  no_such_field: "The card has no such field.",
  missing: "The passage it names is not in the field.",
  ambiguous: "The passage it names occurs more than once.",
  overlap: "It overlaps an earlier change.",
  empty: "It would empty a field that must keep its text.",
  too_long: "The field would pass its length limit.",
};

/** The changes that could not be placed, as a disclosure: field, reason and the proposed text. */
function Unplaceable({ changes: all, base }: { changes: ReviewChange[]; base: ReworkCard | null }) {
  const unplaced = all.flatMap((change) => (change.ok ? [] : [change]));
  if (unplaced.length === 0) return null;
  return (
    <details className="disclosure">
      <summary className={cn(SUMMARY_LINE, "touch:-my-1")}>
        {unplaced.length} could not be placed
        <DisclosureChevron />
      </summary>
      <ul className="mt-2 grid max-h-[30dvh] gap-3 overflow-y-auto border-rush border-l pl-3">
        {unplaced.map((change) => (
          <li key={change.at} className="grid gap-0.5 text-note">
            <span className="font-medium text-ink">
              {change.field === null || base === null
                ? "Unknown field"
                : fieldLabel(change.field, base)}
            </span>
            <span className="text-reed">{UNPLACED[change.reason]}</span>
            {change.replace !== "" && (
              <span className="line-clamp-3 whitespace-pre-wrap break-words text-ink">
                {change.replace}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Buttons on phones reach 44px; the bar's two rows keep them apart. */
const TARGET = "max-tablet:h-11 max-tablet:px-4";
const ICON_TARGET = "max-tablet:size-11";

type DockProps = {
  /** The sheet's fields as they stand: whether Undo leaves fields typed in since Apply. */
  card: ReworkCard;
  /** The sheet's save status, as its header shows it: what the line says after Apply or Undo. */
  save: SaveStatus;
  /** Writes the store's `apply()` result through the sheet's `edit()`. */
  onApply: () => void;
  /** Writes the store's `undo(current)` result through the sheet's `edit()`. */
  onUndo: () => void;
  /** Opens the composer with the request (Try again, Edit request). */
  onCompose: () => void;
  /** The AI Rework button: where Undo and Done leave focus. */
  returnFocus: RefObject<HTMLButtonElement | null>;
};

export function Dock(props: DockProps) {
  const live = useRework((state) => state);
  useFirstChangeScroll();
  const hidden = live.phase === "idle" || (live.phase === "review" && isRefusal(live.failure));
  const { model } = useModelChoice(live.model);
  return (
    // A clear replaces the whole boundary, immediately dropping every retained draft.
    <MotionScope key={live.characterId ?? "unbound"}>
      <AnimatePresence>
        {!hidden && <DockPresenter key="dock" {...props} live={live} model={model} />}
      </AnimatePresence>
    </MotionScope>
  );
}

/** All outgoing text and field comparisons belong to the last complete visible snapshot. */
function DockPresenter({
  card,
  save,
  onApply,
  onUndo,
  onCompose,
  returnFocus,
  live,
  model,
}: DockProps & { live: ReworkState; model: ReturnType<typeof useModelChoice>["model"] }) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const view = live;

  // Previous and Next: an index into the review order, reset for every run.
  const [nav, setNav] = useState<{ epoch: number; index: number | null }>({
    epoch: live.epoch,
    index: null,
  });
  if (nav.epoch !== live.epoch) setNav({ epoch: live.epoch, index: null });

  // Once the sheet saved what Apply or Undo wrote, the line says so until the next one,
  // whatever later edits do. Read at render, so no status the sheet passes through is missed.
  const [savedFor, setSavedFor] = useState<Applied | null>(null);
  if (live.applied !== null && save.kind === "saved" && savedFor !== live.applied) {
    setSavedFor(live.applied);
  }
  const saved = live.applied !== null && savedFor === live.applied;

  const status = useRef<HTMLParagraphElement>(null);
  const undo = useRef<HTMLButtonElement>(null);
  const applying = useRef(false);
  const focusedEpoch = useRef(-1);
  const lineId = useId();

  // Submitting focuses the dock's line once; completion never moves focus.
  useEffect(() => {
    if (!present || live.phase !== "working" || focusedEpoch.current === live.epoch) return;
    focusedEpoch.current = live.epoch;
    status.current?.focus({ preventScroll: true });
  }, [live.phase, live.epoch, present]);

  // Apply leaves focus on Undo.
  useEffect(() => {
    if (!present || live.phase !== "applied" || !applying.current) return;
    applying.current = false;
    undo.current?.focus();
  }, [live.phase, present]);

  // After Undo has saved, its result stays a moment, then the bar leaves.
  const undoneSaved = live.applied?.undone != null && (saved || save.kind === "saved");
  useEffect(() => {
    if (!present || !undoneSaved) return;
    const timer = setTimeout(() => reworkStore.getState().finish(), 4000);
    return () => clearTimeout(timer);
  }, [undoneSaved, present]);

  const order = reviewOrder(view.changes);
  const index = nav.index !== null && nav.index < order.length ? nav.index : null;
  const currentChange = index === null ? undefined : order[index];
  const current =
    currentChange === undefined || view.base === null
      ? null
      : `Change ${(index ?? 0) + 1} of ${order.length}, ${fieldLabel(currentChange.field, view.base)}`;
  const line = lineOf(view, model, current, saved ? null : save);
  const accepted = acceptedChanges(view).length;
  const rejected = view.changes.filter(
    (change) => change.ok && change.decision === "rejected",
  ).length;
  const applyLine = `${accepted === 0 ? "Nothing to apply" : `${changes(accepted)} to apply`}${rejected > 0 ? `, ${rejected} rejected` : ""}`;
  const edited = view.phase === "applied" ? leftByUndo(view, card) : [];
  const writtenFields = Object.keys(view.applied?.written ?? {}).length;

  const goTo = (next: number) => {
    const change = order[next];
    if (change === undefined) return;
    setNav({ epoch: live.epoch, index: next });
    // A change in running text has its reason row apart, at its sentence's end: it is current too.
    for (const marked of document.querySelectorAll(
      "[data-change-at][data-current], [data-reason-for][data-current]",
    )) {
      marked.removeAttribute("data-current");
    }
    document.querySelector(`[data-reason-for="${change.at}"]`)?.setAttribute("data-current", "");
    const target = document.querySelector<HTMLElement>(`[data-change-at="${change.at}"]`);
    if (target === null) return;
    target.setAttribute("data-current", "");
    target.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    target.focus({ preventScroll: true });
  };
  const back = () => returnFocus.current?.focus();
  const compose = () => {
    reworkStore.getState().discard();
    onCompose();
  };

  const navigation = order.length > 0 && view.phase === "review" && (
    <div className="flex shrink-0 items-center">
      <Button
        size="icon"
        aria-label="Previous change"
        className={ICON_TARGET}
        disabled={index === 0}
        onClick={() => goTo(index === null ? order.length - 1 : index - 1)}
      >
        <PreviousIcon />
      </Button>
      <span aria-hidden="true" className="min-w-9 text-center text-meta text-reed tabular-nums">
        {index !== null && `${index + 1} / ${order.length}`}
      </span>
      <Button
        size="icon"
        aria-label="Next change"
        className={ICON_TARGET}
        disabled={index === order.length - 1}
        onClick={() => goTo(index === null ? 0 : index + 1)}
      >
        <NextIcon />
      </Button>
    </div>
  );

  let actions: ReactNode = null;
  let meta: ReactNode = null;
  let below: ReactNode = null;
  switch (view.phase) {
    case "working":
      meta = view.changes.length > 0 && `${changes(view.changes.length)} so far`;
      actions = (
        <Button variant="outline" className={TARGET} onClick={() => reworkStore.getState().stop()}>
          <StopIcon size={16} />
          Stop
        </Button>
      );
      break;
    case "waiting":
      actions = (
        <Button className={TARGET} onClick={() => reworkStore.getState().discard()}>
          Discard
        </Button>
      );
      break;
    case "applied":
      actions = (
        <>
          {view.applied?.undone === null && edited.length < writtenFields && (
            <Button
              ref={undo}
              variant="outline"
              className={TARGET}
              onClick={() => {
                onUndo();
                back();
              }}
            >
              <UndoIcon size={16} />
              {edited.length > 0 ? "Undo untouched fields" : "Undo"}
            </Button>
          )}
          <Button
            variant="outline"
            className={TARGET}
            onClick={() => {
              reworkStore.getState().finish();
              back();
            }}
          >
            Done
          </Button>
        </>
      );
      break;
    case "review": {
      const nothing = view.ended === "complete" && view.changes.length === 0;
      below = (
        <>
          {nothing && view.summary !== null && (
            <p className="text-pretty text-note text-reed">{view.summary}</p>
          )}
          <Unplaceable changes={view.changes} base={view.base} />
          <div className="flex items-center justify-between gap-3">
            {nothing ? (
              <>
                <Button className={cn("-ml-3", TARGET)} onClick={compose}>
                  Edit request
                </Button>
                <Button
                  variant="outline"
                  className={TARGET}
                  onClick={() => {
                    reworkStore.getState().finish();
                    back();
                  }}
                >
                  Done
                </Button>
              </>
            ) : (
              <>
                <div className="-ml-3 flex items-center gap-1">
                  <Button className={TARGET} onClick={() => reworkStore.getState().discard()}>
                    Discard
                  </Button>
                  {view.ended !== "complete" && view.failure !== "invalid_request" && (
                    <Button className={TARGET} onClick={compose}>
                      Try again
                    </Button>
                  )}
                </div>
                {order.length > 0 && (
                  <Button
                    variant="primary"
                    className={TARGET}
                    disabled={accepted === 0}
                    onClick={() => {
                      applying.current = true;
                      onApply();
                    }}
                  >
                    {accepted === 0 ? "Apply" : `Apply ${changes(accepted)}`}
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      );
      break;
    }
    default:
      break;
  }

  return (
    <m.div
      role="region"
      aria-label="AI Rework"
      inert={!present}
      aria-hidden={!present || undefined}
      data-leaving={present ? undefined : ""}
      initial={{
        height: reduced ? "auto" : 0,
        opacity: 0,
        y: reduced ? 0 : motionPx("--panel-shift"),
      }}
      animate={{ height: "auto", opacity: 1, y: 0 }}
      exit={{
        height: reduced ? "auto" : 0,
        opacity: 0,
        y: reduced ? 0 : motionPx("--panel-shift"),
      }}
      transition={{
        height: spring(present ? "--duration-panel-in" : "--duration-panel-out"),
        y: spring(present ? "--duration-panel-in" : "--duration-panel-out"),
        opacity: fade(present ? "--duration-panel-in" : "--duration-panel-out"),
      }}
      className="shrink-0 overflow-clip"
    >
      <div className="w-full border-rush border-t bg-canvas pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid w-full max-w-measure gap-2 py-3 pr-[max(1.25rem,env(safe-area-inset-right))] pl-[max(1.25rem,env(safe-area-inset-left))]">
          <div className="flex min-h-9 items-center gap-3 max-tablet:min-h-11">
            {view.phase === "working" && <LampFlameIcon size={16} className="shrink-0 text-reed" />}
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <p
                ref={status}
                id={lineId}
                tabIndex={-1}
                className={cn(
                  "min-w-0 text-pretty font-medium text-ui outline-none",
                  line.failure ? "text-ember" : "text-ink",
                )}
              >
                {view.phase === "review" &&
                view.ended === "complete" &&
                !line.failure &&
                view.changes.length > 0
                  ? applyLine
                  : line.text}
                {view.phase === "review" &&
                  (view.ended !== "complete" || line.failure) &&
                  order.length > 0 && (
                    <span className="mt-0.5 block font-normal text-meta text-reed">
                      {applyLine}
                    </span>
                  )}
              </p>
              {meta && <span className="text-meta text-reed tabular-nums">{meta}</span>}
            </div>
            {navigation}
            {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
          </div>
          {below}
          <p role="status" className="sr-only">
            {!present || line.failure
              ? ""
              : view.phase === "review" && order.length > 0
                ? current === null
                  ? applyLine
                  : `${applyLine}. ${current}`
                : line.announce}
          </p>
          <p role="alert" className="sr-only">
            {present && line.failure ? line.announce : ""}
          </p>
        </div>
      </div>
    </m.div>
  );
}
