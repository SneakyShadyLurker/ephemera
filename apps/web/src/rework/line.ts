import { andList, countOf, MODEL_BUSY } from "@/lib/text";
import { isFailure, type SaveStatus, saveStatusText } from "../sheet/autosave.ts";
import { invalidField, type ReworkState } from "./store.ts";

/*
 * What the rework's dock says in its one line, for each phase and ending.
 * Pure, so the words follow the state and the sheet's save status as they
 * are at render.
 */

export const changes = (n: number) => countOf(n, "change");

/** "Stopped. 3 changes arrived." and its kin. */
const arrived = (n: number) => (n === 0 ? "No changes arrived." : `${changes(n)} arrived.`);

/** What the dock's line says, and whether it is a failure. */
export interface Line {
  text: string;
  /** Said once through the status (or alert) node; the visible line may say more. */
  announce: string;
  failure: boolean;
}

/** Why the server refused the card as sent, naming the field its schema refuses when one does. */
function refusedText(state: Pick<ReworkState, "base">): string {
  const problem = state.base === null ? null : invalidField(state.base);
  if (problem === null) return "This card has a field Ephemera can't send as it is.";
  const how = problem.kind === "empty" ? "is empty" : "is over the limit";
  return `Ephemera can't send this card as it is: ${problem.field} ${how}.`;
}

/**
 * The line for `state`. `save` is the sheet's save status after Apply or
 * Undo, or null once the sheet saved what they wrote; `current` names the
 * change Previous and Next are on.
 */
export function lineOf(
  state: ReworkState,
  model: string | null,
  current: string | null,
  save: SaveStatus | null,
): Line {
  const placed = state.changes.filter((change) => change.ok);
  switch (state.phase) {
    case "waiting":
      return {
        text: "Not sent yet: waiting for you to sign in",
        announce: "Not sent yet: waiting for you to sign in.",
        failure: false,
      };
    case "working":
      return {
        text: `Reworking with ${model ?? "the model"}`,
        announce: `Reworking with ${model ?? "the model"}.`,
        failure: false,
      };
    case "applied": {
      const applied = state.applied;
      if (applied === null) return { text: "", announce: "", failure: false };
      let text = `Applied ${changes(applied.count)}.`;
      if (applied.undone !== null) {
        const { restored, skipped, kept } = applied.undone;
        const stayed = kept.length === 0 ? "" : `, so ${andList(kept)} stayed as applied`;
        const left =
          skipped.length === 0
            ? ""
            : ` ${andList(skipped)} ${skipped.length === 1 ? "was" : "were"} edited since${stayed}.`;
        text =
          skipped.length === 0
            ? `Undo restored ${changes(restored)}.`
            : `Undo restored ${restored} of ${changes(applied.count)}.${left}`;
      }
      if (save === null || save.kind === "saved") return { text, announce: text, failure: false };
      if (save.kind === "saving") return { text: `${text} Saving`, announce: text, failure: false };
      // Not saved, as the header says it: a failure in ember, signed out as expected.
      const unsaved = `${text} ${saveStatusText(save, false, "character")}.`;
      return { text: unsaved, announce: unsaved, failure: isFailure(save, false) };
    }
    default:
      break;
  }
  if (state.applyProblem !== null) {
    const { field, kind } = state.applyProblem;
    const text = `Apply would ${kind === "empty" ? `leave ${field} empty` : `make ${field} too long`}. Restore or reject a change in it.`;
    return { text, announce: text, failure: true };
  }
  if (state.ended === "stopped") {
    const text = `Stopped. ${arrived(state.changes.length)}`;
    return { text, announce: text, failure: false };
  }
  if (state.ended === "failed") {
    const text =
      state.failure === "invalid_request"
        ? refusedText(state)
        : state.failure === "upstream_busy"
          ? `${MODEL_BUSY} ${arrived(state.changes.length)}`
          : `The model stopped before it finished. ${arrived(state.changes.length)}`;
    return { text, announce: text, failure: true };
  }
  if (placed.length === 0) {
    const text =
      state.changes.length === 0
        ? "No changes suggested. Your character is unchanged."
        : "No change could be matched. Your character is unchanged.";
    return { text, announce: text, failure: false };
  }
  const fields = new Set(placed.map((change) => change.group)).size;
  const overview = `${changes(placed.length)} in ${countOf(fields, "field")}`;
  return { text: current ?? overview, announce: `${overview}.`, failure: false };
}
