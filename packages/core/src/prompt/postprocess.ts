import { type SpeakerNames, speakerOf } from "../chat.ts";
import {
  type Counted,
  type FitInput,
  type Fitted,
  fitPrompt,
  historyBlockTokens,
  memoizedCount,
  type SentMessage,
  selectedPrompt,
} from "./budget.ts";

/** Provider role shaping is configured per model and defaults off. Merged roles join with blank lines; semi-strict keeps leading system messages, strict ensures a user opening, and single names history speakers in text. Fitting counts the resulting wire messages. */

export const PROMPT_PROCESSING = ["none", "merge", "semiStrict", "strict", "single"] as const;
type PromptProcessing = (typeof PROMPT_PROCESSING)[number];

/** Native user-opening instruction for providers requiring strict role alternation. */
export const PROCESSING_PLACEHOLDER = "Continue the scene from the context above.";

interface ProcessOptions {
  /** `{{user}}` and `{{char}}`, for naming speakers in a single user message. */
  names: SpeakerNames;
  /** The tokens of a processed message, as the fit counts them. */
  count: (message: Counted) => number;
}

const SEPARATOR = "\n\n";

/** Folds consecutive messages of one role into one. */
function mergeRoles(messages: SentMessage[]): SentMessage[] {
  // Each run of one role is gathered first and joined once: linear however long the run.
  const runs: SentMessage[][] = [];
  for (const message of messages) {
    const run = runs.at(-1);
    if (run?.[0]?.role === message.role) run.push(message);
    else runs.push([message]);
  }
  return runs.map((run) => {
    const [first, ...rest] = run as [SentMessage, ...SentMessage[]];
    if (rest.length === 0) return first;
    return {
      ...first,
      content: run.map((message) => message.content).join(SEPARATOR),
      merged: [
        ...(first.merged ?? []),
        ...rest.flatMap((message) => [message.source, ...(message.merged ?? [])]),
      ],
    };
  });
}

/** Every system message after the leading ones is sent as the user's. */
function oneLeadingSystem(messages: SentMessage[]): SentMessage[] {
  const lead = messages.findIndex((message) => message.role !== "system");
  if (lead === -1) return messages;
  return messages.map((message, index) =>
    index >= lead && message.role === "system" ? { ...message, role: "user" } : message,
  );
}

/** Single-message provider formats need explicit attribution in history text. */
function attributed(
  message: SentMessage,
  names: ProcessOptions["names"],
  single = false,
): SentMessage {
  if (!single || message.source.kind !== "history" || message.historySpeaker?.prefixed)
    return message;
  const speaker = message.historySpeaker?.name ?? speakerOf({ role: message.role }, names);
  return { ...message, content: `${speaker}: ${message.content}` };
}

/** The processed messages, before their tokens are counted again. */
function reshape(
  sent: SentMessage[],
  mode: Exclude<PromptProcessing, "none">,
  names: ProcessOptions["names"],
): SentMessage[] {
  const messages = sent.map((message) => attributed(message, names, mode === "single"));
  switch (mode) {
    case "merge":
      return mergeRoles(messages);
    case "semiStrict":
      return mergeRoles(oneLeadingSystem(messages));
    case "strict": {
      const semi = oneLeadingSystem(messages);
      const first = semi.findIndex((message) => message.role !== "system");
      // A user message follows the leading system messages, even with no chat turn yet.
      if (semi[first]?.role !== "user") {
        semi.splice(first === -1 ? semi.length : first, 0, {
          role: "user",
          content: PROCESSING_PLACEHOLDER,
          source: { kind: "placeholder" },
          tokens: 0,
        });
      }
      return mergeRoles(semi);
    }
    case "single":
      return mergeRoles(
        messages.map((message) => ({
          ...message,
          role: "user" as const,
        })),
      );
  }
}

export function processPrompt(
  messages: SentMessage[],
  mode: PromptProcessing,
  { names, count }: ProcessOptions,
): SentMessage[] {
  if (mode === "none" || messages.length === 0) return messages;
  return reshape(messages, mode, names).map((message) => ({
    ...message,
    tokens: count(message),
  }));
}

/** Proportional cap hints before geometric reduction guarantees logarithmic progress. */
const FAST_ATTEMPTS = 3;

/**
 * Keeps the actual budget fixed and reduces explicit example/history caps,
 * examples first. A few proportional hints, then geometric reduction and
 * binary refinement bound candidate trials by O(log examples + log turns).
 * Actual selections are processed once per request; message counts are
 * memoized by content only for this call. Blocks keep the original budget's
 * boundaries, with an exact fallback. Before refusal, check the actual
 * minimum and Strict's shortest user-opening suffix independently of plain
 * selection costs. Arbitrary nonmonotonic token counters can still have
 * fitting intermediate selections that this bounded search does not visit.
 */
