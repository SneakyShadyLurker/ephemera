import type { WorkflowSummary } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import {
  blockedGroups,
  choiceProblem,
  INITIAL_PANEL,
  isDirty,
  nameCheck,
  type PanelAction,
  type PanelState,
  panelReducer,
  reportOf,
  type SaveTarget,
  saveCheck,
} from "./panel-state.ts";
import { testInspection } from "./test-inspection.ts";

const NEW_ID = "0b6f7c3e-2d4a-4f8e-9a1b-5c6d7e8f9a0b";
const OTHER_ID = "1c7f8d4e-3e5b-4f9e-8a2b-6d7e8f9a0b1c";
const CREATE: SaveTarget = { mode: "create", id: NEW_ID };
const FILE = { fileName: "flux-portrait.json", source: { "1": {} } };

const summary = (id: string, name: string): WorkflowSummary => ({
  id,
  name,
  family: "moss",
  nodes: 12,
  revision: 3,
  updatedAt: 0,
});
const NAMES = { yours: [summary(OTHER_ID, "Moss Studio")], server: ["Krea 2 Gonzalomo"] };

const run = (...actions: PanelAction[]): PanelState => actions.reduce(panelReducer, INITIAL_PANEL);

const reading = (request = 1): PanelAction[] => [
  { type: "read", request, controller: new AbortController(), fileName: FILE.fileName },
  { type: "parsed", request, file: FILE },
];

/** A file read and inspected; `output` stands in for a detected output. */
const inspected = (options: { output?: string; target?: SaveTarget } = {}) =>
  run(...reading(), {
    type: "inspected",
    request: 1,
    inspection: testInspection(options.output === undefined ? {} : { output: options.output }),
    target: options.target ?? CREATE,
  });

const draftIn = (state: PanelState) => {
  if (!("draft" in state)) throw new Error(`no draft in ${state.phase}`);
  return state.draft;
};

describe("reading a file", () => {
  it("ignores a late inspection for an abandoned request", () => {
    const state = run(...reading(1), ...reading(2), {
      type: "inspected",
      request: 1,
      inspection: testInspection(),
      target: CREATE,
    });
    expect(state.phase).toBe("reading");
    expect(state.phase === "reading" && state.request).toBe(2);
    expect(
      run(
        ...reading(1),
        { type: "close" },
        { type: "inspectFailed", request: 1, failure: { ok: false, reason: "busy" } },
      ).phase,
    ).toBe("idle");
  });

  it("refuses a file the tab cannot read, for the current request only", () => {
    const refused = run(...reading(1), {
      type: "refused",
      request: 1,
      fileName: "a.json",
      refusal: { kind: "not_json" },
    });
    expect(refused).toMatchObject({
      phase: "refused",
      fileName: "a.json",
      refusal: { kind: "not_json" },
    });
    expect(
      run(...reading(2), {
        type: "refused",
        request: 1,
        fileName: "a.json",
        refusal: { kind: "not_json" },
      }).phase,
    ).toBe("reading");
    // Too large before any request.
    expect(
      run({ type: "refused", request: null, fileName: "big.json", refusal: { kind: "too_large" } }),
    ).toMatchObject({ phase: "refused", refusal: { kind: "too_large" } });
  });

  it("keeps a server refusal, a busy inspection and a ComfyUI the UI file needs apart", () => {
    expect(
      run(...reading(), {
        type: "inspectFailed",
        request: 1,
        failure: { ok: false, reason: "invalid_workflow", code: "linked_prompt", nodes: ["4"] },
      }),
    ).toMatchObject({
      phase: "refused",
      refusal: { kind: "invalid_workflow", code: "linked_prompt" },
    });
    expect(
      run(...reading(), {
        type: "inspectFailed",
        request: 1,
        failure: { ok: false, reason: "too_large" },
      }),
    ).toMatchObject({ phase: "refused", refusal: { kind: "too_large" } });
    const busy = run(...reading(), {
      type: "inspectFailed",
      request: 1,
      failure: { ok: false, reason: "busy" },
    });
    expect(busy).toMatchObject({ phase: "failed", stage: "inspect", failure: "busy", file: FILE });
    const again = panelReducer(busy, {
      type: "retry",
      request: 2,
      controller: new AbortController(),
    });
    expect(again).toMatchObject({ phase: "reading", request: 2, file: FILE });
    expect(
      run(...reading(), {
        type: "inspectFailed",
        request: 1,
        failure: { ok: false, reason: "comfyui_required" },
      }),
    ).toMatchObject({ phase: "failed", failure: "comfyui_required" });
  });

  it("refuses at inspection when finalization with no choice refuses for another reason than a place", () => {
    const state = run(...reading(), {
      type: "inspected",
      request: 1,
      inspection: testInspection({
        output: "7",
        graph: {
          ...testInspection().graph,
          "5": { class_type: "KSampler", inputs: { latent_image: ["4", 0], positive: ["2", 0] } },
        },
      }),
      target: CREATE,
    });
    expect(state).toMatchObject({
      phase: "refused",
      refusal: { kind: "invalid_workflow", code: "no_seed_slot" },
    });
  });

  it("is dirty only once a file is inspected and not saved", () => {
    expect(isDirty(run(...reading()))).toBe(false);
    expect(isDirty(inspected())).toBe(true);
    expect(
      isDirty(
        run(...reading(), {
          type: "inspectFailed",
          request: 1,
          failure: { ok: false, reason: "busy" },
        }),
      ),
    ).toBe(false);
    expect(isDirty(panelReducer(inspected(), { type: "saved" }))).toBe(false);
  });
});

