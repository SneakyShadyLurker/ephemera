import {
  applyChanges,
  entryName,
  entrySettings,
  entryTitle,
  fieldLabel,
  type LorebookEntry,
  type ReworkCard,
} from "@ephemera/core";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { percent } from "../lorebook/copy.ts";
import { ChangeDecision, Deleted, Inserted } from "./ChangeRuns.tsx";
import { type ReviewItem, useReview } from "./ReviewField.tsx";
import { reworkStore } from "./session.ts";
import { TrackedChips, TrackedKeys } from "./TrackedKeys.tsx";
import { TrackedText } from "./TrackedText.tsx";

/*
 * The sheet's Lorebook section during a review: one row per entry the
 * changes touch, above the book's summary. An existing entry shows each
 * changed part with its own decision; a new entry and a removed one are one
 * row with one decision, as they are applied whole. Text nodes only.
 */

const ROW = "grid min-w-0 gap-3 rounded-lg border border-rush bg-surface p-4";
const WORD = /\S+/gu;
/** Removed content longer than this hides behind "Show removed entry". */
const REMOVED_WORDS = 60;

/** How the entry is used, in the summary's words: "enabled, always on"; by chance is not always on. */
function usage(entry: LorebookEntry): string {
  if (!entry.enabled) return "disabled";
  if (entry.constant !== true) return "enabled, on its keywords";
  const { chance } = entrySettings(entry);
  return chance === null ? "enabled, always on" : `enabled, by chance, ${percent(chance)}`;
}

/** The entry's number and use: the stable identity beside a name that may repeat or be empty. */
function Context({
  number,
  entry,
  state,
}: {
  number: string;
  entry: LorebookEntry;
  state?: string;
}) {
  return (
    <p className="text-meta text-reed">
      {[number, state, usage(entry)].filter(Boolean).join(", ")}
    </p>
  );
}

export function LorebookReview() {
  const { base, items } = useReview();
  if (base === null) return null;
  const existing = new Map<number, ReviewItem[]>();
  const added = new Map<number, ReviewItem[]>();
  for (const item of items) {
    const { field } = item.change;
    if (field.kind === "entry")
      existing.set(field.index, [...(existing.get(field.index) ?? []), item]);
    if (field.kind === "entry_new")
      added.set(field.number, [...(added.get(field.number) ?? []), item]);
  }
  if (existing.size === 0 && added.size === 0) return null;
  return (
    <div className="grid gap-3">
      {[...existing].map(([index, own]) => {
        const entry = base.lorebook?.entries[index];
        if (entry === undefined) return null;
        const removal = own.find(
          (item) =>
            item.change.field.kind === "entry" &&
            item.change.field.part === "content" &&
            item.change.whole &&
            item.change.replace === "",
        );
        return removal === undefined ? (
          <EntryRow key={`e${index}`} base={base} index={index} entry={entry} items={own} />
        ) : (
          <RemovedRow key={`e${index}`} index={index} entry={entry} item={removal} />
        );
      })}
      {[...added].map(([number, own]) => (
        <NewRow key={`n${number}`} base={base} number={number} items={own} />
      ))}
    </div>
  );
}

