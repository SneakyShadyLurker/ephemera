import { describe, expect, it } from "vitest";
import { blankCard } from "../card/index.ts";
import { CAST_LIMITS } from "./limits.ts";
import {
  castCanon,
  KEEPER_OPENING,
  keeperInstructions,
  keeperMessage,
  SHEET_OPENING,
  sheetInstructions,
  sheetMessage,
  sheetShortfall,
} from "./prompt.ts";
import {
  castChangesSchema,
  clampCastChanges,
  emptyCastAnchor,
  emptyCastState,
} from "./register.ts";

const names = { char: "Mara", user: "Ash" };
const register = {
  entries: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      role: "principal" as const,
      anchor: { ...emptyCastAnchor("Mara Battin", "female"), age: "18" },
      aka: [],
      state: { ...emptyCastState(true), mood: "nervous" },
    },
  ],
};
const turns = [
  { role: "assistant" as const, content: "Mara waits at the stop." },
  { role: "user" as const, content: "I sit beside her." },
];

const message = (canon: string | null, full = false) =>
  keeperMessage({ canon, names, register, turns, mode: "update", full });

describe("the keeper prompt", () => {
  it("keeps the instructions identical across calls, opening with KEEPER_OPENING", () => {
    expect(keeperInstructions()).toBe(keeperInstructions());
    expect(keeperInstructions().startsWith(KEEPER_OPENING)).toBe(true);
  });

  it("asks for every garment worn and the state the clothes are in", () => {
    const instructions = keeperInstructions();
    expect(instructions).toMatch(/- "outfit": every garment they have on now/);
    expect(instructions).toMatch(/- "disarray": the state of their clothes/);
    expect(instructions.indexOf('"outfit"')).toBeLessThan(instructions.indexOf('"disarray"'));
  });

  it("orders canon, player, register and turns, then the task", () => {
    const text = message("Description:\nMara keeps the light.");
    const at = ["<canon>", "<player>", "<register>", "<turn>", "Answer with what changed."].map(
      (part) => text.indexOf(part),
    );
    expect(at.every((index) => index !== -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("The player is Ash: never an entry.");
    expect(text).toContain("Mara: Mara waits at the stop.\nAsh: I sit beside her.");
    expect(text).toContain('"name":"Mara Battin"');
    expect(text).not.toContain("00000000-0000");
    expect(text).not.toContain("The register is full");
  });

  it("leaves canon out when there is none, and says when the register is full", () => {
    const text = message(null, true);
    expect(text).not.toContain("<canon>");
    expect(text.startsWith("<player>")).toBe(true);
    expect(text).toContain("The register is full: add no one; update and mark absent only.");
  });

  it("writes whole only who is in the scene or named in the turns; the rest by name, role and gender", () => {
    const away = (id: number, name: string, more: object = {}) => ({
      id: `00000000-0000-4000-8000-00000000000${id}`,
      role: "minor" as const,
      anchor: { ...emptyCastAnchor(name, "male"), hair: `hair of ${name}` },
      aka: [],
      state: { ...emptyCastState(false), outfit: `outfit of ${name}` },
      ...more,
    });
    const text = keeperMessage({
      canon: null,
      names,
      register: {
        entries: [
          ...register.entries,
          away(2, "Jonas Reyes", {
            introduced: true,
            aka: ["Jo"],
            continuity: { goals: "sell the bar" },
          }),
          away(3, "Tomas Vidal"),
          away(4, "Ash Okoro"),
        ],
      },
      turns: [
        { role: "assistant" as const, content: "Mara waits. Tomas is late again, she says." },
        { role: "user" as const, content: "I shrug.", name: "Ash" },
      ],
      mode: "update",
      full: false,
    });
    // Present: whole. Named by his given name: whole, though away.
    expect(text).toContain(
      '"name":"Mara Battin","role":"principal","gender":"female","anchor":{"age":"18"}',
    );
    expect(text).toContain('"hair":"hair of Tomas Vidal"');
    expect(text).toContain('"outfit":"outfit of Tomas Vidal"');
    // Away and unnamed: identity alone. The player's name names no entry.
    expect(text).toContain(
      '{"name":"Jonas Reyes","role":"minor","gender":"male","aka":["Jo"],"introduced":true}',
    );
    expect(text).toContain('{"name":"Ash Okoro","role":"minor","gender":"male"}');
    expect(text).not.toContain("hair of Jonas Reyes");
    expect(text).not.toContain("sell the bar");
    expect(keeperInstructions()).toContain(
      'Everyone else is listed by "name", "role" and "gender" alone',
    );
  });

  it("asks a seed call to set who is present", () => {
    expect(
      keeperMessage({ canon: null, names, register, turns, mode: "seed", full: false }),
    ).toContain("This is the opening.");
  });

  it("keeps canonical truth and gradual player discovery distinct, and names a Scenario", () => {
    const existing = register.entries[0];
    if (existing === undefined) throw new Error("Expected the fixture's entry");
    const discovered = {
      ...register,
      entries: [
        {
          ...existing,
          introduced: true,
          discovered: {
            age: { value: "late teens", basis: "seen" as const, evidence: "Mara waits" },
          },
        },
      ],
    };
    const text = keeperMessage({
      canon: null,
      names,
      register: discovered,
      turns,
      mode: "update",
      full: false,
      kind: "Scenario",
    });
    expect(text).toContain("Kind: Scenario");
    expect(text).toContain('"introduced":true');
    expect(text).toContain('"discovered":{"age":{"value":"late teens","basis":"seen"}}');
    expect(text).not.toContain("test discovery");
    // The role rule is the instructions' own, for every kind of card: no call repeats it.
    expect(text).not.toContain("starts minor");
    expect(keeperInstructions()).toContain("A new NPC starts minor");
    expect(keeperInstructions()).toContain('"principal" is a continuing figure');
    // An introduction brings its discoveries along: a model otherwise sends the one without the other.
    expect(keeperInstructions()).toContain('goes under "discovered" in the same change');
    expect(keeperInstructions()).toContain("A new minor gets the looks alone");
    expect(keeperInstructions()).toContain("complete the anchor in the same answer");
    expect(keeperInstructions()).toContain("Invented canon is not player discovery");
    expect(keeperInstructions()).toContain("Intimate anatomy requires actual exposure");
  });

  it("records a clothed figure as what the clothes suggest, and garments that shape it", () => {
    const instructions = keeperInstructions();
    expect(instructions).toContain(
      'Before exposure, a discovered "build" holds the figure as the clothes show it, chest, hips and ass included',
    );
    expect(instructions).toContain("which may be false");
    expect(instructions).toContain('refine "build" without the clothed guess');
    expect(instructions).toContain('how it shapes the body, such as "padded push-up bra"');
  });

  it("describes every key before the answer's shape, and shows an introduction in its example", () => {
    const instructions = keeperInstructions();
    const shape = instructions.indexOf("Return one JSON object with exactly these keys:");
    const example = instructions.indexOf("For example");
    for (const key of [
      '- "developments":',
      '- "continuity":',
      '- "introduce":',
      '- "discovered":',
    ]) {
      expect(instructions.indexOf(key)).toBeGreaterThan(-1);
      expect(instructions.indexOf(key)).toBeLessThan(shape);
    }
    expect(shape).toBeLessThan(example);
    const shown = instructions.slice(example);
    expect(shown).toContain('"introduce":{"evidence":');
    expect(shown).toContain('"discovered":{"build":{"value":');
    expect(
      instructions.endsWith(
        "Answer with the JSON object alone, with nothing before or after it and no code fence.",
      ),
    ).toBe(true);
  });

  it("asks for everyone not yet introduced, a card's subjects included", () => {
    const instructions = keeperInstructions();
    expect(instructions).toContain('The register marks who is introduced with "introduced": true.');
    expect(instructions).toContain("a card's own subjects included");
    expect(
      keeperMessage({ canon: null, names, register, turns, mode: "seed", full: false }),
    ).toContain("introduce everyone it shows the player");
  });

  it("builds canon from the card's fields with the names filled, null when blank", () => {
    const card = { ...blankCard("Mara"), description: "{{char}} meets {{user}}." };
    expect(castCanon(card, names)).toBe("Description:\nMara meets Ash.");
    expect(castCanon(blankCard("Mara"), names)).toBeNull();
  });
});

describe("the sheet prompt", () => {
  it("keeps the instructions identical across calls, opening with SHEET_OPENING", () => {
    expect(sheetInstructions()).toBe(sheetInstructions());
    expect(sheetInstructions().startsWith(SHEET_OPENING)).toBe(true);
  });

  it("asks again only for an answer short of what the card's kind promises", () => {
    const card = { ...blankCard("Mara"), description: "Mara and Lena share a flat." };
    const group = { ...card, tags: ["Multiple Subjects"] };
    const subject = { ...card, tags: ["Subject"] };
    expect(sheetShortfall(group, 0)).toContain("this answer records no one");
    expect(sheetShortfall(group, 1)).toContain("its two or three people");
    expect(sheetShortfall(group, 2)).toBeNull();
    expect(sheetShortfall(subject, 0)).toContain("the one person it is about");
    expect(sheetShortfall(subject, 1)).toBeNull();
    expect(sheetShortfall({ ...card, tags: ["Scenario"] }, 0)).toBeNull();
    expect(sheetShortfall({ ...card, tags: ["romance"] }, 0)).toBeNull();
    expect(sheetShortfall({ ...group, description: "  " }, 0)).toBeNull();
  });

  it("names the card's kind, or none, and keeps {{user}} as written", () => {
    const card = { ...blankCard("Mara"), description: "{{char}} waits for {{user}}." };
    expect(sheetMessage({ ...card, tags: ["Multiple Subjects"] })).toContain(
      "Kind: Multiple Subjects",
    );
    const untagged = sheetMessage({ ...card, tags: ["romance"] });
    expect(untagged).toContain("Kind: none");
    expect(untagged).toContain("Mara waits for {{user}}.");
  });
});

describe("the keeper's and sheet's shared rules", () => {
  const both = [keeperInstructions(), sheetInstructions()];

  it("says how to clear a state field and that an omitted one stays", () => {
    const instructions = keeperInstructions();
    expect(instructions).toContain("Every entry, key and field you leave out stays as it is");
    expect(instructions).toContain('a state field that no longer holds is sent as ""');
  });

  it("takes whoever gets a state as present, so someone only spoken of gets none", () => {
    expect(keeperInstructions()).toContain(
      "Whoever you give a state is taken as present, so someone the turns only speak of gets no state, and a new NPC in the scene always gets one.",
    );
  });

  it("states both field bounds and that a longer value is cut", () => {
    for (const instructions of both) {
      expect(instructions).toContain(`at most ${CAST_LIMITS.field} characters`);
      expect(instructions).toContain(`"intimate" at most ${CAST_LIMITS.longField}`);
      expect(instructions).toContain("a longer one is cut");
    }
    expect(keeperInstructions()).toContain(
      `"outfit" and "disarray" at most ${CAST_LIMITS.longField}`,
    );
  });

  it("puts a source's stated facts into the field's form, adding none", () => {
    for (const instructions of both) {
      expect(instructions).toContain("Record only what the source states and add nothing.");
      expect(instructions).toContain("a stated cup size converted to EU");
      expect(instructions).toContain('such as "in her forties"');
      expect(instructions).toContain("Where it gives no height or weight, leave them empty.");
      expect(instructions).not.toContain("copying its words exactly");
      expect(instructions).not.toContain("Never overwrite an owner's corrected field");
    }
  });

  it("shows a clear, someone only spoken of and a continuity cue in an example that parses", () => {
    const instructions = keeperInstructions();
    const example = instructions.slice(instructions.indexOf("For example")).split("\n")[1] ?? "";
    const answer = castChangesSchema.parse(clampCastChanges(JSON.parse(example)));
    expect(answer).toEqual(castChangesSchema.parse(JSON.parse(example)));
    expect(answer.cast["Mara Battin"]?.state?.intoxication).toBe("");
    expect(answer.cast["Mara Battin"]?.continuity?.goals?.value).toBeTruthy();
    expect(answer.cast["Ana Pires"]).toEqual({
      gender: "female",
      introduce: { evidence: "my sister Ana" },
    });
  });
});
