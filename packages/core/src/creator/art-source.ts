import { clipText } from "../card/limits.ts";
import { CREATOR_LIMITS as C } from "./limits.ts";
import { locationLine } from "./location.ts";
import {
  type AnswerBlock,
  descriptionBlocks,
  type ScenarioBlock,
  type SubjectTag,
} from "./parse.ts";
import type { CreatorKind } from "./schema.ts";

/*
 * The text the browser sends back for the art request: only what the art
 * metaprompt needs from the card in memory, never the whole card.
 */

const textOf = (blocks: AnswerBlock[], name: SubjectTag | ScenarioBlock): string =>
  blocks.find((block) => block.name === name)?.text ?? "";

let sentences: Intl.Segmenter | undefined;

/** The first `count` sentences of a text, for a line or two of context. */
export function leadingSentences(text: string, count: number): string {
  sentences ??= new Intl.Segmenter("en", { granularity: "sentence" });
  const kept: string[] = [];
  for (const { segment } of sentences.segment(text)) {
    if (kept.length === count) break;
    kept.push(segment.trim());
  }
  return kept.join(" ");
}

export const tagged = (name: string, text: string): string => `<${name}>\n${text}\n</${name}>`;

/**
 * A character's looks: its appearance, with its background's first sentence
 * for age and home and its bounded personality for expression and posture.
 */
const character = (block: AnswerBlock): string =>
  tagged(
    block.name,
    [
      tagged("background", leadingSentences(textOf(block.blocks, "backgroundstory"), 1)),
      tagged("appearance", textOf(block.blocks, "appearance")),
      tagged(
        "temperament",
        clipText(textOf(block.blocks, "personality").trim(), C.artPersonalityLength),
      ),
    ].join("\n"),
  );

/**
 * Subject and Group: each subject's looks. Scenario: the card's title, which
 * its cover letters like a movie poster, the premise (the first line of
 * Roleplay), the first three sentences of Setting (era and place, leaving out
 * society, rules and daily life, which a photograph cannot show), People
 * whole, since it holds no fixed characters and its people's looks lead
 * People, and the first two sentences of Tone (genre and mood). Every
 * source starts with the opening's (firstMessage) Location line, whose place and
 * time the image shows, so the clip never reaches it; an opening without one
 * sends none.
 */
export function artSource(
  kind: CreatorKind,
  description: string,
  opening: string,
  title = "",
): string {
  const blocks = descriptionBlocks(description);
  const parts =
    kind !== "scenario"
      ? blocks.map(character)
      : [
          tagged("Premise", textOf(blocks, "Roleplay").split("\n")[0] ?? ""),
          tagged("Setting", leadingSentences(textOf(blocks, "Setting"), 3)),
          // A Scenario saved before People had its own block has none to send.
          ...(textOf(blocks, "People") === "" ? [] : [tagged("People", textOf(blocks, "People"))]),
          tagged("Tone", leadingSentences(textOf(blocks, "Tone"), 2)),
        ];
  const location = locationLine(opening);
  if (location !== "") parts.unshift(tagged("Location", location));
  return clipText([...scenarioTitle(kind, title), ...parts].join("\n\n"), C.artSourceLength);
}

/** A Scenario's title as its art source opens with it; nothing for other kinds or no title. */
export const scenarioTitle = (kind: CreatorKind, title: string): string[] =>
  kind === "scenario" && title.trim() !== "" ? [tagged("Title", title.trim())] : [];
