import { settingsSchema, WORKFLOW_LIMITS, type WorkflowSummary } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { queryClient } from "@/app/query.ts";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { DropOverlay, useFileDrop } from "@/components/file-drop";
import { ModelSelect } from "@/components/model-select";
import { cn } from "@/lib/cn";
import { useModelOptions } from "../api.ts";
import { ART_STATUS_KEY } from "../creator/queries.ts";
import { FOCUS_WITHIN } from "../sheet/fields.ts";
import { SAVED_UNCHECKED } from "../workflows/copy.ts";
import { ImportPanel, type WorkflowDraft } from "../workflows/ImportPanel.tsx";
import { workflowsQuery } from "../workflows/queries.ts";
import { Workflows } from "../workflows/Workflows.tsx";
import { ROW_SELECT, SettingGroup, SettingRow } from "./SettingRow.tsx";
import {
  applySettings,
  queueSettingsSave,
  type SaveError,
  useRefusedAddress,
  useSetting,
  useUpdateSettings,
} from "./settings.ts";
import { WindowNote } from "./WindowNote.tsx";

/** The image prompt model choice that leaves each surface on its own default; never a model id. */
const CHAT_MODEL = "";
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

/**
 * Settings > Pictures: the model that writes image prompts, the owner's
 * ComfyUI address, and the workflows it paints with and whether each can
 * paint now. The workflow is chosen where portraits are made, in Create with
 * AI. A workflow file comes in through the file picker, or dropped anywhere
 * on this category on tablet and desktop; `ImportPanel` shows it, under the
 * list. A file arriving while one is open waits as `incoming` until the panel
 * takes it or keeps its own.
 */
export function Pictures() {
  const comfyuiBaseUrl = useSetting((settings) => settings.comfyuiBaseUrl);
  const count = useQuery(workflowsQuery).data?.length ?? 0;
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [incoming, setIncoming] = useState<WorkflowDraft | null>(null);
  // The workflow just saved, whose name takes focus once the list shows it.
  const [saved, setSaved] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  // The workflow Replace file was chosen for, until the picker answers.
  const replacing = useRef<WorkflowSummary | null>(null);
  const full = count >= WORKFLOW_LIMITS.workflows;
  // A file that arrived while a save was in flight opens once that save closed the panel.
  if (draft === null && incoming !== null) {
    setDraft(incoming);
    setIncoming(null);
  }
  const offer = (next: WorkflowDraft) => {
    setUnchecked(false);
    if (draft === null) setDraft(next);
    else setIncoming(next);
  };
  const { dragging, dropTarget } = useFileDrop((files) => {
    const [file] = files;
    if (file !== undefined && !full) offer({ mode: "import", file });
  });

  const choose = (workflow: WorkflowSummary | null) => {
    replacing.current = workflow;
    picker.current?.click();
  };

  // After the commit that shows the saved row, its name takes focus; Import, when the list
  // could not be refreshed to show it.
  useEffect(() => {
    if (saved === null) return;
    (rowPart(root.current, saved, "name") ?? importButton.current)?.focus();
    setSaved(null);
  }, [saved]);

  return (
    <div ref={root} className="relative grid gap-6" {...dropTarget}>
      <SettingGroup>
        <ImagePromptModel />
        <AddressField saved={comfyuiBaseUrl} inputRef={address} />
        <div className="py-3.5">
          <Workflows
            importRef={importButton}
            notice={unchecked ? SAVED_UNCHECKED : null}
            onImport={() => choose(null)}
            onReplace={(workflow) => choose(workflow)}
            about={
              <>
                <p>
                  The ComfyUI graphs pictures are painted with. Yours are the ones you import:
                  rename them, set their image model family, replace their file or delete them.
                </p>
                <p>
                  On this server are the ones the server ships. Each row says whether it can paint
                  now, and the one Create with AI uses says In use. Up to{" "}
                  {WORKFLOW_LIMITS.workflows} of yours.
                </p>
              </>
            }
          />
        </div>
      </SettingGroup>
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
          offer(workflow === null ? { mode: "import", file } : { mode: "replace", workflow, file });
        }}
      />
      {draft !== null && (
        <ImportPanel
          draft={draft}
          incoming={incoming}
          onIncoming={(take) => {
            if (take && incoming !== null) setDraft(incoming);
            setIncoming(null);
          }}
          onClose={() => {
            const replaced = draft.mode === "replace" ? draft.workflow.id : null;
            setDraft(null);
            setIncoming(null);
            (replaced === null
              ? importButton.current
              : rowPart(root.current, replaced, "actions")
            )?.focus();
          }}
          onChooseFile={() => choose(draft.mode === "replace" ? draft.workflow : null)}
          onSaved={(id, checked) => {
            setDraft(null);
            setUnchecked(!checked);
            setSaved(id);
          }}
          onEditAddress={() => {
            address.current?.focus({ preventScroll: true });
            address.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
          }}
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

/** Writes the prompts for portraits and scene pictures; unset, each surface's own default. */
function ImagePromptModel() {
  const imagePromptModel = useSetting((settings) => settings.imagePromptModel);
  const updateSettings = useUpdateSettings();
  const options = useModelOptions(imagePromptModel);
  const labelId = useId();
  return (
    <SettingRow
      label="Image prompt model"
      labelId={labelId}
      about={
        <p>
          Writes the image prompts for portraits and scene pictures, from the card and the scene.
          The chat model unless you pick another; Create with AI and the art studio can still choose
          one per picture.
        </p>
      }
      below={<WindowNote model={imagePromptModel} />}
    >
      <ModelSelect
        labelId={labelId}
        options={options}
        lead={{ value: CHAT_MODEL, label: "The chat model" }}
        value={imagePromptModel ?? CHAT_MODEL}
        onChange={(model) =>
          updateSettings({ imagePromptModel: model === CHAT_MODEL ? null : model })
        }
        className={ROW_SELECT}
      />
    </SettingRow>
  );
}

/** A workflow row's actions button or name, inside the category. */
const rowPart = (root: HTMLElement | null, id: string, part: "actions" | "name") =>
  root
    ?.querySelector(`[data-workflow="${CSS.escape(id)}"]`)
    ?.querySelector<HTMLElement>(`[data-workflow-${part}]`);

function AddressField({
  saved,
  inputRef,
}: {
  saved: string;
  /** Where Edit the address in the import panel moves focus. */
  inputRef: RefObject<HTMLInputElement | null>;
}) {
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
    <SettingRow
      label="ComfyUI address"
      htmlFor={id}
      hint={
        shown !== null
          ? ADDRESS_PROBLEMS[shown]
          : "Saved when you leave the field; empty turns pictures off."
      }
      hintId={`${id}-help`}
      problem={invalid}
      live
      about={
        <p>
          Where Ephemera sends image prompts for portraits and scene pictures. Clear the field to
          turn pictures off.
        </p>
      }
    >
      <div
        className={cn(
          "flex h-9 items-center rounded-md border border-control-edge bg-surface px-3 touch:h-11",
          ROW_SELECT,
          FOCUS_WITHIN,
          invalid && "border-ember",
        )}
      >
        <input
          ref={inputRef}
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
    </SettingRow>
  );
}
