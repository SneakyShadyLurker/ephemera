import { castKey } from "../cast/key.ts";
import { CAST_LIMITS } from "../cast/limits.ts";
import {
  CAST_ANCHOR_FIELDS,
  type CastSheetEntry,
  emptyCastAnchor,
  type RememberedCastAnchor,
  rememberedCastAnchorSchema,
  setAnchorFields,
} from "../cast/register.ts";
import { cutText } from "./clamp.ts";
import { fillUserPlaceholder } from "./prompt.ts";

/** Invalid owner lines remain editable, but lend no identity to a chat. */
export function readMemoryCastLine(line: string): RememberedCastAnchor | null {
  try {
    const parsed = rememberedCastAnchorSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Chat-local ids, minor roles and empty missing fields; admission belongs to `withSheet`. */
export function memoryCastEntries(
  lines: readonly string[],
  newId: (name: string) => string,
): CastSheetEntry[] {
  const seen = new Set<string>();
  return lines.flatMap((line) => {
    const anchor = readMemoryCastLine(line);
    if (anchor === null || seen.has(castKey(anchor.name))) return [];
    seen.add(castKey(anchor.name));
    return [
      {
        id: newId(anchor.name),
        role: "minor" as const,
        aka: [],
        anchor: { ...emptyCastAnchor(anchor.name, anchor.gender), ...setAnchorFields(anchor) },
      },
    ];
  });
}

/** Fill only memory's persona placeholder after parsing, preserving the notebook and chat ids. */
export function fillMemoryCastEntries(
  entries: readonly CastSheetEntry[],
  user: string,
): CastSheetEntry[] {
  return entries.map((entry) => {
    const anchor = {
      ...entry.anchor,
      name: cutText(fillUserPlaceholder(entry.anchor.name, user), CAST_LIMITS.name),
    };
    for (const field of CAST_ANCHOR_FIELDS)
      anchor[field] = cutText(fillUserPlaceholder(anchor[field], user), CAST_LIMITS.field);
    return { ...entry, anchor };
  });
}
