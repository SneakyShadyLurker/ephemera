/** A line break of any kind: CRLF as one, a newline, a return, NEL, a line or paragraph separator. */
const LINE_BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/g;

/** Whether `text` holds no line break: the rule of every one-line field. */
export const isOneLine = (text: string): boolean => text.search(LINE_BREAKS) === -1;

/** `text` as one line, each line break a space, so an editor never holds what `isOneLine` refuses. */
export const oneLine = (text: string): string => text.replace(LINE_BREAKS, " ");
