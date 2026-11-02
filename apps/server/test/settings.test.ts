import { settingsResponseSchema, userWorkflowId } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { ownerHeaders, requestJson, TEST_USER, testApp } from "./helpers.ts";
import { storeUserWorkflow, TEST_WORKFLOWS } from "./test-workflows.ts";

function setup() {
  const { app, instances } = testApp({ workflows: TEST_WORKFLOWS });
  return { app, stores: instances.instance(TEST_USER).stores };
}

const read = async (app: ReturnType<typeof setup>["app"]) => {
  const response = await app.request("/api/settings", { headers: ownerHeaders() });
  expect(response.status).toBe(200);
  return settingsResponseSchema.parse(await response.json()).settings.comfyuiWorkflow;
};

describe("the settings' workflow", () => {
  it("saves a user's workflow that exists and refuses one that does not", async () => {
    const { app, stores } = setup();
    const { id } = storeUserWorkflow(stores.workflows);
    const saved = await app.request("/api/settings", requestJson("PATCH", { comfyuiWorkflow: id }));
    expect(saved.status).toBe(200);
    expect(settingsResponseSchema.parse(await saved.json()).settings.comfyuiWorkflow).toBe(id);
    expect(await read(app)).toBe(id);

    const unknown = userWorkflowId(crypto.randomUUID());
    const refused = await app.request(
      "/api/settings",
      requestJson("PATCH", { comfyuiWorkflow: unknown }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "unknown_reference" });
    expect(await read(app)).toBe(id);
  });

  it("shows the default for a row naming a deleted user workflow", async () => {
    const { app, stores } = setup();
    const { id, uuid } = storeUserWorkflow(stores.workflows);
    stores.settings.update({ comfyuiWorkflow: id });
    // A row left naming it, as one written before the delete repointed it.
    const gone = userWorkflowId(crypto.randomUUID());
    stores.settings.update({ comfyuiWorkflow: gone });
    expect(stores.settings.get().comfyuiWorkflow).toBe(gone);
    expect(await read(app)).toBe(TEST_WORKFLOWS.defaultWorkflow);

    stores.settings.update({ comfyuiWorkflow: id });
    stores.workflows.remove(uuid);
    expect(await read(app)).toBe(TEST_WORKFLOWS.defaultWorkflow);
  });
});
