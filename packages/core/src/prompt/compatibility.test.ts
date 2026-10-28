import { describe, expect, it } from "vitest";
import { CPU_BOUND_TEST_TIMEOUT_MS, cpuMs } from "../../test-fixtures/cpu.ts";
import { PLAIN_MAIN_PROMPT, plainPromptPreset } from "../../test-fixtures/preset.ts";
import { blankCard } from "../card/index.ts";
import { chatTurnSchema, generateRequestSchema } from "../chat.ts";
import { DEFAULT_MAIN_PROMPT } from "../preset/defaults.ts";
import {
  type AssemblyInput,
  assemblePrompt,
  fillChatText,
  flatten,
  macroContext,
} from "./assemble.ts";
import { fitPrompt } from "./budget.ts";
import { cardGreetingChoices } from "./greetings.ts";
import { cloneMacroState, emptyMacroState, MACRO_STATE_LIMITS } from "./macro-state.ts";
import {
  AggregateMacroLimitError,
  createMacroWorkBudget,
  MAX_MACRO_OUTPUT,
  MAX_MACRO_WORK,
  MacroLimitError,
} from "./macros.ts";

const base = (): AssemblyInput => ({
  preset: plainPromptPreset(),
  character: blankCard("Vale"),
  persona: { name: "Mira", description: "" },
  history: [{ role: "user", content: "Hello" }],
  clock: { now: 0, timeZone: "UTC" },
  pickSeed: 0,
  random: () => 0,
});

describe("display scan text boundary", () => {
  it("accepts requests without scan text and only accepts string scan text on macro-eligible assistant turns", () => {
    const request = {
      model: "m",
      clock: base().clock,
      pickSeed: base().pickSeed,
      messages: [{ role: "user", content: "Hi" }],
    };
    expect(generateRequestSchema.safeParse(request).success).toBe(true);
    const turn = { role: "assistant", content: "{{char}}", macroEligible: true, scanText: "Vale" };
    expect(chatTurnSchema.parse(turn)).toEqual(turn);
    for (const invalid of [
      { ...turn, role: "user" },
      { ...turn, macroEligible: false },
      { role: "assistant", content: "Vale", scanText: "Vale" },
      { ...turn, scanText: 1 },
      { ...turn, scanText: null },
    ])
      expect(chatTurnSchema.safeParse(invalid).success).toBe(false);
  });
});

const main = (input: AssemblyInput, content: string) => ({
  ...input.preset,
  blocks: input.preset.blocks.map((block) =>
    block.kind === "text" && block.id === "main" ? { ...block, content } : block,
  ),
});

