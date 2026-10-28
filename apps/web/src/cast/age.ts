import { type CastEntry, effectiveCastAnchor } from "@ephemera/core";

/** The age as a roster gives it, the panel's cue aside and the sheet's list alike: the field's first token. */
export const ageOf = (entry: Pick<CastEntry, "anchor" | "developments">): string =>
  (effectiveCastAnchor(entry).age.trim().split(/\s+/)[0] ?? "").replace(/[,;.]$/, "");
