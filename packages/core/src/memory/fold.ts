import { MEMORY_LIMITS } from "./limits.ts";

/*
 * The lazy fold: which held memories a prompt folds. Held spans keep their
 * turns in the history while it fits; only once the fit would trim the
 * history do the oldest held spans give way to their memories. Pure; the
 * caller assembles and fits each attempt.
 */

/** How an attempt fitted: not at all, or with `trimmed` history turns left out (0: whole). */
type FoldFit = { ok: false } | { ok: true; trimmed: number };

/**
 * The attempt a prompt is built from, the spans it folded and the turns they
 * covered. `attempt` assembles and fits the prompt with the oldest `spans`
 * held spans folded, their `turns` leading history turns left out. Nothing
 * folds while the history fits whole. A fit that trims folds the fewest
 * further spans whose turns cover what it trimmed; one that does not fit
 * at all folds one more. It ends on a whole fit or with every span folded.
 * Spans past the newest `MEMORY_LIMITS.held` fold from the start, as the tab
 * folds them before it sends, so `attempt` runs at most `MEMORY_LIMITS.held`
 * plus one times however many spans a request holds.
 */
export function foldToFit<T>(
  held: readonly { turns: number }[],
  attempt: (spans: number, turns: number) => T,
  measure: (result: T) => FoldFit,
): { result: T; spans: number; turns: number } {
  let spans = Math.max(0, held.length - MEMORY_LIMITS.held);
  let turns = held.slice(0, spans).reduce((total, span) => total + span.turns, 0);
  for (;;) {
    const result = attempt(spans, turns);
    const fitted = measure(result);
    if (spans >= held.length || (fitted.ok && fitted.trimmed === 0)) {
      return { result, spans, turns };
    }
    // The trimmed turns are the oldest: the next spans cover them first.
    const trimmed = fitted.ok ? fitted.trimmed : 0;
    let covered = 0;
    do {
      const span = held[spans]?.turns ?? 0;
      covered += span;
      turns += span;
      spans += 1;
    } while (covered < trimmed && spans < held.length);
  }
}
