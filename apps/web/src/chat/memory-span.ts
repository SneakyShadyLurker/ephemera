import type { RememberFailure } from "../memory/queries.ts";
import { shownTurns } from "./messages.ts";
import type { ChatMemory, ChatState } from "./store.ts";

export const NO_MEMORY: ChatMemory = {
  horizon: 0,
  held: [],
  boundary: null,
  recap: [],
  foldedLatest: null,
  status: "idle",
  failure: null,
  pending: null,
  shown: false,
};

/** Where the remembered messages end, held or folded, as an index in `messages`. */
export const rememberedEnd = (memory: ChatMemory): number =>
  memory.held.at(-1)?.to ?? memory.horizon;

/**
 * The latest memory, which the seam shows, edits and forgets: the newest
 * held one, else the newest folded one; `to` is where its span ends.
 */
export function latestMemory(
  memory: ChatMemory,
): { id: string; title: string; from: number; to: number; held: boolean } | null {
  const last = memory.held.at(-1);
  if (last !== undefined) return { ...last, held: true };
  const folded = memory.foldedLatest;
  return folded === null ? null : { ...folded, to: memory.horizon, held: false };
}

/**
 * Refusals the next settled reply may try again on its own, with a new
 * attempt: the upstream failed, the request timed out, or memory moved
 * under the call (Forget, or off and on again, in another tab). The server
 * says memory_off only when nothing of the attempt stands (a memory it wrote
 * is the answer whatever happened since), so the new attempt never writes
 * the span twice. A memory that is really off reloads as off, and then no
 * call goes out. Every other
 * one (a span the window cannot take, an unknown window) waits for Try
 * again, since another call would fail the same way.
 */
export const TRANSIENT_FAILURES: ReadonlySet<RememberFailure> = new Set([
  "memory_failed",
  "upstream_busy",
  "upstream_signed_out",
  "timeout",
  "memory_off",
]);

/** The fewest turns the ending's memory takes: one, so nothing of the ending is left out. */
export const ENDING_LEAST = 1;

/**
 * The span the next memory call takes, as message indices [from, to): a
 * lost answer's own span again while it still starts where the remembered
 * messages end and all of it is there, else the unremembered messages but
 * the newest `keep`, ending at its last turn: a trailing message no turn
 * comes from (a slot waiting for a sign-in, a failed or empty reply) stays
 * outside it, open.
 */
export function spanToRemember(
  state: Pick<ChatState, "memory" | "messages">,
  keep: number,
): { from: number; to: number; again: NonNullable<ChatMemory["pending"]> | null } {
  const { memory, messages } = state;
  const from = rememberedEnd(memory);
  const { pending } = memory;
  const again =
    pending !== null &&
    pending.from === from &&
    pending.boundary > from &&
    pending.boundary <= messages.length
      ? pending
      : null;
  if (again !== null) return { from, to: again.boundary, again };
  let to = messages.length - keep;
  while (to > from && shownTurns(messages.slice(to - 1, to)).length === 0) to -= 1;
  return { from, to, again };
}

/**
 * Whether the open edit is of a message in [from, to). Remembering those
 * messages would send them as they were and lock the edit's message, so
 * every memory call, the ending and Remember now's reason wait until the
 * edit is saved or cancelled.
 */
export function editHolds(
  state: Pick<ChatState, "editing" | "messages">,
  span: { from: number; to: number },
): boolean {
  const { editing, messages } = state;
  if (editing === null) return false;
  const at = messages.findIndex((message) => message.id === editing.id);
  return at !== -1 && at >= span.from && at < span.to;
}
