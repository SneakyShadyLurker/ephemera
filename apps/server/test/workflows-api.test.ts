import {
  creatorArtWorkflowsSchema,
  finalizeWorkflow,
  type Inspection,
  inspectionSchema,
  settingsResponseSchema,
  userWorkflowId,
  WORKFLOW_LIMITS,
  type WorkflowGraph,
  workflowSavedResponseSchema,
  workflowsResponseSchema,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  loadWorkflowFixture,
  loadWorkflowFixtures,
} from "../../../packages/core/test-fixtures/workflows.ts";
import bundled from "../src/comfyui/workflows/krea2-gonzalomo.json" with { type: "json" };
import { type FakeComfyuiOptions, fakeComfyui } from "./fake-comfyui.ts";
import { formRequest, ownerHeaders, requestJson, TEST_USER, testApp } from "./helpers.ts";
import { storeUserWorkflow, TEST_WORKFLOWS } from "./test-workflows.ts";

const COMFY = "http://comfy.test:8188";

type Fetch = ReturnType<typeof fakeComfyui>["fetch"];

interface Setup {
  comfy?: FakeComfyuiOptions;
  /** The saved ComfyUI address; empty means none. */
  address?: string;
  /** Wraps the fake's fetch, as a test that holds a request does. */
  wrap?: (fetch: Fetch) => Fetch;
}

function setup(options: Setup = {}) {
  const comfy = fakeComfyui(options.comfy);
  const fetch = options.wrap?.(comfy.fetch) ?? comfy.fetch;
  const { app, lines, instances } = testApp({ fetch, workflows: TEST_WORKFLOWS });
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

/** The bundled export sampling a latent read from ComfyUI's files, which nothing may admit. */
function readsLatent(): Record<string, unknown> {
  const graph = exported({ "12": { class_type: "LoadLatent", inputs: { latent: "x.latent" } } });
  Object.assign((graph["7"] as { inputs: Record<string, unknown> }).inputs, {
    latent_image: ["12", 0],
  });
  return graph;
}

/** An SDXL API export: a positive and a longer negative encoder, a file saver and a preview. */
function sdxl(): WorkflowGraph {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
        seed: 42,
        steps: 25,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "fixture-checkpoint.safetensors" },
    },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "a cat" } },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["4", 1], text: "blurry, low quality, watermark" },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "ComfyUI" } },
    "12": { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
  };
}

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

  it("drops a leaf node that writes files, and refuses one the graph depends on", async () => {
    const { app } = setup();
    const { workflow } = await created(app, {
      graph: exported({
        "12": {
          class_type: "SaveLatent",
          inputs: { samples: ["7", 0], filename_prefix: "latents/x" },
        },
      }),
    });
    expect(workflow.graph["12"]).toBeUndefined();

    const response = await create(app, createBody({ name: "Pier", graph: readsLatent() }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "blocked_nodes", nodes: ["LoadLatent"] });
  });

  it("judges blocked nodes on the template, not in an output the user left out", async () => {
    const { app } = setup();
    const graph = {
      ...sdxl(),
      "13": { class_type: "LoadImage", inputs: { image: "x.png" } },
      "14": { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: "x" } },
    };
    const { workflow } = await created(app, {
      family: "general",
      graph,
      choices: { output: "9" },
    });
    expect(workflow.graph["13"]).toBeUndefined();

    const response = await create(
      app,
      createBody({ name: "Pier", family: "general", graph, choices: { output: "14" } }),
    );
    expect(response.status).toBe(422);
  });

  it("detects the places of an SDXL export sent with no choices", async () => {
    const { app } = setup();
    const { workflow } = await created(app, { family: "general", graph: sdxl(), choices: {} });
    const prompts = Object.entries(workflow.graph).flatMap(([id, node]) =>
      Object.values(node.inputs).includes("{{prompt}}") ? [id] : [],
    );
    expect(prompts).toEqual(["6"]);
    expect(workflow.graph["7"]?.inputs.text).toBe("blurry, low quality, watermark");
    expect(workflow.graph["3"]?.inputs.seed).toBe("{{seed}}");
    expect(workflow.graph["9"]?.class_type).toBe("SaveImageWebsocket");
    expect(workflow.graph["12"]).toBeUndefined();
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
        graph: readsLatent(),
        choices: CHOICES,
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "blocked_nodes", nodes: ["LoadLatent"] });
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

