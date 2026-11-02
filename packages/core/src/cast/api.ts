import { z } from "zod";
import { COMMON_REFUSALS, chatTurnSchema, modelIdSchema, refusalBodySchema } from "../chat.ts";
import { REASONING_EFFORTS } from "../preset/sampler.ts";
import { callAccountingSchema, callUsageSchema } from "../usage.ts";

export { type CallUsage, callUsageSchema } from "../usage.ts";

import { CAST_LIMITS as L } from "./limits.ts";
import { castChangesSchema, castRegisterSchema, castSheetEntrySchema } from "./register.ts";

/*
 * The keeper's and the cast sheet's request and response bodies. The keeper
 * request and response are chat content: request memory only. The sheet is
 * character data derived from the card alone.
 */

const reasoning = z.enum(REASONING_EFFORTS).exactOptional();
/** sha256 hex of `castFingerprintInput(card)`. */
const fingerprint = z.string().length(64);

/** One keeper call: the register the browser holds and the turns it has not yet read. */
export const castUpdateRequestSchema = z.strictObject({
  /** The canon source; absent in a chat without a card. */
  characterId: z.uuid().exactOptional(),
  personaId: z.uuid().exactOptional(),
  model: modelIdSchema,
  reasoning,
  /** Seeding reads the opening alone; an update reads the turns since the last good snapshot. */
  mode: z.enum(["seed", "update"]),
  /** The fingerprint of the sheet this chat seeded from, null without one; decides canon. */
  sheetFingerprint: fingerprint.nullable(),
  register: castRegisterSchema,
  turns: z.array(chatTurnSchema).min(1).max(L.turns),
});
export type CastUpdateRequest = z.infer<typeof castUpdateRequestSchema>;

export const castUpdateResponseSchema = z.strictObject({
  changes: castChangesSchema,
  usage: callUsageSchema,
  accounting: callAccountingSchema.exactOptional(),
});
export type CastUpdateResponse = z.infer<typeof castUpdateResponseSchema>;

/** A character's cast sheet: its card's subjects, read from the card alone. */
export const castSheetSchema = z.strictObject({
  characterId: z.uuid(),
  fingerprint,
  entries: z.array(castSheetEntrySchema).max(L.sheetEntries),
  revision: z.number().int(),
  updatedAt: z.number().int(),
});
export type CastSheet = z.infer<typeof castSheetSchema>;

export const castSheetResponseSchema = z.strictObject({
  accounting: callAccountingSchema.exactOptional(),
  sheet: castSheetSchema.nullable(),
  /** Whether the sheet's fingerprint matches the card now. */
  current: z.boolean(),
});
export type CastSheetResponse = z.infer<typeof castSheetResponseSchema>;

export const castSheetRequestSchema = z.strictObject({
  model: modelIdSchema,
  reasoning,
  /** Regenerate even when current (the sheet's button). */
  force: z.boolean().exactOptional(),
});
export type CastSheetRequest = z.infer<typeof castSheetRequestSchema>;

/** Why the server answered a keeper or sheet call with no result, as its body names it. */
export const CAST_REFUSALS = ["cast_failed", ...COMMON_REFUSALS, "aborted", "not_found"] as const;
export type CastRefusal = (typeof CAST_REFUSALS)[number];

/** A refusal's body: one of the reasons, or the request outliving its deadline. */
export const castRefusalSchema = refusalBodySchema(CAST_REFUSALS);
