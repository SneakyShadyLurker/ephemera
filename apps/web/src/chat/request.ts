import type { ChatMemoryState, Clock, InspectedPrompt } from "@ephemera/core";
import type { ChatState, MacroSubject, ReplyFailure, Selection } from "./store.ts";

/** The next prompt's preview follows edits after this pause; it feeds the meter and the inspector. */
export const PREVIEW_DEBOUNCE_MS = 400;

export const sameSubject = (a: Selection, b: Selection) =>
  a.model === b.model &&
  a.samplerPresetId === b.samplerPresetId &&
  a.characterId === b.characterId &&
  a.personaId === b.personaId &&
  a.promptPresetId === b.promptPresetId;

/**
 * The request fields a selection, clock and the chat's pick seed and
 * lorebook state give; absent ids and no state are left out.
 */
export function selected(
  selection: Selection & { model: string },
  clock: Clock,
  chat: Pick<ChatState, "pickSeed" | "lorebookState" | "eventsState">,
  memoryState: ChatMemoryState | null,
) {
  const { model, samplerPresetId, reasoningEffort, promptPresetId, characterId, personaId } =
    selection;
  const { pickSeed, lorebookState, eventsState } = chat;
  return {
    model,
    ...(samplerPresetId === null ? {} : { samplerPresetId }),
    ...(reasoningEffort === null ? {} : { reasoningEffort }),
    ...(promptPresetId === null ? {} : { promptPresetId }),
    ...(characterId === null ? {} : { characterId }),
    ...(personaId === null ? {} : { personaId }),
    clock,
    pickSeed,
    ...(lorebookState === null ? {} : { lorebookState }),
    ...(eventsState === null ? {} : { eventsState }),
    ...(memoryState === null ? {} : { memoryState }),
  };
}

/** What an output's macros read: the model, window and reply tokens its prompt was built with, once it said them. */
export const sentWith = (
  subject: MacroSubject,
  prompt: InspectedPrompt | undefined,
): MacroSubject =>
  prompt === undefined
    ? subject
    : {
        ...subject,
        runtime: { model: prompt.model, window: prompt.window.tokens, reserve: prompt.reserve },
      };

/** The transport's error for a request the sign-in redirect answered. */
export const isSignedOut = (error: unknown) =>
  (error as { reason?: string }).reason === "signed_out";

/**
 * Why a request failed, from the transport's error: its `http`, `provider`,
 * `stream` and `unreadable` reasons, or none at all when `fetch` itself threw
 * (the server was never reached). Its other reasons say nothing more than "failed".
 */
export const failureOf = (error: unknown): ReplyFailure | undefined => {
  const reason = (error as { reason?: string }).reason;
  return reason === "http"
    ? "server"
    : reason === "provider" || reason === "stream" || reason === "unreadable"
      ? reason
      : reason === undefined
        ? "unreachable"
        : undefined;
};
