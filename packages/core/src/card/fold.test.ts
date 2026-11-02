import { describe, expect, it } from "vitest";
import { EXAMPLE_SEPARATOR } from "../prompt/examples.ts";
import { foldLegacyCard, foldLegacyFields, LEGACY_BLOCKS, type LegacyFields } from "./fold.ts";
import { blankCard } from "./schema.ts";

const none: LegacyFields = {
  personality: "",
  scenario: "",
  exampleDialogue: "",
  systemPrompt: "",
  postHistoryInstructions: "",
};

describe("foldLegacyFields", () => {
  it("names the blocks in fold order", () => {
    expect(LEGACY_BLOCKS).toEqual(["scenario", "personality", "example_dialogue", "instructions"]);
  });

  it("appends every non-empty field as a tagged block in fold order", () => {
    expect(
      foldLegacyFields("A captain.", {
        personality: "Wry.",
        scenario: "A storm.",
        exampleDialogue: "{{char}}: Hold fast.",
        systemPrompt: "Stay terse.",
        postHistoryInstructions: "Never break.",
      }),
    ).toBe(
      "A captain.\n\n<scenario>\nA storm.\n</scenario>\n\n<personality>\nWry.\n</personality>\n\n<example_dialogue>\n{{char}}: Hold fast.\n</example_dialogue>\n\n<instructions>\nStay terse.\n\nNever break.\n</instructions>",
    );
  });

  it("trims each field's edges and keeps its inside byte for byte", () => {
    expect(foldLegacyFields("Desc", { ...none, personality: "  \n Wry,\n\n  dry.  \n" })).toBe(
      "Desc\n\n<personality>\nWry,\n\n  dry.\n</personality>",
    );
  });

  it("fills <instructions> from whichever of the two is non-empty", () => {
    expect(foldLegacyFields("D", { ...none, systemPrompt: " Sys " })).toBe(
      "D\n\n<instructions>\nSys\n</instructions>",
    );
    expect(foldLegacyFields("D", { ...none, postHistoryInstructions: "Post\n" })).toBe(
      "D\n\n<instructions>\nPost\n</instructions>",
    );
  });

  it("drops empty example passages, so a leading <START> leaves no bare separator", () => {
    expect(
      foldLegacyFields("D", {
        ...none,
        exampleDialogue: `${EXAMPLE_SEPARATOR}\n{{char}}: Hello.${EXAMPLE_SEPARATOR}  ${EXAMPLE_SEPARATOR}{{char}}: Bye.`,
      }),
    ).toBe(
      `D\n\n<example_dialogue>\n{{char}}: Hello.${EXAMPLE_SEPARATOR}{{char}}: Bye.\n</example_dialogue>`,
    );
  });

  it("adds nothing for whitespace-only fields and returns the description unchanged", () => {
    expect(foldLegacyFields("Desc  \n", none)).toBe("Desc  \n");
    expect(foldLegacyFields("Desc\n", { ...none, scenario: " \n\t", systemPrompt: "  " })).toBe(
      "Desc\n",
    );
  });

  it("trims the description's end before appending, and starts bare on an empty description", () => {
    expect(foldLegacyFields("  Desc \n\n", { ...none, scenario: "S" })).toBe(
      "  Desc\n\n<scenario>\nS\n</scenario>",
    );
    expect(foldLegacyFields(" \n", { ...none, scenario: "S" })).toBe("<scenario>\nS\n</scenario>");
  });

  it("does not inspect the description, so a block already there is added again", () => {
    const once = foldLegacyFields("D", { ...none, scenario: "S" });
    expect(foldLegacyFields(once, { ...none, scenario: "S" })).toBe(
      "D\n\n<scenario>\nS\n</scenario>\n\n<scenario>\nS\n</scenario>",
    );
  });
});

describe("foldLegacyCard", () => {
  it("folds and drops the five fields, leaving the removed macros in other text as written", () => {
    const folded = foldLegacyCard({
      ...blankCard("Mara"),
      ...none,
      description: "{{char}} {{personality}}",
      scenario: "At sea {{original}}.",
      exampleDialogue: "{{exampleDialogue}}x",
      firstMessage: "Hi {{scenario}}",
      alternateGreetings: ["{{ Personality }}a"],
      creatorNotes: "{{scenario}} stays",
      nickname: "{{original}}",
      characterNote: { prompt: "{{charPrompt}}n", depth: 4, role: "system" },
      lorebook: {
        entries: [
          {
            keys: ["{{scenario}}k"],
            secondaryKeys: ["{{original}}s"],
            content: "{{postHistoryInstructions}}c",
            enabled: true,
            insertionOrder: 0,
            useRegex: false,
          },
        ],
      },
    });
    expect(folded).toEqual({
      name: "Mara",
      tags: [],
      creator: "",
      characterVersion: "",
      description:
        "{{char}} {{personality}}\n\n<scenario>\nAt sea {{original}}.\n</scenario>\n\n<example_dialogue>\n{{exampleDialogue}}x\n</example_dialogue>",
      firstMessage: "Hi {{scenario}}",
      alternateGreetings: ["{{ Personality }}a"],
      creatorNotes: "{{scenario}} stays",
      nickname: "{{original}}",
      characterNote: { prompt: "{{charPrompt}}n", depth: 4, role: "system" },
      lorebook: {
        entries: [
          {
            keys: ["{{scenario}}k"],
            secondaryKeys: ["{{original}}s"],
            content: "{{postHistoryInstructions}}c",
            enabled: true,
            insertionOrder: 0,
            useRegex: false,
          },
        ],
      },
    });
    for (const key of Object.keys(none)) expect(folded).not.toHaveProperty(key);
  });

  it("leaves a card with empty fields as it was, minus the five keys", () => {
    const current = { ...blankCard("Mara"), description: "Plain {{char}}." };
    expect(foldLegacyCard({ ...current, ...none })).toStrictEqual(current);
  });

  it("keeps native text otherwise as typed: SillyTavern aliases are not rewritten", () => {
    const current = {
      ...blankCard("Mara"),
      description: "A <BOT> sign and {{group}} {{scenario}}.",
      firstMessage: "<USER>",
    };
    expect(foldLegacyCard({ ...current, ...none })).toStrictEqual(current);
  });
});
