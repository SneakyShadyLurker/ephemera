import { CREATOR_LIMITS } from "@ephemera/core";
import { MODEL_BUSY } from "@/lib/text";
import type { BrainstormSession } from "./brainstorm-slice.ts";

/*
 * What the brainstorm says about its round, in the interface's voice: the
 * status line while the ideas come and once they are in, and the alert when
 * they could not come, naming the way out.
 */

/** The quiet line while the list is written again after a short first answer. */
export const RETRY_NOTE = "The first list was missing ideas, so it is being written again.";

/** "1 idea", "7 ideas". */
const count = (n: number) => `${n} ${n === 1 ? "idea" : "ideas"}`;

/** The status line for the session as it stands; empty while asking or once an alert speaks. */
export function ideasStatus(
  session: Pick<BrainstormSession, "status" | "thinking" | "incoming" | "options" | "arrived">,
): string {
  switch (session.status) {
    case "classifying":
      return "Reading your request";
    case "writing":
      return session.thinking && session.incoming.length === 0 ? "Thinking" : "Writing ideas";
    case "waiting":
      return "Not sent yet: waiting for you to sign in.";
    case "complete":
      return session.options.length >= CREATOR_LIMITS.brainstormOptions
        ? "Ten ideas."
        : `${count(session.options.length)} instead of ten. New ideas tries for the full ten.`;
    case "stopped":
      return session.arrived > 0
        ? `Stopped. ${count(session.arrived)} so far.`
        : "Stopped before any idea arrived.";
    default:
      return "";
  }
}

/** The model stopping, whatever stopped it. */
const STOPPED = "The model stopped before the ideas were done. New ideas to try again.";

const ALERT: Record<NonNullable<BrainstormSession["failure"]>, string> = {
  upstream: STOPPED,
  timeout: STOPPED,
  stream: STOPPED,
  upstream_busy: MODEL_BUSY,
  cut: "The model ran out of room before the ten were done. New ideas to try again, or choose a lower reasoning effort.",
  filtered:
    "The provider's filter stopped the ideas. New ideas to try again, or choose another model.",
  too_large:
    "The request and the earlier lists are too long for this model's context window. Start over, or choose another model.",
  kind_unclear: "This could be one person, several, or a place to go. Choose above.",
  unusable:
    "The ideas came back in a form the app cannot read. New ideas to try again, or choose another model.",
};

/** What a failed round says; none without a failure. */
export const ideasAlert = (failure: BrainstormSession["failure"]): string | null =>
  failure === null ? null : ALERT[failure];
