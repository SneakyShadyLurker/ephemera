import { useId } from "react";
import { cn } from "@/lib/cn";
import { ChangeDecision } from "./ChangeRuns.tsx";
import type { ReviewItem } from "./ReviewField.tsx";
import { reworkStore } from "./session.ts";

/*
 * A list of short items under review, the card's tags or an entry's
 * keywords, as chips: kept ones on the selected surface, added ones on the
 * dusk wash, removed ones struck in ember. Text nodes only.
 */

const CHIP = "inline-flex h-7 items-center rounded-md px-2.5 text-note touch:h-9";

/** Chips for a list before and after a change: the old order, with additions at the end. */
export function TrackedChips({
  before,
  after,
}: {
  before: readonly string[];
  after: readonly string[];
}) {
  const had = new Set(before);
  const kept = new Set(after);
  const added = after.filter((item) => !had.has(item));
  if (before.length === 0 && added.length === 0) {
    return <span className="text-note text-reed">None</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {before.map((item) =>
        kept.has(item) ? (
          <span key={`k${item}`} className={cn(CHIP, "bg-surface-selected text-ink")}>
            {item}
          </span>
        ) : (
          <del key={`d${item}`} className={cn(CHIP, "tracked-chip-del")}>
            <span className="sr-only">removed: </span>
            {item}
          </del>
        ),
      )}
      {added.map((item) => (
        <ins key={`i${item}`} className={cn(CHIP, "tracked-chip-ins")}>
          <span className="sr-only">added: </span>
          {item}
        </ins>
      ))}
    </span>
  );
}

/**
 * One change to a list, as its own group with the reason and the decision
 * under the chips: the card's tags, or an entry's keywords.
 */
export function TrackedKeys({
  item,
  field,
  before,
  after,
  framed = false,
}: {
  item: ReviewItem;
  /** The list's label in the review's labels: "Tags", "Entry 1: The harbour, keywords". */
  field: string;
  before: readonly string[];
  after: readonly string[];
  /** Drawn as the tags field's box; bare inside a lorebook row. */
  framed?: boolean;
}) {
  const whyId = useId();
  const at = item.change.at;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a change's group; a fieldset would carry form semantics.
    <div
      role="group"
      aria-label={`Change ${item.number} of ${item.total} in ${field}`}
      aria-describedby={whyId}
      tabIndex={-1}
      data-change-at={at}
      data-decision={item.decision}
      className={cn(
        "change-mark change-arrive group/change grid min-w-0",
        framed ? "rounded-lg border border-control-edge bg-surface px-2.5 pt-2" : "-ms-1 ps-1",
      )}
    >
      <TrackedChips before={before} after={after} />
      <ChangeDecision
        label={`change ${item.number} of ${item.total}`}
        why={item.change.why}
        whyId={whyId}
        decision={item.decision}
        onAccept={() => reworkStore.getState().accept(at)}
        onReject={() => reworkStore.getState().reject(at)}
      />
    </div>
  );
}
