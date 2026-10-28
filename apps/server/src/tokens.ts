import type { Counted } from "@ephemera/core";
import { countTokens, setMergeCacheSize } from "gpt-tokenizer/model/gpt-4o";

/*
 * Token estimates for prompt budgets, a chat's and every model call's. The
 * counted text is chat content: it is held only while it is counted.
 */

// The tokenizer's merge cache would keep pieces of counted text after the request
// ends; chat content lives only as long as its request (PRINCIPLES.md 1).
setMergeCacheSize(0);

/** Special-token text in cards or chat is counted as text, never refused. */
const COUNT_OPTIONS = { disallowedSpecial: new Set<string>() };
/**
 * Text is counted in pieces of this many characters: byte-pair merging is
 * quadratic on long unbroken runs, and a cut mid-word only adds a token or two
 * to an estimate that calibration corrects anyway.
 */
const COUNT_PIECE = 1_024;
/**
 * The reply's priming, which OpenAI's counting adds once to the messages it
 * counts; a message's own overhead leaves it out (`fitPrompt` says how often
 * a prompt counts it).
 */
export const PRIMING = countTokens([], COUNT_OPTIONS);
const overhead = new Map<string, number>();
/** A native message: its role's overhead and its text. */
export const countMessage = ({ role, content }: Counted) => {
  let tokens = overhead.get(role);
  if (tokens === undefined) {
    tokens = countTokens([{ role, content: "" }], COUNT_OPTIONS) - PRIMING;
    overhead.set(role, tokens);
  }
  return tokens + countText(content);
};

/** The tokens of text alone, without a message's overhead (a lorebook entry's, a created card's block). */
export const countText = (content: string) => {
  let tokens = 0;
  for (let at = 0; at < content.length; at += COUNT_PIECE) {
    tokens += countTokens(content.slice(at, at + COUNT_PIECE), COUNT_OPTIONS);
  }
  return tokens;
};
