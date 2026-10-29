import {
  customPaletteCss,
  customPaletteInputSchema,
  customPaletteReplaceSchema,
  customSlotSchema,
  type paletteResponseSchema,
  type palettesResponseSchema,
  type settingsResponseSchema,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkflowCatalog } from "./comfyui/catalog.ts";
import { PALETTES_CSS_PATH } from "./paths.ts";
import type { CustomPaletteStore, SettingsStore } from "./persistence/store.ts";
import { invalid, jsonLimit, notFound } from "./routes.ts";
import { shown } from "./settings.ts";
import type { FromUser, UserEnv } from "./user.ts";

const slotParam = zValidator(
  "param",
  // Canonical digits only, so "01" or "1e0" is no slot's path.
  z.object({
    slot: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(customSlotSchema),
  }),
  invalid,
);

/**
 * The requester's custom palettes: list, create one in an empty slot (409
 * when another tab took it), replace or delete the one saved at a given
 * `updatedAt` (409 when another save came since), the delete answering with the
 * settings come back, since deleting the chosen palette changes them), and
 * the stylesheet the app shell links so a reload paints a saved palette
 * before any script runs. The stylesheet carries only validated colours.
 */
export function createPalettesApi(
  store: FromUser<CustomPaletteStore>,
  settings: FromUser<SettingsStore>,
  catalogFor: FromUser<Pick<WorkflowCatalog, "known">>,
) {
  return new Hono<UserEnv>()
    .get("/palettes", (c) =>
      c.json({ palettes: store(c).list() } satisfies z.input<typeof palettesResponseSchema>, 200),
    )
    .get(PALETTES_CSS_PATH, (c) =>
      c.body(customPaletteCss(store(c).list()), 200, {
        "Content-Type": "text/css; charset=utf-8",
      }),
    )
    .post(
      "/palettes/:slot",
      slotParam,
      jsonLimit,
      zValidator("json", customPaletteInputSchema, invalid),
      (c) => {
        const palette = store(c).create(c.req.valid("param").slot, c.req.valid("json"));
        if (palette === undefined) return c.json({ error: "slot_taken" as const }, 409);
        return c.json({ palette } satisfies z.input<typeof paletteResponseSchema>, 200);
      },
    )
    .put(
      "/palettes/:slot",
      slotParam,
      jsonLimit,
      zValidator("json", customPaletteReplaceSchema, invalid),
      (c) => {
        const { updatedAt, ...input } = c.req.valid("json");
        const palette = store(c).replace(c.req.valid("param").slot, input, updatedAt);
        if (palette === "missing") return notFound(c);
        if (palette === "changed") return c.json({ error: "changed" as const }, 409);
        return c.json({ palette } satisfies z.input<typeof paletteResponseSchema>, 200);
      },
    )
    .delete(
      "/palettes/:slot",
      slotParam,
      zValidator("query", z.object({ updatedAt: z.coerce.number().int() }), invalid),
      (c) => {
        const outcome = store(c).delete(c.req.valid("param").slot, c.req.valid("query").updatedAt);
        if (outcome === "missing") return notFound(c);
        if (outcome === "changed") return c.json({ error: "changed" as const }, 409);
        return c.json(
          { settings: shown(settings(c).get(), catalogFor(c)) } satisfies z.input<
            typeof settingsResponseSchema
          >,
          200,
        );
      },
    );
}
