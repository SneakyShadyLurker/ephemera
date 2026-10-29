import type { Inspection, WorkflowSummary } from "@ephemera/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  API_NOT_REACHED,
  BLOCKED_COPY,
  DELETED_ELSEWHERE,
  INSPECT_BUSY,
  MISSING_HELP,
  SAVE_FULL,
  SERVER_NAME_NOTE,
} from "./copy.ts";
import { PanelView } from "./ImportPanel.tsx";
import {
  INITIAL_PANEL,
  type ListNames,
  type PanelAction,
  type PanelState,
  panelReducer,
  type SaveTarget,
} from "./panel-state.ts";
import { testInspection } from "./test-inspection.ts";

const NEW_ID = "0b6f7c3e-2d4a-4f8e-9a1b-5c6d7e8f9a0b";
const OTHER_ID = "1c7f8d4e-3e5b-4f9e-8a2b-6d7e8f9a0b1c";
const FILE = "flux-portrait.json";
const MOSS: WorkflowSummary = {
  id: OTHER_ID,
  name: "Moss Studio",
  family: "moss",
  nodes: 12,
  revision: 3,
  updatedAt: 0,
};
const NAMES: ListNames = { yours: [MOSS], server: ["Krea 2 Gonzalomo"] };
const NOT_REACHED = "Ephemera could not be reached";

const reading: PanelAction[] = [
  { type: "read", request: 1, controller: new AbortController(), fileName: FILE },
  { type: "parsed", request: 1, file: { fileName: FILE, source: {} } },
];

const run = (...actions: PanelAction[]): PanelState => actions.reduce(panelReducer, INITIAL_PANEL);

/** A file inspected, then `actions`. */
const inspected = (
  inspection: Partial<Inspection> & { output?: string } = { output: "7" },
  target: SaveTarget = { mode: "create", id: NEW_ID },
  ...actions: PanelAction[]
) =>
  run(
    ...reading,
    { type: "inspected", request: 1, inspection: testInspection(inspection), target },
    ...actions,
  );

const render = (state: PanelState, replacing: string | null = null) =>
  renderToStaticMarkup(
    <PanelView
      state={state}
      names={NAMES}
      address="http://comfyui.local:8188"
      notReached={NOT_REACHED}
      replacing={replacing}
      dispatch={() => {}}
      onSave={() => {}}
      onRetry={() => {}}
      onReload={async () => {}}
      onImportAsNew={() => {}}
      onCancel={() => {}}
      onChooseFile={() => {}}
      onEditAddress={() => {}}
    />,
  );

/** The footer's Save button, by its label, and whether it is disabled. */
const save = (html: string, label = "Save workflow") => {
  const button = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)]
    .map(([markup]) => markup)
    .find((markup) => markup.includes(label));
  return { shown: button !== undefined, disabled: /^<button[^>]* disabled=""/.test(button ?? "") };
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

