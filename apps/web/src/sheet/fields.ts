/**
 * Shared field styling for the sheet: grows with its text up to 60% of the
 * view, then scrolls inside. A read-only field (while an AI Rework works or
 * is under review) looks quiet.
 */
export const FIELD =
  "w-full max-h-[60dvh] resize-none rounded-lg border border-control-edge bg-surface px-3.5 py-2.5 text-ink text-turn [field-sizing:content] placeholder:text-reed transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade focus:border-dusk-line focus:shadow-focus focus:outline-none aria-readonly:border-rush aria-readonly:bg-canvas";

export const FOCUS_WITHIN =
  "transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade focus-within:border-dusk-line focus-within:shadow-focus";

/** The sheets' grid: labels hang in a margin beside the fields, like speaker cues. */
export const SHEET_GRID = "tablet:grid tablet:grid-cols-[7rem_minmax(0,40rem)] tablet:gap-x-6";
