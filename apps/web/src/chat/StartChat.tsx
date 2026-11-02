import { type PersonaSummary, resolvePersona } from "@ephemera/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { boundPersona, personasQuery } from "../personas/queries.ts";
import { currentSettings, useUpdateSettings } from "../settings/settings.ts";
import { DiscardChatDialog } from "./RememberEnding.tsx";
import { chatStore } from "./session.ts";
import { contentChangedSince, hasChatContent } from "./store.ts";

/**
 * Clears the chat and sets who the next one is with in one step, so the old
 * character's greeting never returns between them. The new chat starts as the
 * persona the character goes with, else the default persona, else the current one.
 */
function switchChat(
  id: string | null,
  personas: PersonaSummary[] | undefined,
  updateSettings: ReturnType<typeof useUpdateSettings>,
) {
  const { defaultPersonaId, personaId } = currentSettings();
  chatStore.getState().clear();
  updateSettings({
    characterId: id,
    personaId: resolvePersona({
      bound: boundPersona(personas, id),
      defaultPersona: defaultPersonaId,
      current: personaId,
    }),
  });
}

/**
 * Clear: empties the chat and leaves its character, as choosing "No character"
 * would; without a character it only empties the chat, keeping the persona.
 */
export function useClearChat(): () => void {
  const updateSettings = useUpdateSettings();
  return () => {
    if (currentSettings().characterId === null) chatStore.getState().clear();
    // No character has no bound persona, so the persona list is not needed.
    else switchChat(null, undefined, updateSettings);
  };
}

/** Each start of a chat, wherever chosen; a later one supersedes those still loading. */
let starts = 0;

/** Counts a new start; the check says whether it is still the latest. */
function newStart(): () => boolean {
  starts += 1;
  const start = starts;
  return () => start === starts;
}

/**
 * Starting a chat with a character: immediate when the chat is empty or
 * already with that character; otherwise it asks first, since switching
 * clears the chat (nothing of it is kept). While memory is on for the
 * current chat's character and its ending is unremembered, the dialog
 * offers to remember the ending first, open until it is written.
 */
export function useStartChat() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateSettings = useUpdateSettings();
  const [pending, setPending] = useState<{ id: string | null; name: string } | null>(null);

  const begin = async (id: string | null) => {
    const latest = newStart();
    const decided = chatStore.getState();
    const personas = await queryClient.ensureQueryData(personasQuery).catch(() => undefined);
    // Chosen again, written to or cleared while the persona list loaded: the owner moved on, and that stands.
    if (!latest()) return;
    const now = chatStore.getState();
    if ((contentChangedSince(decided, now) && hasChatContent(now)) || now.epoch !== decided.epoch)
      return;
    switchChat(id, personas, updateSettings);
    void navigate({ to: "/" });
  };

  const start = (id: string | null, name: string) => {
    if (currentSettings().characterId === id) {
      void navigate({ to: "/" });
    } else if (hasChatContent(chatStore.getState())) {
      setPending({ id, name });
    } else {
      void begin(id);
    }
  };

  const startNew = () => {
    if (pending !== null) void begin(pending.id);
    setPending(null);
  };

  const dialog = (
    <DiscardChatDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      proceed={startNew}
      title={
        pending?.id === null
          ? "Start a new chat without a character?"
          : `Start a new chat with ${pending?.name}?`
      }
      description={{
        remembering: "The current chat is cleared from this tab and never saved.",
        plain: "The current chat is cleared from this tab. Nothing from it is saved.",
      }}
      labels={{
        remember: "Remember and start new",
        without: "Start new without remembering",
        confirm: "Start new chat",
      }}
    />
  );

  return { start, dialog };
}
