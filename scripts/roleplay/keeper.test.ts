import { describe, expect, it, vi } from "vitest";
import { parseKeeperOptions, runKeeperEvaluation } from "./keeper.ts";
import { KEEPER_FIXTURE_IDS, type KeeperFixtureId, keeperFixture } from "./keeper-fixtures.ts";
import type { ComparisonFetch } from "./transport.ts";

const args = ["--model", "example/model-1"];
const env = {
  EPHEMERA_UPSTREAM_BASE_URL: "https://synthetic.invalid/v1",
  EPHEMERA_UPSTREAM_API_KEY: "SYNTHETIC_PRIVATE_KEY",
};
const canary = "PRIVATE_KEEPER_ANSWER_CANARY";
const usage = { prompt_tokens: 100, completion_tokens: 20 };
const reply = (text: string, finish = "stop") =>
  Response.json({ choices: [{ finish_reason: finish, message: { content: text } }], usage });

/** A name only that fixture's message carries, to tell which fixture a call is for. */
const MARKS: Record<KeeperFixtureId, string> = {
  clear: "Ines Varga",
  "spoken-of": "Marta Kowal",
  returns: "Lena Hart",
  leaves: "Owen Marsh",
  outfit: "Clara Wendt",
  undress: "Nadia Solberg",
  "scenario-new": "Sigrid Aal",
  "extract-only": "Greta Holm",
  quote: "Vera Lund",
  knowledge: "Hanna Brix",
  player: "Rosa Quill",
  quiet: "Ada Brenner",
  "scenario-walk-on": "Dieter Lorenz",
  "scenario-promotion": "Jorun Berg",
  "full-retires": "Tilda Marek",
  "away-named": "Katla Nyberg",
};
const long = "a".repeat(300);
const json = (cast: Record<string, unknown>, absent: string[] = []) =>
  JSON.stringify({ cast, absent });

const GOOD: Record<KeeperFixtureId, string> = {
  clear: json({ "Ines Varga": { state: { arousal: "", intoxication: "", mood: "calm" } } }),
  "spoken-of": json(
    {
      "Marta Kowal": { state: { activity: "turning her cup in her hands" } },
      Pavel: {
        gender: "male",
        introduce: { evidence: "My brother Pavel lives three hundred kilometres away" },
      },
    },
    ["Pavel"],
  ),
  returns: json({
    "Lena Hart": { state: { present: true, position: "sitting at the kitchen table" } },
  }),
  leaves: json({}, ["Owen Marsh"]),
  outfit: json({
    "Clara Wendt": {
      state: {
        outfit:
          "black lace bra, black lace panties, sheer nude stockings, garter belt, emerald silk gown, cropped velvet bolero, silver stiletto sandals, satin sash",
      },
    },
  }),
  undress: json({
    "Nadia Solberg": {
      state: {
        outfit: "white cotton blouse, navy pencil skirt, black lace bra",
        disarray: "beige trench coat and black ankle boots left on the wicker chair by the door",
      },
    },
  }),
  "scenario-new": json({
    "Sigrid Aal": {
      role: "principal",
      gender: "female",
      anchor: {
        age: "30",
        ethnicity: "Norwegian",
        skin: "pale skin with cool undertones",
        face: "oval face, straight nose, thin lips",
        experience: "experienced",
        relationship: "single",
        height: "178cm",
        weight: "66kg",
        build: "tall, lean build",
        hair: "cropped platinum hair with a straight texture",
        eyes: "grey almond-shaped eyes",
        intimate: "EU 75B, small round breasts",
        personality: "calm, dry, competent",
        fetishes: "fetishes: none; taboos: none",
      },
      state: { position: "at the radio console", activity: "offering a handshake" },
      introduce: { evidence: "I'm Sigrid Aal, the station medic." },
    },
  }),
  "extract-only": json({
    "Greta Holm": {
      gender: "female",
      anchor: { age: "in her forties", hair: "auburn hair pinned up in a loose knot" },
      state: { position: "on the stool beside the player" },
      introduce: { evidence: "Call me Greta Holm" },
    },
  }),
  quote: json({
    "Vera Lund": {
      gender: "female",
      state: { position: "leaning on the counter" },
      introduce: { evidence: "I'm Vera Lund" },
      discovered: {
        hair: {
          value: "loose copper hair",
          basis: "seen",
          evidence: "her copper hair falls loose",
        },
      },
    },
  }),
  knowledge: json({
    "Hanna Brix": {
      continuity: {
        knowledge: {
          value: "knows the ledger is behind the loose brick in the cellar wall",
          evidence: "The ledger is hidden behind the loose brick in the cellar wall",
        },
      },
    },
  }),
  player: json({ "Rosa Quill": { state: { activity: "reading at the table" } } }),
  quiet: json({ "Ada Brenner": { state: { activity: "stirring her tea" } } }),
  "scenario-walk-on": json(
    {
      "Dieter Lorenz": {
        role: "minor",
        gender: "male",
        anchor: {
          age: "in his fifties",
          ethnicity: "German",
          skin: "pale, lined skin",
          face: "long face, straight nose, thin lips",
          height: "179cm",
          weight: "77kg",
          build: "lean, slightly stooped build",
          hair: "short dark hair, grey at the temples",
          eyes: "brown deep-set eyes",
        },
        introduce: { evidence: "Dieter Lorenz, if you need anything else" },
      },
    },
    ["Dieter Lorenz"],
  ),
  "scenario-promotion": json({
    "Jorun Berg": {
      role: "principal",
      anchor: {
        experience: "experienced",
        relationship: "single",
        intimate: "EU 75C, full round breasts",
        personality: "dogged, guarded, methodical",
        fetishes: "fetishes: none; taboos: none",
      },
      continuity: {
        goals: {
          value: "wants to find out who is siphoning diesel",
          evidence: "I intend to find out who before the supply ship comes",
        },
      },
    },
  }),
  "full-retires": json({
    "Tilda Marek": {
      role: "minor",
      gender: "female",
      state: { outfit: "yellow rain cape", position: "at the bar" },
      introduce: { evidence: "I'm Tilda Marek" },
    },
  }),
  "away-named": json({
    "Katla Nyberg": {
      state: {
        present: true,
        position: "on the bench by the stove",
        activity: "pulling off her muddy boots",
      },
    },
    "Agnes Thorne": { state: { activity: "sliding a mug of tea across the counter" } },
  }),
};

