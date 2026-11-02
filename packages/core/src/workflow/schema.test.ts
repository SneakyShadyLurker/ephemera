import { describe, expect, it } from "vitest";
import {
  workflowDeleteResponseSchema,
  workflowResponseSchema,
  workflowSavedResponseSchema,
  workflowsResponseSchema,
} from "../responses.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { workflowRefusalSchema } from "./finalize.ts";
import {
  inspectionSchema,
  storedWorkflowSchema,
  workflowCreateSchema,
  workflowFieldsSchema,
  workflowGraphReplaceSchema,
  workflowInspectSchema,
  workflowPatchSchema,
  workflowSaveErrorSchema,
  workflowSummarySchema,
} from "./schema.ts";

const UUID = "0b6f7c3e-2d4a-4f8e-9a1b-5c6d7e8f9a0b";
const graph = { 9: { class_type: "SaveImageWebsocket", inputs: { images: ["8", 0] } } };
const fields = { name: "Flux Portrait", family: "general", graph };
const stored = { ...fields, id: UUID, revision: 0, createdAt: 1, updatedAt: 2 };
const candidate = { node: "9", title: "Save", classType: "SaveImageWebsocket", inputs: ["images"] };

describe("workflow fields", () => {
  it("trims the name and refuses empty, long and control-character names", () => {
    expect(workflowFieldsSchema.parse({ ...fields, name: "  Flux  " }).name).toBe("Flux");
    for (const name of ["", "   ", "x".repeat(65), "a\nb"]) {
      expect(workflowFieldsSchema.safeParse({ ...fields, name }).success).toBe(false);
    }
    expect(workflowFieldsSchema.safeParse({ ...fields, family: "flux" }).success).toBe(false);
  });

  it("stores ids, revisions and times, and lists without the graph", () => {
    expect(storedWorkflowSchema.parse(stored)).toEqual(stored);
    expect(storedWorkflowSchema.safeParse({ ...stored, id: "user-x" }).success).toBe(false);
    const summary = { id: UUID, name: "Flux", family: "moss", nodes: 1, revision: 0, updatedAt: 2 };
    expect(workflowSummarySchema.parse(summary)).toEqual(summary);
    expect(workflowSummarySchema.safeParse({ ...summary, graph }).success).toBe(false);
    expect(workflowsResponseSchema.parse({ workflows: [summary] })).toEqual({
      workflows: [summary],
    });
  });
});

describe("route bodies", () => {
  it("takes the inspect source with an optional bounded file name", () => {
    expect(workflowInspectSchema.parse({ source: { any: 1 } })).toEqual({ source: { any: 1 } });
    expect(
      workflowInspectSchema.safeParse({ source: {}, fileName: "x.json", replacing: UUID }).success,
    ).toBe(true);
    for (const fileName of ["x".repeat(256), "a\u0000.json"]) {
      expect(workflowInspectSchema.safeParse({ source: {}, fileName }).success).toBe(false);
    }
  });

  it("creates with an id, fields and choices, patches metadata only, replaces the graph", () => {
    expect(workflowCreateSchema.safeParse({ ...fields, id: UUID, choices: {} }).success).toBe(true);
    expect(workflowCreateSchema.safeParse({ ...fields, id: UUID }).success).toBe(false);
    expect(workflowPatchSchema.parse({ revision: 1, name: "New" })).toEqual({
      revision: 1,
      name: "New",
    });
    expect(workflowPatchSchema.safeParse({ revision: 1, graph }).success).toBe(false);
    expect(
      workflowGraphReplaceSchema.safeParse({ revision: 1, graph, choices: { output: "9" } })
        .success,
    ).toBe(true);
  });

  it("answers saves with checked, deletes with settings, refusals with a code", () => {
    expect(workflowSavedResponseSchema.parse({ workflow: stored, checked: false })).toEqual({
      workflow: stored,
      checked: false,
    });
    expect(workflowResponseSchema.parse({ workflow: stored })).toEqual({ workflow: stored });
    expect(workflowDeleteResponseSchema.parse({ settings: DEFAULT_SETTINGS })).toEqual({
      settings: DEFAULT_SETTINGS,
    });
    expect(workflowRefusalSchema.parse({ error: "unknown_node", nodes: ["X"] })).toEqual({
      error: "unknown_node",
      nodes: ["X"],
    });
    expect(workflowRefusalSchema.safeParse({ error: "nope" }).success).toBe(false);
    expect(
      workflowSaveErrorSchema.safeParse({ error: "invalid_workflow", code: "no_size_slot" })
        .success,
    ).toBe(true);
    expect(
      workflowSaveErrorSchema.safeParse({ error: "blocked_nodes", nodes: ["X"] }).success,
    ).toBe(true);
  });

  it("describes an inspection with display metadata and the detection", () => {
    const inspection = {
      format: "api",
      checked: true,
      graph,
      nodes: [{ id: "9", title: "Save", classType: "SaveImageWebsocket" }],
      detection: {
        prompt: { chosen: null, candidates: [] },
        latent: { chosen: null, candidates: [] },
        seed: [],
        output: { chosen: "9", candidates: [candidate] },
        familyGuess: "general",
      },
      report: { changed: [], skipped: [] },
      blocked: [],
      live: { state: "ready" },
      nameSuggestion: "Portrait",
    };
    expect(inspectionSchema.parse(inspection)).toEqual(inspection);
    expect(inspectionSchema.safeParse({ ...inspection, format: "png" }).success).toBe(false);
  });
});
