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
