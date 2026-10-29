import {
  apiGraphSchema,
  type BlockedNode,
  type CreatorArtStatus,
  convertWorkflow,
  type DisplayNode,
  detectFormat,
  detectWorkflow,
  FORBIDDEN_KEYS,
  finalizeWorkflow,
  imageOutputs,
  type inspectionSchema,
  isRecord,
  type NodeMetaMap,
  type NodeTitles,
  normalizeWorkflow,
  type ReportLine,
  stripEphemeraKey,
  titleOf,
  WORKFLOW_LIMITS,
  type WorkflowChoices,
  type WorkflowFields,
  type WorkflowFormat,
  type WorkflowGraph,
  type WorkflowRefusal,
  type WorkflowSaveError,
  walkDepth,
  workflowCreateSchema,
  type workflowDeleteResponseSchema,
  workflowGraphReplaceSchema,
  workflowInspectSchema,
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
import type { Comfyui, ComfyuiInspection } from "./comfyui/client.ts";
import { describeWorkflow, dryFill, type Workflow } from "./comfyui/workflow.ts";
import { artStatus } from "./creator.ts";
import { boundedBody, type LifetimeEnv, requestLifetime } from "./lifetime.ts";
import { errorClass, type LogFields, type Logger } from "./log.ts";
import type { Stores, UserInstance, WorkflowStore } from "./persistence/store.ts";
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
 * The requester's imported workflows (`/api/workflows`): inspect a file,
 * list, create, edit the name and family, replace the graph, delete. An
 * inspection converts and normalizes the file in request memory and answers
 * it to the tab; nothing of it is stored. A graph from the tab is
 * untrusted: create and replace parse it, normalize it, gate it on the
 * allowlist and the live ComfyUI's output nodes when it answers, detect and
 * finalize it again with the tab's choices, and dry-fill the template, before
 * the store sees it. Each
 * request logs one line of operational fields: never a name, node class,
 * model file or text.
 */

/** What a handler adds to its request's log line. */
type Logged = Pick<LogFields, "nodes" | "checked" | "errorClass" | "format">;

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

/** A workflow refusal as a 422 answer. */
const refusedWorkflow = (c: Context<WorkflowsEnv>, { error, nodes }: WorkflowRefusal) =>
  refused(c, 422, {
    error: "invalid_workflow",
    code: error,
    ...(nodes === undefined ? {} : { nodes }),
  });

/**
 * Whether any object in `source` has a reserved key (FORBIDDEN_KEYS) of its
 * own, at any level. `JSON.parse` keeps `__proto__` as an own key, which a
 * file's free-form parts would otherwise carry past every schema.
 */
function hasReservedKey(source: unknown): boolean {
  const pending: unknown[] = [source];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next !== "object" || next === null) continue;
    for (const [key, value] of Object.entries(next)) {
      if (FORBIDDEN_KEYS.has(key)) return true;
      pending.push(value);
    }
  }
  return false;
}

/** The longest node title the panel shows (`nodeTitleSchema`). */
const TITLE_LENGTH = 256;

/** An API file's graph without `_meta` or the reserved `ephemera` key, and its nodes named by `_meta.title`. */
function apiFile(
  source: unknown,
  meta: NodeMetaMap | undefined,
):
  | { ok: true; graph: WorkflowGraph; nodes: DisplayNode[] }
  | { ok: false; refusal: WorkflowRefusal } {
  let file: unknown;
  try {
    file = stripEphemeraKey(source).graph;
  } catch {
    return { ok: false, refusal: { error: "not_a_workflow" } };
  }
  if (isRecord(file) && Object.keys(file).length > WORKFLOW_LIMITS.nodes) {
    return { ok: false, refusal: { error: "too_many_nodes" } };
  }
  const parsed = apiGraphSchema.safeParse(withoutMeta(file));
  if (!parsed.success || !isRecord(file))
    return { ok: false, refusal: { error: "not_a_workflow" } };
  const nodes = Object.entries(parsed.data).map(([id, node]): DisplayNode => {
    const entry = file[id];
    const title = isRecord(entry) && isRecord(entry._meta) ? entry._meta.title : undefined;
    return {
      id,
      title:
        typeof title === "string" && title.trim() !== ""
          ? title.slice(0, TITLE_LENGTH)
          : titleOf(node.class_type, meta),
      classType: node.class_type,
    };
  });
  return { ok: true, graph: parsed.data, nodes };
}

