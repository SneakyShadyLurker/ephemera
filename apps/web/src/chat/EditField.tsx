import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { KeyHint } from "@/components/ui/key-hint";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { COMPOSER } from "./Composer.tsx";
import { chatStore, useChat } from "./session.ts";
import type { EditTarget } from "./store.ts";

/**
 * Puts focus back where the edit began once its field closes: the composer
 * for an edit a key opened there, else the turn's visible Edit control (or
 * its More menu).
 */
function returnFocus(id: string, fromComposer: boolean) {
  requestAnimationFrame(() => {
    // Only focus lost with the closed field comes back; a field opened meanwhile keeps it.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const controls = fromComposer
      ? document.querySelectorAll<HTMLElement>(COMPOSER)
      : document.querySelectorAll<HTMLElement>(`[data-edit-for="${CSS.escape(id)}"]`);
    [...controls].find((control) => control.checkVisibility())?.focus();
  });
}

const openedFromComposer = () => chatStore.getState().editing?.fromComposer === true;

/**
 * A message in its edit field, in the turn's own type with the composer's
 * focus ring: a reply's field speaks in the story's voice (`voice-story`),
 * at the size its turn sets. Save (Ctrl+Enter) changes the user's text or
 * the shown alternate only; Cancel (Esc) keeps it. On touch the keys go
 * unsaid; the two buttons say it. The text being edited is chat
 * content in the store, so it survives leaving the screen and Clear drops it.
 * Save waits while anything is written, and a blank text is deleted, not saved.
 */
export function EditField({
  id,
  label,
  target = "text",
  story = false,
}: {
  id: string;
  label: string;
  target?: EditTarget;
  /** The character's reply: edited in the reading sans it is shown in. */
  story?: boolean;
}) {
  const value = useChat((state) => (state.editing?.id === id ? state.editing.text : ""));
  const busy = useChat((state) => state.generating);
  // Emptied reasoning is removed; an emptied message is deleted instead.
  const blank = value.trim() === "" && target === "text";
  const close = () => {
    const fromComposer = openedFromComposer();
    chatStore.getState().cancelEdit();
    returnFocus(id, fromComposer);
  };
  const save = () => {
    const fromComposer = openedFromComposer();
    if (chatStore.getState().saveEdit()) returnFocus(id, fromComposer);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event)) return;
    // The chat's own shortcuts (Ctrl+Enter regenerates) do not apply inside the field.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  return (
    <div className="grid gap-2">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the field opens because Edit was chosen.
        autoFocus
        aria-label={label}
        value={value}
        autoComplete="off"
        onChange={(event) => chatStore.getState().setEditText(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const end = event.target.value.length;
          event.target.setSelectionRange(end, end);
        }}
        className={cn(
          "max-h-[60dvh] w-full resize-none rounded-lg border border-control-edge bg-surface px-3.5 py-2.5 text-ink transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade [field-sizing:content] focus-visible:border-dusk-line focus-visible:shadow-focus focus-visible:outline-none",
          story && "voice-story",
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <p aria-live="polite" className="flex-1 text-meta text-reed">
          {busy ? (
            "Save waits until the reply is written."
          ) : blank ? (
            "Write something to save, or delete the message instead."
          ) : target === "reasoning" && value.trim() === "" ? (
            "Saving it empty removes the reasoning."
          ) : (
            <KeyHint>Ctrl Enter saves. Esc cancels.</KeyHint>
          )}
        </p>
        <Button variant="quiet" onClick={close}>
          Cancel
        </Button>
        <Button variant="outline" onClick={save} disabled={busy || blank}>
          Save
        </Button>
      </div>
    </div>
  );
}
