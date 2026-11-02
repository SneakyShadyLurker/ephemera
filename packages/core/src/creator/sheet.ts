import { blankCard, type SheetFields } from "../card/schema.ts";
import type { CreatorKind, GeneratedCard } from "./schema.ts";

/** The one tag a created card carries, set by its kind; the model writes none. */
export const CREATOR_TAGS: Readonly<Record<CreatorKind, string>> = {
  subject: "Subject",
  group: "Multiple Subjects",
  scenario: "Scenario",
};

/**
 * A generated card as the sheet's fields for Keep: the description carries
 * the blocks, the card opens on its one greeting, and every other field is
 * `blankCard`'s. The kind is kept only as the card's tag; the model is not
 * stored.
 */
export function toSheetFields(kind: CreatorKind, card: GeneratedCard): SheetFields {
  return {
    ...blankCard(card.name),
    description: card.description,
    firstMessage: card.firstMessage,
    creatorNotes: card.creatorNotes,
    tags: [CREATOR_TAGS[kind]],
  };
}
