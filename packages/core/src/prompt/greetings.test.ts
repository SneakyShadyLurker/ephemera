import { describe, expect, it } from "vitest";
import { CPU_BOUND_TEST_TIMEOUT_MS, cpuMs } from "../../test-fixtures/cpu.ts";
import { blankCard, CARD_LIMITS } from "../card/index.ts";
import { cardGreetingChoices, greetingCandidates, MEMORY_GREETING } from "./greetings.ts";
import { emptyMacroState, MACRO_STATE_LIMITS } from "./macro-state.ts";

const clock = { now: Date.UTC(2026, 8, 29, 19, 42), timeZone: "UTC" };

const greetingContents = (input: Parameters<typeof cardGreetingChoices>[0]) =>
  cardGreetingChoices(input).map((choice) => choice.content);

describe("cardGreetingChoices", () => {
  it("keeps completed choices and stops an indexed-macro batch at the shared work bound", () => {
    const macroState = emptyMacroState();
    macroState.local.collection = JSON.stringify({ text: "x".repeat(65_000) });
    const heavy = "{{setvarkey::collection::key::value}}".repeat(100);
    const character = {
      ...blankCard("Mara"),
      firstMessage: "Hi",
      alternateGreetings: [
        " ",
        `${heavy}{{incvar::count}} One`,
        `${heavy}{{incvar::count}} Two`,
        `${heavy} Three`,
        "Tail",
      ],
    };
    const input = { character, macroState, persona: null, clock, pickSeed: 0, random: () => 0 };
    const choices = cardGreetingChoices(input);
    expect(choices.map(({ content, key }) => [content, key])).toEqual([
      ["Hi", "card:0"],
      ["1 One", "card:2"],
      ["1 Two", "card:3"],
    ]);
    expect(choices.slice(1).map(({ macroState }) => macroState.local.count)).toEqual(["1", "1"]);
    expect(macroState.local.count).toBeUndefined();
    expect(macroState.local.collection).not.toContain('"key"');
    expect(cardGreetingChoices(input)).toEqual(choices);
  });

  it(
    "stops a card that rereads its fields over a full variable state within a second",
    () => {
      const sets = Array.from(
        { length: MACRO_STATE_LIMITS.variables - 1 },
        (_, index) => `{{setvar::v${index}::x}}`,
      ).join("");
      const field = "{{personality}}";
      const greeting = `{{description}}${field.repeat(
        Math.floor((CARD_LIMITS.textLength - 15) / field.length),
      )}`;
      const character = {
        ...blankCard("Mara"),
        description: sets,
        personality: "p",
        firstMessage: greeting,
        alternateGreetings: Array.from({ length: 29 }, () => greeting),
      };
      const { ms } = cpuMs(() =>
        cardGreetingChoices({ character, persona: null, clock, pickSeed: 0, random: () => 0 }),
      );
      expect(ms).toBeLessThan(1_000);
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it("keeps every greeting of a valid card whose example dialogue is long", () => {
    const character = {
      ...blankCard("Mara"),
      exampleDialogue: `<START>\n{{setvar::seen::yes}}${"x".repeat(250_000)}`,
      firstMessage: "Hi",
      alternateGreetings: Array.from({ length: 200 }, (_, index) => `Greeting ${index}`),
    };
    const choices = cardGreetingChoices({
      character,
      persona: null,
      clock,
      pickSeed: 0,
      random: () => 0,
    });
    expect(choices).toHaveLength(201);
    expect(choices.every(({ macroState }) => macroState.local.seen === "yes")).toBe(true);
    expect(new Set(choices.map(({ macroState }) => macroState)).size).toBe(201);
  });

  it("lists the first message, then the alternates, with macros filled", () => {
    const character = {
      ...blankCard("Mara Voss"),
      nickname: "Mara",
      firstMessage: "{{user}}, you're late. It's {{time}}.",
      alternateGreetings: ["{{char}} waves at {{user}}.", "Again, {{USER}}?"],
    };
    expect(
      greetingContents({
        character,
        persona: { name: "Ash", description: "" },
        clock,
        pickSeed: 0,
        random: () => 0,
      }),
    ).toEqual(["Ash, you're late. It's 7:42 PM.", "Mara Voss waves at Ash.", "Again, Ash?"]);
  });

  it("leaves out empty greetings and uses 'User' without a persona", () => {
    const character = {
      ...blankCard("Mara"),
      firstMessage: "  ",
      alternateGreetings: ["", "Hello, {{user}}."],
    };
    expect(
      greetingContents({ character, persona: null, clock, pickSeed: 0, random: () => 0 }),
    ).toEqual(["Hello, User."]);
  });

  it("gives nothing for a card without greetings", () => {
    expect(
      greetingContents({
        character: blankCard("Mara"),
        persona: null,
        clock,
        pickSeed: 0,
        random: () => 0,
      }),
    ).toEqual([]);
  });

  it("ignores unused hostile card fields, but bounds a greeting that references them", () => {
    const character = {
      ...blankCard("x".repeat(200)),
      description: "{{char}}".repeat(6_000),
      firstMessage: "Hi.",
    };
    expect(
      greetingContents({ character, persona: null, clock, pickSeed: 0, random: () => 0 }),
    ).toEqual(["Hi."]);
    expect(
      greetingContents({
        character: { ...character, firstMessage: "{{description}}" },
        persona: null,
        clock,
        pickSeed: 0,
        random: () => 0,
      }),
    ).toEqual([]);
  });

  it("leaves out a greeting whose macros pass the output bound", () => {
    const character = {
      ...blankCard("Mara"),
      description: "x".repeat(200_000),
      firstMessage: "{{description}}".repeat(8),
      alternateGreetings: ["Hi."],
    };
    expect(
      greetingContents({ character, persona: null, clock, pickSeed: 0, random: () => 0 }),
    ).toEqual(["Hi."]);
  });
});

describe("the memory's opening among the greetings", () => {
  const character = {
    ...blankCard("Mara"),
    firstMessage: "Hi, {{user}}.",
    alternateGreetings: ["", "Back again?"],
  };
  const opening = "> Location: The pier, dawn\n\nMara waits beside {{user}} at the rail.";
  const base = { persona: { name: "Ash", description: "" }, clock, pickSeed: 0, random: () => 0 };

  it("lists the card's greetings by their place in the card, the opening first when it has one", () => {
    expect(greetingCandidates(character)).toEqual([
      { text: "Hi, {{user}}.", key: "card:0" },
      { text: "", key: "card:1" },
      { text: "Back again?", key: "card:2" },
    ]);
    expect(greetingCandidates(character, opening)).toEqual([
      { text: opening, key: MEMORY_GREETING },
      { text: "Hi, {{user}}.", key: "card:0" },
      { text: "", key: "card:1" },
      { text: "Back again?", key: "card:2" },
    ]);
    // A blank opening is none, so the card's keys never move.
    expect(greetingCandidates(character, "  \n")).toEqual(greetingCandidates(character));
  });

  it("opens on the filled opening, the card's greetings following as swipes", () => {
    const choices = cardGreetingChoices({ ...base, character, opening });
    expect(choices.map(({ content, key, rawText }) => [content, key, rawText])).toEqual([
      ["> Location: The pier, dawn\n\nMara waits beside Ash at the rail.", "memory", opening],
      ["Hi, Ash.", "card:0", "Hi, {{user}}."],
      ["Back again?", "card:2", "Back again?"],
    ]);
  });

  it("gives the card's greetings alone without an opening", () => {
    const choices = cardGreetingChoices({ ...base, character });
    expect(choices.map(({ content, key }) => [content, key])).toEqual([
      ["Hi, Ash.", "card:0"],
      ["Back again?", "card:2"],
    ]);
    expect(cardGreetingChoices({ ...base, character, opening: " " })).toEqual(choices);
  });

  it("fills the opening on its own work budget, and skips it alone past its bound", () => {
    const heavy = "{{setvarkey::collection::key::value}}".repeat(100);
    const card = {
      ...blankCard("Mara"),
      firstMessage: "Hi",
      alternateGreetings: [`${heavy}{{incvar::count}} One`, `${heavy}{{incvar::count}} Two`],
    };
    const state = () => {
      const macroState = emptyMacroState();
      macroState.local.collection = JSON.stringify({ text: "x".repeat(65_000) });
      return macroState;
    };
    const input = { ...base, character: card, macroState: state() };
    const cardOnly = cardGreetingChoices(input).map(({ content }) => content);
    expect(cardOnly).toEqual(["Hi", "1 One", "1 Two"]);
    // A heavy opening spends none of the card greetings' budget.
    const spent = cardGreetingChoices({ ...input, macroState: state(), opening: `${heavy}Here.` });
    expect(spent.map(({ content }) => content)).toEqual(["Here.", ...cardOnly]);
    // A hostile one past its own bound is left out, and the card's greetings open the chat.
    const hostile = cardGreetingChoices({
      ...input,
      macroState: state(),
      opening: heavy.repeat(4),
    });
    expect(hostile.map(({ content, key }) => [content, key])).toEqual([
      ["Hi", "card:0"],
      ["1 One", "card:1"],
      ["1 Two", "card:2"],
    ]);
  });
});
