import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { countOf } from "@/lib/text";
import { ChangeDecision, ChangeRuns } from "./ChangeRuns.tsx";
import type { ReviewItem } from "./ReviewField.tsx";
import { reworkStore } from "./session.ts";
import { type Segment, segmentField } from "./tracked.ts";

/*
 * A field's tracked view: its original text with each change in place,
 * growing to its content inside the sheet's one scroller (R2). Long
 * unchanged runs fold behind a native disclosure; once opened, a run stays
 * open for the rest of the review, even as later changes split it.
 */

/** The field's own face: Geist prose, the sheet's title, an entry's title. */
export type Face = "turn" | "title" | "heading";

const FACES: Record<Face, string> = {
  turn: "text-turn",
  title: "font-semibold text-title-phone tracking-[-0.015em] tablet:text-title",
  heading: "font-medium text-ui",
};

/** Unchanged runs longer than this fold away (R2). */
const COLLAPSE_WORDS = 60;

export function TrackedText({
  text,
  items,
  label,
  face = "turn",
  framed = true,
}: {
  /** The field's text as sent: the changes' offsets point into it. */
  text: string;
  /** The changes to this field. */
  items: ReviewItem[];
  label: string;
  face?: Face;
  /** Drawn as the field's box; off inside a lorebook row, which is the box. */
  framed?: boolean;
}) {
  /** Offsets of the original the owner opened, as [start, end). */
  const [opened, setOpened] = useState<readonly (readonly [number, number])[]>([]);
  /** A run opened from its summary: focus follows into the text it revealed. */
  const reveal = useRef<number | null>(null);
  const view = useRef<HTMLDivElement>(null);
  /** The prefix of each change's reason id, which its group names as its description. */
  const ids = useId();

  useEffect(() => {
    if (reveal.current === null) return;
    view.current
      ?.querySelector<HTMLElement>(`[data-revealed="${reveal.current}"]`)
      ?.focus({ preventScroll: true });
    reveal.current = null;
  });

  const segments = segmentField(
    text,
    items.map((item) => item.change),
    { collapseWords: COLLAPSE_WORDS },
  );
  const byAt = new Map(items.map((item) => [item.change.at, item]));
  /** Each segment with its place in the original (the key of an opened run). */
  const placed: { segment: Segment; start: number; end: number }[] = [];
  for (const segment of segments) {
    const start = placed.at(-1)?.end ?? 0;
    const length = segment.kind === "change" ? segment.find.length : segment.text.length;
    placed.push({ segment, start, end: start + length });
  }
  const isOpen = (start: number, end: number) =>
    opened.some(([from, to]) => from <= start && end <= to);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of runs and changes; a fieldset would carry form semantics.
    <div
      ref={view}
      role="group"
      aria-label={`${label}, under review`}
      data-tracked=""
      tabIndex={-1}
      className={cn(
        "min-w-0 whitespace-pre-wrap break-words text-ink outline-none",
        framed && "rounded-lg border border-control-edge bg-surface px-3.5 py-2.5",
        FACES[face],
      )}
    >
      {placed.map(({ segment, start, end }) => {
        if (segment.kind === "same") {
          return <Fragment key={`s${start}`}>{segment.text}</Fragment>;
        }
        if (segment.kind === "collapsed") {
          if (isOpen(start, end)) {
            return (
              <span
                key={`o${start}`}
                data-revealed={start}
                tabIndex={-1}
                className="change-arrive outline-none"
              >
                {segment.text}
              </span>
            );
          }
          return (
            <details
              key={`c${start}`}
              className="my-1.5 font-normal font-sans tracking-normal whitespace-normal"
              onToggle={(event) => {
                const details = event.currentTarget;
                if (!details.open) return;
                if (details.contains(document.activeElement)) reveal.current = start;
                setOpened((ranges) => [...ranges, [start, end]]);
              }}
            >
              <summary className="flex w-full cursor-pointer list-none items-center gap-2 rounded-md bg-surface-selected px-3 py-1.5 text-note text-reed transition-colors duration-(--duration-tint-quick) ease-fade hover:text-ink touch:min-h-11 touch:py-3 [&::-webkit-details-marker]:hidden">
                <ChevronDownIcon size={16} className="shrink-0" />
                Show {countOf(segment.words, "unchanged word")}
              </summary>
              {/* Kept in the document, so find in page reaches it and opens the run. */}
              <span className="whitespace-pre-wrap">{segment.text}</span>
            </details>
          );
        }
        const item = byAt.get(Number(segment.id));
        if (item === undefined) return null;
        return (
          <Fragment key={`a${segment.id}`}>
            <ChangeRuns
              change={segment}
              at={item.change.at}
              number={item.number}
              total={item.total}
              field={label}
              whyId={`${ids}-${item.change.at}`}
              decision={item.decision}
            >
              <ChangeDecision
                label={`change ${item.number} of ${item.total}`}
                why={item.change.why}
                whyId={`${ids}-${item.change.at}`}
                decision={item.decision}
                onAccept={() => reworkStore.getState().accept(item.change.at)}
                onReject={() => reworkStore.getState().reject(item.change.at)}
                reasonFor={item.change.at}
              />
            </ChangeRuns>
          </Fragment>
        );
      })}
    </div>
  );
}
