import type { CardProblem, CardSection } from "@ephemera/core";
import { andList, MODEL_BUSY, sentence } from "@/lib/text";
import { blockTitle } from "./sections.ts";
import type { CardRun, CardStatus } from "./store.ts";

/*
 * What the Writing screen says once writing ended without a card, in the
 * interface's voice: what went wrong, and what to do about it.
 */

/** The note for each ending without a card; a failed or invalid card may say more below. */
const END_NOTE: Partial<Record<CardStatus, string>> = {
  stopped: "Stopped. What was written is kept, but the card is incomplete.",
  failed: "The model stopped before the card was complete. Rewrite to try again.",
  invalid: "The card came back without the expected sections. Rewrite to try again.",
  waiting: "Not sent yet: waiting for you to sign in.",
};

/** Failures with a cause of their own; the others read as the model stopping. */
const FAILURE_NOTE: Partial<Record<NonNullable<CardRun["failure"]>, string>> = {
  cut: "The model ran out of room before the card was complete. Rewrite to try again, or choose a lower reasoning effort.",
  filtered:
    "The provider's filter stopped this card. Rewrite to try again, or choose another model.",
  too_large:
    "The description is too long for this model's context window. Shorten it, or choose another model.",
  upstream_busy: MODEL_BUSY,
};

/** A section as the card shows it. */
const SECTION: Record<CardSection, string> = {
  name: "name",
  description: "description",
  firstMessage: "opening",
  creatorNotes: "tagline",
};

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number) => NUMBERS[n] ?? String(n);

/** How many problems the note names; the rest are counted. */
const NAMED = 3;

/** One problem as a clause, as the owner reads the card. */
function clause(problem: CardProblem): string {
  switch (problem.code) {
    case "missing":
    case "incomplete":
    case "too_long": {
      const verb = {
        missing: "is missing",
        incomplete: "was left unfinished",
        too_long: "is longer than a card allows",
      }[problem.code];
      return `the ${SECTION[problem.section]} ${verb}`;
    }
    case "subject_count": {
      if (problem.count === 0) return "no characters were written";
      const written = `${count(problem.count)} ${problem.count === 1 ? "character was" : "characters were"} written`;
      return problem.min === problem.max
        ? `${written} where only ${count(problem.max)} fits`
        : problem.count < problem.min
          ? `${written} where at least ${count(problem.min)} belong`
          : `${written} where at most ${count(problem.max)} fit`;
    }
    case "block_name":
      return `the character “${problem.block}” has a name the card cannot use`;
    case "block_tags":
      return `${blockTitle(problem.block)} is missing a part or has them out of order`;
    case "scenario_blocks":
      return "the description is not just its Roleplay, Setting, People and Tone, in that order";
  }
}

/** What an invalid card lacks, in a sentence or two, and what to do. */
export function problemsNote(problems: CardProblem[]): string {
  const clauses = [...new Set(problems.map(clause))];
  if (clauses.length === 0) return END_NOTE.invalid ?? "";
  const named = andList(clauses.slice(0, NAMED));
  const rest = clauses.length - NAMED;
  const more =
    rest <= 0
      ? ""
      : rest === 1
        ? " One more thing is off."
        : ` ${sentence(count(rest))} more things are off.`;
  return `${sentence(named)}.${more} Rewrite to try again.`;
}

/** The note under a card that ended without being complete; none while writing or once complete. */
export function endNote(run: Pick<CardRun, "status" | "failure" | "problems">): string | null {
  if (run.status === "invalid") return problemsNote(run.problems);
  if (run.status === "failed" && run.failure !== null) {
    return FAILURE_NOTE[run.failure] ?? END_NOTE.failed ?? null;
  }
  return END_NOTE[run.status] ?? null;
}
