import type { ArtRun } from "./art-slice.ts";

/*
 * What the screen says while portraits are made, for the first batch and
 * for New art alike, or while a scene's one picture is: the stage, a count
 * where the stage has one, the frame's line, and after a silence who the run
 * waits for. A silence is measured from the last word the run sent, so a
 * live run never shows one.
 */

/** What a run makes: the creator's four portraits, or a scene's one picture. */
type ArtNoun = "portraits" | "picture";

/** The run's noun in each phrase that names it; only the portraits are counted as they arrive. */
const NOUNS = {
  portraits: { the: "the portraits", onTheirWay: "The portraits are still on their way." },
  picture: { the: "the picture", onTheirWay: "The picture is still on its way." },
} as const;

interface ArtProgress {
  /** What is happening now. */
  label: string;
  /** Sampling steps, portraits received, or the run's place in a busy worker's waiting list. */
  detail?: string;
  /** The frame's line: a measured fraction, or `pending` while the stage has no measure. */
  line?: number | "pending";
  /** Said once `after` ms pass without word from the run. */
  quiet?: { text: string; after: number };
}

/** The progress of a run in flight; null when nothing is on its way. */
export function artProgress(art: ArtRun | null, noun: ArtNoun = "portraits"): ArtProgress | null {
  const words = NOUNS[noun];
  if (art?.status === "waiting") return { label: "Waiting for you to sign in" };
  if (art?.status !== "running") return null;
  const { value, max } = art;
  switch (art.phase) {
    case "status":
      return {
        label: "Checking ComfyUI",
        line: "pending",
        quiet: { text: "ComfyUI is slow to answer.", after: 10_000 },
      };
    case "prompt":
      // Written: the server hands it to ComfyUI.
      return value < max
        ? {
            label: "Writing the image prompt",
            line: "pending",
            quiet: { text: "Still waiting for the model.", after: 30_000 },
          }
        : {
            label: "Sending it to ComfyUI",
            line: "pending",
            quiet: { text: "ComfyUI is slow to answer.", after: 15_000 },
          };
    case "starting":
      return {
        label: "ComfyUI is starting up",
        line: "pending",
        quiet: { text: "ComfyUI is taking a while to start.", after: 30_000 },
      };
    case "busy":
      // Atelier's waiting list says the run's place when it knows it; a new place counts as word from the run.
      return {
        label: "ComfyUI is busy with another job",
        ...(art.position === undefined
          ? {}
          : { detail: art.position === 1 ? "Next in line" : `Number ${art.position} in line` }),
        line: "pending",
        quiet: { text: "Still waiting for ComfyUI to free up.", after: 60_000 },
      };
    case "queued":
      return {
        label: "Waiting in ComfyUI's queue",
        line: "pending",
        quiet: { text: "ComfyUI has not started it yet.", after: 30_000 },
      };
    case "loading":
      return {
        label: "ComfyUI is getting ready",
        line: "pending",
        quiet: { text: "ComfyUI is taking a while to start.", after: 45_000 },
      };
    case "running":
      // After the last step ComfyUI decodes and sends the images; nothing measures that.
      return value < max
        ? {
            label: `Developing ${words.the}`,
            detail: `Step ${value} of ${max}`,
            line: max > 0 ? value / max : 0,
            quiet: { text: "No new step from ComfyUI for a while.", after: 20_000 },
          }
        : {
            label: `Finishing ${words.the}`,
            line: "pending",
            quiet: { text: words.onTheirWay, after: 30_000 },
          };
    case "decoding":
      return {
        label: `Decoding ${words.the}`,
        line: "pending",
        quiet: { text: words.onTheirWay, after: 30_000 },
      };
    case "sending":
      return {
        label: `Sending ${words.the}`,
        line: "pending",
        quiet: { text: words.onTheirWay, after: 30_000 },
      };
    case "receiving":
      // The four arrive moments apart; the line holds full rather than start over.
      return {
        label: `Receiving ${words.the}`,
        detail: `${value} of ${max}`,
        line: 1,
        quiet: { text: words.onTheirWay, after: 20_000 },
      };
  }
}
