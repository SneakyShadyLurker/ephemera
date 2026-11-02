import {
  copyName,
  type PersonaFields,
  type PersonaPatch,
  type PersonaSummary,
  personaFieldsSchema,
  personaPatchSchema,
} from "@ephemera/core";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { PortraitFiles } from "./portrait-files.ts";
import { createPortraitRows } from "./portraits.ts";
import { defined, revised } from "./revised.ts";
import { characters, personaBindings, personas, portraits } from "./schema.ts";
import type { PersonaStore, StoredPersona, Updated } from "./store.ts";

/**
 * The persona repository. Every write parses the persona schemas first, as
 * the character store does (PRINCIPLES.md 1); there is no generic write.
 */
export function createPersonaStore(db: Db, files: PortraitFiles): PersonaStore {
  const now = () => Date.now();
  const rows = createPortraitRows(db, "personaId", personas, files);

  const boundTo = (): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const { characterId, personaId } of db.select().from(personaBindings).all()) {
      const ids = map.get(personaId);
      if (ids === undefined) map.set(personaId, [characterId]);
      else ids.push(characterId);
    }
    return map;
  };

  const select = {
    id: personas.id,
    name: personas.name,
    description: personas.description,
    portrait: portraits.version,
    revision: personas.revision,
    createdAt: personas.createdAt,
    updatedAt: personas.updatedAt,
  };

  const get = (id: string): StoredPersona | undefined => {
    const row = db
      .select(select)
      .from(personas)
      .leftJoin(portraits, eq(portraits.personaId, personas.id))
      .where(eq(personas.id, id))
      .get();
    if (row === undefined) return undefined;
    const characterIds = db
      .select({ characterId: personaBindings.characterId })
      .from(personaBindings)
      .where(eq(personaBindings.personaId, id))
      .all()
      .map((binding) => binding.characterId);
    return { ...row, characterIds };
  };

  return {
    ...rows.store,
    get,

    list(): PersonaSummary[] {
      const bound = boundTo();
      return db
        .select({
          id: personas.id,
          name: personas.name,
          portrait: portraits.version,
          updatedAt: personas.updatedAt,
        })
        .from(personas)
        .leftJoin(portraits, eq(portraits.personaId, personas.id))
        .orderBy(desc(personas.updatedAt))
        .all()
        .map((row) => ({ ...row, characterIds: bound.get(row.id) ?? [] }));
    },

    create(input: PersonaFields, requestedId: string): string {
      const fields = personaFieldsSchema.parse(input);
      const id = z.uuid().parse(requestedId);
      const time = now();
      // A repeated create (a retry after a lost response) finds its own row and writes nothing.
      db.insert(personas)
        .values({ id, ...fields, createdAt: time, updatedAt: time })
        .onConflictDoNothing({ target: personas.id })
        .run();
      return id;
    },

    update(id: string, input: PersonaPatch, expected: number): Updated<StoredPersona> {
      const patch = defined(personaPatchSchema.parse(input));
      return db.transaction(() =>
        revised(get(id), expected, {
          apply: (row) => ({ ...row, ...patch }),
          compare: (row) => row,
          write: (_edited, revision) => {
            db.update(personas)
              .set({ ...patch, revision, updatedAt: now() })
              .where(eq(personas.id, id))
              .run();
            return get(id);
          },
        }),
      );
    },

    duplicate(id: string): string | undefined {
      return db.transaction(() => {
        const source = db.select().from(personas).where(eq(personas.id, id)).get();
        if (source === undefined) return undefined;
        const fields = personaFieldsSchema.parse({
          name: copyName(source.name),
          description: source.description,
        });
        const copy = crypto.randomUUID();
        const time = now();
        db.insert(personas)
          .values({ id: copy, ...fields, createdAt: time, updatedAt: time })
          .run();
        rows.copy(id, copy);
        return copy;
      });
    },

    /** Removes the persona; its portrait and bindings go with it, and settings forget it. */
    remove(id: string): boolean {
      return (
        db.delete(personas).where(eq(personas.id, id)).returning({ id: personas.id }).all().length >
        0
      );
    },

    bind(characterIdInput: string, personaIdInput: string | null): boolean {
      const characterId = z.uuid().parse(characterIdInput);
      const personaId = z.uuid().nullable().parse(personaIdInput);
      return db.transaction(() => {
        const character = db
          .select({ id: characters.id })
          .from(characters)
          .where(eq(characters.id, characterId))
          .get();
        if (character === undefined) return false;
        if (personaId === null) {
          db.delete(personaBindings).where(eq(personaBindings.characterId, characterId)).run();
          return true;
        }
        const persona = db
          .select({ id: personas.id })
          .from(personas)
          .where(eq(personas.id, personaId))
          .get();
        if (persona === undefined) return false;
        db.insert(personaBindings)
          .values({ characterId, personaId })
          .onConflictDoUpdate({ target: personaBindings.characterId, set: { personaId } })
          .run();
        return true;
      });
    },
  };
}
