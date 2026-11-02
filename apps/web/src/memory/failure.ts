import { MEMORY_LIMITS, RECAP_IDS } from "@ephemera/core";
import { formatCount } from "@/lib/text";
import { type SharedCallFailure, sharedCallFailure } from "../model-call.ts";
import { notReached } from "../signin/signin.ts";
import type { OpeningWriteFailure } from "./memory.ts";
import type { RememberFailure } from "./queries.ts";

/*
 * What a failed memory call says, on the seam and on the memory screen
 * alike, and the one way out each failure has: the call again, the Settings
 * that size it, or the memory screen to make room.
 */

/** Where a failure's way out leads. */
export type FailureAction = "retry" | "window" | "settings" | "memory" | null;

const NOT_WRITTEN = "The memory was not written";
/**
 * No answer came, so the memory may have been written: the call keeps its
 * attempt id and its turns stay read-only, and Try again sends it again,
 * which the server answers with the memory it wrote, or writes it now.
 */
const UNCONFIRMED = "Could not confirm the memory was written";
const RECOVERS = "Those turns stay read-only until confirmed. Try again recovers it.";

/** A shared failure after `subject`, with its way out. */
function shared(
  subject: string,
  reason: SharedCallFailure,
): { text: string; action: FailureAction } {
  const { words, action } = sharedCallFailure(reason, "memory");
  return { text: `${subject}: ${words}.`, action };
}

/** A failed memory call (`reason` null when the store kept none) in words, and its way out. */
export function failureNote(reason: RememberFailure | null): {
  text: string;
  action: FailureAction;
} {
  switch (reason) {
    case "unreachable":
      return { text: `${UNCONFIRMED}: ${notReached()}. ${RECOVERS}`, action: "retry" };
    case "signed_out":
      return { text: `${UNCONFIRMED}: you were signed out. ${RECOVERS}`, action: "retry" };
    case "timeout":
    case "upstream_busy":
    case "invalid":
    case "context_window_unknown":
    case "no_model":
      return shared(NOT_WRITTEN, reason);
    case "memory_failed":
      return { text: `${NOT_WRITTEN}: the memory model's answer failed.`, action: "retry" };
    case "prompt_too_long":
      return {
        text: `${NOT_WRITTEN}: these turns are too long for the memory model's context window.`,
        action: "settings",
      };
    case "too_large":
      return { text: `${NOT_WRITTEN}: these turns are too large to send.`, action: "settings" };
    case "too_many_memories":
      return {
        text: `${NOT_WRITTEN}: ${formatCount(MEMORY_LIMITS.episodes)} memories is the most a character keeps. Delete some to make room.`,
        action: "memory",
      };
    case "too_many_chat_memories":
      return {
        text: `${NOT_WRITTEN}: this chat already carries ${formatCount(RECAP_IDS)} memories, the most one chat holds. Delete some of them to make room.`,
        action: "memory",
      };
    case "memory_off":
      // Memory turned off resets the chat, so a refusal still shown came while memory reads on:
      // it moved under the call (Forget, or off and on again, elsewhere).
      return {
        text: `${NOT_WRITTEN}: the character's memory changed meanwhile.`,
        action: "retry",
      };
    case null:
      return { text: `${NOT_WRITTEN}.`, action: "retry" };
  }
}

const OPENING_NOT_WRITTEN = "The opening was not written";

/**
 * A failed opening call in words, and its way out, as `failureNote` says a
 * memory call's. Nothing was written either way, so no outcome is unconfirmed.
 */
export function openingFailureNote(reason: OpeningWriteFailure): {
  text: string;
  action: FailureAction;
} {
  const not = OPENING_NOT_WRITTEN;
  switch (reason) {
    case "unreachable":
    case "signed_out":
    case "timeout":
    case "upstream_busy":
    case "invalid":
    case "context_window_unknown":
    case "no_model":
      return shared(not, reason);
    case "memory_failed":
      return { text: `${not}: the memory model's answer failed.`, action: "retry" };
    case "too_large":
      return { text: `${not}: the request is too large to send.`, action: "retry" };
    case "memory_off":
      return { text: `${not}: the character's memory changed meanwhile.`, action: "retry" };
    case "prompt_too_long":
      return {
        text: `${not}: what is remembered is too long for the memory model's context window.`,
        action: "settings",
      };
    case "unsaved":
      return { text: `${not}: the notebook's edits must be saved first.`, action: "retry" };
    case "nothing_to_remember":
      return { text: `${not}: nothing is remembered yet to write it from.`, action: null };
  }
}

/** What each way out is called. */
export const FAILURE_ACTION_LABEL: Record<NonNullable<FailureAction>, string> = {
  retry: "Try again",
  window: "Set a context window",
  settings: "Memory settings",
  memory: "Open memory",
};
