import {
  fieldKey,
  fieldText,
  type PlacedChange,
  type ReworkCard,
  type ReworkField,
} from "@ephemera/core";
import type { ReactNode } from "react";
import type { Decision } from "./ChangeRuns.tsx";
import { reviewOrder } from "./order.ts";
import { useRework } from "./session.ts";
import { cardKey } from "./store.ts";
import { type Face, TrackedText } from "./TrackedText.tsx";

/*
 * Where the review meets the sheet: each field host asks which placed
 * changes are its own and, while there are any, shows its tracked view in
 * place of its editor. After Apply, the fields Apply wrote hold the settle
 * glow once.
 */

/** A placed change as the sheet shows it: its decision and its place in the review order. */
export interface ReviewItem {
  change: PlacedChange;
  decision: Decision;
  group: string;
  /** From 1, in the dock's order (order.ts), so labels and Previous and Next agree. */
  number: number;
  total: number;
}

/** The card as sent and every placed change under review, in review order. */
export function useReview(): { base: ReworkCard | null; items: ReviewItem[] } {
  const changes = useRework((state) => state.changes);
  const base = useRework((state) => state.base);
  const order = reviewOrder(changes);
  const placed = new Map(
    changes.flatMap((change) => (change.ok ? [[change.change.at, change] as const] : [])),
  );
  const items = order.flatMap((change, index): ReviewItem[] => {
    const review = placed.get(change.at);
    return review === undefined
      ? []
      : [
          {
            change,
            decision: review.decision,
            group: review.group,
            number: index + 1,
            total: order.length,
          },
        ];
  });
  return { base, items };
}

/** The changes under review that name `field`. */
export function useFieldReview(field: ReworkField): {
  base: ReworkCard | null;
  items: ReviewItem[];
} {
  const { base, items } = useReview();
  const key = fieldKey(field);
  return { base, items: items.filter((item) => fieldKey(item.change.field) === key) };
}

/** Whether Apply just wrote this card field: it settles from the dusk wash once. */
export const useSettled = (key: keyof ReworkCard): boolean =>
  useRework(
    (state) =>
      state.phase === "applied" &&
      state.applied !== null &&
      state.applied.undone === null &&
      key in state.applied.written,
  );

/**
 * A text field's host: its editor (`children`) normally, its tracked view
 * while changes to it are under review, in the field's own face.
 */
export function ReviewField({
  field,
  label,
  face = "turn",
  framed = true,
  children,
}: {
  field: ReworkField;
  /** The field's name in the review's labels: "Description". */
  label: string;
  face?: Face;
  framed?: boolean;
  children: ReactNode;
}) {
  const { base, items } = useFieldReview(field);
  const settled = useSettled(cardKey(field));
  const text = base === null ? undefined : fieldText(base, field);
  return (
    <div data-settle={settled ? "" : undefined} className="settle-glow grid min-w-0">
      {items.length > 0 && text !== undefined ? (
        <TrackedText text={text} items={items} label={label} face={face} framed={framed} />
      ) : (
        children
      )}
    </div>
  );
}
