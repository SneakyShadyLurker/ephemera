import { CARD_LIMITS } from "@ephemera/core";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { GLIDE } from "@/app/glide.ts";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { LIST_X } from "../lorebook/EntryList.tsx";
import type { BookContext } from "../lorebook/LorebookEditor.tsx";
import { FIELD, HELP, TITLE_FIELD } from "../sheet/fields.ts";
import { BookLinks } from "./BookLinks.tsx";
import { NAME_TRANSITION } from "./BookRow.tsx";
import { useLibrary } from "./library-state.ts";

/**
 * A library book's head, above its reading rules: its name to edit in place,
 * its description, and the characters it is linked to, with one status line
 * for what was just done. The name's text carries the shared transition with
 * the library row it was opened from, on a wrapper that holds still (no input
 * chrome is in it at rest, and focus never waits for the glide).
 */
export function BookHead({
  id,
  context,
  selectName,
  notice,
  onDismiss,
}: {
  id: string;
  context: BookContext;
  /** A new book: its placeholder name is selected for typing. */
  selectName: boolean;
  notice: { text: string; failed: boolean } | null;
  onDismiss: () => void;
}) {
  const glides = useLibrary((state) => state.opened === id);
  const field = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const blank = context.name.trim() === "";
  useEffect(() => {
    if (selectName) field.current?.select();
  }, [selectName]);
  const style: CSSProperties | undefined = glides
    ? { viewTransitionName: NAME_TRANSITION }
    : undefined;
  return (
    <div className={cn(LIST_X, "grid gap-4 border-rush border-b pt-5 pb-5")}>
      <p
        role="status"
        className={cn(
          "flex min-h-0 items-center gap-2 text-note empty:hidden",
          notice?.failed ? "text-ember" : "text-reed",
        )}
      >
        {notice !== null && (
          <>
            <span className="min-w-0 flex-1 text-pretty">{notice.text}</span>
            <Button size="text" className="text-ink" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        )}
      </p>
      <div className="grid gap-1">
        <span style={style} className={cn("grid", GLIDE)}>
          <input
            ref={field}
            aria-label="Name"
            value={context.name}
            placeholder="Name"
            maxLength={CARD_LIMITS.nameLength}
            autoComplete="off"
            aria-invalid={blank || undefined}
            aria-describedby={blank ? problemId : undefined}
            onChange={(event) => context.onName(event.target.value)}
            className={cn(TITLE_FIELD, "min-w-0 py-0.5 text-heading aria-invalid:border-ember")}
          />
        </span>
        {blank && (
          <p id={problemId} className="text-ember text-note">
            Add a name to save the lorebook.
          </p>
        )}
      </div>
      <Description
        value={context.book.description ?? ""}
        onChange={(description) => context.onBook({ description })}
      />
      <BookLinks id={id} name={context.name} />
    </div>
  );
}

/**
 * The description: a compact preview at rest, a labelled field while it is
 * edited. The preview only shortens what shows; the whole text is kept.
 */
function Description({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  // Whether a pointer is down, so a blur it caused can wait for its click.
  const pressing = useRef(false);
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!editing) return;
    const down = () => {
      pressing.current = true;
    };
    const up = () => {
      pressing.current = false;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, [editing]);
  if (!editing) {
    return value.trim() === "" ? (
      <Button
        variant="quiet"
        className="-ml-2 h-auto min-h-9 justify-self-start px-2 py-1.5 font-normal text-reed text-ui touch:min-h-11"
        onClick={() => setEditing(true)}
      >
        <PlusIcon size={16} />
        Add a description
      </Button>
    ) : (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring-inset -mx-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover"
      >
        <span className="sr-only">Edit description: </span>
        <span className="line-clamp-2 text-pretty text-narration text-ui">{value}</span>
      </button>
    );
  }
  return (
    <div className="grid gap-1.5 transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0">
      <label htmlFor={fieldId} className="font-medium text-ink text-ui">
        Description
      </label>
      <textarea
        ref={field}
        id={fieldId}
        value={value}
        rows={2}
        maxLength={CARD_LIMITS.textLength}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          // A press on a control below blurs the field before its click lands; closing
          // the field at once would move that control out from under the pointer.
          if (!pressing.current) return setEditing(false);
          const close = () => {
            window.removeEventListener("click", close);
            window.removeEventListener("pointercancel", close);
            setEditing(false);
          };
          window.addEventListener("click", close);
          window.addEventListener("pointercancel", close);
        }}
        className={cn(FIELD, "text-ui")}
      />
      <p className={HELP}>For you; the model doesn't read it.</p>
    </div>
  );
}
