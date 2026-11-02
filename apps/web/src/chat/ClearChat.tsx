import { type ReactElement, type RefObject, useState } from "react";
import { currentSettings } from "../settings/settings.ts";
import { useChatCharacter } from "./character.ts";
import { DiscardChatDialog } from "./RememberEnding.tsx";
import { useClearChat } from "./StartChat.tsx";
import { chatStore } from "./session.ts";
import { hasChatContent } from "./store.ts";

/**
 * Clear asks first; confirming empties the chat at once, with nothing kept to
 * undo, and closes its character, back to a chat without one. A chat with
 * nothing written yet, at most its untouched greeting, clears without asking,
 * as starting a chat with someone else does. While memory
 * is on and the ending is unremembered, it offers to remember the ending
 * first; the dialog stays open while it is written and clears once it is.
 * With a `trigger`, Base UI wires it to the dialog; without one (a menu's
 * item), `request` opens it, and closing returns focus to `returnTo`.
 */
export function useClearChatDialog({
  composer,
  trigger,
  returnTo,
}: {
  composer: RefObject<HTMLTextAreaElement | null>;
  trigger?: ReactElement;
  returnTo?: RefObject<HTMLElement | null>;
}): { dialog: ReactElement; request: () => void } {
  const clear = useClearChat();
  const character = useChatCharacter();
  const [open, setOpen] = useState(false);
  const closes = character ? `The chat with ${character.name} closes. ` : "";
  const onOpenChange = (next: boolean) => {
    // Nothing written yet, at most the untouched greeting: nothing to lose or remember.
    if (next && !hasChatContent(chatStore.getState())) {
      clear();
      composer.current?.focus();
      return;
    }
    setOpen(next);
  };
  const dialog = (
    <DiscardChatDialog
      open={open}
      onOpenChange={onOpenChange}
      proceed={() => {
        clear();
        setOpen(false);
      }}
      title="Clear this chat?"
      description={{
        remembering: `${closes}The chat itself is never saved, so its messages cannot be restored.`,
        plain: `${closes}Messages and your draft are removed from this tab. Nothing is saved anywhere, so they cannot be restored.`,
      }}
      labels={{
        remember: "Remember and clear",
        without: "Clear without remembering",
        confirm: "Clear",
      }}
      {...(trigger === undefined ? {} : { trigger })}
      // After clearing, the disabled Clear cannot hold focus: write the next line instead.
      finalFocus={() =>
        hasChatContent(chatStore.getState()) || currentSettings().characterId !== null
          ? (returnTo?.current ?? true)
          : composer.current
      }
    />
  );
  return { dialog, request: () => onOpenChange(true) };
}

/** Clear with its own trigger: the header's Clear control. */
export function ClearChat({
  trigger,
  composer,
}: {
  trigger: ReactElement;
  composer: RefObject<HTMLTextAreaElement | null>;
}) {
  return useClearChatDialog({ composer, trigger }).dialog;
}