const BAD: Record<KeeperFixtureId, string> = {
  clear: json({ "Ines Varga": { state: { mood: "calm" } } }),
  "spoken-of": json({ Pavel: { gender: "male", state: { position: "at the sawmill" } } }, [
    "Marta Kowal",
  ]),
  returns: json({}, ["Lena Hart"]),
  leaves: json({ "Owen Marsh": { state: { activity: "pulling on his coat" } } }),
  outfit: json({
    "Clara Wendt": {
      state: { outfit: "emerald silk gown, velvet bolero, silver sandals", mood: long },
    },
  }),
  undress: json({ "Nadia Solberg": { state: { outfit: "" } } }),
  "scenario-new": json({
    "Sigrid Aal": {
      gender: "female",
      anchor: { age: "30", hair: "long black hair" },
      state: { mood: long },
    },
  }),
  "extract-only": json({
    "Greta Holm": {
      gender: "female",
      anchor: { age: "42", weight: "60kg", hair: "long blonde hair" },
    },
  }),
  quote: json({}),
  knowledge: json({
    "Hanna Brix": {
      continuity: { knowledge: { value: "likes quiet evenings", evidence: "Hanna's eyes widen" } },
    },
  }),
  player: json({ "Felix Arden": { state: { position: "by the window" } } }),
  quiet: json({
    "Ada Brenner": { anchor: { eyes: "brown almond-shaped eyes" } },
    "Ruth Okafor": { state: { position: "in the doorway" } },
  }),
  "scenario-walk-on": json({
    "Dieter Lorenz": {
      role: "principal",
      gender: "male",
      anchor: { age: "55", intimate: "average" },
      state: { mood: long },
    },
  }),
  "scenario-promotion": json({ "Jorun Berg": { state: { mood: long } } }),
  "full-retires": json({ "Edda Lindholm": { state: { activity: "signing for a parcel" } } }),
  "away-named": json({
    "Silas Vane": { state: { position: "by the door" } },
    "Katla Nyberg": { anchor: { eyes: "brown round eyes" } },
  }),
};

/** The fixture a call is for, read from its user message. */
const fixtureOf = (init: RequestInit): KeeperFixtureId => {
  const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
  const message = body.messages.find((item) => item.role === "user")?.content ?? "";
  const id = KEEPER_FIXTURE_IDS.find((item) => message.includes(MARKS[item]));
  if (id === undefined) throw new Error("unknown fixture");
  return id;
};

