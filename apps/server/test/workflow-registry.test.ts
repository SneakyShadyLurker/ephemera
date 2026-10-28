import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@ephemera/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_WORKFLOWS_DIR,
  createWorkflowRegistry,
  discoverWorkflows,
  loadWorkflowRegistry,
  WorkflowFileError,
  type WorkflowRegistry,
} from "../src/comfyui/workflow.ts";
import { loadConfig } from "../src/config.ts";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";
import { readWorkflowFiles } from "../src/persistence/workflow-files.ts";
import { ownerHeaders, requestJson, sharedStores, TEST_USER, testApp } from "./helpers.ts";
import { FIXTURE_WORKFLOWS_DIR, testWorkflows } from "./test-workflows.ts";

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

const ids = (registry: WorkflowRegistry) => registry.list.workflows.map(({ id }) => id);

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
      { id: "krea2-fixture", name: "Krea 2 Fixture" },
      { id: "krea2-gonzalomo", name: "Krea 2 Gonzalomo" },
      { id: "moss-fixture", name: "MOSS Fixture" },
    ]);
    expect(registry.get("moss-fixture").artModel).toBe("moss");
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
    expect(registry.referenceOf("krea2-fixture")?.artModel).toBe("krea2");
  });

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
    ["flux-other.json", "{}", "workflow file name names no image model: flux-other.json"],
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
