import { WORKFLOW_LIMITS, type WorkflowSummary } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useId, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { queryClient } from "@/app/query.ts";
import { ImportIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ART_STATUS_KEY, artWorkflowsQuery } from "../creator/queries.ts";
import {
  deletedLine,
  EMPTY_WORKFLOWS,
  listFailedLine,
  WORKFLOWS_FULL,
} from "../settings/portraits.ts";
import { useSetting } from "../settings/settings.ts";
import { Glides } from "../sheet/ordering.tsx";
import { useNotReached } from "../signin/hooks.ts";
import { workflowsQuery } from "./queries.ts";
import { WorkflowRow } from "./WorkflowRow.tsx";

const HELP = "text-pretty text-note text-reed";
const GROUP = "font-medium text-note text-reed";

/**
 * The workflows portraits can be painted with: the user's own, which they
 * import, rename, re-family, replace and delete, then the server's. Each row
 * says whether it can paint now; the one Create with AI uses says "In use".
 */
export function Workflows({
  importRef,
  onImport,
  onReplace,
}: {
  /** "Import a workflow", where focus returns after an import or a delete. */
  importRef: RefObject<HTMLButtonElement | null>;
  onImport: () => void;
  onReplace: (workflow: WorkflowSummary) => void;
}) {
  const phone = useFormFactor() === "phone";
  const notReached = useNotReached();
  const comfyuiWorkflow = useSetting((settings) => settings.comfyuiWorkflow);
  const yours = useQuery(workflowsQuery);
  const options = useQuery(artWorkflowsQuery);
  const headingId = useId();
  const yoursId = useId();
  const serverId = useId();
  const fullId = useId();
  // The workflow in use that was deleted here; said once, with what replaced it.
  const [deleted, setDeleted] = useState<string | null>(null);
  const rows = yours.data ?? [];
  const servers = (options.data ?? []).filter((option) => option.scope === "server");
  const full = rows.length >= WORKFLOW_LIMITS.workflows;
  const fallback = options.data?.find((option) => option.id === comfyuiWorkflow)?.name;
  const failed = yours.isError || options.isError;

  const onDeleted = (gone: WorkflowSummary, wasInUse: boolean) => {
    setDeleted(wasInUse ? gone.name : null);
    // Focus left with the row; Import is the nearest place to go on from.
    const focused = document.activeElement;
    if (focused === null || focused === document.body || !focused.isConnected) {
      importRef.current?.focus();
    }
  };

  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: workflowsQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: artWorkflowsQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: ART_STATUS_KEY });
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 id={headingId} className="font-medium text-ink text-ui">
          Workflows
        </h3>
        <Button
          ref={importRef}
          variant="outline"
          disabled={full}
          focusableWhenDisabled
          aria-describedby={full ? fullId : undefined}
          onClick={onImport}
        >
          <ImportIcon size={16} />
          Import a workflow
        </Button>
      </div>
      {full && (
        <p id={fullId} className={HELP}>
          {WORKFLOWS_FULL}
        </p>
      )}
      {failed && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p role="status" className={HELP}>
            {listFailedLine(notReached)}
          </p>
          <Button
            variant="outline"
            className="h-8 px-2.5 text-ink text-note touch:h-11"
            onClick={retry}
          >
            Try again
          </Button>
        </div>
      )}
      {deleted !== null && fallback !== undefined && (
        <p role="status" className={HELP}>
          {deletedLine(deleted, fallback)}
        </p>
      )}
      <Glides>
        <div className="grid gap-1">
          <h4 id={yoursId} className={GROUP}>
            Yours
          </h4>
          {yours.isPending ? (
            <p className={HELP}>Listing workflows…</p>
          ) : rows.length === 0 && !yours.isError ? (
            <p className="flex items-baseline gap-2 text-pretty text-note text-reed">
              <ImportIcon size={16} className="shrink-0 translate-y-[0.2em]" />
              {EMPTY_WORKFLOWS}
            </p>
          ) : (
            <ul aria-labelledby={yoursId} className="grid border-rush border-t">
              {rows.map((workflow) => (
                <WorkflowRow
                  key={workflow.id}
                  row={{
                    scope: "user",
                    workflow,
                    otherNames: rows
                      .filter((other) => other.id !== workflow.id)
                      .map((other) => other.name),
                    onReplace,
                    onDeleted,
                  }}
                  inUse={workflow.id === comfyuiWorkflow}
                />
              ))}
            </ul>
          )}
        </div>
        {servers.length > 0 && (
          <div className="grid gap-1">
            <h4 id={serverId} className={GROUP}>
              On this server
            </h4>
            <ul aria-labelledby={serverId} className="grid border-rush border-t">
              {servers.map((option) => (
                <WorkflowRow
                  key={option.id}
                  row={{ scope: "server", workflow: option }}
                  inUse={option.id === comfyuiWorkflow}
                />
              ))}
            </ul>
          </div>
        )}
      </Glides>
      {!phone && !full && (
        <p className={HELP}>Drop a workflow file here, or import one. Both ComfyUI formats work.</p>
      )}
    </section>
  );
}
