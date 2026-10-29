import { DisclosureChevron } from "@/components/ui/disclosure";
import { countOf } from "@/lib/text";
import type { Draft } from "./panel-state.ts";

/** "Title (node 6)" with only the id in mono, as every node in the panel reads. */
export function NodeLabel({ title, node }: { title: string; node: string }) {
  return (
    <>
      {title} (<span className="font-mono text-[0.92em]">node {node}</span>)
    </>
  );
}

/** The rest of the graph, closed until asked: each node by title, id and class. */
export function OtherNodes({ nodes }: { nodes: Draft["inspection"]["nodes"] }) {
  if (nodes.length === 0) return null;
  return (
    <details className="disclosure">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-md text-reed text-ui hover:text-ink focus-visible:outline-2 focus-visible:outline-dusk-line focus-visible:outline-offset-2 touch:min-h-11 [&::-webkit-details-marker]:hidden">
        <DisclosureChevron />
        {countOf(nodes.length, "other node")} {nodes.length === 1 ? "keeps its" : "keep their"}{" "}
        settings
      </summary>
      <ul className="grid gap-1 pt-2 pl-6 text-note text-reed">
        {nodes.map((node) => (
          <li key={node.id} className="text-pretty break-words">
            <span className="text-ink">
              <NodeLabel title={node.title} node={node.id} />
            </span>
            , {node.classType}
          </li>
        ))}
      </ul>
    </details>
  );
}
