import { useState } from "react";

interface Draft {
  /** What the field shows. */
  shown: number | null;
  /** The saved value when the draft began. */
  over: number | null;
  /** The values saved from here that the settings have not shown yet, oldest first. */
  sent: readonly (number | null)[];
}

/**
 * A settings number field's value while it is typed or stepped, for a Base UI
 * NumberField. A saved change reaches the settings cache, and so `value`, a
 * tick after the commit; the draft holds until it arrives, so the field keeps
 * one owner (and its focus) through a committed step and a quick second step
 * counts from the first. A value saved elsewhere shows. With `clear`, an
 * empty field is a value too (`value` null): emptied, it calls `clear`;
 * without it, an emptied field shows the saved value again.
 */
export function useNumberDraft(
  value: number | null,
  save: (next: number) => void,
  clear?: () => void,
) {
  const [draft, setDraft] = useState<Draft | null>(null);
  if (
    draft !== null &&
    (value === draft.shown || (value !== draft.over && !draft.sent.includes(value)))
  ) {
    setDraft(null);
  }
  return {
    value: draft === null ? value : draft.shown,
    onValueChange: (shown: number | null) =>
      setDraft((current) => ({
        shown,
        over: current?.over ?? value,
        sent: current?.sent ?? [],
      })),
    onValueCommitted: (next: number | null) => {
      // What the settings will hold once the values sent from here arrive.
      const intended = draft?.sent.at(-1) ?? value;
      if ((next === null && clear === undefined) || next === intended) {
        setDraft(draft === null || draft.sent.length === 0 ? null : { ...draft, shown: intended });
        return;
      }
      if (next === null) clear?.();
      else save(next);
      setDraft((current) => ({
        shown: next,
        over: current?.over ?? value,
        sent: [...(current?.sent ?? []), next],
      }));
    },
  };
}
