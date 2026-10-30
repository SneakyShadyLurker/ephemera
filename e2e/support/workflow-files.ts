import { expect, type Locator, type Page } from "@playwright/test";
import sdxlApi from "../../packages/core/test-fixtures/workflows/sdxl-basic.api.json" with {
  type: "json",
};
import sdxlObjectInfo from "../../packages/core/test-fixtures/workflows/sdxl-basic.object_info.json" with {
  type: "json",
};
import sdxlUi from "../../packages/core/test-fixtures/workflows/sdxl-basic.ui.json" with {
  type: "json",
};

/*
 * Importing a ComfyUI workflow in Settings > Pictures as the owner drives
 * it (e2e/workflows.spec.ts, e2e/workflows-retention.spec.ts). The files
 * are the stock ComfyUI exports in packages/core/test-fixtures/workflows,
 * read here rather than copied: e2e/support/workflows/ is the server's
 * workflows directory, where every JSON file is a server workflow. A scope
 * serving `SDXL_OBJECT_INFO` has every node and model file they need.
 */

/** The `/object_info` of the ComfyUI the fixtures were exported from (ScopeOptions.objectInfo). */
export const SDXL_OBJECT_INFO: Record<string, unknown> = sdxlObjectInfo;

/** The fixtures' checkpoint: a queued graph holding it is the imported workflow. */
export const SDXL_CHECKPOINT = "sdxl-base.safetensors";

/** The stock export's positive prompt, in both formats. */
export const SDXL_PROMPT = "a lighthouse at dusk";

export interface WorkflowUpload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const upload = (name: string, source: unknown): WorkflowUpload => ({
  name,
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(source, null, 2)),
});

/** The parts of a saved (UI format) workflow the derived files change. */
interface UiNode {
  id: number;
  type: string;
  title?: string;
  order?: number;
  inputs?: { name: string; link: number | null }[];
  outputs?: { links?: number[] | null }[];
  widgets_values?: unknown[];
  widgets_values_named?: Record<string, unknown> | null;
}
interface UiWorkflow {
  nodes: UiNode[];
  links: unknown[][];
  last_node_id: number;
  last_link_id: number;
}

/** The saved (UI format) workflow, its positive prompt holding `prompt`. */
function uiWorkflow(prompt: string): UiWorkflow {
  const workflow: UiWorkflow = structuredClone(sdxlUi);
  const positive = workflow.nodes.find((node) => node.title === "Positive");
  if (positive === undefined) throw new Error("the fixture has no positive prompt");
  positive.widgets_values = [prompt];
  positive.widgets_values_named = { text: prompt };
  return workflow;
}

/** The clean case: one saver, every place found. */
export const cleanUiFile = (prompt = SDXL_PROMPT, name = "sdxl-basic.json") =>
  upload(name, uiWorkflow(prompt));

/** The title of the second saver in `twoSaverUiFile`. */
export const SECOND_SAVER = "Save for print";

/**
 * The clean workflow with a second SaveImage (node 9) on the decoded image,
 * so the image output is the owner's choice.
 */
export function twoSaverUiFile(name = "sdxl-two-savers.json"): WorkflowUpload {
  const workflow = uiWorkflow(SDXL_PROMPT);
  const saver = workflow.nodes.find((node) => node.type === "SaveImage");
  const decode = workflow.nodes.find((node) => node.type === "VAEDecode");
  const [image] = decode?.outputs ?? [];
  if (saver === undefined || decode === undefined || image === undefined)
    throw new Error("the fixture has no saver");
  const link = workflow.last_link_id + 1;
  const second: UiNode = {
    ...structuredClone(saver),
    id: workflow.last_node_id + 1,
    title: SECOND_SAVER,
    order: workflow.nodes.length,
    inputs: (saver.inputs ?? []).map((input) => ({ ...input, link })),
    widgets_values: ["print"],
    widgets_values_named: { filename_prefix: "print" },
  };
  workflow.nodes.push(second);
  image.links = [...(image.links ?? []), link];
  workflow.links.push([link, decode.id, 0, second.id, 0, "IMAGE"]);
  workflow.last_node_id = second.id;
  workflow.last_link_id = link;
  return upload(name, workflow);
}

/** The API export, its positive prompt holding `prompt`. */
export function apiFile(prompt = SDXL_PROMPT, name = "sdxl-basic.api.json"): WorkflowUpload {
  const graph = structuredClone(sdxlApi);
  graph["2"].inputs.text = prompt;
  return upload(name, graph);
}

/** The import panel, named by its heading: "Import a workflow" or "Replace the file of <name>". */
export const importPanel = (page: Page, name: string | RegExp = "Import a workflow") =>
  page.getByRole("region", { name, exact: true });

export const importButton = (page: Page) =>
  page.getByRole("button", { name: "Import a workflow", exact: true });

/** The panel's four places. */
export const mappingRows = (panel: Locator) =>
  panel
    .getByRole("list", { name: "Where Ephemera's values go", exact: true })
    .getByRole("listitem");

/** The user's own workflows, under "Yours". */
export const yours = (page: Page) => page.getByRole("list", { name: "Yours", exact: true });

/** The row of the user's workflow `name`. */
export const workflowRow = (page: Page, name: string) =>
  yours(page)
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });

export const actionsFor = (page: Page, name: string) =>
  page.getByRole("button", { name: `Actions for ${name}`, exact: true });

/** Answers the file picker `open` summons with `file`. */
export async function pickFile(page: Page, open: () => Promise<void>, file: WorkflowUpload) {
  const chooser = page.waitForEvent("filechooser");
  await open();
  await (await chooser).setFiles(file);
}

/** Import a workflow, then `file` from the picker: the panel opens with it. */
export async function openImport(page: Page, file: WorkflowUpload): Promise<Locator> {
  await pickFile(page, () => importButton(page).click(), file);
  const panel = importPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * The clean UI file imported and saved as `name` from Settings, already
 * open: the panel closes and the row is listed under Yours, ready.
 */
export async function importWorkflow(page: Page, name: string, file = cleanUiFile()) {
  const panel = await openImport(page, file);
  await expect(panel.getByRole("status")).toHaveText("Every node and model file is there.");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(workflowRow(page, name)).toContainText("Ready");
}
