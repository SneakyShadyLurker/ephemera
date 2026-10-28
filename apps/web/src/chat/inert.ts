import type { Element, ElementContent, Root, RootContent } from "hast";

/** Streamdown's placeholder for a link whose destination has not streamed yet. */
const INCOMPLETE_LINK = "streamdown:incomplete-link";

type Node = Root | RootContent;

/** The text a run of nodes reads as, markup aside. */
export function textOf(nodes: ElementContent[]): string {
  return nodes
    .map((node) =>
      node.type === "text" ? node.value : node.type === "element" ? textOf(node.children) : "",
    )
    .join("");
}

function attribute(node: Element, name: "href" | "src" | "alt"): string | null {
  const value = node.properties[name];
  return typeof value === "string" && value !== "" && value !== INCOMPLETE_LINK ? value : null;
}

function destination(url: string): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { dataInert: "destination" },
    children: [{ type: "text", value: ` (${url})` }],
  };
}

/** A link keeps its label and shows where it points; it cannot be followed. */
function inertLink(node: Element): Element {
  const href = attribute(node, "href");
  const label = textOf(node.children).trim();
  const children = [...node.children];
  if (href !== null && label !== href) children.push(destination(href));
  return { type: "element", tagName: "span", properties: { dataInert: "link" }, children };
}

/** An image becomes its description; nothing is fetched. */
function inertImage(node: Element): Element {
  const src = attribute(node, "src");
  const alt = attribute(node, "alt");
  const children: ElementContent[] = [{ type: "text", value: alt ? `[image: ${alt}]` : "[image]" }];
  if (src !== null && !src.startsWith("data:")) children.push(destination(src));
  return { type: "element", tagName: "span", properties: { dataInert: "image" }, children };
}

function transform(node: Node): void {
  if (!("children" in node)) return;
  node.children = node.children.map((child) => {
    if (child.type !== "element") return child;
    if (child.tagName === "a") return inertLink(child);
    if (child.tagName === "img") return inertImage(child);
    return child;
  }) as typeof node.children;
  for (const child of node.children) transform(child);
}

/**
 * Rehype plugin for untrusted text (PRINCIPLES.md 3): runs after sanitizing
 * and replaces every link and image, so no `<a href>` or `<img>` reaches the page.
 */
export function rehypeInert() {
  return (tree: Root) => transform(tree);
}
