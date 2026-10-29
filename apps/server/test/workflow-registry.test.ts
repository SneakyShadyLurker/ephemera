import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@ephemera/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAllowlist } from "../src/comfyui/allowlist.ts";
import {
  BUNDLED_WORKFLOWS_DIR,
  createWorkflowRegistry,
  discoverWorkflows,
  loadWorkflowRegistry,
  type ServerWorkflows,
  WorkflowFileError,
} from "../src/comfyui/workflow.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";
import { readWorkflowFiles } from "../src/persistence/workflow-files.ts";
import { ownerHeaders, requestJson, sharedStores, TEST_USER, testApp } from "./helpers.ts";
import { FIXTURE_WORKFLOWS_DIR, fluxGeneralSource, testWorkflows } from "./test-workflows.ts";

/** The e2e suite's synthetic second workflow. */
const E2E_WORKFLOWS_DIR = new URL("../../../e2e/support/workflows", import.meta.url).pathname;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What loading throws, for assertions on the error itself. */
function thrownBy(load: () => unknown): unknown {
  try {
    load();
  } catch (error) {
    return error;
  }
  throw new Error("loading did not throw");
}

/** A scratch directory holding copies of `files` from `from`, and `extra` written as given. */
function directory(from: string, files: string[], extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ephemera-workflows-"));
  scratch.push(dir);
  for (const file of files) copyFileSync(join(from, file), join(dir, file));
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, file), text);
  return dir;
}

const ids = (registry: ServerWorkflows) => registry.list.workflows.map(({ id }) => id);

