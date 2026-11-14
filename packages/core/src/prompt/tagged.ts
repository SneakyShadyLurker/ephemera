/**
 * `text` as a block under `tag`, the tag on its own lines around it: how the
 * folded card fields are stored and how prompts hand a model its sources.
 */
export const tagged = (tag: string, text: string): string => `<${tag}>\n${text}\n</${tag}>`;
