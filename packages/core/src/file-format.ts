import { z } from "zod";
import { isRecord } from "./card/json.ts";
import { CARD_LIMITS } from "./card/limits.ts";
import { utf8Bytes } from "./tokens.ts";

export const NATIVE_FORMATS = [
  "ephemera.character",
  "ephemera.lorebook",
  "ephemera.prompt-preset",
  "ephemera.sampler-preset",
] as const;
export type NativeFormat = (typeof NATIVE_FORMATS)[number];

/** Own native markers reserve parsing, including malformed, unknown and mixed packets. */
export function isNativeFileAttempt(value: unknown): boolean {
  return (
    isRecord(value) &&
    (Object.hasOwn(value, "format") ||
      (Object.hasOwn(value, "version") &&
        !(
          Object.hasOwn(value, "spec") &&
          (value.spec === "chara_card_v2" || value.spec === "chara_card_v3")
        )))
  );
}

/** The version every native file is written in. */
export const NATIVE_VERSION = 1;

export const nativeEnvelope = <F extends NativeFormat, T>(format: F, data: T) => ({
  format,
  version: NATIVE_VERSION,
  data,
});

/** A native file of `format` carrying `data`. */
export const nativeEnvelopeSchema = <F extends NativeFormat, S extends z.ZodType>(
  format: F,
  data: S,
) => z.strictObject({ format: z.literal(format), version: z.literal(NATIVE_VERSION), data });

/**
 * Whether `data`, written as a native `format` file, stays within
 * `CARD_LIMITS.cardJsonBytes`, so anything saved can be exported and
 * imported again.
 */
export const fitsNativeFile = (format: NativeFormat, data: unknown): boolean =>
  utf8Bytes(JSON.stringify(nativeEnvelope(format, data))) <= CARD_LIMITS.cardJsonBytes;

/** Whether a parse failed on the refinement whose `params.code` is `code`, such as a too-large file. */
export const hasIssue = (error: z.ZodError, code: string): boolean =>
  error.issues.some((issue) => issue.code === "custom" && issue.params?.code === code);
