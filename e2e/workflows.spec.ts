import type { Page } from "@playwright/test";
import { uniqueName } from "./support/cards.ts";
import { ART_TIMEOUT, COPY, expectBatch, recordArt } from "./support/creator.ts";
import { keptBase, ownerDescription } from "./support/creator-fixtures.ts";
import { choose, readSettings } from "./support/entities.ts";
import { sceneButton, sceneChat, scenePicture } from "./support/scene.ts";
import { settingsTab } from "./support/settings.ts";
import { expect, test } from "./support/test.ts";
import {
  actionsFor,
  apiFile,
  cleanUiFile,
  importButton,
  importPanel,
  importWorkflow,
  mappingRows,
  openImport,
  pickFile,
  SDXL_CHECKPOINT,
  SDXL_OBJECT_INFO,
  SDXL_PROMPT,
  SECOND_SAVER,
  twoSaverUiFile,
  workflowRow,
  yours,
} from "./support/workflow-files.ts";

/*
 * A ComfyUI workflow of the owner's own, imported in Settings > Pictures:
 * what the panel shows of a file, its
 * focus and its guard, then the saved workflow in Describe's picker, in a
 * New art batch and a scene picture, renamed, replaced and deleted. The
 * mock ComfyUI serves the fixture's `/object_info`, so the file's nodes and
 * model files are all there.
 */

/** The default workflow Create with AI goes back to. */
const DEFAULT_WORKFLOW = "Krea 2 Gonzalomo";

const READY = "Every node and model file is there.";

async function openSettings(page: Page) {
  await page.goto("/settings?section=pictures");
  await expect(importButton(page)).toBeEnabled();
}

/** Create with AI open on a subject, at Describe. */
async function openDescribe(page: Page) {
  await page.goto("/characters");
  await page.getByRole("button", { name: "Create with AI" }).first().click();
  await page.locator('[data-kind="subject"]').click();
  await expect(page.getByRole("textbox", { name: COPY.subject.field })).toBeVisible();
}

const workflowPicker = (page: Page) =>
  page.getByRole("combobox", { name: "Workflow", exact: true });

test("a saved workflow file shows where Ephemera's values go, then saves as ready", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  // Opening moves focus to the heading.
  await expect(
    panel.getByRole("heading", { name: "Import a workflow", exact: true }),
  ).toBeFocused();
  await expect(panel.getByRole("status")).toHaveText(READY);
  const rows = mappingRows(panel);
  await expect(rows).toHaveCount(4);
  for (const [index, place] of ["Prompt", "Size and count", "Seed", "Image output"].entries()) {
    await expect(rows.nth(index)).toContainText(place);
  }
  await expect(rows.nth(0)).toContainText('In this file: "a lighthouse at dusk"');
  await expect(panel.getByRole("combobox", { name: "Output node", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Changed", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Left out", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "On your ComfyUI", exact: true })).toBeVisible();

  const name = uniqueName("Lighthouse");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const row = workflowRow(page, name);
  await expect(row.getByText(name, { exact: true })).toBeFocused();
  await expect(yours(page).getByRole("listitem")).toHaveCount(1);
  await expect(row).toContainText("Ready");
});

test("a workflow with two image outputs asks for one before it saves", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, twoSaverUiFile());
  const output = panel.getByRole("combobox", { name: "Output node", exact: true });
  await expect(output).toBeVisible();
  await expect(mappingRows(panel)).toHaveCount(4);
  await expect(panel.getByText("Choose the output node", { exact: true })).toBeVisible();
  const save = panel.getByRole("button", { name: "Save workflow", exact: true });
  await expect(save).toBeDisabled();
  await expect(panel.getByText("Choose one mapping before saving.", { exact: true })).toBeVisible();
  const notChosen = panel.getByText("SaveImage (node 7), not the chosen output.", { exact: true });
  await expect(notChosen).toHaveCount(0);

  await choose(panel, "Output node", SECOND_SAVER);
  await expect(notChosen).toBeVisible();
  await expect(panel.getByText("Choose one mapping before saving.")).toHaveCount(0);
  await expect(save).toBeEnabled();
});

