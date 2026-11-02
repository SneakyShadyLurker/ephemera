import { type Settings, settingsPatchSchema, type settingsResponseSchema } from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { z } from "zod";
import type { WorkflowCatalog } from "./comfyui/catalog.ts";
import type { Logger } from "./log.ts";
import type { SettingsStore } from "./persistence/store.ts";
import { invalid, jsonLimit } from "./routes.ts";
import type { FromUser, UserEnv } from "./user.ts";

/**
 * The requester's UI settings: read once per tab, changed a field at a time.
 * A ComfyUI address must name an origin the server allows (the ComfyUI
 * client's rule); empty, which turns portraits off, always may. A workflow
 * without a graph is an unknown reference, as a deleted preset is; a saved
 * one whose graph is gone reads as the default.
 */
export const shown = (settings: Settings, workflows: Pick<WorkflowCatalog, "known">): Settings => ({
  ...settings,
  comfyuiWorkflow: workflows.known(settings.comfyuiWorkflow),
});

export function createSettingsApi(
  store: FromUser<SettingsStore>,
  {
    log,
    comfyuiAllows,
    catalogFor,
  }: {
    log: Logger;
    comfyuiAllows: (baseUrl: string) => boolean;
    /** The requester's workflows and the server's, built for each request (api.ts). */
    catalogFor: FromUser<Pick<WorkflowCatalog, "has" | "known">>;
  },
) {
  return new Hono<UserEnv>()
    .get("/", (c) =>
      c.json(
        { settings: shown(store(c).get(), catalogFor(c)) } satisfies z.input<
          typeof settingsResponseSchema
        >,
        200,
      ),
    )
    .patch("/", jsonLimit, zValidator("json", settingsPatchSchema, invalid), (c) => {
      const patch = c.req.valid("json");
      const address = patch.comfyuiBaseUrl;
      if (address !== undefined && address !== "" && !comfyuiAllows(address)) {
        log.warn({
          event: "settings.update",
          status: 422,
          errorClass: "comfyui_origin_not_allowed",
        });
        return c.json({ error: "comfyui_origin_not_allowed" as const }, 422);
      }
      const workflows = catalogFor(c);
      const known = patch.comfyuiWorkflow === undefined || workflows.has(patch.comfyuiWorkflow);
      const settings = known ? store(c).update(patch) : undefined;
      if (settings === undefined) {
        log.warn({ event: "settings.update", status: 422 });
        return c.json({ error: "unknown_reference" as const }, 422);
      }
      return c.json(
        { settings: shown(settings, workflows) } satisfies z.input<typeof settingsResponseSchema>,
        200,
      );
    });
}
