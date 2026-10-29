import type { Page } from "@playwright/test";
import { uniqueName } from "./support/cards.ts";
import { canary } from "./support/env.ts";
import { matrixRow } from "./support/retention.ts";
import { expect } from "./support/test.ts";
import {
  actionsFor,
  apiFile,
  cleanUiFile,
  importPanel,
  mappingRows,
  openImport,
  pickFile,
  SDXL_OBJECT_INFO,
  workflowRow,
} from "./support/workflow-files.ts";

/*
 * Retention matrix, an imported workflow (docs/specs/workflow-import.md
 * § 13): the one place content could enter a workflow is the prompt place's
 * literal text, which is replaced by `{{prompt}}` before anything is stored.
 * The row imports a saved workflow whose prompt holds a canary, then
 * replaces its file with an API export holding another. Each canary is
 * proven in the tab (the panel shows the file's prompt), and the panel is
 * closed by its save, so the tab holds neither afterwards.
 */

/** The panel shows the file's prompt text in the Prompt row. */
async function expectPromptShown(page: Page, panelName: string, text: string) {
  const panel = importPanel(page, panelName);
  await expect(panel.getByRole("status")).toHaveText("Every node and model file is there.");
  await expect(mappingRows(panel).nth(0)).toContainText(text);
  return panel;
}

matrixRow(
  "wf",
  async ({ comfy, page }) => {
    await comfy({ objectInfo: SDXL_OBJECT_INFO });
    await page.goto("/settings");
    const name = uniqueName("Lighthouse");

    const imported = canary("wf");
    await openImport(page, cleanUiFile(`a lighthouse at dusk, ${imported}`));
    const panel = await expectPromptShown(page, "Import a workflow", imported);
    await panel.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await panel.getByRole("button", { name: "Save workflow", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(workflowRow(page, name)).toContainText("Ready");

    const replaced = canary("wf");
    await actionsFor(page, name).click();
    await pickFile(
      page,
      () => page.getByRole("menuitem", { name: "Replace file" }).click(),
      apiFile(`a harbour at night, ${replaced}`),
    );
    const replacing = await expectPromptShown(page, `Replace the file of ${name}`, replaced);
    await replacing.getByRole("button", { name: "Replace file", exact: true }).click();
    await expect(replacing).toHaveCount(0);
    await expect(workflowRow(page, name)).toContainText("Ready");
    await expect(page.locator("body")).not.toContainText(imported);
    await expect(page.locator("body")).not.toContainText(replaced);
  },
  {
    start: "/settings",
    expectEmpty: async (page) => {
      await expect(
        page.getByRole("button", { name: "Import a workflow", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: /^(Import a workflow|Replace the file of)/ }),
      ).toHaveCount(0);
    },
  },
);
