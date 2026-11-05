import { Fragment, type ReactNode, useRef } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { COMPACT_LABEL } from "@/sheet/fields.ts";
import type { Run, Segment } from "./tracked.ts";

/*
 * One change as the review shows it in its field: the word diff, the
 * model's reason and the owner's decision. Model output reaches
 * the DOM only as text nodes (PRINCIPLES.md 3): no Markdown, no HTML.
 */

export type Decision = "accepted" | "rejected";

/** A struck run of the original, spoken as a deletion where the element alone is not. */
export function Deleted({ text, className }: { text: string; className?: string | undefined }) {
  return (
    <del className={cn("tracked-del", className)}>
      <span className="sr-only">deleted: </span>
      {text}
    </del>
  );
}

/** An inserted run, spoken as an insertion. */
export function Inserted({ text, className }: { text: string; className?: string | undefined }) {
  return (
    <ins className={cn("tracked-ins", className)}>
      <span className="sr-only">inserted: </span>
      {text}
    </ins>
  );
}

/**
 * A hair of space where struck and inserted words meet. Its own element, as
 * a margin on the insertion would repeat on every line it wraps to.
 */
const Gap = () => <span aria-hidden className="inline-block w-1" />;

/** A word diff as text: kept runs plain, struck and inserted runs marked. */
export function Runs({ runs }: { runs: readonly Run[] }) {
  return runs.map((run, index) => {
    // Runs of one diff never reorder, so their place is their identity.
    const key = `${index}:${run.kind}`;
    if (run.kind === "del") return <Deleted key={key} text={run.text} />;
    if (run.kind === "ins") {
      return runs[index - 1]?.kind === "del" ? (
        <Fragment key={key}>
          <Gap />
          <Inserted text={run.text} />
        </Fragment>
      ) : (
        <Inserted key={key} text={run.text} />
      );
    }
    return <span key={key}>{run.text}</span>;
  });
}

/** Whether a change only adds: rejecting it folds it away rather than swapping emphasis. */
const isPureInsertion = (runs: readonly Run[]): boolean =>
  runs.length > 0 && runs.every((run) => run.kind === "ins");

/**
 * The reason and the decision for a change: under it, or for a change in
 * running text at the end of its sentence (`reasonFor`). A change starts
 * accepted; its one labelled text action, always shown at every viewport,
 * says what pressing it does: Reject while it is in, Restore once it is out.
 * Each moves focus to the action that takes its place before the change's
 * look moves (R5).
 */
export function ChangeDecision({
  label,
  why,
  whyId,
  decision,
  onAccept,
  onReject,
  reasonFor,
}: {
  /** "change 2 of 6", "new entry: The harbour": what the actions name. */
  label: string;
  why: string;
  whyId: string;
  decision: Decision;
  onAccept: () => void;
  onReject: () => void;
  /**
   * The change's arrival order, when the row stands apart from its change:
   * Previous and Next mark it current with its change (`data-reason-for`).
   */
  reasonFor?: number | undefined;
}) {
  const restore = useRef<HTMLButtonElement>(null);
  const reject = useRef<HTMLButtonElement>(null);
  const rejected = decision === "rejected";
  return (
    // Inline-level and full width, so it takes a line of its own within the field's text.
    <span
      data-reason-for={reasonFor}
      className={cn(
        "mt-2 inline-flex w-full items-start gap-3 align-top font-normal font-sans text-note text-reed tracking-normal whitespace-normal",
        reasonFor !== undefined && "change-arrive",
      )}
    >
      <span id={whyId} className="min-w-0 flex-1 pt-1.5 text-pretty">
        {why}
        {rejected && <span className="sr-only"> Rejected.</span>}
      </span>
      {rejected ? (
        <Button
          key="restore"
          ref={restore}
          variant="link"
          size="text"
          className="shrink-0"
          aria-label={`Restore ${label}`}
          onClick={() => {
            flushSync(onAccept);
            reject.current?.focus();
          }}
        >
          Restore
        </Button>
      ) : (
        <Button
          key="reject"
          ref={reject}
          variant="link"
          size="text"
          className="shrink-0"
          aria-label={`Reject ${label}`}
          onClick={() => {
            flushSync(onReject);
            restore.current?.focus();
          }}
        >
          Reject
        </Button>
      )}
    </span>
  );
}

/**
 * One proposal: the original, its replacement, then its reason and decision.
 * Previous and Next focus the whole block; unchanged passages stand outside it.
 */
export function ChangeRuns({
  change,
  at,
  number,
  total,
  field,
  whyId,
  decision,
  children,
}: {
  change: Extract<Segment, { kind: "change" }>;
  /** The change's arrival order: the dock finds it by this. */
  at: number;
  /** Its place in the review order, from 1, and the review's size. */
  number: number;
  total: number;
  /** The field's label: "Description". */
  field: string;
  /** The id of the change's reason, wherever its row stands. */
  whyId: string;
  decision: Decision;
  children?: ReactNode;
}) {
  const pure = isPureInsertion(change.runs);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a change inside running text; a fieldset would break the line.
    <span
      role="group"
      aria-label={`Change ${number} of ${total} in ${field}`}
      aria-describedby={whyId}
      tabIndex={-1}
      data-change-at={at}
      data-decision={decision}
      data-pure={pure ? "" : undefined}
      className={cn(
        "change-mark change-arrive group/change my-4 block border-rush border-b pb-3 pl-3",
      )}
    >
      {change.find !== "" && (
        <span className="block">
          <span className={cn(COMPACT_LABEL, "block font-sans")}>Removed</span>
          <Deleted text={change.find} />
        </span>
      )}
      {change.replace !== "" && (
        <span className="mt-1 block">
          <span className={cn(COMPACT_LABEL, "block font-sans")}>Proposed</span>
          <Inserted text={change.replace} />
        </span>
      )}
      {children}
    </span>
  );
}
