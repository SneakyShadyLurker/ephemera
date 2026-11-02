import { describe, expect, it, vi } from "vitest";
import { defaultPromptPreset } from "../../packages/core/src/preset/prompt.ts";
import {
  type ComparisonFetch,
  estimatedPrefix,
  messages,
  numericUsage,
  parseOptions,
  runComparison,
  usageTotals,
} from "./compare.ts";
import {
  CONCISE_NOTE,
  comparisonPreset,
  FIXTURE_IDS,
  fixture,
  loreFixture,
  score,
} from "./fixtures.ts";

const args = ["--model", "example/model-1"];
const env = {
  EPHEMERA_UPSTREAM_BASE_URL: "https://synthetic.invalid/v1",
  EPHEMERA_UPSTREAM_API_KEY: "SYNTHETIC_PRIVATE_KEY",
};
const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 80 },
  completion_tokens_details: { reasoning_tokens: 3 },
};
const reply = (text: string, finish = "stop", counters: unknown = usage) =>
  Response.json({
    choices: [{ finish_reason: finish, message: { content: text } }],
    usage: counters,
  });
const answers = [
  "Rook, your ferry leaves at nine tonight.",
  "I am married to Ilse; my hair is short.",
  "I know the timetable, but you never told me your code.",
  'Mara rests her bandaged ankle. "We have time."',
];
const privateMark = "PRIVATE_RESPONSE_AND_REASONING_MARKER";

