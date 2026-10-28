import type { PromptMessage } from "./assemble.ts";

/** Native separator between self-contained example passages. */
export const EXAMPLE_SEPARATOR = "\n\n---\n\n";

/** Each passage retains narration and speaker labels in one ordinary system message. */
export function exampleBlocks(
  text: string,
  wrapper: (content: string) => string = (content) => content,
  retained?: (message: PromptMessage, start: number, end: number) => void,
): PromptMessage[][] {
  const blocks: PromptMessage[][] = [];
  let offset = 0;
  for (const part of text.split(EXAMPLE_SEPARATOR)) {
    const start = offset;
    offset += part.length + EXAMPLE_SEPARATOR.length;
    const content = part.trim();
    if (content === "") continue;
    const message: PromptMessage = {
      role: "system",
      content: wrapper(content),
      source: { kind: "example", index: blocks.length, line: 0 },
    };
    const from = start + part.length - part.trimStart().length;
    retained?.(message, from, from + content.length);
    blocks.push([message]);
  }
  return blocks;
}
