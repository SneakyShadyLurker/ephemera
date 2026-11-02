import type { PromptRole } from "../preset/index.ts";
import { estimateTokens } from "../tokens.ts";
import { type Assembly, flatten, type Kept, type PromptMessage } from "./assemble.ts";

/*
 * The prompt budget is the context window minus the reply reserve. Examples
 * fill the room left by the complete history,
 * block by block, and go entirely once any turn has to be left out; then the
 * oldest turns go. Fixed blocks, in-chat blocks and the latest turn always
 * stay; when they alone do not fit, nothing is sent.
 *
 * Native block trimming leaves the
 * oldest turns out a block at a time instead, so the retained start of the
 * chat stays put across turns until the history overflows again and the
 * provider's prefix cache keeps the rest warm. Block boundaries are fixed
 * from the chat's start by a UTF-8 byte estimate of the older turns alone, so
 * a growing fixed block, a calibration change, the draft or reasoning
 * dropping off a newer reply moves none of them, and history left out is
 * never tokenized for them. Blocks are sized from the prompt budget, so a
 * new reply reserve or context limit resizes them and moves the boundaries
 * once. They hold while the text of older turns is unchanged: an edit or a
 * deletion in an omitted turn can move later boundaries and so the retained
 * start once, and a variable macro (`{{random}}`, `{{time}}`) there, expanded
 * again for every request, can move them on every request while it stays in
 * the older history. Stateless: the same assembled input, budget and
 * calibration select the same turns, so a preview and its send agree. The
 * start moves about once per block of new chat and loses about one block; a
 * large append can skip several block starts at once. When a block is larger than the room for
 * history, the fit falls back to exact trimming within the newest block.
 */

/** Tokens kept for the reply when the sampler preset leaves its length to the model. */
export const DEFAULT_REPLY_RESERVE = 4_096;
const CALIBRATION = { min: 0.5, max: 2 } as const;

/** The share of the prompt budget one history block holds. */
export const HISTORY_BLOCK_SHARE = 1 / 8;

/** The tokens one history block holds for `budget`, by the boundary estimate. */
export const historyBlockTokens = (budget: number) =>
  Math.max(1, Math.floor(budget * HISTORY_BLOCK_SHARE));

/**
 * How history was trimmed: per message, in blocks, or per message within one
 * oversized block. Block mode also reports `exact` when `fitProcessed` had to
 * fit per message so as not to refuse.
 */
export const TRIMMINGS = ["exact", "blocks", "blocks-fallback"] as const;
type Trimming = (typeof TRIMMINGS)[number];

/**
 * Tokens kept free for the reply: the preset's reply length, or the default,
 * which never takes more than a quarter of a small window.
 */
export function replyReserve(maxOutputTokens: number | null, window: number): number {
  return maxOutputTokens ?? Math.min(DEFAULT_REPLY_RESERVE, Math.floor(window / 4));
}

/** Available prompt tokens: the window less the reply reserve. */
export function promptBudget(window: number, reserve: number): number {
  return Math.max(0, Math.floor(window - reserve));
}

/** How far the model's own count was from the estimate, bounded; 1 when unknown. */
export function calibrationRatio(counted: number, estimated: number): number {
  if (!(estimated > 0) || !(counted > 0)) return 1;
  return Math.min(CALIBRATION.max, Math.max(CALIBRATION.min, counted / estimated));
}

/** What a message costs: its role and text. */
export type Counted = { role: PromptRole; content: string };

/**
 * `count` remembered by role and text, for as long as the
 * returned counter is held: repeated fit attempts count each distinct message
 * once. Its caller drops it with the request, since the text is chat content.
 */
export function memoizedCount(count: (message: Counted) => number): (message: Counted) => number {
  const counts = new Map<PromptRole, Map<string, number>>();
  return (message) => {
    let byContent = counts.get(message.role);
    if (byContent === undefined) {
      byContent = new Map();
      counts.set(message.role, byContent);
    }
    let tokens = byContent.get(message.content);
    if (tokens === undefined) {
      tokens = count(message);
      byContent.set(message.content, tokens);
    }
    return tokens;
  };
}

export interface FitInput {
  assembly: Assembly;
  budget: number;
  /** An uncalibrated estimate of one message's tokens, its own overhead included. */
  count: (message: Counted) => number;
  /** The reply's priming is counted and calibrated once beside message costs. */
  priming: number;
  /** From `calibrationRatio`; 1 before the model has counted anything. */
  calibration: number;
  /** A positive history block size in boundary-estimate tokens; defaults to a share of the prompt budget. */
  blockTokens?: number;
  /**
   * The most history turns to keep, counted as `history.sent` counts them;
   * the latest turn stays regardless. A retry sets it below its last fit so
   * block trimming steps to an older block start.
   */
  historyCap?: number;
  /** The most example blocks to keep. */
  examplesCap?: number;
}

export type SentMessage = PromptMessage & { tokens: number };

export type Fitted =
  | {
      ok: true;
      messages: SentMessage[];
      /** Final wire estimate, including priming. */
      estimate: number;
      /** The priming counted into `estimate`, calibrated. */
      priming: number;
      history: { sent: number; total: number };
      examples: { sent: number; total: number };
      trimming: Trimming;
      lorebook: Assembly["lorebook"];
      lorebookState: Assembly["lorebookState"];
    }
  | { ok: false; reason: "prompt_too_long"; estimate: number };

