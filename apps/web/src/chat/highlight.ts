import { HIGHLIGHT_TONES, isHighlightTone, opensCue, THOUGHT_MARK } from "@ephemera/core";
import type { Nodes, Parent, PhrasingContent, Root, RootContent, Text } from "mdast";
import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import remend, { type RemendOptions } from "remend";
import type { StreamdownProps } from "streamdown";

/*
 * Highlights: `:rose[words]` and the other HIGHLIGHT_TONES (core) are text
 * directives that render as `<span data-tone>`, styled in styles.css: tone
 * is presentation, so assistive technology reads the words alone. A
 * thought, `:thought[words]` (THOUGHT_MARK), is one too and renders as
 * `<span data-voice="thought">`. Only
 * the text form of the directive syntax is parsed, so `::name` and
 * `:::name` lines stay plain Markdown; any other text directive (`:D`,
 * `Re:Zero`, `:gold[words]`) is put back as written, keeping the Markdown
 * parsed inside its label.
 */

type Pluggable = NonNullable<StreamdownProps["remarkPlugins"]>[number];
type Processor = ThisParameterType<Extract<Pluggable, (...args: never[]) => unknown>>;

type TextDirective = Extract<Nodes, { type: "textDirective" }>;

interface ParserData {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
}

/** remark-directive's wiring, limited to text directives. */
function remarkTextDirectives(this: Processor) {
  // unified types `Data` without the parser extension lists remark-parse reads.
  const data: ParserData = this.data() as object;
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), { text: directive().text }];
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), directiveFromMarkdown()];
}

const text = (value: string): Text => ({ type: "text", value });

/** A directive other than a highlight, as written: its name, brackets and attributes return as text. */
function restore(
  node: TextDirective,
  markdown: string,
  labelEnd: number | undefined,
): PhrasingContent[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const name = `:${node.name}`;
  if (start === undefined || end === undefined) return [text(name), ...node.children];
  const source = markdown.slice(start, end);
  if (source[name.length] !== "[") return [text(source)];
  const close = source.indexOf("]", labelEnd === undefined ? name.length + 1 : labelEnd - start);
  if (close === -1) return [text(source)];
  return [text(`${name}[`), ...node.children, text(source.slice(close))];
}

/**
 * Bottom-up, so a restored directive's label is already resolved when it is
 * spliced in; where its label ends is read first, while it still has a position.
 */
function transform(parent: Parent, markdown: string): void {
  parent.children = parent.children.flatMap((child): RootContent[] => {
    if (child.type !== "textDirective") {
      if ("children" in child) transform(child, markdown);
      return [child];
    }
    const labelEnd = child.children.at(-1)?.position?.end.offset;
    transform(child, markdown);
    if (isHighlightTone(child.name) && child.children.length) {
      child.data = { hName: "span", hProperties: { dataTone: child.name } };
      return [child];
    }
    if (child.name === THOUGHT_MARK && child.children.length) {
      child.data = { hName: "span", hProperties: { dataVoice: THOUGHT_MARK } };
      return [child];
    }
    return restore(child, markdown, labelEnd);
  }) as typeof parent.children;
}

function remarkHighlight() {
  return (tree: Root, file: { value: unknown }) =>
    transform(tree, typeof file.value === "string" ? file.value : "");
}

/** Runs before remark-smartypants and remark-breaks, so restored text gets both. */
export const highlightRemarkPlugins: Pluggable[] = [remarkTextDirectives, remarkHighlight];

/**
 * A directive name and its label's opening bracket, as micromark reads
 * them: no whitespace or punctuation but `-` and `_` inside, neither of
 * those first or last.
 */
const DIRECTIVE_NAME = /[^\s\p{P}\p{S}](?:[^\s\p{P}\p{S}]|[-_])*(?<![-_])\[/uy;
const TRAILING_NAME = /:([a-z]+)$/;
const FENCE_INDENT = /^[ \t>]*$/;
const BLANK = /^[ \t>]*$/;
/** Deeper nesting is degenerate output; it is left open, as cheap plain text. */
const MAX_OPEN = 8;

interface OpenLabel {
  /** Where the label's text starts. */
  start: number;
  /** Plain brackets open inside it. */
  depth: number;
}

/**
 * The labels of directives still open at the end of `text`, outermost
 * first, where escaped brackets inside labels are, and where a `(` still
 * open after a label's `]` or a bracket inside one starts, in one pass;
 * null when the text ends inside code.
 */
function openLabels(
  text: string,
): { labels: OpenLabel[]; escapes: number[]; paren: number | null; abandoned: number[] } | null {
  const open: OpenLabel[] = [];
  const escapes: number[] = [];
  let paren: number | null = null;
  const abandoned: number[] = [];
  let lineStart = 0;
  let fenced: string | false = false;
  let codeSpan = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      // Labels, code spans and links end with their paragraph.
      if (!fenced && BLANK.test(text.slice(lineStart, i))) {
        for (const label of open) abandoned.push(label.start - 1);
        if (paren !== null) abandoned.push(paren);
        open.length = 0;
        codeSpan = 0;
        paren = null;
      }
      lineStart = i + 1;
    }
    if (char === "`" || char === "~") {
      let run = 1;
      while (text[i + run] === char) run++;
      if (run >= 3 && codeSpan === 0 && FENCE_INDENT.test(text.slice(lineStart, i))) {
        fenced = fenced === char ? false : fenced || char;
      } else if (char === "`" && !fenced) {
        codeSpan = codeSpan === 0 ? run : codeSpan === run ? 0 : codeSpan;
      }
      i += run - 1;
      continue;
    }
    if (fenced || codeSpan) continue;
    if (char === "\\") {
      if (open.length && (text[i + 1] === "[" || text[i + 1] === "]")) escapes.push(i);
      i++;
      continue;
    }
    if (char === ":" && text[i - 1] !== ":") {
      DIRECTIVE_NAME.lastIndex = i + 1;
      if (DIRECTIVE_NAME.test(text)) {
        open.push({ start: DIRECTIVE_NAME.lastIndex, depth: 0 });
        i = DIRECTIVE_NAME.lastIndex - 1;
      }
      continue;
    }
    if (char === ")") paren = null;
    const label = open.at(-1);
    if (label === undefined) continue;
    if (char === "[") label.depth++;
    else if (char === "]") {
      if (label.depth) label.depth--;
      else open.pop();
      if (text[i + 1] === "(") paren ??= i + 1;
    }
  }
  return fenced || codeSpan ? null : { labels: open, escapes, paren, abandoned };
}

