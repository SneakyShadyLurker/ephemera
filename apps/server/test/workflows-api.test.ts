import {
  creatorArtWorkflowsSchema,
  settingsResponseSchema,
  userWorkflowId,
  WORKFLOW_LIMITS,
  type WorkflowGraph,
  workflowSavedResponseSchema,
  workflowsResponseSchema,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import bundled from "../src/comfyui/workflows/krea2-gonzalomo.json" with { type: "json" };
import { type FakeComfyuiOptions, fakeComfyui } from "./fake-comfyui.ts";
import { formRequest, ownerHeaders, requestJson, TEST_USER, testApp } from "./helpers.ts";
import { storeUserWorkflow, TEST_WORKFLOWS } from "./test-workflows.ts";

const COMFY = "http://comfy.test:8188";

interface Setup {
  comfy?: FakeComfyuiOptions;
  /** The saved ComfyUI address; empty means none. */
  address?: string;
}

function setup(options: Setup = {}) {
  const comfy = fakeComfyui(options.comfy);
  const { app, lines, instances } = testApp({ fetch: comfy.fetch, workflows: TEST_WORKFLOWS });
  const { stores } = instances.instance(TEST_USER);
  stores.settings.update({ comfyuiBaseUrl: options.address ?? COMFY });
  return { app, lines, stores };
}

/** The bundled graph as a user's API export carries it: literal values, a node title, no placeholders. */
function exported(extra: WorkflowGraph = {}): Record<string, unknown> {
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> =
    structuredClone(bundled);
  Object.assign(graph["4"]?.inputs ?? {}, { text: "a lighthouse at dusk" });
  Object.assign(graph["6"]?.inputs ?? {}, { width: 1024, height: 1536, batch_size: 1 });
  Object.assign(graph["7"]?.inputs ?? {}, { seed: 1234567 });
  return {
    ...Object.fromEntries(
      Object.entries(graph).map(([id, node]) => [
        id,
        { ...node, _meta: { title: node.class_type } },
      ]),
    ),
    ...extra,
  };
}

const CHOICES = { output: "9", latent: "6", prompt: ["4"] };

const createBody = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  name: "Lighthouse",
  family: "krea2",
  graph: exported(),
  choices: CHOICES,
  ...overrides,
});

type App = ReturnType<typeof setup>["app"];

const create = (app: App, body: unknown) =>
  app.request("/api/workflows", requestJson("POST", body));

async function created(app: App, overrides: Record<string, unknown> = {}) {
  const response = await create(app, createBody(overrides));
  expect(response.status).toBe(201);
  return workflowSavedResponseSchema.parse(await response.json());
}

const workflowLines = (lines: string[]) =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => String(line.event).startsWith("workflows."));