/** A fixture's `/object_info` entries, for the fake to serve. */
const objectInfoOf = (name: string) =>
  z.record(z.string(), z.unknown()).parse(loadWorkflowFixture(name).objectInfo);

/** A setup whose fake ComfyUI serves a fixture's `/object_info`. */
const fixtureSetup = (
  name: string,
  options: Omit<Setup, "comfy"> & { comfy?: FakeComfyuiOptions } = {},
) => setup({ ...options, comfy: { objectInfo: objectInfoOf(name), ...options.comfy } });

const inspect = (app: App, body: unknown, init: RequestInit = {}) =>
  app.request("/api/workflows/inspect", requestJson("POST", body, init));

async function inspected(app: App, body: unknown): Promise<Inspection> {
  const response = await inspect(app, body);
  expect(response.status).toBe(200);
  return inspectionSchema.parse(await response.json());
}

/** A create from an inspection with its default choices, as the panel saves it untouched. */
const createFrom = (app: App, inspection: Inspection, name = "Imported") =>
  create(app, {
    id: crypto.randomUUID(),
    name,
    family: inspection.detection.familyGuess,
    graph: inspection.graph,
    choices: {},
  });

describe("POST /api/workflows/inspect", () => {
  it("inspects a UI file against the live ComfyUI and previews the report", async () => {
    const { app } = fixtureSetup("sdxl-basic");
    const inspection = await inspected(app, {
      source: loadWorkflowFixture("sdxl-basic").ui,
      fileName: "sdxl-basic.json",
    });
    expect(inspection).toMatchObject({
      format: "ui",
      checked: true,
      live: { state: "ready" },
      blocked: [],
      nameSuggestion: "sdxl-basic",
    });
    expect(inspection.detection).toMatchObject({
      prompt: { chosen: [{ node: "2", input: "text" }] },
      latent: { chosen: "4" },
      seed: [{ node: "5", input: "seed" }],
      output: { chosen: "7" },
      familyGuess: "general",
    });
    expect(inspection.detection.prompt.candidates.map((candidate) => candidate.node)).toEqual([
      "2",
      "3",
    ]);
    expect(inspection.graph["7"]?.class_type).toBe("SaveImageWebsocket");
    expect(inspection.graph["8"]).toBeUndefined();
    expect(inspection.nodes).toEqual([
      { id: "1", title: "CheckpointLoaderSimple", classType: "CheckpointLoaderSimple" },
      { id: "2", title: "Positive", classType: "CLIPTextEncode" },
      { id: "3", title: "Negative", classType: "CLIPTextEncode" },
      { id: "4", title: "EmptyLatentImage", classType: "EmptyLatentImage" },
      { id: "5", title: "KSampler", classType: "KSampler" },
      { id: "6", title: "VAEDecode", classType: "VAEDecode" },
      { id: "7", title: "SaveImage", classType: "SaveImageWebsocket" },
    ]);
    // The report is the file's own, before any choice, naming nodes by the file's titles
    // (this export titles them by class); the prompt is not replaced yet.
    expect(inspection.report.changed).toEqual([
      expect.stringMatching(/^SaveImage \(node 7\) now sends the picture to Ephemera/),
    ]);
    expect(inspection.report.skipped).toEqual([expect.stringMatching(/^PreviewImage \(node 8\)/)]);
    // The tab finalizes it with its choices and shows that report.
    const titles = new Map(inspection.nodes.map((node) => [node.id, node.title]));
    const finalized = finalizeWorkflow(
      { graph: inspection.graph, ...inspection.report },
      inspection.detection,
      {},
      undefined,
      titles,
    );
    if (!finalized.ok) throw new Error(finalized.refusal.error);
    expect(finalized.changed).toContainEqual(
      expect.stringMatching(/^The written prompt of Positive \(node 2\)/),
    );
    expect(finalized.skipped).toEqual(inspection.report.skipped);
    expect(inspection.detection.prompt.candidates.map(({ title }) => title)).toContain("Positive");
  });

  it("suggests the UI file's own name, else the file name without its extension", async () => {
    const { app } = fixtureSetup("sdxl-basic");
    const file = structuredClone(loadWorkflowFixture("sdxl-basic").ui) as Record<string, unknown>;
    file.extra = { info: { name: "Harbour at night" } };
    expect((await inspected(app, { source: file, fileName: "x.json" })).nameSuggestion).toBe(
      "Harbour at night",
    );
    expect(
      (await inspected(app, { source: exported(), fileName: "pier.v2.json" })).nameSuggestion,
    ).toBe("pier.v2");
    expect((await inspected(app, { source: exported() })).nameSuggestion).toBe("");
  });

  it("names an API file's nodes by their `_meta` titles", async () => {
    const { app } = setup();
    const source = exported();
    (source["4"] as { _meta: { title: string } })._meta.title = "Scene prompt";
    const inspection = await inspected(app, { source });
    expect(inspection.format).toBe("api");
    expect(inspection.nodes).toContainEqual({
      id: "4",
      title: "Scene prompt",
      classType: "CLIPTextEncode",
    });
    expect(JSON.stringify(inspection.graph)).not.toContain("_meta");
  });

  it("leaves out a leaf SaveLatent and blocks a latent read from ComfyUI's files", async () => {
    const { app } = setup();
    const leaf = await inspected(app, {
      source: exported({
        "12": {
          class_type: "SaveLatent",
          inputs: { samples: ["7", 0], filename_prefix: "latents/x" },
        },
      }),
    });
    expect(leaf.blocked).toEqual([]);
    expect(leaf.report.skipped).toContainEqual(expect.stringContaining("(node 12)"));
    expect(leaf.graph["12"]).toBeUndefined();

    const reads = await inspected(app, {
      source: readsLatent(),
    });
    expect(reads.blocked).toEqual([{ classType: "LoadLatent", reason: "refused_writes" }]);
    expect(reads.report.skipped).not.toContainEqual(expect.stringContaining("(node 12)"));
  });

  it("blocks an image loader as reference only, in either format", async () => {
    const { app } = fixtureSetup("qwen-edit-images");
    const fixture = loadWorkflowFixture("qwen-edit-images");
    for (const source of [fixture.ui, fixture.api]) {
      expect((await inspected(app, { source })).blocked).toEqual([
        { classType: "LoadImage", reason: "reference_only" },
      ]);
    }
  });

  it("needs a reachable ComfyUI for a UI file but not for an API file", async () => {
    for (const options of [{ comfy: { down: true } }, { address: "" }]) {
      const { app } = setup(options);
      const ui = await inspect(app, { source: loadWorkflowFixture("sdxl-basic").ui });
      expect(ui.status).toBe(409);
      expect(await ui.json()).toEqual({ error: "comfyui_required" });
    }
    const { app } = setup({ comfy: { down: true } });
    const api = await inspected(app, { source: loadWorkflowFixture("sdxl-basic").api });
    expect(api).toMatchObject({
      format: "api",
      checked: false,
      live: { state: "unavailable", reason: "unreachable" },
      blocked: [],
    });
    expect(api.detection).toMatchObject({
      prompt: { chosen: [{ node: "2", input: "text" }] },
      latent: { chosen: "4" },
      seed: [{ node: "5", input: "seed" }],
      output: { chosen: "7" },
    });
    expect(api.nodes).toContainEqual({ id: "2", title: "Positive", classType: "CLIPTextEncode" });
  });

  const successes = loadWorkflowFixtures().flatMap((fixture) =>
    (["ui", "api"] as const).flatMap((format) =>
      fixture.expect[format].ok ? [[fixture.name, format] as const] : [],
    ),
  );
  it.each(successes)(
    "inspects %s (%s) and creates it with the default choices",
    async (name, format) => {
      const { app } = fixtureSetup(name);
      const inspection = await inspected(app, { source: loadWorkflowFixture(name)[format] });
      expect(inspection.format).toBe(format);
      expect(inspection.blocked).toEqual([]);
      expect(inspection.live).toEqual({ state: "ready" });
      const response = await createFrom(app, inspection);
      expect(response.status).toBe(201);
      const { workflow, checked } = workflowSavedResponseSchema.parse(await response.json());
      expect(checked).toBe(true);
      expect(JSON.stringify(workflow.graph)).toContain("{{prompt}}");
    },
  );

  it("refuses a body past 2 MiB, a file nested too deep and a long or unknown field", async () => {
    const { app } = fixtureSetup("sdxl-basic");
    const large = await inspect(app, { source: { blob: "x".repeat(3 * 1024 * 1024) } });
    expect(large.status).toBe(413);

    let deep: unknown = 1;
    for (let level = 0; level < 20; level++) deep = { a: deep };
    const tooDeep = await inspect(app, { source: deep });
    expect(tooDeep.status).toBe(422);
    expect(await tooDeep.json()).toEqual({ error: "invalid_workflow", code: "too_deep" });

    const source = loadWorkflowFixture("sdxl-basic").ui;
    expect((await inspect(app, { source, fileName: "x".repeat(300) })).status).toBe(400);
    expect((await inspect(app, { source, extra: 1 })).status).toBe(400);
  });

  it.each([
    ["the file", (body: string) => body.replace('"source":{', '"source":{"__proto__":{"x":1},')],
    ["a nested object", (body: string) => body.replace('"extra":{', '"extra":{"constructor":1,')],
  ])("refuses a reserved key in %s", async (_label, edit) => {
    const { app } = fixtureSetup("sdxl-basic");
    const text = edit(JSON.stringify({ source: loadWorkflowFixture("sdxl-basic").ui }));
    expect(text).toMatch(/__proto__|constructor/);
    const response = await app.request("/api/workflows/inspect", {
      method: "POST",
      headers: ownerHeaders(),
      body: text,
    });
    expect(response.status).toBe(400);
  });

  it("refuses a file that is neither format", async () => {
    const { app } = setup();
    const response = await inspect(app, { source: { nodes: 1 } });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_workflow", code: "not_a_workflow" });
  });

  it("admits one inspect at a time per user, and frees the slot when the client goes away", async () => {
    let reached = () => {};
    const holding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held = false;
    const { app } = fixtureSetup("sdxl-basic", {
      wrap: (fetch) => async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (new URL(request.url).pathname === "/object_info" && !held) {
          held = true;
          reached();
          const signal = init?.signal ?? request.signal;
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return fetch(input, init);
      },
    });
    const body = { source: loadWorkflowFixture("sdxl-basic").ui };
    const controller = new AbortController();
    const first = inspect(app, body, { signal: controller.signal });
    await holding;

    const second = await inspect(app, body);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "busy" });

    controller.abort();
    const third = await inspect(app, body);
    expect(third.status).toBe(200);
    await first;
  });

  it("logs one line with operational fields only", async () => {
    const { app, lines } = fixtureSetup("sdxl-basic");
    await inspected(app, {
      source: loadWorkflowFixture("sdxl-basic").ui,
      fileName: "harbour.json",
    });
    const [line, ...rest] = workflowLines(lines);
    expect(rest).toEqual([]);
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ["time", "level", "event", "status", "durationMs", "format", "nodes", "checked"].sort(),
    );
    expect(line).toMatchObject({
      event: "workflows.inspect",
      status: 200,
      format: "ui",
      nodes: 7,
      checked: true,
    });
    const text = lines.join("\n");
    for (const secret of [
      "harbour",
      "Positive",
      "lighthouse",
      "CLIPTextEncode",
      "SaveImage",
      "safetensors",
    ]) {
      expect(text).not.toContain(secret);
    }

    const { app: down, lines: downLines } = setup({ comfy: { down: true } });
    await inspect(down, { source: loadWorkflowFixture("sdxl-basic").ui });
    expect(workflowLines(downLines)).toEqual([
      expect.objectContaining({
        event: "workflows.inspect",
        status: 409,
        format: "ui",
        checked: false,
        errorClass: "comfyui_required",
      }),
    ]);
  });
});
