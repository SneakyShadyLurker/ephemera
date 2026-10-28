import {
  BUILT_IN_NAMES,
  type BuiltInBlock,
  blockOrder,
  blockRole,
  castAnchorsPlace,
  compareInChat,
  GENERATION_TYPES,
  type GenerationType,
  isPlaceable,
  OPTIONAL_BLOCKS,
  type Placeable,
  PRESET_LIMITS,
  type PromptBlock,
} from "@ephemera/core";

/*
 * The editor's rules for a prompt preset's blocks. The stored array is the
 * running order; blocks placed inside the chat keep a depth instead, and sit
 * in the chat history's band in the order they are sent (ties in list
 * order). Custom blocks, the main prompt, the post-history instructions and
 * the source blocks prompt assembly places by role and depth can go inside
 * the chat; the lorebook and example dialogue blocks always send at their
 * place in the order.
 */

/** Where each source block's text comes from; the blocks' names are core's `BUILT_IN_NAMES`. */
export const BLOCK_SOURCE: Partial<Record<BuiltInBlock, string>> = {
  lorebookBefore: "From the character's lorebook",
  personaDescription: "From your persona",
  charDescription: "From the character",
  charPersonality: "From the character",
  scenario: "From the character",
  castAnchors: "From the chat's cast register",
  lorebookAfter: "From the character's lorebook",
  dialogueExamples: "From the character",
};

export const blockName = (block: PromptBlock) =>
  block.kind === "custom" ? block.name : BUILT_IN_NAMES[block.id];

/** A block inside the chat: placeable, with a depth (absent or null keeps it in the order). */
export const isInChat = (block: PromptBlock): block is Placeable =>
  isPlaceable(block) && block.depth !== undefined && block.depth !== null;

/** The blocks sent in list order, the chat history among them. */
export const runningOrder = (blocks: PromptBlock[]): PromptBlock[] =>
  blocks.filter((block) => !isInChat(block));

const place = (block: Placeable) => ({
  depth: block.depth ?? 0,
  order: blockOrder(block),
  role: blockRole(block),
});

/** The blocks inside the chat, from the oldest messages to the latest, as they are sent. */
export const inChat = (blocks: PromptBlock[]): Placeable[] =>
  blocks
    .filter(isInChat)
    .map((block, index) => ({ block, index }))
    .sort((a, b) => compareInChat(place(a.block), place(b.block)) || a.index - b.index)
    .map(({ block }) => block);

/*
 * Moves and inserts change the stored list in place: blocks inside the chat keep their stored places, so a built-in one
 * set back in the order returns where it was among the others.
 */

/** `block` placed just before (`after` false) or just after the running block `anchorId`. */
function placeBy(
  blocks: PromptBlock[],
  block: PromptBlock,
  anchorId: string,
  after: boolean,
): PromptBlock[] {
  const rest = blocks.filter((candidate) => candidate.id !== block.id);
  const at = rest.findIndex((candidate) => candidate.id === anchorId);
  if (at < 0) return blocks;
  rest.splice(after ? at + 1 : at, 0, block);
  return rest;
}

/** One place earlier (-1) or later (1) in the running order; unchanged at the ends. */
export function moveInOrder(blocks: PromptBlock[], id: string, step: -1 | 1): PromptBlock[] {
  const order = runningOrder(blocks);
  const from = order.findIndex((block) => block.id === id);
  const block = order[from];
  const neighbour = order[from + step];
  if (block === undefined || neighbour === undefined) return blocks;
  return placeBy(blocks, block, neighbour.id, step === 1);
}

/** Moves a block to just before another in the running order. */
export function moveBefore(blocks: PromptBlock[], id: string, beforeId: string): PromptBlock[] {
  const order = runningOrder(blocks);
  const block = order.find((candidate) => candidate.id === id);
  if (block === undefined || id === beforeId) return blocks;
  if (!order.some((candidate) => candidate.id === beforeId)) return blocks;
  return placeBy(blocks, block, beforeId, false);
}

/**
 * A block's place: inside the chat at a depth, or back in the order. A custom
 * block returns just above the chat history; a built-in one stays where it is
 * in the list, so an imported place among the other built-ins survives.
 */
