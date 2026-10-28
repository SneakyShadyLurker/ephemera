import {
  type ChapterOutput,
  chapterOutputSchema,
  type EpisodeFields,
  emptyNotebook,
  episodeFieldsSchema,
  MEMORY_LIMITS,
  MEMORY_ON_BY_DEFAULT,
  type MemoryNotebook,
  type MemoryOutput,
  type MemoryState,
  memoryIsOn,
  memoryOutputSchema,
  memoryStateOf,
  memoryStatePatchRequestSchema,
  type StoredEpisode,
} from "@ephemera/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { defined, revised } from "./revised.ts";
import { characters, memories, memoryNotebooks } from "./schema.ts";
import type { ChapterMember, MemoryStore, Patch, Remembered, Updated } from "./store.ts";

const statePatchSchema = memoryStatePatchRequestSchema.omit({ revision: true });
const episodePatchSchema = episodeFieldsSchema.partial();
const turnsSchema = z.number().int().min(0);
const chapterMembersSchema = z
  .array(
    z.strictObject({ id: z.uuid(), revision: z.number().int(), chapterId: z.uuid().nullable() }),
  )
  .min(1);

type NotebookRow = typeof memoryNotebooks.$inferSelect;

const toState = ({
  enabled,
  situation,
  relationships,
  facts,
  threads,
  cast,
  opening,
  revision,
  updatedAt,
}: NotebookRow) => ({
  enabled,
  notebook: { situation, relationships, facts, threads, cast },
  opening,
  revision,
  updatedAt,
});

/**
 * Characters' memories: one notebook row per character, the next chat's
 * opening on it, and its episodes, `seq` ascending. A character has no row until the first write that needs
 * one (turning memory off, a notebook edit, a memory written): it reads as
 * on, with an empty notebook at revision 0, and that write creates the row
 * (`createdRow`). Every write parses a core schema first, as the other
 * stores do (PRINCIPLES.md 1); only the memory call's output and the owner's
 * edits are written, never the span they came from.
 */
