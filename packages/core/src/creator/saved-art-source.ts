import { clipText } from "../card/limits.ts";
import type { SheetFields } from "../card/schema.ts";
import { sameTag } from "../card/tags.ts";
import { artSource, leadingSentences, scenarioTitle, tagged } from "./art-source.ts";
import { CREATOR_LIMITS as C } from "./limits.ts";
import { locationLine } from "./location.ts";
import { characterProblems, descriptionOutline, savedScenarioLayout } from "./parse.ts";
import { type CreatorKind, creatorKindSchema } from "./schema.ts";
import { CREATOR_TAGS } from "./sheet.ts";

/*
 * The art source for a saved character's new art: the creator's own source
 * when the description is a card format the creator writes, otherwise the
 * card's prose, quoted as written for the metaprompt to read the looks from.
 */

/** Most prose the structured path allows outside a description's blocks. */
const OUTSIDE_LENGTH = 200;
/** The opening's share of a prose source, for a card whose looks live in its greeting. */
const OPENING_LENGTH = 1_500;

/** The kind a saved card's tags name, as `toSheetFields` wrote them; null when none does. */
export function taggedCardKind(tags: readonly string[]): CreatorKind | null {
  for (const tag of tags) {
    const kind = creatorKindSchema.options.find((kind) => sameTag(CREATOR_TAGS[kind], tag));
    if (kind !== undefined) return kind;
  }
  return null;
}

/** The kind a saved card's tags name; Subject when none does. */
export const savedCardKind = (tags: readonly string[]): CreatorKind =>
  taggedCardKind(tags) ?? "subject";

/** Whether the description is wholly in the format the creator writes for `kind`. */
function structured(kind: CreatorKind, description: string): boolean {
  const { blocks, outside } = descriptionOutline(description);
  if (outside.length >= OUTSIDE_LENGTH) return false;
  if (kind === "scenario") return savedScenarioLayout(blocks);
  return blocks.length > 0 && blocks.every((block) => characterProblems(block).length === 0);
}

/**
 * A creator-shaped card yields `artSource` unchanged. Any other card yields
 * the opening's Location line, the description and personality (bounded),
 * two sentences of scenario, and, without a Location line, up to three of
 * the opening. All four fields blank yields "". A Scenario's cover takes the
 * card's `title` first; a scene passes none, since it letters nothing.
 */
export function savedCardArtSource(
  kind: CreatorKind,
  card: Pick<SheetFields, "description" | "personality" | "scenario" | "firstMessage">,
  title = "",
): string {
  if (structured(kind, card.description)) {
    return artSource(kind, card.description, card.firstMessage, title);
  }
  const location = locationLine(card.firstMessage);
  const parts: [string, string][] = [
    ["Location", location],
    ["description", clipText(card.description.trim(), C.savedDescriptionLength)],
    ["temperament", clipText(card.personality.trim(), C.artPersonalityLength)],
    ["premise", leadingSentences(card.scenario, 2)],
    [
      "opening",
      location === "" ? clipText(leadingSentences(card.firstMessage, 3), OPENING_LENGTH) : "",
    ],
  ];
  const given = parts.filter(([, text]) => text !== "").map(([name, text]) => tagged(name, text));
  if (given.length === 0) return "";
  return clipText([...scenarioTitle(kind, title), ...given].join("\n\n"), C.artSourceLength);
}
