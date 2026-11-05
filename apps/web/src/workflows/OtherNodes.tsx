import { DisclosureChevron, SUMMARY_LINE } from "@/components/ui/disclosure";
import { cn } from "@/lib/cn";
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
      <summary className={cn(SUMMARY_LINE, "gap-2 text-ui")}>
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

/**
 * The nodes a refusal concerns, as the panel names them, closed under the
 * sentence that says what is wrong and what to do, so the way out reads first.
 */
export function NodesInvolved({ nodes }: { nodes: readonly string[] }) {
  if (nodes.length === 0) return null;
  return (
    <details className="disclosure">
      <summary className={cn(SUMMARY_LINE, "gap-2")}>
        <DisclosureChevron />
        {nodes.length === 1
          ? "The node concerned"
          : `The ${countOf(nodes.length, "node")} concerned`}
      </summary>
      <ul className="grid gap-1 pt-1 pl-6 text-note text-ink">
        {nodes.map((node) => (
          <li key={node} className="text-pretty break-words">
            {node}
          </li>
        ))}
      </ul>
    </details>
  );
}
