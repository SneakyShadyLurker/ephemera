import {
  ART_FAMILIES,
  type ArtFamily,
  WORKFLOW_LIMITS,
  type WorkflowSummary,
  workflowInspectSchema,
} from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import { queryClient } from "@/app/query.ts";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { CautionIcon, SavingIcon } from "@/components/icons";
import { ReportGroup } from "@/components/import-report";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { countOf } from "@/lib/text";
import { artWorkflowsQuery } from "../creator/queries.ts";
import { FAMILY_NAMES } from "../settings/portraits.ts";
import { useSetting } from "../settings/settings.ts";
import { ConflictNotice } from "../sheet/ConflictNotice.tsx";
import { FIELD } from "../sheet/fields.ts";
import { useNotReached } from "../signin/hooks.ts";
import { identity } from "../signin/identity.ts";
import {
  API_NOT_REACHED,
  BLOCKED_COPY,
  DELETED_ELSEWHERE,
  FAMILY_HELP,
  fileRefusalText,
  INSPECT_BUSY,
  LIVE_MISSING,
  LIVE_READY,
  MISSING_HELP,
  refusalText,
  SAVE_FULL,
  uiNotReached,
  unchosenSummary,
} from "./copy.ts";
import { MappingList, MappingOutline } from "./MappingList.tsx";
import { mappingRows, otherNodes } from "./mapping.ts";
import { NodeLabel, OtherNodes } from "./OtherNodes.tsx";
import {
  blockedGroups,
  choiceProblem,
  type Draft,
  draftOf,
  INITIAL_PANEL,
  isDirty,
  type ListNames,
  nameCheck,
  type PanelAction,
  type PanelState,
  panelReducer,
  type ReadFile,
  reportOf,
  type SaveFailure,
  type SaveTarget,
  saveCheck,
} from "./panel-state.ts";
import {
  createWorkflow,
  inspectWorkflow,
  replaceWorkflowGraph,
  updateWorkflow,
  workflowsQuery,
} from "./queries.ts";
import { MissingList, StatusDot } from "./WorkflowRow.tsx";

const HELP = "text-pretty text-note text-reed";
/** A field beside its label, in the mapping list's 7rem column. */
const FIELD_ROW = "grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1";
const SMALL = "h-8 px-2.5 text-ink text-note touch:h-11";

/** A workflow file on its way in: a new import, or a replacement for one of the user's workflows. */
export type WorkflowDraft =
  | { mode: "import"; file: File }
  | { mode: "replace"; workflow: WorkflowSummary; file: File };

/** What the import panel gets from the Portraits section that holds the file picker. */
export interface ImportPanelProps {
  draft: WorkflowDraft;
  /** Another file chosen or dropped while this one is open, until `onIncoming` answers. */
  incoming: WorkflowDraft | null;
  /** Takes the incoming file in this one's place, or keeps this one. */
  onIncoming: (take: boolean) => void;
  /** Closes the panel; focus returns to Import a workflow, or to the replaced row's actions button. */
  onClose: () => void;
  /** Opens the file picker again, for the same mode. */
  onChooseFile: () => void;
  /** After a save: the panel closes and focus moves to the saved row's name. */
  onSaved: (id: string, checked: boolean) => void;
  /** Moves focus to the ComfyUI address field; the panel stays as it is. */
  onEditAddress: () => void;
}

const targetOf = (draft: WorkflowDraft): SaveTarget =>
  draft.mode === "replace"
    ? { mode: "replace", workflow: draft.workflow }
    : { mode: "create", id: crypto.randomUUID() };

/** The file's name as the inspect contract takes it, when it fits; it is never stored. */
const sentName = (fileName: string): { fileName?: string } => {
  const parsed = workflowInspectSchema.shape.fileName.safeParse(fileName);
  return parsed.success && parsed.data !== undefined ? { fileName: parsed.data } : {};
};

/**
 * A workflow file read, inspected and saved, inline under the list. The
 * file, its JSON, the graph and the draft stay in this component's state
 * and go with it; a file read and not saved asks before it is dropped.
 */
