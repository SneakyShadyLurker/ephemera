import {
  applySheetPatch,
  blankCard,
  characterPatchRequestSchema,
  type charactersResponseSchema,
  fitsNativeFile,
  type importResponseSchema,
  isCardTooLarge,
  serializeCharacter,
  sheetFieldsSchema,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { cardToPng, readCardFile } from "./cards.ts";
import type { Logger } from "./log.ts";
import { IMPORT_PATH } from "./paths.ts";
import type { CharacterStore } from "./persistence/store.ts";
import {
  answerUpdate,
  attachment,
  createPortraitApi,
  duplicated,
  fileBytes,
  fileForm,
  idParam,
  invalid,
  invalidRequest,
  jsonLimit,
  nativeExport,
  notFound,
  outgrew,
  payloadTooLarge,
  removed,
  uploadLimit,
} from "./routes.ts";
import type { FromUser, UserEnv } from "./user.ts";

/** Characters: list, sheet, import, portraits and export, all of the requester's store. */
export function createCharactersApi(store: FromUser<CharacterStore>, log: Logger) {
  return new Hono<UserEnv>()
    .route("/", createPortraitApi(store, log, "characters"))
    .get("/", (c) =>
      c.json(
        { characters: store(c).list() } satisfies z.input<typeof charactersResponseSchema>,
        200,
      ),
    )
    .post(
      "/",
      jsonLimit,
      zValidator("json", z.strictObject({ id: z.uuid(), fields: sheetFieldsSchema }), invalid),
      (c) => {
        const { id, fields } = c.req.valid("json");
        const card = applySheetPatch(blankCard(fields.name), fields);
        if (!fitsNativeFile("ephemera.character", card)) return payloadTooLarge(c);
        // The client chooses the id, so a retried create cannot make a second character.
        return c.json({ id: store(c).create(card, undefined, id) }, 201);
      },
    )
    .post(IMPORT_PATH, uploadLimit, fileForm, async (c) => {
      const result = await readCardFile(await fileBytes(c.req.valid("form").file));
      if (!result.ok) {
        log.warn({ event: "characters.import", errorClass: result.error });
        if (result.error === "too_large" || result.error === "image_too_large") {
          return payloadTooLarge(c);
        }
        return c.json(
          { error: result.error, ...(result.field ? { field: result.field } : {}) },
          422,
        );
      }
      const id = store(c).create(result.card, result.portrait);
      const body = { id, name: result.card.name, report: result.report };
      return c.json(body satisfies z.input<typeof importResponseSchema>, 201);
    })
    .get("/:id", idParam, (c) => {
      const character = store(c).get(c.req.valid("param").id);
      if (character === undefined) return notFound(c);
      return c.json(character, 200);
    })
    .patch(
      "/:id",
      idParam,
      jsonLimit,
      zValidator("json", characterPatchRequestSchema, invalid),
      (c) => {
        const { revision, ...patch } = c.req.valid("json");
        let result: ReturnType<CharacterStore["update"]>;
        try {
          result = store(c).update(c.req.valid("param").id, patch, revision);
        } catch (error) {
          if (outgrew(error, isCardTooLarge)) return payloadTooLarge(c);
          // A valid partial edit can leave widened stored text past a public field limit.
          if (error instanceof z.ZodError) return invalidRequest(c);
          throw error;
        }
        return answerUpdate(c, result);
      },
    )
    .delete("/:id", idParam, (c) => removed(c, store(c).remove(c.req.valid("param").id)))
    .post("/:id/duplicate", idParam, (c) => {
      let id: string | undefined;
      try {
        id = store(c).duplicate(c.req.valid("param").id);
      } catch (error) {
        if (outgrew(error, isCardTooLarge)) return payloadTooLarge(c);
        if (error instanceof z.ZodError) return invalidRequest(c);
        throw error;
      }
      return duplicated(c, id);
    })
    .get("/:id/export.json", idParam, (c) => {
      const character = store(c).get(c.req.valid("param").id);
      if (character === undefined) return notFound(c);
      const text = nativeExport(() => serializeCharacter(character.card), isCardTooLarge);
      if (text === undefined) return payloadTooLarge(c);
      return c.body(text, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": attachment(character.card.name, "json"),
      });
    })
    .get("/:id/export.png", idParam, async (c) => {
      const { id } = c.req.valid("param");
      const characters = store(c);
      const character = characters.get(id);
      if (character === undefined) return notFound(c);
      // Refused before the portrait is read.
      if (nativeExport(() => serializeCharacter(character.card), isCardTooLarge) === undefined) {
        return payloadTooLarge(c);
      }
      const png = await cardToPng(character.card, (await characters.portrait(id, "full"))?.bytes);
      return c.body(new Uint8Array(png), 200, {
        "Content-Type": "image/png",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": attachment(character.card.name, "png"),
      });
    });
}