/** An existing entry with changed parts, each with its own decision. */
function EntryRow({
  base,
  index,
  entry,
  items,
}: {
  base: ReworkCard;
  index: number;
  entry: LorebookEntry;
  items: ReviewItem[];
}) {
  const part = (name: "name" | "keys" | "content") =>
    items.filter((item) => item.change.field.kind === "entry" && item.change.field.part === name);
  const names = part("name");
  const keys = part("keys");
  const content = part("content");
  const label = (name: "name" | "keys" | "content") =>
    fieldLabel({ kind: "entry", index, part: name }, base);
  /** The keywords after one change, as Apply would write them. */
  const keysAfter = (item: ReviewItem) =>
    applyChanges(base, [item.change]).next.lorebook?.entries[index]?.keys ?? entry.keys;
  return (
    <div className={cn(ROW, "change-arrive")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        {names.length > 0 ? (
          <div className="min-w-[min(100%,16rem)] flex-1">
            <TrackedText
              text={entryName(entry)}
              items={names}
              label={label("name")}
              face="heading"
              framed={false}
            />
          </div>
        ) : (
          <h3 className="min-w-0 font-medium text-ink text-ui">{entryTitle(entry, index)}</h3>
        )}
        <Context number={`Entry ${index + 1}`} entry={entry} />
      </div>
      {keys.length === 0 ? (
        <TrackedChips before={entry.keys} after={entry.keys} />
      ) : (
        keys.map((item) => (
          <TrackedKeys
            key={item.change.at}
            item={item}
            field={label("keys")}
            before={entry.keys}
            after={keysAfter(item)}
          />
        ))
      )}
      {content.length > 0 && (
        <TrackedText text={entry.content} items={content} label={label("content")} framed={false} />
      )}
    </div>
  );
}

/** An entry the change removes: wholly struck, one decision; long content behind a disclosure. */
function RemovedRow({
  index,
  entry,
  item,
}: {
  index: number;
  entry: LorebookEntry;
  item: ReviewItem;
}) {
  const whyId = useId();
  const at = item.change.at;
  const title = entryTitle(entry, index);
  const long = (entry.content.match(WORD)?.length ?? 0) > REMOVED_WORDS;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a change's group; a fieldset would carry form semantics.
    <div
      role="group"
      aria-label={`Change ${item.number} of ${item.total}: removed entry ${title}`}
      aria-describedby={whyId}
      tabIndex={-1}
      data-change-at={at}
      data-decision={item.decision}
      className={cn(ROW, "change-mark change-arrive group/change")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h3 className="min-w-0 font-medium text-ui">
          <Deleted text={title} />
        </h3>
        <Context number={`Entry ${index + 1}`} state="removed" entry={entry} />
      </div>
      <TrackedChips before={entry.keys} after={[]} />
      {long ? (
        <details className="disclosure group/removed">
          <summary className="flex w-fit cursor-pointer list-none items-center rounded-md text-note text-reed hover:text-ink focus-visible:outline-2 focus-visible:outline-dusk-line focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
            Show removed entry
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-turn">
            <Deleted text={entry.content} />
          </p>
        </details>
      ) : (
        <p className="whitespace-pre-wrap break-words text-turn">
          <Deleted text={entry.content} />
        </p>
      )}
      <ChangeDecision
        label={`removed entry: ${title}`}
        why={item.change.why}
        whyId={whyId}
        decision={item.decision}
        onAccept={() => reworkStore.getState().accept(at)}
        onReject={() => reworkStore.getState().reject(at)}
      />
    </div>
  );
}

/**
 * An entry the change adds: its parts wholly inserted and one decision for
 * them all (their group), folding away when rejected. Each part is still a
 * target for Previous and Next.
 */
function NewRow({
  base,
  number,
  items,
}: {
  base: ReworkCard;
  number: number;
  items: ReviewItem[];
}) {
  const whyId = useId();
  const [first] = items;
  if (first === undefined) return null;
  const book = applyChanges(
    base,
    items.map((item) => item.change),
  ).next.lorebook;
  const entry = book?.entries.at(-1);
  if (entry === undefined) return null;
  const index = (book?.entries.length ?? 1) - 1;
  const title = entryTitle(entry, index);
  const label = `New entry: ${title}`;
  const decision = first.decision;
  const at = (name: "name" | "keys" | "content") =>
    items.find((item) => item.change.field.kind === "entry_new" && item.change.field.part === name);
  /** A part's attributes as a target of Previous and Next, when the answer wrote that part. */
  const target = (name: "name" | "keys" | "content") => {
    const item = at(name);
    return item === undefined
      ? {}
      : {
          role: "group" as const,
          tabIndex: -1,
          "data-change-at": item.change.at,
          "aria-label": `Change ${item.number} of ${item.total} in ${fieldLabel(item.change.field, base)}`,
        };
  };
  const mark = (name: "name" | "keys" | "content") =>
    at(name) !== undefined && "change-mark -ms-1 ps-1";
  const why = [...new Set(items.map((item) => item.change.why).filter((text) => text !== ""))].join(
    " ",
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a change's group; a fieldset would carry form semantics.
    <div
      role="group"
      aria-label={label}
      aria-describedby={whyId}
      data-decision={decision}
      className="change-arrive group/change grid min-w-0 rounded-lg border border-rush bg-surface p-4"
    >
      <div
        {...target("name")}
        className={cn(
          "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5",
          mark("name"),
        )}
      >
        <h3 className="min-w-0 font-medium text-ui">
          <Inserted text={title} />
        </h3>
        <Context number={`New entry ${number}`} entry={entry} />
      </div>
      {/* Rejected, the entry's body folds away; its title stays, faded, beside Restore. */}
      <div className="tracked-fold grid gap-3 pt-3">
        <div {...target("keys")} className={cn(mark("keys"))}>
          <TrackedChips before={[]} after={entry.keys} />
        </div>
        {entry.content !== "" && (
          <p
            {...target("content")}
            className={cn("whitespace-pre-wrap break-words text-turn", mark("content"))}
          >
            <Inserted text={entry.content} />
          </p>
        )}
      </div>
      <ChangeDecision
        label={`new entry: ${title}`}
        why={why}
        whyId={whyId}
        decision={decision}
        onAccept={() => reworkStore.getState().setGroup(first.group, "accepted")}
        onReject={() => reworkStore.getState().setGroup(first.group, "rejected")}
      />
    </div>
  );
}
