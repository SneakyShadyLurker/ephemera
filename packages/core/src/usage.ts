import { z } from "zod";
import { modelIdSchema } from "./chat.ts";

export const MAX_CALL_RECORDS = 128;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Reported fields only. Missing is unknown, including a missing cached count. */
export const callUsageSchema = z.strictObject({
  inputTokens: count.exactOptional(),
  cachedTokens: count.exactOptional(),
  outputTokens: count.exactOptional(),
  reasoningTokens: count.exactOptional(),
});
export type CallUsage = z.infer<typeof callUsageSchema>;

export const callPurposeSchema = z.enum([
  "narration",
  "scene.prompt",
  "cast.update",
  "cast.sheet",
  "memory.remember",
  "memory.chapter",
  "memory.opening",
]);
export type CallPurpose = z.infer<typeof callPurposeSchema>;

/** Content-free metadata for one actual provider attempt, never an assembled prompt. */
export const callRecordSchema = z.strictObject({
  id: z.uuid(),
  purpose: callPurposeSchema,
  model: modelIdSchema,
  status: z.enum(["completed", "failed", "aborted"]),
  finishReason: z
    .enum(["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"])
    .exactOptional(),
  durationMs: count.exactOptional(),
  usage: callUsageSchema,
});
export type CallRecord = z.infer<typeof callRecordSchema>;
export const callAccountingSchema = z.strictObject({
  calls: z.array(callRecordSchema).max(MAX_CALL_RECORDS),
  truncated: z.boolean(),
});
export type CallAccounting = z.infer<typeof callAccountingSchema>;