/**
 * A turn's size by the boundary estimate: its role, name and content as
 * assembled, so ASCII runs four characters a token and CJK close to one.
 */
const boundaryTokens = (turn: PromptMessage) => estimateTokens(`${turn.role}${turn.content}`);

/**
 * The kept-turn counts, from the latest, at which a block starts. Turn 0
 * starts block 0; a later turn starts one where the estimate of the turns
 * before it crosses a multiple of `blockTokens`, so a boundary depends only
 * on the turns older than it.
 */
function blockStarts(turns: PromptMessage[], blockTokens: number): Set<number> {
  const starts = new Set([turns.length]);
  let before = 0;
  for (const [index, turn] of turns.entries()) {
    if (index === turns.length - 1) break;
    const previous = before;
    before += boundaryTokens(turn);
    if (Math.floor(before / blockTokens) > Math.floor(previous / blockTokens))
      starts.add(turns.length - index - 1);
  }
  return starts;
}

/** The assembly's one history segment's turns and one examples segment's blocks, empty when absent. */
function historyAndExamples(assembly: Assembly): {
  turns: PromptMessage[];
  blocks: PromptMessage[][];
} {
  const history = assembly.segments.find((segment) => segment.kind === "history");
  const examples = assembly.segments.find((segment) => segment.kind === "examples");
  return { turns: history?.turns ?? [], blocks: examples?.blocks ?? [] };
}

/** Counts and finalizes one explicit selection; its caller applies the actual wire budget. */
export function selectedPrompt(
  assembly: Assembly,
  kept: Kept,
  count: (message: PromptMessage) => number,
  priming: number,
  trimming: Trimming,
): Extract<Fitted, { ok: true }> {
  const sent = flatten(assembly, kept);
  const messages = sent.map((message) => ({ ...message, tokens: Math.round(count(message)) }));
  const estimate = Math.ceil(priming + sent.reduce((total, message) => total + count(message), 0));
  const delivery = assembly.lorebookDelivery;
  const lorebook = delivery?.finalize(
    new Set(sent.flatMap((message) => delivery.entries.get(message) ?? [])),
  ) ?? { lorebook: assembly.lorebook, lorebookState: assembly.lorebookState };
  const { turns, blocks } = historyAndExamples(assembly);
  const history = { sent: Math.min(kept.turns, turns.length), total: turns.length };
  const examples = { sent: Math.min(kept.examples, blocks.length), total: blocks.length };
  return { ok: true, messages, estimate, priming, history, examples, trimming, ...lorebook };
}

export function fitPrompt({
  assembly,
  budget,
  count,
  priming,
  calibration,
  blockTokens = historyBlockTokens(budget),
  historyCap = Number.POSITIVE_INFINITY,
  examplesCap = Number.POSITIVE_INFINITY,
}: FitInput): Fitted {
  const tokens = new Map<PromptMessage, number>();
  const cost = (message: PromptMessage) => {
    let value = tokens.get(message);
    if (value === undefined) {
      value = count(message) * calibration;
      tokens.set(message, value);
    }
    return value;
  };
  const { turns, blocks } = historyAndExamples(assembly);
  const maxTurns = turns.length;
  const primed = priming * calibration;
  // Injection placement changes order, not
  // the cost of these separate messages, so older turns can be added once.
  const minimum = Math.min(1, maxTurns);
  let used =
    primed +
    flatten(assembly, { turns: minimum, examples: 0 }).reduce(
      (total, message) => total + cost(message),
      0,
    );
  if (used > budget) return { ok: false, reason: "prompt_too_long", estimate: Math.ceil(used) };
  let keptTurns = minimum;
  let candidate = used;
  // With no turns there is nothing to trim, so the fit is the per-message one.
  const starts = blockTokens === 0 || maxTurns === 0 ? null : blockStarts(turns, blockTokens);
  /** The longest fitting suffix that starts a block, while the scan from the latest turn runs. */
  let block = starts?.has(minimum) ? { turns: minimum, used } : null;
  for (let n = minimum + 1; n <= maxTurns && n <= historyCap; n += 1) {
    const older = turns[maxTurns - n];
    if (older !== undefined) candidate += cost(older);
    if (candidate > budget) break;
    keptTurns = n;
    used = candidate;
    if (starts?.has(n)) block = { turns: n, used };
  }
  // No block start fits when the newest block is larger than the room for
  // history: the per-message fit within it stands, and its start can move each turn.
  const trimming: Trimming =
    starts === null ? "exact" : block === null ? "blocks-fallback" : "blocks";
  if (block !== null) {
    keptTurns = block.turns;
    used = block.used;
  }
  let keptExamples = 0;
  // Once the history no longer fits whole, it has filled the context: no examples.
  if (keptTurns === maxTurns) {
    candidate = used;
    for (const [index, block] of blocks.entries()) {
      if (index + 1 > examplesCap) break;
      candidate += block.reduce((total, message) => total + cost(message), 0);
      if (candidate > budget) break;
      keptExamples = index + 1;
    }
  }

  // A join can increase BPE cost. Check the final wire independently rather
  // than assuming joining always saves tokens. Both passes reuse counted turns.
  const selected = selectedPrompt(
    assembly,
    { examples: keptExamples, turns: keptTurns },
    cost,
    primed,
    trimming,
  );
  return selected.estimate > budget
    ? { ok: false, reason: "prompt_too_long", estimate: selected.estimate }
    : selected;
}
