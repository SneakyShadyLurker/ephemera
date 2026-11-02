import { addTags, CARD_LIMITS } from "@ephemera/core";
import { useId } from "react";
import { useFieldReview, useSettled } from "../rework/ReviewField.tsx";
import { useReworkLocked } from "../rework/session.ts";
import { TrackedTags } from "../rework/TrackedTags.tsx";
import { TokenField } from "../sheet/TokenField.tsx";

/**
 * Tags as removable tokens (sheet/TokenField.tsx). Read-only while an AI
 * Rework works or is under review; a change to the tags under review shows
 * in the field's place.
 */
export function TagsField({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const labelId = useId();
  const locked = useReworkLocked();
  const review = useFieldReview({ kind: "tags" });
  const settled = useSettled("tags");

  if (review.base !== null && review.items.length > 0) {
    return <TrackedTags base={review.base} items={review.items} />;
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <span id={labelId} className="text-note text-reed">
        Tags
      </span>
      <TokenField
        tokens={tags}
        add={addTags}
        item="tag"
        locked={locked}
        settle={settled}
        className="settle-glow"
        input={{
          "aria-labelledby": labelId,
          placeholder: "Add a tag",
          maxLength: CARD_LIMITS.tagLength,
        }}
        onChange={onChange}
      />
    </div>
  );
}
