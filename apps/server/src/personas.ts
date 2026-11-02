import {
  personaFieldsSchema,
  personaPatchRequestSchema,
  type personasResponseSchema,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Logger } from "./log.ts";
import type { PersonaStore } from "./persistence/store.ts";
import {
  answerUpdate,
  createPortraitApi,
  duplicated,
  idParam,
  invalid,
  invalidRequest,
  jsonLimit,
  notFound,
  removed,
} from "./routes.ts";
import type { FromUser, UserEnv } from "./user.ts";

/**
 * The persona a request names, as prompts read it: its name and description;
 * null for none, or for one deleted since it was chosen.
 */
export function chosenPersona(
  personas: PersonaStore,
  id: string | undefined,
): { name: string; description: string } | null {
  const persona = id === undefined ? undefined : personas.get(id);
  return persona === undefined ? null : { name: persona.name, description: persona.description };
}

/**
 * Personas: list, sheet, bindings to characters, and portraits through the
 * shared routes, all of the requester's store.
 */
export function createPersonasApi(store: FromUser<PersonaStore>, log: Logger) {
  return new Hono<UserEnv>()
    .route("/", createPortraitApi(store, log, "personas"))
    .get("/", (c) =>
      c.json({ personas: store(c).list() } satisfies z.input<typeof personasResponseSchema>, 200),
    )
    .post(
      "/",
      jsonLimit,
      zValidator("json", z.strictObject({ id: z.uuid(), fields: personaFieldsSchema }), invalid),
      (c) => {
        const { id, fields } = c.req.valid("json");
        // The client chooses the id, so a retried create cannot make a second persona.
        return c.json({ id: store(c).create(fields, id) }, 201);
      },
    )
    .put(
      "/bindings/:characterId",
      zValidator("param", z.object({ characterId: z.uuid() }), invalid),
      jsonLimit,
      zValidator("json", z.strictObject({ personaId: z.uuid().nullable() }), invalid),
      (c) =>
        store(c).bind(c.req.valid("param").characterId, c.req.valid("json").personaId)
          ? c.body(null, 204)
          : notFound(c),
    )
    .get("/:id", idParam, (c) => {
      const persona = store(c).get(c.req.valid("param").id);
      if (persona === undefined) return notFound(c);
      return c.json(persona, 200);
    })
    .patch(
      "/:id",
      idParam,
      jsonLimit,
      zValidator("json", personaPatchRequestSchema, invalid),
      (c) => {
        const { revision, ...patch } = c.req.valid("json");
        return answerUpdate(c, store(c).update(c.req.valid("param").id, patch, revision));
      },
    )
    .delete("/:id", idParam, (c) => removed(c, store(c).remove(c.req.valid("param").id)))
    .post("/:id/duplicate", idParam, (c) => {
      try {
        return duplicated(c, store(c).duplicate(c.req.valid("param").id));
      } catch (error) {
        if (error instanceof z.ZodError) return invalidRequest(c);
        throw error;
      }
    });
}