describe("the workflow registry", () => {
  it("without either variable holds the bundled set, with krea2-gonzalomo as the default", () => {
    const registry = loadWorkflowRegistry({});
    const bundled = discoverWorkflows(readWorkflowFiles(BUNDLED_WORKFLOWS_DIR));
    expect(ids(registry)).toEqual([...bundled.workflows.keys()]);
    expect(ids(registry)).toContain("krea2-gonzalomo");
    expect(DEFAULT_SETTINGS.comfyuiWorkflow).toBe("krea2-gonzalomo");
    expect(registry.defaultWorkflow).toBe("krea2-gonzalomo");
    expect(registry.referenceOf("krea2-gonzalomo")).toBeDefined();
  });

  it("joins an external directory's graphs in file name order", () => {
    const bundled = directory(BUNDLED_WORKFLOWS_DIR, [
      "krea2-gonzalomo.json",
      "krea2-gonzalomo.reference.json",
    ]);
    const registry = loadWorkflowRegistry({
      bundledDir: bundled,
      workflowsDir: FIXTURE_WORKFLOWS_DIR,
    });
    expect(registry.list.workflows).toEqual([
      { id: "krea2-fixture", name: "Krea 2 Fixture", family: "krea2", scope: "server" },
      { id: "krea2-gonzalomo", name: "Krea 2 Gonzalomo", family: "krea2", scope: "server" },
      { id: "moss-fixture", name: "MOSS Fixture", family: "moss", scope: "server" },
    ]);
    expect(registry.get("moss-fixture").family).toBe("moss");
    expect(registry.referenceOf("krea2-fixture")).toBeDefined();
    expect(registry.referenceOf("moss-fixture")).toBeUndefined();
    expect(registry.defaultWorkflow).toBe("krea2-gonzalomo");
  });

  it("pairs an external reference graph with a bundled workflow", () => {
    const bundled = directory(FIXTURE_WORKFLOWS_DIR, ["krea2-fixture.json"]);
    const external = directory(FIXTURE_WORKFLOWS_DIR, ["krea2-fixture.reference.json"]);
    const registry = loadWorkflowRegistry({
      bundledDir: bundled,
      workflowsDir: external,
      defaultWorkflow: "krea2-fixture",
    });
    expect(ids(registry)).toEqual(["krea2-fixture"]);
    expect(registry.referenceOf("krea2-fixture")?.family).toBe("krea2");
  });

  it("admits a file whose first word names no family as a General workflow and logs it once", () => {
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], {
      "flux-thing.json": fluxGeneralSource(),
    });
    const lines: string[] = [];
    const registry = loadWorkflowRegistry({
      workflowsDir: external,
      log: createLogger((line) => lines.push(line)),
    });
    expect(registry.get("flux-thing").family).toBe("general");
    expect(registry.list.workflows).toContainEqual({
      id: "flux-thing",
      name: "Flux Thing",
      family: "general",
      scope: "server",
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        time: expect.any(String),
        level: "info",
        event: "startup.workflows",
        family: "general",
        file: "flux-thing.json",
      },
    ]);
  });

  it("reads a file's family and name from its reserved ephemera key, which leaves the graph", () => {
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], {
      "flux-general.json": fluxGeneralSource({ family: "moss", name: "Flux Portrait" }),
    });
    const lines: string[] = [];
    const registry = loadWorkflowRegistry({
      workflowsDir: external,
      log: createLogger((line) => lines.push(line)),
    });
    const workflow = registry.get("flux-general");
    expect(workflow.family).toBe("moss");
    expect(Object.hasOwn(workflow.graph, "ephemera")).toBe(false);
    expect(registry.list.workflows).toContainEqual({
      id: "flux-general",
      name: "Flux Portrait",
      family: "moss",
      scope: "server",
    });
    expect(lines).toEqual([]);
  });

  it("logs nothing for a file that declares the General family", () => {
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], {
      "flux-general.json": fluxGeneralSource({ family: "general" }),
    });
    const lines: string[] = [];
    const registry = loadWorkflowRegistry({
      workflowsDir: external,
      log: createLogger((line) => lines.push(line)),
    });
    expect(registry.get("flux-general").family).toBe("general");
    expect(registry.list.workflows).toContainEqual({
      id: "flux-general",
      name: "Flux General",
      family: "general",
      scope: "server",
    });
    expect(lines).toEqual([]);
  });

  it.each([
    ["an unknown family", { family: "flux" }],
    ["an extra key", { family: "general", note: "x" }],
    ["an empty name", { name: "  " }],
  ])("refuses an ephemera key with %s, naming the file", (_, ephemera) => {
    const file = "flux-general.json";
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], { [file]: fluxGeneralSource(ephemera) });
    const thrown = thrownBy(() => loadWorkflowRegistry({ workflowsDir: external }));
    expect(thrown).toBeInstanceOf(WorkflowFileError);
    expect((thrown as WorkflowFileError).message).toBe(
      `workflow file is not a valid workflow: ${file}`,
    );
    expect((thrown as WorkflowFileError).file).toBe(file);
  });

  it.each(["user-anything.json", "user-anything.reference.json"])(
    "refuses %s, whose name uses the reserved prefix",
    (file) => {
      const external = directory(FIXTURE_WORKFLOWS_DIR, [], { [file]: fluxGeneralSource() });
      const thrown = thrownBy(() => loadWorkflowRegistry({ workflowsDir: external }));
      expect(thrown).toBeInstanceOf(WorkflowFileError);
      expect((thrown as WorkflowFileError).message).toBe(
        `workflow file name uses the reserved prefix: ${file}`,
      );
      expect((thrown as WorkflowFileError).file).toBe(file);
    },
  );

  it.each(["krea2-gonzalomo.json", "krea2-gonzalomo.reference.json"])(
    "refuses a second %s, naming the file",
    (file) => {
      const external = directory(BUNDLED_WORKFLOWS_DIR, [file]);
      const thrown = thrownBy(() => loadWorkflowRegistry({ workflowsDir: external }));
      expect(thrown).toBeInstanceOf(WorkflowFileError);
      expect((thrown as WorkflowFileError).message).toBe(`workflow file name is taken: ${file}`);
      expect((thrown as WorkflowFileError).file).toBe(file);
    },
  );

  it.each([
    ["krea2-broken.json", "{ not json", "workflow file is not readable JSON: krea2-broken.json"],
    ["krea2-shape.json", '{"1": {}}', "workflow file is not a valid workflow: krea2-shape.json"],
  ])("refuses %s, naming the file only", (file, text, message) => {
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], { [file]: text });
    const thrown = thrownBy(() => loadWorkflowRegistry({ workflowsDir: external }));
    expect(thrown).toBeInstanceOf(WorkflowFileError);
    expect((thrown as WorkflowFileError).message).toBe(message);
    expect((thrown as WorkflowFileError).message).not.toContain(external);
    expect((thrown as WorkflowFileError).name).toBe("WorkflowFileError");
    expect((thrown as WorkflowFileError).file).toBe(file);
  });

  /** The fixture graph with one more node of `classType`, as text. */
  const withNode = (classType: string) => {
    const graph = JSON.parse(
      readFileSync(join(FIXTURE_WORKFLOWS_DIR, "moss-fixture.json"), "utf8"),
    );
    graph["99"] = { class_type: classType, inputs: { images: ["8", 0], filename_prefix: "x" } };
    return JSON.stringify(graph);
  };

  it.each(["SaveImage", "PreviewImage", "SomeCustomNode"])(
    "refuses a graph with a %s node, which is not allowed, naming the file",
    (classType) => {
      const file = "moss-extra.json";
      const external = directory(FIXTURE_WORKFLOWS_DIR, [], { [file]: withNode(classType) });
      const thrown = thrownBy(() => loadWorkflowRegistry({ workflowsDir: external }));
      expect(thrown).toBeInstanceOf(WorkflowFileError);
      expect((thrown as WorkflowFileError).message).toBe(
        `workflow file is not a valid workflow: ${file}`,
      );
      expect((thrown as WorkflowFileError).file).toBe(file);
    },
  );

  it("admits a graph with an extra class only when the allowlist lists it", () => {
    const file = "moss-extra.json";
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], { [file]: withNode("MyNode") });
    const thrown = thrownBy(() => loadWorkflowRegistry({ workflowsDir: external }));
    expect(thrown).toBeInstanceOf(WorkflowFileError);
    expect((thrown as WorkflowFileError).file).toBe(file);
    const registry = loadWorkflowRegistry({
      workflowsDir: external,
      allowlist: createAllowlist(["MyNode"]),
    });
    expect(ids(registry)).toContain("moss-extra");
  });

  it("refuses a graph with a SaveImage node even when the allowlist lists it", () => {
    const file = "moss-extra.json";
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], { [file]: withNode("SaveImage") });
    const thrown = thrownBy(() =>
      loadWorkflowRegistry({ workflowsDir: external, allowlist: createAllowlist(["SaveImage"]) }),
    );
    expect(thrown).toBeInstanceOf(WorkflowFileError);
    expect((thrown as WorkflowFileError).file).toBe(file);
  });

  it("admits the e2e suite's synthetic graph", () => {
    const registry = loadWorkflowRegistry({ workflowsDir: E2E_WORKFLOWS_DIR });
    expect(ids(registry)).toContain("krea2-second");
  });

  it("refuses a reference graph without its workflow, naming the file", () => {
    const external = directory(FIXTURE_WORKFLOWS_DIR, ["krea2-fixture.reference.json"]);
    const thrown = thrownBy(() => loadWorkflowRegistry({ workflowsDir: external }));
    expect(thrown).toBeInstanceOf(WorkflowFileError);
    expect((thrown as WorkflowFileError).message).toBe(
      "reference graph has no workflow: krea2-fixture.reference.json",
    );
    expect((thrown as WorkflowFileError).file).toBe("krea2-fixture.reference.json");
  });

  it("accepts an empty external directory, as the Compose placeholder binds", () => {
    const external = directory(FIXTURE_WORKFLOWS_DIR, [], { ".keep": "" });
    expect(ids(loadWorkflowRegistry({ workflowsDir: external }))).toEqual(
      ids(loadWorkflowRegistry({})),
    );
  });

  it("uses a configured default, and refuses one without a graph", () => {
    const registry = loadWorkflowRegistry({
      workflowsDir: FIXTURE_WORKFLOWS_DIR,
      defaultWorkflow: "moss-fixture",
    });
    expect(registry.defaultWorkflow).toBe("moss-fixture");
    expect(registry.known("krea2-removed")).toBe("moss-fixture");
    expect(registry.requested(undefined, "krea2-removed")).toBe("moss-fixture");
    expect(() => loadWorkflowRegistry({ defaultWorkflow: "krea2-removed" })).toThrow(
      "the default workflow has no file",
    );
    expect(() => createWorkflowRegistry({ files: [] })).toThrow("the default workflow has no file");
  });
});

