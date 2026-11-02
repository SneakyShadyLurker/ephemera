import { describe, expect, it } from "vitest";
import {
  BRAINSTORM_CLASSIFY_PROMPT,
  BRAINSTORM_MORE,
  BRAINSTORM_PROMPTS,
  BRAINSTORM_UNITS,
  type BrainstormOption,
  brainstormAnswerLines,
  brainstormMessages,
  brainstormReader,
  brainstormRetryPrompt,
  brainstormSwitchLine,
  CREATOR_LIMITS,
  creatorBrainstormEventSchema,
  creatorBrainstormRequestSchema,
  NO_EM_DASHES,
  parseBrainstormAnswer,
  parseBrainstormKind,
  parseBrainstormOption,
  pitchKey,
} from "./index.ts";
import { contentPolicy } from "./prompts.ts";

const KINDS = ["subject", "group", "scenario"] as const;

const option = (n: number, round = 1): BrainstormOption => ({
  pitch: `Idea ${n}, round ${round}: a placeholder pitch.`,
  brief: `A placeholder brief for idea ${n} of round ${round}.`,
});
const line = (value: BrainstormOption) => JSON.stringify(value);
const ten = (round = 1) => Array.from({ length: 10 }, (_, i) => option(i + 1, round));
const answerOf = (options: BrainstormOption[]) => options.map((o) => `${line(o)}\n`).join("");

describe("brainstorm prompts", () => {
  it("carry no em dash and keep the shared rule word for word", () => {
    expect(NO_EM_DASHES).toBe("Never use em dashes, which read as machine prose.");
    for (const prompt of [BRAINSTORM_CLASSIFY_PROMPT, ...Object.values(BRAINSTORM_PROMPTS)]) {
      expect(prompt).not.toContain("—");
    }
  });

  it("ask each kind for exactly ten ideas under the request's content policy, and differ", () => {
    for (const kind of KINDS) {
      const prompt = BRAINSTORM_PROMPTS[kind];
      expect(prompt).toContain(contentPolicy("the request"));
      expect(prompt).toContain("exactly ten");
      expect(prompt).toContain(NO_EM_DASHES);
      expect(prompt).toContain("written as a request the player could have typed");
      expect(prompt).toContain(BRAINSTORM_UNITS[kind]);
    }
    expect(new Set(Object.values(BRAINSTORM_PROMPTS)).size).toBe(3);
  });

  it("write the subject prompt as approved", () => {
    expect(BRAINSTORM_PROMPTS.subject).toBe(
      `You brainstorm ideas for a private text-based roleplay app, in which another language model plays one character across a long session. The player says what they are in the mood for, in a few words or a paragraph, and you answer with exactly ten distinct ideas for a Subject card: one person to meet, each one a card the app can then write in full. Write what the request calls for directly and completely, including sexual, violent or dark material. No disclaimers, warnings, commentary, softening, or omissions. Use ages as given.

Each idea is one person: who they are, their situation and what makes them worth meeting, never a list of traits. Keep every idea inside the request: honour every constraint it gives, such as period, place, tone, age, relationship, kink or genre, and leave open what it leaves open. Make the ten differ in premise, not in wording: vary age, origin, trade, temperament, situation and the way they and {{user}} meet, so the player has a real choice. Prefer the particular over the typical: a named place, a specific trade, one telling detail. Invent no plot, secrets or outcomes; an idea is a starting point, not a story. Where the player belongs in the idea, call them {{user}}.

Write two texts for each idea. The pitch is one sentence of at most 20 words that the player reads to choose, in plain words, with no title and no label before a colon. The brief is the description the app writes the card from: two to five sentences written as a request the player could have typed, saying who the person is, their age and background, their temperament and situation, and how they and {{user}} come to meet, and repeating every constraint the player gave, so the brief stands on its own without this conversation. Plain prose, present tense, no headings, no lists and no markdown. Never use em dashes, which read as machine prose.

When the player answers with feedback, write a fresh list of ten that follows it: keep the ideas they want kept, in the places they number, word for word, and replace the others; carry the changes they ask for across the rest. Every idea stays a Subject card: one person to meet, whatever the feedback asks for; the player changes the kind with a control of their own.

Answer with exactly ten lines and nothing else: no numbering, no fence and no text before or after. Each line is one JSON object with two string fields, pitch and brief, in that order, as in {"pitch":"...","brief":"..."}.`,
    );
  });

  it("ask the classifier for exactly one word, without the first-words rule", () => {
    expect(BRAINSTORM_CLASSIFY_PROMPT).toBe(
      "You sort a player's request for a private text-based roleplay app into the kind of card it asks for. The app writes three kinds. subject: one person to meet. group: two or three specific people who come as a set, such as a pair, a trio, a family or a crew. scenario: a place, time, situation, premise, genre or mood to step into, where no particular person is the point and the people are left open. Read the request and answer with exactly one word in lowercase, subject, group or scenario, and nothing else. A request centred on one person is subject even when it mentions others around them. Sort every request as given, whatever its content, with no comment.",
    );
    expect(BRAINSTORM_CLASSIFY_PROMPT).toContain("exactly one word");
    expect(BRAINSTORM_CLASSIFY_PROMPT).not.toContain("first words");
  });
});

