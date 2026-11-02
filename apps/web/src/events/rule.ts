import type { EventFields, EventScope } from "@ephemera/core";
import { andList, bounded, countOf, formatCount, orList } from "@/lib/text";

/*
 * The words an event's row reads in: its rule as one sentence (chance,
 * quiet time and what the owner will feel in play) and its scope as names.
 * Pure, so the row, the open editor and the tests read the same text.
 */

/** A chance, and an average below 10 (so 70% reads 1.4 rather than every reply). */
const oneDecimal = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const NEAR_BELOW = 10;

/** Replies between two firings on average: one in 1/chance, then the quiet ones; null at 0%. */
export function averageReplies(chance: number, cooldown: number): number | null {
  if (chance <= 0) return null;
  return 1 / (chance / 100) + cooldown;
}

/**
 * The rule's average as words, or null when it never fires: "Every reply."
 * only at 100% with no quiet replies, one decimal below 10, whole replies
 * from 10 up.
 */
function averageText(chance: number, cooldown: number): string | null {
  const average = averageReplies(chance, cooldown);
  if (average === null) return null;
  if (chance >= 100 && cooldown === 0) return "Every reply.";
  const shown =
    average < NEAR_BELOW ? oneDecimal.format(average) : formatCount(Math.round(average));
  return `About once in ${shown} replies.`;
}

/** Chance and quiet time: "5% per reply, then quiet for 30." */
function ruleText({ chance, cooldown }: Pick<EventFields, "chance" | "cooldown">): string {
  const per = `${oneDecimal.format(chance)}% per reply`;
  return cooldown === 0 ? `${per}.` : `${per}, then quiet for ${formatCount(cooldown)}.`;
}

/**
 * The rule as the row says it, split where the average starts so the
 * average can change on its own. Off leads with "Off." and has no average;
 * at 0% an enabled event never fires.
 */
export function ruleSentence(fields: Pick<EventFields, "chance" | "cooldown" | "enabled">): {
  lead: string;
  average: string | null;
} {
  if (!fields.enabled) return { lead: `Off. ${ruleText(fields)}`, average: null };
  if (fields.chance <= 0) return { lead: "Never fires at 0%.", average: null };
  return { lead: ruleText(fields), average: averageText(fields.chance, fields.cooldown) };
}

/** Parts a scope line names before the rest are counted. */
const SHOWN = 3;

/**
 * Who an event applies to: "All characters", or the chosen characters by
 * name and the chosen tags, beyond three shortened with "and N more". A
 * chosen character that no longer exists is left out; nothing chosen is
 * "Applies to no one yet."
 */
export function scopeSummary(scope: EventScope, names: ReadonlyMap<string, string>): string {
  if (scope.kind === "all") return "All characters";
  const characters = scope.characters.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
  const items = [
    ...characters.map((name) => ({ kind: "character" as const, name })),
    ...scope.tags.map((name) => ({ kind: "tag" as const, name })),
  ];
  if (items.length === 0) return "Applies to no one yet.";
  const { shown, more } = bounded(items, SHOWN);
  const tags = shown.filter((item) => item.kind === "tag").map((item) => `"${item.name}"`);
  const parts = [
    ...shown.filter((item) => item.kind === "character").map((item) => item.name),
    ...(tags.length === 0 ? [] : [`cards tagged ${orList(tags)}`]),
    ...(more === null ? [] : [more]),
  ];
  return andList(parts);
}

/**
 * The section's closed row: how many events there are and how many are on,
 * then how many hold edits that could not be saved, if any.
 */
export function eventsSummary(
  events: readonly Pick<EventFields, "enabled">[],
  unsaved = 0,
): string {
  const failed = unsaved === 0 ? "" : `. ${formatCount(unsaved)} not saved`;
  if (events.length === 0) return `None yet${failed}`;
  const on = events.filter((event) => event.enabled).length;
  const total = countOf(events.length, "event");
  return `${total}, ${on === events.length ? "all" : on === 0 ? "none" : formatCount(on)} on${failed}`;
}