describe("workflow configuration", () => {
  const env = {
    EPHEMERA_UPSTREAM_BASE_URL: "http://upstream.test/v1",
    EPHEMERA_UPSTREAM_API_KEY: "key",
    EPHEMERA_PROXY_KEY: "p".repeat(40),
    EPHEMERA_DATA_KEY: "0".repeat(64),
    EPHEMERA_ORIGIN: "https://ephemera.test",
  };

  it("reads both variables as optional, an empty value as unset", () => {
    expect(loadConfig(env)).toMatchObject({ workflowsDir: undefined, defaultWorkflow: undefined });
    expect(
      loadConfig({ ...env, EPHEMERA_WORKFLOWS_DIR: "", EPHEMERA_DEFAULT_WORKFLOW: "" }),
    ).toMatchObject({ workflowsDir: undefined, defaultWorkflow: undefined });
    expect(
      loadConfig({
        ...env,
        EPHEMERA_WORKFLOWS_DIR: "/run/workflows",
        EPHEMERA_DEFAULT_WORKFLOW: "krea2-fixture",
      }),
    ).toMatchObject({ workflowsDir: "/run/workflows", defaultWorkflow: "krea2-fixture" });
  });

  it("reads EPHEMERA_COMFYUI_EXTRA_NODES as a trimmed comma list, empty entries ignored", () => {
    expect(loadConfig(env).extraNodes).toEqual([]);
    expect(loadConfig({ ...env, EPHEMERA_COMFYUI_EXTRA_NODES: "" }).extraNodes).toEqual([]);
    const { extraNodes } = loadConfig({
      ...env,
      EPHEMERA_COMFYUI_EXTRA_NODES: " MyNode, ,Pack.Node:v2 ,",
    });
    expect(extraNodes).toEqual(["MyNode", "Pack.Node:v2"]);
    expect(createAllowlist(extraNodes).allows("MyNode", "import")).toBe(true);
  });

  it.each([
    ["a name with a space", "My Node"],
    ["a name over 128 characters", "N".repeat(129)],
    ["more than 200 names", Array.from({ length: 201 }, (_, i) => `Node${i}`).join(",")],
  ])("refuses EPHEMERA_COMFYUI_EXTRA_NODES with %s, naming the variable", (_, value) => {
    expect(() => loadConfig({ ...env, EPHEMERA_COMFYUI_EXTRA_NODES: value })).toThrow(
      "Invalid or missing environment variables: EPHEMERA_COMFYUI_EXTRA_NODES",
    );
  });

  it.each(["SaveImage", "LoadLatent", "MyCustomSave", "PreviewThing"])(
    "refuses EPHEMERA_COMFYUI_EXTRA_NODES naming %s, a node that writes, naming the variable and the class",
    (classType) => {
      const thrown = thrownBy(() =>
        loadConfig({ ...env, EPHEMERA_COMFYUI_EXTRA_NODES: `MyNode,${classType}` }),
      );
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).variables).toEqual(["EPHEMERA_COMFYUI_EXTRA_NODES"]);
      expect((thrown as ConfigError).message).toContain("EPHEMERA_COMFYUI_EXTRA_NODES");
      expect((thrown as ConfigError).message).toContain(classType);
    },
  );

  it("accepts SaveImageWebsocket in EPHEMERA_COMFYUI_EXTRA_NODES, already curated", () => {
    expect(
      loadConfig({ ...env, EPHEMERA_COMFYUI_EXTRA_NODES: "SaveImageWebsocket" }).extraNodes,
    ).toEqual(["SaveImageWebsocket"]);
  });

  it("refuses a default that is not a workflow id, naming the variable only", () => {
    expect(() => loadConfig({ ...env, EPHEMERA_DEFAULT_WORKFLOW: "../Secret Name" })).toThrow(
      "Invalid or missing environment variables: EPHEMERA_DEFAULT_WORKFLOW",
    );
  });
});