export function createMemoryStore(db: Db): MemoryStore {
  const now = () => Date.now();

  const state = (characterId: string): MemoryState | undefined => {
    const row = db
      .select()
      .from(memoryNotebooks)
      .where(eq(memoryNotebooks.characterId, characterId))
      .get();
    return row === undefined ? undefined : toState(row);
  };

  const get = (id: string): StoredEpisode | undefined =>
    db.select().from(memories).where(eq(memories.id, id)).get();

  const characterExists = (characterId: string) =>
    db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.id, characterId))
      .get() !== undefined;

  const episodeCount = (characterId: string) =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.characterId, characterId))
      .get()?.count ?? 0;

  const nextSeq = (characterId: string) =>
    (db
      .select({ seq: sql<number | null>`max(${memories.seq})` })
      .from(memories)
      .where(eq(memories.characterId, characterId))
      .get()?.seq ?? -1) + 1;

  /** Inserts one episode or chapter, next in `seq`, and returns it as stored. */
  const insert = (
    characterId: string,
    fields: { kind: StoredEpisode["kind"]; turns: number } & Omit<EpisodeFields, "pinned">,
  ): StoredEpisode => {
    const time = now();
    return db
      .insert(memories)
      .values({
        id: crypto.randomUUID(),
        characterId,
        seq: nextSeq(characterId),
        ...fields,
        chapterId: null,
        pinned: false,
        createdAt: time,
        updatedAt: time,
      })
      .returning()
      .get();
  };

  /**
   * The row of a character that had none, written with `values` at
   * revision 1, as the first edit of a row at revision 0 is.
   */
  const createdRow = (
    characterId: string,
    values: { enabled?: boolean; opening?: string } & Partial<MemoryNotebook>,
  ): NotebookRow =>
    db
      .insert(memoryNotebooks)
      .values({
        characterId,
        enabled: MEMORY_ON_BY_DEFAULT,
        ...emptyNotebook(),
        ...values,
        revision: 1,
        updatedAt: now(),
      })
      .returning()
      .get();

  /**
   * Rewrites the notebook and the opening made at `revision`; the row as
   * written, or none when it moved on.
   */
  const writeNotebook = (
    characterId: string,
    { notebook, opening }: { notebook: MemoryNotebook; opening: string },
    revision: number,
  ): NotebookRow | undefined =>
    db
      .update(memoryNotebooks)
      .set({ ...notebook, opening, revision: revision + 1, updatedAt: now() })
      .where(
        and(eq(memoryNotebooks.characterId, characterId), eq(memoryNotebooks.revision, revision)),
      )
      .returning()
      .get();

  return {
    state,
    get,

    setState(characterId, input, expected): Updated<MemoryState> {
      const patch = statePatchSchema.parse(input);
      const values = {
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.notebook ?? {}),
        ...(patch.opening === undefined ? {} : { opening: patch.opening }),
      };
      return db.transaction(() => {
        const stored = state(characterId);
        return revised(
          characterExists(characterId) ? memoryStateOf(stored ?? null) : undefined,
          expected,
          {
            apply: (row) => ({
              ...row,
              ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
              notebook: { ...row.notebook, ...patch.notebook },
              ...(patch.opening === undefined ? {} : { opening: patch.opening }),
            }),
            compare: (row) => row,
            write: (_edited, revision) => {
              if (stored === undefined) return toState(createdRow(characterId, values));
              const row = db
                .update(memoryNotebooks)
                .set({ ...values, revision, updatedAt: now() })
                .where(eq(memoryNotebooks.characterId, characterId))
                .returning()
                .get();
              return row === undefined ? undefined : toState(row);
            },
          },
        );
      });
    },

    list(characterId): StoredEpisode[] {
      return db
        .select()
        .from(memories)
        .where(eq(memories.characterId, characterId))
        .orderBy(asc(memories.seq))
        .all();
    },

    update(id, input: Patch<EpisodeFields>, expected): Updated<StoredEpisode> {
      const patch = defined(episodePatchSchema.parse(input));
      return db.transaction(() =>
        revised(get(id), expected, {
          apply: (row) => ({ ...row, ...patch }),
          compare: (row) => row,
          write: (_edited, revision) =>
            db
              .update(memories)
              .set({ ...patch, revision, updatedAt: now() })
              .where(eq(memories.id, id))
              .returning()
              .get(),
        }),
      );
    },

    remove(id): boolean {
      return (
        db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id }).all().length >
        0
      );
    },

    forget(characterId): boolean {
      return db.transaction(() => {
        if (!characterExists(characterId)) return false;
        db.delete(memories).where(eq(memories.characterId, characterId)).run();
        // The notebook and the opening empty; the owner's choice of on or off stays.
        const current = state(characterId);
        if (current !== undefined) {
          writeNotebook(characterId, { notebook: emptyNotebook(), opening: "" }, current.revision);
        }
        return true;
      });
    },

    remember(
      characterId,
      input: { output: MemoryOutput; turns: number; notebookRevision: number },
    ) {
      const { title, summary, cues, notebook, opening } = memoryOutputSchema.parse(input.output);
      const turns = turnsSchema.parse(input.turns);
      return db.transaction((): Remembered => {
        if (!characterExists(characterId)) return "missing";
        const stored = state(characterId);
        const current = memoryStateOf(stored ?? null);
        if (!memoryIsOn(current)) return "off";
        if (episodeCount(characterId) >= MEMORY_LIMITS.episodes) return "full";
        const episode = insert(characterId, { kind: "episode", turns, title, summary, cues });
        // The owner edited the notebook or the opening during the call: their edit stays.
        const written =
          current.revision !== input.notebookRevision
            ? undefined
            : stored === undefined
              ? createdRow(characterId, { ...notebook, opening })
              : writeNotebook(characterId, { notebook, opening }, current.revision);
        return {
          status: "written",
          episode,
          notebook: written === undefined ? current : toState(written),
        };
      });
    },

    chapter(characterId, input: { output: ChapterOutput; members: ChapterMember[] }) {
      const { title, summary, cues } = chapterOutputSchema.parse(input.output);
      const read = chapterMembersSchema.parse(input.members);
      const ids = read.map((member) => member.id);
      return db.transaction(() => {
        if (!characterExists(characterId)) return "missing";
        if (!memoryIsOn(state(characterId) ?? null)) return "off";
        const members = db
          .select()
          .from(memories)
          .where(and(eq(memories.characterId, characterId), inArray(memories.id, ids)))
          .all();
        // Every member as the chapter read it: still there, unedited and in no chapter.
        const found = new Map(members.map((member) => [member.id, member]));
        const moved = read.some((member) => {
          const stored = found.get(member.id);
          return (
            stored === undefined ||
            stored.revision !== member.revision ||
            member.chapterId !== null ||
            stored.chapterId !== null
          );
        });
        if (moved) return "stale";
        if (episodeCount(characterId) >= MEMORY_LIMITS.episodes) return "full";
        const turns = members.reduce((sum, member) => sum + member.turns, 0);
        const chapter = insert(characterId, { kind: "chapter", turns, title, summary, cues });
        db.update(memories)
          .set({ chapterId: chapter.id, updatedAt: now() })
          .where(and(eq(memories.characterId, characterId), inArray(memories.id, ids)))
          .run();
        return chapter;
      });
    },
  };
}
