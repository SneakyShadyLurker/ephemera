import { Fragment, useRef } from "react";
import { flushSync } from "react-dom";
import { CheckIcon, CloseIcon, UndoIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/disclosure";
import { cn } from "@/lib/cn";
import type { Run, Segment } from "./tracked.ts";

/*
 * One change as the review shows it in its field: the word diff, the
 * model's reason and the owner's decision. Model output reaches
 * the DOM only as text nodes (PRINCIPLES.md 3): no Markdown, no HTML.
 */

export type Decision = "accepted" | "rejected";

const WORD = /\S+/gu;
const countWords = (text: string): number => text.match(WORD)?.length ?? 0;

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

const LETTER = /[\p{L}\p{N}]/u;

/**
 * Whether the word diff keeps any word of the original. A rewrite that
 * keeps only spaces and punctuation reads better as the old passage struck,
 * then the new one, than as words interleaved one by one.
 */
const keepsWords = (runs: readonly Run[]): boolean =>
  runs.some((run) => run.kind === "same" && LETTER.test(run.text));

/** Whether a change only adds: rejecting it folds it away rather than swapping emphasis. */
const isPureInsertion = (runs: readonly Run[]): boolean =>
  runs.length > 0 && runs.every((run) => run.kind === "ins");

/**
 * The reason and the decision for a change: under it, or for a change in
 * running text at the end of its sentence (`reasonFor`). Accepted: Accept
 * (pressed) and Reject, shown on hover or focus with a fine pointer, while
 * the change is current, and always on touch. Rejected: Restore, always
 * shown. Each moves focus to the button that takes its place before the
 * change's look moves (R5).
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
  /** "change 2 of 6", "new entry: The harbour": what the buttons name. */
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
        "group/decision my-1 inline-flex w-full items-start gap-3 align-top font-normal font-sans text-note text-reed tracking-normal whitespace-normal",
        reasonFor !== undefined && "change-arrive",
      )}
    >
      <span id={whyId} className="min-w-0 flex-1 text-pretty pt-2 touch:pt-3">
        {why}
        {rejected && <span className="sr-only"> Rejected.</span>}
      </span>
      {rejected ? (
        <Button
          ref={restore}
          className="h-9 px-2.5 text-ink touch:h-11"
          aria-label={`Restore ${label}`}
          onClick={() => {
            flushSync(onAccept);
            reject.current?.focus();
          }}
        >
          <UndoIcon size={16} />
          Restore
        </Button>
      ) : (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-(--duration-quick) ease-fade group-hover/change:opacity-100 group-hover/decision:opacity-100 group-focus-within/change:opacity-100 group-focus-within/decision:opacity-100 group-data-current/change:opacity-100 group-data-current/decision:opacity-100 touch:opacity-100">
          <Button
            size="icon"
            aria-label={`Accept ${label}`}
            aria-pressed
            className="text-dusk-line"
            onClick={onAccept}
          >
            <CheckIcon size={16} />
          </Button>
          <Button
            ref={reject}
            size="icon"
            aria-label={`Reject ${label}`}
            onClick={() => {
              flushSync(onReject);
              restore.current?.focus();
            }}
          >
            <CloseIcon size={16} />
          </Button>
        </span>
      )}
    </span>
  );
}

/**
 * One change inside a tracked view, in the flow of its field's text:
 * interleaved runs, or for a large rewrite that keeps little (R3) one
 * inserted passage with the original behind "Show original". The group is
 * what Previous and Next focus (`data-change-at`, R5); its reason and
 * decision stand at the end of its sentence (TrackedText), and `whyId`
 * names the reason that describes it.
 */
export function ChangeRuns({
  change,
  at,
  number,
  total,
  field,
  whyId,
  decision,
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
        "change-mark change-arrive group/change -ms-1 ps-1",
        // A passage and its disclosure stand as a block of their own.
        change.mode === "passage" && "block",
      )}
    >
      {change.mode === "passage" ? (
        <>
          <Inserted text={change.replace} />
          <details className="disclosure mt-1.5 font-sans whitespace-normal">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-note text-reed hover:text-ink focus-visible:outline-2 focus-visible:outline-dusk-line focus-visible:outline-offset-2 touch:min-h-11 [&::-webkit-details-marker]:hidden">
              Show original ({countWords(change.find)} words)
              <DisclosureChevron />
            </summary>
            <span className="mt-1.5 block whitespace-pre-wrap text-pretty">
              <Deleted text={change.find} />
            </span>
          </details>
        </>
      ) : keepsWords(change.runs) || change.find === "" || change.replace === "" ? (
        <Runs runs={change.runs} />
      ) : (
        <>
          <Deleted text={change.find} />
          <Gap />
          <Inserted text={change.replace} />
        </>
      )}
    </span>
  );
}