export function ImportPanel({
  draft,
  incoming,
  onIncoming,
  onClose,
  onChooseFile,
  onSaved,
  onEditAddress,
}: ImportPanelProps) {
  const [state, dispatch] = useReducer(panelReducer, INITIAL_PANEL);
  const heading = useRef<HTMLHeadingElement>(null);
  const requests = useRef(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const yours = useQuery(workflowsQuery).data ?? [];
  const servers = (useQuery(artWorkflowsQuery).data ?? [])
    .filter((option) => option.scope === "server")
    .map((option) => option.name);
  const names: ListNames = { yours, server: servers };
  const address = useSetting((settings) => settings.comfyuiBaseUrl);
  const notReached = useNotReached();
  const dirty = isDirty(state);

  // Opening moves focus to the heading, without summoning a keyboard.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, []);

  // A request the panel leaves (a new file, a close) is cancelled.
  const controller = state.phase === "reading" ? state.controller : null;
  useEffect(() => () => controller?.abort(), [controller]);

  const inspect = async (
    request: number,
    signal: AbortSignal,
    file: ReadFile,
    target: SaveTarget,
  ) => {
    const result = await inspectWorkflow(
      {
        source: file.source,
        ...sentName(file.fileName),
        ...(target.mode === "replace" ? { replacing: target.workflow.id } : {}),
      },
      signal,
    );
    // A cancelled request answers unreachable; the panel has moved on from it.
    if (signal.aborted) return;
    dispatch(
      result.ok
        ? { type: "inspected", request, inspection: result.value, target }
        : { type: "inspectFailed", request, failure: result },
    );
  };

  // Each accepted file is read once: its size, then its text as JSON, then the inspection.
  const [target, setTarget] = useState<SaveTarget>(() => targetOf(draft));
  const [readFile, setReadFile] = useState(draft.file);
  if (readFile !== draft.file) {
    setReadFile(draft.file);
    setTarget(targetOf(draft));
  }
  // Only a new file starts a read; its target was set with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one read per accepted file
  useEffect(() => {
    const file = draft.file;
    requests.current += 1;
    const request = requests.current;
    if (file.size > WORKFLOW_LIMITS.uploadBytes) {
      dispatch({
        type: "refused",
        request: null,
        fileName: file.name,
        refusal: { kind: "too_large" },
      });
      return;
    }
    const reading = new AbortController();
    dispatch({ type: "read", request, controller: reading, fileName: file.name });
    void (async () => {
      let source: unknown;
      try {
        source = JSON.parse(await file.text());
      } catch {
        if (!reading.signal.aborted) {
          dispatch({
            type: "refused",
            request,
            fileName: file.name,
            refusal: { kind: "not_json" },
          });
        }
        return;
      }
      if (reading.signal.aborted) return;
      const parsed = { fileName: file.name, source };
      dispatch({ type: "parsed", request, file: parsed });
      await inspect(request, reading.signal, parsed, target);
    })();
    return () => reading.abort();
  }, [draft.file]);

  const retry = () => {
    if (state.phase !== "failed" || state.stage !== "inspect") return;
    requests.current += 1;
    const request = requests.current;
    const again = new AbortController();
    dispatch({ type: "retry", request, controller: again });
    void inspect(request, again.signal, state.file, target);
  };

  // Another file: taken at once unless this one was read and not saved.
  useEffect(() => {
    if (incoming !== null && !dirty) onIncoming(true);
  }, [incoming, dirty, onIncoming]);
  const askIncoming = incoming !== null && dirty;

  // The blocker registers again whenever these change, so it reads this render's state.
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname && dirty,
    enableBeforeUnload: identity.guard(() => dirty),
    withResolver: true,
  });

  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onClose();
  };

  const save = async (revision?: number) => {
    const open = draftOf(state);
    if (open === null) return;
    dispatch({ type: "save" });
    const name = open.name.trim();
    const { family, choices } = open;
    const graph = open.inspection.graph;
    if (open.target.mode === "create") {
      const created = await createWorkflow({ id: open.target.id, name, family, graph, choices });
      if (!created.ok) {
        dispatch({ type: "saveFailed", failure: created });
        return;
      }
      dispatch({ type: "saved" });
      onSaved(created.value.workflow.id, created.value.checked);
      return;
    }
    const { workflow } = open.target;
    let checked = true;
    let current = open.graphRevision;
    if (current === null) {
      const latest = yours.find((row) => row.id === workflow.id) ?? workflow;
      const replaced = await replaceWorkflowGraph(workflow.id, {
        revision: revision ?? latest.revision,
        graph,
        choices,
      });
      if (!replaced.ok) {
        dispatch({ type: "saveFailed", failure: replaced });
        return;
      }
      checked = replaced.value.checked;
      current = replaced.value.workflow.revision;
      dispatch({ type: "graphSaved", revision: current });
    } else if (revision !== undefined) {
      current = revision;
    }
    const details = {
      ...(name !== workflow.name ? { name } : {}),
      ...(family !== workflow.family ? { family } : {}),
    };
    if (Object.keys(details).length > 0) {
      const updated = await updateWorkflow(workflow.id, { revision: current, ...details });
      if (!updated.ok) {
        dispatch({ type: "saveFailed", failure: updated });
        return;
      }
    }
    dispatch({ type: "saved" });
    onSaved(workflow.id, checked);
  };

  // Reload takes the saved workflow and drops this tab's file, or its rename once the file is in.
  const reload = async () => {
    const fetched = await queryClient.fetchQuery({ ...workflowsQuery, staleTime: 0 }).then(
      () => true,
      () => false,
    );
    if (!fetched) return;
    const open = draftOf(state);
    if (open?.target.mode === "replace" && open.graphRevision !== null) {
      dispatch({ type: "saved" });
      onSaved(open.target.workflow.id, true);
      return;
    }
    dispatch({ type: "close" });
    onClose();
  };

  return (
    <PanelView
      state={state}
      names={names}
      address={address}
      notReached={notReached}
      replacing={draft.mode === "replace" ? draft.workflow.name : null}
      headingRef={heading}
      dispatch={dispatch}
      onSave={(revision) => void save(revision)}
      onRetry={retry}
      onReload={reload}
      onImportAsNew={() => dispatch({ type: "importAsNew", id: crypto.randomUUID() })}
      onCancel={requestClose}
      onChooseFile={onChooseFile}
      onEditAddress={onEditAddress}
    >
      <ConfirmDialog
        open={blocker.status === "blocked" || confirmClose}
        onOpenChange={(open) => {
          if (open) return;
          setConfirmClose(false);
          blocker.reset?.();
        }}
        title="Discard this import?"
        description="The file is not saved. Its choices, name and family go with it."
        confirm="Discard"
        cancel="Keep importing"
        onCancel={() => blocker.reset?.()}
        onConfirm={() => {
          setConfirmClose(false);
          if (blocker.status === "blocked") blocker.proceed?.();
          else onClose();
        }}
      />
      <ConfirmDialog
        open={askIncoming}
        onOpenChange={(open) => !open && onIncoming(false)}
        title="Replace this import with the new file?"
        description={`${incoming?.file.name ?? "The new file"} is read in place of this one, whose choices, name and family are not saved.`}
        confirm="Replace"
        cancel="Keep this one"
        tone="primary"
        onCancel={() => onIncoming(false)}
        onConfirm={() => onIncoming(true)}
      />
    </PanelView>
  );
}

