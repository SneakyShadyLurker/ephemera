import {
  blankLorebook,
  CARD_LIMITS,
  clipText,
  type importResponseSchema,
  importWorldInfo,
  isLorebookTooLarge,
  type Lorebook,
  type libraryResponseSchema,
  lorebookFieldsSchema,
  lorebookPatchRequestSchema,
  serializeLorebook,
  type WorldInfoImportError,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Logger } from "./log.ts";
import { IMPORT_PATH } from "./paths.ts";
import type { LorebookStore } from "./persistence/store.ts";
import {
  answerUpdate,
  attachment,
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
} from "./routes.ts";
import type { FromUser, UserEnv } from "./user.ts";

/** The name of a book whose file gives none and whose file name is empty. */
const IMPORTED_NAME = "Imported lorebook";

/** Why an uploaded file was refused: the importer's codes, or text that is not JSON. */
type LorebookFileError = WorldInfoImportError | "not_json";

/** A book past the standalone limit is 413, as a card past its limit is; any other refusal is 400 without detail. */
const bookRefused = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (result.success) return;
  if (result.error instanceof z.ZodError && isLorebookTooLarge(result.error))
    return payloadTooLarge(c);
  return invalidRequest(c);
};

const createSchema = z.strictObject({
  id: z.uuid(),
  name: lorebookFieldsSchema.shape.name,
  book: lorebookFieldsSchema.shape.book.optional(),
});

const linkParam = zValidator("param", z.object({ id: z.uuid(), characterId: z.uuid() }), invalid);

/** A write the store refused because the book, with its name mirrored, outgrew the limit. */
const bookOutgrew = (error: unknown) => outgrew(error, isLorebookTooLarge);

/** The file's own name, else the uploaded file's base name, else a fixed one; trimmed and bounded. */
function importedName(book: Lorebook, fileName: string): string {
  const base = (fileName.split(/[\\/]/).at(-1) ?? "").replace(/\.[^.]*$/, "");
  for (const candidate of [book.name ?? "", base]) {
    const name = clipText(candidate.trim(), CARD_LIMITS.nameLength).trim();
    if (name !== "") return name;
  }
  return IMPORTED_NAME;
}

/** An uploaded file's JSON, or why it is not JSON; never its text. */
function parseFile(bytes: Uint8Array): { ok: true; json: unknown } | { ok: false } {
  try {
    // The decoder drops a leading byte order mark.
    return { ok: true, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

/**
 * Library lorebooks: list (with the books embedded in cards and every
 * character's links), sheet, native exports and foreign World Info imports, and
 * links to characters, all of the requester's store.
 */
export function createLorebooksApi(store: FromUser<LorebookStore>, log: Logger) {
  const refuse = (c: Context, error: LorebookFileError, field?: string) => {
    log.warn({ event: "lorebooks.import", errorClass: error });
    if (error === "too_large") return payloadTooLarge(c);
    return c.json({ error, ...(field ? { field } : {}) }, 422);
  };

  return new Hono<UserEnv>()
    .get("/", (c) => {
      const lorebooks = store(c);
      return c.json(
        {
          lorebooks: lorebooks.list(),
          embedded: lorebooks.embedded(),
          links: lorebooks.links(),
        } satisfies z.input<typeof libraryResponseSchema>,
        200,
      );
    })
    .post("/", jsonLimit, zValidator("json", createSchema, bookRefused), (c) => {
      const { id, name, book } = c.req.valid("json");
      try {
        // The client chooses the id, so a retried create cannot make a second book.
        return c.json(
          { id: store(c).create({ name, book: book ?? blankLorebook(name) }, id) },
          201,
        );
      } catch (error) {
        if (bookOutgrew(error)) return payloadTooLarge(c);
        throw error;
      }
    })
    .post(IMPORT_PATH, jsonLimit, fileForm, async (c) => {
      const { file } = c.req.valid("form");
      const bytes = await fileBytes(file);
      if (bytes.byteLength > CARD_LIMITS.cardJsonBytes) return refuse(c, "too_large");
      const parsed = parseFile(bytes);
      if (!parsed.ok) return refuse(c, "not_json");
      const result = importWorldInfo(parsed.json);
      if (!result.ok) return refuse(c, result.error, result.field);
      const name = importedName(result.book, file.name);
      let id: string;
      try {
        id = store(c).create({ name, book: result.book }, crypto.randomUUID());
      } catch (error) {
        if (bookOutgrew(error)) return refuse(c, "too_large");
        throw error;
      }
      return c.json(
        { id, name, report: result.report } satisfies z.input<typeof importResponseSchema>,
        201,
      );
    })
    .get("/:id", idParam, (c) => {
      const lorebook = store(c).get(c.req.valid("param").id);
      if (lorebook === undefined) return notFound(c);
      return c.json(lorebook, 200);
    })
    .patch(
      "/:id",
      idParam,
      jsonLimit,
      zValidator("json", lorebookPatchRequestSchema, bookRefused),
      (c) => {
        const { revision, ...patch } = c.req.valid("json");
        let result: ReturnType<LorebookStore["update"]>;
        try {
          result = store(c).update(c.req.valid("param").id, patch, revision);
        } catch (error) {
          if (bookOutgrew(error)) return payloadTooLarge(c);
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
        // The copy's longer name would take a book at the limit past it.
        if (bookOutgrew(error)) return payloadTooLarge(c);
        if (error instanceof z.ZodError) return invalidRequest(c);
        throw error;
      }
      return duplicated(c, id);
    })
    .get("/:id/export", idParam, (c) => {
      const lorebook = store(c).get(c.req.valid("param").id);
      if (lorebook === undefined) return notFound(c);
      const text = nativeExport(() => serializeLorebook(lorebook.book), isLorebookTooLarge);
      if (text === undefined) return payloadTooLarge(c);
      return c.body(text, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": attachment(lorebook.name, "json"),
      });
    })
    .put("/:id/characters/:characterId", linkParam, (c) => {
      const { id, characterId } = c.req.valid("param");
      const result = store(c).link(id, characterId);
      if (result === "missing") return notFound(c);
      if (result === "full") return c.json({ error: "too_many_lorebooks" as const }, 409);
      return c.body(null, 204);
    })
    .delete("/:id/characters/:characterId", linkParam, (c) => {
      const { id, characterId } = c.req.valid("param");
      return removed(c, store(c).unlink(id, characterId));
    });
}
