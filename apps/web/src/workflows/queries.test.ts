import { DEFAULT_SETTINGS, type WorkflowCreate } from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../app/query.ts";
import { ART_STATUS_KEY, artWorkflowsQuery } from "../creator/queries.ts";
import { settingsQuery } from "../settings/settings.ts";
import {
  createWorkflow,
  deleteWorkflow,
  inspectWorkflow,
  replaceWorkflowGraph,
  updateWorkflow,
  workflowsQuery,
} from "./queries.ts";

const UUID = "0b6f7c3e-2d4a-4f8e-9a1b-5c6d7e8f9a0b";
/** A node class found nowhere but in this graph, so any copy of the graph shows up by it. */
const MARKER = "MarkerSaveNode";
const graph = { 9: { class_type: MARKER, inputs: { images: ["8", 0] } } };
const stored = {
  id: UUID,
  name: "Portrait",
  family: "general",
  graph,
  revision: 0,
  createdAt: 1,
  updatedAt: 2,
};
const CREATE: WorkflowCreate = {
  id: UUID,
  name: "Portrait",
  family: "general",
  graph,
  choices: {},
};
const inspection = {
  format: "api",
  checked: true,
  graph,
  nodes: [{ id: "9", title: "Save", classType: MARKER }],
  detection: {
    prompt: { chosen: null, candidates: [] },
    latent: { chosen: null, candidates: [] },
    seed: [],
    output: {
      chosen: "9",
      candidates: [{ node: "9", title: "Save", classType: MARKER, inputs: ["images"] }],
    },
    familyGuess: "general",
  },
  report: { changed: [], skipped: [] },
  blocked: [],
  live: { state: "ready" },
  nameSuggestion: "Portrait",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  queryClient.clear();
});

/** Every request as the server would see it; `answer` replies to each. */
function serving(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      typeof input === "string" ? new URL(input, "http://localhost") : input,
      init,
    );
    requests.push(request);
    return answer(request);
  });
  return requests;
}

describe("the workflows list", () => {
  it("asks for the user's workflows", async () => {
    const requests = serving(() =>
      Response.json({
        workflows: [
          { id: UUID, name: "Portrait", family: "general", nodes: 1, revision: 0, updatedAt: 2 },
        ],
      }),
    );
    expect(await queryClient.fetchQuery(workflowsQuery)).toEqual([
      { id: UUID, name: "Portrait", family: "general", nodes: 1, revision: 0, updatedAt: 2 },
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/workflows"]);
  });
});

describe("a workflow write", () => {
  it("creates and invalidates the list, the picker's workflows and every art status", async () => {
    const requests = serving(() =>
      Response.json({ workflow: stored, checked: true }, { status: 201 }),
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    expect(await createWorkflow(CREATE)).toEqual({
      ok: true,
      value: { workflow: stored, checked: true },
    });
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/workflows");
    expect(await requests[0]?.json()).toEqual(CREATE);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      workflowsQuery.queryKey,
      artWorkflowsQuery.queryKey,
      ART_STATUS_KEY,
    ]);
  });

  it("updates, replaces the graph and deletes, invalidating after each", async () => {
    const requests = serving((request) =>
      request.method === "DELETE"
        ? Response.json({ settings: DEFAULT_SETTINGS })
        : request.method === "PUT"
          ? Response.json({ workflow: stored, checked: false })
          : Response.json({ workflow: stored }),
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    expect(await updateWorkflow(UUID, { revision: 0, name: "Portrait" })).toEqual({
      ok: true,
      value: { workflow: stored },
    });
    expect(await replaceWorkflowGraph(UUID, { revision: 0, graph, choices: {} })).toEqual({
      ok: true,
      value: { workflow: stored, checked: false },
    });
    expect((await deleteWorkflow(UUID)).ok).toBe(true);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `PATCH /api/workflows/${UUID}`,
        `PUT /api/workflows/${UUID}/graph`,
        `DELETE /api/workflows/${UUID}`,
      ],
    );
    expect(invalidate).toHaveBeenCalledTimes(9);
  });

  it("applies the settings a delete leaves, so the chosen workflow falls back at once", async () => {
    queryClient.setQueryData(settingsQuery.queryKey, {
      ...DEFAULT_SETTINGS,
      comfyuiWorkflow: `user-${UUID}`,
    });
    serving(() => Response.json({ settings: DEFAULT_SETTINGS }));
    expect(await deleteWorkflow(UUID)).toEqual({
      ok: true,
      value: { settings: DEFAULT_SETTINGS },
    });
    expect(queryClient.getQueryData(settingsQuery.queryKey)?.comfyuiWorkflow).toBe(
      DEFAULT_SETTINGS.comfyuiWorkflow,
    );
  });
});