test("an imported workflow is listed first in the picker and paints New art and a scene", async ({
  comfy,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const scope = await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);

  await openDescribe(page);
  await workflowPicker(page).click();
  const groups = page.getByRole("listbox").getByRole("group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAccessibleName("Yours");
  await expect(groups.nth(1)).toHaveAccessibleName("On this server");
  await expect(groups.nth(0).getByRole("option", { name, exact: true })).toBeVisible();
  await expect(
    groups.nth(1).getByRole("option", { name: DEFAULT_WORKFLOW, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await choose(page, "Workflow", name);

  const base = keptBase();
  const art = await recordArt(page);
  await page.getByRole("textbox", { name: COPY.subject.field }).fill(ownerDescription(base));
  await choose(page, "Model", "mock-fast");
  await page.getByRole("button", { name: COPY.subject.create }).click();
  await art.expectPortraits(base);
  await expectBatch(page);
  const newArt = page.getByRole("button", { name: "New art" });
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  await newArt.click();
  await art.expectPortraits(base, 2);
  await expect(newArt).toBeEnabled({ timeout: ART_TIMEOUT });
  // Both batches were painted with the imported graph, not the server's.
  expect(await scope.state(SDXL_CHECKPOINT)).toMatchObject({ prompts: 2, containing: 2 });
  await scope.expectClean();

  const character = await sceneChat(page, request, "By the lighthouse lamp");
  await sceneButton(page).click();
  await expect(scenePicture(page, character)).toBeVisible({ timeout: ART_TIMEOUT });
  expect(await scope.state(SDXL_CHECKPOINT)).toMatchObject({ prompts: 3, containing: 3 });
  await scope.expectClean();
});

test("a rename refuses an empty name, and Escape leaves the name as it was", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);

  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  await expect(field).toBeFocused();
  await field.fill("  ");
  await field.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Give the workflow a name.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(actionsFor(page, name)).toBeFocused();
  await expect(workflowRow(page, name)).toBeVisible();
  await expect(page.getByText("Give the workflow a name.")).toHaveCount(0);

  const renamed = uniqueName("Harbour light");
  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await field.fill(renamed);
  await field.press("Enter");
  await expect(workflowRow(page, renamed)).toContainText("Ready");
  await expect(actionsFor(page, renamed)).toBeFocused();
  await page.reload();
  await expect(workflowRow(page, renamed)).toBeVisible();
  await expect(workflowRow(page, name)).toHaveCount(0);
});

test("Replace file takes the API export in place of the saved file", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);

  await actionsFor(page, name).click();
  await pickFile(
    page,
    () => page.getByRole("menuitem", { name: "Replace file" }).click(),
    apiFile(),
  );
  const panel = importPanel(page, `Replace the file of ${name}`);
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^sdxl-basic\.api\.json, API format, \d+ nodes$/)).toBeVisible();
  await expect(panel.getByRole("status")).toHaveText(READY);
  await expect(panel.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  await panel.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(workflowRow(page, name).getByText(name, { exact: true })).toBeFocused();
  await expect(workflowRow(page, name)).toContainText("Ready");
  await expect(yours(page).getByRole("listitem")).toHaveCount(1);
});

