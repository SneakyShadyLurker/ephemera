import { EXAMPLE_SEPARATOR } from "../prompt/examples.ts";
import type { LegacyStoredCharacterCard, StoredCharacterCard } from "./schema.ts";

/** The tagged blocks the removed card fields fold into, in fold order. */
export const LEGACY_BLOCKS = [
  "scenario",
  "personality",
  "example_dialogue",
  "instructions",
] as const;
export type LegacyBlock = (typeof LEGACY_BLOCKS)[number];

/** The five removed card fields. */
export interface LegacyFields {
  personality: string;
  scenario: string;
  exampleDialogue: string;
  systemPrompt: string;
  postHistoryInstructions: string;
}

const tagged = (tag: LegacyBlock, text: string): string => `<${tag}>\n${text}\n</${tag}>`;

/** The description with every non-empty legacy field appended as a tagged block. */
export function foldLegacyFields(description: string, legacy: LegacyFields): string {
  const instructions = [legacy.systemPrompt.trim(), legacy.postHistoryInstructions.trim()]
    .filter(Boolean)
    .join("\n\n");
  const texts: Record<LegacyBlock, string> = {
    scenario: legacy.scenario.trim(),
    personality: legacy.personality.trim(),
    example_dialogue: legacy.exampleDialogue
      .split(EXAMPLE_SEPARATOR)
      .map((passage) => passage.trim())
      .filter(Boolean)
      .join(EXAMPLE_SEPARATOR),
    instructions,
  };
  const blocks = LEGACY_BLOCKS.filter((tag) => texts[tag] !== "").map((tag) =>
    tagged(tag, texts[tag]),
  );
  if (blocks.length === 0) return description;
  const kept = description.trimEnd();
  return [...(kept === "" ? [] : [kept]), ...blocks].join("\n\n");
}

/** A version-1 stored card (or native v1 file data) as a current stored card, its removed fields folded. */
export function foldLegacyCard(card: LegacyStoredCharacterCard): StoredCharacterCard {
  const { personality, scenario, exampleDialogue, systemPrompt, postHistoryInstructions, ...rest } =
    card;
  return {
    ...rest,
    description: foldLegacyFields(card.description, {
      personality,
      scenario,
      exampleDialogue,
      systemPrompt,
      postHistoryInstructions,
    }),
  };
}
