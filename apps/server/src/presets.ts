import {
  clipText,
  importPresetFile,
  isNativeFileAttempt,
  isPromptPresetTooLarge,
  PRESET_LIMITS,
  type presetImportResponseSchema,
  presetNameSchema,
  promptPresetPatchRequestSchema,
  promptPresetSchema,
  samplerPresetPatchRequestSchema,
  samplerPresetSchema,
  toPromptPresetFile,
  toSamplerPresetFile,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Logger } from "./log.ts";
import type { Patch, PresetKindStore, PresetStore, Updated } from "./persistence/store.ts";
import {
  answerUpdate,
  attachment,
  duplicated,
  idParam,
  invalid,
  invalidRequest,
  jsonLimit,
  nativeExport,
  notFound,
  payloadTooLarge,
} from "./routes.ts";
import type { FromUser, UserEnv } from "./user.ts";

const importSchema = z
  .strictObject({
    promptId: z.uuid(),
    samplerId: z.uuid(),
    /** The file's name without its extension. */
    name: presetNameSchema,
    /** A native file packet or foreign import JSON, validated at dispatch. */
    file: z.unknown(),
  })
  .refine((body) => body.promptId !== body.samplerId, "ids must differ");

interface PresetsApiDeps {
  log: Logger;
  /** The catalog's model ids, so an imported model is kept only when offered. */
  modelIds: (signal: AbortSignal) => Promise<string[] | undefined>;
}

/** One kind's routes: list, create, read, edit, duplicate and delete (never the last one). */
function presetRoutes<
  Preset,
  Stored extends {
    id: string;
    name: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
  },
>(
  store: FromUser<PresetKindStore<Preset, Stored>>,
  schema: z.ZodType<Preset>,
  patchSchema: z.ZodType<Patch<Preset> & { revision: number }>,
  toFile: (preset: Preset) => object,
  /** Whether an export failed on the preset's size, the one failure a stored preset may meet. */
  isTooLarge: (error: z.ZodError) => boolean,
) {
  return new Hono<UserEnv>()
    .get("/", (c) => c.json({ presets: store(c).list() }, 200))
    .post(
      "/",
      jsonLimit,
      zValidator("json", z.strictObject({ id: z.uuid(), preset: schema }), invalid),
      (c) => {
        const { id, preset } = c.req.valid("json");
        // The client chooses the id, so a retried create cannot make a second preset.
        return c.json({ id: store(c).create(preset, id) }, 201);
      },
    )
    .get("/:id", idParam, (c) => {
      const preset = store(c).get(c.req.valid("param").id);
      if (preset === undefined) return notFound(c);
      return c.json({ preset }, 200);
    })
    .get("/:id/export", idParam, (c) => {
      const preset = store(c).get(c.req.valid("param").id);
      if (preset === undefined) return notFound(c);
      // Stored rows also carry database metadata, which never belongs in a file.
      const {
        id: _id,
        revision: _revision,
        createdAt: _created,
        updatedAt: _updated,
        ...data
      } = preset;
      const text = nativeExport(() => JSON.stringify(toFile(schema.parse(data))), isTooLarge);
      if (text === undefined) return payloadTooLarge(c);
      return c.body(text, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": attachment(preset.name, "json"),
      });
    })
    .patch("/:id", idParam, jsonLimit, zValidator("json", patchSchema, invalid), (c) => {
      const { revision, ...rest } = c.req.valid("json");
      // What is left without the revision is the preset patch (TypeScript cannot see it through Omit).
      const patch = rest as Patch<Preset>;
      let result: Updated<Stored>;
      try {
        result = store(c).update(c.req.valid("param").id, patch, revision);
      } catch (error) {
        // The patch is valid alone but leaves the preset invalid.
        if (error instanceof z.ZodError) return invalidRequest(c);
        throw error;
      }
      return answerUpdate(
        c,
        result.status === "updated" ? { ...result, value: { preset: result.value } } : result,
      );
    })
    .delete("/:id", idParam, (c) => {
      const result = store(c).remove(c.req.valid("param").id);
      if (result === "missing") return notFound(c);
      if (result === "last") return c.json({ error: "last_preset" as const }, 409);
      return c.body(null, 204);
    })
    .post("/:id/duplicate", idParam, (c) => {
      try {
        return duplicated(c, store(c).duplicate(c.req.valid("param").id));
      } catch (error) {
        if (error instanceof z.ZodError) return invalidRequest(c);
        throw error;
      }
    });
}

/**
 * Native independent files and foreign paired imports, all in the requester's store.
 */
export function createPresetsApi(stores: FromUser<PresetStore>, deps: PresetsApiDeps) {
  return new Hono<UserEnv>()
    .post("/import", jsonLimit, zValidator("json", importSchema, invalid), async (c) => {
      const { promptId, samplerId, name, file } = c.req.valid("json");
      const result = importPresetFile(file, clipText(name, PRESET_LIMITS.nameLength), {
        newId: () => crypto.randomUUID(),
        models: isNativeFileAttempt(file) ? undefined : await deps.modelIds(c.req.raw.signal),
      });
      if (!result.ok) {
        deps.log.warn({ event: "presets.import", status: 422, errorClass: result.reason });
        return c.json({ error: result.reason }, 422);
      }
      const presets = stores(c);
      if (result.format === "prompt") {
        presets.prompt.create(result.prompt, promptId);
        return c.json(
          {
            format: "prompt",
            id: promptId,
            name: result.prompt.name,
            report: result.report,
          } satisfies z.input<typeof presetImportResponseSchema>,
          201,
        );
      }
      if (result.format === "sampler") {
        presets.sampler.create(result.sampler, samplerId);
        return c.json(
          {
            format: "sampler",
            id: samplerId,
            name: result.sampler.name,
            report: result.report,
          } satisfies z.input<typeof presetImportResponseSchema>,
          201,
        );
      }
      presets.createPair(result.prompt, result.sampler, { prompt: promptId, sampler: samplerId });
      return c.json(
        {
          format: "foreign",
          promptId,
          samplerId,
          name: result.prompt.name,
          report: result.report,
        } satisfies z.input<typeof presetImportResponseSchema>,
        201,
      );
    })
    .route(
      "/prompt",
      presetRoutes(
        (c) => stores(c).prompt,
        promptPresetSchema,
        promptPresetPatchRequestSchema,
        toPromptPresetFile,
        isPromptPresetTooLarge,
      ),
    )
    .route(
      "/sampler",
      presetRoutes(
        (c) => stores(c).sampler,
        samplerPresetSchema,
        samplerPresetPatchRequestSchema,
        toSamplerPresetFile,
        // Bounded fields keep a sampler preset far below the file limit.
        () => false,
      ),
    );
}
