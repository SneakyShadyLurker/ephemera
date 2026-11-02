import { type LegacyBlock, reworkCardSchema } from "@ephemera/core";
import { andList } from "@/lib/text";
import type { ReworkState } from "./store.ts";

/**
 * The sheet's offer to rework a card whose description holds blocks folded
 * in from an older card format (LegacyBlocksNotice).
 */

/** What the offer asks Rework for, written into an empty request. */
export const OFFER_REQUEST =
  "Convert the folded <scenario>, <personality>, <example_dialogue> and <instructions> blocks at the end of the description into the card's layout, and remove them from the description.";

const LABELS: Record<LegacyBlock, string> = {
  scenario: "Scenario",
  personality: "Personality",
  example_dialogue: "Example dialogue",
  instructions: "Instructions",
};

/** The labels of the blocks found, in description order, each once. */
export const legacyBlockLabels = (blocks: readonly LegacyBlock[]): string[] => [
  ...new Set(blocks.map((block) => LABELS[block])),
];

/** The offer's sentence for the blocks labelled `labels` (at least one). */
export const offerText = (labels: readonly string[]): string =>
  labels.length === 1
    ? `The ${labels[0]} block was folded in from an older card format. Rework can rewrite it into the card's layout.`
    : `${andList(labels)} blocks were folded in from an older card format. Rework can rewrite them into the card's layout.`;

/** Whether Rework's request takes `description`: its schema bounds the text (CARD_LIMITS.textLength). */
export const fitsRework = (description: string): boolean =>
  reworkCardSchema.shape.description.safeParse(description).success;

/** Writes the offer's request into an empty one; a request the owner typed is kept. */
export function prefillOffer(state: Pick<ReworkState, "request" | "setRequest">): void {
  if (state.request.trim() === "") state.setRequest(OFFER_REQUEST);
}
