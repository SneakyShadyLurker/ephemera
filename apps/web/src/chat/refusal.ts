import type { RefusalCode } from "@ephemera/core";

const WINDOW_UNKNOWN = "the model has no known context window";

/** Why a reply was not sent, when the server would not build its prompt. */
export const REFUSAL_NOTE: Record<RefusalCode, string> = {
  context_window_unknown: `Not sent: ${WINDOW_UNKNOWN}. Set one in Settings, or choose another model.`,
  prompt_too_long:
    "Not sent: the preset's blocks, this message and the reply length don't fit the model's context window.",
};

/** Why Write for me was not sent, for the same refusals. */
export const IMPERSONATION_REFUSAL: Record<RefusalCode, string> = {
  context_window_unknown: `Write for me wasn't sent: ${WINDOW_UNKNOWN}.`,
  prompt_too_long: "Write for me wasn't sent: the prompt doesn't fit the model's context window.",
};
