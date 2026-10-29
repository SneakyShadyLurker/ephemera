import { settingsSchema, WORKFLOW_LIMITS, type WorkflowSummary } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, useId, useRef, useState } from "react";
import { queryClient } from "@/app/query.ts";
import { DropOverlay, useFileDrop } from "@/components/file-drop";
import { cn } from "@/lib/cn";
import { ART_STATUS_KEY } from "../creator/queries.ts";
import { FOCUS_WITHIN } from "../sheet/fields.ts";
import { workflowsQuery } from "../workflows/queries.ts";
import { Workflows } from "../workflows/Workflows.tsx";
import {
  applySettings,
  queueSettingsSave,
  type SaveError,
  useRefusedAddress,
  useSetting,
} from "./settings.ts";

const HELP = "text-pretty text-note text-reed";
const addressSchema = settingsSchema.shape.comfyuiBaseUrl;

/**
 * Saves the ComfyUI address and takes it into this tab only once the server
 * has not refused its origin, and only while it is still the field's newest
 * choice (`latest`): a save that settles after a newer one was committed
 * leaves the tab's copy to that one.
 */
async function saveAddress(
  comfyuiBaseUrl: string,
  latest: () => boolean,
): Promise<"taken" | "not_allowed" | "superseded"> {
  const notAllowed = await queueSettingsSave({ comfyuiBaseUrl }).then(
    () => false,
    (error: unknown) =>
      error instanceof Error &&
      error.message === ("comfyui_origin_not_allowed" satisfies SaveError),
  );
  if (!latest()) return "superseded";
  if (notAllowed) return "not_allowed";
  applySettings({ comfyuiBaseUrl });
  await queryClient.invalidateQueries({ queryKey: ART_STATUS_KEY });
  return "taken";
}

/** What the address field reports under itself, if anything. */
const ADDRESS_PROBLEMS = {
  format: "Use a plain http or https address, such as http://comfyui.local:8188.",
  not_allowed:
    "This server does not allow that address. Only origins in its COMFYUI_ALLOWED_ORIGINS can be used.",
} as const;

/** A workflow file on its way in: a new import, or a replacement for one of the user's workflows. */
export type WorkflowDraft =
  | { mode: "import"; file: File }
  | { mode: "replace"; workflow: WorkflowSummary; file?: File };

/** What the import panel gets: the draft, how to close it, and where focus goes on. */
export interface ImportPanelProps {
  draft: WorkflowDraft;
  /** Closes the panel; focus returns to Import a workflow, or to the replaced row's actions button. */
  onClose: () => void;
  /** Opens the file picker again, for the same mode. */
  onChooseFile: () => void;
  /** Moves focus to a workflow row's name, once the list shows it. */
  focusWorkflow: (id: string) => void;
}

/**
 * The owner's ComfyUI for card portraits: its address, and the workflows it
 * paints with and whether each can paint now. The workflow is chosen where
 * portraits are made, in Create with AI. A workflow file comes in through the
 * file picker, or dropped anywhere on this section on tablet and desktop;
 * `ImportPanel` shows it, under the list.
 */
