import {
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  type PromptPreset,
} from "../src/preset/index.ts";

/** A one-line main prompt, so tests read the assembly rather than the default's instructions. */
export const PLAIN_MAIN_PROMPT =
  "Write {{char}}'s next reply in this roleplay with {{user}}. Stay in character, move the scene forward, and never write {{user}}'s actions or words.";

/**
 * The default preset's built-in blocks alone, in their default order, with
 * the one-line main prompt, no persona wrapper and the Author's Note off: a fixture for tests
 * of assembly and block mechanics, which stay independent of the default's
 * own instruction blocks and note.
 */
export function plainPromptPreset(name?: string): PromptPreset {
  const preset = defaultPromptPreset(name);
  return {
    ...preset,
    blocks: preset.blocks
      .filter((block) => block.kind !== "custom")
      .map((block) =>
        block.kind === "text" && block.id === "main"
          ? { ...block, content: PLAIN_MAIN_PROMPT }
          : block.kind === "source"
            ? { ...block, template: "" }
            : block,
      ),
    authorsNote: { ...DEFAULT_AUTHORS_NOTE, enabled: false },
  };
}
