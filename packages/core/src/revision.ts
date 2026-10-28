import { z } from "zod";

/*
 * Optimistic concurrency for the entities sheets edit (characters, personas,
 * prompt and sampler presets). Each carries a revision: 0 when created,
 * duplicated or imported, one more with every edit. An edit names the
 * revision its editor last had; a different one is refused, so a stale tab
 * cannot silently overwrite another's save.
 */

export const revisionSchema = z.number().int().nonnegative();

/** What every stored entity carries beside its id: its revision and when it was created and last changed. */
export const storedFields = {
  revision: revisionSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
};

/** An edit's request body: the edit and the revision it was made against. */
export const withRevision = <Shape extends z.ZodRawShape>(patch: z.ZodObject<Shape>) =>
  patch.extend({ revision: revisionSchema });

/** The answer to an edit made against another revision (409): the current one. */
export const conflictSchema = z.strictObject({
  error: z.literal("conflict"),
  revision: revisionSchema,
});
