import {
  conflictSchema,
  DEFAULT_SETTINGS,
  type Inspection,
  inspectionSchema,
  userWorkflowId,
  type WorkflowCreate,
  type WorkflowGraphReplace,
  type WorkflowInspect,
  type WorkflowPatch,
  type WorkflowRefusalCode,
  type WorkflowSummary,
  workflowDeleteResponseSchema,
  workflowResponseSchema,
  workflowSavedResponseSchema,
  workflowSaveErrorSchema,
  workflowsResponseSchema,
} from "@ephemera/core";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../api.ts";
import { queryClient } from "../app/query.ts";
import { ART_STATUS_KEY, artWorkflowsQuery } from "../creator/queries.ts";
import { applySettings, currentSettings, fetchSavedSettings } from "../settings/settings.ts";
import { SAVE_TIMEOUT_MS, unsafeOptions } from "../sheet/saving.ts";

/*
 * The user's imported workflows (PRINCIPLES.md 1: configuration, kept on the
 * server). Only the list rows, which never carry a graph, are cached. The
 * graph-bearing requests are plain functions, not mutations, so neither the
 * query cache nor the mutation cache ever holds a graph.
 */

/** The user's workflows as the server lists them now. */
async function listWorkflows(signal: AbortSignal): Promise<WorkflowSummary[]> {
  const response = await api.workflows.$get(undefined, { init: { signal } });
  if (!response.ok) throw new Error("unavailable");
  return workflowsResponseSchema.parse(await response.json()).workflows;
}

export const workflowsQuery = queryOptions({
  queryKey: ["workflows"],
  queryFn: ({ signal }) => listWorkflows(signal),
});

type PlainReason = "busy" | "comfyui_required" | "full" | "name_taken" | "not_found" | "too_large";

/**
 * Why a workflow request failed, as the routes answer. "unreachable" is
 * anything else (offline, cancelled, a proxy's page), said with `notReached()`.
 */
export type WorkflowFailure =
  | { [R in PlainReason]: { ok: false; reason: R } }[PlainReason]
  | { ok: false; reason: "invalid_workflow"; code: WorkflowRefusalCode; nodes: string[] }
  | { ok: false; reason: "blocked_nodes"; nodes: string[] }
  | { ok: false; reason: "conflict"; revision: number }
  | { ok: false; reason: "unreachable" };

type Reason = WorkflowFailure["reason"];

/** A request's answer: the parsed response, or only the failures its route can give. */
export type WorkflowResult<Value, Reasons extends Reason> =
  | { ok: true; value: Value }
  | FailureAmong<Reasons>;

/** The failures among `Reasons`; any request can be unreachable. */
type FailureAmong<Reasons extends Reason> = Extract<
  WorkflowFailure,
  { reason: Reasons | "unreachable" }
>;

/** Every refusal body the routes send, beside the save refusals core describes. */
const refusalSchema = z.union([
  workflowSaveErrorSchema,
  conflictSchema,
  z.strictObject({ error: z.enum(["busy", "comfyui_required", "not_found", "payload_too_large"]) }),
]);
type Refusal = z.infer<typeof refusalSchema>;

/** Each refusal's status; the same body under another is not Ephemera's answer. */
const REFUSAL_STATUS: Record<Refusal["error"], number> = {
  busy: 429,
  comfyui_required: 409,
  invalid_workflow: 422,
  blocked_nodes: 422,
  full: 413,
  payload_too_large: 413,
  name_taken: 409,
  conflict: 409,
  not_found: 404,
};

function failureOf(refusal: Refusal): WorkflowFailure {
  switch (refusal.error) {
    case "invalid_workflow":
      return { ok: false, reason: refusal.error, code: refusal.code, nodes: refusal.nodes ?? [] };
    case "blocked_nodes":
      return { ok: false, reason: refusal.error, nodes: refusal.nodes };
    case "conflict":
      return { ok: false, reason: refusal.error, revision: refusal.revision };
    case "payload_too_large":
      return { ok: false, reason: "too_large" };
    default:
      return { ok: false, reason: refusal.error };
  }
}

const among = <Reasons extends Reason>(
  failure: WorkflowFailure,
  reasons: readonly Reasons[],
): failure is FailureAmong<Reasons> => {
  const listed: readonly Reason[] = reasons;
  return listed.includes(failure.reason);
};

/**
 * Sends one request and reads its answer: `read` parses a success; a
 * refusal counts only under its own status and among the route's `reasons`.
 */
async function requesting<Value, Reasons extends Reason>(
  send: () => Promise<Response>,
  read: (body: unknown) => Value,
  reasons: readonly Reasons[],
): Promise<WorkflowResult<Value, Reasons>> {
  try {
    const response = await send();
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) return { ok: true, value: read(body) };
    const refusal = refusalSchema.safeParse(body);
    if (refusal.success && REFUSAL_STATUS[refusal.data.error] === response.status) {
      const failure = failureOf(refusal.data);
      if (among(failure, reasons)) return failure;
    }
  } catch {
    // Offline, cancelled, signed out or an answer that does not parse.
  }
  return { ok: false, reason: "unreachable" };
}

/** After a write, or a refusal that shows the tab is behind: the list, the picker's workflows and every workflow's status ask again. */
export async function refreshWorkflows(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: workflowsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: artWorkflowsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ART_STATUS_KEY }),
  ]);
}