export function fitProcessed(
  input: Omit<FitInput, "blockTokens"> & {
    mode: PromptProcessing;
    names: ProcessOptions["names"];
  },
): Fitted {
  const { mode, names, ...fit } = input;
  if (mode === "none") return fitPrompt(fit);
  // Counted by role and text for this call only: a message processing passes through
  // reuses its plain count, and a merged one is counted once however many selections hold it.
  const plainCount = memoizedCount(fit.count);
  const history = fit.assembly.segments.find((segment) => segment.kind === "history");
  const count: ProcessOptions["count"] = (message) => plainCount(message) * fit.calibration;
  type Candidate = Extract<Fitted, { ok: true }>;
  const processed = new Map<string, Pick<Candidate, "messages" | "estimate">>();
  let refusal: Exclude<Fitted, { ok: true }> = {
    ok: false,
    reason: "prompt_too_long",
    estimate: 0,
  };
  const process = (fitted: Extract<Fitted, { ok: true }>): Candidate => {
    const key = `${fitted.examples.sent}/${fitted.history.sent}`;
    let result = processed.get(key);
    if (result === undefined) {
      const messages = processPrompt(fitted.messages, mode, { names, count });
      const estimate = Math.ceil(
        fitted.priming + messages.reduce((total, message) => total + message.tokens, 0),
      );
      result = { messages, estimate };
      processed.set(key, result);
    }
    if (result.estimate > fit.budget) refusal = { ...refusal, estimate: result.estimate };
    return { ...fitted, ...result };
  };
  const fitFrom = (blockTokens: number): Fitted => {
    const blocks = { blockTokens };
    const initial = fitPrompt({ ...fit, ...blocks, count: plainCount });
    if (!initial.ok) return initial;
    let current = process(initial);
    if (current.estimate <= fit.budget) return current;
    const trials = new Map<string, Candidate | null>();
    const tryFit = (caps: Pick<FitInput, "examplesCap" | "historyCap">): Candidate | null => {
      const key = `${caps.examplesCap ?? fit.examplesCap}/${caps.historyCap ?? fit.historyCap}`;
      if (trials.has(key)) return trials.get(key) ?? null;
      const fitted = fitPrompt({ ...fit, ...blocks, ...caps, count: plainCount });
      const candidate = fitted.ok ? process(fitted) : null;
      if (!fitted.ok) refusal = fitted;
      trials.set(key, candidate);
      return candidate;
    };
    const search = (
      axis: "examples" | "history",
      start: Candidate,
      minimum: number,
    ): Candidate | null => {
      const capped = (cap: number) =>
        tryFit(axis === "examples" ? { examplesCap: cap } : { examplesCap: 0, historyCap: cap });
      let cap = start[axis].sent;
      let high = cap;
      let estimate = start.estimate;
      for (let round = 0; cap > minimum; round += 1) {
        const next = Math.max(
          minimum,
          Math.min(
            cap - 1,
            round < FAST_ATTEMPTS
              ? Math.floor((cap * fit.budget) / Math.max(1, estimate))
              : minimum + Math.floor((cap - minimum) / 2),
          ),
        );
        const candidate = capped(next);
        if (candidate !== null && candidate.estimate <= fit.budget) {
          let best = candidate;
          let low = next;
          // Refine a fitting bracket; every step halves it, including selection plateaus.
          while (high - low > 1) {
            const middle = Math.floor((low + high) / 2);
            const refined = capped(middle);
            if (refined !== null && refined.estimate <= fit.budget) {
              best = refined;
              low = middle;
            } else high = middle;
          }
          return best;
        }
        cap = Math.min(next, candidate?.[axis].sent ?? next);
        high = cap;
        estimate = candidate?.estimate ?? estimate;
      }
      return null;
    };
    if (current.examples.sent > 0) {
      const examples = search("examples", current, 0);
      if (examples !== null) return examples;
      const withoutExamples = tryFit({ examplesCap: 0 });
      if (withoutExamples === null) return refusal;
      current = withoutExamples;
    }
    const minimum = (history?.turns.length ?? 0) > 0 ? 1 : 0;
    return search("history", current, minimum) ?? refusal;
  };
  const inBlocks = fitFrom(historyBlockTokens(fit.budget));
  if (inBlocks.ok) return inBlocks;
  const exact = fitFrom(0);
  if (exact.ok) return exact;
  const endpoint = (turns: number) =>
    process(
      selectedPrompt(
        fit.assembly,
        { turns, examples: 0 },
        count,
        fit.priming * fit.calibration,
        "exact",
      ),
    );
  const minimum = endpoint(1);
  if (minimum.estimate <= fit.budget) return minimum;
  const minimumRefusal = refusal;
  if (mode === "strict") {
    if (history !== undefined && history.turns.length > 0) {
      const index = history.turns.findLastIndex((turn) => turn.role === "user");
      const turns = history.turns.length - index;
      if (index >= 0 && turns <= (fit.historyCap ?? Number.POSITIVE_INFINITY)) {
        const opening = endpoint(turns);
        if (opening.estimate <= fit.budget) return opening;
      }
    }
  }
  return minimumRefusal;
}
