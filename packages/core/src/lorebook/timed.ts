import { z } from "zod";
import { CARD_LIMITS } from "../card/limits.ts";
import type { LorebookEntry } from "../card/schema.ts";
import { MAX_CHAT_TURNS } from "../chat-limits.ts";
import { MAX_FOLDED_TURNS } from "../memory/state.ts";
import type { CombinedEntry } from "./combine.ts";
import { LOREBOOK_RULES } from "./rules.ts";
import type { EntrySettings } from "./settings.ts";

/** Timed effects hold while history length is below start plus duration. Their state exists only in tab memory and for one server request. */

/** A key within one book across books: the book (none for the card's own), then an index or a digest. */
const place = (book: string | null | undefined, within: number | string) =>
  `${book ?? ""}/${within}`;

/**
 * One record per entry: "this entry was sent at length `start`". Durations
 * are never stored; they are read from the entry's current settings. An
 * entry is named by its book and its index inside that book.
 */
const effectSchema = z.strictObject({
  /** The library book holding the entry; absent for the book in the character's card. */
  book: z.uuid().exactOptional(),
  index: z
    .number()
    .int()
    .min(0)
    .max(CARD_LIMITS.lorebookEntries - 1),
  /** The injected digest of the entry as it was sent; another digest ends the effect. */
  digest: z.string().regex(/^[0-9a-f]{1,32}$/i),
  start: z.number().int().min(-MAX_FOLDED_TURNS).max(MAX_CHAT_TURNS),
});
type TimedEffect = z.infer<typeof effectSchema>;

/** The timed effects one chat carries from request to request. */
export const lorebookStateSchema = z.strictObject({
  characterId: z.uuid(),
  effects: z
    .array(effectSchema)
    .max(LOREBOOK_RULES.combinedEntries)
    .refine(
      (effects) =>
        new Set(effects.map((effect) => place(effect.book, effect.index))).size === effects.length,
      "one effect per entry",
    ),
});
export type LorebookState = z.infer<typeof lorebookStateSchema>;

/** What a request needs to read and write the state; core never hashes. */
export interface TimedIdentity {
  /** The state the request carried. */
  state: LorebookState | null;
  /** The character whose book is activated; another character's state is discarded. */
  characterId: string;
  /** A stable digest of an entry, as hex; the server hashes its canonical JSON. */
  digest: (entry: LorebookEntry) => string;
}

/** Where an entry stands before its keys are read. */
type Standing =
  | { kind: "free" }
  /** Activated without its keys for `left` more messages. */
  | { kind: "sticky"; left: number }
  /** Cannot activate for `left` more messages. */
  | { kind: "cooldown"; left: number }
  /** Cannot activate before the chat has `until` messages. */
  | { kind: "delayed"; until: number };

/** An entry as the timed state names it: the entry, its book and its index there. */
type TimedEntry = Pick<CombinedEntry, "entry" | "book" | "index">;

/**
 * Every entry's standing, and its entry's record by its position in the
 * combined list, expired ones included: a later request with a shorter
 * history (a regenerate after a Continue) can stand inside an effect again.
 */
interface Timed {
  standings: Standing[];
  kept: Map<number, TimedEffect>;
}

type Durations = Pick<EntrySettings, "sticky" | "cooldown" | "delay">;

/**
 * An effect's standing at `length`: sticky while `length < start + sticky`,
 * on cooldown until `start + sticky + cooldown`, then over (null). A record
 * the chat has not advanced past (`start >= length`: a swipe, regenerate,
 * delete or resend of the exchange that started it) is over too, and the
 * entry is read by its keys again.
 */
function effectStanding(
  start: number,
  { sticky, cooldown }: Pick<Durations, "sticky" | "cooldown">,
  length: number,
): Extract<Standing, { kind: "sticky" | "cooldown" }> | null {
  if (start >= length) return null;
  if (length < start + sticky) return { kind: "sticky", left: start + sticky - length };
  const ends = start + sticky + cooldown;
  if (length < ends) return { kind: "cooldown", left: ends - length };
  return null;
}

/** A record for the entry `at`, naming its book only when it is a library book. */
function recordOf(at: TimedEntry, digest: string, start: number): TimedEffect {
  return at.book === null
    ? { index: at.index, digest, start }
    : { book: at.book, index: at.index, digest, start };
}

/**
 * Each entry's standing at `length` from the carried state. A record is
 * dropped when the state is another character's, its entry is gone, the
 * entry changed since (its digest differs: editing an entry ends its
 * effect), the chat has not advanced past it, or its start is below the
 * entry's delay (an activation that could not have happened). Delay holds
 * whatever the state says: an entry, constant or not, activates only once
 * the chat has `delay` turns. Delay counts the whole chat, the `folded`
 * turns a memory holds included (memory/state.ts); starts, sticky and
 * cooldown stay relative to the live history. A record without a book is
 * the card's own book's.
 */
