import { z } from "zod";
import { CARD_LIMITS as L } from "../card/limits.ts";
import {
  type Lorebook,
  type LorebookEntry,
  lorebookSchema,
  storedLorebookDataSchema,
} from "../card/schema.ts";
import { fitsNativeFile, hasIssue } from "../file-format.ts";
import { storedFields, withRevision } from "../revision.ts";
import { LOREBOOK_LINKS } from "./rules.ts";
import { type EntrySettings, entrySettings } from "./settings.ts";

/*
 * Library lorebooks: standalone books, persisted per user like characters
 * and linked to characters by id. A book keeps the embedded book's schema
 * and limits; its whole JSON stays within the card limit. Book text is
 * untrusted like card fields (PRINCIPLES.md 3).
 */

/** Public writes keep native exports within the file byte limit. Stored reads omit this refinement. */
export const publicLorebookSchema = lorebookSchema.refine(
  (book) => fitsNativeFile("ephemera.lorebook", book),
  {
    message: "The lorebook is past the size limit",
    params: { code: "lorebook_too_large" },
  },
);
/** Whether a parse failed because the whole book is past the limit, not because a field is invalid. */
export const isLorebookTooLarge = (error: z.ZodError): boolean =>
  hasIssue(error, "lorebook_too_large");

/** Library ids are UUIDs: the timed state names a library book by its id. */
const lorebookId = z.uuid();

/** What a book's screen edits: its name and the whole book. */
export const lorebookFieldsSchema = z.strictObject({
  name: z.string().trim().min(1).max(L.nameLength),
  book: publicLorebookSchema,
});
export type LorebookFields = z.infer<typeof lorebookFieldsSchema>;

/** A PATCH body: the name, the whole book or both, and the revision they were made against. */
export const lorebookPatchRequestSchema = withRevision(lorebookFieldsSchema.partial());

/** One library book as the API returns it. */
export const storedLorebookSchema = z.strictObject({
  id: lorebookId,
  name: z.string(),
  book: storedLorebookDataSchema,
  ...storedFields,
});
export type StoredLorebook = z.infer<typeof storedLorebookSchema>;

const count = z.number().int().min(0);

/** The counts a list row shows, from `summarizeLorebook`. */
const lorebookCountsSchema = z.strictObject({
  description: z.string(),
  entries: count,
  /** Entries switched on; the three kinds below count only these, each entry once. */
  enabled: count,
  /** Always on: constant, without a trigger chance. */
  always: count,
  /** Read by keywords: every other entry that is not by chance. */
  keywords: count,
  /** By chance: constant, with a trigger chance. */
  chance: count,
});
export type LorebookCounts = z.infer<typeof lorebookCountsSchema>;

/** What the library lists. */
export const lorebookSummarySchema = z.strictObject({
  id: lorebookId,
  name: z.string(),
  ...lorebookCountsSchema.shape,
  updatedAt: z.number().int(),
});
export type LorebookSummary = z.infer<typeof lorebookSummarySchema>;

/** Each character's linked library books, in link order. */
export const lorebookLinksSchema = z.array(
  z.strictObject({
    characterId: z.string(),
    lorebookIds: z
      .array(lorebookId)
      .max(LOREBOOK_LINKS)
      .refine((ids) => new Set(ids).size === ids.length, "one link per book"),
  }),
);
export type LorebookLinks = z.infer<typeof lorebookLinksSchema>;

/**
 * How an entry goes in: always (constant, no chance), on its keywords (a
 * keyword entry may still carry a chance), or by chance (constant with a
 * trigger chance, no keyword needed).
 */
export const ENTRY_ACTIVATIONS = ["always", "keywords", "chance"] as const;
export type EntryActivation = (typeof ENTRY_ACTIVATIONS)[number];

/** An entry's activation; `settings`, when given, are its `entrySettings`. */
export function entryActivation(entry: LorebookEntry, settings?: EntrySettings): EntryActivation {
  if (entry.constant !== true) return "keywords";
  return (settings ?? entrySettings(entry)).chance === null ? "always" : "chance";
}

/** A book's counts for a list row, one owner for library and embedded books. */
export function summarizeLorebook(book: Lorebook): LorebookCounts {
  const counts: Record<EntryActivation, number> = { always: 0, keywords: 0, chance: 0 };
  let enabled = 0;
  for (const entry of book.entries) {
    if (!entry.enabled) continue;
    enabled += 1;
    counts[entryActivation(entry)] += 1;
  }
  return {
    description: book.description ?? "",
    entries: book.entries.length,
    enabled,
    ...counts,
  };
}

/** An empty book, named when `name` is given ("New lorebook"). */
export function blankLorebook(name?: string): Lorebook {
  return { ...(name === undefined ? {} : { name }), entries: [] };
}
