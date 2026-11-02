/** The next prompt's size against the model's window, as the context meter shows it. */
export interface Level {
  estimate: number;
  window: number;
  reserve: number;
  /** Oldest turns left out to fit; the window is full when any are. */
  trimmed: number;
}

export type MeterStage = "quiet" | "near" | "full";

/** The meter shows from this share of the window and hides again below the lower one, so it does not flicker at the edge. */
const REVEAL = 0.75;
const HIDE = 0.7;

/**
 * How much the meter shows: nothing while there is room, the level once the
 * window is nearly full, "full" once history is left out.
 */
export function meterStage(level: Level, previous: MeterStage): MeterStage {
  if (level.trimmed > 0) return "full";
  const share = level.estimate / level.window;
  if (share >= REVEAL) return "near";
  return previous !== "quiet" && share >= HIDE ? "near" : "quiet";
}