/** The name the panel suggests: the UI file's own name, else the file name without its extension. */
function nameSuggestion(source: unknown, format: WorkflowFormat, fileName: string | undefined) {
  const info =
    format === "ui" && isRecord(source) && isRecord(source.extra) && isRecord(source.extra.info)
      ? source.extra.info.name
      : undefined;
  const name =
    typeof info === "string" && info.trim() !== ""
      ? info
      : (fileName?.replace(/\.[^.]*$/, "") ?? "");
  return name
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, WORKFLOW_LIMITS.nameLength)
    .trim();
}

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

export function createWorkflowsApi(store: WorkflowStoreFor, deps: WorkflowsDeps) {
  const { log, allowlist, comfyui } = deps;

  /**
   * Each user instance's inspect in flight, by the token of the request
   * holding it: one at a time per user, never across users. A request
   * releases only its own slot, on its answer, its failure or its client
   * going away, whichever comes first.
   */
  const inspecting = new WeakMap<UserInstance, symbol>();
  const oneInspect = createMiddleware<WorkflowsEnv>(async (c, next) => {
    const user = c.var.user;
    if (inspecting.has(user)) {
      c.set("logged", { ...c.get("logged"), errorClass: "busy" });
      return c.json({ error: "busy" as const }, 429);
    }
    const token = Symbol("inspect");
    inspecting.set(user, token);
    const release = () => {
      if (inspecting.get(user) === token) inspecting.delete(user);
    };
    const { signal } = c.req.raw;
    signal.addEventListener("abort", release, { once: true });
    if (signal.aborted) release();
    try {
      await next();
    } finally {
      signal.removeEventListener("abort", release);
      release();
    }
  });

  /** The saved address's inventory, read once, or the live status saying why there is none. */
  async function liveInventory(
    c: Context<WorkflowsEnv>,
  ): Promise<
    { inspection: Extract<ComfyuiInspection, { reachable: true }> } | { status: CreatorArtStatus }
  > {
    const baseUrl = c.var.user.stores.settings.get().comfyuiBaseUrl;
    if (baseUrl === "") return { status: { state: "off" } };
    if (!comfyui.allows(baseUrl))
      return { status: { state: "unavailable", reason: "not_allowed" } };
    const inspection = await comfyui.inspect({ baseUrl, signal: c.get("deadline") });
    return inspection.reachable ? { inspection } : { status: artStatus(inspection) };
  }

  /** The safe fixes (spec § 10.1), with the server's sanctioned output and refused classes. */
  const normalize = (graph: WorkflowGraph, meta: NodeMetaMap | undefined, titles?: NodeTitles) =>
    normalizeWorkflow(
      graph,
      meta,
      (name) => name === OUTPUT_CLASS,
      (name) => allowlist.why(name, "import") === "refused_writes",
      titles,
    );

  /**
   * The classes of a normalized graph an import refuses (spec § 11.2): the
   * allowlist's reason, else a class the live ComfyUI reports as an output
   * node. Image outputs are the output choice: finalization makes the chosen
   * one the saver and drops the rest, so they are not assessed.
   */
  function blockedIn(graph: WorkflowGraph, meta: NodeMetaMap | undefined): BlockedNode[] {
    const outputs = new Set(imageOutputs(graph, meta));
    const classes = new Set(
      Object.entries(graph).flatMap(([id, node]) => (outputs.has(id) ? [] : [node.class_type])),
    );
    return [...classes].flatMap((classType): BlockedNode[] => {
      const reason =
        allowlist.why(classType, "import") ??
        (classType !== OUTPUT_CLASS && meta?.get(classType)?.outputNode === true
          ? "output_node"
          : undefined);
      return reason === undefined ? [] : [{ classType, reason }];
    });
  }

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
   * The template a save stores, or the answer refusing it (spec § 10):
   * normalization with the saved address's inventory when it answers (else
   * none, § 10.7), the allowlist and the live output nodes on the normalized
   * graph, detection, finalization with the tab's choices, the dry fill and
   * the template's size.
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
    const invalidWorkflow = (refusal: WorkflowRefusal) => fail(refusedWorkflow(c, refusal));

    // One inventory read serves normalization, detection and the live output gate.
    const live = await liveInventory(c);
    const meta = "inspection" in live ? live.inspection.meta : undefined;
    const checked = meta !== undefined;

    const normalized = normalize(graph, meta);
    c.set("logged", { nodes: Object.keys(normalized.graph).length, checked });

    // The allowlist's refusals first; the live output nodes only once it admits every class.
    const blocked = blockedIn(normalized.graph, meta);
    const listed = blocked.filter(({ reason }) => reason !== "output_node");
    const shown = listed.length > 0 ? listed : blocked;
    if (shown.length > 0) {
      return fail(
        refused(c, 422, {
          error: "blocked_nodes",
          nodes: shown.map(({ classType }) => classType),
        }),
      );
    }

    const detected = detectWorkflow(normalized, meta);
    if (!detected.ok) return invalidWorkflow(detected.refusal);
    const finalized = finalizeWorkflow(normalized, detected.detection, choices, meta);
    if (!finalized.ok) return invalidWorkflow(finalized.refusal);
    const result = finalized.template;
    c.set("logged", { nodes: Object.keys(result).length, checked });

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
    .post(
      "/inspect",
      logged("workflows.inspect"),
      requestLifetime(deps.requestTimeoutMs),
      oneInspect,
      boundedBody(WORKFLOW_LIMITS.uploadBytes),
      async (c) => {
        let json: unknown;
        try {
          json = await c.req.json();
        } catch {
          return invalidRequest(c);
        }
        // The body wraps the file one level deeper than the file holds itself.
        if (!walkDepth(json, WORKFLOW_LIMITS.jsonDepth + 1)) {
          return refused(c, 422, { error: "invalid_workflow", code: "too_deep" });
        }
        if (hasReservedKey(json)) return invalidRequest(c);
        const parsed = workflowInspectSchema.safeParse(json);
        if (!parsed.success) return invalidRequest(c);
        const { source, fileName } = parsed.data;
        const format = detectFormat(source);
        if (format === undefined) return refusedWorkflow(c, { error: "not_a_workflow" });
        c.set("logged", { format, checked: false });

        // One inventory read serves conversion, normalization, detection and the live preview.
        const live = await liveInventory(c);
        const inventory = "inspection" in live ? live.inspection : undefined;
        const meta = inventory?.meta;
        const checked = meta !== undefined;
        c.set("logged", { format, checked });

        let file: { graph: WorkflowGraph; nodes: DisplayNode[]; skipped: ReportLine[] };
        if (format === "ui") {
          // A UI file's widget values are positional: only the live input order places them.
          if (meta === undefined) {
            c.set("logged", { format, checked, errorClass: "comfyui_required" });
            return c.json({ error: "comfyui_required" as const }, 409);
          }
          const converted = convertWorkflow(source, meta);
          if (!converted.ok) return refusedWorkflow(c, converted.refusal);
          file = converted;
        } else {
          const read = apiFile(source, meta);
          if (!read.ok) return refusedWorkflow(c, read.refusal);
          file = { ...read, skipped: [] };
        }

        // The file's own node titles name nodes in the detection and the report.
        const titles: NodeTitles = new Map(file.nodes.map((node) => [node.id, node.title]));
        const normalized = normalize(file.graph, meta, titles);
        c.set("logged", { format, checked, nodes: Object.keys(normalized.graph).length });
        const blocked = blockedIn(normalized.graph, meta);
        const detected = detectWorkflow(normalized, meta, titles);
        if (!detected.ok) return refusedWorkflow(c, detected.refusal);
        const { detection } = detected;

        // The report and the live check as a save with the default choices would see them.
        const preview = finalizeWorkflow(normalized, detection, {}, meta, titles);
        const report = preview.ok ? preview : normalized;
        let status: CreatorArtStatus;
        if (inventory === undefined) {
          status = "status" in live ? live.status : { state: "off" };
        } else {
          // Until a choice is made, the image outputs are the choice and none is checked.
          const outputs = new Set(imageOutputs(normalized.graph, meta));
          const checkedGraph: Workflow = preview.ok
            ? describeWorkflow(preview.template, detection.familyGuess)
            : {
                graph: Object.fromEntries(
                  Object.entries(normalized.graph).filter(([id]) => !outputs.has(id)),
                ),
                output: "",
                models: [],
                family: detection.familyGuess,
              };
          status = artStatus({ reachable: true, ...inventory.missing(checkedGraph) });
        }

        return c.json(
          {
            format,
            checked,
            graph: normalized.graph,
            // The nodes the graph still has, under the class normalization left them.
            nodes: file.nodes.flatMap((node) => {
              const kept = Object.hasOwn(normalized.graph, node.id)
                ? normalized.graph[node.id]
                : undefined;
              return kept === undefined ? [] : [{ ...node, classType: kept.class_type }];
            }),
            detection,
            report: { changed: report.changed, skipped: [...file.skipped, ...report.skipped] },
            blocked,
            live: status,
            nameSuggestion: nameSuggestion(source, format, fileName),
          } satisfies z.input<typeof inspectionSchema>,
          200,
        );
      },
    )
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
