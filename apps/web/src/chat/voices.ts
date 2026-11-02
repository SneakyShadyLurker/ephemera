import { splitCue, THOUGHT_MARK } from "@ephemera/core";
import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import { textOf } from "./inert.ts";

/*
 * A scene's voices (styles.css `voice-scene`): in a paragraph of story
 * prose, a cue (`Kate (25):`, core's splitCue) becomes `<span data-cue>`,
 * its name in `<span data-cue-name>`, its age with the parentheses in
 * `<span data-cue-age>`, its colon and space in `<span data-cue-separator>`, which a scene hides
 * visually and keeps for assistive technology, find and copy; quoted
 * speech becomes `<span data-voice="speech">`; and the paragraph is marked `data-scene-line="cue"` when it opens with a cue,
 * `"thought"` when a thought is all that follows the cue, and `"narration"`
 * otherwise. Blockquotes and lists (the location line, the present block)
 * are left as they are, except that the present block's names become
 * `<span data-present-name>`. Runs after sanitizing, so its own elements need no
 * sanitizer allowance, and before Streamdown's word animation, which
 * Streamdown appends after every custom rehype plugin.
 */

/** Closing marks for each opening mark of speech; single quotes and apostrophes never open it. */
export const CLOSERS: Record<string, string> = {
  "“": '”"',
  "„": "“”",
  "«": "»",
  '"': '"”',
};

/** Elements whose quotation marks belong to them: actions, thoughts, tones, cues, inert links, code. */
const SEALED = new Set(["em", "span", "code"]);

/** The marks that close the quotation still open, carried across the elements it runs through. */
export interface Quote {
  closers: string | null;
}

/** An action keeps its own quotation marks; emphasis inside open speech is part of that speech. */
const sealed = (node: Element, quote: Quote) =>
  SEALED.has(node.tagName) && !(node.tagName === "em" && quote.closers !== null);

const text = (value: string): Text => ({ type: "text", value });

const span = (properties: Element["properties"], children: ElementContent[]): Element => ({
  type: "element",
  tagName: "span",
  properties,
  children,
});

const speech = (children: ElementContent[]) => span({ dataVoice: "speech" }, children);

/**
 * Wraps each run from an opening quotation mark to its closing one, quotes
 * included, across sibling nodes; a quote still open at the end runs to it.
 * A run passes through bold and the like, each level wrapping its own part,
 * so a quote may close inside them.
 */
function speak(children: ElementContent[], quote: Quote): ElementContent[] {
  const out: ElementContent[] = [];
  let run: ElementContent[] | null = quote.closers === null ? null : [];
  const flush = () => {
    if (run?.length) out.push(speech(run));
    run = null;
  };
  for (const child of children) {
    if (child.type === "text") {
      const { value } = child;
      let from = 0;
      for (let i = 0; i < value.length; i++) {
        const char = value[i] ?? "";
        if (run === null) {
          const opened = CLOSERS[char];
          if (opened === undefined) continue;
          if (i > from) out.push(text(value.slice(from, i)));
          run = [];
          quote.closers = opened;
          from = i;
        } else if (quote.closers?.includes(char)) {
          run.push(text(value.slice(from, i + 1)));
          flush();
          quote.closers = null;
          from = i + 1;
        }
      }
      if (from < value.length) (run ?? out).push(text(value.slice(from)));
    } else if (child.type === "element" && !sealed(child, quote)) {
      flush();
      out.push({ ...child, children: speak(child.children, quote) });
      if (quote.closers !== null) run = [];
    } else {
      (run ?? out).push(child);
    }
  }
  flush();
  return out;
}

const isThought = (node: ElementContent) =>
  node.type === "element" && node.tagName === "span" && node.properties.dataVoice === THOUGHT_MARK;

const isBlank = (node: ElementContent) => node.type === "text" && node.value.trim() === "";

/** The paragraph's cue as its own element, and how the line is marked; null without a cue. */
function cue(paragraph: Element): { children: ElementContent[]; line: string } | null {
  const [first, ...after] = paragraph.children;
  if (first?.type !== "text") return null;
  const split = splitCue(textOf(paragraph.children));
  if (split === null) return null;
  const prefix = split.cue + split.separator;
  if (!first.value.startsWith(prefix)) return null;
  const rest = first.value.slice(prefix.length);
  const content = rest ? [text(rest), ...after] : after;
  const label = span({ dataCue: "" }, [
    span({ dataCueName: "" }, [text(split.name)]),
    text(" "),
    span({ dataCueAge: "" }, [text(`(${split.age})`)]),
    span({ dataCueSeparator: "" }, [text(split.separator)]),
  ]);
  const spoken = content.filter((node) => !isBlank(node));
  const line =
    spoken.length === 1 && spoken[0] !== undefined && isThought(spoken[0]) ? "thought" : "cue";
  return { children: [label, ...content], line };
}

function paragraph(node: Element): void {
  const cued = cue(node);
  node.properties = { ...node.properties, dataSceneLine: cued?.line ?? "narration" };
  if (cued !== null) node.children = cued.children;
  node.children = speak(node.children, { closers: null });
}

/** The present block's first line, from a preset that asks for one: `present:`. */
const PRESENT = /^\s*present:/i;
/** Longer than any name: text before an entry's first comma that runs past this is not one. */
const NAME_LIMIT = 80;

const isBreak = (node: ElementContent) => node.type === "element" && node.tagName === "br";

/**
 * Each line of a present block names one woman before its first comma
 * (`Mara Battin, 18 years old, ...`). The name becomes
 * `<span data-present-name>` when the line opens with plain text; a line
 * that opens with markup, or has no comma yet, is left as written.
 */
function presentNames(quote: Element): void {
  const paragraphs = quote.children.filter(
    (child): child is Element => child.type === "element" && child.tagName === "p",
  );
  const [header] = paragraphs;
  if (header === undefined || !PRESENT.test(textOf(header.children))) return;
  for (const paragraph of paragraphs) {
    // The header's own line holds no one; every later line, and later paragraph, holds one.
    let opening = paragraph !== header;
    const out: ElementContent[] = [];
    for (const child of paragraph.children) {
      if (isBreak(child)) opening = true;
      else if (opening && child.type === "text") {
        const lead = /^\s*/.exec(child.value)?.[0] ?? "";
        const comma = child.value.indexOf(",", lead.length);
        if (lead.length === child.value.length) {
          out.push(child);
          continue;
        }
        opening = false;
        const name = child.value.slice(lead.length, comma).trimEnd();
        if (comma !== -1 && name !== "" && name.length <= NAME_LIMIT) {
          if (lead) out.push(text(lead));
          out.push(span({ dataPresentName: "" }, [text(name)]));
          out.push(text(child.value.slice(lead.length + name.length)));
          continue;
        }
      } else opening = false;
      out.push(child);
    }
    paragraph.children = out;
  }
}

/** Blockquotes and lists hold the location line and the present block, which keep their own look. */
const APART = new Set(["blockquote", "ul", "ol", "pre"]);

function visit(node: Root | RootContent): void {
  if (node.type === "element") {
    if (node.tagName === "blockquote") presentNames(node);
    if (APART.has(node.tagName)) return;
    if (node.tagName === "p") {
      paragraph(node);
      return;
    }
  }
  if ("children" in node) for (const child of node.children) visit(child);
}

/** Rehype plugin: the scene's cues, speech and line marks, as described above. */
export function rehypeVoices() {
  return (tree: Root) => visit(tree);
}
