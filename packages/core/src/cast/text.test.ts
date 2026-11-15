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
        outfit: "blue denim work shirt, black jeans, brown boots",
        disarray: "shirt unbuttoned to the waist, sleeves rolled up",
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
        disarray: "",
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

const HEADER =
  "Every NPC's card or initial baseline, the player excepted and minor figures in brief: preserve these details unless current durable overrides in Cast now take precedence for changed fields.";

/** The register with the minor in the scene, her anchor filled further. */
const withMinorPresent = (): CastRegister => ({
  entries: register.entries.map((entry) =>
    entry.role === "minor"
      ? {
          ...entry,
          anchor: { ...entry.anchor, hair: "long black braid", eyes: "grey almond-shaped eyes" },
          state: { ...entry.state, present: true },
        }
      : entry,
  ),
});

describe("the register as the narrator reads it", () => {
  it("writes the <cast> block: a principal's whole anchor under its keys, a minor's identity", () => {
    expect(castAnchorsText(register)).toBe(
      [
        "<cast>",
        HEADER,
        "Jonas Reyes; gender: male; age: 34 years old; ethnicity: Mexican-American; skin: warm tan skin; face: square face, broken nose, thin lips; experience: experienced; relationship: divorced; height: 183cm; weight: 88kg; build: broad; hair: short black curls; eyes: dark brown hooded eyes; personality: dry, protective; fetishes: none; taboos: none",
        "Ana Pires; gender: female; age: looks 20, is 300 years; build: willowy",
        "</cast>",
      ].join("\n"),
    );
  });

  it("leaves an unknown gender out and a minor's other fields to Cast now", () => {
    const text = castAnchorsText({
      entries: withMinorPresent().entries.map((entry) => ({
        ...entry,
        anchor: { ...entry.anchor, gender: "other" as const },
      })),
    });
    expect(text).toContain("\nJonas Reyes; age: 34 years old;");
    expect(text).toContain(
      "\nAna Pires; age: looks 20, is 300 years; build: willowy; hair: long black braid\n",
    );
    expect(text).not.toContain("Portuguese");
    expect(text).not.toContain("grey almond-shaped eyes");
  });

  it("writes the Cast now message with the present entries' state under its keys and the away ones by name", () => {
    expect(castStateText(register)).toBe(
      "[Cast now:\nJonas Reyes; present; outfit: blue denim work shirt, black jeans, brown boots; disarray: shirt unbuttoned to the waist, sleeves rolled up; position: behind the bar; activity: polishing a glass; mood: amused; injuries: bruised knuckles; intoxication: two beers in\nAway: Ana Pires]",
    );
  });

  it("gives a present minor's remaining anchor fields in Cast now, as they stand", () => {
    const present = withMinorPresent();
    expect(castStateText(present)).toContain(
      "\nAna Pires; present; outfit: red coat\nAna Pires details: ethnicity: Portuguese; eyes: grey almond-shaped eyes]",
    );
    const developed: CastRegister = {
      entries: present.entries.map((entry) => ({
        ...entry,
        developments: { eyes: "one eye lost" },
      })),
    };
    expect(castStateText(developed)).toContain(
      "Ana Pires details: ethnicity: Portuguese; eyes: one eye lost]",
    );
    // A principal's whole anchor is in <cast>: no details line.
    expect(castStateText(developed)).not.toContain("Jonas Reyes details");
  });

  it("opens the message with the lag when the register was read before the newest reply", () => {
    expect(castStateText(register, true)).toMatch(
      /^\[Cast now, recorded before the latest reply; where the latest turns differ, they win:\nJonas Reyes; present; /,
    );
    expect(castStateText(register, false)).toMatch(/^\[Cast now:\n/);
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
      "Jonas Reyes current durable overrides: hair: cropped hair\n",
    );
    // The precedence rule is stated once, in the <cast> header.
    expect(castStateText(developed)).not.toContain("authoritative");
  });

  it("writes nothing for an empty register", () => {
    expect(castAnchorsText({ entries: [] })).toBe("");
    expect(castStateText({ entries: [] })).toBe("");
  });

  it("gives a scene picture the present entries' looks, clothes as they are worn and state", () => {
    expect(castPeopleNotes(register)).toBe(
      "Jonas Reyes, 34 years old, Mexican-American, warm tan skin, square face, broken nose, thin lips, 183cm, 88kg, broad, short black curls, dark brown hooded eyes, blue denim work shirt, black jeans, brown boots, shirt unbuttoned to the waist, sleeves rolled up, behind the bar, polishing a glass, amused, bruised knuckles",
    );
  });
});