describe("the draft", () => {
  it("prefills the suggested name and the family guess, or the replaced workflow's", () => {
    expect(draftIn(inspected())).toMatchObject({ name: "Flux Dev Portrait", family: "general" });
    const workflow = summary(OTHER_ID, "Moss Studio");
    expect(draftIn(inspected({ target: { mode: "replace", workflow } }))).toMatchObject({
      name: "Moss Studio",
      family: "moss",
      target: { mode: "replace", workflow },
    });
  });

  it("re-runs finalization on a choice, refreshing Left out", () => {
    const state = inspected();
    expect(saveCheck(state, NAMES)).toEqual({ enabled: false, unchosen: 1 });
    const save = panelReducer(state, { type: "choose", place: "output", node: "7" });
    expect(saveCheck(save, NAMES)).toEqual({ enabled: true, unchosen: 0 });
    expect(reportOf(draftIn(save)).skipped).toEqual([
      "Preview Image (node 8), not the chosen output.",
    ]);
    const preview = panelReducer(save, { type: "choose", place: "output", node: "8" });
    expect(reportOf(draftIn(preview)).skipped).toEqual([
      "Save Image (node 7), not the chosen output.",
    ]);
    expect(draftIn(preview).choices).toEqual({ output: "8" });
  });

  it("names a choice finalization refuses beside the list", () => {
    const state = panelReducer(inspected({ output: "7" }), {
      type: "choose",
      place: "latent",
      node: "9",
    });
    expect(choiceProblem(draftIn(state))).toBe(
      "That node cannot take this place: node 9. Choose another node.",
    );
    expect(saveCheck(state, NAMES).enabled).toBe(false);
  });

  it("checks the name against your list, case-insensitive, without the replaced workflow", () => {
    const named = (name: string, target?: SaveTarget) =>
      panelReducer(inspected({ output: "7", ...(target ? { target } : {}) }), {
        type: "name",
        name,
      });
    expect(nameCheck(draftIn(named("  ")), NAMES).problem).toBe("Give the workflow a name.");
    expect(nameCheck(draftIn(named("moss studio")), NAMES).problem).toBe(
      "You already have a workflow called moss studio.",
    );
    expect(saveCheck(named("moss studio"), NAMES).enabled).toBe(false);
    const replacing = { mode: "replace" as const, workflow: summary(OTHER_ID, "Moss Studio") };
    expect(nameCheck(draftIn(named("Moss Studio", replacing)), NAMES).problem).toBeNull();
    const server = nameCheck(draftIn(named("krea 2 gonzalomo")), NAMES);
    expect(server).toEqual({
      problem: null,
      note: "A server workflow has this name too; both are listed.",
    });
    expect(saveCheck(named("Krea 2 Gonzalomo"), NAMES).enabled).toBe(true);
  });

  it("disables Save while reading, on a refusal and with a blocked node", () => {
    expect(saveCheck(run(...reading()), NAMES).enabled).toBe(false);
    expect(
      saveCheck(
        run({ type: "refused", request: null, fileName: "a", refusal: { kind: "not_json" } }),
        NAMES,
      ).enabled,
    ).toBe(false);
    const blocked = run(...reading(), {
      type: "inspected",
      request: 1,
      inspection: testInspection({
        output: "7",
        blocked: [{ classType: "KSampler", reason: "not_allowed" }],
      }),
      target: CREATE,
    });
    expect(saveCheck(blocked, NAMES).enabled).toBe(false);
    expect(blockedGroups(draftIn(blocked))).toEqual([
      { reason: "not_allowed", nodes: [{ id: "5", title: "KSampler" }] },
    ]);
  });

  it("keeps choices, name and family through every recoverable failure", () => {
    let state = panelReducer(inspected(), { type: "choose", place: "output", node: "7" });
    state = panelReducer(state, { type: "name", name: "Harbour" });
    state = panelReducer(state, { type: "family", family: "krea2" });
    state = panelReducer(state, { type: "save" });
    expect(state.phase).toBe("saving");
    expect(saveCheck(state, NAMES).enabled).toBe(false);
    const kept = { choices: { output: "7" }, name: "Harbour", family: "krea2" };

    const unreachable = panelReducer(state, {
      type: "saveFailed",
      failure: { ok: false, reason: "unreachable" },
    });
    expect(unreachable).toMatchObject({
      phase: "failed",
      stage: "save",
      failure: { kind: "unreachable" },
      draft: kept,
    });
    expect(saveCheck(unreachable, NAMES).enabled).toBe(true);

    const full = panelReducer(state, {
      type: "saveFailed",
      failure: { ok: false, reason: "full" },
    });
    expect(full).toMatchObject({ phase: "failed", failure: { kind: "full" }, draft: kept });

    const taken = panelReducer(state, {
      type: "saveFailed",
      failure: { ok: false, reason: "name_taken" },
    });
    expect(taken).toMatchObject({ phase: "inspected", draft: kept });
    expect(nameCheck(draftIn(taken), NAMES).problem).toBe(
      "You already have a workflow called Harbour.",
    );
    expect(
      nameCheck(draftIn(panelReducer(taken, { type: "name", name: "Harbour 2" })), NAMES).problem,
    ).toBeNull();

    const blocked = panelReducer(state, {
      type: "saveFailed",
      failure: { ok: false, reason: "blocked_nodes", nodes: ["VAEDecode"] },
    });
    expect(blockedGroups(draftIn(blocked))).toEqual([
      { reason: "not_allowed", nodes: [{ id: "6", title: "VAE Decode" }] },
    ]);
    expect(saveCheck(blocked, NAMES).enabled).toBe(false);

    const conflict = panelReducer(state, {
      type: "saveFailed",
      failure: { ok: false, reason: "conflict", revision: 7 },
    });
    expect(conflict).toMatchObject({ failure: { kind: "conflict", revision: 7 }, draft: kept });
    // Reload and Keep mine are the way on, not Save.
    expect(saveCheck(conflict, NAMES).enabled).toBe(false);
  });

  it("turns a replacement deleted elsewhere into a new import, keeping the draft", () => {
    const workflow = summary(OTHER_ID, "Moss Studio");
    let state = inspected({ output: "7", target: { mode: "replace", workflow } });
    state = panelReducer(state, { type: "save" });
    state = panelReducer(state, {
      type: "saveFailed",
      failure: { ok: false, reason: "not_found" },
    });
    expect(state).toMatchObject({ phase: "failed", failure: { kind: "not_found" } });
    state = panelReducer(state, { type: "importAsNew", id: NEW_ID });
    expect(state).toMatchObject({
      phase: "inspected",
      draft: { target: { mode: "create", id: NEW_ID }, name: "Moss Studio", family: "moss" },
    });
  });

  it("remembers a replaced graph whose details still wait to be saved", () => {
    const workflow = summary(OTHER_ID, "Moss Studio");
    let state = inspected({ output: "7", target: { mode: "replace", workflow } });
    state = panelReducer(state, { type: "name", name: "Moss Harbour" });
    state = panelReducer(state, { type: "save" });
    state = panelReducer(state, { type: "graphSaved", revision: 4 });
    expect(state).toMatchObject({ phase: "saving", draft: { graphRevision: 4 } });
    state = panelReducer(state, {
      type: "saveFailed",
      failure: { ok: false, reason: "unreachable" },
    });
    expect(draftIn(state).graphRevision).toBe(4);
  });
});
