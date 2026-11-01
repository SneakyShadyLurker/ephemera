import { type Lorebook, summarizeLorebook } from "@ephemera/core";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LorebookIcon, PlusIcon } from "@/components/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { countOf, formatCount } from "@/lib/text";
import { useSettled } from "../rework/ReviewField.tsx";
import { useReworkLocked } from "../rework/session.ts";
import { HELP, SHEET_GRID, sheetLabel } from "../sheet/fields.ts";
import { bookSettings } from "./book.ts";
import { LinkedBooks } from "./LinkedBooks.tsx";

/**
 * The character sheet's Lorebook section, after the definition it surrounds:
 * the book in its card (a summary and the way into its screen), then the
 * library books linked to it. A new, unsaved character has none to open or
 * link yet. `book` is the sheet's, so the summary
 * follows changes an AI Rework applied; `review` shows a rework's changes to
 * the book above the summary while they are under review, and the way into
 * the screen is off while the rework holds the sheet (leaving would drop
 * the proposal).
 */
export function LorebookSection({
  id,
  name,
  book,
  review,
}: {
  id: string | null;
  name: string;
  book: Lorebook | undefined;
  review?: ReactNode;
}) {
  const locked = useReworkLocked();
  const settled = useSettled("lorebook");
  // Counts are core's: an entry by chance is not always on.
  const counts = book === undefined ? null : summarizeLorebook(book);
  const settings = book === undefined ? null : bookSettings(book);
  const depth = settings?.effectiveDepth ?? null;
  const budget = settings?.budget ?? null;
  return (
    <section id="s-lorebook" aria-labelledby="lorebook-heading" className={SHEET_GRID}>
      <h2 id="lorebook-heading" className={sheetLabel()}>
        Lorebook
      </h2>
      <div className="grid gap-8">
        <div className="grid gap-3">
          {review}
          <h3 className="font-medium text-ink text-ui">In this card</h3>
          {counts !== null && counts.entries > 0 && depth !== null ? (
            <div
              data-settle={settled ? "" : undefined}
              className="settle-glow flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rush bg-surface px-4 py-3"
            >
              <div className="grid min-w-0 gap-0.5">
                <span className="text-ink text-ui">
                  {countOf(counts.entries, "entry", "entries")}, {formatCount(counts.enabled)}{" "}
                  enabled
                  {counts.always > 0 && `, ${formatCount(counts.always)} of them always on`}
                  {counts.chance > 0 && `, ${formatCount(counts.chance)} by chance`}
                </span>
                <span className="text-meta text-reed">
                  Reads the last {countOf(depth, "message")}, up to{" "}
                  {budget === null
                    ? "a quarter of the context window"
                    : `${formatCount(budget)} tokens`}
                  {settings?.chaining === true && ", and entries can bring in others"}
                </span>
              </div>
              <OpenLink
                id={id}
                locked={locked}
                icon={<LorebookIcon size={16} />}
                label="Open lorebook"
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <OpenLink
                id={id}
                locked={locked}
                icon={<PlusIcon size={16} />}
                label="Create lorebook"
              />
            </div>
          )}
          <p className={HELP}>
            Background the model reads when an entry's keywords come up in the chat, always, or by
            chance. Saved in the card and used with every chat with {name}.
          </p>
        </div>
        <LinkedBooks id={id} name={name} locked={locked} />
      </div>
    </section>
  );
}

/** The way into the lorebook screen; a character not yet saved has none, nor one held by a rework. */
function OpenLink({
  id,
  locked,
  icon,
  label,
}: {
  id: string | null;
  locked: boolean;
  icon: ReactNode;
  label: string;
}) {
  if (id === null || locked) {
    return (
      <Button variant="outline" disabled>
        {icon}
        {label}
      </Button>
    );
  }
  return (
    <Link
      to="/characters/$id/lorebook"
      params={{ id }}
      className={buttonVariants({ variant: "outline" })}
    >
      {icon}
      {label}
    </Link>
  );
}
