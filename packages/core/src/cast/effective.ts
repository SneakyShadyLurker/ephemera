import { z } from "zod";
import { CAST_LIMITS } from "./limits.ts";
import {
  CAST_ANCHOR_FIELDS,
  type CastAnchor,
  type CastChanges,
  type CastEntry,
  type CastRegister,
  castContinuitySchema,
  rememberedCastAnchorSchema,
  setAnchorFields,
} from "./register.ts";

/** One precedence rule for every reader. Owner corrections may explicitly clear a field. */
export const effectiveCastAnchor = (
  entry: Pick<CastEntry, "anchor" | "developments">,
  correction: Partial<CastAnchor> = {},
): CastAnchor => {
  const anchor = { ...entry.anchor };
  for (const field of CAST_ANCHOR_FIELDS) {
    const value = entry.developments?.[field];
    if (value !== undefined) anchor[field] = value;
  }
  return { ...anchor, ...correction };
};

/** Identity recovery must never borrow developments or continuity from a future scene. */
export const castIdentity = ({
  developments: _developments,
  continuity: _continuity,
  ...entry
}: CastEntry): CastEntry => entry;

/** Require an exact short quote in one shown turn. This is grounding, not semantic proof. */
export function groundedCastChanges(changes: CastChanges, shown: readonly string[]): CastChanges {
  const grounded = <T extends Record<string, { value: string; evidence: string } | undefined>>(
    fields: T,
  ): T =>
    Object.fromEntries(
      Object.entries(fields).filter(
        ([, item]) =>
          item !== undefined &&
          item.value.trim() !== "" &&
          item.evidence.trim() !== "" &&
          shown.some((text) => text.includes(item.evidence)),
      ),
    ) as T;
  return {
    ...changes,
    cast: Object.fromEntries(
      Object.entries(changes.cast).map(([name, change]) => [
        name,
        {
          ...change,
          ...(change.developments === undefined
            ? {}
            : { developments: grounded(change.developments) }),
          ...(change.continuity === undefined ? {} : { continuity: grounded(change.continuity) }),
        },
      ]),
    ),
  };
}

/** Request-only archivist context: no ids, aliases, role or volatile scene state. */
export const memoryCastContextSchema = z
  .array(
    z.strictObject({
      anchor: rememberedCastAnchorSchema,
      continuity: castContinuitySchema.exactOptional(),
    }),
  )
  .max(CAST_LIMITS.entries);
export type MemoryCastContext = z.infer<typeof memoryCastContextSchema>;

export const memoryCastContext = (register: CastRegister): MemoryCastContext =>
  register.entries.map((entry) => {
    const anchor = effectiveCastAnchor(entry);
    return {
      anchor: { name: anchor.name, gender: anchor.gender, ...setAnchorFields(anchor) },
      ...(entry.continuity === undefined ? {} : { continuity: entry.continuity }),
    };
  });
