import type { PlacedChange, ReworkField, TextKey } from "@ephemera/core";
import type { ReviewChange } from "./store.ts";

/*
 * The review's one order: the sheet's, top to bottom, then by place within a
 * field. Previous and Next walk it, and each change's label counts in it
 * ("Change 2 of 6 in Description"), so the two always agree.
 */

/** Where a text field sits on the sheet, among every field a change can name. */
const TEXT_RANK: Record<TextKey, number> = {
  name: 0,
  description: 2,
  personality: 3,
  scenario: 4,
  firstMessage: 7,
  exampleDialogue: 10,
  systemPrompt: 11,
  postHistoryInstructions: 12,
  characterNote: 13,
  creatorNotes: 14,
};

/** An entry's parts as its row shows them: title, keywords, content. */
const PART_RANK = { name: 0, keys: 1, content: 2 } as const;

/** A field's place on the sheet as a tuple compared in order. */
function fieldRank(field: ReworkField, at: number): number[] {
  switch (field.kind) {
    case "text":
      return [TEXT_RANK[field.key]];
    case "tags":
      return [1];
    case "entry":
      return [5, field.index, PART_RANK[field.part]];
    case "entry_new":
      return [6, field.number, PART_RANK[field.part]];
    case "alternate":
      return [8, field.index];
    case "alternate_new":
      return [9, at];
  }
}

function compare(a: PlacedChange, b: PlacedChange): number {
  const ra = [...fieldRank(a.field, a.at), a.start, a.at];
  const rb = [...fieldRank(b.field, b.at), b.start, b.at];
  for (let i = 0; i < Math.max(ra.length, rb.length); i += 1) {
    const d = (ra[i] ?? -1) - (rb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The placed changes in sheet order; changes that could not be placed are not reviewed in place. */
export function reviewOrder(changes: readonly ReviewChange[]): PlacedChange[] {
  return changes.flatMap((change) => (change.ok ? [change.change] : [])).sort(compare);
}
