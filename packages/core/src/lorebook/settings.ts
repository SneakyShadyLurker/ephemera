import { z } from "zod";
import { CARD_LIMITS } from "../card/limits.ts";
import type { LorebookEntry } from "../card/schema.ts";
import { MAX_CHAT_TURNS } from "../chat-limits.ts";
import { PRESET_LIMITS, promptRoleSchema } from "../preset/prompt.ts";
import { LOREBOOK_RULES } from "./rules.ts";

export const ENTRY_PLACEMENTS = [
  "before",
  "after",
  "anTop",
  "anBottom",
  "depth",
  "examplesTop",
  "examplesBottom",
] as const;
export type EntryPlacement = (typeof ENTRY_PLACEMENTS)[number];
/** The secondary-key logics, in their menu order. */
export const ENTRY_LOGICS = ["andAny", "andAll", "notAny", "notAll"] as const;
export type EntryLogic = (typeof ENTRY_LOGICS)[number];
const bounded = (max: number) => z.number().int().min(0).max(max);

/** Sparse saved settings. Effective defaults and derived values belong to entrySettings. */
export const entrySettingsPatchSchema = z
  .strictObject({
    placement: z.enum(ENTRY_PLACEMENTS),
    depth: bounded(PRESET_LIMITS.maxDepth),
    role: promptRoleSchema,
    logic: z.enum(ENTRY_LOGICS),
    secondaryKeys: z.array(z.string().max(CARD_LIMITS.shortTextLength)).max(CARD_LIMITS.tags),
    excludeRecursion: z.boolean(),
    preventRecursion: z.boolean(),
    recursiveOnly: z.boolean(),
    scanDepth: bounded(LOREBOOK_RULES.maxScanDepth).nullable(),
    caseSensitive: z.boolean().nullable(),
    wholeWords: z.boolean().nullable(),
    sticky: bounded(MAX_CHAT_TURNS),
    cooldown: bounded(MAX_CHAT_TURNS),
    delay: bounded(MAX_CHAT_TURNS),
    useProbability: z.boolean(),
    probability: bounded(100).nullable(),
    poolNames: z.array(z.string()).max(LOREBOOK_RULES.poolNamesKept),
    poolWeight: z
      .number()
      .int()
      .min(LOREBOOK_RULES.poolWeight.min)
      .max(LOREBOOK_RULES.poolWeight.max),
    poolPrioritized: z.boolean(),
  })
  .partial();
export const entrySettingsSchema = entrySettingsPatchSchema.omit({ secondaryKeys: true });
export type EntrySettingsPatch = z.infer<typeof entrySettingsPatchSchema>;
export type EntrySettings = {
  [K in keyof EntrySettingsPatch]-?: Exclude<EntrySettingsPatch[K], undefined>;
} & {
  effectiveCaseSensitive: boolean;
  effectiveWholeWords: boolean;
  chance: number | null;
  pools: string[];
};

/** Distinct, nonempty pool names, with bounded work and retained capacity. */
export function splitPoolNames(text: string): string[] {
  const names = new Set<string>();
  for (let start = 0; start <= text.length && names.size < LOREBOOK_RULES.poolNamesKept; ) {
    const comma = text.indexOf(",", start);
    const end = comma === -1 ? text.length : comma;
    const name = text.slice(start, end).trim();
    if (name !== "") names.add(name);
    start = end + 1;
  }
  return [...names];
}

/** Native runtime interpretation; never decodes foreign settings. */
export function entrySettings(entry: LorebookEntry): EntrySettings {
  const s = entry.settings ?? {};
  const probability = s.probability ?? null;
  const useProbability = s.useProbability ?? false;
  const poolNames = s.poolNames ?? [];
  return {
    placement: s.placement ?? "before",
    depth: s.depth ?? PRESET_LIMITS.defaultDepth,
    role: s.role ?? "system",
    logic: s.logic ?? "andAny",
    secondaryKeys: entry.secondaryKeys ?? [],
    excludeRecursion: s.excludeRecursion ?? false,
    preventRecursion: s.preventRecursion ?? false,
    recursiveOnly: s.recursiveOnly ?? false,
    scanDepth: s.scanDepth ?? null,
    caseSensitive: s.caseSensitive ?? null,
    wholeWords: s.wholeWords ?? null,
    effectiveCaseSensitive: s.caseSensitive ?? false,
    effectiveWholeWords: s.wholeWords ?? true,
    sticky: s.sticky ?? 0,
    cooldown: s.cooldown ?? 0,
    delay: s.delay ?? 0,
    probability,
    useProbability,
    chance: useProbability && probability !== null && probability < 100 ? probability : null,
    poolNames,
    pools: poolNames.slice(0, LOREBOOK_RULES.poolsPerEntry),
    poolWeight: s.poolWeight ?? LOREBOOK_RULES.poolWeight.default,
    poolPrioritized: s.poolPrioritized ?? false,
  };
}

export function withEntrySettings(entry: LorebookEntry, patch: EntrySettingsPatch): LorebookEntry {
  const settings = entrySettingsPatchSchema.parse({ ...entry.settings, ...patch });
  const { secondaryKeys, ...saved } = settings;
  return {
    ...entry,
    settings: saved,
    ...(secondaryKeys === undefined ? {} : { secondaryKeys }),
    ...(secondaryKeys?.length ? { selective: true } : {}),
  };
}
