import { creatorArtWorkflowsSchema, userWorkflowId, userWorkflowUuid } from "@ephemera/core";
import type { Stores, WorkflowStore } from "../persistence/store.ts";
import type { NodeAllowlist } from "./allowlist.ts";
import {
  describeWorkflow,
  type ServerWorkflows,
  type Workflow,
  type WorkflowId,
  type WorkflowList,
} from "./workflow.ts";

/*
 * The workflows one request may run: the user's own (`user-<uuid>`) and the
 * server's, merged per request from the user's store and the server set
 * built at startup. Nothing here outlives the request, so no user's graph
 * reaches another request or another user, and a replaced or deleted graph
 * is never served stale.
 */

/** The `blocked` entry of a stored graph `describeWorkflow` cannot read. */
export const INVALID_GRAPH = "invalid_graph";

/** A workflow as the catalog gives it. */
export interface CatalogWorkflow extends Workflow {
  /**
   * Classes the allowlist no longer admits for an imported graph (an operator
   * removed one from the env list): the workflow stays listed, never runs.
   * Always empty for a server workflow, which the start already checked.
   * `INVALID_GRAPH` marks a stored graph that cannot run at all.
   */
  blocked: readonly string[];
}

/** What a run takes, resolved when the request is admitted: a delete or replace since changes nothing. */
export interface RunWorkflow extends CatalogWorkflow {
  id: WorkflowId;
  /** The reference graph, when the server workflow has one. */
  reference?: Workflow;
}

export interface WorkflowCatalog {
  /** The user's workflows by name ("Yours"), then the server's in file name order. */
  list: WorkflowList;
  has(id: WorkflowId): boolean;
  /** The workflow `requested` admitted; an unknown id throws. */
  get(id: WorkflowId): CatalogWorkflow;
  /** A saved choice that is gone reads as the default. */
  known(id: WorkflowId): WorkflowId;
  /**
   * The workflow a request runs: the one it names, which must exist (never
   * another in its place), or, when it names none, the saved one. Undefined
   * refuses the request.
   */
  requested(named: WorkflowId | undefined, saved: WorkflowId): WorkflowId | undefined;
  /** A server workflow's reference graph; a user workflow has none. */
  referenceOf(id: WorkflowId): Workflow | undefined;
  /** Always a server workflow. */
  defaultWorkflow: WorkflowId;
}

/** How a route reaches its request's catalog: from the requester's own stores (user.ts). */
export type CatalogFor = (c: {
  var: { user: { stores: Pick<Stores, "workflows"> } };
}) => WorkflowCatalog;

/** The catalog of one request, over the server set, the requester's store and the server's node policy. */
export function createWorkflowCatalog(
  server: ServerWorkflows,
  store: WorkflowStore,
  allowlist: NodeAllowlist,
): WorkflowCatalog {
  const rows = store.list();
  const stored = new Set(rows.map((row) => row.id));
  /** The stored row's uuid when `id` names one of the user's workflows. */
  const userUuid = (id: WorkflowId) => {
    const uuid = userWorkflowUuid(id);
    return uuid !== undefined && stored.has(uuid) ? uuid : undefined;
  };
  const has = (id: WorkflowId) => userUuid(id) !== undefined || server.has(id);
  const known = (id: WorkflowId) => (has(id) ? id : server.defaultWorkflow);
  const list = creatorArtWorkflowsSchema.parse({
    workflows: [
      ...rows.map(({ id, name, family }) => ({
        id: userWorkflowId(id),
        name,
        family,
        scope: "user",
      })),
      ...server.list.workflows,
    ],
  });
  return {
    list,
    has,
    get(id) {
      const uuid = userUuid(id);
      if (uuid === undefined) return { ...server.get(id), blocked: [] };
      const row = store.get(uuid);
      if (row === undefined) throw new Error("workflow has no graph");
      const classes = new Set(Object.values(row.graph).map((node) => node.class_type));
      const blocked = [...classes].filter((name) => !allowlist.allows(name, "import"));
      try {
        return { ...describeWorkflow(row.graph, row.family), blocked };
      } catch {
        // A stored graph no save could have written stays listed and never runs.
        return {
          graph: row.graph,
          output: "",
          models: [],
          family: row.family,
          blocked: [...blocked, INVALID_GRAPH],
        };
      }
    },
    known,
    requested: (named, saved) =>
      named === undefined ? known(saved) : has(named) ? named : undefined,
    referenceOf: (id) => (userUuid(id) === undefined ? server.referenceOf(id) : undefined),
    defaultWorkflow: server.defaultWorkflow,
  };
}

/** The workflow `id` as a run takes it, with its reference graph when it has one; an unknown id throws. */
export function runWorkflow(catalog: WorkflowCatalog, id: WorkflowId): RunWorkflow {
  const reference = catalog.referenceOf(id);
  return { id, ...catalog.get(id), ...(reference === undefined ? {} : { reference }) };
}
