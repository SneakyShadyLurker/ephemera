import { describe, expect, it } from "vitest";
import { legacyBlocks } from "./legacy-blocks.ts";

describe("legacyBlocks", () => {
  it("finds none in prose or a description without legacy blocks", () => {
    expect(legacyBlocks("")).toEqual([]);
    expect(legacyBlocks("A captain of the Gull.")).toEqual([]);
    expect(legacyBlocks("<Roleplay>\nr\n</Roleplay>\n\n<Setting>\ns\n</Setting>")).toEqual([]);
  });

  it("ignores a legacy tag nested in another complete block", () => {
    expect(legacyBlocks("<mara_voss><personality>x</personality></mara_voss>")).toEqual([]);
  });

  it("finds an appended block after prose", () => {
    expect(legacyBlocks("prose\n\n<scenario>\ns\n</scenario>")).toEqual(["scenario"]);
  });

  it("treats an unclosed opening tag as enclosing nothing", () => {
    expect(legacyBlocks("Notes <unclosed>\n\n<scenario>\ns\n</scenario>")).toEqual(["scenario"]);
    expect(
      legacyBlocks("<personality> never closed\n\n<instructions>\ni\n</instructions>"),
    ).toEqual(["instructions"]);
  });

  it("lists every top-level block in description order, repeats included", () => {
    expect(
      legacyBlocks(
        "D\n\n<instructions>\ni\n</instructions>\n\n<scenario>\ns\n</scenario>\n\n<example_dialogue>\ne\n</example_dialogue>\n\n<scenario>\nt\n</scenario>",
      ),
    ).toEqual(["instructions", "scenario", "example_dialogue", "scenario"]);
  });

  it("counts only the exact lowercase tag names", () => {
    expect(legacyBlocks("<Scenario>\ns\n</Scenario>\n\n<PERSONALITY>p</PERSONALITY>")).toEqual([]);
  });
});
