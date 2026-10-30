import {
  type ArtFamily,
  type CreatorArtStatus,
  type CreatorArtUnavailable,
  WORKFLOW_LIMITS,
  workflowNameSchema,
} from "@ephemera/core";
import { countOf } from "@/lib/text";

const UNAVAILABLE: Record<CreatorArtUnavailable, string> = {
  not_allowed:
    "This server no longer allows this address. Only origins in its COMFYUI_ALLOWED_ORIGINS can be used.",
  unreachable: "ComfyUI did not answer at this address.",
  insecure: "A token is set, so the address must use https: the token is only sent over https.",
  unauthorized: "ComfyUI refused the token. Check COMFYUI_API_KEY in the server's environment.",
  not_ready: "The private worker answered but is not ready yet.",
  invalid_response: "Something answered at this address, but not the way ComfyUI does.",
};

/** One status line: whether portraits can be made, in plain words, and the names of what is missing. */
interface PortraitStatusLine {
  tone: "ready" | "off" | "problem";
  text: string;
  /** Node classes and model files the chosen workflow needs that ComfyUI lacks. */
  missing: { nodes: string[]; models: string[] } | null;
}

export function portraitStatusLine(status: CreatorArtStatus): PortraitStatusLine {
  switch (status.state) {
    case "off":
      return {
        tone: "off",
        text: "Off. Add a ComfyUI address to make portraits for cards written with AI.",
        missing: null,
      };
    case "ready":
      return {
        tone: "ready",
        text: "Ready. Cards written with AI get four portraits to choose from.",
        missing: null,
      };
    case "unavailable":
      return { tone: "problem", text: `Unavailable. ${UNAVAILABLE[status.reason]}`, missing: null };
    case "missing":
      return {
        tone: "problem",
        text: "Unavailable. ComfyUI lacks parts the chosen workflow needs.",
        missing: { nodes: status.nodes, models: status.models },
      };
  }
}

/** The short form the create screen shows beside the model. */
export const portraitStatusLabel = (status: CreatorArtStatus): string =>
  status.state === "ready"
    ? "Portraits available"
    : status.state === "off"
      ? "Portraits off"
      : "Portraits unavailable";

/** A family on screen: always text, never a badge. */
export const FAMILY_NAMES: Record<ArtFamily, string> = {
  krea2: "Krea 2",
  moss: "MOSS",
  general: "General",
};

/** The dot's tone, shared with every other status dot. */
export type StatusTone = "ready" | "off" | "problem" | "unknown";

/** One workflow row's status: the dot, the words beside it and what hangs under the row. */
interface WorkflowStatus {
  tone: StatusTone;
  words: "Ready" | "Checking" | "Missing requirements" | "Unavailable" | "Unchecked";
  missing: { nodes: string[]; models: string[] } | null;
  /** Why ComfyUI is unavailable, in plain words. */
  reason: string | null;
}

/**
 * A row's status from its `artStatusQuery`: still asking ("checking"), not
 * answered ("failed"), or the answer. No saved address reads "Unchecked" too.
 */
export function workflowStatus(status: CreatorArtStatus | "checking" | "failed"): WorkflowStatus {
  const none = { missing: null, reason: null };
  if (status === "checking") return { tone: "unknown", words: "Checking", ...none };
  if (status === "failed") return { tone: "off", words: "Unchecked", ...none };
  switch (status.state) {
    case "off":
      return { tone: "off", words: "Unchecked", ...none };
    case "ready":
      return { tone: "ready", words: "Ready", ...none };
    case "unavailable":
      return {
        tone: "problem",
        words: "Unavailable",
        missing: null,
        reason: UNAVAILABLE[status.reason],
      };
    case "missing":
      return {
        tone: "problem",
        words: "Missing requirements",
        missing: { nodes: status.nodes, models: status.models },
        reason: null,
      };
  }
}

export const nodeCount = (nodes: number): string => countOf(nodes, "node");

/**
 * Why a name is refused, by core's name rule and against the user's other
 * workflow names, in the row's rename and the import panel; null when it may be saved.
 */
export function renameProblem(name: string, others: readonly string[]): string | null {
  const next = name.trim();
  if (next === "") return "Give the workflow a name.";
  if (!workflowNameSchema.safeParse(next).success) {
    return next.length > WORKFLOW_LIMITS.nameLength
      ? `Keep the name to ${WORKFLOW_LIMITS.nameLength} characters.`
      : "Leave control characters out of the name.";
  }
  const lower = next.toLowerCase();
  return others.some((other) => other.toLowerCase() === lower) ? nameTakenLine(next) : null;
}

/** A name another of the user's workflows has, in the tab's check or the server's. */
export const nameTakenLine = (name: string): string =>
  `You already have a workflow called ${name}.`;

/** Said once after the workflow Create with AI used was deleted. */
export const deletedLine = (name: string, fallback: string): string =>
  `${name} was deleted; back to ${fallback}.`;

export const WORKFLOWS_FULL = `${WORKFLOW_LIMITS.workflows} workflows is the most Ephemera keeps. Delete one to import another.`;

export const EMPTY_WORKFLOWS =
  "Nothing of yours yet. Import a workflow from ComfyUI and it appears here, ready to paint.";

export const listFailedLine = (notReached: string): string =>
  `The list could not be refreshed: ${notReached}.`;
