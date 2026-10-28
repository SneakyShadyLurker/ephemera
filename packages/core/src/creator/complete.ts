import { ANY_TAG, type AnswerBlock } from "./parse.ts";
import type { CreatorKind, GeneratedCard } from "./schema.ts";

/*
 * The stricter bar a card written without the owner watching must clear
 * before it is kept automatically (an image-born card). The browser creator's
 * Keep does not use it: there the owner reads the card first.
 */

/** Empty once tags are set aside: `<x> </x>` holds no more than nothing does. */
const blank = (text: string): boolean => text.replace(ANY_TAG, "").trim() === "";

const emptyInner = (block: AnswerBlock, path: string): string[] =>
  block.blocks.filter((inner) => blank(inner.text)).map((inner) => `${path}.${inner.name}`);

/**
 * What a valid answer of `kind` leaves empty. Every kind: `creatorNotes`.
 * A Subject or Multiple Subjects card: `<block>.<inner>` for each empty inner
 * block of a subject. A Scenario: each of its blocks that is empty. An empty list means the card is complete.
 */
export function incompleteForAutomaticKeep(
  kind: CreatorKind,
  card: GeneratedCard,
  blocks: AnswerBlock[],
): string[] {
  const notes = card.creatorNotes.trim() === "" ? ["creatorNotes"] : [];
  if (kind !== "scenario") {
    return [...notes, ...blocks.flatMap((block) => emptyInner(block, block.name))];
  }
  return [...notes, ...blocks.filter((block) => blank(block.text)).map((block) => block.name)];
}
