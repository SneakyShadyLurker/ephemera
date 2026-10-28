/**
 * Highlight tones a prompt can ask the model to use: `:rose[words]` shows the
 * words in that tone wherever chat Markdown renders. The list is the whole
 * vocabulary; any other `:name[...]` stays plain text.
 */
export const HIGHLIGHT_TONES = ["rose", "sage", "iris", "mist"] as const;

type HighlightTone = (typeof HIGHLIGHT_TONES)[number];

export function isHighlightTone(name: string): name is HighlightTone {
  return (HIGHLIGHT_TONES as readonly string[]).includes(name);
}

/**
 * The mark for a character's thought, `:thought[like this]`: a scene line's
 * own voice, not a tone, so it is set apart from HIGHLIGHT_TONES.
 */
export const THOUGHT_MARK = "thought";

/** A scene line's cue, `Kate (25)`, its name and age, and the colon and spaces after it. */
interface Cue {
  cue: string;
  name: string;
  age: string;
  separator: string;
  rest: string;
}

/** One word of a cue's name: letters, marks, apostrophes, hyphens and periods. */
const WORD = "[\\p{L}\\p{M}'\\u2019.-]{1,20}";
/** A cue's name: one to three words. */
const NAME = `${WORD}(?: ${WORD}){0,2}`;

/**
 * A name, a space, an age of up to four digits in parentheses, a colon and
 * at least one space, then the line's text.
 */
const CUE = new RegExp(`^((${NAME}) \\((\\d{1,4})\\))(: +)(?=\\S)`, "u");

/**
 * Splits the cue a scene line opens with (`Kate (25): "Hi"`) from its text;
 * null when the line opens with none, as in `Note: hi` or `12:30 came`, or
 * has nothing after it.
 */
export function splitCue(line: string): Cue | null {
  const match = CUE.exec(line);
  if (match === null) return null;
  const [whole, cue = "", name = "", age = "", separator = ""] = match;
  return { cue, name, age, separator, rest: line.slice(whole.length) };
}

/** A name, then as much of ` (25): ` as has arrived, and no text yet. */
const CUE_OPENING = new RegExp(`^${NAME}(?: (?:\\((?:\\d{1,4}(?:\\)(?:: *)?)?)?)?)?$`, "u");

/**
 * Whether a line still arriving may yet open with a cue: `Kate`, `Kate (2`
 * or `Kate (25): `, with no text after it. A reply that streams holds such
 * a line back, so a cue never shows first as narration.
 */
export function opensCue(line: string): boolean {
  return CUE_OPENING.test(line);
}

const OPENER = new RegExp(`:(?:${[...HIGHLIGHT_TONES, THOUGHT_MARK].join("|")})\\[`, "y");
const ATTRIBUTES = /\{[^}\n]*\}/y;

/**
 * The text as it reads, without highlight or thought markup: `:rose[` or
 * `:thought[` and its closing `]` (with any `{attributes}` after it) go,
 * the words stay; code and a tone
 * written straight after a colon stay as they are, as the chat shows them.
 * Lorebook keys match against this, so a key such as "Rose" fires on the
 * story, not on the markup.
 */
export function withoutHighlights(text: string): string {
  if (!text.includes(":")) return text;
  let out = "";
  // Open highlights, each with the depth of plain brackets inside it.
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "`") {
      // A code span or fence runs to the next run of as many backticks.
      let run = 1;
      while (text[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const end = text.indexOf(fence, i + run);
      const to = end === -1 ? i + run : end + run;
      out += text.slice(i, to);
      i = to - 1;
      continue;
    }
    if (char === "\\") {
      out += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (char === ":" && text[i - 1] !== ":") {
      OPENER.lastIndex = i;
      if (OPENER.test(text)) {
        open.push(0);
        i = OPENER.lastIndex - 1;
        continue;
      }
    }
    const depth = open.at(-1);
    if (depth !== undefined && char === "[") open[open.length - 1] = depth + 1;
    else if (depth !== undefined && char === "]") {
      if (depth === 0) {
        open.pop();
        ATTRIBUTES.lastIndex = i + 1;
        if (ATTRIBUTES.test(text)) i = ATTRIBUTES.lastIndex - 1;
        continue;
      }
      open[open.length - 1] = depth - 1;
    }
    out += char;
  }
  return out;
}
