import {
  copyName,
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  defaultSamplerPreset,
  type PromptPreset,
  promptPresetSchema,
  type SamplerPreset,
  type StoredPromptPreset,
  type StoredSamplerPreset,
  samplerPresetSchema,
  storedPromptPresetDataSchema,
} from "@ephemera/core";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { defined, revised } from "./revised.ts";
import { promptPresets, samplerPresets, settings } from "./schema.ts";
import type { PresetKindStore, PresetRemoval, PresetStore, Updated } from "./store.ts";

/*
 * Prompt and sampler presets. Every write parses the whole preset with its
 * core schema (PRINCIPLES.md 1). At least one preset of each kind always
 * exists, so a chat always has one to use.
 */

/** The typed row operations of one kind; the rules shared by both kinds live in `presetKind`. */
interface KindRows<Preset, Stored> {
  schema: z.ZodType<Preset>;
  storedSchema: z.ZodType<Preset>;
  list(): Stored[];
  /** No preset of this kind exists. */
  empty(): boolean;
  get(id: string): Stored | undefined;
  toPreset(stored: Stored): Preset;
  /** Inserts unless the id exists (a retried create writes nothing). */
  insert(id: string, preset: Preset, time: number): void;
  /** Writes the preset at `revision`; call inside a transaction that checked the current one. */
  replace(id: string, preset: Preset, revision: number, time: number): void;
  delete(id: string): void;
  /** The most recently edited preset other than `id`. */
  otherThan(id: string): string | undefined;
  settingsColumn: "promptPresetId" | "samplerPresetId";
  seed(): Preset;
}

function presetKind<Preset extends { name: string }, Stored extends { revision: number }>(
  db: Db,
  rows: KindRows<Preset, Stored>,
): PresetKindStore<Preset, Stored> {
  const store: PresetKindStore<Preset, Stored> = {
    list: () => rows.list(),
    get: (id) => rows.get(id),

    create(input, requestedId) {
      const preset = rows.schema.parse(input);
      const id = z.uuid().parse(requestedId);
      rows.insert(id, preset, Date.now());
      return id;
    },

    update(id, patch, expected): Updated<Stored> {
      const changes = defined(patch);
      return db.transaction(() =>
        revised(rows.get(id), expected, {
          apply: (row) => rows.schema.parse({ ...rows.toPreset(row), ...changes }),
          compare: (row) => rows.storedSchema.parse(rows.toPreset(row)),
          write: (preset, revision) => {
            rows.replace(id, preset, revision, Date.now());
            return rows.get(id);
          },
        }),
      );
    },

    duplicate(id) {
      return db.transaction(() => {
        const source = rows.get(id);
        if (source === undefined) return undefined;
        const preset = rows.toPreset(source);
        return store.create({ ...preset, name: copyName(preset.name) }, crypto.randomUUID());
      });
    },

    remove(id): PresetRemoval {
      return db.transaction(() => {
        if (rows.get(id) === undefined) return "missing";
        const other = rows.otherThan(id);
        if (other === undefined) return "last";
        // The preset in use hands over to the most recently edited other one.
        db.update(settings)
          .set({ [rows.settingsColumn]: other })
          .where(and(eq(settings.id, 1), eq(settings[rows.settingsColumn], id)))
          .run();
        rows.delete(id);
        return "removed";
      });
    },
  };

  // The built-in default, when this kind has none.
  if (rows.empty()) store.create(rows.seed(), crypto.randomUUID());
  return store;
}

/**
 * A prompt preset row as stored. Like the other JSON columns, the note is not
 * parsed on read (every write parsed it); a row from before the note reads as
 * core's default.
 */
function fromRow(row: typeof promptPresets.$inferSelect): StoredPromptPreset {
  return { ...row, authorsNote: row.authorsNote ?? { ...DEFAULT_AUTHORS_NOTE } };
}

export function createPresetStore(db: Db): PresetStore {
  const prompt = promptPresets;
  const sampler = samplerPresets;
  const kinds = {
    prompt: presetKind<PromptPreset, StoredPromptPreset>(db, {
      schema: promptPresetSchema,
      storedSchema: storedPromptPresetDataSchema,
      list: () => db.select().from(prompt).orderBy(desc(prompt.updatedAt)).all().map(fromRow),
      empty: () => db.select({ id: prompt.id }).from(prompt).limit(1).get() === undefined,
      get: (id) => {
        const row = db.select().from(prompt).where(eq(prompt.id, id)).get();
        return row === undefined ? undefined : fromRow(row);
      },
      toPreset: ({ name, blocks, actions, reasoning, authorsNote }) => ({
        name,
        blocks,
        actions,
        reasoning,
        authorsNote,
      }),
      insert: (id, { name, blocks, actions, reasoning, authorsNote }, time) =>
        db
          .insert(prompt)
          .values({
            id,
            name,
            blocks,
            actions,
            reasoning,
            authorsNote,
            createdAt: time,
            updatedAt: time,
          })
          .onConflictDoNothing({ target: prompt.id })
          .run(),
      replace: (id, { name, blocks, actions, reasoning, authorsNote }, revision, time) =>
        db
          .update(prompt)
          .set({ name, blocks, actions, reasoning, authorsNote, revision, updatedAt: time })
          .where(eq(prompt.id, id))
          .run(),
      delete: (id) => db.delete(prompt).where(eq(prompt.id, id)).run(),
      otherThan: (id) =>
        db
          .select({ id: prompt.id })
          .from(prompt)
          .where(ne(prompt.id, id))
          .orderBy(desc(prompt.updatedAt))
          .limit(1)
          .get()?.id,
      settingsColumn: "promptPresetId",
      seed: () => defaultPromptPreset(),
    }),
    sampler: presetKind<SamplerPreset, StoredSamplerPreset>(db, {
      schema: samplerPresetSchema,
      storedSchema: samplerPresetSchema,
      list: () => db.select().from(sampler).orderBy(desc(sampler.updatedAt)).all(),
      empty: () => db.select({ id: sampler.id }).from(sampler).limit(1).get() === undefined,
      get: (id) => db.select().from(sampler).where(eq(sampler.id, id)).get(),
      toPreset: ({ name, values }) => ({ name, values }),
      insert: (id, { name, values }, time) =>
        db
          .insert(sampler)
          .values({ id, name, values, createdAt: time, updatedAt: time })
          .onConflictDoNothing({ target: sampler.id })
          .run(),
      replace: (id, { name, values }, revision, time) =>
        db
          .update(sampler)
          .set({ name, values, revision, updatedAt: time })
          .where(eq(sampler.id, id))
          .run(),
      delete: (id) => db.delete(sampler).where(eq(sampler.id, id)).run(),
      otherThan: (id) =>
        db
          .select({ id: sampler.id })
          .from(sampler)
          .where(ne(sampler.id, id))
          .orderBy(desc(sampler.updatedAt))
          .limit(1)
          .get()?.id,
      settingsColumn: "samplerPresetId",
      seed: () => defaultSamplerPreset(),
    }),
  };
  return {
    ...kinds,
    createPair(promptPreset, samplerPreset, ids) {
      db.transaction(() => {
        kinds.prompt.create(promptPreset, ids.prompt);
        kinds.sampler.create(samplerPreset, ids.sampler);
      });
    },
  };
}
