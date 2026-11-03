import { applyChanges, type ReworkCard } from "@ephemera/core";
import type { ReviewItem } from "./ReviewField.tsx";
import { TrackedKeys } from "./TrackedKeys.tsx";

/*
 * The card's tags under review, in the tags field's place and, like it,
 * named for assistive technology only: each change as chips. The list
 * after a change is what Apply would write of it, computed by core's one
 * owner of application.
 */
export function TrackedTags({ base, items }: { base: ReworkCard; items: ReviewItem[] }) {
  return (
    <fieldset aria-label="Tags" className="grid min-w-0 gap-1.5">
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
    </fieldset>
  );
}
