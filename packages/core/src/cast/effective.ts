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

/** The anchor as the player knows it, never a fallback to hidden canon. */
export const discoveredCastAnchor = (
  entry: Pick<CastEntry, "anchor" | "discovered">,
  correction: Partial<CastAnchor> = {},
): CastAnchor => {
  const anchor = { ...entry.anchor };
  for (const field of CAST_ANCHOR_FIELDS) anchor[field] = entry.discovered?.[field]?.value ?? "";
  return { ...anchor, ...correction };
};

/** A panel entry: public discoveries and corrections, with canonical overrides left out. */
export const discoveredCastEntry = (
  entry: CastEntry,
  correction: Partial<CastAnchor> = {},
): CastEntry => {
  const { developments: _developments, continuity: _continuity, ...rest } = entry;
  return { ...rest, anchor: discoveredCastAnchor(entry, correction) };
};

/** Identity recovery must never borrow knowledge or developments from a future scene. */
export const castIdentity = ({
  developments: _developments,
  continuity: _continuity,
  introduced: _introduced,
  discovered: _discovered,
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
      Object.entries(changes.cast).map(([name, change]) => {
        const { introduce: candidate, ...rest } = change;
        const introduce =
          candidate !== undefined && shown.some((text) => text.includes(candidate.evidence))
            ? { introduce: candidate }
            : {};
        return [
          name,
          {
            ...rest,
            ...introduce,
            ...(change.developments === undefined
              ? {}
              : { developments: grounded(change.developments) }),
            ...(change.continuity === undefined ? {} : { continuity: grounded(change.continuity) }),
            ...(change.discovered === undefined ? {} : { discovered: grounded(change.discovered) }),
          },
        ];
      }),
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