describe("POST /api/workflows", () => {
  it("stores the finalized template, checked against a ComfyUI that answers", async () => {
    const { app } = setup();
    const { workflow, checked } = await created(app);
    expect(checked).toBe(true);
    expect(workflow).toMatchObject({ name: "Lighthouse", family: "krea2", revision: 0 });
    expect(workflow.graph["4"]?.inputs.text).toBe("{{prompt}}");
    expect(workflow.graph["7"]?.inputs.seed).toBe("{{seed}}");
    expect(JSON.stringify(workflow.graph)).not.toContain("_meta");
    expect(JSON.stringify(workflow.graph)).not.toContain("lighthouse");
  });

  it("saves unchecked when ComfyUI does not answer or no address is saved", async () => {
    for (const options of [{ comfy: { down: true } }, { address: "" }]) {
      const { app } = setup(options);
      expect((await created(app)).checked).toBe(false);
    }
  });

  it("lists the new workflow first in the picker, as the user's", async () => {
    const { app } = setup();
    const { workflow } = await created(app);
    const listed = await app.request("/api/creator/art/workflows", { headers: ownerHeaders() });
    const { workflows } = creatorArtWorkflowsSchema.parse(await listed.json());
    expect(workflows[0]).toMatchObject({
      id: userWorkflowId(workflow.id),
      name: "Lighthouse",
      scope: "user",
    });
    const mine = await app.request("/api/workflows", { headers: ownerHeaders() });
    expect(mine.status).toBe(200);
    expect(workflowsResponseSchema.parse(await mine.json()).workflows).toEqual([
      expect.objectContaining({ id: workflow.id, name: "Lighthouse", nodes: 11 }),
    ]);
  });

  it("refuses a name another workflow has", async () => {
    const { app } = setup();
    await created(app);
    const response = await create(app, createBody({ name: "lighthouse" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "name_taken" });
  });

  it("refuses a 25th workflow", async () => {
    const { app, stores } = setup();
    for (let index = 0; index < WORKFLOW_LIMITS.workflows; index++) {
      storeUserWorkflow(stores.workflows, { name: `Mine ${index}` });
    }
    const response = await create(app, createBody());
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "full" });
  });

  it("refuses a graph still using a node that writes files", async () => {
    const { app } = setup();
    const response = await create(
      app,
      createBody({
        graph: exported({
          "12": {
            class_type: "SaveLatent",
            inputs: { samples: ["7", 0], filename_prefix: "latents/x" },
          },
        }),
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "blocked_nodes", nodes: ["SaveLatent"] });
  });

  it("refuses a class the live ComfyUI reports as an output node", async () => {
    const { app } = setup({ comfy: { outputNodes: ["ModelAttentionBackend"] } });
    const response = await create(app, createBody());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "blocked_nodes",
      nodes: ["ModelAttentionBackend"],
    });
  });

  it("refuses placeholder text in an input Ephemera does not fill", async () => {
    const { app } = setup();
    const graph = exported();
    Object.assign((graph["10"] as { inputs: Record<string, unknown> }).inputs, {
      attention: "{{x}}",
    });
    const response = await create(app, createBody({ graph }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_workflow",
      code: "embedded_placeholder",
      nodes: ["10"],
    });
  });

  it("refuses a body past 2 MiB", async () => {
    const { app } = setup();
    const response = await create(app, createBody({ name: "x".repeat(3 * 1024 * 1024) }));
    expect(response.status).toBe(413);
  });

  it("refuses a body nested deeper than the limit", async () => {
    const { app } = setup();
    let deep: unknown = 1;
    for (let level = 0; level < WORKFLOW_LIMITS.jsonDepth + 2; level++) deep = [deep];
    const graph = exported();
    Object.assign((graph["10"] as { inputs: Record<string, unknown> }).inputs, { extra: deep });
    const response = await create(app, createBody({ graph }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_workflow", code: "too_deep" });
  });

  it.each([
    ["the body", (body: string) => body.replace(/^\{/, '{"__proto__":{"x":1},')],
    ["a node id", (body: string) => body.replace('"graph":{', '"graph":{"__proto__":{"x":1},')],
    ["an input name", (body: string) => body.replace('"inputs":{', '"inputs":{"__proto__":1,')],
    [
      "a nested object",
      (body: string) => body.replace('"inputs":{', '"inputs":{"nested":{"__proto__":1},'),
    ],
  ])("refuses a __proto__ key in %s", async (_label, edit) => {
    const { app, stores } = setup();
    const text = edit(JSON.stringify(createBody()));
    expect(text).toContain("__proto__");
    const response = await app.request("/api/workflows", {
      method: "POST",
      headers: ownerHeaders(),
      body: text,
    });
    expect(response.status).toBe(400);
    expect(stores.workflows.list()).toEqual([]);
  });

  it("is refused by the boundary without the user binding or with a multipart body", async () => {
    const { app } = setup();
    const { "X-Ephemera-User": _bound, ...unbound } = ownerHeaders();
    const missing = await app.request("/api/workflows", {
      method: "POST",
      headers: unbound,
      body: JSON.stringify(createBody()),
    });
    expect(missing.status).toBe(412);
    const form = new FormData();
    form.append("file", new File([JSON.stringify(createBody())], "graph.json"));
    const multipart = await app.request("/api/workflows", formRequest("POST", form));
    expect(multipart.status).toBe(415);
  });
});

describe("PATCH /api/workflows/:id", () => {
  it("renames at the current revision and refuses a stale one or a graph key", async () => {
    const { app } = setup();
    const { workflow } = await created(app);
    const path = `/api/workflows/${workflow.id}`;
    const renamed = await app.request(
      path,
      requestJson("PATCH", { revision: 0, name: "Harbour", family: "general" }),
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      workflow: { name: "Harbour", family: "general", revision: 1 },
    });

    const stale = await app.request(path, requestJson("PATCH", { revision: 0, name: "Pier" }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", revision: 1 });

    const graph = await app.request(
      path,
      requestJson("PATCH", { revision: 1, graph: workflow.graph }),
    );
    expect(graph.status).toBe(400);
  });

  it("refuses a name another workflow has, and answers 404 for an unknown one", async () => {
    const { app } = setup();
    await created(app);
    const { workflow } = await created(app, { name: "Harbour" });
    const taken = await app.request(
      `/api/workflows/${workflow.id}`,
      requestJson("PATCH", { revision: 0, name: "Lighthouse" }),
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "name_taken" });
    const unknown = await app.request(
      `/api/workflows/${crypto.randomUUID()}`,
      requestJson("PATCH", { revision: 0, name: "Pier" }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("PUT /api/workflows/:id/graph", () => {
  it("replaces the graph at the current revision and refuses a stale one", async () => {
    const { app } = setup();
    const { workflow } = await created(app);
    const path = `/api/workflows/${workflow.id}/graph`;
    const graph = exported();
    Object.assign((graph["7"] as { inputs: Record<string, unknown> }).inputs, { steps: 20 });
    const replaced = await app.request(
      path,
      requestJson("PUT", { revision: 0, graph, choices: CHOICES }),
    );
    expect(replaced.status).toBe(200);
    const saved = workflowSavedResponseSchema.parse(await replaced.json());
    expect(saved.checked).toBe(true);
    expect(saved.workflow.revision).toBe(1);
    expect(saved.workflow.graph["7"]?.inputs.steps).toBe(20);

    // Another graph: the same one again at the old revision is the write already made.
    Object.assign((graph["7"] as { inputs: Record<string, unknown> }).inputs, { steps: 30 });
    const stale = await app.request(
      path,
      requestJson("PUT", { revision: 0, graph, choices: CHOICES }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", revision: 1 });
  });

  it("runs the same gates as a create", async () => {
    const { app } = setup();
    const { workflow } = await created(app);
    const response = await app.request(
      `/api/workflows/${workflow.id}/graph`,
      requestJson("PUT", {
        revision: 0,
        graph: exported({ "12": { class_type: "SaveLatent", inputs: { samples: ["7", 0] } } }),
        choices: CHOICES,
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "blocked_nodes", nodes: ["SaveLatent"] });
  });
});

describe("DELETE /api/workflows/:id", () => {
  it("answers the settings, back on the default when they named the workflow", async () => {
    const { app, stores } = setup();
    const { workflow } = await created(app);
    stores.settings.update({ comfyuiWorkflow: userWorkflowId(workflow.id) });
    const response = await app.request(`/api/workflows/${workflow.id}`, requestJson("DELETE"));
    expect(response.status).toBe(200);
    const { settings } = settingsResponseSchema.parse(await response.json());
    expect(settings.comfyuiWorkflow).toBe(TEST_WORKFLOWS.defaultWorkflow);
    expect(stores.workflows.list()).toEqual([]);

    const again = await app.request(`/api/workflows/${workflow.id}`, requestJson("DELETE"));
    expect(again.status).toBe(404);
  });
});

describe("the workflows routes' logs", () => {
  it("write one line per request with operational fields only", async () => {
    const { app, lines } = setup();
    const { workflow } = await created(app);
    await create(app, createBody({ name: "Pier" }));
    await create(app, createBody({ name: "Lighthouse" }));
    await app.request("/api/workflows", { headers: ownerHeaders() });
    await app.request(
      `/api/workflows/${workflow.id}`,
      requestJson("PATCH", { revision: 0, name: "Harbour" }),
    );
    await app.request(
      `/api/workflows/${workflow.id}/graph`,
      requestJson("PUT", { revision: 1, graph: exported(), choices: CHOICES }),
    );
    await app.request(`/api/workflows/${workflow.id}`, requestJson("DELETE"));

    const logged = workflowLines(lines);
    expect(logged.map((line) => line.event)).toEqual([
      "workflows.create",
      "workflows.create",
      "workflows.create",
      "workflows.list",
      "workflows.update",
      "workflows.replace",
      "workflows.delete",
    ]);
    const allowed = [
      "time",
      "level",
      "event",
      "status",
      "durationMs",
      "nodes",
      "checked",
      "errorClass",
    ];
    for (const line of logged) {
      for (const key of Object.keys(line)) expect(allowed).toContain(key);
      expect(typeof line.durationMs).toBe("number");
    }
    expect(logged[0]).toMatchObject({ status: 201, nodes: 11, checked: true });
    expect(logged[2]).toMatchObject({ status: 409, errorClass: "name_taken" });
    const text = lines.join("\n");
    for (const secret of [
      "Lighthouse",
      "Harbour",
      "lighthouse at dusk",
      "KSampler",
      "safetensors",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
