import {
  ART_FAMILIES,
  type ArtFamily,
  type ComfyuiWorkflowOption,
  type WorkflowSummary,
} from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { m } from "motion/react";
import { useId, useRef, useState } from "react";
import { queryClient } from "@/app/query.ts";
import { DeleteIcon, EditIcon, ImportIcon, MoreIcon, TagIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { artStatusQuery } from "../creator/queries.ts";
import {
  FAMILY_NAMES,
  nameTakenLine,
  nodeCount,
  renameProblem,
  type StatusTone,
  workflowStatus,
} from "../settings/portraits.ts";
import { ConflictNotice } from "../sheet/ConflictNotice.tsx";
import { FOCUS_WITHIN } from "../sheet/fields.ts";
import { useGlide } from "../sheet/ordering.tsx";
import { useNotReached } from "../signin/hooks.ts";
import { deleteWorkflow, refreshWorkflows, updateWorkflow, workflowsQuery } from "./queries.ts";

/** A small state dot beside the status words: lit dusk when ready, ember on a problem. */
export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 translate-y-[-0.1em] rounded-full",
        tone === "ready" && "bg-dusk",
        tone === "problem" && "bg-ember",
        (tone === "off" || tone === "unknown") && "bg-control-edge",
      )}
    />
  );
}

/** One row of the list: the user's own, with its actions, or the server's (name, family and status only). */
type Row =
  | {
      scope: "user";
      workflow: WorkflowSummary;
      /** The user's other workflow names, a rename must differ from. */
      otherNames: readonly string[];
      onReplace: (workflow: WorkflowSummary) => void;
      /** After a delete, with whether Create with AI used the workflow until then. */
      onDeleted: (workflow: WorkflowSummary, wasInUse: boolean) => void;
    }
  | { scope: "server"; workflow: ComfyuiWorkflowOption };

/** What a rename or family change sends besides the revision. */
type Change = { name: string } | { family: ArtFamily };

/** The row's hairline, the content beside its trailing actions. */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-rush border-b py-2";

/**
 * One workflow: its dot, name and family on the first line, its node count
 * and status words beside (tablet up) or under them (phone), and the missing
 * requirements under the row. User rows end in their actions button.
 */
