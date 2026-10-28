import { blankCard } from "../../packages/core/src/card/schema.ts";
import { applyCastChanges } from "../../packages/core/src/cast/apply.ts";
import { emptyCastAnchor, emptyCastState } from "../../packages/core/src/cast/register.ts";
import { defaultPromptPreset, type PromptPreset } from "../../packages/core/src/preset/prompt.ts";
import type { AssemblyInput } from "../../packages/core/src/prompt/assemble.ts";

export const CONCISE_NOTE =
  "[Author's note: Preserve player agency. Keep each NPC's psychology, voice, knowledge and current state consistent with canon and established events, including earned relationships and lasting consequences. Show only perceivable details. Give NPCs initiative and advance the scene without writing {{user}}'s actions or choices.]";
export type Variant = "current" | "concise";
export type Layout = "current-layout" | "tail-layout";
export const FIXTURE_IDS = ["callback", "developments", "hidden-code", "agency-injury"] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];

/** Machine result v1: these fixed check IDs are bounded lexical heuristics, not immersion proof. */
export const CHECK_IDS = {
  callback: ["nickname", "departure"],
  developments: ["spouse", "short-hair"],
  "hidden-code": ["code-withheld"],
  "agency-injury": ["injury", "no-player-speech-cue"],
} as const;

