import type { CharacterCard } from "../card/index.ts";
import { chatTextFiller, type FilledText, fillChatText, type MacroInput } from "./assemble.ts";
import type { MacroState } from "./macro-state.ts";
import { AggregateMacroLimitError, createMacroWorkBudget, MacroLimitError } from "./macros.ts";

/** The key of the memory's opening among a chat's greetings. */
export const MEMORY_GREETING = "memory";

/**
 * A greeting's identity among a chat's greetings, kept across refills: the
 * memory's opening, or the card's greeting at its place in
 * `[firstMessage, ...alternateGreetings]`.
 */
export type GreetingKey = typeof MEMORY_GREETING | `card:${number}`;

/** A greeting's raw text, before macros, and its key. */
interface GreetingCandidate {
  text: string;
  key: GreetingKey;
}

/** One greeting filled for a new chat, with the text written for it. */
interface FilledGreeting {
  content: string;
  macroState: MacroState;
  rawText: string;
  key: GreetingKey;
}

/**
 * Every greeting a new chat may open on, blank ones included: the memory's
 * `opening` first when it has any text, then the card's first message and
 * its alternates. The one list both the choices and their raw text index.
 */
export function greetingCandidates(
  character: CharacterCard,
  opening?: string | null,
): GreetingCandidate[] {
  const card = [character.firstMessage, ...character.alternateGreetings].map(
    (text, at): GreetingCandidate => ({ text, key: `card:${at}` }),
  );
  return opening == null || opening.trim() === ""
    ? card
    : [{ text: opening, key: MEMORY_GREETING }, ...card];
}

/**
 * Each greeting is evaluated from the same input state; commit only the
 * selected choice. The card's greetings share one work budget and one
 * expansion of the example dialogue. The memory's opening, when given, is
 * filled on its own work budget, so it never spends the card greetings'
 * shared one, and is left out alone when its macros pass a bound.
 */
export function cardGreetingChoices(
  input: MacroInput & { character: CharacterCard; opening?: string | null },
): FilledGreeting[] {
  const workBudget = createMacroWorkBudget();
  let fillCard: ((text: string) => FilledText) | undefined;
  const cardFiller = () => {
    fillCard ??= chatTextFiller(input, workBudget);
    return fillCard;
  };
  const choices: FilledGreeting[] = [];
  for (const { text, key } of greetingCandidates(input.character, input.opening)) {
    if (text.trim() === "") continue;
    const memory = key === MEMORY_GREETING;
    try {
      const choice = memory
        ? fillChatText(text, input, createMacroWorkBudget())
        : cardFiller()(text);
      if (choice.content.trim() !== "") choices.push({ ...choice, rawText: text, key });
    } catch (error) {
      if (!(error instanceof MacroLimitError)) throw error;
      // Example dialogue past a bound fails every card greeting alike.
      if (!memory && (fillCard === undefined || error instanceof AggregateMacroLimitError)) break;
    }
  }
  return choices;
}
