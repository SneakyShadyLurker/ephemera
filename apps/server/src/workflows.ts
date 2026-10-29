import {
  apiGraphSchema,
  type Candidate,
  type Detection,
  finalizeWorkflow,
  isRecord,
  type SlotTarget,
  WORKFLOW_LIMITS,
  type WorkflowChoices,
  type WorkflowFields,
  type WorkflowGraph,
  type WorkflowSaveError,
  walkDepth,
  workflowCreateSchema,
  type workflowDeleteResponseSchema,
  workflowGraphReplaceSchema,
  workflowPatchSchema,
  type workflowResponseSchema,
  type workflowSavedResponseSchema,
  type workflowsResponseSchema,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import { type NodeAllowlist, OUTPUT_CLASS } from "./comfyui/allowlist.ts";
import type { CatalogFor } from "./comfyui/catalog.ts";
import type { Comfyui } from "./comfyui/client.ts";
import { dryFill } from "./comfyui/workflow.ts";
import { boundedBody, type LifetimeEnv, requestLifetime } from "./lifetime.ts";
import { errorClass, type LogFields, type Logger } from "./log.ts";
import type { Stores, WorkflowStore } from "./persistence/store.ts";
import {
  conflict,
  idParam,
  invalid,
  invalidRequest,
  jsonLimit,
  notFound,
  payloadTooLarge,
} from "./routes.ts";
import { shown } from "./settings.ts";
import type { UserEnv } from "./user.ts";

/*
 * The requester's imported workflows (`/api/workflows`): list, create, edit
 * the name and family, replace the graph, delete. A graph from the tab is
 * untrusted: create and replace parse it, finalize it again with the tab's
 * choices and gate the template on the allowlist, the live ComfyUI's output
 * nodes when it answers, and a dry fill, before the store sees it. Each
 * request logs one line of operational fields: never a name, node class,
 * model file or text.
 */

/** What a handler adds to its request's log line. */
type Logged = Pick<LogFields, "nodes" | "checked" | "errorClass">;

type WorkflowsEnv = UserEnv & LifetimeEnv & { Variables: { logged: Logged } };

/** How a route reaches the requester's own workflows (api.ts). */
export type WorkflowStoreFor = (c: {
  var: { user: { stores: Pick<Stores, "workflows"> } };
}) => WorkflowStore;

export interface WorkflowsDeps {
  log: Logger;
  /** The server's node policy, applied in its `import` context. */
  allowlist: NodeAllowlist;
  comfyui: Pick<Comfyui, "allows" | "inspect">;
  /** The requester's workflows and the server's, built for each request (api.ts). */
  catalogFor: CatalogFor;
  requestTimeoutMs: number;
}

/** The class of a refusal the shared answers give (routes.ts, lifetime.ts), by status. */
const UNLABELLED: Partial<Record<number, string>> = {
  400: "invalid_request",
  404: "not_found",
  408: "request_timeout",
  409: "conflict",
  413: "payload_too_large",
};

/** A body a graph route refused before or while parsing it, or the parsed body. */
type Read<T> = { ok: true; body: T } | { ok: false; refusal: Response };

/** A save refused (409, 413, 422), with the class its log line carries. */
const refused = (c: Context<WorkflowsEnv>, status: 409 | 413 | 422, body: WorkflowSaveError) => {
  c.set("logged", {
    ...c.get("logged"),
    errorClass: body.error === "invalid_workflow" ? body.code : body.error,
  });
  return c.json(body, status);
};

/** Every node without its `_meta` (titles from ComfyUI), which a template never holds. */
const withoutMeta = (graph: unknown): unknown =>
  isRecord(graph)
    ? Object.fromEntries(
        Object.entries(graph).map(([id, node]) => {
          if (!isRecord(node)) return [id, node];
          const { _meta, ...rest } = node;
          return [id, rest];
        }),
      )
    : graph;

/**
 * Detection as the tab's choices give it: each chosen node its place's one
 * candidate, a chosen encoder's string inputs its prompt, and every `seed`
 * or `noise_seed` literal the seed (spec § 10.7, input names only). An
 * unchosen place stays unchosen, so finalization refuses it by name.
 * TODO(B3): replace with `normalizeWorkflow` and `detectSlots` once they land.
 */
function detectionOf(graph: WorkflowGraph, choices: WorkflowChoices): Detection {
  const candidate = (node: string, inputs: (value: unknown) => boolean): Candidate[] => {
    const found = graph[node];
    if (found === undefined) return [];
    return [
      {
        node,
        title: found.class_type,
        classType: found.class_type,
        inputs: Object.entries(found.inputs).flatMap(([input, value]) =>
          inputs(value) ? [input] : [],
        ),
      },
    ];
  };
  const any = () => true;
  const text = (value: unknown) => typeof value === "string";
  const place = (node: string | undefined) => ({
    chosen: node !== undefined && graph[node] !== undefined ? node : null,
    candidates: node === undefined ? [] : candidate(node, any),
  });
  const seed: SlotTarget[] = Object.entries(graph).flatMap(([node, { inputs }]) =>
    ["seed", "noise_seed"].flatMap((input) =>
      Object.hasOwn(inputs, input) && !Array.isArray(inputs[input]) ? [{ node, input }] : [],
    ),
  );
  return {
    prompt: {
      chosen: null,
      candidates: (choices.prompt ?? []).flatMap((node) => candidate(node, text)),
    },
    latent: place(choices.latent),
    seed,
    output: place(choices.output),
    familyGuess: "general",
  };
}

export function createWorkflowsApi(store: WorkflowStoreFor, deps: WorkflowsDeps) {
  const { log, allowlist, comfyui } = deps;

  /** Logs the request's one line when it is answered, whatever answered it. */
  const logged = (event: string) =>
    createMiddleware<WorkflowsEnv>(async (c, next) => {
      const started = performance.now();
      c.set("logged", {});
      await next();
      const { status } = c.res;
      const fields = c.get("logged");
      const failure =
        fields.errorClass ?? (c.error === undefined ? UNLABELLED[status] : errorClass(c.error));
      log[status >= 500 ? "error" : status >= 400 ? "warn" : "info"]({
        event,
        status,
        durationMs: Math.round(performance.now() - started),
        ...fields,
        ...(failure === undefined ? {} : { errorClass: failure }),
      });
    });

  /** The body within the upload bound (middleware), refused when too deep before Zod parses it. */
  async function read<T>(c: Context<WorkflowsEnv>, schema: z.ZodType<T>): Promise<Read<T>> {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return { ok: false, refusal: invalidRequest(c) };
    }
    // The body wraps the graph one level deeper than a file holds it.
    if (!walkDepth(json, WORKFLOW_LIMITS.jsonDepth + 1)) {
      return {
        ok: false,
        refusal: refused(c, 422, { error: "invalid_workflow", code: "too_deep" }),
      };
    }
    const parsed = schema.safeParse(
      isRecord(json) ? { ...json, graph: withoutMeta(json.graph) } : json,
    );
    if (!parsed.success) return { ok: false, refusal: invalidRequest(c) };
    return { ok: true, body: parsed.data };
  }

  /**
   * The template a save stores, or the answer refusing it: finalization with
   * the tab's choices, the allowlist, the live ComfyUI's output nodes when
   * the saved address answers, the dry fill and the template's size.
   */
  async function template(
    c: Context<WorkflowsEnv>,
    graph: WorkflowGraph,
    choices: WorkflowChoices,
  ): Promise<
    | { ok: true; template: WorkflowFields["graph"]; checked: boolean }
    | { ok: false; refusal: Response }
  > {
    const fail = (refusal: Response) => ({ ok: false as const, refusal });
    const finalized = finalizeWorkflow(
      { graph, changed: [], skipped: [] },
      detectionOf(graph, choices),
      choices,
    );
    if (!finalized.ok) {
      const { error, nodes } = finalized.refusal;
      return fail(
        refused(c, 422, {
          error: "invalid_workflow",
          code: error,
          ...(nodes === undefined ? {} : { nodes }),
        }),
      );
    }
    const result = finalized.template;
    const classes = [...new Set(Object.values(result).map((node) => node.class_type))];
    c.set("logged", { nodes: Object.keys(result).length, checked: false });

    const blocked = classes.filter((name) => allowlist.why(name, "import") !== undefined);
    if (blocked.length > 0)
      return fail(refused(c, 422, { error: "blocked_nodes", nodes: blocked }));

    let checked = false;
    const baseUrl = c.var.user.stores.settings.get().comfyuiBaseUrl;
    if (baseUrl !== "" && comfyui.allows(baseUrl)) {
      const live = await comfyui.inspect({ baseUrl, signal: c.get("deadline") });
      if (live.reachable) {
        checked = true;
        c.set("logged", { ...c.get("logged"), checked });
        const outputs = classes.filter(
          (name) => name !== OUTPUT_CLASS && live.meta.get(name)?.outputNode === true,
        );
        if (outputs.length > 0) {
          return fail(refused(c, 422, { error: "blocked_nodes", nodes: outputs }));
        }
      }
    }

    try {
      dryFill(result);
    } catch {
      return fail(refused(c, 422, { error: "invalid_workflow", code: "embedded_placeholder" }));
    }
    // Finalization may add a node, so the template is bounded again as the store holds it.
    const bounded = apiGraphSchema.safeParse(result);
    if (!bounded.success) {
      return fail(refused(c, 422, { error: "invalid_workflow", code: "too_many_nodes" }));
    }
    if (
      new TextEncoder().encode(JSON.stringify(bounded.data)).byteLength > WORKFLOW_LIMITS.graphBytes
    ) {
      return fail(payloadTooLarge(c));
    }
    return { ok: true, template: bounded.data, checked };
  }

  return new Hono<WorkflowsEnv>()
    .get("/", logged("workflows.list"), (c) =>
      c.json({ workflows: store(c).list() } satisfies z.input<typeof workflowsResponseSchema>, 200),
    )
    .post(
      "/",
      logged("workflows.create"),
      requestLifetime(deps.requestTimeoutMs),
      boundedBody(WORKFLOW_LIMITS.uploadBytes),
      async (c) => {
        const input = await read(c, workflowCreateSchema);
        if (!input.ok) return input.refusal;
        const { id, name, family, graph, choices } = input.body;
        const saved = await template(c, graph, choices);
        if (!saved.ok) return saved.refusal;
        // The client chooses the id, so a retried create cannot make a second workflow.
        const result = store(c).create({ name, family, graph: saved.template }, id);
        if (result === "full") return refused(c, 413, { error: "full" });
        if (result === "name_taken") return refused(c, 409, { error: "name_taken" });
        const workflow = store(c).get(id);
        if (workflow === undefined) throw new Error("created workflow is missing");
        return c.json(
          { workflow, checked: saved.checked } satisfies z.input<
            typeof workflowSavedResponseSchema
          >,
          201,
        );
      },
    )
    .patch(
      "/:id",
      logged("workflows.update"),
      idParam,
      jsonLimit,
      zValidator("json", workflowPatchSchema, invalid),
      (c) => {
        const { revision, ...patch } = c.req.valid("json");
        const result = store(c).update(c.req.valid("param").id, patch, revision);
        if (result === "name_taken") return refused(c, 409, { error: "name_taken" });
        if (result.status === "missing") return notFound(c);
        if (result.status === "conflict") return conflict(c, result.revision);
        return c.json(
          { workflow: result.value } satisfies z.input<typeof workflowResponseSchema>,
          200,
        );
      },
    )
    .put(
      "/:id/graph",
      logged("workflows.replace"),
      idParam,
      requestLifetime(deps.requestTimeoutMs),
      boundedBody(WORKFLOW_LIMITS.uploadBytes),
      async (c) => {
        const { id } = c.req.valid("param");
        if (store(c).get(id) === undefined) return notFound(c);
        const input = await read(c, workflowGraphReplaceSchema);
        if (!input.ok) return input.refusal;
        const { revision, graph, choices } = input.body;
        const saved = await template(c, graph, choices);
        if (!saved.ok) return saved.refusal;
        const result = store(c).replaceGraph(id, saved.template, revision);
        if (result.status === "missing") return notFound(c);
        if (result.status === "conflict") return conflict(c, result.revision);
        return c.json(
          { workflow: result.value, checked: saved.checked } satisfies z.input<
            typeof workflowSavedResponseSchema
          >,
          200,
        );
      },
    )
    .delete("/:id", logged("workflows.delete"), idParam, (c) => {
      if (!store(c).remove(c.req.valid("param").id)) return notFound(c);
      return c.json(
        {
          settings: shown(c.var.user.stores.settings.get(), deps.catalogFor(c)),
        } satisfies z.input<typeof workflowDeleteResponseSchema>,
        200,
      );
    });
}
