import { LEGACY_BLOCKS, type LegacyBlock } from "../card/fold.ts";
import { type AnswerBlock, descriptionBlocks } from "./parse.ts";

const isLegacy = (name: string): name is LegacyBlock =>
  (LEGACY_BLOCKS as readonly string[]).includes(name);

/**
 * Complete legacy blocks among `blocks`. The parser runs an unclosed tag to
 * the end of the text; here it encloses nothing, so the blocks scanned
 * inside it count as if it were not there. The parser's depth bound
 * (BLOCK_DEPTH) still applies, so blocks behind more than three unclosed
 * tags in a row go unseen; that bound keeps hostile text linear to scan.
 */
const topLevel = (blocks: AnswerBlock[]): LegacyBlock[] =>
  blocks.flatMap((block) => {
    if (block.state === "incomplete") return topLevel(block.blocks);
    return isLegacy(block.name) ? [block.name] : [];
  });

/** The legacy blocks a description holds at its top level, in description order; [] when none. */
export const legacyBlocks = (description: string): LegacyBlock[] =>
  topLevel(descriptionBlocks(description));