export function applyTimed(
  entries: readonly TimedEntry[],
  settings: readonly Durations[],
  length: number,
  identity: TimedIdentity | null,
  folded = 0,
): Timed {
  const kept = new Map<number, TimedEffect>();
  const state = identity?.state;
  if (identity != null && state != null && state.characterId === identity.characterId) {
    const digests = new Map<number, string>();
    const digestOf = (position: number) => {
      let digest = digests.get(position);
      const at = entries[position];
      if (digest === undefined && at !== undefined) {
        digest = identity.digest(at.entry);
        digests.set(position, digest);
      }
      return digest;
    };
    const keep = (effect: TimedEffect, position: number) => {
      const durations = settings[position];
      const at = entries[position];
      if (durations === undefined || at === undefined) return;
      if (effect.start >= length || effect.start + folded < durations.delay) return;
      kept.set(position, recordOf(at, effect.digest, effect.start));
    };
    const positions = new Map<string, number>();
    for (const [position, at] of entries.entries()) {
      const key = place(at.book, at.index);
      if (!positions.has(key)) positions.set(key, position);
    }
    // An effect stays with its entry: at its index when that entry is unchanged, else at the
    // first unclaimed entry of the same book with its digest (entries removed or added before
    // it move it); an entry that changed, or is gone, ends its effect.
    const claimed = new Set<number>();
    const moved: TimedEffect[] = [];
    for (const effect of state.effects) {
      const position = positions.get(place(effect.book, effect.index));
      if (
        position !== undefined &&
        !claimed.has(position) &&
        digestOf(position) === effect.digest
      ) {
        claimed.add(position);
        keep(effect, position);
      } else moved.push(effect);
    }
    if (moved.length > 0) {
      // The unclaimed entries of the moved effects' books, by book and digest, in book order.
      const books = new Set(moved.map((effect) => effect.book ?? null));
      const free = Map.groupBy(
        entries.entries().filter(([position, at]) => !claimed.has(position) && books.has(at.book)),
        ([position, at]) => place(at.book, digestOf(position) ?? ""),
      );
      const taken = new Map<string, number>();
      for (const effect of moved) {
        const key = place(effect.book, effect.digest);
        const next = taken.get(key) ?? 0;
        const position = free.get(key)?.[next]?.[0];
        if (position === undefined) continue;
        taken.set(key, next + 1);
        claimed.add(position);
        keep(effect, position);
      }
    }
  }
  const standings = settings.map((durations, position): Standing => {
    if (length + folded < durations.delay) return { kind: "delayed", until: durations.delay };
    const effect = kept.get(position);
    const timed = effect === undefined ? null : effectStanding(effect.start, durations, length);
    return timed ?? { kind: "free" };
  });
  return { standings, kept };
}

/**
 * The state after `count` leading history turns were folded into a memory
 * (negative: unfolded again). Every start moves down with the turns, so a
 * sticky or cooldown effect keeps the turns it had left, including one
 * whose start is now negative, inside the folded span. Delay still counts
 * the folded turns: requests carry them as
 * `folded` (applyTimed).
 */
export function lorebookStateAfterFold(
  state: LorebookState | null,
  count: number,
): LorebookState | null {
  if (state === null || count === 0) return state;
  return {
    characterId: state.characterId,
    effects: state.effects.map((effect) => ({
      ...effect,
      start: Math.min(Math.max(effect.start - count, -MAX_FOLDED_TURNS), MAX_CHAT_TURNS),
    })),
  };
}

/**
 * The state the next request carries: every kept record, expired ones
 * included, keeping its start (keywords seen while sticky do not refresh
 * it), and a record at `length` for every entry sent now that has a sticky
 * or cooldown duration and no record in effect, replacing an expired one.
 * One record per entry keeps the state bounded. **Decided:** only sent
 * entries start an effect; an activated entry the budget left out starts
 * none. Records follow the combined order. Null without an identity to
 * write it under.
 */
export function nextState(
  entries: readonly TimedEntry[],
  settings: readonly Durations[],
  timed: Timed,
  sent: Iterable<number>,
  length: number,
  identity: TimedIdentity | null,
): LorebookState | null {
  if (identity === null) return null;
  const effects = new Map(timed.kept);
  const start = Math.min(Math.max(0, Math.trunc(length)), MAX_CHAT_TURNS);
  for (const position of sent) {
    const at = entries[position];
    const durations = settings[position];
    if (at === undefined || durations === undefined) continue;
    const standing = timed.standings[position]?.kind;
    if (standing === "sticky" || standing === "cooldown") continue;
    if (durations.sticky > 0 || durations.cooldown > 0) {
      effects.set(position, recordOf(at, identity.digest(at.entry), start));
    }
  }
  return {
    characterId: identity.characterId,
    effects: [...effects.entries()].sort(([a], [b]) => a - b).map(([, effect]) => effect),
  };
}