/** What the panel shows for a state: a pure render, so each state can be checked without a DOM. */
export function PanelView({
  state,
  names,
  address,
  notReached,
  replacing,
  headingRef,
  dispatch,
  onSave,
  onRetry,
  onReload,
  onImportAsNew,
  onCancel,
  onChooseFile,
  onEditAddress,
  children,
}: {
  state: PanelState;
  names: ListNames;
  address: string;
  notReached: string;
  /** The name of the workflow whose file is replaced, as the panel opened. */
  replacing: string | null;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  dispatch: (action: PanelAction) => void;
  onSave: (revision?: number) => void;
  onRetry: () => void;
  onReload: () => Promise<unknown>;
  onImportAsNew: () => void;
  onCancel: () => void;
  onChooseFile: () => void;
  onEditAddress: () => void;
  children?: ReactNode;
}) {
  const headingId = useId();
  const draft = draftOf(state);
  const saving = state.phase === "saving";
  const replace =
    draft === null
      ? replacing
      : draft.target.mode === "replace"
        ? draft.target.workflow.name
        : null;
  const check = saveCheck(state, names);
  const fileName =
    state.phase === "idle"
      ? null
      : state.phase === "reading" || state.phase === "refused"
        ? state.fileName
        : state.file.fileName;
  const fileLine =
    draft === null
      ? fileName
      : `${fileName}, ${draft.inspection.format === "ui" ? "saved workflow" : "API format"}, ${countOf(draft.inspection.nodes.length, "node")}`;
  const refused = state.phase === "refused";
  const stalled = state.phase === "failed" && state.stage === "inspect" ? state.failure : null;
  const failure = state.phase === "failed" && state.stage === "save" ? state.failure : null;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={state.phase === "reading"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          // The discard prompt this may open must not take the same Escape as its own dismissal.
          event.stopPropagation();
          onCancel();
        }
      }}
      className="grid max-w-xl gap-6 rounded-xl border border-rush bg-surface p-4 transition-[opacity,translate] duration-(--duration-panel-in) ease-spring starting:translate-y-(--rise) starting:opacity-0 tablet:p-5"
    >
      <div className="grid gap-0.5">
        <h3
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="text-pretty break-words font-semibold text-ink text-lead outline-none"
        >
          {replace === null ? "Import a workflow" : `Replace the file of ${replace}`}
        </h3>
        {fileLine !== null && <p className={cn(HELP, "break-words")}>{fileLine}</p>}
      </div>

      {state.phase === "reading" && (
        <>
          <p className="flex items-center gap-2 break-words text-note text-reed">
            <SavingIcon
              size={16}
              className="shrink-0 animate-[breathe_1.2s_var(--ease-breath)_infinite_alternate] motion-reduce:animate-none"
            />
            Reading {state.fileName}
          </p>
          <MappingOutline />
        </>
      )}

      {refused && (
        <div role="alert" className="grid gap-1 arrive">
          <h4 className="text-pretty break-words font-medium text-ember text-ui">
            Cannot import {state.fileName}
          </h4>
          <p className="text-pretty text-ink text-note">
            {state.refusal.kind === "invalid_workflow"
              ? refusalText(state.refusal.code, state.refusal.nodes)
              : fileRefusalText(state.fileName, state.refusal)}
          </p>
        </div>
      )}

      {(stalled === "busy" || stalled === "unreachable") && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 arrive">
          <p role="alert" className="text-pretty text-ink text-note">
            {stalled === "busy" ? INSPECT_BUSY : `The file was not read: ${notReached}.`}
          </p>
          <Button variant="outline" className={SMALL} onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}

      {draft !== null && <DraftBody draft={draft} disabled={saving} dispatch={dispatch} />}

      {state.phase !== "idle" &&
        !refused &&
        (stalled === null || stalled === "comfyui_required") && (
          <div className="grid gap-2">
            <h4 className="font-medium text-ink text-ui">On your ComfyUI</h4>
            <div role="status" className="grid gap-2">
              {stalled === "comfyui_required" ? (
                <div className="grid justify-items-start gap-2 arrive">
                  <p className="flex items-baseline gap-2 text-pretty text-ink text-note">
                    <CautionIcon size={16} className="shrink-0 translate-y-[0.2em] text-ember" />
                    {uiNotReached(address)}
                  </p>
                  <div className="-ml-2.5 flex flex-wrap gap-1">
                    <Button className={SMALL} onClick={onRetry}>
                      Try again
                    </Button>
                    <Button className={SMALL} onClick={onEditAddress}>
                      Edit the address
                    </Button>
                    <Button className={SMALL} onClick={onChooseFile}>
                      Choose another file
                    </Button>
                  </div>
                </div>
              ) : (
                draft !== null && <LiveStatus draft={draft} />
              )}
            </div>
          </div>
        )}

      {draft !== null && (
        <Fields draft={draft} names={names} disabled={saving} dispatch={dispatch} />
      )}

      {failure !== null && (
        <SaveFailureNotice
          failure={failure}
          notReached={notReached}
          onRetry={() => onSave()}
          onKeepMine={(revision) => onSave(revision)}
          onReload={onReload}
          onImportAsNew={onImportAsNew}
          onChooseFile={onChooseFile}
        />
      )}

      {check.unchosen > 0 && <p className={HELP}>{unchosenSummary(check.unchosen)}</p>}

      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-2 rounded-b-xl border-rush border-t bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] tablet:static tablet:mx-0 tablet:mb-0 tablet:border-0 tablet:bg-transparent tablet:p-0">
        <span className="flex-1" />
        {(refused || stalled === "busy" || stalled === "unreachable") && (
          <Button variant="outline" onClick={onChooseFile}>
            Choose another file
          </Button>
        )}
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        {!refused && (
          <Button variant="primary" disabled={!check.enabled} onClick={() => onSave()}>
            {saving ? (
              <>
                <SavingIcon
                  size={16}
                  className="animate-[breathe_1.2s_var(--ease-breath)_infinite_alternate] motion-reduce:animate-none"
                />
                Saving
              </>
            ) : replace !== null ? (
              "Replace file"
            ) : (
              "Save workflow"
            )}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

/** The mapping, the rest of the graph, what changes and what cannot run. */
function DraftBody({
  draft,
  disabled,
  dispatch,
}: {
  draft: Draft;
  disabled: boolean;
  dispatch: (action: PanelAction) => void;
}) {
  const report = reportOf(draft);
  const problem = choiceProblem(draft);
  const blocked = blockedGroups(draft);
  return (
    <>
      <MappingList
        rows={mappingRows(draft)}
        disabled={disabled}
        onChoose={(place, node) => dispatch({ type: "choose", place, node })}
      />
      {problem !== null && (
        <p role="alert" className="text-pretty text-ember text-note">
          {problem}
        </p>
      )}
      <OtherNodes nodes={otherNodes(draft)} />
      {report.changed.length + report.skipped.length > 0 && (
        <div className="grid gap-3 text-note">
          <ReportGroup title="Changed" items={report.changed} heading="h4" />
          <ReportGroup title="Left out" items={report.skipped} heading="h4" />
        </div>
      )}
      {blocked.length > 0 && (
        <div className="grid gap-2">
          <h4 className="flex items-baseline gap-2 font-medium text-ember text-ui">
            <CautionIcon size={16} className="shrink-0 translate-y-[0.2em]" />
            Ephemera cannot run these nodes
          </h4>
          <div className="grid gap-3 border-ember/40 border-l pl-4 text-note">
            {blocked.map((group) => (
              <div key={group.reason} className="grid gap-1">
                <p className="text-pretty text-ink">{BLOCKED_COPY[group.reason]}</p>
                <ul className="grid gap-0.5 text-ember">
                  {group.nodes.map((node) => (
                    <li key={node.id} className="break-words">
                      <NodeLabel title={node.title} node={node.id} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** The one summary "On your ComfyUI" announces once the inspection lands. */
function LiveStatus({ draft }: { draft: Draft }) {
  const { live } = draft.inspection;
  if (live.state === "ready") {
    return (
      <p className="flex items-baseline gap-2.5 text-ink text-note arrive">
        <StatusDot tone="ready" />
        {LIVE_READY}
      </p>
    );
  }
  if (live.state === "missing") {
    return (
      <div className="grid gap-2 arrive">
        <p className="flex items-baseline gap-2 text-pretty text-ink text-note">
          <CautionIcon size={16} className="shrink-0 translate-y-[0.2em] text-ember" />
          {LIVE_MISSING}
        </p>
        <MissingList nodes={live.nodes} models={live.models} />
        <p className={HELP}>{MISSING_HELP}</p>
      </div>
    );
  }
  return <p className={cn(HELP, "arrive")}>{API_NOT_REACHED}</p>;
}

/** The name and family the workflow is saved under. */
function Fields({
  draft,
  names,
  disabled,
  dispatch,
}: {
  draft: Draft;
  names: ListNames;
  disabled: boolean;
  dispatch: (action: PanelAction) => void;
}) {
  const nameId = useId();
  const familyId = useId();
  const { problem, note } = nameCheck(draft, names);
  const guess = draft.inspection.detection.familyGuess;
  return (
    <div className="grid gap-4">
      <div className={FIELD_ROW}>
        <label htmlFor={nameId} className="pt-2 font-medium text-ink text-ui touch:pt-3">
          Name
        </label>
        <div className="grid min-w-0 gap-1">
          <input
            id={nameId}
            autoComplete="off"
            spellCheck={false}
            maxLength={WORKFLOW_LIMITS.nameLength}
            disabled={disabled}
            aria-invalid={problem !== null}
            aria-describedby={problem !== null || note !== null ? `${nameId}-help` : undefined}
            value={draft.name}
            onChange={(event) => dispatch({ type: "name", name: event.target.value })}
            className={cn(
              FIELD,
              "h-9 max-w-sm py-0 text-ui touch:h-11",
              problem !== null && "border-ember",
            )}
          />
          {(problem !== null || note !== null) && (
            <p
              id={`${nameId}-help`}
              className={cn("text-pretty text-note", problem !== null ? "text-ember" : "text-reed")}
            >
              {problem ?? note}
            </p>
          )}
        </div>
      </div>
      <div className={FIELD_ROW}>
        <span id={familyId} className="pt-2 font-medium text-ink text-ui touch:pt-3">
          Family
        </span>
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Select
              value={draft.family}
              disabled={disabled}
              onValueChange={(value) => {
                const family = ART_FAMILIES.find((option) => option === value);
                if (family !== undefined) dispatch({ type: "family", family });
              }}
            >
              <SelectTrigger aria-labelledby={familyId} placeholder="Family" className="w-40">
                {FAMILY_NAMES[draft.family]}
              </SelectTrigger>
              <SelectContent label="Families">
                {ART_FAMILIES.map((family: ArtFamily) => (
                  <SelectItem key={family} value={family}>
                    {FAMILY_NAMES[family]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-note text-reed">Looks like {FAMILY_NAMES[guess]}</span>
          </div>
          <p
            key={draft.family}
            className="text-pretty text-note text-reed transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
          >
            {FAMILY_HELP[draft.family]}
          </p>
        </div>
      </div>
    </div>
  );
}

/** A save that did not go through, and its way on; the draft stays. */
function SaveFailureNotice({
  failure,
  notReached,
  onRetry,
  onKeepMine,
  onReload,
  onImportAsNew,
  onChooseFile,
}: {
  failure: SaveFailure;
  notReached: string;
  onRetry: () => void;
  onKeepMine: (revision: number) => void;
  onReload: () => Promise<unknown>;
  onImportAsNew: () => void;
  onChooseFile: () => void;
}) {
  switch (failure.kind) {
    case "conflict":
      return (
        <ConflictNotice
          noun="workflow"
          placement="inline"
          onReload={onReload}
          onKeepMine={() => onKeepMine(failure.revision)}
        />
      );
    case "full":
      return (
        <p role="alert" className="text-pretty text-ember text-note arrive">
          {SAVE_FULL}
        </p>
      );
    case "not_found":
    case "unreachable":
    case "refused": {
      const [text, action, run] =
        failure.kind === "not_found"
          ? [DELETED_ELSEWHERE, "Import as new", onImportAsNew]
          : failure.kind === "unreachable"
            ? [`Not saved: ${notReached}.`, "Try again", onRetry]
            : [refusalText(failure.code, failure.nodes), "Choose another file", onChooseFile];
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 arrive">
          <p role="alert" className="text-pretty text-ember text-note">
            {text}
          </p>
          <Button variant="outline" className={SMALL} onClick={run}>
            {action}
          </Button>
        </div>
      );
    }
  }
}