export function Portraits({ ImportPanel }: { ImportPanel?: ComponentType<ImportPanelProps> }) {
  const comfyuiBaseUrl = useSetting((settings) => settings.comfyuiBaseUrl);
  const count = useQuery(workflowsQuery).data?.length ?? 0;
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  // The workflow Replace file was chosen for, until the picker answers.
  const replacing = useRef<WorkflowSummary | null>(null);
  const full = count >= WORKFLOW_LIMITS.workflows;
  const { dragging, dropTarget } = useFileDrop((files) => {
    const [file] = files;
    if (file !== undefined && !full) setDraft({ mode: "import", file });
  });

  const choose = (workflow: WorkflowSummary | null) => {
    replacing.current = workflow;
    picker.current?.click();
  };

  const rowPart = (id: string, part: "actions" | "name") =>
    root.current
      ?.querySelector(`[data-workflow="${CSS.escape(id)}"]`)
      ?.querySelector<HTMLElement>(`[data-workflow-${part}]`);

  return (
    <div ref={root} className="relative grid gap-6" {...dropTarget}>
      <AddressField saved={comfyuiBaseUrl} />
      <Workflows
        importRef={importButton}
        onImport={() => choose(null)}
        onReplace={(workflow) => choose(workflow)}
      />
      <input
        ref={picker}
        type="file"
        accept=".json,application/json"
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Cleared, so choosing the same file again still answers.
          event.currentTarget.value = "";
          const workflow = replacing.current;
          replacing.current = null;
          if (file === undefined) return;
          setDraft(
            workflow === null ? { mode: "import", file } : { mode: "replace", workflow, file },
          );
        }}
      />
      {draft !== null && ImportPanel !== undefined && (
        <ImportPanel
          draft={draft}
          onClose={() => {
            const replaced = draft.mode === "replace" ? draft.workflow.id : null;
            setDraft(null);
            (replaced === null ? importButton.current : rowPart(replaced, "actions"))?.focus();
          }}
          onChooseFile={() => choose(draft.mode === "replace" ? draft.workflow : null)}
          focusWorkflow={(id) => rowPart(id, "name")?.focus()}
        />
      )}
      {dragging && (
        <DropOverlay
          title="Import this workflow"
          hint="ComfyUI workflow, saved or exported as API"
        />
      )}
    </div>
  );
}

function AddressField({ saved }: { saved: string }) {
  const id = useId();
  const [address, setAddress] = useState(saved);
  const [problem, setProblem] = useState<keyof typeof ADDRESS_PROBLEMS | null>(null);
  const [editing, setEditing] = useState(false);
  // The saved address the field last took in. When it changes (this field's
  // save settling, another tab, a refetch), the field refills unless the owner
  // is typing in it, so text typed while a save is in flight stays.
  const [taken, setTaken] = useState(saved);
  if (saved !== taken) {
    setTaken(saved);
    if (!editing) {
      setAddress(saved);
      setProblem(null);
    }
  }
  // The newest address committed and not yet settled, compared against in its
  // place: reverting to the saved address while a save is in flight is a choice too.
  const [committed, setCommitted] = useState<string | null>(null);
  const round = useRef(0);
  // A resend after a renewal can be refused too, for an address the tab already holds.
  const refused = useRefusedAddress();
  const shown = problem ?? (refused !== undefined && refused === saved ? "not_allowed" : null);
  const invalid = shown !== null;
  const commit = () => {
    const next = address.trim();
    if (next === (committed ?? saved)) {
      setProblem(null);
      return;
    }
    if (!addressSchema.safeParse(next).success) {
      setProblem("format");
      return;
    }
    setProblem(null);
    setCommitted(next);
    round.current += 1;
    const mine = round.current;
    void saveAddress(next, () => round.current === mine).then((outcome) => {
      if (outcome === "superseded") return;
      setCommitted(null);
      if (outcome === "not_allowed") setProblem("not_allowed");
    });
  };
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="font-medium text-ink text-ui">
        ComfyUI address
      </label>
      <div
        className={cn(
          "flex h-9 max-w-sm items-center rounded-md border border-control-edge bg-surface px-3 touch:h-11",
          FOCUS_WITHIN,
          invalid && "border-ember",
        )}
      >
        <input
          id={id}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          translate="no"
          placeholder="http://comfyui.local:8188"
          aria-invalid={invalid}
          aria-describedby={`${id}-help`}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-ink text-ui outline-none placeholder:text-reed"
        />
      </div>
      <p id={`${id}-help`} aria-live="polite" className={cn(HELP, invalid && "text-ember")}>
        {shown !== null
          ? ADDRESS_PROBLEMS[shown]
          : "Saved when you leave the field; empty turns portraits off. Only the image prompt for a new card goes there; its token stays in the server's environment."}
      </p>
    </div>
  );
}