export function score(id: FixtureId, text: string): Record<string, boolean> {
  switch (id) {
    case "callback":
      return {
        nickname: /\brook\b/i.test(text),
        departure:
          /\b(?:nine(?:[ -]o['’]?clock)?|21(?::00|[ .]00)?|9\s*(?::00\s*)?p\.?m\.?)\b/i.test(text),
      };
    case "developments":
      return {
        spouse: /\bilse\b/i.test(text) && !/\b(?:unmarried|single)\b/i.test(text),
        "short-hair":
          /\b(?:short(?:[- ](?:cropped|cut))?|cropped|pixie|bob|buzz(?:ed|cut)?)\b/i.test(text) &&
          !/\blong[- ]hair\b/i.test(text),
      };
    case "hidden-code":
      // This checks disclosure of one exact synthetic code only, not all epistemic behavior.
      return { "code-withheld": !/7[\s-]*4[\s-]*2[\s-]*9[\s-]*1[\s-]*3/.test(text) };
    case "agency-injury":
      return {
        injury:
          /\b(?:ankle|sprain(?:ed)?|limp(?:ing|ed)?|injur(?:y|ed)|wound(?:ed)?|bandag\w*)\b/i.test(
            text,
          ),
        "no-player-speech-cue":
          !/(?:\b(?:Aria|you)\s+(?:(?:quietly|softly|finally)\s+)?(?:say|says|said|ask|asks|asked|reply|replies|replied|whisper\w*|murmur\w*|shout\w*|answer\w*)\b|(?:^|\n)\s*(?:Aria|you)\s*:)/i.test(
            text,
          ),
      };
  }
}

export function comparisonPreset(
  variant: Variant,
  layout: Layout = "current-layout",
): PromptPreset {
  const preset = defaultPromptPreset();
  if (variant === "concise") preset.authorsNote = { ...preset.authorsNote, text: CONCISE_NOTE };
  if (layout === "tail-layout") {
    // Experiment only: moving this authored source changes placement semantics.
    const lore = preset.blocks.find((block) => block.id === "lorebookBefore");
    preset.blocks = preset.blocks.filter((block) => block.id !== "lorebookBefore");
    if (lore !== undefined) {
      const history = preset.blocks.findIndex((block) => block.kind === "chatHistory");
      preset.blocks.splice(history, 0, lore);
    }
  }
  return preset;
}

export function fixture(id: FixtureId, variant: Variant): AssemblyInput {
  const input: AssemblyInput = {
    preset: comparisonPreset(variant),
    character: {
      ...blankCard("Mara"),
      description: "Mara is an adult ferry clerk with long brown hair. She is single.",
      personality: "Dry humor, concise speech, observant and patient.",
      scenario: "Aria and Mara are at the ferry office. The scene clock reads exactly 19:00 today.",
      exampleDialogue: "{{user}}: Is the office open?\n{{char}}: Until the bell decides otherwise.",
    },
    persona: { name: "Aria", description: "Aria is an adult traveler." },
    history: [],
    clock: { now: Date.UTC(2026, 9, 26, 19), timeZone: "UTC" },
    pickSeed: 0,
    random: () => 0.5,
  };
  switch (id) {
    case "callback":
      input.history = [
        { role: "user", content: "Call me Rook. My ferry departs tonight at 21:00." },
        {
          role: "assistant",
          content: '"Rook it is. The ferry departs at 21:00 tonight." Mara checks the board.',
        },
        {
          role: "user",
          content:
            "The office clock reads 19:00 now. What nickname did I ask you to use, and what time does my ferry depart?",
        },
      ];
      break;
    case "developments": {
      const evidence = "Mara married Ilse last month and cut her hair short yesterday.";
      input.cast = applyCastChanges(
        {
          entries: [
            {
              id: "94f3d513-f7ac-4e14-9ab0-6d553265f69e",
              role: "principal",
              aka: [],
              anchor: {
                ...emptyCastAnchor("Mara", "female"),
                hair: "long brown hair",
                relationship: "single",
              },
              state: emptyCastState(true),
            },
          ],
        },
        {
          cast: {
            Mara: {
              developments: {
                hair: { value: "short brown hair", evidence },
                relationship: { value: "married to Ilse", evidence },
              },
              continuity: {
                voice: {
                  value: "Dry concise speech; calls Aria traveler.",
                  evidence: "Mara calls Aria traveler in dry, concise speech.",
                },
                goals: {
                  value: "Finish her shift and meet Ilse.",
                  evidence: "Mara wants to finish her shift and meet Ilse.",
                },
                knowledge: {
                  value: "Knows the ferry timetable, not Aria's private history.",
                  evidence: "Mara knows the ferry timetable, not Aria's private history.",
                },
              },
            },
          },
          absent: [],
        },
        {
          player: "Aria",
          newId: () => "94f3d513-f7ac-4e14-9ab0-6d553265f69e",
          shown: [
            evidence,
            "Mara calls Aria traveler in dry, concise speech.",
            "Mara wants to finish her shift and meet Ilse.",
            "Mara knows the ferry timetable, not Aria's private history.",
          ],
        },
      );
      input.history = [
        { role: "user", content: "Mara, who is your spouse, and how do you wear your hair now?" },
      ];
      break;
    }
    case "hidden-code":
      input.persona = {
        name: "Aria",
        description:
          "Aria privately memorized vault code 742913. She never told Mara, who never saw or learned it.",
      };
      input.history = [
        {
          role: "assistant",
          content:
            'Mara taps the public timetable. "I know the ferry schedule. You have not told me anything about a vault."',
        },
        {
          role: "user",
          content:
            "What do you actually know about my vault access code? Answer as Mara, using only what you have learned.",
        },
      ];
      break;
    case "agency-injury":
      input.cast = {
        entries: [
          {
            id: "94f3d513-f7ac-4e14-9ab0-6d553265f69e",
            role: "principal",
            aka: [],
            anchor: emptyCastAnchor("Mara", "female"),
            state: {
              ...emptyCastState(true),
              injuries: "sprained left ankle, bandaged",
              position: "seated behind the ferry counter",
              activity: "keeping weight off her injured ankle",
            },
          },
        ],
      };
      input.history = [
        {
          role: "assistant",
          content:
            "Mara sits behind the counter, keeping her bandaged, sprained left ankle off the floor. Aria stands nearby in silence.",
        },
        {
          role: "user",
          content:
            "I remain silent. Continue the scene from Mara's current position and condition.",
        },
      ];
      break;
  }
  return input;
}

/** Both layouts use the concise note and the same selected lore for each request. */
export function loreFixture(layout: Layout, place: "Harbor" | "Market"): AssemblyInput {
  const input = fixture("callback", "concise");
  input.preset = comparisonPreset("concise", layout);
  if (input.character !== null)
    input.character.lorebook = {
      scanDepth: 1,
      tokenBudget: 4096,
      recursiveScanning: false,
      entries: ["Harbor", "Market"].map((name) => ({
        keys: [name],
        content: `${name}: the public notice board lists the ferry schedule and local meeting points.`,
        enabled: true,
        insertionOrder: 100,
        useRegex: false,
        settings: { placement: "before" },
      })),
    };
  input.history = [
    {
      role: "user",
      content: `We are at the ${place}. Describe what Mara notices on the public board.`,
    },
  ];
  input.lorebook = { window: 32768, count: (text) => text.length };
  return input;
}
