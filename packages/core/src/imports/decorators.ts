const DECORATOR = "@@";

/** Index of the first line after the leading V3 decorator lines, or 0 without any. */
function decoratorEnd(lines: string[]): number {
  let end = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith(DECORATOR)) end = i + 1;
    else if (line.trim() !== "") break;
  }
  return end;
}

/** Blank lines, then a line starting with `@@`. Linear: the two repeated parts share no character. */
const LEADING_DECORATOR = /^(?:[^\S\n]*\n)*@@/;

/** Whether the content starts with V3 decorator lines (`@@depth 4` and the like). */
export function hasDecorators(content: string): boolean {
  return LEADING_DECORATOR.test(content);
}

/**
 * **Decided:** the content with its leading decorator lines (and blank lines
 * among them) removed; decorators are ignored, as V3 allows.
 */
export function stripDecorators(content: string): string {
  if (!hasDecorators(content)) return content;
  const lines = content.split("\n");
  return lines.slice(decoratorEnd(lines)).join("\n");
}