describe("the saved workflow under a configured default", () => {
  const read = async (app: ReturnType<typeof testApp>["app"]) =>
    (
      (await (await app.request("/api/settings", { headers: ownerHeaders() })).json()) as {
        settings: { comfyuiWorkflow: string };
      }
    ).settings.comfyuiWorkflow;

  it("seeds a new user's settings with the configured default", async () => {
    const { app, instances } = testApp({ workflows: testWorkflows("krea2-fixture") });
    expect(await read(app)).toBe("krea2-fixture");
    expect(instances.instance(TEST_USER).stores.settings.get().comfyuiWorkflow).toBe(
      "krea2-fixture",
    );
  });

  it("keeps an existing user's saved choice", async () => {
    const stores = createStores(openUserDatabase(undefined).db, createMemoryPortraitFiles());
    stores.settings.update({ comfyuiWorkflow: "moss-fixture" });
    const { app } = testApp({
      workflows: testWorkflows("krea2-fixture"),
      instances: sharedStores(stores),
    });
    expect(await read(app)).toBe("moss-fixture");
  });

  it("reads a vanished choice as the default and refuses an unknown one on write", async () => {
    const stores = createStores(openUserDatabase(undefined).db, createMemoryPortraitFiles());
    stores.settings.update({ comfyuiWorkflow: "krea2-removed" });
    const { app } = testApp({
      workflows: testWorkflows("krea2-fixture"),
      instances: sharedStores(stores),
    });
    expect(await read(app)).toBe("krea2-fixture");
    const refused = await app.request(
      "/api/settings",
      requestJson("PATCH", { comfyuiWorkflow: "krea2-removed" }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "unknown_reference" });
    const listed = await app.request("/api/creator/art/workflows", { headers: ownerHeaders() });
    expect(((await listed.json()) as { workflows: { id: string }[] }).workflows).toEqual(
      testWorkflows().list.workflows,
    );
  });
});