/** Runs `refreshWorkflows` after a write that succeeded. */
async function written<Result extends { ok: boolean }>(result: Promise<Result>): Promise<Result> {
  const answer = await result;
  if (answer.ok) await refreshWorkflows();
  return answer;
}

/*
 * The graph routes read their bounded body themselves, so the typed client
 * declares no `json` for them; it sends one all the same, typed here by core.
 */

/** A save's client options: the timeout, for the edits that carry no graph. */
const saveInit = () => ({ init: { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) } });

/** Reads a file into what the import panel shows; `signal` cancels it. */
export async function inspectWorkflow(
  body: WorkflowInspect,
  signal: AbortSignal,
): Promise<
  WorkflowResult<Inspection, "busy" | "comfyui_required" | "invalid_workflow" | "too_large">
> {
  const ask = () =>
    requesting(
      () => api.workflows.inspect.$post({ json: body }, { init: { signal } }),
      (answer) => inspectionSchema.parse(answer),
      ["busy", "comfyui_required", "invalid_workflow", "too_large"],
    );
  let result = await ask();
  // Busy right after this tab let go of a read is mostly that read still ending on the
  // server, so it is asked again, a moment apart, before the panel says so.
  for (let retry = 0; retry < BUSY_RETRIES && !result.ok && result.reason === "busy"; retry++) {
    if (!(await pause(BUSY_PAUSE_MS, signal))) break;
    result = await ask();
  }
  return result;
}

const BUSY_RETRIES = 2;
const BUSY_PAUSE_MS = 400;

/** Waits `ms`; false when `signal` aborts first. */
const pause = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => resolve(true), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });

/**
 * Saves an inspected graph as a new workflow. No timeout: the server checks
 * it against the live ComfyUI under its own deadline, and the id the tab
 * chose keeps a retry from making a second one.
 */
export function createWorkflow(
  body: WorkflowCreate,
): Promise<
  WorkflowResult<
    z.infer<typeof workflowSavedResponseSchema>,
    "invalid_workflow" | "blocked_nodes" | "full" | "name_taken" | "too_large"
  >
> {
  return written(
    requesting(
      () => api.workflows.$post({ json: body }),
      (answer) => workflowSavedResponseSchema.parse(answer),
      ["invalid_workflow", "blocked_nodes", "full", "name_taken", "too_large"],
    ),
  );
}

/**
 * The user's workflow `id` as the list shows it now, null when the list
 * lacks it, or unreachable when the list did not answer: a create whose
 * answer was lost is looked up this way before it is sent again. Its own
 * request, so a list request that left before the create landed never
 * answers it; the list query takes the rows it found.
 */
export async function findWorkflow(
  id: string,
): Promise<WorkflowResult<WorkflowSummary | null, never>> {
  try {
    const rows = await listWorkflows(AbortSignal.timeout(SAVE_TIMEOUT_MS));
    queryClient.setQueryData(workflowsQuery.queryKey, rows);
    return { ok: true, value: rows.find((row) => row.id === id) ?? null };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/** Renames a workflow or changes its family, against `body.revision`. */
export function updateWorkflow(
  id: string,
  body: WorkflowPatch,
): Promise<
  WorkflowResult<z.infer<typeof workflowResponseSchema>, "name_taken" | "conflict" | "not_found">
> {
  return written(
    requesting(
      () => api.workflows[":id"].$patch({ param: { id }, json: body }, saveInit()),
      (answer) => workflowResponseSchema.parse(answer),
      ["name_taken", "conflict", "not_found"],
    ),
  );
}

/** Replaces a workflow's graph with a newly inspected one; no timeout, as a create. */
export function replaceWorkflowGraph(
  id: string,
  body: WorkflowGraphReplace,
): Promise<
  WorkflowResult<
    z.infer<typeof workflowSavedResponseSchema>,
    "invalid_workflow" | "blocked_nodes" | "conflict" | "not_found" | "too_large"
  >
> {
  return written(
    requesting(
      () => {
        const args = { param: { id }, json: body };
        return api.workflows[":id"].graph.$put(args);
      },
      (answer) => workflowSavedResponseSchema.parse(answer),
      ["invalid_workflow", "blocked_nodes", "conflict", "not_found", "too_large"],
    ),
  );
}

/**
 * Deletes a workflow. When this tab chose it, the tab takes the workflow the
 * server's settings fall back to, and nothing else of them (each tab owns its
 * settings): from the delete's answer, or, when another tab deleted it first,
 * from the saved settings.
 */
export async function deleteWorkflow(
  id: string,
): Promise<WorkflowResult<z.infer<typeof workflowDeleteResponseSchema>, "not_found">> {
  const result = await requesting(
    () => api.workflows[":id"].$delete({ param: { id } }, unsafeOptions()),
    (answer) => workflowDeleteResponseSchema.parse(answer),
    ["not_found"],
  );
  const chosen = () => currentSettings().comfyuiWorkflow === userWorkflowId(id);
  if (result.ok) {
    if (chosen()) applySettings({ comfyuiWorkflow: result.value.settings.comfyuiWorkflow });
    await refreshWorkflows();
  } else if (result.reason === "not_found" && chosen()) {
    const saved = await fetchSavedSettings().catch(() => undefined);
    if (chosen()) {
      applySettings({
        comfyuiWorkflow: saved?.comfyuiWorkflow ?? DEFAULT_SETTINGS.comfyuiWorkflow,
      });
    }
  }
  return result;
}