test("deleting the workflow in use goes back to the default", async ({ comfy, page, request }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  const { comfyuiWorkflow: before } = await readSettings(request);

  await openDescribe(page);
  await choose(page, "Workflow", name);
  await expect.poll(async () => (await readSettings(request)).comfyuiWorkflow).not.toBe(before);
  await openSettings(page);
  const row = workflowRow(page, name);
  await expect(row).toContainText("In use");

  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}?` });
  await expect(dialog).toContainText(
    "Create with AI paints with it now and goes back to the default workflow.",
  );
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(`${name} was deleted; back to ${DEFAULT_WORKFLOW}.`)).toBeVisible();
  await expect(importButton(page)).toBeFocused();

  await openDescribe(page);
  await expect(workflowPicker(page)).toHaveText(DEFAULT_WORKFLOW);
});

test("the import panel takes focus on open and Cancel gives it back", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  // A file that is not JSON is refused in the tab, and closes without a discard prompt.
  const panel = await openImport(page, {
    name: "portrait.json",
    mimeType: "application/json",
    buffer: Buffer.from("not a workflow {"),
  });
  await expect(
    panel.getByRole("heading", { name: "Import a workflow", exact: true }),
  ).toBeFocused();
  await expect(panel.getByRole("alert")).toContainText("Cannot import portrait.json");
  await expect(panel.getByRole("alert")).toContainText("portrait.json is not a JSON file.");
  await expect(panel.getByRole("button", { name: "Choose another file" })).toBeVisible();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await expect(importButton(page)).toBeFocused();
});

test("a file read and not saved asks before it is left", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);

  const guard = page.getByRole("alertdialog", { name: "Discard this import?" });
  const presets = page.getByRole("link", { name: "Presets" });
  await presets.click();
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Keep importing", exact: true }).click();
  await expect(guard).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\?section=pictures$/);
  await expect(mappingRows(panel)).toHaveCount(4);

  // Escape in the panel asks the same.
  await panel.getByRole("textbox", { name: "Name", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Keep importing", exact: true }).click();
  await expect(panel).toBeVisible();

  await presets.click();
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Presets" })).toBeVisible();
});

test("an import in progress survives a look at another Settings category", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  const name = uniqueName("Harbour light");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);

  await settingsTab(page, "Chat").click();
  await expect(page).toHaveURL(/\/settings\?section=chat$/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(panel).toHaveCount(0);

  await settingsTab(page, "Pictures").click();
  await expect(panel).toBeVisible();
  await expect(mappingRows(panel)).toHaveCount(4);
  await expect(panel.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
});

test("an IME composition keeps Enter and Escape from the rename and the panel", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  const composing = (key: string) => ({ key, isComposing: true });

  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  await expect(field).toHaveAttribute("maxlength", "64");
  await field.fill(`${name} harbour`);
  await field.dispatchEvent("keydown", composing("Enter"));
  await field.dispatchEvent("keydown", composing("Escape"));
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(`${name} harbour`);
  await field.press("Escape");
  await expect(field).toHaveCount(0);

  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  const panelName = panel.getByRole("textbox", { name: "Name", exact: true });
  await panelName.focus();
  await panelName.dispatchEvent("keydown", composing("Escape"));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog", { name: "Discard this import?" })).toBeVisible();
});

test("a save the list cannot show yet gives focus to Import", async ({ comfy, page }) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  await page.route("**/api/workflows", (route) =>
    route.request().method() === "GET" ? route.abort() : route.fallback(),
  );
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(uniqueName("Lighthouse"));
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  // The refresh is retried before the list gives up.
  await expect(panel).toHaveCount(0, { timeout: 15_000 });
  await expect(importButton(page)).toBeFocused();
});

test("a save in flight holds Cancel, Escape and a new file until it settles", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workflows", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    return route.fallback();
  });
  const name = uniqueName("Lighthouse");
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Saving" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await panel.getByRole("heading", { name: "Import a workflow", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await pickFile(page, () => importButton(page).click(), cleanUiFile(SDXL_PROMPT, "second.json"));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  release();
  await expect(workflowRow(page, name)).toBeVisible();
  // The file held back opens once the save is in.
  await expect(panel.getByText(/^second\.json, saved workflow, \d+ nodes$/)).toBeVisible();
});

test("a create whose answer was lost is retried as a replace of the saved one", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const panel = await openImport(page, cleanUiFile());
  await expect(panel.getByRole("status")).toHaveText(READY);
  const sent: string[] = [];
  let lose = true;
  let failList = false;
  await page.route("**/api/workflows/**", (route) => {
    sent.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fallback();
  });
  await page.route("**/api/workflows", async (route) => {
    const method = route.request().method();
    sent.push(`${method} /api/workflows`);
    if (method === "GET" && failList) {
      failList = false;
      return route.abort();
    }
    if (method !== "POST" || !lose) return route.fallback();
    lose = false;
    // The server saves it; the answer never reaches the tab.
    await route.fetch();
    return route.abort();
  });
  const name = uniqueName("Lighthouse");
  const field = panel.getByRole("textbox", { name: "Name", exact: true });
  await field.fill(name);
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();

  // Renamed since; the list does not answer the lookup, so nothing is sent again.
  const renamed = uniqueName("Harbour light");
  await field.fill(renamed);
  failList = true;
  await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  expect(sent.filter((line) => line === "POST /api/workflows")).toHaveLength(1);

  await panel.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(workflowRow(page, renamed)).toContainText("Ready");
  expect(sent.filter((line) => line === "POST /api/workflows")).toHaveLength(1);
  expect(sent.filter((line) => line.startsWith("PUT ") && line.endsWith("/graph"))).toHaveLength(1);
});

test("Replace file answers a change made since it opened with a conflict", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  // Another graph than the saved one, so the replace is a write of its own.
  const file = apiFile();
  const graph: Record<string, { inputs: Record<string, unknown> }> = JSON.parse(
    file.buffer.toString("utf8"),
  );
  Object.assign(graph["5"]?.inputs ?? {}, { steps: 30 });

  await actionsFor(page, name).click();
  await pickFile(page, () => page.getByRole("menuitem", { name: "Replace file" }).click(), {
    ...file,
    buffer: Buffer.from(JSON.stringify(graph)),
  });
  const panel = importPanel(page, `Replace the file of ${name}`);
  await expect(panel.getByRole("status")).toHaveText(READY);

  // Renamed in the row while the replacement is open.
  const renamed = uniqueName("Harbour light");
  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  await field.fill(renamed);
  await field.press("Enter");
  await expect(workflowRow(page, renamed)).toBeVisible();

  await panel.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(panel.getByText("Changed in another tab")).toBeVisible();
});

test("a Reload that answers after another file was taken leaves that file open", async ({
  comfy,
  page,
}) => {
  await comfy({ objectInfo: SDXL_OBJECT_INFO });
  await openSettings(page);
  const name = uniqueName("Lighthouse");
  await importWorkflow(page, name);
  const file = apiFile();
  const graph: Record<string, { inputs: Record<string, unknown> }> = JSON.parse(
    file.buffer.toString("utf8"),
  );
  Object.assign(graph["5"]?.inputs ?? {}, { steps: 30 });
  await actionsFor(page, name).click();
  await pickFile(page, () => page.getByRole("menuitem", { name: "Replace file" }).click(), {
    ...file,
    buffer: Buffer.from(JSON.stringify(graph)),
  });
  const panel = importPanel(page, `Replace the file of ${name}`);
  await expect(panel.getByRole("status")).toHaveText(READY);
  await actionsFor(page, name).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: `Name of ${name}`, exact: true });
  const renamed = uniqueName("Harbour light");
  await field.fill(renamed);
  await field.press("Enter");
  await expect(workflowRow(page, renamed)).toBeVisible();
  await panel.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(panel.getByText("Changed in another tab")).toBeVisible();

  // Reload's list answers only once another file has taken this one's place.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workflows", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    return route.fallback();
  });
  await panel.getByRole("button", { name: "Reload", exact: true }).click();
  await pickFile(page, () => importButton(page).click(), cleanUiFile(SDXL_PROMPT, "second.json"));
  await page
    .getByRole("alertdialog", { name: "Replace this import with the new file?" })
    .getByRole("button", { name: "Replace", exact: true })
    .click();
  const next = importPanel(page);
  await expect(next.getByText(/^second\.json, saved workflow, \d+ nodes$/)).toBeVisible();

  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workflows" &&
      response.request().method() === "GET",
  );
  release();
  await answered;
  // Long enough for a late Reload to close the panel, had it not been dropped.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  await expect(next).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
