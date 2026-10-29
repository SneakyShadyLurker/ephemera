import {
  apiGraphSchema,
  DEFAULT_SETTINGS,
  type StoredWorkflow,
  userWorkflowId,
  WORKFLOW_LIMITS,
  type WorkflowFields,
  type WorkflowGraph,
  type WorkflowSummary,
  workflowFieldsSchema,
  workflowUuidSchema,
} from "@ephemera/core";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { revised } from "./revised.ts";
import { settings, workflows } from "./schema.ts";
import type { Patch, Updated, WorkflowCreation, WorkflowStore } from "./store.ts";

/** The metadata edit: strict, so a graph key is refused rather than ignored. */
const workflowMetaPatchSchema = workflowFieldsSchema.pick({ name: true, family: true }).partial();

const nodeCount = (graph: WorkflowGraph) => Object.keys(graph).length;

/**
 * The user's imported workflows. Every write parses the core workflow
 * schemas first, as the other stores do (PRINCIPLES.md 1); the allowlist and
 * the live check are the route's, applied before the store is called. A
 * graph is configuration, never chat content, and nothing here logs.
 * Removing the workflow the settings choose returns them to
 * `defaultWorkflow`, the server's, in the same transaction.
 */
export function createWorkflowStore(
  db: Db,
  defaultWorkflow: string = DEFAULT_SETTINGS.comfyuiWorkflow,
): WorkflowStore {
  const now = () => Date.now();

  const stored = {
    id: workflows.id,
    name: workflows.name,
    family: workflows.family,
    graph: workflows.graph,
    revision: workflows.revision,
    createdAt: workflows.createdAt,
    updatedAt: workflows.updatedAt,
  };

  const get = (id: string): StoredWorkflow | undefined =>
    db.select(stored).from(workflows).where(eq(workflows.id, id)).get();

  /** Whether a workflow other than `except` goes by `name` in any case. */
  const nameTaken = (name: string, except: string) =>
    db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(sql`${workflows.name} = ${name} COLLATE NOCASE`, ne(workflows.id, except)))
      .get() !== undefined;

  return {
    get,

    list(): WorkflowSummary[] {
      return db
        .select({
          id: workflows.id,
          name: workflows.name,
          family: workflows.family,
          nodes: workflows.nodes,
          revision: workflows.revision,
          updatedAt: workflows.updatedAt,
        })
        .from(workflows)
        .orderBy(sql`${workflows.name} COLLATE NOCASE`, asc(workflows.id))
        .all();
    },

    create(input: WorkflowFields, requestedId: string): WorkflowCreation {
      const fields = workflowFieldsSchema.parse(input);
      const id = workflowUuidSchema.parse(requestedId);
      return db.transaction(() => {
        // A repeated create (a retry after a lost response) finds its own row and writes nothing.
        if (get(id) !== undefined) return "created";
        const { count } = db.select({ count: sql<number>`count(*)` }).from(workflows).get() ?? {
          count: 0,
        };
        if (count >= WORKFLOW_LIMITS.workflows) return "full";
        if (nameTaken(fields.name, id)) return "name_taken";
        const time = now();
        db.insert(workflows)
          .values({
            id,
            ...fields,
            nodes: nodeCount(fields.graph),
            createdAt: time,
            updatedAt: time,
          })
          .run();
        return "created";
      });
    },

    update(
      id: string,
      input: Patch<Pick<WorkflowFields, "name" | "family">>,
      expected: number,
    ): Updated<StoredWorkflow> | "name_taken" {
      const patch = workflowMetaPatchSchema.parse(input);
      return db.transaction(() => {
        if (patch.name !== undefined && nameTaken(patch.name, id)) return "name_taken";
        return revised(get(id), expected, {
          apply: (row) => ({ name: patch.name ?? row.name, family: patch.family ?? row.family }),
          compare: ({ name, family }) => ({ name, family }),
          write: (meta, revision) =>
            db
              .update(workflows)
              .set({ ...meta, revision, updatedAt: now() })
              .where(eq(workflows.id, id))
              .returning(stored)
              .get(),
        });
      });
    },

    replaceGraph(id: string, input: WorkflowGraph, expected: number): Updated<StoredWorkflow> {
      const graph = apiGraphSchema.parse(input);
      return db.transaction(() =>
        revised(get(id), expected, {
          apply: () => graph,
          compare: (row) => row.graph,
          write: (next, revision) =>
            db
              .update(workflows)
              .set({ graph: next, nodes: nodeCount(next), revision, updatedAt: now() })
              .where(eq(workflows.id, id))
              .returning(stored)
              .get(),
        }),
      );
    },

    remove(id: string): boolean {
      return db.transaction(() => {
        const removed = db
          .delete(workflows)
          .where(eq(workflows.id, id))
          .returning({ id: workflows.id })
          .get();
        if (removed === undefined) return false;
        db.update(settings)
          .set({ comfyuiWorkflow: defaultWorkflow, updatedAt: now() })
          .where(and(eq(settings.id, 1), eq(settings.comfyuiWorkflow, userWorkflowId(removed.id))))
          .run();
        return true;
      });
    },
  };
}
