import {
  eventCreateRequestSchema,
  eventPatchRequestSchema,
  type eventsResponseSchema,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { EventStore } from "./persistence/store.ts";
import { answerUpdate, idParam, invalid, invalidRequest, jsonLimit, removed } from "./routes.ts";
import type { FromUser, UserEnv } from "./user.ts";

/**
 * Events: list (newest first), create, edit against a revision and delete,
 * all of the requester's store. Definitions only: which event fired where
 * travels with the chat requests and never reaches these routes.
 */
export function createEventsApi(store: FromUser<EventStore>) {
  return new Hono<UserEnv>()
    .get("/", (c) =>
      c.json({ events: store(c).list() } satisfies z.input<typeof eventsResponseSchema>, 200),
    )
    .post("/", jsonLimit, zValidator("json", eventCreateRequestSchema, invalid), (c) => {
      const { id, ...fields } = c.req.valid("json");
      // The client chooses the id, so a retried create cannot make a second event.
      if (store(c).create(fields, id) === "full")
        return c.json({ error: "too_many_events" as const }, 409);
      return c.json({ id }, 201);
    })
    .patch(
      "/:id",
      idParam,
      jsonLimit,
      zValidator("json", eventPatchRequestSchema, invalid),
      (c) => {
        const { revision, ...patch } = c.req.valid("json");
        try {
          return answerUpdate(c, store(c).update(c.req.valid("param").id, patch, revision));
        } catch (error) {
          // Partial validation cannot see whether enabling leaves the stored text blank.
          if (error instanceof z.ZodError) return invalidRequest(c);
          throw error;
        }
      },
    )
    .delete("/:id", idParam, (c) => removed(c, store(c).remove(c.req.valid("param").id)));
}