describe("memory-only macro lifecycle", () => {
  it(
    "bounds intermediate indexed work across generated history and starts fresh for each request",
    () => {
      const input = base();
      const macroState = emptyMacroState();
      macroState.local.collection = JSON.stringify({ text: "x".repeat(65_000) });
      const content = "{{setvarkey::collection::key::value}}".repeat(100);
      const one = { role: "assistant" as const, content, macroEligible: true };
      const request = { ...input, macroState, history: [one, one, one] };
      const { ms } = cpuMs(() => {
        expect(() => assemblePrompt(request)).toThrow(AggregateMacroLimitError);
      });
      expect(ms).toBeLessThan(1_000);
      expect(assemblePrompt({ ...request, history: [one] }).macroState?.local.collection).toContain(
        '"key":"value"',
      );
      expect(macroState.local.collection).not.toContain('"key"');
      expect(() => assemblePrompt(request)).toThrow(AggregateMacroLimitError);
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );

  it("shares work before example preparation and through nested field evaluation", () => {
    const input = base();
    const macroState = emptyMacroState();
    macroState.local.collection = JSON.stringify({ text: "x".repeat(65_000) });
    const setters = "{{setvarkey::collection::key::value}}";
    const character = { ...blankCard("Vale"), exampleDialogue: setters.repeat(300) };
    expect(() => fillChatText("Hi", { ...input, character, macroState })).toThrow(
      AggregateMacroLimitError,
    );
    const nested = { ...blankCard("Vale"), description: setters.repeat(70) };
    expect(() =>
      fillChatText("{{description}}".repeat(4), { ...input, character: nested, macroState }),
    ).toThrow(AggregateMacroLimitError);
    const budget = createMacroWorkBudget();
    const action = { ...input, macroState };
    expect(fillChatText(setters.repeat(100), action, budget).content).toBe("");
    expect(fillChatText(setters.repeat(100), action, budget).content).toBe("");
    expect(() => fillChatText(setters.repeat(100), action, budget)).toThrow(
      AggregateMacroLimitError,
    );
    expect(fillChatText(setters.repeat(100), action).content).toBe("");
  });

  it("clones both namespaces for every assembly, including previews", () => {
    const input = base();
    const macroState = emptyMacroState();
    macroState.local.counter = "4";
    macroState.global.counter = "9";
    const request = {
      ...input,
      macroState,
      preset: main(input, "{{incvar::counter}}/{{incglobalvar::counter}}"),
    };
    const first = assemblePrompt(request);
    const second = assemblePrompt(request);
    expect(flatten(first)[0]?.content).toBe("5/10");
    expect(flatten(second)[0]?.content).toBe("5/10");
    expect(macroState.local.counter).toBe("4");
    expect(macroState.global.counter).toBe("9");
    expect(first.macroState?.local.counter).toBe("5");
    expect(first.macroState).not.toBe(second.macroState);
  });

  it("fills new user text once and preserves existing history literally", () => {
    const input = base();
    const created = fillChatText("{{incvar::input}} Hello {{user}}", input);
    expect(created.content).toBe("1 Hello Mira");
    const assembled = assemblePrompt({
      ...input,
      macroState: created.macroState,
      history: [
        { role: "user", content: created.content },
        { role: "user", content: "literal {{incvar::input}}" },
      ],
      preset: main(input, "INPUT={{getvar::input}}"),
    });
    expect(flatten(assembled)[0]?.content).toBe("INPUT=1");
    expect(flatten(assembled).at(-1)?.content).toBe("literal {{incvar::input}}");
    expect(created.macroState.local.input).toBe("1");
  });

  it("evaluates greeting candidates independently and commits neither to the caller", () => {
    const input = base();
    const macroState = emptyMacroState();
    const choices = cardGreetingChoices({
      ...input,
      macroState,
      character: {
        ...blankCard("Vale"),
        firstMessage: "{{incvar::greeting}} Hello",
        alternateGreetings: ["{{incvar::greeting}} Welcome"],
      },
    });
    expect(choices.map((choice) => choice.content)).toEqual(["1 Hello", "1 Welcome"]);
    expect(choices.map((choice) => choice.macroState.local.greeting)).toEqual(["1", "1"]);
    expect(macroState.local.greeting).toBeUndefined();
  });

  it("keeps the original greeting key after blank greetings are excluded", () => {
    const input = base();
    const choices = cardGreetingChoices({
      ...input,
      character: {
        ...blankCard("Vale"),
        firstMessage: "",
        alternateGreetings: ["One", "{{setvar::hidden::yes}}", "Three"],
      },
    });
    expect(choices.map(({ key, content }) => ({ key, content }))).toEqual([
      { key: "card:1", content: "One" },
      { key: "card:3", content: "Three" },
    ]);
    expect(choices.every((choice) => choice.macroState.local.hidden === undefined)).toBe(true);
  });

  it("commits model display effects once, then expands only marked raw model history", () => {
    const input = base();
    const raw = "Reply {{incvar::output}} USER={{user}}";
    const received = fillChatText(raw, input);
    expect(received.content).toBe("Reply 1 USER=Mira");
    const assembly = assemblePrompt({
      ...input,
      macroState: received.macroState,
      preset: main(input, "OUTPUT={{getvar::output}}"),
      history: [
        { role: "assistant", content: "Greeting {{incvar::output}}" },
        { role: "user", content: "Literal {{incvar::output}}" },
        { role: "assistant", content: raw, macroEligible: true },
        { role: "user", content: "Again" },
      ],
    });
    const messages = flatten(assembly);
    expect(messages[0]?.content).toBe("OUTPUT=1");
    expect(
      messages
        .filter((message) => message.source.kind === "history")
        .map((message) => message.content),
    ).toEqual([
      "Greeting {{incvar::output}}",
      "Literal {{incvar::output}}",
      "Reply 2 USER=Mira",
      "Again",
    ]);
    expect(assembly.macroState?.local.output).toBe("2");
    expect(received.macroState.local.output).toBe("1");
    fitPrompt({ assembly, budget: 100, count: () => 1, priming: 0, calibration: 1 });
    flatten(assembly);
    expect(assembly.macroState?.local.output).toBe("2");
  });

  it("retains an empty displayed model reply's raw setter in history", () => {
    const input = base();
    const raw = "{{incvar::hidden-output}}{{trim}}";
    // A setter has no visible output; incvar returns its new value.
    const setter = "{{setvar::hidden-output::saved}}";
    const received = fillChatText(setter, input);
    expect(received.content).toBe("");
    const assembly = assemblePrompt({
      ...input,
      macroState: received.macroState,
      history: [
        { role: "assistant", content: setter, macroEligible: true },
        { role: "user", content: raw },
      ],
    });
    expect(
      flatten(assembly)
        .filter((message) => message.source.kind === "history")
        .map((message) => message.content),
    ).toEqual(["", raw]);
    expect(assembly.macroState?.local["hidden-output"]).toBe("saved");
  });

  it("keeps edited prefixes literal while expanding reasoning before the generated suffix", () => {
    const input = base();
    const literal = "  Edited {{incvar::edited}}{{trim}} \\{{char}}  ";
    const raw = "Generated {{incvar::generated}}";
    const preset = main(input, "Main");
    preset.reasoning = { ...preset.reasoning, addToPrompts: true, maxAdditions: 1 };
    const history = [
      {
        role: "assistant" as const,
        content: literal + raw,
        macroEligible: true,
        macroPrefixLength: literal.length,
        reasoning: "Reason {{incvar::thought}} SEEN={{getvar::generated}}",
      },
      { role: "user" as const, content: "Next" },
    ];
    const first = assemblePrompt({ ...input, preset, history });
    const message = (assembly: ReturnType<typeof assemblePrompt>) =>
      flatten(assembly).find((turn) => turn.role === "assistant")?.content;
    expect(message(first)).toBe(`<think>Reason 1 SEEN=</think>\n${literal}Generated 1`);
    expect(first.macroState?.local.edited).toBeUndefined();
    const second = assemblePrompt({
      ...input,
      preset,
      history,
      macroState: first.macroState ?? emptyMacroState(),
    });
    expect(message(second)).toBe(`<think>Reason 2 SEEN=1</think>\n${literal}Generated 2`);
    expect(second.macroState?.local.edited).toBeUndefined();
    expect(first.macroState?.local.generated).toBe("1");
  });

  it("rolls back a newly exhausted model turn, including nested metadata setters, and keeps generating", () => {
    const input = base();
    input.character = { ...blankCard("Vale"), description: "{{incglobalvar::metadata}}" };
    const initial = emptyMacroState();
    initial.local.counter = "1";
    initial.local.blob = "";
    initial.global.marker = "9";
    initial.global.metadata = "0";
    const raw =
      "{{setvar::counter::bad}}{{setglobalvar::marker::bad}}{{description}}{{addvar::blob::x}}";
    // The same raw reply originally expanded successfully on receipt.
    const received = fillChatText(raw, { ...input, macroState: initial });
    expect(received.macroState.local.blob).toBe("x");
    const exhausted = cloneMacroState(initial);
    exhausted.local.blob = "x".repeat(MACRO_STATE_LIMITS.value);
    const history = [
      { role: "assistant" as const, content: raw, macroEligible: true },
      { role: "assistant" as const, content: "Safe {{incvar::counter}}", macroEligible: true },
      { role: "user" as const, content: "Next" },
    ];
    const preset = main(input, "CURRENT={{getvar::counter}}/{{getglobalvar::marker}}");
    const first = assemblePrompt({ ...input, preset, history, macroState: exhausted });
    expect(
      flatten(first)
        .filter((turn) => turn.source.kind === "history")
        .map(({ content }) => content),
    ).toEqual([raw, "Safe 2", "Next"]);
    expect(first.macroState?.global.marker).toBe("9");
    expect(first.macroState?.global.metadata).toBe("1");
    expect(first.macroState?.local.blob).toBe(exhausted.local.blob);
    expect(exhausted.local.counter).toBe("1");
    expect(exhausted.global.metadata).toBe("0");
    const later = assemblePrompt({
      ...input,
      preset,
      history,
      macroState: first.macroState ?? emptyMacroState(),
    });
    expect(flatten(later)[0]?.content).toBe("CURRENT=2/9");
    expect(later.macroState?.local.counter).toBe("3");
    expect(later.macroState?.global.metadata).toBe("2");
    expect(later.macroState?.global.marker).toBe("9");
  });

  it("retains bounded raw text on per-turn output overflow without committing an earlier setter", () => {
    const input = base();
    const macroState = emptyMacroState();
    macroState.local.blob = "x".repeat(MACRO_STATE_LIMITS.value);
    const raw = `{{setvar::partial::bad}}${"{{getvar::blob}}".repeat(17)}`;
    const assembled = assemblePrompt({
      ...input,
      macroState,
      history: [
        { role: "assistant", content: raw, macroEligible: true },
        { role: "user", content: "Next" },
      ],
    });
    expect(flatten(assembled).find((turn) => turn.role === "assistant")?.content).toBe(raw);
    expect(assembled.macroState?.local.partial).toBeUndefined();
    expect(assembled.macroState?.local.blob).toBe(macroState.local.blob);
  });

  it("does not swallow aggregate bounds when failed expansions fall back to raw text", () => {
    const input = base();
    const raw = "x".repeat(MAX_MACRO_OUTPUT + 1);
    const history = Array.from({ length: Math.ceil(MAX_MACRO_WORK / raw.length) }, () => ({
      role: "assistant" as const,
      content: raw,
      macroEligible: true,
    }));
    expect(() => assemblePrompt({ ...input, history })).toThrow(MacroLimitError);
  });

  it("does not swallow cumulative card-field work limits inside a failed model turn", () => {
    const input = base();
    input.character = { ...blankCard("Vale"), description: "x".repeat(100_000) };
    const history = Array.from({ length: 40 }, () => ({
      role: "assistant" as const,
      content: "{{description}}".repeat(11),
      macroEligible: true,
    }));
    expect(() => assemblePrompt({ ...input, history })).toThrow(MacroLimitError);
  });

  it("still refuses preset overflows, malformed state and non-macro failures", () => {
    const input = base();
    const macroState = emptyMacroState();
    macroState.local.blob = "x".repeat(MACRO_STATE_LIMITS.value);
    expect(() =>
      assemblePrompt({ ...input, macroState, preset: main(input, "{{getvar::blob}}".repeat(17)) }),
    ).toThrow(MacroLimitError);
    expect(() =>
      assemblePrompt({
        ...input,
        macroState: { local: { invalid: "x".repeat(MACRO_STATE_LIMITS.value + 1) }, global: {} },
        history: [{ role: "assistant", content: "Raw", macroEligible: true }],
      }),
    ).toThrow("Invalid macro state");
    const failure = new Error("Synthetic random failure");
    expect(() =>
      assemblePrompt({
        ...input,
        random: () => {
          throw failure;
        },
        history: [{ role: "assistant", content: "{{roll::1d6}}", macroEligible: true }],
      }),
    ).toThrow(failure);
  });

  it("bounds aggregate generated history expansion across individually valid turns", () => {
    const input = base();
    const macroState = emptyMacroState();
    macroState.local.blob = "x".repeat(64 * 1024);
    const history = Array.from({ length: 520 }, () => ({
      role: "assistant" as const,
      content: "{{getvar::blob}}",
      macroEligible: true,
    }));
    expect(() => assemblePrompt({ ...input, macroState, history })).toThrow(MacroLimitError);
    expect(macroState.local.blob.length).toBe(64 * 1024);
  });

  it("bounds aggregate prompt block expansion before retaining an oversized text pass", () => {
    const input = base();
    const macroState = emptyMacroState();
    macroState.local.blob = "x".repeat(64 * 1024);
    const preset = main(input, "Main");
    preset.blocks.splice(
      1,
      0,
      ...Array.from({ length: 34 }, (_, index) => ({
        kind: "custom" as const,
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        name: "Large",
        role: "system" as const,
        content: "{{getvar::blob}}".repeat(16),
        enabled: true,
        depth: null,
      })),
    );
    expect(() => assemblePrompt({ ...input, preset, macroState })).toThrow(MacroLimitError);
    expect(macroState.local.blob.length).toBe(64 * 1024);
  });

  it("does not evaluate unused card fields or background prompt recounts on text receipt", () => {
    const input = base();
    input.character = { ...blankCard("Vale"), description: "{{incvar::description}}" };
    const sent = fillChatText("Plain user text", input);
    expect(sent.macroState.local.description).toBeUndefined();
    const preset = main(input, "TURN={{incvar::turn}}");
    const first = assemblePrompt({ ...input, preset, macroState: sent.macroState });
    const reply = fillChatText("Plain model text", {
      ...input,
      macroState: first.macroState ?? emptyMacroState(),
    });
    expect(reply.macroState.local.turn).toBe("1");
    const second = assemblePrompt({ ...input, preset, macroState: reply.macroState });
    expect(flatten(second)[0]?.content).toBe("TURN=2");
  });

  it("skips inactive trigger setters before evaluation", () => {
    const input = base();
    const preset = main(input, "{{setvar::value::normal}}");
    const block = preset.blocks.find((entry) => entry.kind === "text" && entry.id === "main");
    if (block?.kind !== "text") throw new Error("missing main");
    block.triggers = ["normal"];
    const assembly = assemblePrompt({ ...input, preset, generationType: "swipe" });
    expect(assembly.macroState?.local.value).toBeUndefined();
    expect(assembly.generationType).toBe("swipe");
  });
});

describe("card source preparation and metadata lookup", () => {
  it("prepares sources before text, resolves raw fields at use, and prepares persona source after text", () => {
    const input = base();
    input.character = {
      ...blankCard("Vale"),
      description: "DESCRIPTION={{incvar::desc}} STYLE={{getvar::style}}",
      personality: "PERSONALITY={{incvar::personality}} STYLE={{getvar::style}}",
      scenario: "SCENARIO={{incvar::scenario}} STYLE={{getvar::style}}",
    };
    input.persona = {
      name: "Mira",
      description: "PERSONA={{incvar::persona}} STYLE={{getvar::style}}",
    };
    const preset = main(
      input,
      "{{setvar::style::main}}MAIN={{getvar::desc}}/{{getvar::personality}}/{{getvar::scenario}}/{{getvar::persona}}",
    );
    preset.blocks = preset.blocks.map((block) =>
      block.id === "charPersonality"
        ? { ...block, enabled: false }
        : block.kind === "text" && block.id === "postHistory"
          ? {
              ...block,
              enabled: true,
              content:
                "POST={{getvar::desc}}/{{getvar::personality}}/{{getvar::scenario}}/{{getvar::persona}}",
            }
          : block,
    );
    preset.blocks.splice(1, 0, {
      kind: "custom",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Metadata",
      role: "system",
      depth: null,
      enabled: true,
      content:
        "META-D={{description}} META-P={{personality}} META-S={{scenario}} META-U={{persona}}",
    });
    const first = assemblePrompt({ ...input, preset });
    const messages = flatten(first);
    const source = (id: string) =>
      messages.find((message) => message.source.kind === "block" && message.source.id === id)
        ?.content;
    expect(source("main")).toBe("MAIN=1/1/1/1");
    expect(messages.find((message) => message.source.kind === "custom")?.content).toBe(
      "META-D=DESCRIPTION=2 STYLE=main META-P=PERSONALITY=2 STYLE=main META-S=SCENARIO=2 STYLE=main META-U=PERSONA=2 STYLE=main",
    );
    expect(source("charDescription")).toBe("DESCRIPTION=1 STYLE=");
    expect(source("scenario")).toBe("SCENARIO=1 STYLE=");
    expect(source("personaDescription")).toBe("PERSONA=3 STYLE=main");
    expect(source("postHistory")).toBe("POST=2/2/2/2");
    const second = assemblePrompt({
      ...input,
      preset,
      macroState: first.macroState ?? emptyMacroState(),
    });
    const next = flatten(second);
    expect(next[0]?.content).toBe("MAIN=3/3/3/4");
    expect(
      next.find((message) => message.source.kind === "block" && message.source.id === "postHistory")
        ?.content,
    ).toBe("POST=4/4/4/5");
    expect(second.macroState?.local).toMatchObject({
      desc: "4",
      personality: "4",
      scenario: "4",
      persona: "6",
      style: "main",
    });
  });

  it("uses a blind context for crossfield references and exposes reasoning tags with parsing off", () => {
    const input = base();
    input.character = {
      ...blankCard("Vale"),
      description: "DESCRIPTION={{personality}}/{{persona}}",
      scenario: "SCENARIO={{description}}",
    };
    input.preset.reasoning = { ...input.preset.reasoning, tag: "analysis", autoParse: false };
    expect(
      fillChatText(
        "{{description}}/{{scenario}} {{reasoningPrefix}}body{{reasoningSuffix}}[{{reasoningSeparator}}]",
        input,
      ).content,
    ).toBe("DESCRIPTION=//SCENARIO= <analysis>body</analysis>[\n]");
  });
});

describe("preset message compatibility", () => {
  it("prefixes past personas only under the default names setting", () => {
    const input = base();
    const assembly = assemblePrompt({
      ...input,
      history: [
        { role: "user", name: "Old Mira", content: "Earlier" },
        { role: "user", name: "Mira", content: "Now" },
      ],
    });
    expect(
      flatten(assembly)
        .filter((message) => message.source.kind === "history")
        .map((message) => message.content),
    ).toEqual(["Old Mira: Earlier", "Now"]);
  });
});

describe("prompt template fields", () => {
  it("provides raw preferred/default system prompts and the preset's note without recursive expansion", () => {
    const input = base();
    const character = {
      ...blankCard("Vale"),
      systemPrompt: "CARD [{{original}}]",
      postHistoryInstructions: "INSTRUCTIONS [{{original}}]",
    };
    const preset = {
      ...input.preset,
      authorsNote: {
        enabled: true,
        text: "SESSION {{user}}",
        position: "afterMain" as const,
        depth: 4,
        role: "system" as const,
        frequency: 1,
      },
    };
    const context = macroContext({ ...input, character, preset });
    expect(context.systemPrompt).toBe("CARD [{{original}}]");
    expect(context.defaultSystemPrompt).toBe(DEFAULT_MAIN_PROMPT);
    expect(context.authorsNote).toBe("SESSION {{user}}");
    const filled = fillChatText("{{systemPrompt}}/{{postHistoryInstructions}}/{{authorsNote}}", {
      ...input,
      character,
      preset,
    });
    expect(filled.content).toBe("CARD [{{original}}]/INSTRUCTIONS [{{original}}]/SESSION {{user}}");
    const fallback = macroContext({
      ...input,
      character,
      prefer: { preferCharacterPrompt: false, preferCharacterInstructions: false },
    });
    expect(fallback.systemPrompt).toBe(PLAIN_MAIN_PROMPT);
    expect(fallback.characterSystemPrompt).toBe("");
  });
});
