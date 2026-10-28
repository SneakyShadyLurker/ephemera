import type { Nodes, Root, RootContent } from "mdast";
import { useState } from "react";
import remarkBreaks from "remark-breaks";
import remarkSmartypants from "remark-smartypants";
import {
  type AnimateOptions,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
} from "streamdown";
import { QUICK } from "@/app/motion.tsx";
import { highlightRemarkPlugins, streamingFrom, withHighlights } from "./highlight.ts";
import { rehypeInert } from "./inert.ts";
import { rehypeVoices } from "./voices.ts";

/**
 * Above this many characters of text, a paragraph, heading or table cell
 * keeps its straight quotes and dashes. SmartyPants costs time quadratic in
 * the length of a sentence (unist-util-visit finds each word's index by
 * searching its siblings), so one paragraph of tens of thousands of words
 * would block the tab for seconds; up to this size it takes milliseconds.
 */
const SMARTYPANTS_BLOCK_LIMIT = 10_000;

const SMARTYPANTS_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);

const textLength = (node: Nodes): number =>
  "value" in node
    ? node.value.length
    : "children" in node
      ? node.children.reduce((sum, child) => sum + textLength(child), 0)
      : 0;

type SmartypantsTransformer = Exclude<ReturnType<typeof remarkSmartypants>, void>;

/**
 * remark-smartypants, run on one block at a time and only on blocks up to
 * SMARTYPANTS_BLOCK_LIMIT. Each block is given to it under a root of its own,
 * so it still starts afresh as it would in the whole document: quotes are
 * decided by their neighbours within a block, and the plugin already
 * separates blocks with a space.
 */
function remarkBoundedSmartypants(this: ThisParameterType<typeof remarkSmartypants>) {
  const smarten = remarkSmartypants.call(this) as SmartypantsTransformer;
  return (tree: Root, file: Parameters<SmartypantsTransformer>[1]) => {
    const visit = (node: Nodes): void => {
      if (SMARTYPANTS_BLOCKS.has(node.type)) {
        if (textLength(node) <= SMARTYPANTS_BLOCK_LIMIT) {
          const root: Root = { type: "root", children: [node as RootContent] };
          smarten(root, file, () => {});
        }
      } else if ("children" in node) {
        for (const child of node.children) visit(child);
      }
    };
    visit(tree);
  };
}

// Highlights first; then typographic quotes and dashes, as models often send
// straight ones. A single newline is a line break.
const remarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  ...highlightRemarkPlugins,
  remarkBoundedSmartypants,
  remarkBreaks,
];
// Streamdown's defaults add raw HTML and allow every link and image; neither is used.
// The scene's voices come after sanitizing; Streamdown's word animation runs last.
const rehypePlugins = [withHighlights(defaultRehypePlugins.sanitize), rehypeInert, rehypeVoices];
/**
 * Words that stream in fade in briefly, all at once, never queued behind
 * each other (styles.css `[data-sd-animate]`, which owns the curve as
 * `--ease-fade`); one object, so Streamdown's memo holds.
 */
const ANIMATED: AnimateOptions = {
  animation: "fadeIn",
  duration: QUICK * 1000,
  sep: "word",
  stagger: 0,
  maxBacklogMs: QUICK * 1000,
};
/** More characters than this in one update and the rest of a reply appears without fading in. */
const FADE_BURST_LIMIT = 5_000;

/** Untrusted Markdown from cards and models, rendered inert (PRINCIPLES.md 3). */
export function Markdown({ children, streaming }: { children: string; streaming: boolean }) {
  // Only a reply seen from its first words fades them in, until it first
  // settles. A continued reply streams again with all its text, which the
  // plugin would take as new and fade out and back in; its new words simply
  // appear.
  const [fresh, setFresh] = useState(streaming);
  if (fresh && !streaming) setFresh(false);
  // A burst of text, such as a long paragraph arriving at once, ends the fade:
  // each fading word is an element of its own, and React places a run of new
  // sibling elements at a cost that grows with the square of their number.
  const [shown, setShown] = useState(streaming ? 0 : children.length);
  if (shown !== children.length) {
    if (fresh && children.length - shown > FADE_BURST_LIMIT) setFresh(false);
    setShown(children.length);
  }
  // What was shown before the reply streamed: nothing of a new reply, all of
  // one being continued. A cue is held back only in text that arrives after.
  const [settled, setSettled] = useState(streaming ? 0 : children.length);
  if (!streaming && settled !== children.length) setSettled(children.length);
  const remend = streamingFrom(settled);
  return (
    <Streamdown
      className={streaming ? "caret-after" : ""}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      animated={streaming && fresh && ANIMATED}
      controls={false}
      remend={remend}
      linkSafety={{ enabled: false }}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
    >
      {children}
    </Streamdown>
  );
}
