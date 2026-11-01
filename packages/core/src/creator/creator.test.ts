import { describe, expect, it } from "vitest";
import greetingOnly from "../../test-fixtures/saved-cards/greeting-only.json" with { type: "json" };
import incompleteAppearance from "../../test-fixtures/saved-cards/incomplete-appearance.json" with {
  type: "json",
};
import mixedTone from "../../test-fixtures/saved-cards/mixed-tone.json" with { type: "json" };
import plainProse from "../../test-fixtures/saved-cards/plain-prose.json" with { type: "json" };
import wplusplus from "../../test-fixtures/saved-cards/wplusplus.json" with { type: "json" };
import { normalizeCard } from "../card/import.ts";
import { textLength } from "../card/limits.ts";
import { sheetFieldsSchema } from "../card/schema.ts";
import {
  ART_FAMILIES,
  ART_LOOK_IDS,
  ART_LOOKS,
  ART_METAPROMPTS,
  artControlEventSchema,
  artMetaprompt,
  artPrompt,
  artSource,
  CARD_SYSTEM_PROMPTS,
  CREATOR_LIMITS,
  type CreatorKind,
  cardPrompt,
  cardRetryPrompt,
  creatorArtCompositionSchema,
  creatorArtRequestSchema,
  creatorCardEventSchema,
  creatorCardRequestSchema,
  creatorImageCardEventSchema,
  formatLocationLine,
  type GeneratedCard,
  imageCardPrompt,
  incompleteForAutomaticKeep,
  parseCardAnswer,
  REWORK_SYSTEM_PROMPT,
  SCENE_METAPROMPTS,
  SUBJECT_DIPTYCH_METAPROMPTS,
  savedCardArtSource,
  savedCardKind,
  toSheetFields,
  validateCardAnswer,
} from "./index.ts";
import {
  CARD_STYLE,
  LOCATION_OPENING,
  OPENING_RESTRAINT,
  SCENARIO_OPENING_SHAPE,
  SUBJECT_OPENING_SHAPE,
} from "./prompts.ts";
import { creatorErrorCodeSchema } from "./schema.ts";

const KINDS = ["subject", "group", "scenario"] as const;

const inner = (background = "Is 30 and lives in Testtown. Works at the mill.") =>
  [
    `<backgroundstory>${background}</backgroundstory>`,
    "<appearance>Tall, placeholder build, grey eyes.</appearance>",
    "<personality>Calm placeholder temperament.</personality>",
    '<vocabulary>Short sentences. "Sample phrase."</vocabulary>',
  ].join("\n");

const subject = (name: string, body = inner()) => `<${name}>\n${body}\n</${name}>`;

const scenarioDescription = (roleplay = "The narrator plays everyone else.") =>
  [
    `<Roleplay>\nA placeholder premise in one line.\n${roleplay}\n</Roleplay>`,
    "<Setting>A placeholder valley town.</Setting>",
    "<People>Millers in flour-white aprons.</People>",
    "<Tone>Quiet placeholder mood.</Tone>",
  ].join("\n");

interface Parts {
  name?: string;
  description?: string;
  firstMessage?: string;
  creatorNotes?: string;
}

function answer(parts: Parts = {}): string {
  const {
    name = "Ada Reed",
    description = subject("ada_reed"),
    firstMessage = "Ada looks up.",
    creatorNotes = "A placeholder pitch.",
  } = parts;
  return [
    `<name>${name}</name>`,
    `<description>\n${description}\n</description>`,
    `<firstMessage>${firstMessage}</firstMessage>`,
    `<creatorNotes>${creatorNotes}</creatorNotes>`,
  ].join("\n");
}

