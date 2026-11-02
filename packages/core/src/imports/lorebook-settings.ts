import { finiteNumber, isRecord } from "../card/json.ts";
import { MAX_CHAT_TURNS } from "../chat-limits.ts";
import { LOREBOOK_RULES } from "../lorebook/rules.ts";
import { type EntrySettingsPatch, splitPoolNames } from "../lorebook/settings.ts";
import { PRESET_LIMITS } from "../preset/prompt.ts";

/** Import-only numeric codes and World Info field names. Never used for serialization. */
export const POSITION_CODES = {
  before: 0,
  after: 1,
  anTop: 2,
  anBottom: 3,
  depth: 4,
  examplesTop: 5,
  examplesBottom: 6,
  outlet: 7,
} as const;
export const SILLYTAVERN_ENTRY_KEYS = {
  position: "position",
  depth: "depth",
  role: "role",
  selectiveLogic: "selectiveLogic",
  sticky: "sticky",
  cooldown: "cooldown",
  delay: "delay",
  scanDepth: "scan_depth",
  matchWholeWords: "match_whole_words",
  caseSensitive: "case_sensitive",
  excludeRecursion: "exclude_recursion",
  preventRecursion: "prevent_recursion",
  delayUntilRecursion: "delay_until_recursion",
  group: "group",
  groupOverride: "group_override",
  groupWeight: "group_weight",
  useGroupScoring: "use_group_scoring",
  probability: "probability",
  useProbability: "useProbability",
  automationId: "automation_id",
  vectorized: "vectorized",
  displayIndex: "display_index",
  characterFilter: "character_filter",
  triggers: "triggers",
  outletName: "outlet_name",
} as const;

const fromCode = <T extends string>(table: Record<T, number>, value: unknown): T | undefined => {
  const number = finiteNumber(value);
  return (Object.keys(table) as T[]).find((key) => table[key] === number);
};

/** The shared pure import/upgrade rule for extension settings, preserving sparse data. */
export function convertForeignEntrySettings(entry: Record<string, unknown>): {
  settings: EntrySettingsPatch;
  outlet: boolean;
} {
  const ext = isRecord(entry.extensions) ? entry.extensions : {};
  const settings: EntrySettingsPatch = {};
  const placement = fromCode(POSITION_CODES, ext.position);
  if (placement !== undefined && placement !== "outlet") settings.placement = placement;
  else if (entry.position === "after_char") settings.placement = "after";
  else if (entry.position === "before_char") settings.placement = "before";
  const role = fromCode({ system: 0, user: 1, assistant: 2 }, ext.role);
  if (role !== undefined) settings.role = role;
  const logic = fromCode({ andAny: 0, notAll: 1, notAny: 2, andAll: 3 }, ext.selectiveLogic);
  if (logic !== undefined) settings.logic = logic;
  if (Array.isArray(entry.secondary_keys))
    settings.secondaryKeys = entry.secondary_keys.filter((k): k is string => typeof k === "string");
  const number = (
    key: string,
    target: "depth" | "scanDepth" | "sticky" | "cooldown" | "delay" | "probability" | "poolWeight",
    max: number,
    min = 0,
  ) => {
    const value = finiteNumber(ext[key]);
    if (value !== undefined) settings[target] = Math.min(max, Math.max(min, Math.trunc(value)));
  };
  number("depth", "depth", PRESET_LIMITS.maxDepth);
  number("scan_depth", "scanDepth", LOREBOOK_RULES.maxScanDepth);
  number("sticky", "sticky", MAX_CHAT_TURNS);
  number("cooldown", "cooldown", MAX_CHAT_TURNS);
  number("delay", "delay", MAX_CHAT_TURNS);
  number("probability", "probability", 100);
  number(
    "group_weight",
    "poolWeight",
    LOREBOOK_RULES.poolWeight.max,
    LOREBOOK_RULES.poolWeight.min,
  );
  for (const [key, target] of [
    ["exclude_recursion", "excludeRecursion"],
    ["prevent_recursion", "preventRecursion"],
    ["match_whole_words", "wholeWords"],
    ["useProbability", "useProbability"],
    ["group_override", "poolPrioritized"],
  ] as const)
    if (typeof ext[key] === "boolean") settings[target] = ext[key];
  if (typeof ext.case_sensitive === "boolean") settings.caseSensitive = ext.case_sensitive;
  else if (typeof entry.case_sensitive === "boolean") settings.caseSensitive = entry.case_sensitive;
  const level = ext.delay_until_recursion === true ? 1 : finiteNumber(ext.delay_until_recursion);
  if (level !== undefined) settings.recursiveOnly = level >= 1;
  else if (ext.delay_until_recursion === false) settings.recursiveOnly = false;
  if (typeof ext.group === "string") settings.poolNames = splitPoolNames(ext.group);
  return { settings, outlet: placement === "outlet" };
}