describe("the import panel", () => {
  it("lists the mapping with the file's values, the other nodes and the report", () => {
    const html = render(inspected());
    expect(html).toContain('aria-label="Where Ephemera&#x27;s values go"');
    expect(text(html)).toContain("Ephemera fills these four places");
    expect(text(html)).toContain("flux-portrait.json, saved workflow, 8 nodes");
    expect(html).toContain('<span class="font-mono text-[0.92em]">node 2</span>');
    expect(text(html)).toContain("CLIP Text Encode (node 2), text");
    expect(text(html)).toContain("Empty Latent Image (node 4), width, height, batch_size");
    expect(text(html)).toContain("In this file: 1024 x 1536, batch 4");
    expect(text(html)).toContain("Set to 1024 x 1536 and the batch Ephemera asks for.");
    expect(text(html)).toContain("3 other nodes keep their settings");
    expect(text(html)).toContain("Preview Image (node 8), not the chosen output.");
    expect(text(html)).toContain("Every node and model file is there.");
    expect(html).toContain('role="status"');
    expect(save(html)).toEqual({ shown: true, disabled: false });
    // No connectors, arrows or drawn order in the rendered tree.
    expect(text(html)).not.toMatch(/→|->|—/);
  });

  it("reads the file busy, with the places as outlines and Save disabled", () => {
    const html = render(run(...reading));
    expect(html).toContain('aria-busy="true"');
    expect(text(html)).toContain(`Reading ${FILE}`);
    for (const place of ["Prompt", "Size and count", "Seed", "Image output"]) {
      expect(text(html)).toContain(place);
    }
    expect(text(html)).not.toContain("In this file");
    expect(save(html).disabled).toBe(true);
  });

  it("refuses a file that is not JSON in the tab, with Choose another file", () => {
    const html = render(
      run({ type: "refused", request: null, fileName: FILE, refusal: { kind: "not_json" } }),
    );
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(`Cannot import ${FILE}`);
    expect(text(html)).toContain(`${FILE} is not a JSON file.`);
    expect(save(html, "Choose another file").shown).toBe(true);
    expect(save(html).shown).toBe(false);
  });

  it("shows a refusal under Cannot import", () => {
    const html = render(
      run(...reading, {
        type: "inspectFailed",
        request: 1,
        failure: { ok: false, reason: "invalid_workflow", code: "linked_prompt", nodes: ["4"] },
      }),
    );
    expect(text(html)).toContain(`Cannot import ${FILE}`);
    expect(text(html)).toContain("Give the prompt its own text in ComfyUI and import again.");
  });

  it("asks to try again while another import is read", () => {
    const html = render(
      run(...reading, {
        type: "inspectFailed",
        request: 1,
        failure: { ok: false, reason: "busy" },
      }),
    );
    expect(text(html)).toContain(INSPECT_BUSY);
    expect(save(html, "Try again").shown).toBe(true);
  });

  it("needs the ComfyUI a saved workflow is read with, and offers its address", () => {
    const html = render(
      run(...reading, {
        type: "inspectFailed",
        request: 1,
        failure: { ok: false, reason: "comfyui_required" },
      }),
    );
    expect(text(html)).toContain(
      "Not reached at http://comfyui.local:8188. Reading a saved workflow needs it.",
    );
    for (const action of ["Try again", "Edit the address", "Choose another file"]) {
      expect(save(html, action).shown).toBe(true);
    }
    expect(save(html).disabled).toBe(true);
  });

  it("saves an API file without a check", () => {
    const html = render(
      inspected({
        output: "7",
        format: "api",
        checked: false,
        live: { state: "unavailable", reason: "unreachable" },
      }),
    );
    expect(text(html)).toContain(API_NOT_REACHED);
    expect(save(html).disabled).toBe(false);
  });

  it("names blocked nodes in plain words first, by reason, and disables Save", () => {
    const allowed = render(
      inspected({ output: "7", blocked: [{ classType: "KSampler", reason: "not_allowed" }] }),
    );
    expect(text(allowed)).toContain("Ephemera cannot run these nodes");
    expect(text(allowed)).toContain(`${BLOCKED_COPY.not_allowed}KSampler (node 5)`);
    expect(save(allowed).disabled).toBe(true);
    const refused = render(
      inspected({ output: "7", blocked: [{ classType: "VAEDecode", reason: "refused_writes" }] }),
    );
    expect(text(refused)).toContain(`${BLOCKED_COPY.refused_writes}VAE Decode (node 6)`);
    expect(save(refused).disabled).toBe(true);
  });

  it("lists missing requirements and still saves", () => {
    const html = render(
      inspected({
        output: "7",
        live: { state: "missing", nodes: ["MyNode"], models: ["moss_v2.safetensors"] },
      }),
    );
    expect(text(html)).toContain("NodesMyNode");
    expect(text(html)).toContain("Model filesmoss_v2.safetensors");
    expect(text(html)).toContain(MISSING_HELP);
    expect(save(html).disabled).toBe(false);
  });

  it("asks for an unsettled place on a dashed rail, with a named Select and the summary", () => {
    const html = render(inspected({}));
    expect(html).toContain("border-dashed");
    expect(text(html)).toContain("Choose the output node");
    expect(html).toContain('aria-label="Output node"');
    expect(text(html)).toContain("Choose one mapping before saving.");
    expect(save(html).disabled).toBe(true);
  });

  it("refuses an empty or taken name under the field, and notes a server's", () => {
    const named = (name: string) =>
      render(inspected({ output: "7" }, undefined, { type: "name", name }));
    expect(text(named(""))).toContain("Give the workflow a name.");
    expect(save(named("")).disabled).toBe(true);
    expect(text(named("Moss Studio"))).toContain("You already have a workflow called Moss Studio.");
    expect(save(named("Moss Studio")).disabled).toBe(true);
    const server = named("Krea 2 Gonzalomo");
    expect(text(server)).toContain(SERVER_NAME_NOTE);
    expect(save(server).disabled).toBe(false);
  });

  it("says why a save failed and keeps the draft", () => {
    const failed = (failure: PanelAction & { type: "saveFailed" }, target?: SaveTarget) =>
      render(
        inspected({ output: "7" }, target, { type: "save" }, failure),
        target === undefined ? null : MOSS.name,
      );
    expect(text(failed({ type: "saveFailed", failure: { ok: false, reason: "full" } }))).toContain(
      SAVE_FULL,
    );
    const unreachable = failed({
      type: "saveFailed",
      failure: { ok: false, reason: "unreachable" },
    });
    expect(text(unreachable)).toContain(`Not saved: ${NOT_REACHED}.`);
    expect(save(unreachable, "Try again").shown).toBe(true);
    const replace: SaveTarget = { mode: "replace", workflow: MOSS };
    const conflict = failed(
      { type: "saveFailed", failure: { ok: false, reason: "conflict", revision: 5 } },
      replace,
    );
    expect(text(conflict)).toContain("Changed in another tab");
    expect(save(conflict, "Reload").shown).toBe(true);
    expect(save(conflict, "Keep mine").shown).toBe(true);
    const gone = failed(
      { type: "saveFailed", failure: { ok: false, reason: "not_found" } },
      replace,
    );
    expect(text(gone)).toContain(DELETED_ELSEWHERE);
    expect(save(gone, "Import as new").shown).toBe(true);
  });

  it("saves with the fields disabled", () => {
    const html = render(inspected({ output: "7" }, undefined, { type: "save" }));
    expect(save(html, "Saving")).toEqual({ shown: true, disabled: true });
    expect(html).toMatch(/<input[^>]* disabled=""/);
  });

  it("replaces a workflow's file under its name and family", () => {
    const html = render(inspected({ output: "7" }, { mode: "replace", workflow: MOSS }), MOSS.name);
    expect(text(html)).toContain("Replace the file of Moss Studio");
    expect(html).toContain('value="Moss Studio"');
    expect(text(html)).toContain("MOSS prompts are written for MOSS Image models.");
    expect(save(html, "Replace file")).toEqual({ shown: true, disabled: false });
  });
});