describe("parseBrainstormKind", () => {
  it.each([
    ["subject", "subject"],
    ["  Group\n", "group"],
    ["scenario.", "scenario"],
    ["I would say this is a subject.", "subject"],
    ["Not a group, a scenario", "scenario"],
  ] as const)("reads %j as %s", (answer, kind) => {
    expect(parseBrainstormKind(answer)).toBe(kind);
  });

  it.each(["maybe a person", "", "subjects"])("names no kind in %j", (answer) => {
    expect(parseBrainstormKind(answer)).toBeNull();
  });
});

describe("pitchKey", () => {
  it("compares pitches trimmed, lowercased and with inner whitespace collapsed", () => {
    expect(pitchKey("  A Night   Porter\twho knows ")).toBe(pitchKey("a night porter who knows"));
    expect(pitchKey("a night porter")).not.toBe(pitchKey("a day porter"));
  });
});

describe("parseBrainstormOption", () => {
  const one = option(1);

  it.each([
    ["plain", line(one)],
    ["numbered", `3. ${line(one)}`],
    ["numbered with a parenthesis", `3) ${line(one)}`],
    ["bulleted", `- ${line(one)}`],
    ["starred", `* ${line(one)}`],
    ["indented, with an array's comma", `  ${line(one)},`],
    ["an array's first", `[${line(one)},`],
    ["an array's last", `${line(one)} ]`],
    ["a one-element array", `[ ${line(one)} ],`],
  ])("reads a %s line", (_, text) => {
    expect(parseBrainstormOption(text)).toEqual(one);
  });

  it.each([
    ["a fence line", "```json"],
    ["a closing fence", "```"],
    ["invalid JSON", '{"pitch":"A pitch","brief":'],
    ["prose", "Here are ten ideas:"],
    ["an empty pitch", JSON.stringify({ pitch: " ", brief: "A brief." })],
    ["a missing brief", JSON.stringify({ pitch: "A pitch." })],
    ["an extra field", JSON.stringify({ ...one, title: "A title" })],
  ])("refuses %s", (_, text) => {
    expect(parseBrainstormOption(text)).toBeNull();
  });

  it("takes a long brief whole and refuses one past the description length, never cutting it", () => {
    const longest = "b".repeat(CREATOR_LIMITS.descriptionLength);
    expect(parseBrainstormOption(line({ pitch: "A pitch.", brief: longest }))).toEqual({
      pitch: "A pitch.",
      brief: longest,
    });
    expect(parseBrainstormOption(line({ pitch: "A pitch.", brief: `${longest}b` }))).toBeNull();
  });

  it("reads a line with a long whitespace run inside it in linear time", () => {
    // A backtracking trailing pattern took seconds on a few thousand spaces and stalled the server.
    const spaced = { pitch: `a${" ".repeat(10_000)}b`, brief: "c" };
    const started = performance.now();
    expect(parseBrainstormOption(line(spaced))).toEqual(spaced);
    expect(parseBrainstormOption(`${line(spaced)}${" ".repeat(10_000)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("brainstormReader", () => {
  it("accepts ideas as their lines complete, across pushes split mid-line", () => {
    const reader = brainstormReader();
    const text = answerOf([option(1), option(2)]);
    const cut = line(option(1)).length + 10;
    expect(reader.push(text.slice(0, 15))).toEqual([]);
    expect(reader.push(text.slice(15, cut))).toEqual([option(1)]);
    expect(reader.push(text.slice(cut))).toEqual([option(2)]);
    expect(reader.end()).toEqual([]);
    expect(reader.options).toEqual([option(1), option(2)]);
  });

  it("skips a duplicate pitch by its key", () => {
    const reader = brainstormReader();
    const again = { pitch: `  ${option(1).pitch.toUpperCase()} `, brief: "Another brief." };
    expect(reader.push(answerOf([option(1), again, option(2)]))).toEqual([option(1), option(2)]);
  });

  it("flushes a last line without a newline on end", () => {
    const reader = brainstormReader();
    expect(reader.push(line(option(1)))).toEqual([]);
    expect(reader.end()).toEqual([option(1)]);
    expect(reader.options).toEqual([option(1)]);
  });

  it("stops accepting at ten", () => {
    const reader = brainstormReader();
    const twelve = Array.from({ length: 12 }, (_, i) => option(i + 1));
    expect(reader.push(answerOf(twelve))).toHaveLength(10);
    expect(reader.options).toEqual(twelve.slice(0, 10));
  });
});

describe("parseBrainstormAnswer", () => {
  it("is ok with ten ideas", () => {
    expect(parseBrainstormAnswer(answerOf(ten()))).toEqual({ ok: true, options: ten() });
  });

  it("is not ok with nine", () => {
    expect(parseBrainstormAnswer(answerOf(ten().slice(0, 9)))).toEqual({
      ok: false,
      options: ten().slice(0, 9),
    });
  });

  it("keeps the first ten of twelve", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => option(i + 1));
    expect(parseBrainstormAnswer(answerOf(twelve))).toEqual({ ok: true, options: ten() });
  });

  it("reads a fenced, numbered answer", () => {
    const fenced = ["```json", ...ten().map((o, i) => `${i + 1}. ${line(o)}`), "```"].join("\n");
    expect(parseBrainstormAnswer(fenced)).toEqual({ ok: true, options: ten() });
  });

  it("reads an answer written as one pretty-printed array, deduplicated", () => {
    const array = JSON.stringify([...ten(), { ...option(4), brief: "A repeat." }], null, 2);
    expect(parseBrainstormAnswer(`Here they are:\n\`\`\`json\n${array}\n\`\`\``)).toEqual({
      ok: true,
      options: ten(),
    });
  });

  it("reads a compact array written one element per line, first and last on the brackets' lines", () => {
    const compact = `[${ten().map(line).join(",\n")}]`;
    expect(parseBrainstormAnswer(compact)).toEqual({ ok: true, options: ten() });
  });

  it("finds no idea in prose", () => {
    expect(parseBrainstormAnswer("I cannot think of any.")).toEqual({ ok: false, options: [] });
  });
});

