import { describe, expect, it } from "vitest";
import { createAllowlist, type NodeAllowlist } from "../src/comfyui/allowlist.ts";
import { createWorkflowCatalog, runWorkflow } from "../src/comfyui/catalog.ts";
import { createWorkflowRegistry } from "../src/comfyui/workflow.ts";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
  type Stores,
} from "../src/persistence/index.ts";
import { storeUserWorkflow, TEST_WORKFLOWS, userGraph } from "./test-workflows.ts";

const SERVER = TEST_WORKFLOWS;
const ALLOWLIST = createAllowlist([]);

function fresh(): Stores {
  return createStores(openUserDatabase(undefined).db, createMemoryPortraitFiles(), {
    defaultWorkflow: SERVER.defaultWorkflow,
  });
}

const catalogOf = (stores: Stores, allowlist: NodeAllowlist = ALLOWLIST) =>
  createWorkflowCatalog(SERVER, stores.workflows, allowlist);

describe("the workflow catalog", () => {
  it("lists the user's workflows by name, then the server's, each with its scope and family", () => {
    const stores = fresh();
    const b = storeUserWorkflow(stores.workflows, { name: "b portrait", family: "general" });
    const a = storeUserWorkflow(stores.workflows, { name: "A portrait", family: "moss" });
    expect(catalogOf(stores).list.workflows).toEqual([
      { id: a.id, name: "A portrait", family: "moss", scope: "user" },
      { id: b.id, name: "b portrait", family: "general", scope: "user" },
      ...SERVER.list.workflows,
    ]);
    expect(SERVER.list.workflows.every((option) => option.scope === "server")).toBe(true);
  });

  it("is the server's list alone for a user without workflows", () => {
    expect(catalogOf(fresh()).list).toEqual(SERVER.list);
  });

  it("gives a stored graph with its output and models computed as for a file", () => {
    const stores = fresh();
    const graph = userGraph(5);
    const { id } = storeUserWorkflow(stores.workflows, { graph, family: "general" });
    const asFile = createWorkflowRegistry({
      files: [{ file: "krea2-mine.json", source: graph }],
      defaultWorkflow: "krea2-mine",
    }).get("krea2-mine");
    const catalog = catalogOf(stores);
    expect(catalog.has(id)).toBe(true);
    expect(catalog.get(id)).toEqual({
      graph,
      output: asFile.output,
      models: asFile.models,
      family: "general",
      blocked: [],
    });
    expect(catalog.get(SERVER.defaultWorkflow)).toEqual({
      ...SERVER.get(SERVER.defaultWorkflow),
      blocked: [],
    });
  });

  it("still lists a stored graph whose class the allowlist no longer admits, with the class blocked", () => {
    const stores = fresh();
    const graph = userGraph(5, { "20": { class_type: "OperatorNode", inputs: {} } });
    // Admitted while the operator listed the class.
    expect(createAllowlist(["OperatorNode"]).allows("OperatorNode", "import")).toBe(true);
    const { id } = storeUserWorkflow(stores.workflows, { graph });
    const catalog = catalogOf(stores);
    expect(catalog.list.workflows.map((option) => option.id)).toContain(id);
    expect(catalog.has(id)).toBe(true);
    expect(catalog.get(id).blocked).toEqual(["OperatorNode"]);
    expect(catalogOf(stores, createAllowlist(["OperatorNode"])).get(id).blocked).toEqual([]);
  });

  it("lists a stored graph it cannot read as blocked instead of failing", () => {
    const stores = fresh();
    const graph = userGraph(5);
    delete graph["9"];
    const { id } = storeUserWorkflow(stores.workflows, { graph });
    const catalog = catalogOf(stores);
    expect(catalog.list.workflows.map((option) => option.id)).toContain(id);
    expect(catalog.get(id).blocked).toEqual(["invalid_graph"]);
  });

  it("blocks a class only reference graphs may use", () => {
    const stores = fresh();
    const graph = userGraph(5, {
      "20": { class_type: "LoadImage", inputs: { image: "x.png" } },
    });
    const { id } = storeUserWorkflow(stores.workflows, { graph });
    expect(catalogOf(stores).get(id).blocked).toEqual(["LoadImage"]);
  });

  it("reads a deleted user workflow as the default and never runs it in another's place", () => {
    const stores = fresh();
    const { id, uuid } = storeUserWorkflow(stores.workflows);
    const before = catalogOf(stores);
    expect(before.known(id)).toBe(id);
    expect(before.requested(undefined, id)).toBe(id);
    expect(before.requested(id, SERVER.defaultWorkflow)).toBe(id);
    stores.workflows.remove(uuid);
    const after = catalogOf(stores);
    expect(after.has(id)).toBe(false);
    expect(after.known(id)).toBe(SERVER.defaultWorkflow);
    expect(after.requested(undefined, id)).toBe(SERVER.defaultWorkflow);
    expect(after.requested(id, SERVER.defaultWorkflow)).toBeUndefined();
    expect(() => after.get(id)).toThrow();
    expect(after.list).toEqual(SERVER.list);
  });

  it("refuses ids that only look like a user's", () => {
    const catalog = catalogOf(fresh());
    for (const id of ["user-", `user-${crypto.randomUUID().toUpperCase()}`, "user-x"]) {
      expect(catalog.has(id)).toBe(false);
      expect(catalog.known(id)).toBe(SERVER.defaultWorkflow);
    }
  });

  it("keeps the server's default and its reference graphs, never one for a user workflow", () => {
    const stores = fresh();
    const { id } = storeUserWorkflow(stores.workflows);
    const catalog = catalogOf(stores);
    expect(catalog.defaultWorkflow).toBe(SERVER.defaultWorkflow);
    expect(catalog.referenceOf(id)).toBeUndefined();
    expect(catalog.referenceOf("krea2-fixture")).toEqual(SERVER.referenceOf("krea2-fixture"));
  });

  it("reads each request's own rows: a replaced graph shows in the next catalog", () => {
    const stores = fresh();
    const { id, uuid } = storeUserWorkflow(stores.workflows, { graph: userGraph(5) });
    const first = catalogOf(stores);
    const pinned = runWorkflow(first, id);
    stores.workflows.replaceGraph(uuid, userGraph(9), 0);
    expect(catalogOf(stores).get(id).graph["7"]?.inputs.steps).toBe(9);
    expect(pinned.graph["7"]?.inputs.steps).toBe(5);
  });

  it("resolves what a run takes, with the reference graph of a server workflow", () => {
    const stores = fresh();
    const { id } = storeUserWorkflow(stores.workflows);
    const catalog = catalogOf(stores);
    const run = runWorkflow(catalog, id);
    expect(run).toEqual({ id, ...catalog.get(id) });
    expect(run).not.toHaveProperty("reference");
    expect(runWorkflow(catalog, "krea2-fixture")).toEqual({
      id: "krea2-fixture",
      ...catalog.get("krea2-fixture"),
      reference: SERVER.referenceOf("krea2-fixture"),
    });
    expect(runWorkflow(catalog, SERVER.defaultWorkflow)).toMatchObject({
      reference: SERVER.referenceOf(SERVER.defaultWorkflow),
    });
  });
});
