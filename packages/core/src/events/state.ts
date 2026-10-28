import { z } from "zod";
import type { ChatRole } from "../chat.ts";
import { MAX_CHAT_TURNS } from "../chat-limits.ts";
import { MAX_FOLDED_TURNS } from "../memory/state.ts";
import { EVENT_LIMITS, type EventCharacter, type EventFields, eventApplies } from "./event.ts";

/*
 * Which event fired where: chat content, like the lorebook's timed state. It
 * lives in the tab's memory and in the server for one request, never
 * anywhere else. A record says "this event fired in the request whose
 * history had `start` turns", so the reply it fired on is the turn at index
 * `start`. "Length" is as lorebook/timed.ts defines it: the turns in the
 * request's history, the greeting and the message being answered included.
 * Cooldowns are never stored; they are read from the event's current value.
 */

const firedSchema = z
  .strictObject({
    id: z.uuid(),
    start: z.number().int().min(-MAX_FOLDED_TURNS).max(MAX_CHAT_TURNS),
    /** Replies after the firing reply and before the live history; absent means none. */
    foldedReplies: z.number().int().min(0).max(MAX_FOLDED_TURNS).exactOptional(),
  })
  .refine(({ start, foldedReplies }) => foldedReplies === undefined || start < 0, {
    message: "Folded replies require a folded firing reply.",
    path: ["foldedReplies"],
  });
export type FiredEvent = z.infer<typeof firedSchema>;

/** The records one chat carries from reply to reply: one per event at most. */
export const eventsStateSchema = z.strictObject({
  characterId: z.uuid(),
  fired: z
    .array(firedSchema)
    .max(EVENT_LIMITS.events)
    .refine((fired) => new Set(fired.map((record) => record.id)).size === fired.length, {
      message: "one record per event",
    }),
});
export type EventsState = z.infer<typeof eventsStateSchema>;

/** What a roll reads of an event. */
export type RolledEvent = Pick<EventFields, "chance" | "cooldown" | "enabled" | "scope"> & {
  id: string;
};

/** Where a fired event stands: free to roll, or off for `left` more replies. */
type EventStanding = { kind: "free" } | { kind: "cooldown"; left: number };

/**
 * A record's standing in a request whose history has these roles, oldest
 * first. Null when the reply it fired on is not in the history: the chat
 * has not advanced past it (`start >= length`: the exchange that fired it is
 * being regenerated or was deleted), or the turn at `start` is not a reply
 * (that reply failed or came back empty, so it was never sent on); then the
 * record is dropped. Otherwise the event is off while fewer than `cooldown`
 * replies follow the one it fired on. A negative start names a folded
 * reply: its `foldedReplies` and every live reply follow it.
 */
export function eventStanding(
  start: number,
  cooldown: number,
  roles: readonly ChatRole[],
  foldedReplies = 0,
): EventStanding | null {
  if (start >= 0 && roles[start] !== "assistant") return null;
  let after = start < 0 ? foldedReplies : 0;
  for (let index = Math.max(0, start + 1); index < roles.length; index += 1) {
    if (roles[index] === "assistant") after += 1;
  }
  return after < cooldown ? { kind: "cooldown", left: cooldown - after } : { kind: "free" };
}

interface EventRollInput<Event extends RolledEvent> {
  /** Every event of the user's, in list order. */
  events: readonly Event[];
  character: EventCharacter;
  /** The state the request carried; another character's is discarded. */
  state: EventsState | null;
  /** The request's history roles, oldest first, the message being answered included. */
  roles: readonly ChatRole[];
  /** Uniform in [0, 1): the request's random source. */
  random: () => number;
}

interface EventRoll<Event extends RolledEvent> {
  /** The one event that goes in, or null. */
  fired: Event | null;
  /** The carried records that still stand: their event exists, applies and the chat moved past them. */
  kept: FiredEvent[];
}

/**
 * One reply's roll: each enabled event that applies to the character and
 * is off no cooldown draws once against its chance, in list order; when
 * several hit, one more draw picks one of them uniformly. The others start
 * no cooldown. A record whose event is gone or no longer applies is dropped.
 */