describe("brainstormAnswerLines", () => {
  it("writes one object per line, pitch first", () => {
    expect(brainstormAnswerLines([option(1), option(2)])).toBe(
      `${line(option(1))}\n${line(option(2))}`,
    );
    expect(brainstormAnswerLines([{ brief: "B.", pitch: "P." } as BrainstormOption])).toBe(
      '{"pitch":"P.","brief":"B."}',
    );
  });
});

describe("brainstorm messages", () => {
  const REQUEST = "Something slow and tense in a snowed-in hotel.";

  it("send a first round as the request alone", () => {
    expect(brainstormMessages(REQUEST, [], "subject")).toEqual([
      { role: "user", content: REQUEST },
    ]);
  });

  it("send a round with feedback as the request, its lines and the feedback", () => {
    const rounds = [{ kind: "scenario" as const, options: ten(), feedback: "Keep 3 and 7." }];
    expect(brainstormMessages(REQUEST, rounds, "scenario")).toEqual([
      { role: "user", content: REQUEST },
      { role: "assistant", content: brainstormAnswerLines(ten()) },
      { role: "user", content: "Keep 3 and 7." },
    ]);
  });

  it("name the next list's kind after each switch, and the requested kind after the last", () => {
    const rounds = [
      { kind: "subject" as const, options: ten(1) },
      { kind: "group" as const, options: ten(2) },
    ];
    expect(brainstormMessages(REQUEST, rounds, "scenario")).toEqual([
      { role: "user", content: REQUEST },
      { role: "assistant", content: brainstormAnswerLines(ten(1)) },
      {
        role: "user",
        content:
          "Same request, as ideas for a Multiple Subjects card: two or three people who come as a set instead: ten new ideas.",
      },
      { role: "assistant", content: brainstormAnswerLines(ten(2)) },
      {
        role: "user",
        content:
          "Same request, as ideas for a Scenario card: a world or situation to step into, its people left open instead: ten new ideas.",
      },
    ]);
    expect(brainstormSwitchLine("group")).toBe(
      `Same request, as ideas for ${BRAINSTORM_UNITS.group} instead: ten new ideas.`,
    );
  });

  it("ask for ten new ideas when a round of the same kind had no feedback", () => {
    const rounds = [{ kind: "subject" as const, options: ten() }];
    expect(brainstormMessages(REQUEST, rounds, "subject").at(-1)).toEqual({
      role: "user",
      content: BRAINSTORM_MORE,
    });
    expect(BRAINSTORM_MORE).toBe("Ten new ideas, none of them repeating the ones above.");
  });

  it("count the usable ideas in the retry turn", () => {
    const rest =
      "instead of ten. Write the whole list again: exactly ten lines, each one JSON object with the string fields pitch and brief, and nothing else.";
    expect(brainstormRetryPrompt(0)).toBe(`Your answer held no usable ideas ${rest}`);
    expect(brainstormRetryPrompt(1)).toBe(`Your answer held one usable idea ${rest}`);
    expect(brainstormRetryPrompt(9)).toBe(`Your answer held 9 usable ideas ${rest}`);
  });
});

