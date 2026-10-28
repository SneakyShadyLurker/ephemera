/** `text` ending a sentence: as it is when it already ends in `.`, `!`, `?` or `…`, else with a full stop. */
export const closeSentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);
