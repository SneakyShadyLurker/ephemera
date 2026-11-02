import {
  EVENT_LIMITS,
  type EventFields,
  eventFieldsSchema,
  type StoredEvent,
  storedEventSchema,
} from "@ephemera/core";
import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { defined, revised } from "./revised.ts";
import { events } from "./schema.ts";
import type { EventCreation, EventStore, Patch, Updated } from "./store.ts";

const eventPatchSchema = eventFieldsSchema.partial();

/**
 * The events repository: definitions only, newest first, at most
 * `EVENT_LIMITS.events`. Every write parses the core schema first, as the
 * other stores do (PRINCIPLES.md 1); there is no generic write.
 */
export function createEventStore(db: Db): EventStore {
  const now = () => Date.now();

  const get = (id: string): StoredEvent | undefined =>
    db.select().from(events).where(eq(events.id, id)).get();

  return {
    get,

    list(): StoredEvent[] {
      return db.select().from(events).orderBy(desc(events.createdAt), asc(events.id)).all();
    },

    create(input: EventFields, requestedId: string): EventCreation {
      const fields = eventFieldsSchema.parse(input);
      const id = z.uuid().parse(requestedId);
      return db.transaction(() => {
        // A repeated create (a retry after a lost response) finds its own row and writes nothing.
        if (get(id) !== undefined) return "created";
        const { count } = db.select({ count: sql<number>`count(*)` }).from(events).get() ?? {
          count: 0,
        };
        if (count >= EVENT_LIMITS.events) return "full";
        const time = now();
        db.insert(events)
          .values({ id, ...fields, createdAt: time, updatedAt: time })
          .run();
        return "created";
      });
    },

    update(id: string, input: Patch<EventFields>, expected: number): Updated<StoredEvent> {
      const patch = defined(eventPatchSchema.parse(input));
      return db.transaction(() =>
        revised(get(id), expected, {
          apply: (row) => storedEventSchema.parse({ ...row, ...patch }),
          compare: (row) => row,
          write: (_edited, revision) =>
            db
              .update(events)
              .set({ ...patch, revision, updatedAt: now() })
              .where(eq(events.id, id))
              .returning()
              .get(),
        }),
      );
    },

    remove(id: string): boolean {
      return (
        db.delete(events).where(eq(events.id, id)).returning({ id: events.id }).all().length > 0
      );
    },
  };
}
