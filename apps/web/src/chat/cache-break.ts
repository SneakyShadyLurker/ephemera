import type { InspectedPrompt } from "@ephemera/core";

type Prompt = Pick<InspectedPrompt, "model" | "messages">;
type Message = InspectedPrompt["messages"][number];

/** How much of the next prompt repeats the last one sent, and where it first differs. */
export interface CacheBreak {
  shared: {
    /** Whole messages equal to the last prompt's, from the start. */
    messages: number;
    /**
     * Tokens of the next prompt up to the first difference: the equal
     * messages, plus the differing message's tokens prorated by the
     * characters it shares. An estimate, like every count in the inspector.
     */
    tokens: number;
  };
  /**
   * The index in the next prompt of the first message that differs; equal to
   * its length when it ends before the last one did; null when every message
   * sent repeats and the next prompt only adds after them.
   */
  at: number | null;
}

const same = (a: Message, b: Message) => a.role === b.role && a.content === b.content;

/** The length of the common start of two strings. */
function commonStart(a: string, b: string): number {
  const end = Math.min(a.length, b.length);
  let at = 0;
  while (at < end && a[at] === b[at]) at++;
  return at;
}

/**
 * Where the next prompt first differs from the last one sent, message by
 * message on what goes upstream (role, speaker name, content). A provider's
 * prompt cache can at best reach that point. Prompts for different models
 * share no cache, so they compare to nothing. Pure presentation state: both
 * prompts are already in the tab's memory and nothing is kept.
 */
export function cacheBreak(sent: Prompt, next: Prompt): CacheBreak | null {
  if (sent.model !== next.model) return null;
  let at = 0;
  let tokens = 0;
  while (at < next.messages.length && at < sent.messages.length) {
    const ahead = next.messages[at];
    const before = sent.messages[at];
    if (ahead === undefined || before === undefined || !same(ahead, before)) break;
    tokens += ahead.tokens;
    at++;
  }
  const messages = at;
  // Everything sent repeats; the next prompt can only carry on past it.
  if (at === sent.messages.length) {
    return { shared: { messages, tokens }, at: null };
  }
  const ahead = next.messages[at];
  const before = sent.messages[at];
  // The differing message's own start can still match, when roles do.
  if (ahead !== undefined && before !== undefined && ahead.content.length > 0) {
    const sameHead = ahead.role === before.role;
    const chars = sameHead ? commonStart(ahead.content, before.content) : 0;
    tokens += Math.floor((ahead.tokens * chars) / ahead.content.length);
  }
  return { shared: { messages, tokens }, at };
}