function valid(kind: CreatorKind, text: string): GeneratedCard {
  const result = validateCardAnswer(kind, text);
  if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.problems)}`);
  return result.card;
}

const problems = (kind: CreatorKind, text: string) => {
  const result = validateCardAnswer(kind, text);
  return result.ok ? [] : result.problems;
};

describe("creator requests and events", () => {
  it("accepts only the optional regular/diptych composition and keeps the art boundary strict", () => {
    const base = { kind: "subject", model: "m", source: "Notes" };
    expect(creatorArtCompositionSchema.options).toEqual(["regular", "diptych"]);
    expect(creatorArtRequestSchema.parse(base)).not.toHaveProperty("composition");
    for (const composition of creatorArtCompositionSchema.options) {
      expect(creatorArtRequestSchema.parse({ ...base, composition }).composition).toBe(composition);
    }
    for (const composition of ["panorama", "", null]) {
      expect(creatorArtRequestSchema.safeParse({ ...base, composition }).success).toBe(false);
    }
    expect(creatorArtRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it("refuses an unknown look at the boundary", () => {
    const base = { kind: "subject", model: "m", source: "Notes" };
    expect(creatorArtRequestSchema.safeParse({ ...base, look: "polaroid" }).success).toBe(false);
    expect(creatorArtRequestSchema.parse({ ...base, look: "film" }).look).toBe("film");
    expect(creatorArtRequestSchema.parse(base)).not.toHaveProperty("look");
  });
  it("bounds the description and rejects unknown fields", () => {
    const base = { kind: "subject", description: "A placeholder baker.", model: "m" };
    expect(creatorCardRequestSchema.safeParse(base).success).toBe(true);
    expect(creatorCardRequestSchema.safeParse({ ...base, description: "  " }).success).toBe(false);
    expect(
      creatorCardRequestSchema.safeParse({
        ...base,
        description: "x".repeat(CREATOR_LIMITS.descriptionLength + 1),
      }).success,
    ).toBe(false);
    expect(creatorCardRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("takes an optional direction for the art, trimmed and bounded", () => {
    const base = { kind: "subject", model: "m", source: "<Location>Testtown</Location>" };
    expect(creatorArtRequestSchema.safeParse(base).success).toBe(true);
    expect(creatorArtRequestSchema.parse({ ...base, direction: "  at dusk  " }).direction).toBe(
      "at dusk",
    );
    expect(creatorArtRequestSchema.safeParse({ ...base, direction: " " }).success).toBe(false);
    const longest = "x".repeat(CREATOR_LIMITS.artDirectionLength);
    expect(creatorArtRequestSchema.safeParse({ ...base, direction: longest }).success).toBe(true);
    expect(creatorArtRequestSchema.safeParse({ ...base, direction: `${longest}x` }).success).toBe(
      false,
    );
  });

  it("takes an optional reference to a character by uuid, and nothing else in it", () => {
    const base = { kind: "subject", model: "m", source: "<Location>Testtown</Location>" };
    const characterId = "00000000-0000-4000-8000-000000000004";
    expect(
      creatorArtRequestSchema.parse({ ...base, reference: { characterId } }).reference,
    ).toEqual({ characterId });
    expect(
      creatorArtRequestSchema.safeParse({ ...base, reference: { characterId: "ada" } }).success,
    ).toBe(false);
    expect(
      creatorArtRequestSchema.safeParse({ ...base, reference: { characterId, portrait: true } })
        .success,
    ).toBe(false);
  });

  it("reports a gone character and an unprepared portrait as art errors", () => {
    for (const code of ["not_found", "reference"] as const) {
      expect(creatorErrorCodeSchema.options).toContain(code);
      expect(artControlEventSchema.parse({ type: "error", code })).toEqual({ type: "error", code });
    }
  });

  it("refuses progress past its maximum", () => {
    expect(
      artControlEventSchema.safeParse({ type: "progress", phase: "running", value: 3, max: 2 })
        .success,
    ).toBe(false);
  });

  it("reports a failed validation in the card result event", () => {
    const event = {
      type: "result",
      validation: { ok: false, problems: [{ code: "missing", section: "firstMessage" }] },
      tokens: [],
    };
    expect(creatorCardEventSchema.parse(event)).toEqual(event);
  });

  it("keys every prompt by kind, and every art metaprompt by image model too", () => {
    for (const kind of KINDS) {
      expect(CARD_SYSTEM_PROMPTS[kind]).toContain("Write your answer as these sections");
      expect(ART_METAPROMPTS.krea2[kind]).toContain("the Krea 2 image model");
      expect(ART_METAPROMPTS.krea2[kind]).not.toContain("MOSS");
      expect(ART_METAPROMPTS.moss[kind]).toContain("the MOSS image model");
      expect(ART_METAPROMPTS.moss[kind]).not.toContain("Krea");
    }
  });

  it("words the General family for any image model, in plain natural language", () => {
    const prompts = [
      ...KINDS.map((kind) => ART_METAPROMPTS.general[kind]),
      SUBJECT_DIPTYCH_METAPROMPTS.general,
      ...KINDS.map((kind) => SCENE_METAPROMPTS.general[kind]),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("You write image prompts for the image model.");
      expect(prompt).toMatch(/The image model does not know names/);
      expect(prompt).not.toMatch(/Krea|MOSS|pussy|bare word|\u2014/);
      expect(prompt).not.toContain("the image model image model");
    }
    expect(ART_METAPROMPTS.general.subject).toContain("vertical 2:3 photograph");
    expect(ART_METAPROMPTS.general.subject).toContain("her breasts and vulva are bare");
    expect(SUBJECT_DIPTYCH_METAPROMPTS.general).toContain("hides her buttocks");
    expect(SCENE_METAPROMPTS.general.subject).toContain("the vulva with its pubic hair");
  });

  it("renders the subject portrait metaprompt for each family, for the owner to read side by side", async () => {
    const rendered = ART_FAMILIES.map(
      (family) => `===== ${family} =====\n\n${ART_METAPROMPTS[family].subject}\n`,
    ).join("\n");
    await expect(rendered).toMatchFileSnapshot("./__snapshots__/subject-portrait-metaprompts.txt");
  });

  it("asks MOSS for a named capture and plain anatomical words, never a bare photograph", () => {
    for (const kind of KINDS) {
      const prompt = ART_METAPROMPTS.moss[kind];
      expect(prompt).toContain('Never write the bare word "photograph"');
      expect(prompt.match(/photograph/g)).toHaveLength(1);
      expect(prompt).toContain("her vulva in view");
      expect(prompt).not.toContain("pussy");
    }
    for (const prompt of [
      SUBJECT_DIPTYCH_METAPROMPTS.moss,
      ...Object.values(SCENE_METAPROMPTS.moss),
    ]) {
      expect(prompt.match(/photograph/g)).toHaveLength(1);
    }
    expect(SUBJECT_DIPTYCH_METAPROMPTS.moss).toContain(
      "one candid RAW photo split into two tall vertical panels",
    );
    expect(ART_METAPROMPTS.moss.subject).toContain("her breasts and vulva are bare");
    expect(ART_METAPROMPTS.moss.group).toContain("her breasts and vulva are bare");
    expect(ART_METAPROMPTS.moss.scenario).toContain("her breasts and vulva are bare");
  });

  it("lists every look in the model's words on every cover metaprompt, an explicit tag winning over Auto", () => {
    const [, selfie] = ART_LOOKS;
    for (const model of ART_FAMILIES) {
      const covers = {
        cover: ART_METAPROMPTS[model].subject,
        diptych: SUBJECT_DIPTYCH_METAPROMPTS[model],
        group: ART_METAPROMPTS[model].group,
      };
      for (const [surface, prompt] of Object.entries(covers)) {
        for (const look of ART_LOOKS) {
          expect(prompt).toContain(look.wording[model]);
          expect(prompt).toContain(look.when.cover);
          if (look.undated) expect(prompt).toContain(look.undated[model]);
        }
        expect(prompt).toContain("A <look> tag in the message names the look");
        expect(prompt).toContain("take the snapshot unless another plainly fits");
        expect(prompt).toContain("Only the available light that place and time give");
        expect(prompt).not.toMatch(/flash|studio|professional/i);
        expect(prompt).toContain(selfie?.framing?.[surface as keyof typeof covers]);
      }
    }
  });

  it("scene metaprompts choose a look from the notes and the excerpt, with no tag", () => {
    const [, selfie] = ART_LOOKS;
    for (const model of ART_FAMILIES) {
      for (const kind of KINDS) {
        const prompt = SCENE_METAPROMPTS[model][kind];
        for (const look of ART_LOOKS) {
          expect(prompt).toContain(look.wording[model]);
          expect(prompt).toContain(look.when.scene);
          if (look.when.cover !== look.when.scene) expect(prompt).not.toContain(look.when.cover);
        }
        expect(prompt).toContain("Choose by the era the notes and the excerpt give");
        expect(prompt).toContain(selfie?.framing?.scene);
        expect(prompt).not.toContain(selfie?.framing?.cover);
        expect(prompt).not.toContain("<look>");
      }
    }
  });

  it("shows three women on a Scenario poster unless the owner's direction asks for another number", () => {
    for (const model of ART_FAMILIES) {
      const prompt = ART_METAPROMPTS[model].scenario;
      expect(prompt).toContain("The poster shows three women.");
      expect(prompt).toContain(
        "Where the owner's direction asks for another number of women, from one up, show that number instead.",
      );
      expect(prompt).toContain("at most 180 words plus 80 for each woman");
      expect(prompt).not.toContain("two or three");
    }
  });

  it("adapts a Scenario poster's era without a catalogue", () => {
    for (const model of ART_FAMILIES) {
      const prompt = ART_METAPROMPTS[model].scenario;
      expect(prompt).toContain("film of that decade, named as in 1970s");
      expect(prompt).toContain("black and white film still");
      expect(prompt).toContain("genre, mood and era");
      expect(prompt).not.toContain("- selfie");
      expect(prompt).not.toContain("<look>");
      expect(prompt).not.toContain("professional");
    }
  });

  it("excepts only a look's decade and 35mm from the figure rule", () => {
    const clause = "the decade and 35mm a look's own wording carries";
    for (const model of ART_FAMILIES) {
      for (const prompt of [
        ART_METAPROMPTS[model].subject,
        ART_METAPROMPTS[model].group,
        SUBJECT_DIPTYCH_METAPROMPTS[model],
        ...Object.values(SCENE_METAPROMPTS[model]),
      ]) {
        expect(prompt).toContain(`Apart from age and ${clause}`);
      }
      expect(ART_METAPROMPTS[model].scenario).toContain(
        `Apart from age, the quoted title and ${clause}`,
      );
    }
  });

  it("opens a subject's background with the line the art source sends", () => {
    const line =
      "Open with one line, in the same terse notation, giving their age, origin, where they live now and their work, and the decade or year";
    expect(CARD_SYSTEM_PROMPTS.subject).toContain(line);
    expect(REWORK_SYSTEM_PROMPT).toContain(line);
  });

  it("asks a scene metaprompt for one moment in the model's words, bared only as the excerpt bares", () => {
    for (const kind of KINDS) {
      const krea = SCENE_METAPROMPTS.krea2[kind];
      const moss = SCENE_METAPROMPTS.moss[kind];
      expect(krea).toContain("the Krea 2 image model");
      expect(krea).toContain("vertical 2:3 photograph");
      expect(krea).toContain("the pussy with its pubic hair");
      expect(krea).not.toContain("MOSS");
      expect(moss).toContain("the MOSS image model");
      expect(moss).toContain("vertical 2:3 candid RAW photo");
      expect(moss).toContain("the vulva with its pubic hair");
      expect(moss).not.toContain("pussy");
      expect(moss.match(/photograph/g)).toHaveLength(1);
      for (const prompt of [krea, moss]) {
        expect(prompt).toContain("at the end of the excerpt");
        expect(prompt).toContain("nothing is bare that the excerpt does not bare");
        expect(prompt).toContain("unless the pose turns it away");
        expect(prompt).toContain("a change the excerpt makes");
        expect(prompt).toContain("{{user}}");
        expect(prompt).not.toContain("diptych");
        expect(prompt).not.toContain("pulled down");
        expect(prompt).not.toContain("square to the camera");
        expect(prompt).toContain("Return only the prompt as plain text.");
      }
    }
    expect(SCENE_METAPROMPTS.krea2.subject).toContain("at most 220 words");
    expect(SCENE_METAPROMPTS.krea2.subject).toContain("The character is alone in the frame");
    expect(SCENE_METAPROMPTS.krea2.subject).toContain("then the attached portrait");
    expect(SCENE_METAPROMPTS.krea2.group).toContain("290 for two and 370 for three");
    expect(SCENE_METAPROMPTS.krea2.group).toContain('anchored "on the left"');
    expect(SCENE_METAPROMPTS.krea2.scenario).toContain("the one person the latest turns focus on");
    expect(SCENE_METAPROMPTS.krea2.scenario).toContain("at most 220 words");
    // A Scenario sends no portrait and fixes no one: its person looks as the chat showed them.
    expect(SCENE_METAPROMPTS.krea2.scenario).not.toContain("portrait");
    expect(SCENE_METAPROMPTS.krea2.scenario).not.toContain("cast");
    expect(SCENE_METAPROMPTS.krea2.scenario).toContain("then how the excerpt has described them");
    // Its person exists only in the chat, so the rules take age and ethnicity from the excerpt first.
    expect(SCENE_METAPROMPTS.krea2.scenario).toContain("age as given in the excerpt or the notes");
    expect(SCENE_METAPROMPTS.krea2.scenario).toContain(
      "the phenotype the excerpt or the notes give",
    );
    expect(SCENE_METAPROMPTS.krea2.subject).toContain("age as given in the notes");
    // A covered chest looks as its clothing shapes it; the true size shows only once bared.
    for (const kind of ["subject", "group", "scenario"] as const) {
      expect(SCENE_METAPROMPTS.krea2[kind]).toContain(
        "names the size the clothing gives them, not the cup size",
      );
      // The shared figure rule must not override it with an unconditional cup-size word.
      expect(SCENE_METAPROMPTS.krea2[kind]).not.toContain(
        'one size word placed directly before "breasts", from the EU cup size:',
      );
      expect(SCENE_METAPROMPTS.krea2[kind]).toContain(
        "from the EU cup size where they are bare and, while clothing covers them, the size the clothing gives them",
      );
    }
    expect(ART_METAPROMPTS.krea2.subject).toContain(
      'one size word placed directly before "breasts", from the EU cup size:',
    );
    expect(SCENE_METAPROMPTS.krea2.subject).toContain("over the portrait and the notes");
  });

  it("defaults to one Subject in one frame and offers an explicit front/rear diptych for both models", () => {
    expect(CARD_SYSTEM_PROMPTS.subject).toContain("create exactly one subject");
    expect(CARD_SYSTEM_PROMPTS.group).toContain("at least two, at most three");
    for (const model of ART_FAMILIES) {
      expect(artMetaprompt(model, "subject")).toBe(ART_METAPROMPTS[model].subject);
      expect(artMetaprompt(model, "subject", "regular")).toContain("one woman in one single frame");
      expect(artMetaprompt(model, "subject")).not.toContain("diptych");
      expect(artMetaprompt(model, "subject")).toContain("both in full view from the front");
      expect(artMetaprompt(model, "subject")).not.toContain("uncovered");
      const diptych = artMetaprompt(model, "subject", "diptych");
      expect(diptych).toBe(SUBJECT_DIPTYCH_METAPROMPTS[model]);
      expect(diptych).toContain("two tall vertical panels");
      expect(diptych).toContain("The right panel is a full rear view");
      expect(diptych).toContain("in full view on the left");
      expect(diptych).toContain("in full view on the right");
      // One personality-led pose and place in it, seen from both sides, not only standing.
      expect(diptych).toContain("She holds one pose in both panels");
      expect(diptych).toContain("her pose and position unchanged");
      expect(diptych).toContain("where she is in the place");
      expect(diptych).toContain("besides where step 2 puts each woman");
      expect(diptych).toContain(`hides her ${model === "krea2" ? "ass" : "buttocks"}`);
      expect(diptych).not.toContain("she stands fully in the frame");
      for (const kind of ["group", "scenario"] as const) {
        expect(artMetaprompt(model, kind, "diptych")).toBe(ART_METAPROMPTS[model][kind]);
      }
    }
    expect(ART_METAPROMPTS.krea2.group).toContain("group photo");
    expect(ART_METAPROMPTS.krea2.group).not.toContain("panel");
  });

  it("keeps where play begins out of Subject and Group descriptions, in the opening alone", () => {
    for (const prompt of [CARD_SYSTEM_PROMPTS.subject, CARD_SYSTEM_PROMPTS.group]) {
      expect(prompt).toContain("no current place, time of day, outfit or scene");
      expect(prompt).toContain("The first message alone sets where and when play begins");
    }
    expect(CARD_SYSTEM_PROMPTS.scenario).not.toContain("The first message alone sets");
  });

  it("describes how Subject and Group people dress as a style or habit, never one outfit", () => {
    for (const prompt of [CARD_SYSTEM_PROMPTS.subject, CARD_SYSTEM_PROMPTS.group]) {
      expect(prompt).toContain(
        "How they dress, as a general style or habit, such as practical workwear, muted layers or always a leather jacket, never one outfit or a list of garments.",
      );
      expect(prompt).not.toContain("Usual clothing.");
    }
    // A picture shows one outfit; the card takes only the style it suggests.
    expect(imageCardPrompt("subject", null, null)).toContain(
      "Their clothing in it is one outfit: the description takes from it only the general style it suggests, never the outfit itself.",
    );
    expect(imageCardPrompt("group", null, null)).toContain(
      "Each person's clothing in it is one outfit: the description takes from it only the general style it suggests, never the outfit itself.",
    );
  });

  it("keeps Subject and Group blocks to what shapes play, with no word quotas or invented secrets", () => {
    for (const prompt of [CARD_SYSTEM_PROMPTS.subject, CARD_SYSTEM_PROMPTS.group]) {
      expect(prompt).toContain("only what shapes how the subject acts, talks and reacts");
      expect(prompt).toContain("outside the card's subjects as short unnamed lines");
      expect(prompt).toContain(
        "Invent no secrets, hidden agendas, goals or unresolved conflicts the player did not ask for",
      );
      expect(prompt).toContain("Use as many words as the facts need and no more");
      expect(prompt).not.toMatch(/(Up to|At most) [\d,]+ words/);
    }
  });

  it("lights Subject and Group covers only by the place's available light", () => {
    expect(ART_METAPROMPTS.krea2.subject).toContain(
      "Only the available light that place and time give",
    );
    expect(ART_METAPROMPTS.krea2.group).toContain(
      "Only the available light that place and time give",
    );
  });

  it("bares every woman on every cover in the words the image model answers to", () => {
    expect(ART_METAPROMPTS.krea2.subject).toContain("her breasts and pussy are bare");
    expect(ART_METAPROMPTS.krea2.subject).toContain("Her pose keeps her pussy in view");
    expect(ART_METAPROMPTS.krea2.group).toContain("her breasts and pussy are bare");
    expect(ART_METAPROMPTS.krea2.scenario).toContain("her breasts and pussy are bare");
    for (const prompt of ART_FAMILIES.flatMap((model) =>
      KINDS.map((kind) => ART_METAPROMPTS[model][kind]),
    )) {
      expect(prompt).toContain("any underwear she wears included");
      expect(prompt).toContain("keeps her");
      expect(prompt).not.toContain("vagina");
    }
  });

  it("poses every woman on every cover by her dominant visible trait, named in words with her place", () => {
    for (const model of ART_FAMILIES) {
      for (const prompt of [
        ...KINDS.map((kind) => ART_METAPROMPTS[model][kind]),
        SUBJECT_DIPTYCH_METAPROMPTS[model],
      ]) {
        expect(prompt).toContain("Pose each woman by the dominant personality trait");
        expect(prompt).toContain("the one a picture can show most clearly");
        expect(prompt).toContain("posture, body language, gesture, gaze and expression");
        expect(prompt).toContain(
          "Distinct subjects must not all receive a generic identical stance",
        );
        expect(prompt).toContain("then the pose that trait gives her, in concrete words");
        expect(prompt).toContain("where she is in the place");
        expect(prompt).toContain("besides where step 2 puts each woman");
        expect(prompt).not.toContain("square to the camera");
        expect(prompt).not.toContain("hands on her hips, at her sides or behind her head");
      }
      // A Scenario's women are unnamed, so the trait comes from their kind of person.
      expect(ART_METAPROMPTS[model].scenario).toContain(
        "the notes' People give her kind of person",
      );
      for (const kind of KINDS) {
        expect(SCENE_METAPROMPTS[model][kind]).toContain(
          "Only where the excerpt leaves posing details open, pose each person by their dominant personality trait",
        );
        expect(SCENE_METAPROMPTS[model][kind]).toContain(
          "Never replace an explicit current pose or action",
        );
      }
    }
  });

  it("asks every card appearance and every image prompt for the exact age in years", () => {
    // A Scenario writes no appearances: it holds no fixed characters.
    expect(CARD_SYSTEM_PROMPTS.scenario).not.toContain("years old");
    for (const kind of KINDS) {
      if (kind !== "scenario") {
        expect(CARD_SYSTEM_PROMPTS[kind]).toContain('age as given, in digits as in "25 years old"');
      }
      expect(CARD_SYSTEM_PROMPTS[kind]).not.toContain("18 or older");
      for (const model of ART_FAMILIES) {
        expect(ART_METAPROMPTS[model][kind]).toContain(
          'age as given in the notes as "NN years old"',
        );
        expect(ART_METAPROMPTS[model][kind]).not.toContain("under 18");
        expect(ART_METAPROMPTS[model][kind]).not.toContain("apparent age");
      }
    }
  });

  it("asks for one opening and no alternate greetings, starting point or tags", () => {
    for (const kind of KINDS) {
      expect(CARD_SYSTEM_PROMPTS[kind]).toContain("- firstMessage:");
      expect(CARD_SYSTEM_PROMPTS[kind]).not.toContain("alternate_greeting");
      expect(CARD_SYSTEM_PROMPTS[kind]).not.toContain("- scenario:");
      expect(CARD_SYSTEM_PROMPTS[kind]).not.toContain("- tags:");
    }
  });

  it("frames a Scenario with no fixed characters, its people left for the narrator to invent", () => {
    const prompt = CARD_SYSTEM_PROMPTS.scenario;
    expect(prompt).toContain("holds no fixed characters");
    expect(prompt).toContain(
      "the narrator invents every person, place and event as play needs them",
    );
    expect(prompt).toContain("Who lives here, in general terms, never an individual");
    expect(prompt).toContain("Build a frame, not a plot or a cast");
    expect(prompt).toContain("At most three standing pressures");
    expect(prompt).not.toMatch(/[\d,]+ words/);
    expect(prompt).toContain("never by a named person");
    expect(prompt).not.toContain("principal characters");
    expect(prompt).not.toContain("<backgroundstory>");
    expect(prompt).not.toContain("Name every character");
    expect(imageCardPrompt("scenario", null, null)).toContain(
      "without making any of them a named character",
    );
  });

  it("letters only a Scenario cover, with the card's title as a movie poster's", () => {
    for (const model of ["krea2", "moss"] as const) {
      expect(ART_METAPROMPTS[model].scenario).toContain("movie poster title lettering");
      expect(ART_METAPROMPTS[model].scenario).toContain(
        "no lettering or captions in the image but the title",
      );
      expect(ART_METAPROMPTS[model].scenario).toContain("unnamed women of this world");
      // A title such as "Station 13" keeps its digits, whatever the rule on numbers says.
      expect(ART_METAPROMPTS[model].scenario).toContain(
        "Apart from age, the quoted title and the decade and 35mm a look's own wording carries, such as 1970s, write no numbers",
      );
      expect(ART_METAPROMPTS[model].subject).toContain(
        "Apart from age and the decade and 35mm a look's own wording carries, such as 1970s, write no numbers",
      );
      expect(ART_METAPROMPTS[model].scenario).not.toContain("cast");
      for (const kind of ["subject", "group"] as const) {
        expect(ART_METAPROMPTS[model][kind]).toContain("no lettering or captions in the image.");
        expect(ART_METAPROMPTS[model][kind]).not.toContain("title");
      }
      for (const kind of KINDS) {
        expect(SCENE_METAPROMPTS[model][kind]).toContain("no lettering or captions in the image.");
      }
    }
  });

  it("opens a subject or group card on its subjects in the scene, a scenario on the scene alone", () => {
    for (const kind of ["subject", "group"] as const) {
      expect(CARD_SYSTEM_PROMPTS[kind]).toContain(
        "one short sentence that places the subject in the scene: exactly where they are and their current state",
      );
      expect(CARD_SYSTEM_PROMPTS[kind]).toContain(
        '"{{char}} is seen tanning on a plush sun lounger, unassuming and relaxed."',
      );
      expect(CARD_SYSTEM_PROMPTS[kind]).not.toContain("sensory detail");
    }
    expect(CARD_SYSTEM_PROMPTS.group).toContain("places each of them, by name, never {{char}}");
    expect(CARD_SYSTEM_PROMPTS.scenario).toContain("one short sentence of sensory detail");
    expect(CARD_SYSTEM_PROMPTS.scenario).not.toContain("places the subject in the scene");
  });
});

describe("card answer validation", () => {
  it("accepts a Subject card with one subject", () => {
    const card = valid("subject", answer());
    expect(card).toEqual({
      name: "Ada Reed",
      description: subject("ada_reed"),
      firstMessage: "Ada looks up.",
      creatorNotes: "A placeholder pitch.",
    });
  });

  it("accepts a Group card with three subjects and returns their blocks", () => {
    const description = [subject("ada_reed"), subject("bo_lind"), subject("cy_moss")].join("\n");
    const result = validateCardAnswer("group", answer({ description }));
    expect(result.ok && result.blocks.map((block) => block.name)).toEqual([
      "ada_reed",
      "bo_lind",
      "cy_moss",
    ]);
  });

  it("accepts a subject with a single name", () => {
    expect(valid("subject", answer({ name: "Ada", description: subject("ada") })).name).toBe("Ada");
  });

  it("tolerates text outside the tags", () => {
    expect(valid("subject", `Here is the card:\n${answer()}\nEnjoy.`).name).toBe("Ada Reed");
  });

  it("accepts a Scenario card of three plain blocks", () => {
    const card = valid("scenario", answer({ name: "Valley", description: scenarioDescription() }));
    expect(card.description).toBe(scenarioDescription());
  });

  it("needs exactly one subject on a Subject card", () => {
    const two = [subject("ada"), subject("bo")].join("\n");
    expect(problems("subject", answer({ description: two }))).toEqual([
      { code: "subject_count", count: 2, min: 1, max: 1 },
    ]);
    expect(problems("subject", answer({ description: "Just prose." }))).toEqual([
      { code: "subject_count", count: 0, min: 1, max: 1 },
    ]);
  });

  it("needs two or three subjects on a Group card", () => {
    const four = ["ada", "bo", "cy", "di"].map((name) => subject(name)).join("\n");
    expect(problems("group", answer({ description: four }))).toEqual([
      { code: "subject_count", count: 4, min: 2, max: 3 },
    ]);
    expect(problems("group", answer())).toEqual([
      { code: "subject_count", count: 1, min: 2, max: 3 },
    ]);
    expect(
      valid("group", answer({ description: [subject("ada"), subject("bo")].join("\n") })).name,
    ).toBe("Ada Reed");
  });

  it("asks the model for the kind's number of subjects when it retries", () => {
    expect(cardRetryPrompt([{ code: "subject_count", count: 2, min: 1, max: 1 }])).toContain(
      "it needs exactly 1.",
    );
    expect(cardRetryPrompt([{ code: "subject_count", count: 4, min: 2, max: 3 }])).toContain(
      "it needs 2 to 3.",
    );
  });

  it("needs lowercase block names joined by underscores", () => {
    expect(problems("subject", answer({ description: subject("Ada_Reed") }))).toEqual([
      { code: "block_name", block: "Ada_Reed" },
    ]);
  });

  it("needs the four inner tags in order", () => {
    const missing = subject("ada", inner().replace(/<vocabulary>.*<\/vocabulary>/, ""));
    const swapped = subject(
      "ada",
      "<appearance>A.</appearance><backgroundstory>B.</backgroundstory><personality>C.</personality><vocabulary>D.</vocabulary>",
    );
    expect(problems("subject", answer({ description: missing }))).toEqual([
      { code: "block_tags", block: "ada" },
    ]);
    expect(problems("subject", answer({ description: swapped }))).toEqual([
      { code: "block_tags", block: "ada" },
    ]);
  });

  it("needs exactly Roleplay, Setting, People and Tone in order", () => {
    const swapped =
      "<Setting>S.</Setting><Roleplay>R.</Roleplay><People>P.</People><Tone>T.</Tone>";
    const noTone = "<Roleplay>R.</Roleplay><Setting>S.</Setting><People>P.</People>";
    const noPeople = "<Roleplay>R.</Roleplay><Setting>S.</Setting><Tone>T.</Tone>";
    expect(problems("scenario", answer({ description: noPeople }))).toEqual([
      { code: "scenario_blocks" },
    ]);
    expect(problems("scenario", answer({ description: swapped }))).toEqual([
      { code: "scenario_blocks" },
    ]);
    expect(problems("scenario", answer({ description: noTone }))).toEqual([
      { code: "scenario_blocks" },
    ]);
  });

  it("rejects character blocks nested in a Scenario, which holds no fixed characters", () => {
    const cast = scenarioDescription(subject("ada_reed"));
    expect(problems("scenario", answer({ description: cast }))).toEqual([
      { code: "scenario_blocks" },
    ]);
    const inPeople = scenarioDescription().replace(
      "Millers in flour-white aprons.",
      subject("mira"),
    );
    expect(problems("scenario", answer({ description: inPeople }))).toEqual([
      { code: "scenario_blocks" },
    ]);
    const wrapped = scenarioDescription().replace(
      "Millers in flour-white aprons.",
      `<cast>${subject("mira")}</cast>`,
    );
    expect(problems("scenario", answer({ description: wrapped }))).toEqual([
      { code: "scenario_blocks" },
    ]);
    // Tag-like words in a block's prose are no character and pass.
    const tagLike = scenarioDescription().replace(
      "Quiet placeholder mood.",
      "Thoughts in <i>italics</i>, as <Roleplay> sets.",
    );
    expect(problems("scenario", answer({ description: tagLike }))).toEqual([]);
  });

  it("ignores alternate greetings and a starting point the model writes anyway", () => {
    const extra = answer().replace(
      "<creatorNotes>",
      "<scenario>Ada waits at the gate.</scenario>\n<alternate_greeting>Rain.</alternate_greeting>\n<creatorNotes>",
    );
    expect(valid("subject", extra)).toEqual(valid("subject", answer()));
  });

  it("keeps card tags inside an ignored section out of the card", () => {
    const nested = answer().replace(
      "<firstMessage>",
      "<scenario>See <firstMessage>Nested.</firstMessage> below.</scenario>\n<firstMessage>",
    );
    expect(valid("subject", nested).firstMessage).toBe("Ada looks up.");
  });

  it("ignores tags the model writes anyway, and the sections inside them", () => {
    expect(valid("subject", `${answer()}\n<tags>drama, noir</tags>`)).not.toHaveProperty("tags");
    const leading = `<tags><name>Wrong Name</name>, drama</tags>\n${answer()}`;
    expect(valid("subject", leading).name).toBe("Ada Reed");
  });

  it("needs a name and a first message", () => {
    expect(problems("subject", answer({ name: " ", firstMessage: "" }))).toEqual([
      { code: "missing", section: "name" },
      { code: "missing", section: "firstMessage" },
    ]);
  });

  it("reports a name past the card limit", () => {
    expect(problems("subject", answer({ name: "A".repeat(201) }))).toEqual([
      { code: "too_long", section: "name" },
    ]);
  });

  it("reports an answer cut off mid-way", () => {
    const cut = answer().slice(0, answer().indexOf("pitch"));
    expect(problems("subject", cut)).toEqual([{ code: "incomplete", section: "creatorNotes" }]);
  });
});

describe("streaming parse", () => {
  it("reports absent, incomplete and complete sections of a truncated stream", () => {
    const full = answer();
    const parsed = parseCardAnswer(full.slice(0, full.indexOf("looks up.") + 5));
    expect(parsed.name).toEqual({ state: "complete", text: "Ada Reed" });
    expect(parsed.description.state).toBe("complete");
    expect(parsed.firstMessage).toEqual({ state: "incomplete", text: "Ada looks" });
    expect(parsed.creatorNotes).toEqual({ state: "absent", text: "" });
  });

  it("sets the opening as a quoted Location line, an empty line and the scene", () => {
    const scene = "Warm golden light slants across the counter.";
    const expected = `> Location: Kahale Fruit Stand, late afternoon\n\n${scene}`;
    for (const opening of [
      `Location: Kahale Fruit Stand, late afternoon\n${scene}`,
      `> Location: Kahale Fruit Stand, late afternoon\n${scene}`,
      `>Location: Kahale Fruit Stand, late afternoon\n\n\n${scene}`,
      `**Location:** Kahale Fruit Stand, late afternoon\n${scene}`,
      `*Location: Kahale Fruit Stand, late afternoon*\n${scene}`,
      `> Location: Kahale Fruit Stand, late afternoon\n\n${scene}`,
    ]) {
      expect(valid("subject", answer({ firstMessage: opening })).firstMessage).toBe(expected);
    }
    expect(valid("subject", answer({ firstMessage: "Ada looks up.\nRain." })).firstMessage).toBe(
      "Ada looks up.\nRain.",
    );
    expect(parseCardAnswer("<firstMessage>Location: a harbour").firstMessage).toEqual({
      state: "incomplete",
      text: "> Location: a harbour",
    });
  });

  it("sets a reply's Location line apart and leaves the rest as written", () => {
    const scene = 'Rain drums on the roof.\nKate (25): "Hi."\n\n> present: none';
    expect(formatLocationLine(`\nLocation: the park, dusk\n${scene}`)).toBe(
      `> Location: the park, dusk\n\n${scene}`,
    );
    for (const text of [
      `Kate (25): "Location: here."`,
      "",
      "Locations blur.\nRain.",
      "Location of the vault is secret.\nShe smiles.",
      "Location, location, location.",
      "*Location* matters more than price.",
    ]) {
      expect(formatLocationLine(text)).toBe(text);
    }
    const streamed = [
      "Location",
      "Location: the pa",
      "Location: the park\n",
      "Location: the park\nRa",
    ];
    expect(streamed.map(formatLocationLine)).toEqual([
      "> Location:",
      "> Location: the pa",
      "> Location: the park",
      "> Location: the park\n\nRa",
    ]);
  });

  it("reads a hostile first line of quote mark and spaces in linear time", () => {
    const hostile = `>${" ".repeat(200_000)}x`;
    const started = performance.now();
    expect(formatLocationLine(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("drops a tag cut off at the end of the stream", () => {
    const parsed = parseCardAnswer("<name>Ada</name><firstMessage>Ada looks up.</first_m");
    expect(parsed.firstMessage).toEqual({ state: "incomplete", text: "Ada looks up." });
  });

  it("reports description blocks and inner tags as they arrive", () => {
    const text = `<name>Ada</name><description>${subject("ada")}\n<bo><backgroundstory>Is 40.</backgroundstory><appear`;
    const [ada, bo] = parseCardAnswer(text).blocks;
    expect(ada?.state).toBe("complete");
    expect(ada?.blocks.map((block) => block.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
    expect(bo).toMatchObject({ name: "bo", state: "incomplete" });
    expect(bo?.blocks).toEqual([
      { name: "backgroundstory", state: "complete", text: "Is 40.", blocks: [] },
    ]);
  });
});

describe("art source", () => {
  const LOCATION = "Location: a placeholder harbour, dusk.";
  const OPENING = `${LOCATION}\nGulls cry over the water.`;

  it("sends the opening's Location line, then each subject's appearance, background opening and fuller personality", () => {
    const description = [
      subject("ada").replace(
        "Calm placeholder temperament.",
        "Calm placeholder temperament. Wants placeholder things in private. Tilts her head with a sly smile.",
      ),
      subject("bo"),
    ].join("\n");
    const source = artSource("subject", description, OPENING);
    expect(source).toContain("<ada>");
    expect(source).toContain("<bo>");
    expect(source).toContain("Is 30 and lives in Testtown.");
    expect(source).not.toContain("Works at the mill.");
    expect(source).toContain("Tall, placeholder build, grey eyes.");
    expect(source).toContain(
      "<temperament>\nCalm placeholder temperament. Wants placeholder things in private. Tilts her head with a sly smile.\n</temperament>",
    );
    expect(source).not.toContain("Sample phrase.");
    expect(source.startsWith(`<Location>\n${LOCATION}\n</Location>`)).toBe(true);
    expect(source).not.toContain("Gulls cry");
  });

  it("bounds each subject's personality so later subjects still carry their own traits", () => {
    const description = [
      subject("ada").replace(
        "Calm placeholder temperament.",
        "x".repeat(CREATOR_LIMITS.artPersonalityLength + 100),
      ),
      subject("bo").replace("Calm placeholder temperament.", "Shy. Keeps her shoulders tucked in."),
    ].join("\n");
    const source = artSource("group", description, "");
    expect(source).not.toContain("x".repeat(CREATOR_LIMITS.artPersonalityLength + 1));
    expect(source).toContain("<bo>");
    expect(source).toContain("Shy. Keeps her shoulders tucked in.");
    expect(textLength(source)).toBeLessThanOrEqual(CREATOR_LIMITS.artSourceLength);
  });

  it("sends a scenario's title, the opening's Location line, the premise and the openings of Setting and Tone", () => {
    const description = scenarioDescription()
      .replace(
        "Quiet placeholder mood.",
        'Placeholder drama. The mood is quiet. Past tense, short replies. "A sample line."',
      )
      .replace(
        "A placeholder valley town.",
        "A placeholder valley town. It is autumn. Mills line the river. The guilds set the law.",
      );
    expect(artSource("scenario", description, OPENING, " Valley of Mills ")).toBe(
      [
        "<Title>\nValley of Mills\n</Title>",
        `<Location>\n${LOCATION}\n</Location>`,
        "<Premise>\nA placeholder premise in one line.\n</Premise>",
        "<Setting>\nA placeholder valley town. It is autumn. Mills line the river.\n</Setting>",
        "<People>\nMillers in flour-white aprons.\n</People>",
        "<Tone>\nPlaceholder drama. The mood is quiet.\n</Tone>",
      ].join("\n\n"),
    );
  });

  it("titles only a Scenario's source", () => {
    expect(artSource("subject", subject("ada"), OPENING, "Ada")).not.toContain("<Title>");
    expect(artSource("scenario", scenarioDescription(), OPENING, " ")).not.toContain("<Title>");
  });

  it("sends a Location line with Markdown emphasis, and no Location for other openings", () => {
    const description = subject("ada");
    expect(artSource("subject", description, "**Location:** a harbour, dusk.\nRain.")).toMatch(
      /^<Location>\n\*\*Location:\*\* a harbour, dusk\.\n<\/Location>/,
    );
    expect(artSource("subject", description, `> ${OPENING}`)).toMatch(
      new RegExp(`^<Location>\n${LOCATION}\n</Location>`),
    );
    for (const opening of ["Ada looks up.\nLocation: a harbour, dusk.", "Locations blur.", " "]) {
      expect(artSource("subject", description, opening)).not.toContain("<Location>");
    }
  });

  it("sends a scenario without a title or an opening as premise, Setting, People and Tone", () => {
    expect(artSource("scenario", scenarioDescription(), " ")).toBe(
      [
        "<Premise>\nA placeholder premise in one line.\n</Premise>",
        "<Setting>\nA placeholder valley town.\n</Setting>",
        "<People>\nMillers in flour-white aprons.\n</People>",
        "<Tone>\nQuiet placeholder mood.\n</Tone>",
      ].join("\n\n"),
    );
  });
});

describe("saved card art source", () => {
  /** A fixture card as the import normalizes it. */
  const fields = (card: unknown) => {
    const result = normalizeCard(card);
    if (!result.ok) throw new Error(`fixture: ${result.error}`);
    return result.card;
  };
  const SCENARIO = "A placeholder ferry crosses a grey estuary. The crossing takes an hour.";

  it("takes the kind from the creator's tag in any case, Subject when none matches", () => {
    expect(savedCardKind(["drama", "Scenario"])).toBe("scenario");
    expect(savedCardKind(["Multiple Subjects"])).toBe("group");
    expect(savedCardKind([])).toBe("subject");
    expect(savedCardKind(["scenario"])).toBe("scenario");
    expect(savedCardKind(["scenarios"])).toBe("subject");
  });

  it("sends a creator-shaped card's source exactly as the creator does", () => {
    const opening = "Location: a placeholder harbour, dusk.\nGulls cry.";
    const card = { personality: "Ignored here.", scenario: "Ignored too.", firstMessage: opening };
    const subjectCard = { ...card, description: subject("ada") };
    expect(savedCardArtSource("subject", subjectCard)).toBe(
      artSource("subject", subjectCard.description, opening),
    );
    const scenarioCard = { ...card, description: scenarioDescription() };
    expect(savedCardArtSource("scenario", scenarioCard, "Valley")).toBe(
      artSource("scenario", scenarioCard.description, opening, "Valley"),
    );
  });

  it("reads a Scenario saved in the three blocks before People by its blocks, however long", () => {
    const legacy = [
      `<Roleplay>\nA placeholder premise.\n${"Forces in motion. ".repeat(1_000)}\n${subject("ada_reed")}\n</Roleplay>`,
      "<Setting>A placeholder valley town.</Setting>",
      "<Tone>Quiet placeholder mood.</Tone>",
    ].join("\n");
    const card = { personality: "", scenario: "", firstMessage: "Location: the pass, dawn.\nFog." };
    const source = savedCardArtSource("scenario", { ...card, description: legacy }, "Valley");
    expect(source).toBe(artSource("scenario", legacy, card.firstMessage, "Valley"));
    expect(source).toContain("<Setting>\nA placeholder valley town.\n</Setting>");
    expect(source).toContain("<Tone>\nQuiet placeholder mood.\n</Tone>");
    expect(source).not.toContain("<People>");
    // Its cast is no longer pictured: a Scenario's cover shows unnamed people of its world.
    expect(source).not.toContain("Tall, placeholder build");
  });

  it.each([
    ["a W++ card", wplusplus],
    ["prose with one tagged block", mixedTone],
    ["a subject block with an unclosed inner tag", incompleteAppearance],
  ])(
    "quotes %s as prose: its description, bounded personality and two sentences of scenario",
    (_, fixture) => {
      const card = fields(fixture);
      const source = savedCardArtSource("subject", card);
      expect(source).toContain(`<description>\n${card.description.trim()}\n</description>`);
      expect(source).toContain(`<temperament>\n${card.personality.trim()}\n</temperament>`);
      expect(source).toContain(`<premise>\n${SCENARIO}\n</premise>`);
      expect(source).toContain("deep water");
      expect(source).not.toContain("Smugglers");
    },
  );

  it("clips a long prose description and the whole source, never inside a character", () => {
    const description = `${"x".repeat(CREATOR_LIMITS.savedDescriptionLength - 1)}\u{1F600} tail`;
    const huge = `${"y".repeat(CREATOR_LIMITS.artSourceLength)}.`;
    const source = savedCardArtSource("subject", {
      description,
      personality: huge,
      scenario: "",
      firstMessage: "",
    });
    expect(textLength(source)).toBeLessThanOrEqual(CREATOR_LIMITS.artSourceLength);
    expect(source.isWellFormed()).toBe(true);
    expect(source).toContain(
      `<description>\n${"x".repeat(CREATOR_LIMITS.savedDescriptionLength - 1)}\u{1F600}\n</description>`,
    );
  });

  it("sends up to three sentences of a greeting-only card's opening", () => {
    expect(savedCardArtSource("subject", fields(greetingOnly))).toBe(
      "<opening>\nMira sets her lantern on the rail. The rain has stopped at last. She turns to you with a tired smile.\n</opening>",
    );
  });

  it("sends an opening's Location line instead of its sentences", () => {
    const source = savedCardArtSource("subject", fields(plainProse));
    expect(
      source.startsWith("<Location>\nLocation: the ferry's wheelhouse, dawn.\n</Location>"),
    ).toBe(true);
    expect(source).not.toContain("<opening>");
    expect(source).toContain("copper braid");
  });

  it("sends nothing for a card whose four fields are blank", () => {
    const blank = { description: " ", personality: "", scenario: "\n", firstMessage: "" };
    expect(savedCardArtSource("scenario", blank)).toBe("");
  });
});

describe("sheet fields", () => {
  it("maps a Subject card with the pitch as creator notes and empty duplicates", () => {
    const fields = toSheetFields("subject", valid("subject", answer()));
    expect(sheetFieldsSchema.parse(fields)).toEqual(fields);
    expect(fields).toMatchObject({
      name: "Ada Reed",
      firstMessage: "Ada looks up.",
      alternateGreetings: [],
      scenario: "",
      creatorNotes: "A placeholder pitch.",
      personality: "",
      exampleDialogue: "",
      systemPrompt: "",
      postHistoryInstructions: "",
      tags: ["Subject"],
    });
  });

  it("tags a Group card Multiple Subjects", () => {
    const description = [subject("ada"), subject("bo")].join("\n");
    expect(toSheetFields("group", valid("group", answer({ description }))).tags).toEqual([
      "Multiple Subjects",
    ]);
  });

  it("maps a Scenario card with an empty scenario field", () => {
    const card = valid("scenario", answer({ name: "Valley", description: scenarioDescription() }));
    const fields = toSheetFields("scenario", card);
    expect(sheetFieldsSchema.parse(fields)).toEqual(fields);
    expect(fields).toMatchObject({
      name: "Valley",
      description: scenarioDescription(),
      scenario: "",
      alternateGreetings: [],
      tags: ["Scenario"],
    });
  });
});

describe("opening shapes", () => {
  it("keep their exact text while sharing the Location line and the restraint", () => {
    expect(SUBJECT_OPENING_SHAPE).toBe(
      `a first line that starts with "> Location: " and names the place and the time, then an empty line, then one short sentence that places the subject in the scene: exactly where they are and their current state, what they are doing and how they seem, seen from outside, as in "{{char}} is seen tanning on a plush sun lounger, unassuming and relaxed." A card with several subjects places each of them, by name, never {{char}}. No dialogue, no plot, and nothing for {{user}}.`,
    );
    expect(SCENARIO_OPENING_SHAPE).toBe(
      `a first line that starts with "> Location: " and names the place and the time, then an empty line, then one short sentence of sensory detail. No character actions, no dialogue, no plot, and nothing for {{user}}.`,
    );
    expect(SUBJECT_OPENING_SHAPE.startsWith(LOCATION_OPENING)).toBe(true);
    expect(SCENARIO_OPENING_SHAPE.startsWith(LOCATION_OPENING)).toBe(true);
    expect(SUBJECT_OPENING_SHAPE.endsWith(OPENING_RESTRAINT)).toBe(true);
  });
});

describe("card style", () => {
  it("keeps its exact text", () => {
    expect(CARD_STYLE).toBe(
      "Write for a model, not a reader: the most detail in the fewest tokens. Use terse notation instead of prose: fragments, short clauses and label: value lines, with no articles, filler or connecting phrases and no restating whom a block is about. Every clause carries a concrete, specific fact that changes how the model plays the card. Use as many words as the facts need and no more. Only what the player reads or a character says is written in full sentences: firstMessage, alternate greetings, example dialogue, creatorNotes, sample phrases in quotation marks and the <Tone> sample. Never use em dashes, which read as machine prose.",
    );
  });
});

describe("cardPrompt", () => {
  it("is the description alone without a persona", () => {
    expect(cardPrompt("A placeholder keeper", null)).toBe("A placeholder keeper");
  });

  it("puts the persona before the description, and tells the model it is {{user}}", () => {
    const prompt = cardPrompt("{{user}}'s placeholder sister", {
      name: "Kai Moss",
      description: "  A placeholder sailor, 34, from Testport.  ",
    });
    expect(prompt).toContain("{{user}}");
    expect(prompt).toContain("<name>Kai Moss</name>");
    expect(prompt).toContain("<about>\nA placeholder sailor, 34, from Testport.\n</about>");
    expect(
      prompt.endsWith("<player_description>\n{{user}}'s placeholder sister\n</player_description>"),
    ).toBe(true);
    expect(prompt.indexOf("<persona>")).toBeLessThan(prompt.indexOf("<player_description>"));
  });

  it("sends a persona without a description by name only", () => {
    const prompt = cardPrompt("A placeholder keeper", { name: "Kai", description: " " });
    expect(prompt).toContain("<persona>\n<name>Kai</name>\n</persona>");
    expect(prompt).not.toContain("<about>");
  });

  it("accepts a persona id on the card request", () => {
    const request = { kind: "subject", description: "A keeper", model: "m" };
    const id = "00000000-0000-4000-8000-000000000004";
    expect(creatorCardRequestSchema.parse({ ...request, personaId: id }).personaId).toBe(id);
    expect(creatorCardRequestSchema.safeParse({ ...request, personaId: "kai" }).success).toBe(
      false,
    );
  });
});

describe("art looks", () => {
  it("the catalogue's wording obeys the form and light rules on both models", () => {
    expect(ART_LOOKS.map((look) => look.id)).toEqual([...ART_LOOK_IDS]);
    for (const look of ART_LOOKS) {
      const texts = [
        look.when.cover,
        look.when.scene,
        ...ART_FAMILIES.map((model) => look.wording[model]),
        ...(look.undated ? ART_FAMILIES.map((model) => look.undated?.[model] ?? "") : []),
        ...Object.values(look.framing ?? {}),
      ];
      for (const text of texts) {
        expect(text).not.toMatch(/[:;\u2014]/);
        expect(text).not.toMatch(
          /photograph|grain|noise|blur|soft|flash|studio|professional|editorial|photoshoot|lens|aperture|stock|bokeh/i,
        );
        expect(text.replace(/\b35mm\b|\b(19|20)\d0s\b/g, "")).not.toMatch(/\d/);
      }
    }
    const byId = Object.fromEntries(ART_LOOKS.map((look) => [look.id, look]));
    expect(byId.snapshot?.framing).toBeUndefined();
    for (const model of ART_FAMILIES) {
      expect(byId.snapshot?.wording[model]).toBe("an amateur snapshot, raw and true to life");
      for (const id of ["film", "digital", "monochrome"]) {
        const undated = byId[id]?.undated?.[model];
        expect(undated).toBeDefined();
        expect(undated).not.toContain("<decade>");
      }
      for (const id of ["film", "monochrome"]) {
        expect(byId[id]?.undated?.[model]?.replace("35mm", "")).not.toMatch(/\d/);
      }
    }
  });
});

describe("artPrompt", () => {
  const SOURCE = "<Location>\nLocation: a placeholder harbour, dusk.\n</Location>";

  it("sends the art source alone without a direction", () => {
    expect(artPrompt(SOURCE, null)).toBe(SOURCE);
  });

  it("puts the direction after the notes, first in rank and inside the metaprompt's form", () => {
    const prompt = artPrompt(SOURCE, "Golden hour on a rooftop.");
    expect(prompt.startsWith(`${SOURCE}\n\n`)).toBe(true);
    expect(prompt).toContain("It is your primary direction");
    expect(prompt).toContain("A place or time of day it names replaces the Location's.");
    expect(prompt).toContain(
      "The framing, the order of the steps, the word limit, the rules and the plain-text answer stay exactly as the instructions say.",
    );
    expect(prompt.endsWith("<direction>\nGolden hour on a rooftop.\n</direction>")).toBe(true);
  });

  it("adds the reference note after the notes when a portrait is attached, the direction still last", () => {
    const note = "The attached image is the card's current portrait.";
    const referenced = artPrompt(SOURCE, null, true);
    expect(referenced.startsWith(`${SOURCE}\n\n${note}`)).toBe(true);
    expect(referenced).toContain("The framing, the order of the steps");
    const directed = artPrompt(SOURCE, "Golden hour on a rooftop.", true);
    expect(directed.indexOf(note)).toBeGreaterThan(directed.indexOf(SOURCE));
    expect(directed.indexOf("It is your primary direction")).toBeGreaterThan(
      directed.indexOf(note),
    );
    expect(directed.endsWith("<direction>\nGolden hour on a rooftop.\n</direction>")).toBe(true);
  });

  it("artPrompt rides the look after the reference note and before the direction, and none for Auto", () => {
    expect(artPrompt(SOURCE, null)).toBe(SOURCE);
    const prompt = artPrompt(SOURCE, "Golden hour on a rooftop.", true, "film");
    const look = prompt.indexOf("<look>\nfilm\n</look>");
    expect(look).toBeGreaterThan(
      prompt.indexOf("The attached image is the card's current portrait."),
    );
    expect(look).toBeLessThan(prompt.indexOf("<direction>"));
    expect(prompt.endsWith("<direction>\nGolden hour on a rooftop.\n</direction>")).toBe(true);
  });
});

describe("image card", () => {
  const blocksOf = (text: string) => {
    const result = validateCardAnswer("subject", text);
    if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.problems)}`);
    return result;
  };

  it("names the attached image as the description, without notes", () => {
    const prompt = imageCardPrompt("subject", null, null);
    expect(prompt.startsWith("Create the subject shown in the attached image.")).toBe(true);
    expect(prompt).toContain("The image is the player's description.");
    expect(prompt).not.toContain("<notes>");
  });

  it("wraps the notes in <notes> after the paragraph and keeps the image-wins rule", () => {
    const prompt = imageCardPrompt("subject", "A placeholder baker, 30, in Testtown.", null);
    expect(prompt.startsWith(`${imageCardPrompt("subject", null, null)}\n\n`)).toBe(true);
    expect(prompt).toContain(
      "Where the notes and the image disagree about how the person looks, the image wins.",
    );
    expect(prompt.endsWith("<notes>\nA placeholder baker, 30, in Testtown.\n</notes>")).toBe(true);
  });

  it("sends the request and notes unchanged without a direction", () => {
    const notes = "A placeholder baker, 30, in Testtown.";
    expect(imageCardPrompt("subject", null, null)).toBe(
      [
        "Create the subject shown in the attached image. The image is the player's description.",
        "Read the person's apparent age, apparent ethnicity and phenotype, build, skin, face, eyes, hair and hairstyle, expression, visible marks, posture, setting and mood from it, and keep everything you write about their appearance consistent with what the image shows.",
        "Their clothing in it is one outfit: the description takes from it only the general style it suggests, never the outfit itself.",
        "Fill in everything the image cannot show, such as name, origin, history, personality, sexuality and way of speaking, with specific, coherent choices that fit the person in the image.",
      ].join(" "),
    );
    expect(imageCardPrompt("subject", notes, null)).toBe(
      `${imageCardPrompt("subject", null, null)}\n\nThe notes below are the image prompt that produced this picture. Treat them as part of the description. Take any name, age, occupation, place, relationship or trait they state and build on it. Words about the camera, lens, film, lighting, framing or image style describe the photograph, not the person, so leave them out of the card. Where the notes and the image disagree about how the person looks, the image wins.\n\n<notes>\n${notes}\n</notes>`,
    );
  });

  it("puts the owner's direction last, after the notes, ranked above them but not above the image's looks", () => {
    const notes = "A placeholder baker, 30, in Testtown.";
    const direction = "Make her a retired sea captain, gruff but kind.";
    const prompt = imageCardPrompt("subject", notes, direction);
    expect(prompt.startsWith(`${imageCardPrompt("subject", notes, null)}\n\n`)).toBe(true);
    expect(prompt).toContain("It is your primary direction");
    expect(prompt).toContain("before the notes and before any choice the image leaves open");
    expect(prompt).toContain(
      "Only where it contradicts what the image plainly shows about how the person looks does the image win",
    );
    expect(prompt).toContain(
      "The card's format, fields and rules stay exactly as the instructions say.",
    );
    expect(prompt.endsWith(`<direction>\n${direction}\n</direction>`)).toBe(true);
  });

  it("follows the request with the direction when there are no notes", () => {
    const direction = "Make her a retired sea captain, gruff but kind.";
    const prompt = imageCardPrompt("subject", null, direction);
    expect(
      prompt.startsWith(`${imageCardPrompt("subject", null, null)}\n\nThe owner's direction`),
    ).toBe(true);
    expect(prompt).not.toContain("<notes>");
    expect(prompt.endsWith(`<direction>\n${direction}\n</direction>`)).toBe(true);
  });

  it("finds nothing missing in a complete Subject answer", () => {
    const { card, blocks } = blocksOf(answer());
    expect(incompleteForAutomaticKeep("subject", card, blocks)).toEqual([]);
  });

  it("names empty creator notes the validator accepts", () => {
    const { card, blocks } = blocksOf(answer({ creatorNotes: " " }));
    expect(incompleteForAutomaticKeep("subject", card, blocks)).toEqual(["creatorNotes"]);
  });

  it("names each empty inner block by its subject", () => {
    const body = inner().replace(/<personality>.*<\/personality>/, "<personality> </personality>");
    const { card, blocks } = blocksOf(answer({ description: subject("bo_lind", body) }));
    expect(incompleteForAutomaticKeep("subject", card, blocks)).toEqual(["bo_lind.personality"]);
  });

  it("counts an inner block holding only empty tags as empty", () => {
    const body = inner().replace(
      /<personality>.*<\/personality>/,
      "<personality><x> </x></personality>",
    );
    const { card, blocks } = blocksOf(answer({ description: subject("bo_lind", body) }));
    expect(incompleteForAutomaticKeep("subject", card, blocks)).toEqual(["bo_lind.personality"]);
  });

  it.each([
    ["group", "Create the subjects shown in the attached image."],
    ["scenario", "Create the scenario this image opens onto."],
  ] as const)("asks for a %s card with its own request, notes and direction", (kind, opening) => {
    const notes = "A placeholder baker, 30, in Testtown.";
    const direction = "Make them retired sea captains.";
    const prompt = imageCardPrompt(kind, notes, direction);
    expect(prompt.startsWith(`${opening} The image is the player's description.`)).toBe(true);
    expect(prompt).toContain("describe the photograph, not the people or the world");
    expect(prompt).toContain("The owner's direction for this card follows.");
    expect(prompt).not.toContain(imageCardPrompt("subject", null, null));
    expect(prompt.endsWith(`<direction>\n${direction}\n</direction>`)).toBe(true);
  });

  describe("a Scenario's automatic keep", () => {
    const scenarioBlocks = (description: string) => {
      const result = validateCardAnswer("scenario", answer({ name: "Valley", description }));
      if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.problems)}`);
      return result;
    };

    it("finds nothing missing in a complete Scenario", () => {
      const { card, blocks } = scenarioBlocks(scenarioDescription());
      expect(incompleteForAutomaticKeep("scenario", card, blocks)).toEqual([]);
    });

    it("names each empty block", () => {
      const description = [
        "<Roleplay>\n</Roleplay>",
        "<Setting> </Setting>",
        "<People></People>",
        "<Tone>Quiet placeholder mood.</Tone>",
      ].join("\n");
      const { card, blocks } = scenarioBlocks(description);
      const empty = incompleteForAutomaticKeep("scenario", card, blocks);
      expect(empty).toEqual(["Roleplay", "Setting", "People"]);
      expect(cardRetryPrompt([], empty).split("\n").slice(1, 4)).toEqual([
        "- The <Roleplay> block is empty.",
        "- The <Setting> block is empty.",
        "- The <People> block is empty.",
      ]);
    });
  });

  it("names what the automatic keep found empty in the retry, after the validator's problems", () => {
    const prompt = cardRetryPrompt(
      [{ code: "missing", section: "firstMessage" }],
      ["creatorNotes", "bo_lind.personality"],
    );
    expect(prompt.split("\n").slice(0, 4)).toEqual([
      "Your card does not follow the required format:",
      "- The <firstMessage> section is missing or empty.",
      "- The <creatorNotes> section is missing or empty.",
      "- The <personality> block of <bo_lind> is empty.",
    ]);
    expect(cardRetryPrompt([{ code: "missing", section: "firstMessage" }], [])).toBe(
      cardRetryPrompt([{ code: "missing", section: "firstMessage" }]),
    );
  });

  it("has no delta event and a closed set of error codes", () => {
    expect(creatorImageCardEventSchema.safeParse({ type: "delta", text: "x" }).success).toBe(false);
    expect(creatorImageCardEventSchema.safeParse({ type: "error", code: "comfyui" }).success).toBe(
      false,
    );
    expect(creatorImageCardEventSchema.parse({ type: "error", code: "invalid_card" })).toEqual({
      type: "error",
      code: "invalid_card",
    });
    expect(
      creatorImageCardEventSchema.safeParse({
        type: "result",
        id: "00000000-0000-4000-8000-000000000004",
        name: "Ada Reed",
      }).success,
    ).toBe(true);
  });
});