describe("brainstorm schemas", () => {
  const request = { description: "A mood.", model: "fake-model", rounds: [] };
  const round = { kind: "subject", options: [option(1)] };

  it("classify a request without a kind and without rounds", () => {
    expect(creatorBrainstormRequestSchema.safeParse(request).success).toBe(true);
    expect(creatorBrainstormRequestSchema.safeParse({ ...request, kind: "group" }).success).toBe(
      true,
    );
  });

  it("require the kind with rounds", () => {
    expect(creatorBrainstormRequestSchema.safeParse({ ...request, rounds: [round] }).success).toBe(
      false,
    );
    expect(
      creatorBrainstormRequestSchema.safeParse({ ...request, kind: "subject", rounds: [round] })
        .success,
    ).toBe(true);
  });

  it("carry at most the rounds' limit", () => {
    const rounds = (n: number) => Array.from({ length: n }, () => round);
    const with_ = (n: number) =>
      creatorBrainstormRequestSchema.safeParse({ ...request, kind: "subject", rounds: rounds(n) })
        .success;
    expect(with_(CREATOR_LIMITS.brainstormRounds)).toBe(true);
    expect(with_(CREATOR_LIMITS.brainstormRounds + 1)).toBe(false);
  });

  it("bound a round's list and its feedback", () => {
    const parse = (value: object) =>
      creatorBrainstormRequestSchema.safeParse({ ...request, kind: "subject", rounds: [value] })
        .success;
    expect(parse({ ...round, options: [] })).toBe(false);
    expect(parse({ ...round, options: Array.from({ length: 11 }, (_, i) => option(i)) })).toBe(
      false,
    );
    expect(parse({ ...round, feedback: "f".repeat(CREATOR_LIMITS.descriptionLength) })).toBe(true);
    expect(parse({ ...round, feedback: "f".repeat(CREATOR_LIMITS.descriptionLength + 1) })).toBe(
      false,
    );
  });

  it("bound a pitch and a brief by the description length alone", () => {
    const at = "x".repeat(CREATOR_LIMITS.descriptionLength);
    const ok = (value: BrainstormOption) =>
      creatorBrainstormEventSchema.safeParse({ type: "option", index: 0, option: value }).success;
    expect(ok({ pitch: at, brief: at })).toBe(true);
    expect(ok({ pitch: `${at}x`, brief: "B." })).toBe(false);
    expect(ok({ pitch: "P.", brief: `${at}x` })).toBe(false);
  });

  it("place an option at 0 to 9 and refuse index 10", () => {
    const event = (index: number) =>
      creatorBrainstormEventSchema.safeParse({ type: "option", index, option: option(1) }).success;
    expect(event(0)).toBe(true);
    expect(event(9)).toBe(true);
    expect(event(10)).toBe(false);
    expect(event(-1)).toBe(false);
  });

  it("carry a result of one to ten and the error codes", () => {
    const result = (n: number) =>
      creatorBrainstormEventSchema.safeParse({ type: "result", options: ten().slice(0, n) })
        .success;
    expect(result(0)).toBe(false);
    expect(result(1)).toBe(true);
    expect(result(10)).toBe(true);
    for (const code of ["kind_unclear", "unusable", "too_large", "upstream_busy"]) {
      expect(creatorBrainstormEventSchema.safeParse({ type: "error", code }).success).toBe(true);
    }
    expect(creatorBrainstormEventSchema.safeParse({ type: "kind", kind: "group" }).success).toBe(
      true,
    );
  });
});