export function rollEvents<Event extends RolledEvent>({
  events,
  character,
  state,
  roles,
  random,
}: EventRollInput<Event>): EventRoll<Event> {
  const applying = new Map(
    events
      .filter((event) => eventApplies(event.scope, character))
      .map((event) => [event.id, event]),
  );
  const kept: FiredEvent[] = [];
  const off = new Set<string>();
  if (state !== null && state.characterId === character.id) {
    for (const record of state.fired) {
      const event = applying.get(record.id);
      if (event === undefined) continue;
      const standing = eventStanding(record.start, event.cooldown, roles, record.foldedReplies);
      if (standing === null) continue;
      kept.push(record);
      if (standing.kind === "cooldown") off.add(record.id);
    }
  }
  const hits = [...applying.values()].filter(
    (event) => event.enabled && !off.has(event.id) && random() * 100 < event.chance,
  );
  const pick = hits.length > 1 ? Math.min(Math.floor(random() * hits.length), hits.length - 1) : 0;
  return { fired: hits[pick] ?? null, kept };
}

/**
 * The state the next request carries: the kept records, with the fired
 * event's replaced by one at `length` when it went into the request
 * (`sent`, its id). Records follow the carried order, the new one last.
 */
export function nextEventsState(
  characterId: string,
  kept: readonly FiredEvent[],
  sent: string | null,
  length: number,
): EventsState {
  const fired = kept.filter((record) => record.id !== sent);
  if (sent !== null) {
    fired.push({ id: sent, start: Math.min(Math.max(0, Math.trunc(length)), MAX_CHAT_TURNS) });
  }
  return { characterId, fired };
}

/**
 * The state after the history turn at `index` was deleted: the record of an
 * event that fired on it is dropped, and every later one moves down one.
 */
export function eventsAfterDeletion(state: EventsState, index: number): EventsState {
  return {
    characterId: state.characterId,
    fired: state.fired.flatMap((record) =>
      record.start === index
        ? []
        : [record.start > index ? { ...record, start: record.start - 1 } : record],
    ),
  };
}

/**
 * The state after a turn joined the history at `index` (an earlier failed or
 * empty reply edited into one that is sent): every record at or after it
 * moves up one, so each still names the reply it fired on.
 */
export function eventsAfterInsertion(state: EventsState, index: number): EventsState {
  return {
    characterId: state.characterId,
    fired: state.fired.map((record) =>
      record.start >= index
        ? { ...record, start: Math.min(record.start + 1, MAX_CHAT_TURNS) }
        : record,
    ),
  };
}

/**
 * The state after `count` leading history turns were folded into a memory
 * (negative: unfolded again). Starts move with the live origin, including
 * firing replies inside the fold. `crossedRoles` are the leading turns
 * removed or restored, oldest first: assistant replies after the firing
 * reply join or leave `foldedReplies`, preserving its cooldown. A crossed
 * live anchor must name an assistant reply before its role leaves the history.
 */
export function eventsAfterFold(
  state: EventsState | null,
  count: number,
  crossedRoles: readonly ChatRole[],
): EventsState | null {
  if (state === null || count === 0) return state;
  return {
    characterId: state.characterId,
    fired: state.fired.flatMap((record) => {
      if (
        count > 0 &&
        record.start >= 0 &&
        record.start < count &&
        crossedRoles[record.start] !== "assistant"
      ) {
        return [];
      }
      const start = Math.min(Math.max(record.start - count, -MAX_FOLDED_TURNS), MAX_CHAT_TURNS);
      const { foldedReplies, ...rest } = record;
      if (start >= 0) return [{ ...rest, start }];
      const crossed = crossedRoles
        .slice(count > 0 ? Math.max(0, record.start + 1) : 0)
        .filter((role) => role === "assistant").length;
      const replies = Math.min(
        Math.max((foldedReplies ?? 0) + (count > 0 ? crossed : -crossed), 0),
        MAX_FOLDED_TURNS,
      );
      return [{ ...rest, start, foldedReplies: replies }];
    }),
  };
}

/**
 * The state after the history was cut at `cut` (that turn and every later
 * one deleted together): every record that fired at or past the cut is dropped.
 */
export function eventsAfterTruncation(state: EventsState, cut: number): EventsState {
  return {
    characterId: state.characterId,
    fired: state.fired.filter((record) => record.start < cut),
  };
}