export function setPlace(blocks: PromptBlock[], id: string, depth: number | null): PromptBlock[] {
  const index = blocks.findIndex((candidate) => candidate.id === id);
  const block = blocks[index];
  if (block === undefined || !isPlaceable(block)) return blocks;
  const placed: Placeable = { ...block, depth };
  if (block.kind !== "custom") return blocks.map((other) => (other.id === id ? placed : other));
  const others = blocks.filter((candidate) => candidate.id !== id);
  if (depth !== null) return [...others, placed];
  return insertBeforeHistory(others, placed);
}

/** An in-chat block's `injection_order`, within the imported range. */
export function setOrder(blocks: PromptBlock[], id: string, order: number): PromptBlock[] {
  const clamped = Math.min(PRESET_LIMITS.maxOrder, Math.max(-PRESET_LIMITS.maxOrder, order));
  return blocks.map((block) =>
    block.id === id && isPlaceable(block) ? { ...block, order: clamped } : block,
  );
}

function insertBeforeHistory(blocks: PromptBlock[], block: PromptBlock): PromptBlock[] {
  const history = blocks.find((candidate) => candidate.kind === "chatHistory");
  if (history !== undefined) return placeBy([...blocks, block], block, history.id, false);
  // Without a chat history: after the last block in the order.
  const last = runningOrder(blocks).at(-1);
  if (last === undefined) return [block, ...blocks];
  return placeBy([...blocks, block], block, last.id, true);
}

/** The generation types a block is sent for; none listed means every one. */
export function setTriggers(
  blocks: PromptBlock[],
  id: string,
  triggers: GenerationType[],
): PromptBlock[] {
  // Kept in the shared generation-type order, each once.
  const listed = GENERATION_TYPES.filter((type) => triggers.includes(type));
  return blocks.map((block) =>
    block.id === id && isPlaceable(block) ? { ...block, triggers: listed } : block,
  );
}

/** One message earlier (1: further from the end) or later (-1), within 0 and the depth limit. */
export function shiftDepth(blocks: PromptBlock[], id: string, delta: 1 | -1): PromptBlock[] {
  return blocks.map((block) =>
    block.id === id && isInChat(block)
      ? {
          ...block,
          depth: Math.min(PRESET_LIMITS.maxDepth, Math.max(0, (block.depth ?? 0) + delta)),
        }
      : block,
  );
}

/** A new block goes after the open row in the order, or just above the chat history. */
export function insertCustom(
  blocks: PromptBlock[],
  block: PromptBlock,
  afterId: string | null,
): PromptBlock[] {
  const open = runningOrder(blocks).find((candidate) => candidate.id === afterId);
  if (open === undefined) return insertBeforeHistory(blocks, block);
  return placeBy([...blocks, block], block, open.id, true);
}

export function updateBlock(
  blocks: PromptBlock[],
  id: string,
  change: (block: PromptBlock) => PromptBlock,
): PromptBlock[] {
  return blocks.map((block) => (block.id === id ? change(block) : block));
}

/** Where an optional built-in block goes when added back: where assembly places it unasked. */
const OPTIONAL_PLACE: Partial<
  Record<BuiltInBlock, (blocks: PromptBlock[]) => readonly PromptBlock[]>
> = { castAnchors: castAnchorsPlace };

/** The optional built-in blocks the preset leaves out, each one the editor can add back. */
export const missingOptional = (blocks: PromptBlock[]): BuiltInBlock[] =>
  [...OPTIONAL_BLOCKS].filter(
    (id) => OPTIONAL_PLACE[id] !== undefined && !blocks.some((block) => block.id === id),
  );

/** The optional block `id` added back at its default place. */
export const addOptional = (blocks: PromptBlock[], id: BuiltInBlock): PromptBlock[] => [
  ...(OPTIONAL_PLACE[id]?.(blocks) ?? blocks),
];

export type Removed = { block: PromptBlock; index: number };

export function removeBlock(
  blocks: PromptBlock[],
  id: string,
): { blocks: PromptBlock[]; removed: Removed } {
  const index = blocks.findIndex((block) => block.id === id);
  const block = blocks[index];
  if (block === undefined) throw new Error("no such block");
  return { blocks: blocks.filter((candidate) => candidate.id !== id), removed: { block, index } };
}

export function restoreBlock(blocks: PromptBlock[], removed: Removed): PromptBlock[] {
  const next = [...blocks];
  next.splice(Math.min(removed.index, next.length), 0, removed.block);
  return next;
}
