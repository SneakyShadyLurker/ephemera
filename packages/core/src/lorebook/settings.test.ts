import { describe, expect, it } from "vitest";
import { convertForeignEntrySettings, POSITION_CODES } from "../imports/lorebook-settings.ts";
import { LOREBOOK_RULES, newEntry } from "./rules.ts";
import {
  entrySettings,
  entrySettingsPatchSchema,
  splitPoolNames,
  withEntrySettings,
} from "./settings.ts";

describe("native entry settings", () => {
  it("owns effective defaults without inflating saved entries", () => {
    const entry = newEntry([]);
    expect(entry).not.toHaveProperty("settings");
    expect(entrySettings(entry)).toMatchObject({
      placement: "before",
      depth: 4,
      role: "system",
      logic: "andAny",
      chance: null,
      effectiveCaseSensitive: false,
      effectiveWholeWords: true,
      pools: [],
      poolWeight: 100,
    });
  });
  it("writes only typed native data, preserving unrelated fields and input", () => {
    const entry = newEntry([]);
    const patched = withEntrySettings(entry, {
      placement: "depth",
      role: "user",
      sticky: 3,
      probability: 30,
      useProbability: true,
      secondaryKeys: ["moon"],
      poolNames: ["Night"],
    });
    expect(patched.settings).toEqual({
      placement: "depth",
      role: "user",
      sticky: 3,
      probability: 30,
      useProbability: true,
      poolNames: ["Night"],
    });
    expect(patched.secondaryKeys).toEqual(["moon"]);
    expect(patched.selective).toBe(true);
    expect(entrySettings(patched)).toMatchObject({ chance: 30, pools: ["Night"] });
    expect(entry).not.toHaveProperty("settings");
    expect(patched).not.toHaveProperty("extensions");
  });
  it("keeps dormant chance data and resolves null defaults", () => {
    const entry = withEntrySettings(newEntry([]), {
      probability: 30,
      useProbability: false,
      wholeWords: null,
      caseSensitive: null,
    });
    expect(entrySettings(entry)).toMatchObject({
      chance: null,
      probability: 30,
      effectiveWholeWords: true,
      effectiveCaseSensitive: false,
    });
    expect(entrySettings(withEntrySettings(entry, { useProbability: true })).chance).toBe(30);
  });
  it("rejects numeric foreign settings at native writes", () => {
    expect(entrySettingsPatchSchema.safeParse({ placement: 4 }).success).toBe(false);
    expect(entrySettingsPatchSchema.safeParse({ selectiveLogic: 3 }).success).toBe(false);
    expect(entrySettingsPatchSchema.safeParse({ sticky: -1 }).success).toBe(false);
  });
  it("bounds distinct pool names and activation pool count", () => {
    expect(splitPoolNames(" Weather ,, weather,Weather , Night ")).toEqual([
      "Weather",
      "weather",
      "Night",
    ]);
    const names = splitPoolNames(Array.from({ length: 200_000 }, (_, i) => `n${i}`).join(","));
    expect(names).toHaveLength(LOREBOOK_RULES.poolNamesKept);
    expect(entrySettings(withEntrySettings(newEntry([]), { poolNames: names })).pools).toHaveLength(
      LOREBOOK_RULES.poolsPerEntry,
    );
  });
});
describe("shared foreign settings conversion", () => {
  it.each(Object.entries(POSITION_CODES))("converts position %s once", (placement, code) => {
    const result = convertForeignEntrySettings({ extensions: { position: String(code) } });
    expect(result.outlet).toBe(placement === "outlet");
    if (placement !== "outlet") expect(result.settings.placement).toBe(placement);
  });
  it("converts numeric strings, bounds, old flags and top-level fallback", () => {
    const result = convertForeignEntrySettings({
      position: "after_char",
      case_sensitive: true,
      secondary_keys: ["moon"],
      extensions: {
        depth: "7",
        role: "2",
        selectiveLogic: "3",
        scan_depth: "5",
        probability: "25",
        useProbability: true,
        group: "Night,Night,Weather",
        group_weight: "30",
        sticky: 1e9,
        delay_until_recursion: true,
        case_sensitive: null,
      },
    });
    expect(result.settings).toMatchObject({
      placement: "after",
      caseSensitive: true,
      secondaryKeys: ["moon"],
      depth: 7,
      role: "assistant",
      logic: "andAll",
      scanDepth: 5,
      probability: 25,
      useProbability: true,
      poolNames: ["Night", "Weather"],
      poolWeight: 30,
      recursiveOnly: true,
    });
    expect(result.settings.sticky).toBeGreaterThan(0);
    expect(
      convertForeignEntrySettings({ extensions: { position: "bogus", depth: "deep" } }).settings,
    ).toEqual({});
  });
});