export function WorkflowRow({
  row,
  inUse,
}: {
  row: Row;
  /** The workflow Create with AI paints with. */
  inUse: boolean;
}) {
  const { workflow } = row;
  const glide = useGlide();
  const notReached = useNotReached();
  const status = useQuery(artStatusQuery(workflow.id));
  const shown = workflowStatus(
    status.isPending ? "checking" : status.isError ? "failed" : status.data,
  );
  const problemId = useId();
  const actionsRef = useRef<HTMLButtonElement>(null);
  // Rename and Family take focus themselves; the menu then leaves it alone.
  const handoff = useRef(false);
  const [editing, setEditing] = useState<"name" | "family" | null>(null);
  // Set once the name field closes, so the blur its removal may cause commits nothing.
  const closed = useRef(true);
  const [draft, setDraft] = useState("");
  // This tab's change, shown over the row until the list answers with it.
  const [pending, setPending] = useState<Change | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ revision: number; change: Change } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const name = pending !== null && "name" in pending ? pending.name : workflow.name;
  const family = pending !== null && "family" in pending ? pending.family : workflow.family;

  const save = async (change: Change, revision: number) => {
    setPending(change);
    setProblem(null);
    setConflict(null);
    const result = await updateWorkflow(workflow.id, { revision, ...change });
    if (result.ok) {
      setPending(null);
      return;
    }
    if (result.reason === "conflict") {
      setConflict({ revision: result.revision, change });
      return;
    }
    setPending(null);
    if (result.reason === "name_taken" && "name" in change) {
      setProblem(nameTakenLine(change.name));
    } else if (result.reason === "not_found") {
      // Deleted in another tab: the list drops the row.
      await refreshWorkflows();
    } else {
      setProblem(`Not saved: ${notReached}.`);
    }
  };

  const openEditor = (editor: "name" | "family") => {
    handoff.current = true;
    closed.current = false;
    setDraft(name);
    setProblem(null);
    setEditing(editor);
  };

  const closeEditor = (refocus: boolean) => {
    closed.current = true;
    setEditing(null);
    setProblem(null);
    if (refocus) actionsRef.current?.focus();
  };

  // Enter and blur save, Escape cancels; a refused name stays in the field with its reason.
  const commitName = (refocus: boolean) => {
    if (closed.current || row.scope !== "user") return;
    const next = draft.trim();
    if (next === name) {
      closeEditor(refocus);
      return;
    }
    const refused = renameProblem(next, row.otherNames);
    if (refused !== null) {
      setProblem(refused);
      return;
    }
    closeEditor(refocus);
    void save({ name: next }, row.workflow.revision);
  };

  const remove = async () => {
    if (row.scope !== "user") return;
    const wasInUse = inUse;
    setProblem(null);
    const result = await deleteWorkflow(workflow.id);
    if (result.ok) {
      row.onDeleted(row.workflow, wasInUse);
      return;
    }
    if (result.reason === "not_found") {
      // Already deleted in another tab: as good as done here.
      await refreshWorkflows();
      row.onDeleted(row.workflow, wasInUse);
      return;
    }
    setProblem(`Not deleted: ${notReached}.`);
  };

  const words = (
    <span className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-note">
      {row.scope === "user" && <span className="text-reed">{nodeCount(row.workflow.nodes)}</span>}
      <span className={shown.tone === "problem" ? "text-ember" : "text-ink"}>{shown.words}</span>
      {inUse && <span className="text-reed">In use</span>}
    </span>
  );

  return (
    <m.li data-workflow={workflow.id} className={ROW} {...glide}>
      <div className="grid min-w-0 gap-1 tablet:flex tablet:flex-wrap tablet:items-baseline tablet:gap-x-4">
        <span className="flex min-w-0 items-baseline gap-x-2.5 gap-y-0.5 max-tablet:flex-wrap tablet:gap-x-4">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <StatusDot tone={shown.tone} />
            {editing === "name" ? (
              <span
                className={cn(
                  "flex h-8 min-w-0 items-center rounded-md border border-control-edge bg-surface px-2 touch:h-11",
                  FOCUS_WITHIN,
                  problem !== null && "border-ember",
                )}
              >
                <input
                  // Rename moved focus here from the menu.
                  // biome-ignore lint/a11y/noAutofocus: opened by the owner's choice of Rename
                  autoFocus
                  aria-label={`Name of ${workflow.name}`}
                  aria-invalid={problem !== null}
                  aria-describedby={problem !== null ? problemId : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setProblem(null);
                  }}
                  onBlur={() => commitName(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitName(true);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeEditor(true);
                    }
                  }}
                  className="w-56 min-w-0 max-w-full bg-transparent text-ink text-ui outline-none"
                />
              </span>
            ) : (
              <span
                data-workflow-name=""
                tabIndex={-1}
                className="min-w-0 break-words font-medium text-ink text-ui outline-none"
              >
                {name}
              </span>
            )}
          </span>
          {editing === "family" ? (
            <Select
              defaultOpen
              value={family}
              onValueChange={(value) => {
                if (row.scope !== "user" || value === null) return;
                const chosen = ART_FAMILIES.find((option) => option === value);
                if (chosen !== undefined && chosen !== family) {
                  void save({ family: chosen }, row.workflow.revision);
                }
              }}
              onOpenChangeComplete={(open) => {
                if (!open) closeEditor(true);
              }}
            >
              <SelectTrigger
                aria-label={`Family of ${workflow.name}`}
                placeholder="Family"
                className="h-8 w-36"
              >
                {FAMILY_NAMES[family]}
              </SelectTrigger>
              <SelectContent label="Families">
                {ART_FAMILIES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {FAMILY_NAMES[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="shrink-0 text-note text-reed">{FAMILY_NAMES[family]}</span>
          )}
        </span>
        {words}
      </div>
      {row.scope === "user" ? (
        <>
          <Menu>
            <MenuTrigger
              ref={actionsRef}
              render={
                <Button
                  size="icon"
                  aria-label={`Actions for ${workflow.name}`}
                  data-workflow-actions=""
                />
              }
            >
              <MoreIcon />
            </MenuTrigger>
            <MenuContent
              label={`Actions for ${workflow.name}`}
              finalFocus={() => {
                const handed = handoff.current;
                handoff.current = false;
                return !handed;
              }}
            >
              <MenuItem onClick={() => openEditor("name")}>
                <EditIcon size={16} />
                Rename
              </MenuItem>
              <MenuItem onClick={() => openEditor("family")}>
                <TagIcon size={16} />
                Family
              </MenuItem>
              <MenuItem onClick={() => row.onReplace(row.workflow)}>
                <ImportIcon size={16} />
                Replace file
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onClick={() => setConfirmDelete(true)}>
                <DeleteIcon size={16} />
                Delete
              </MenuItem>
            </MenuContent>
          </Menu>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${workflow.name}?`}
            description={
              inUse
                ? "Create with AI paints with it now and goes back to the default workflow."
                : "Portraits already painted with it stay."
            }
            confirm="Delete"
            onConfirm={() => void remove()}
          />
        </>
      ) : (
        <span />
      )}
      {(problem !== null || shown.missing !== null || (inUse && shown.reason !== null)) && (
        <div className="col-span-2 grid gap-2 pt-1 pb-1 pl-4">
          {problem !== null && (
            <p id={problemId} role="alert" className="text-pretty text-ember text-note">
              {problem}
            </p>
          )}
          {inUse && shown.reason !== null && (
            <p className="text-pretty text-note text-reed">{shown.reason}</p>
          )}
          {shown.missing !== null && (
            <dl className="grid gap-1.5 border-rush border-l pl-4 text-note">
              {shown.missing.nodes.length > 0 && (
                <div className="grid gap-0.5">
                  <dt className="text-reed">Nodes</dt>
                  <dd className="break-words text-ink">{shown.missing.nodes.join(", ")}</dd>
                </div>
              )}
              {shown.missing.models.length > 0 && (
                <div className="grid gap-0.5">
                  <dt className="text-reed">Model files</dt>
                  <dd className="break-words text-ink">{shown.missing.models.join(", ")}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
      {conflict !== null && (
        <div className="col-span-2 pt-1 pb-1">
          <ConflictNotice
            noun="workflow"
            placement="inline"
            onReload={async () => {
              // A failed fetch changes nothing: the change and the notice stay.
              const fetched = await queryClient
                .fetchQuery({ ...workflowsQuery, staleTime: 0 })
                .then(
                  () => true,
                  () => false,
                );
              if (!fetched) return;
              setConflict(null);
              setPending(null);
            }}
            onKeepMine={() => void save(conflict.change, conflict.revision)}
          />
        </div>
      )}
    </m.li>
  );
}
