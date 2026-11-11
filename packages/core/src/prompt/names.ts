/*
 * How a story's text names someone: the forms of a name it uses and whether
 * a text writes one. Shared by the memory calls' persona placeholder and the
 * cast register's introductions. Pure; imports nothing.
 */

/** A letter, digit, mark or underscore: what continues a word. */
export const WORD = "[\\p{L}\\p{M}\\p{N}_]";

/** First words, in lower case, that are a title or an article, never what a story calls someone by. */
const NOT_A_NAME = new Set(
  [
    "a an the",
    "mr mrs ms mx miss sir dame lady lord madam master",
    "dr doctor prof professor captain general sergeant officer detective agent",
    "king queen prince princess duke duchess count countess baron baroness emperor empress",
    "father mother brother sister uncle aunt saint",
  ].flatMap((words) => words.split(" ")),
);

/**
 * The first word of a name of several, as a story most often calls someone:
 * null for a one-word name and for a first word that is lower case, a title,
 * an article or an initial.
 */
export function givenName(name: string): string | null {
  const whole = name.trim();
  const first = whole.split(/\s+/)[0] ?? "";
  return first !== whole &&
    /^\p{Lu}[\p{L}\p{M}'’-]+$/u.test(first) &&
    !NOT_A_NAME.has(first.toLowerCase())
    ? first
    : null;
}

/** Matches `name`, as written, where it stands as whole words. */
export const wholeName = (name: string, flags = "u"): RegExp =>
  new RegExp(`(?<!${WORD})${RegExp.escape(name)}(?!${WORD})`, flags);

/**
 * Given names that are everyday English words too, in lower case: months,
 * days and seasons, virtues, plants, colours and gems, animals and places,
 * and the short forms that are also verbs or nouns. A sentence capitalises
 * these on its own ("May I come in?", "Dawn breaks"), so a capital alone
 * names no one. Not complete: the common ones.
 */
const EVERYDAY_NAMES = new Set(
  [
    "april may june august summer autumn winter spring dawn eve",
    "monday tuesday wednesday thursday friday saturday sunday",
    "hope faith joy grace charity mercy patience prudence honor harmony melody destiny chance",
    "bliss merry love true angel echo story journey haven trinity christian",
    "rose lily ivy holly daisy poppy iris fern heather hazel olive sage willow violet ginger",
    "amber ruby pearl crystal jade scarlet penny candy sandy rusty sunny misty rain storm sky star",
    "robin wren raven jay wolf fox bear buck drake reed brook dale glen cliff heath forest lake",
    "river ash clay stone rocky",
    "will mark art bill rob pat sue chase hunter mason grant miles rich frank earnest victor",
    "major duke earl king prince baron bishop dean carol jack bob dick don gene guy herb lance",
    "pierce rod skip wade ward drew nick josh dot",
  ].flatMap((words) => words.split(" ")),
);

/** Whether a one-word name is an everyday word as well, whatever its case. */
export const isEverydayName = (name: string): boolean => EVERYDAY_NAMES.has(name.toLowerCase());
