import { cn } from "@/lib/cn";

/** Layout sits above `row`, which owns interaction and inset keyboard focus. */
const LAYOUT = {
  collection: "min-h-16 gap-x-4 gap-y-1 px-1 py-2.5 touch:min-h-16",
  entry: "min-h-14 gap-x-3 gap-y-1 px-3 py-3 touch:min-h-16",
  diagnostic: "min-h-12 gap-x-3 gap-y-1 px-1 py-2 touch:min-h-14",
} as const;

export const rowLayout = (kind: keyof typeof LAYOUT, interactive = true) =>
  cn("grid min-w-0 items-center rounded-sm text-left", interactive && "row", LAYOUT[kind]);

/** A row with a separate action hit area; never nest its actions in its link. */
export const ROW_FRAME = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1";
export const ROW_CONTENT = "grid min-w-0 gap-1";
export const ROW_META = "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-note text-reed";
export const ROW_ACTIONS = "flex shrink-0 items-center justify-end gap-1";
