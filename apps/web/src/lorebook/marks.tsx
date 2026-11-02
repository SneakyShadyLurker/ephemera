import { ENTRY_ACTIVATIONS, type EntryActivation, type LorebookCounts } from "@ephemera/core";
import {
  AlwaysMarkIcon,
  ChanceMarkIcon,
  type IconProps,
  KeywordsMarkIcon,
} from "@/components/icons";
import { cn } from "@/lib/cn";
import { countOf, formatCount } from "@/lib/text";
import { ACTIVATION_COUNT_TEXT } from "./copy.ts";

/*
 * The activation marks in use: one sign per way an entry goes in, beside the
 * words that say it. Card and book data, never chat content.
 */

const MARKS: Record<EntryActivation, (props: IconProps) => React.ReactNode> = {
  always: AlwaysMarkIcon,
  keywords: KeywordsMarkIcon,
  chance: ChanceMarkIcon,
};

/** The mark of `activation`; an entry switched off dims it (its "Off" is said beside it). */
export function ActivationMark({
  activation,
  off = false,
  className,
}: {
  activation: EntryActivation;
  off?: boolean;
  className?: string;
}) {
  const Mark = MARKS[activation];
  return <Mark size={16} className={cn(off && "opacity-50", className)} />;
}

/** "42 entries, 40 on" or "1 entry, all on"; "No entries" for an empty book. */
export function entriesText(counts: Pick<LorebookCounts, "entries" | "enabled">): string {
  if (counts.entries === 0) return "No entries";
  const total = countOf(counts.entries, "entry", "entries");
  return counts.enabled === counts.entries
    ? `${total}, all on`
    : `${total}, ${formatCount(counts.enabled)} on`;
}

/**
 * A book's counts as a list row says them: the entries and how many are on,
 * then each kind of the enabled ones with its mark, mutually exclusive, only
 * the kinds it has.
 */
export function ActivationCounts({
  counts,
  className,
}: {
  counts: LorebookCounts;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5", className)}>
      <span>{entriesText(counts)}</span>
      {ENTRY_ACTIVATIONS.filter((kind) => counts[kind] > 0).map((kind) => (
        <span key={kind} className="inline-flex items-center gap-1 whitespace-nowrap">
          <ActivationMark activation={kind} className="text-ink" />
          <span className="tabular-nums">{formatCount(counts[kind])}</span>{" "}
          {ACTIVATION_COUNT_TEXT[kind]}
        </span>
      ))}
    </span>
  );
}
