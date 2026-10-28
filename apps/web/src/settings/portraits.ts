import type { CreatorArtStatus, CreatorArtUnavailable } from "@ephemera/core";

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