/** Neither a fixture's turns nor its people nor the canary appear in the printed report. */
function expectPrivate(report: unknown) {
  const output = JSON.stringify(report);
  expect(output).not.toContain(canary);
  expect(output).not.toContain(env.EPHEMERA_UPSTREAM_API_KEY);
  for (const id of KEEPER_FIXTURE_IDS) {
    expect(output).not.toContain(MARKS[id]);
    for (const turn of keeperFixture(id).turns) expect(output).not.toContain(turn.content);
  }
}

type Report = Awaited<ReturnType<typeof runKeeperEvaluation>>;
const fixtureRows = (report: Report) => {
  if (!("fixtures" in report)) throw new Error("no fixtures");
  return report.fixtures;
};

describe("cast keeper evaluation", () => {
  it("defaults to offline estimates without environment reads or calls", async () => {
    const fetch = vi.fn<ComparisonFetch>();
    const report = await runKeeperEvaluation(args, {
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
    expect(report).toMatchObject({ code: "offline", calls: 0, plannedCalls: 32, outputCap: 8192 });
    if (!("diagnostics" in report)) throw new Error("no diagnostics");
    expect(report.diagnostics.map((row) => row.fixture)).toEqual(KEEPER_FIXTURE_IDS);
    for (const row of report.diagnostics) expect(row.estimatedPromptTokens).toBeGreaterThan(0);
    expectPrivate(report);
  });

  it("leaves reasoning and sampler unset by default and reads its bounds", () => {
    expect(parseKeeperOptions(args)).toMatchObject({
      repetitions: 2,
      maxCalls: 32,
      outputCap: 8192,
      settings: {},
    });
    expect(
      parseKeeperOptions([
        ...args,
        "--repetitions",
        "3",
        "--max-calls",
        "72",
        "--reasoning",
        "low",
        "--temperature",
        "0.7",
        "--top-p",
        "0.9",
        "--fixtures",
        "quiet,clear",
      ]),
    ).toMatchObject({
      repetitions: 3,
      maxCalls: 72,
      settings: { reasoning: "low", temperature: 0.7, topP: 0.9 },
      fixtures: ["quiet", "clear"],
    });
  });

  it.each([
    [],
    [...args, "--repetitions", "4"],
    [...args, "--repetitions", "3"],
    [...args, "--max-calls", "31"],
    [...args, "--max-calls", "73"],
    [...args, "--fixtures", "clear,unknown"],
    [...args, "--fixtures", "clear,clear"],
    [...args, "--output-cap", "2048"],
    [...args, "--temperature", "NaN"],
    [...args, "--reasoning", "fictional"],
  ])("refuses before any call: %j", async (...input) => {
    const fetch = vi.fn<ComparisonFetch>();
    const report = await runKeeperEvaluation([...input, "--live"], { env, fetch });
    expect(report).not.toHaveProperty("code", "finished");
    expect(report).not.toHaveProperty("code", "offline");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a live run without the upstream environment", async () => {
    const fetch = vi.fn<ComparisonFetch>();
    for (const partial of [{}, { EPHEMERA_UPSTREAM_API_KEY: env.EPHEMERA_UPSTREAM_API_KEY }])
      expect(await runKeeperEvaluation([...args, "--live"], { env: partial, fetch })).toMatchObject(
        { code: "upstream_environment_required", calls: 0 },
      );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes every check on good answers, sending the product's keeper call", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<ComparisonFetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return reply(GOOD[fixtureOf(init)]);
    });
    const report = await runKeeperEvaluation([...args, "--live", "--repetitions", "1"], {
      env,
      fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(16);
    expect(report).toMatchObject({
      code: "finished",
      calls: 16,
      totals: { valid: 16, invalid: 0, valuesOverBound: 0, evidenced: { sent: 9, kept: 9 } },
    });
    for (const row of fixtureRows(report)) {
      expect(Object.keys(row.checks).length).toBeGreaterThan(0);
      for (const [check, counts] of Object.entries(row.checks))
        expect({ check, ...counts }).toEqual({ check, passed: 1, failed: 0, unscored: 0 });
    }
    for (const body of bodies) {
      expect(body).toMatchObject({ model: args[1], max_tokens: 8192, stream: false });
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body).not.toHaveProperty("reasoning_effort");
      expect((body.messages as { role: string }[]).map((item) => item.role)).toEqual([
        "system",
        "user",
      ]);
    }
    expectPrivate(report);
  });

  it("fails every check on bad answers and counts values over a bound", async () => {
    const fetch = vi.fn<ComparisonFetch>(async (_url, init) => reply(BAD[fixtureOf(init)]));
    const report = await runKeeperEvaluation([...args, "--live", "--repetitions", "1"], {
      env,
      fetch,
    });
    expect(report).toMatchObject({
      totals: { valid: 16, valuesOverBound: 4, evidenced: { sent: 1, kept: 1 } },
    });
    for (const row of fixtureRows(report))
      for (const [check, counts] of Object.entries(row.checks))
        expect({ check, ...counts }).toEqual({ check, passed: 0, failed: 1, unscored: 0 });
    expectPrivate(report);
  });

  it("counts a field written as a list by its joined length, as the clamp reads it", async () => {
    const mood = Array.from({ length: 60 }, (_, at) => `word${at}`);
    const fetch = vi.fn<ComparisonFetch>(async () =>
      reply(JSON.stringify({ cast: { "Ada Brenner": { state: { mood } } }, absent: [] })),
    );
    const report = await runKeeperEvaluation(
      [...args, "--live", "--repetitions", "1", "--fixtures", "quiet", "--max-calls", "1"],
      { env, fetch },
    );
    expect(report).toMatchObject({ totals: { valid: 1, valuesOverBound: 1 } });
  });

  it("never calls past --max-calls and stops at the run's deadline", async () => {
    const fetch = vi.fn<ComparisonFetch>(async (_url, init) => reply(GOOD[fixtureOf(init)]));
    for (const [input, planned] of [
      [[], 32],
      [["--repetitions", "3", "--max-calls", "48"], 48],
      [["--fixtures", "quiet,leaves", "--repetitions", "1", "--max-calls", "2"], 2],
    ] as const) {
      fetch.mockClear();
      const report = await runKeeperEvaluation([...args, "--live", ...input], { env, fetch });
      expect(fetch).toHaveBeenCalledTimes(planned);
      expect(report).toMatchObject({ calls: planned, unattemptedCalls: 0 });
    }
    const hanging = vi.fn<ComparisonFetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error(canary)), { once: true });
        }),
    );
    const report = await runKeeperEvaluation(
      [...args, "--live", "--timeout-ms", "5", "--deadline-ms", "25"],
      { env, fetch: hanging },
    );
    expect(report).toMatchObject({ code: "overall_deadline" });
    expect(hanging.mock.calls.length).toBeLessThan(24);
    expectPrivate(report);
  });

  it("reads malformed, wrapped, reasoning-prefixed, truncated and failed answers as the product does", async () => {
    const answers: ((init: RequestInit) => Response)[] = [
      // clear: malformed
      () => reply(`{"cast": {"${canary}": `),
      // quiet: prose around a valid object, with one ungrounded cue
      () =>
        reply(
          `Here is the update ${canary}:\n${json({
            "Ada Brenner": {
              state: { activity: "stirring her tea" },
              continuity: { goals: { value: "wants rain", evidence: `${canary} said nothing` } },
            },
          })}\nThat is all.`,
        ),
      // leaves: an inline reasoning block before the valid object
      () => reply(`<think>${canary} {"cast":{"Owen Marsh":{}},"absent":[]}</think>${GOOD.leaves}`),
      // returns: cut off by the output allowance
      () => reply(GOOD.returns, "length"),
      // player: a call that throws
      () => {
        throw new Error(canary);
      },
    ];
    let at = 0;
    const fetch = vi.fn<ComparisonFetch>(async (_url, init) => {
      const answer = answers[at++];
      if (answer === undefined) throw new Error("unexpected call");
      return answer(init);
    });
    const report = await runKeeperEvaluation(
      [...args, "--live", "--repetitions", "1", "--fixtures", "clear,quiet,leaves,returns,player"],
      { env, fetch },
    );
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fixtureRows(report)).toMatchObject([
      {
        fixture: "clear",
        outcomes: { completed: 1 },
        valid: 0,
        invalid: 1,
        checks: { "clear.arousal": { passed: 0, failed: 0, unscored: 1 } },
      },
      {
        fixture: "quiet",
        valid: 1,
        evidenced: { sent: 1, kept: 0 },
        checks: { "quiet.presence": { passed: 1 }, "quiet.no-anchor": { passed: 1 } },
      },
      { fixture: "leaves", valid: 1, checks: { "leaves.away": { passed: 1 } } },
      {
        fixture: "returns",
        outcomes: { length: 1 },
        valid: 0,
        invalid: 0,
        checks: { "returns.present": { unscored: 1 } },
      },
      {
        fixture: "player",
        outcomes: { error: 1 },
        valid: 0,
        failures: [{ code: "request_failed" }],
        checks: { "player.no-entry": { unscored: 1 } },
      },
    ]);
    expect(report).toMatchObject({ totals: { valid: 2, invalid: 1, calls: 5 } });
    expectPrivate(report);
  });
});
