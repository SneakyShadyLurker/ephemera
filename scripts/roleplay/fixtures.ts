import { foldLegacyFields } from "../../packages/core/src/card/fold.ts";
import { blankCard } from "../../packages/core/src/card/schema.ts";
import { applyCastChanges } from "../../packages/core/src/cast/apply.ts";
import {
  type CastAnchor,
  type CastEntry,
  type CastRegister,
  type CastState,
  emptyCastAnchor,
  emptyCastState,
} from "../../packages/core/src/cast/register.ts";
import { defaultPromptPreset, type PromptPreset } from "../../packages/core/src/preset/prompt.ts";
import type { AssemblyInput } from "../../packages/core/src/prompt/assemble.ts";

export const CONCISE_NOTE =
  "[Author's note: Preserve player agency. Keep each NPC's psychology, voice, knowledge and current state consistent with canon and established events, including earned relationships and lasting consequences. Show only perceivable details. Give NPCs initiative and advance the scene without writing {{user}}'s actions or choices.]";
export type Variant = "current" | "concise";
export type Layout = "current-layout" | "tail-layout";
export const FIXTURE_IDS = [
  "callback",
  "developments",
  "hidden-code",
  "agency-injury",
  "cast-recall",
] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];

/** Machine result v1: these fixed check IDs are bounded lexical heuristics, not immersion proof. */
export const CHECK_IDS = {
  callback: ["nickname", "departure"],
  developments: ["spouse", "short-hair"],
  "hidden-code": ["code-withheld"],
  "agency-injury": ["injury", "no-player-speech-cue"],
  "cast-recall": ["away-principal", "present-minor"],
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
    case "cast-recall":
      // Each colour is written once in the fixture, in the register alone.
      return {
        "away-principal": /\bamber\b/i.test(text),
        "present-minor": /\bhazel\b/i.test(text) && /\bgreen\b/i.test(text),
      };
  }
}

/** A register entry of the recall fixture: a fixed id by position, the anchor and state given. */
function person(
  at: number,
  name: string,
  gender: CastAnchor["gender"],
  role: CastEntry["role"],
  anchor: Partial<CastAnchor>,
  state: Partial<CastState> | null,
): CastEntry {
  return {
    id: `94f3d513-f7ac-4e14-9ab0-${String(at).padStart(12, "0")}`,
    role,
    aka: [],
    anchor: { ...emptyCastAnchor(name, gender), ...anchor },
    introduced: true,
    state: { ...emptyCastState(state !== null), ...state },
  };
}

/**
 * Six people at the ferry office: two principals (one away) and four minors
 * (two away), every anchor filled. The eye colours asked for are written
 * nowhere else in the fixture.
 */
const recallCast = (): CastRegister => ({
  entries: [
    person(
      1,
      "Mara",
      "female",
      "principal",
      {
        age: "32",
        ethnicity: "Swedish",
        skin: "fair skin with light freckles",
        face: "oval face, straight nose, full lips",
        relationship: "single",
        height: "168cm",
        weight: "60kg",
        build: "slim, narrow-shouldered build",
        hair: "long brown hair in a low ponytail",
        eyes: "dark blue round eyes",
        personality: "dry humor, concise, observant, patient",
      },
      {
        outfit: "navy uniform jacket over a white shirt, black trousers, black lace-up shoes",
        position: "behind the ferry counter",
        activity: "stamping tickets",
        mood: "calm",
      },
    ),
    person(
      2,
      "Ilse Brandt",
      "female",
      "principal",
      {
        age: "41",
        ethnicity: "Dutch",
        skin: "pale skin, freckled across the nose",
        face: "heart-shaped face, small upturned nose, thin lips",
        relationship: "widowed",
        height: "172cm",
        weight: "61kg",
        build: "lean, wiry build",
        hair: "copper-red braid down to her waist",
        eyes: "amber almond-shaped eyes",
        personality: "blunt, loyal, quick to laugh",
      },
      null,
    ),
    person(
      3,
      "Tobin Hale",
      "male",
      "minor",
      {
        age: "26",
        ethnicity: "Welsh",
        skin: "tanned, weathered skin",
        face: "square face, crooked nose, wide mouth",
        relationship: "engaged",
        height: "185cm",
        weight: "90kg",
        build: "broad, heavy-shouldered build",
        hair: "cropped black hair",
        eyes: "one green eye and one hazel eye",
        personality: "quiet, steady, shy with strangers",
      },
      {
        outfit: "orange safety vest over a charcoal hoodie, canvas work trousers, steel-toed boots",
        position: "by the door",
        activity: "stacking crates",
      },
    ),
    person(
      4,
      "Greta Holm",
      "female",
      "minor",
      {
        age: "55",
        ethnicity: "German",
        skin: "ruddy, lined skin",
        face: "round face, broad nose, thin lips",
        relationship: "married",
        height: "160cm",
        weight: "72kg",
        build: "short, sturdy build",
        hair: "silver bob with a blunt fringe",
        eyes: "dark brown round eyes",
        personality: "brisk, exacting, kind underneath",
      },
      { position: "at the boarding gate", activity: "checking the passenger list" },
    ),
    person(
      5,
      "Pavel Novak",
      "male",
      "minor",
      {
        age: "63",
        ethnicity: "Czech",
        skin: "sun-browned, creased skin",
        face: "long face, hooked nose, thin lips",
        relationship: "divorced",
        height: "178cm",
        weight: "84kg",
        build: "stocky, barrel-chested build",
        hair: "white-blond crew cut",
        eyes: "pale blue deep-set eyes",
        personality: "gruff, superstitious, generous",
      },
      null,
    ),
    person(
      6,
      "Jonas Reyes",
      "male",
      "minor",
      {
        age: "34",
        ethnicity: "Mexican-American",
        skin: "warm tan skin",
        face: "square face, broken nose, thin lips",
        relationship: "single",
        height: "183cm",
        weight: "88kg",
        build: "broad, heavy-set build",
        hair: "short black curls",
        eyes: "black hooded eyes",
        personality: "easygoing, talkative, protective",
      },
      null,
    ),
  ],
});

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
      description: foldLegacyFields(
        "Mara is an adult ferry clerk with long brown hair. She is single.",
        {
          personality: "Dry humor, concise speech, observant and patient.",
          scenario:
            "Aria and Mara are at the ferry office. The scene clock reads exactly 19:00 today.",
          exampleDialogue:
            "{{user}}: Is the office open?\n{{char}}: Until the bell decides otherwise.",
          systemPrompt: "",
          postHistoryInstructions: "",
        },
      ),
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
    case "cast-recall":
      input.cast = recallCast();
      input.history = [
        {
          role: "assistant",
          content:
            "Mara stamps a ticket at the ferry counter while Tobin stacks crates by the door and Greta checks the passenger list at the boarding gate.",
        },
        {
          role: "user",
          content:
            "Mara, two things before I board. What colour are Ilse's eyes again? And look at Tobin over there: what is unusual about his eyes?",
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
