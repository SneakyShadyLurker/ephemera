import { describe, expect, it } from "vitest";
import type { CastRegister } from "./register.ts";
import { castAnchorsText, castPeopleNotes, castStateText } from "./text.ts";

const register: CastRegister = {
  entries: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      role: "principal",
      anchor: {
        name: "Jonas Reyes",
        gender: "male",
        age: "34",
        ethnicity: "Mexican-American",
        skin: "warm tan skin",
        face: "square face, broken nose, thin lips",
        experience: "experienced",
        relationship: "divorced",
        height: "183cm",
        weight: "88kg",
        build: "broad",
        hair: "short black curls",
        eyes: "dark brown hooded eyes",
        intimate: "",
        personality: "dry, protective",
        fetishes: "fetishes: none; taboos: none",
      },
      aka: [],
      state: {
        present: true,
        outfit: "work shirt open",
        position: "behind the bar",
        activity: "polishing a glass",
        mood: "amused",
        arousal: "",
        injuries: "bruised knuckles",
        intoxication: "two beers in",
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      role: "minor",
      anchor: {
        name: "Ana Pires",
        gender: "female",
        age: "looks 20, is 300 years",
        ethnicity: "Portuguese",
        skin: "",
        face: "",
        experience: "",
        relationship: "",
        height: "",
        weight: "",
        build: "willowy",
        hair: "",
        eyes: "",
        intimate: "",
        personality: "",
        fetishes: "",
      },
      aka: [],
      state: {
        present: false,
        outfit: "red coat",
        position: "",
        activity: "",
        mood: "",
        arousal: "",
        injuries: "",
        intoxication: "",
      },
    },
  ],
};

describe("the register as the narrator reads it", () => {
  it("writes the <cast> block with every entry's anchor, outfit and state left out", () => {
    expect(castAnchorsText(register)).toBe(
      [
        "<cast>",
        "Every NPC's card or initial baseline, the player excepted. Preserve these details unless current durable overrides in Cast now take precedence for changed fields; the current state is in the chat.",
        "Jonas Reyes, 34 years old, Mexican-American, warm tan skin, square face, broken nose, thin lips, experienced, divorced, 183cm, 88kg, broad, short black curls, dark brown hooded eyes, dry, protective, fetishes: none; taboos: none",
        "Ana Pires, looks 20, is 300 years, Portuguese, willowy",
        "</cast>",
      ].join("\n"),
    );
  });

  it("writes the Cast now line with the present entries' state and the away ones by name", () => {
    expect(castStateText(register)).toBe(
      "[Cast now:\nJonas Reyes: present, work shirt open, behind the bar, polishing a glass, amused, bruised knuckles, two beers in\nAway: Ana Pires]",
    );
  });

  it("keeps baseline bytes stable while Cast now carries durable overrides", () => {
    const developed: CastRegister = {
      entries: register.entries.map((entry) => ({
        ...entry,
        developments: { hair: "cropped hair" },
      })),
    };
    expect(castAnchorsText(developed)).toBe(castAnchorsText(register));
    expect(castStateText(developed)).toContain(
      "current durable overrides (authoritative over <cast> baseline for these fields): hair: cropped hair",
    );
  });

  it("writes nothing for an empty register", () => {
    expect(castAnchorsText({ entries: [] })).toBe("");
    expect(castStateText({ entries: [] })).toBe("");
  });

  it("gives a scene picture the present entries' looks and state", () => {
    expect(castPeopleNotes(register)).toBe(
      "Jonas Reyes, 34 years old, Mexican-American, warm tan skin, square face, broken nose, thin lips, 183cm, 88kg, broad, short black curls, dark brown hooded eyes, work shirt open, behind the bar, polishing a glass, amused, bruised knuckles",
    );
  });
});
