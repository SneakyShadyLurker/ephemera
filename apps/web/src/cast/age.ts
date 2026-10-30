import { type CastEntry, effectiveCastAnchor } from "@ephemera/core";

/**
 * The age as a roster gives it, the panel's cue aside and the sheet's list
 * alike: the field's first token when it is a number, else none, so "late
 * twenties" never shows as "late"; the record shows such an age in full.
 */
export function ageOf(entry: Pick<CastEntry, "anchor" | "developments">): string {
  const first = (effectiveCastAnchor(entry).age.trim().split(/\s+/)[0] ?? "").replace(/[,;.]$/, "");
  return /^\d/.test(first) ? first : "";
}