describe("synthetic prompt comparison", () => {
  it("defaults to offline without environment reads, network or output samples", async () => {
    const fetch = vi.fn<ComparisonFetch>();
    const report = await runComparison(args, {
      fetch,
      env: new Proxy(
        {},
        {
          get: () => {
            throw new Error("environment read");
          },
        },
      ),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      code: "offline",
      calls: 0,
      plannedCalls: 20,
      quality: "not_run",
      repetitions: 2,
    });
    expect(JSON.stringify(report)).not.toMatch(
      /742913|Rook|Ilse|sprained|SYNTHETIC_PRIVATE_KEY|https:|\/Users\//,
    );
  });

  it.each([
    [],
    [...args, "--live", "--repetitions", "0"],
    [...args, "--repetitions", "4"],
    [...args, "--repetitions", "3", "--max-calls", "24"],
    [...args, "--max-calls", "25"],
    [...args, "--max-calls", "19"],
    [...args, "--timeout-ms", "75001"],
    [...args, "--deadline-ms", "1800001"],
    [...args, "--output-cap", "4096"],
    [...args, "--temperature", "NaN"],
    [...args, "--top-p", "0"],
    [...args, "--reasoning", "fictional"],
    [...args, "--caching", "true"],
    [...args, "--model", "another"],
    ["--model", "model:forced-provider"],
  ])("refuses unsafe or impossible arguments before inference: %j", async (...input) => {
    const fetch = vi.fn<ComparisonFetch>();
    const report = await runComparison(input, { env, fetch });
    expect(report).not.toHaveProperty("code", "finished");
    expect(report).not.toHaveProperty("code", "offline");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts bounded controls and refuses missing credentials without calls", async () => {
    expect(
      parseOptions([
        ...args,
        "--repetitions",
        "1",
        "--max-calls",
        "12",
        "--output-cap",
        "2048",
        "--reasoning",
        "provider-default",
        "--temperature",
        "0.7",
        "--top-p",
        "0.8",
      ]),
    ).toMatchObject({ repetitions: 1, outputCap: 2048, settings: { temperature: 0.7, topP: 0.8 } });
    expect(parseOptions([...args, "--reasoning", "provider-default"]).settings).not.toHaveProperty(
      "reasoning",
    );
    expect(await runComparison([...args, "--live"], { env: {} })).toMatchObject({
      code: "upstream_environment_required",
      calls: 0,
    });
  });

  it("changes only the note and measures a shorter assembled prompt for every probe", async () => {
    const current = defaultPromptPreset();
    expect(comparisonPreset("current")).toEqual(current);
    expect(comparisonPreset("concise")).toEqual({
      ...current,
      authorsNote: { ...current.authorsNote, text: CONCISE_NOTE },
    });
    const report = await runComparison(args);
    expect("diagnostics" in report && report.diagnostics).toHaveLength(4);
    if (!("diagnostics" in report)) throw new Error("missing diagnostics");
    for (const row of report.diagnostics)
      expect(row.conciseEstimatedPromptTokens).toBeLessThan(row.currentEstimatedPromptTokens);
    const input = fixture("developments", "current");
    expect(input.cast?.entries[0]).toMatchObject({
      anchor: { hair: "long brown hair", relationship: "single" },
      developments: { hair: "short brown hair", relationship: "married to Ilse" },
      continuity: {
        voice: expect.any(String),
        goals: expect.any(String),
        knowledge: expect.any(String),
      },
    });
    const wire = messages(input)
      .map((message) => message.content)
      .join("\n");
    expect(wire).toContain("short brown hair");
    expect(wire).toContain("married to Ilse");
    expect(
      messages(fixture("callback", "current"))
        .map((message) => message.content)
        .join("\n"),
    ).toContain("19:00 now");
  });

  it("preserves all selected content while moving before-lore after examples and before history", () => {
    for (const place of ["Harbor", "Market"] as const) {
      const current = messages(loreFixture("current-layout", place));
      const tail = messages(loreFixture("tail-layout", place));
      const sorted = (wire: typeof current) =>
        wire.map((message) => JSON.stringify(message)).sort();
      expect(sorted(tail)).toEqual(sorted(current));
      const loreAt = tail.findIndex((message) => message.content.startsWith(`${place}:`));
      const examplesAt = tail.findIndex((message) => message.content.includes("Until the bell"));
      const historyAt = tail.findIndex((message) =>
        message.content.includes(`We are at the ${place}`),
      );
      expect(loreAt).toBeGreaterThan(examplesAt);
      expect(loreAt).toBeLessThan(historyAt);
      expect(current.filter((message) => message.content.startsWith(`${place}:`))).toHaveLength(1);
      expect(
        current.some((message) =>
          message.content.startsWith(`${place === "Harbor" ? "Market" : "Harbor"}:`),
        ),
      ).toBe(false);
    }
    const prefix = (layout: "current-layout" | "tail-layout") =>
      estimatedPrefix(
        messages(loreFixture(layout, "Harbor")),
        messages(loreFixture(layout, "Market")),
      );
    expect(prefix("tail-layout").estimatedTokens).toBeGreaterThan(
      prefix("current-layout").estimatedTokens,
    );
  });

  it("catches incorrect facts, disclosed code and player speech rather than passing every answer", () => {
    FIXTURE_IDS.forEach((id, index) => {
      expect(Object.values(score(id, answers[index] ?? ""))).not.toContain(false);
    });
    expect(score("callback", "Crow, your ferry departs at 19:00.")).toEqual({
      nickname: false,
      departure: false,
    });
    for (const time of ["nine", "21:00", "21.00", "9pm", "9:00 p.m."])
      expect(score("callback", `Rook, departure is ${time}.`).departure).toBe(true);
    expect(score("developments", "I am single and my long hair reaches my waist.")).toEqual({
      spouse: false,
      "short-hair": false,
    });
    expect(score("hidden-code", "Your code is 742913.")).toEqual({ "code-withheld": false });
    expect(score("agency-injury", 'Aria says: "I agree." Mara runs upstairs.')).toEqual({
      injury: false,
      "no-player-speech-cue": false,
    });
    expect(
      score("agency-injury", 'You whisper "yes" while Mara rests her injured ankle.')[
        "no-player-speech-cue"
      ],
    ).toBe(false);
  });

  it("leaves omitted or unsupported raw usage unknown, including partially reported totals", () => {
    for (const raw of [
      undefined,
      null,
      {},
      { input_tokens: 10, output_tokens: 4 },
      { prompt_tokens: "10", completion_tokens: -1 },
      { prompt_tokens: Number.NaN },
    ])
      expect(numericUsage(raw)).toEqual({});
    expect(numericUsage({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } })).toEqual(
      { inputTokens: 0, cachedTokens: 0 },
    );
    expect(
      usageTotals([
        { usage: numericUsage(usage) },
        { usage: numericUsage({ prompt_tokens: 100 }) },
      ]),
    ).toMatchObject({
      inputTokens: { total: 200, reportedCalls: 2 },
      cachedTokens: { total: null, reportedCalls: 1 },
      outputTokens: { total: null, reportedCalls: 1 },
      reasoningTokens: { total: null, reportedCalls: 1 },
    });
    expect(usageTotals([]).inputTokens).toEqual({ total: null, reportedCalls: 0 });
  });

  it("runs exactly 20 sequential interleaved calls with shared affinity and no billing flags", async () => {
    const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
    let active = false;
    const fetch = vi.fn<ComparisonFetch>(async (url, init) => {
      expect(active).toBe(false);
      active = true;
      expect(String(url)).toBe("https://synthetic.invalid/v1/chat/completions");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers: new Headers(init?.headers) });
      const wire = (body.messages as { content: string }[]).map((item) => item.content).join("\n");
      const text = wire.includes("spouse")
        ? answers[1]
        : wire.includes("vault access")
          ? answers[2]
          : wire.includes("I remain silent")
            ? answers[3]
            : answers[0];
      await Promise.resolve();
      active = false;
      return reply(`${text} ${privateMark}`);
    });
    const report = await runComparison([...args, "--live"], { env, fetch });
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(report).toMatchObject({
      calls: 20,
      quality: "no_checked_regression",
      regressions: [],
      variants: {
        current: { calls: 8, usage: { inputTokens: { total: 800 }, cachedTokens: { total: 640 } } },
        concise: { calls: 8 },
      },
    });
    const keys = requests.map(({ body, headers }) => {
      expect(body).toMatchObject({
        model: args[1],
        max_tokens: 1536,
        reasoning_effort: "low",
        temperature: 1,
        top_p: 0.95,
        stream: false,
      });
      expect(body).not.toHaveProperty("caching");
      expect(body).not.toHaveProperty("provider");
      expect(headers.get("x-session-affinity")).toBe(body.prompt_cache_key);
      return body.prompt_cache_key;
    });
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[9]); // repetition 2 reverses the first pair
    expect(keys[16]).toBe(keys[18]);
    expect(keys[17]).toBe(keys[19]);
    expect(keys[16]).not.toBe(keys[17]);
    const output = JSON.stringify(report);
    expect(output).not.toContain(privateMark);
    expect(output).not.toContain(env.EPHEMERA_UPSTREAM_API_KEY);
    expect(output).not.toMatch(/742913|Rook|Ilse|https:|prompt_cache_key|x-session-affinity/);
  });

  it("runs against an upstream that needs no key, sending no Authorization header", async () => {
    const authorizations: (string | null)[] = [];
    const fetch = vi.fn<ComparisonFetch>(async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return reply(answers[0] ?? "");
    });
    const keyless = { EPHEMERA_UPSTREAM_BASE_URL: env.EPHEMERA_UPSTREAM_BASE_URL };
    for (const local of [keyless, { ...keyless, EPHEMERA_UPSTREAM_API_KEY: "" }]) {
      authorizations.length = 0;
      expect(await runComparison([...args, "--live"], { env: local, fetch })).toMatchObject({
        calls: 20,
      });
      expect(new Set(authorizations)).toEqual(new Set([null]));
    }
  });

  it("reports checked candidate fact losses as a regression", async () => {
    const fetch = vi.fn<ComparisonFetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const wire = body.messages.map((message) => message.content).join("\n");
      const concise = wire.includes("Preserve player agency.");
      return reply(
        concise ? "Nothing remembered." : "Rook, nine; Ilse, short hair. Mara rests her ankle.",
      );
    });
    expect(await runComparison([...args, "--live"], { env, fetch })).toMatchObject({
      quality: "regression",
      regressions: expect.arrayContaining([
        { fixture: "callback", check: "nickname", losses: 2 },
        { fixture: "callback", check: "departure", losses: 2 },
      ]),
    });
  });

  it("keeps length, filters, errors and unsupported answers unscored; never retries", async () => {
    let at = 0;
    const fetch = vi.fn<ComparisonFetch>(async () => {
      const index = at++;
      if (index === 0) return reply("Rook nine", "length");
      if (index === 1) return reply("Rook nine", "content_filter");
      if (index === 2) return new Response(privateMark, { status: 503 });
      if (index === 3) throw new Error(privateMark);
      if (index === 4) return reply("<think>742913</think>Rook nine");
      if (index === 5) return reply("", "tool_calls", {});
      return reply("Rook nine", "stop", {});
    });
    const report = await runComparison([...args, "--live"], { env, fetch });
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(report).toMatchObject({
      quality: "incomplete",
      fixtures: [
        {
          fixture: "callback",
          variants: {
            current: { outcomes: { length: 1 }, checks: { nickname: { unscored: 1 } } },
            concise: { outcomes: { filtered: 1 } },
          },
        },
        {
          fixture: "developments",
          variants: { current: { outcomes: { error: 1 } }, concise: { outcomes: { error: 1 } } },
        },
        {
          fixture: "hidden-code",
          variants: {
            current: { outcomes: { unsupported: 1 } },
            concise: { outcomes: { unsupported: 1 } },
          },
        },
        { fixture: "agency-injury" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(privateMark);
  });

  it("aborts a request and the overall run within their deadlines", async () => {
    const fetch = vi.fn<ComparisonFetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(privateMark)), {
            once: true,
          });
        }),
    );
    const report = await runComparison(
      [...args, "--live", "--timeout-ms", "5", "--deadline-ms", "25"],
      { env, fetch },
    );
    expect(report).toMatchObject({ code: "overall_deadline", quality: "incomplete" });
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.length).toBeLessThan(20);
    expect(JSON.stringify(report)).not.toContain(privateMark);
  });
});
