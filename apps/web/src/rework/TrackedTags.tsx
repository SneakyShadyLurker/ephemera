import { applyChanges, type ReworkCard } from "@ephemera/core";
import type { ReviewItem } from "./ReviewField.tsx";
import { TrackedKeys } from "./TrackedKeys.tsx";

/*
 * The card's tags under review, in the tags field's place: the field's
 * label, then each change as chips. The list after a change is what Apply
 * would write of it, computed by core's one owner of application.
 */
export function TrackedTags({ base, items }: { base: ReworkCard; items: ReviewItem[] }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-note text-reed">Tags</span>
      {items.map((item) => (
        <TrackedKeys
          key={item.change.at}
          item={item}
          field="Tags"
          before={base.tags}
          after={applyChanges(base, [item.change]).next.tags ?? base.tags}
          framed
        />
      ))}
    </div>
  );
}