describe("an inspect", () => {
  it("is cancelled with its signal", async () => {
    const requests = serving(
      (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason)),
        ),
    );
    const controller = new AbortController();
    const result = inspectWorkflow({ source: {} }, controller.signal);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort();
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(await result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("asks again a moment later while the server is still busy, then says so", async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      serving(() => {
        answers += 1;
        return answers === 2
          ? Response.json(inspection)
          : Response.json({ error: "busy" }, { status: 429 });
      });
      const settled = inspectWorkflow({ source: graph }, new AbortController().signal);
      await vi.runAllTimersAsync();
      expect(await settled).toEqual({ ok: true, value: inspection });
      expect(answers).toBe(2);

      answers = 10;
      const busy = inspectWorkflow({ source: graph }, new AbortController().signal);
      await vi.runAllTimersAsync();
      expect(await busy).toEqual({ ok: false, reason: "busy" });
      expect(answers).toBe(13);
    } finally {
      vi.useRealTimers();
    }
  });

  it("and a create leave no graph in the query or mutation cache", async () => {
    serving((request) =>
      new URL(request.url).pathname.endsWith("/inspect")
        ? Response.json(inspection)
        : request.method === "POST"
          ? Response.json({ workflow: stored, checked: true }, { status: 201 })
          : Response.json({ workflows: [] }),
    );
    await queryClient.fetchQuery(workflowsQuery);
    const inspected = await inspectWorkflow(
      { source: graph, fileName: "portrait.json" },
      new AbortController().signal,
    );
    expect(inspected).toEqual({ ok: true, value: inspection });
    expect((await createWorkflow(CREATE)).ok).toBe(true);
    const cached = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.state]),
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    ]);
    expect(cached).not.toContain(MARKER);
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });
});

describe("a refused or lost workflow request", () => {
  it("says why, each status and body as its own case", async () => {
    const inspect = () => inspectWorkflow({ source: {} }, new AbortController().signal);
    const create = () => createWorkflow(CREATE);
    const update = () => updateWorkflow(UUID, { revision: 0, name: "Portrait" });
    const replace = () => replaceWorkflowGraph(UUID, { revision: 0, graph, choices: {} });
    const remove = () => deleteWorkflow(UUID);
    const refusal = (status: number, body: object) => Response.json(body, { status });
    const cases: [() => Promise<unknown>, Response, unknown][] = [
      [inspect, refusal(429, { error: "busy" }), { ok: false, reason: "busy" }],
      [
        inspect,
        refusal(409, { error: "comfyui_required" }),
        { ok: false, reason: "comfyui_required" },
      ],
      [
        inspect,
        refusal(422, { error: "invalid_workflow", code: "no_output" }),
        { ok: false, reason: "invalid_workflow", code: "no_output", nodes: [] },
      ],
      [
        create,
        refusal(422, { error: "invalid_workflow", code: "unknown_node", nodes: ["4"] }),
        { ok: false, reason: "invalid_workflow", code: "unknown_node", nodes: ["4"] },
      ],
      [
        replace,
        refusal(422, { error: "blocked_nodes", nodes: ["SaveImage"] }),
        { ok: false, reason: "blocked_nodes", nodes: ["SaveImage"] },
      ],
      [create, refusal(413, { error: "full" }), { ok: false, reason: "full" }],
      [inspect, refusal(413, { error: "payload_too_large" }), { ok: false, reason: "too_large" }],
      [update, refusal(409, { error: "name_taken" }), { ok: false, reason: "name_taken" }],
      [
        replace,
        refusal(409, { error: "conflict", revision: 4 }),
        { ok: false, reason: "conflict", revision: 4 },
      ],
      [remove, refusal(404, { error: "not_found" }), { ok: false, reason: "not_found" }],
      // A body under another status, a refusal the route never gives, a proxy's
      // page and an unknown code are not Ephemera's refusal.
      [inspect, refusal(409, { error: "busy" }), { ok: false, reason: "unreachable" }],
      [remove, refusal(409, { error: "name_taken" }), { ok: false, reason: "unreachable" }],
      [
        create,
        new Response("<html>Bad gateway</html>", { status: 502 }),
        { ok: false, reason: "unreachable" },
      ],
      [
        create,
        refusal(422, { error: "invalid_workflow", code: "made_up" }),
        { ok: false, reason: "unreachable" },
      ],
    ];
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    for (const [send, response, result] of cases) {
      serving(() => response.clone());
      expect(await send()).toEqual(result);
    }
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    for (const send of [inspect, create, update, replace, remove]) {
      expect(await send()).toEqual({ ok: false, reason: "unreachable" });
    }
    expect(invalidate).not.toHaveBeenCalled();
  });
});