/**
 * `text` from `from` to `to`, its escaped brackets written as character
 * references, which remend's link completion does not take for brackets.
 */
function referenced(text: string, escapes: number[], from: number, to: number): string {
  let out = "";
  let last = from;
  for (const i of escapes) {
    if (i < from || i >= to) continue;
    out += `${text.slice(last, i)}&#${text.charCodeAt(i + 1)};`;
    last = i + 2;
  }
  return out + text.slice(last, to);
}

/** Inside an open label only its own Markdown is completed; a bracket stays a bracket. */
const LABEL: RemendOptions = { links: false, images: false };

/** Mark names held back while they stream in: the tones and the thought. */
const MARKS: readonly string[] = [...HIGHLIGHT_TONES, THOUGHT_MARK];

/**
 * While a reply streams, open directive labels are closed from the inside
 * out, each after its own Markdown and brackets are completed, so a
 * highlight or thought shows from its first word and no `:rose[` flashes
 * by; a mark name still arriving, or an opener with no word yet, is held
 * back with the space before it, as remend drops a trailing space before
 * closing emphasis.
 * Runs before remend's link completion, which would otherwise read an open
 * label as a link.
 */
function completeHighlight(text: string): string {
  const scan = openLabels(text);
  if (scan === null) return text;
  // remend would complete these as links to its placeholder, shown as text:
  // a `(` open after a label, and a label's `[` or `(` its paragraph left open.
  if (scan.paren !== null) return completeHighlight(text.slice(0, scan.paren));
  if (scan.abandoned.length) {
    let rest = text;
    for (const at of scan.abandoned.toSorted((a, b) => b - a)) {
      rest = `${rest.slice(0, at)}&#${rest.charCodeAt(at)};${rest.slice(at + 1)}`;
    }
    return completeHighlight(rest);
  }
  const name = TRAILING_NAME.exec(text);
  const held =
    name && MARKS.some((mark) => mark.startsWith(name[1] ?? ""))
      ? text.slice(0, name.index).trimEnd()
      : text;
  const { labels, escapes } = scan;
  const outermost = labels[0];
  if (outermost === undefined || labels.length > MAX_OPEN) return held;
  let closed = "";
  let end = held.length;
  for (const label of [...labels].reverse()) {
    const inner = remend(referenced(held, escapes, label.start, end) + closed, LABEL);
    if (!inner.trim()) {
      return completeHighlight(held.slice(0, held.lastIndexOf(":", label.start)).trimEnd());
    }
    closed = `${inner}${"]".repeat(label.depth + 1)}`;
    end = label.start;
  }
  return held.slice(0, outermost.start) + closed;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/g;

/**
 * While a reply streams, a last paragraph that may yet open with a cue
 * (core's opensCue) is held back until its text starts, so a cue arrives as
 * a cue and its line never changes look. A paragraph that began within the
 * first `settled` characters was already shown (a reply being continued)
 * and stays.
 */
function holdCue(text: string, settled: number): string {
  let start = 0;
  for (const match of text.matchAll(PARAGRAPH_BREAK)) start = match.index + match[0].length;
  return start >= settled && opensCue(text.slice(start)) ? text.slice(0, start).trimEnd() : text;
}

/**
 * Streamdown's `remend` options: its own completions plus highlights and
 * cues, for a reply whose first `settled` characters were shown before it
 * streamed.
 */
export function streamingFrom(settled: number): RemendOptions {
  return {
    handlers: [
      {
        name: "highlight",
        handle: (text) => holdCue(completeHighlight(text), settled),
        priority: 18,
      },
    ],
  };
}

interface SanitizeSchema {
  tagNames?: string[];
  attributes?: Record<string, unknown[]>;
}

/** Streamdown's sanitizer, also letting `<span>` carry a known tone or the thought voice and nothing else. */
export function withHighlights(sanitize: Pluggable | undefined): Pluggable {
  if (!Array.isArray(sanitize) || typeof sanitize[1] !== "object" || sanitize[1] === null) {
    throw new Error("Streamdown no longer provides its sanitizer");
  }
  const [plugin, schema] = sanitize as [Pluggable, SanitizeSchema];
  return [
    plugin,
    {
      ...schema,
      attributes: {
        ...schema.attributes,
        span: [
          ...(schema.attributes?.span ?? []),
          ["dataTone", ...HIGHLIGHT_TONES],
          ["dataVoice", THOUGHT_MARK],
        ],
      },
    },
  ] as Pluggable;
}
