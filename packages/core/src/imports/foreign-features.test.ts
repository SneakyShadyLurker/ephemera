import { describe, expect, it } from "vitest";
import type { JsonObject } from "../card/json.ts";

type Lorebook = Record<string, unknown>;
type LorebookEntry = Record<string, unknown>;

import {
  type IgnoredFeature,
  ignoredEntryFeatures,
  ignoredFeatureList,
} from "./foreign-features.ts";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: ["tide"],
  content: "The tide turns.",
  extensions: {},
  enabled: true,
  insertion_order: 100,
  use_regex: false,
  ...overrides,
});

/** The features reported for one entry. */
const featuresOf = (overrides: Partial<LorebookEntry>): IgnoredFeature[] =>
  ignoredEntryFeatures(entry(overrides));
const withExtensions = (extensions: JsonObject) => featuresOf({ extensions });

/** SillyTavern's full extension set at its defaults, as its exports write it. */
const SILLYTAVERN_DEFAULTS: JsonObject = {
  position: 0,
  depth: 4,
  role: 0,
  selectiveLogic: 0,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  scan_depth: null,
  match_whole_words: null,
  case_sensitive: null,
  exclude_recursion: false,
  prevent_recursion: false,
  delay_until_recursion: false,
  group: "",
  group_override: false,
  group_weight: 100,
  use_group_scoring: false,
  probability: 100,
  useProbability: true,
  automation_id: "",
  vectorized: false,
  display_index: 0,
  character_filter: { isExclude: false, names: [], tags: [] },
  triggers: [],
  outlet_name: "",
};

describe("ignored lorebook features", () => {
  it("reports nothing for a plain book or SillyTavern's defaults", () => {
    const book: Lorebook = {
      recursive_scanning: true,
      extensions: { ephemera: { x: 1 } },
      entries: [
        entry({ secondary_keys: ["moon"], selective: true }),
        entry({ extensions: { ...SILLYTAVERN_DEFAULTS, ephemera: {} } }),
      ],
    };
    expect(ignoredFeatureList(book)).toEqual([]);
  });

  it("reports settings from other apps on the book", () => {
    const book: Lorebook = { extensions: { world: "x" }, entries: [] };
    expect(ignoredFeatureList(book)).toEqual(["bookExtensions"]);
  });

  it("lists each feature the book or any entry uses once, in the features' order", () => {
    const book: Lorebook = {
      extensions: { world: "x" },
      entries: [
        entry({ content: "@@dont_activate" }),
        entry(),
        entry({ priority: 0, content: "@@dont_activate" }),
      ],
    };
    expect(ignoredFeatureList(book)).toEqual(["priority", "bookExtensions", "decorators"]);
    expect(ignoredFeatureList(undefined)).toEqual([]);
  });

  it("reports no trigger chance, which activation acts on", () => {
    expect(withExtensions({ useProbability: true, probability: 50 })).toEqual([]);
    expect(withExtensions({ useProbability: true, probability: 0 })).toEqual([]);
  });

  it("reports no event pool, which activation acts on, and group scoring only when on", () => {
    expect(withExtensions({ group: "weather", group_override: true, group_weight: 5 })).toEqual([]);
    expect(withExtensions({ group: "weather", use_group_scoring: true })).toEqual(["groupScoring"]);
    expect(withExtensions({ use_group_scoring: false })).toEqual([]);
  });

  it("reports an automation id only when it is set", () => {
    expect(withExtensions({ automation_id: "a1" })).toEqual(["automation"]);
    expect(withExtensions({ automation_id: "" })).toEqual([]);
  });

  it("reports vectorized only when true", () => {
    expect(withExtensions({ vectorized: true })).toEqual(["vectorized"]);
    expect(withExtensions({ vectorized: false })).toEqual([]);
  });

  it("reports a character filter only when it names characters or tags", () => {
    expect(withExtensions({ character_filter: { names: ["Maren"], tags: [] } })).toEqual([
      "characterFilter",
    ]);
    expect(withExtensions({ character_filter: { names: [], tags: ["sea"] } })).toEqual([
      "characterFilter",
    ]);
    expect(withExtensions({ character_filter: { isExclude: true, names: [], tags: [] } })).toEqual(
      [],
    );
  });

  it("reports triggers only when there are some", () => {
    expect(withExtensions({ triggers: ["normal"] })).toEqual(["triggers"]);
    expect(withExtensions({ triggers: [] })).toEqual([]);
  });

  it("reports a delay until recursion level only above 1", () => {
    expect(withExtensions({ delay_until_recursion: 2 })).toEqual(["recursionLevel"]);
    expect(withExtensions({ delay_until_recursion: true })).toEqual([]);
    expect(withExtensions({ delay_until_recursion: 1 })).toEqual([]);
  });

  it("reports no position that is sent", () => {
    for (const position of [0, 1, 2, 3, 4, 5, 6]) expect(withExtensions({ position })).toEqual([]);
  });

  it("reports an outlet position", () => {
    expect(withExtensions({ position: 7, outlet_name: "Harbour" })).toEqual(["outlet"]);
  });

  it("reports keys outside SillyTavern's set, camelCase aliases included", () => {
    expect(withExtensions({ addMemo: true })).toEqual(["otherExtensions"]);
    expect(withExtensions({ characterFilter: null })).toEqual(["otherExtensions"]);
    expect(withExtensions({ ephemera: { x: 1 }, display_index: 3 })).toEqual([]);
  });
});
