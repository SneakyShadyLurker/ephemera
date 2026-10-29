import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type WorkflowGraph,
  workflowSavedResponseSchema,
  workflowsResponseSchema,
} from "@ephemera/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDirContaining, filesContaining, holds } from "../../../e2e/support/scan.ts";
import bundled from "../src/comfyui/workflows/krea2-gonzalomo.json" with { type: "json" };
import { createLogger } from "../src/log.ts";
import { createInstanceRegistry, type InstanceRegistry } from "../src/persistence/index.ts";
import { fakeComfyui } from "./fake-comfyui.ts";
import { ownerHeaders, requestJson, TEST_USER, testApp } from "./helpers.ts";
import { TEST_WORKFLOWS } from "./test-workflows.ts";

/*
 * The retention matrix row for imported workflows (docs/specs/workflow-import.md
 * § 13): the prompt place's literal text is replaced by `{{prompt}}` before
 * anything is stored, so a sentinel written there by the user reaches no
 * database file, no log line, no temp path and no response.
 */

const COMFY = "http://comfy.test:8188";
const CHOICES = { output: "9", latent: "6", prompt: ["4"] };

type Node = { class_type: string; inputs: Record<string, unknown> };

/** The bundled graph as a user's API export carries it, its prompt place holding `text`. */
function exported(text: string): Record<string, Node> {
  const graph: Record<string, Node> = structuredClone(bundled);
  Object.assign(graph["4"]?.inputs ?? {}, { text });
  Object.assign(graph["6"]?.inputs ?? {}, { width: 1024, height: 1536, batch_size: 1 });
  Object.assign(graph["7"]?.inputs ?? {}, { seed: 1234567 });
  return graph;
}

/** The same export without the attention node: one node fewer. */
function smaller(text: string): Record<string, Node> {
  const { "10": _attention, ...graph } = exported(text);
  Object.assign(graph["7"]?.inputs ?? {}, { model: ["1", 0] });
  return graph;
}

const promptOf = (graph: WorkflowGraph) => graph["4"]?.inputs.text;

let root: string;
let previousTmp: string | undefined;
let registry: InstanceRegistry | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ephemera-workflows-retention-"));
  // The process temp directory the app could write, redirected so it can be scanned whole.
  previousTmp = process.env.TMPDIR;
  const tmp = join(root, "tmp");
  await mkdir(tmp, { mode: 0o700 });
  process.env.TMPDIR = tmp;
});

afterEach(async () => {
  await registry?.close();
  registry = undefined;
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  await rm(root, { recursive: true, force: true });
});

describe("workflow retention", () => {
  it("keeps the prompt place's text out of the data dir, logs, temp paths and responses", async () => {
    const first = `workflow-sentinel-${crypto.randomUUID()}`;
    const second = `workflow-sentinel-${crypto.randomUUID()}`;
    const sentinels = [first, second];

    const dataDir = join(root, "data");
    const tmp = join(root, "tmp");
    await mkdir(dataDir, { mode: 0o700 });
    expect(tmpdir()).toBe(tmp);
    const key = randomBytes(32);
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    const comfy = fakeComfyui();
    registry = createInstanceRegistry({
      dataDir,
      key,
      log,
      defaultWorkflow: TEST_WORKFLOWS.defaultWorkflow,
    });
    const { app, instances } = testApp({
      fetch: comfy.fetch,
      workflows: TEST_WORKFLOWS,
      instances: registry,
      log,
    });
    instances.instance(TEST_USER).stores.settings.update({ comfyuiBaseUrl: COMFY });

    const bodies: string[] = [];
    const id = crypto.randomUUID();
    const createResponse = await app.request(
      "/api/workflows",
      requestJson("POST", {
        id,
        name: "Lighthouse",
        family: "krea2",
        graph: exported(first),
        choices: CHOICES,
      }),
    );
    const createText = await createResponse.text();
    bodies.push(createText);
    expect(createResponse.status).toBe(201);
    const created = workflowSavedResponseSchema.parse(JSON.parse(createText)).workflow;
    expect(promptOf(created.graph)).toBe("{{prompt}}");

    const listed = async () => {
      const response = await app.request("/api/workflows", { headers: ownerHeaders() });
      const text = await response.text();
      bodies.push(text);
      expect(response.status).toBe(200);
      const found = workflowsResponseSchema
        .parse(JSON.parse(text))
        .workflows.find((one) => one.id === id);
      if (found === undefined) throw new Error("workflow is not listed");
      return found;
    };
    const before = await listed();

    const replaceResponse = await app.request(
      `/api/workflows/${id}/graph`,
      requestJson("PUT", { revision: created.revision, graph: smaller(second), choices: CHOICES }),
    );
    const replaceText = await replaceResponse.text();
    bodies.push(replaceText);
    expect(replaceResponse.status).toBe(200);
    const replaced = workflowSavedResponseSchema.parse(JSON.parse(replaceText)).workflow;
    expect(promptOf(replaced.graph)).toBe("{{prompt}}");
    expect(replaced.revision).toBeGreaterThan(created.revision);
    const after = await listed();
    expect(after.revision).toBe(replaced.revision);
    expect(after.nodes).not.toBe(before.nodes);

    // The stored template, read from the store the next request would use.
    const stored = instances.instance(TEST_USER).stores.workflows.get(id);
    expect(stored === undefined ? undefined : promptOf(stored.graph)).toBe("{{prompt}}");

    // Every write is on disk once the registry closes.
    await registry.close();
    registry = undefined;

    const data = await dataDirContaining(dataDir, sentinels, key);
    expect(data.unreadable).toEqual([]);
    expect(data.decrypted).toBeGreaterThan(0);
    expect(data.hits).toEqual([]);
    // Positive control: the decrypted image is scanned as plaintext and holds the template.
    expect((await dataDirContaining(dataDir, "{{prompt}}", key)).hits).not.toEqual([]);

    const temp = await filesContaining(tmp, sentinels);
    expect(temp.unreadable).toEqual([]);
    expect(temp.hits).toEqual([]);

    expect(lines.some((line) => line.includes("workflows.create"))).toBe(true);
    expect(lines.some((line) => line.includes("workflows.replace"))).toBe(true);
    const logged = Buffer.from(lines.join("\n"));
    for (const sentinel of sentinels) {
      expect(holds(logged, sentinel)).toBe(false);
      for (const body of bodies) expect(holds(Buffer.from(body), sentinel)).toBe(false);
    }
  });
});
