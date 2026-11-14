import { isRecord } from "../../packages/core/src/card/json.ts";
import { applyCastChanges } from "../../packages/core/src/cast/apply.ts";
import { groundedCastChanges } from "../../packages/core/src/cast/effective.ts";
import { CAST_LIMITS, castFieldLimit } from "../../packages/core/src/cast/limits.ts";
import { keeperInstructions, keeperMessage } from "../../packages/core/src/cast/prompt.ts";
import {
  type CastChanges,
  castChangesSchema,
  castFieldText,
  clampCastChanges,
} from "../../packages/core/src/cast/register.ts";
import { repairObject } from "../../packages/core/src/memory/answer.ts";
import { KEEPER_FIXTURE_IDS, type KeeperFixtureId, keeperFixture } from "./keeper-fixtures.ts";
import {
  aggregate,
  type ComparisonFetch,
  callBudget,
  estimate,
  type Observation,
  parseFlags,
  Refusal,
  type RunOptions,
  request,
  runCli,
  upstreamEndpoint,
  type WireMessage,
} from "./transport.ts";

/*
 * The cast keeper evaluation: the product's keeper prompt over synthetic
 * fixtures, each answer read as the product reads it (repair, clamp,
 * schema, then `applyCastChanges`), scored by the fixtures' checks.
 * Prints numbers and fixed identifiers only.
 */

interface KeeperOptions extends RunOptions {
  fixtures: KeeperFixtureId[];
}

/** No flag reads config or writes anything; a run that needs more calls than allowed is refused. */
export function parseKeeperOptions(args: string[]): KeeperOptions {
  const options: KeeperOptions = {
    live: false,
    model: "",
    repetitions: 2,
    maxCalls: 24,
    timeoutMs: 75000,
    deadlineMs: 1800000,
    outputCap: 8192,
    // The product sends no sampler and the provider's default effort for keeper calls.
    settings: {},
    fixtures: [...KEEPER_FIXTURE_IDS],
  };
  parseFlags(args, options, 72, (flag, value) => {
    if (flag !== "--fixtures") return false;
    const chosen = value.split(",");
    if (new Set(chosen).size !== chosen.length) throw new Refusal("invalid_arguments");
    options.fixtures = chosen.map((id) => {
      const known = KEEPER_FIXTURE_IDS.find((item) => item === id);
      if (known === undefined) throw new Refusal("unknown_fixture");
      return known;
    });
    return true;
  });
  if (options.fixtures.length * options.repetitions > options.maxCalls)
    throw new Refusal("call_budget_exceeded");
  return options;
}

/** The keeper call as the product sends it: its instructions, then one update message. */
function keeperWire(id: KeeperFixtureId): WireMessage[] {
  const { canon, names, register, turns, kind } = keeperFixture(id);
  return [
    { role: "system", content: keeperInstructions() },
    {
      role: "user",
      content: keeperMessage({
        canon,
        names,
        register,
        turns,
        mode: "update",
        full: register.entries.length >= CAST_LIMITS.entries,
        kind,
      }),
    },
  ];
}

/** Text values of a parsed answer past their field's bound: anchor and state fields, evidenced items' values. */
function valuesOverBound(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.cast)) return 0;
  // Measured as the clamp reads it: a field written as a list of strings is its joined text.
  const over = ([key, value]: [string, unknown]) => {
    const text = castFieldText(value);
    return typeof text === "string" && text.trim().length > castFieldLimit(key);
  };
  let count = 0;
  for (const change of Object.values(value.cast)) {
    if (!isRecord(change)) continue;
    for (const key of ["anchor", "state"]) {
      const fields = change[key];
      if (isRecord(fields)) count += Object.entries(fields).filter(over).length;
    }
    for (const key of ["developments", "continuity", "discovered"]) {
      const fields = change[key];
      if (isRecord(fields))
        count += Object.entries(fields).filter(
          ([field, item]) => isRecord(item) && over([field, item.value]),
        ).length;
    }
  }
  return count;
}

/** Introductions and evidenced fields the changes carry. */
const evidenced = (changes: CastChanges): number =>
  Object.values(changes.cast).reduce(
    (sum, change) =>
      sum +
      (change.introduce === undefined ? 0 : 1) +
      [change.developments, change.continuity, change.discovered]
        .map((fields) => Object.values(fields ?? {}).filter((item) => item !== undefined).length)
        .reduce((a, b) => a + b, 0),
    0,
  );

interface Judged {
  checks: Record<string, boolean>;
  overBound: number;
  sent: number;
  kept: number;
}

/**
 * A completed answer read as the product reads it: `repairObject` with the
 * keeper's clamp and schema, then applied to the fixture's register over the
 * turns as shown. Undefined when no candidate validates. Values over a bound
 * are those of the candidate `repairObject` returns: the last one whose
 * clamped form passes the schema.
 */
export function judgeAnswer(id: KeeperFixtureId, text: string): Judged | undefined {
  const fixture = keeperFixture(id);
  const candidates: { overBound: number; valid: boolean }[] = [];
  const clamp = (value: unknown): unknown => {
    const clamped = clampCastChanges(value);
    candidates.push({
      overBound: valuesOverBound(value),
      valid: castChangesSchema.safeParse(clamped).success,
    });
    return clamped;
  };
  const changes = repairObject(text, castChangesSchema, clamp);
  if (changes === undefined) return undefined;
  const shown = fixture.turns.map((turn) => turn.content);
  let next = 0;
  const after = applyCastChanges(fixture.register, changes, {
    player: fixture.names.user,
    newId: () => `00000000-0000-4000-9000-${String(++next).padStart(12, "0")}`,
    shown,
  });
  const overBound = candidates.findLast((candidate) => candidate.valid)?.overBound ?? 0;
  const result = { before: fixture.register, after, changes, overBound };
  return {
    checks: Object.fromEntries(
      Object.entries(fixture.checks).map(([check, passes]) => [check, passes(result)]),
    ),
    overBound,
    sent: evidenced(changes),
    kept: evidenced(groundedCastChanges(changes, shown)),
  };
}

interface Row {
  id: KeeperFixtureId;
  observation: Observation;
  judged?: Judged;
}

/** Counts beyond the call outcomes: completed answers that validated or not, and what the valid ones carried. */
function answerTotals(rows: Row[]) {
  const judged = rows.flatMap((row) => (row.judged === undefined ? [] : [row.judged]));
  const sum = (key: "overBound" | "sent" | "kept") =>
    judged.reduce((total, item) => total + item[key], 0);
  return {
    valid: judged.length,
    invalid: rows.filter((row) => row.observation.outcome === "completed" && !row.judged).length,
    valuesOverBound: sum("overBound"),
    evidenced: { sent: sum("sent"), kept: sum("kept") },
  };
}

interface Dependencies {
  env?: Record<string, string | undefined>;
  fetch?: ComparisonFetch;
}

/**
 * Report v1. diagnostics holds local prompt estimates only. fixtures[] and
 * totals hold call outcomes, check pass/fail/unscored counts over completed,
 * valid answers (every other outcome is unscored, never a failed check),
 * valid and invalid answer counts, values sent past a field bound, evidenced
 * items sent and kept after grounding, and usage totals (null unless every
 * call reported the field). No prompts, fixture text, answers, reasoning,
 * error bodies, credentials or paths escape.
 */
export async function runKeeperEvaluation(args: string[], dependencies: Dependencies = {}) {
  let options: KeeperOptions;
  try {
    options = parseKeeperOptions(args);
  } catch (error) {
    return { version: 1, code: error instanceof Refusal ? error.code : "invalid_arguments" };
  }
  const plannedCalls = options.fixtures.length * options.repetitions;
  const base = {
    version: 1,
    mode: options.live ? "live" : "offline",
    plannedCalls,
    repetitions: options.repetitions,
    maxCalls: options.maxCalls,
    requestTimeoutMs: options.timeoutMs,
    deadlineMs: options.deadlineMs,
    outputCap: options.outputCap,
    sampler: options.settings,
    scoring: "bounded_heuristics_not_proof",
    diagnostics: options.fixtures.map((id) => ({
      fixture: id,
      estimatedPromptTokens: estimate(keeperWire(id)),
    })),
  };
  if (!options.live) return { ...base, code: "offline", calls: 0 };
  const upstream = upstreamEndpoint(dependencies.env ?? process.env);
  if ("code" in upstream) return { ...base, code: upstream.code, calls: 0 };
  const { endpoint, apiKey } = upstream;
  const budget = callBudget(options.maxCalls, options.deadlineMs);
  const rows: Row[] = [];
  const rootKey = crypto.randomUUID();
  try {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      for (const id of options.fixtures) {
        if (!budget.take()) continue;
        const { observation, text } = await request(
          keeperWire(id),
          `${rootKey}-${id}`,
          options,
          endpoint,
          apiKey,
          dependencies.fetch ?? globalThis.fetch,
          budget.signal,
        );
        // A truncated answer is no answer; every other completed one goes to the repair.
        const judged = text === undefined ? undefined : judgeAnswer(id, text);
        if (judged !== undefined) observation.checks = judged.checks;
        rows.push({ id, observation, ...(judged === undefined ? {} : { judged }) });
      }
    }
  } finally {
    budget.close();
  }
  const calls = budget.calls;
  return {
    ...base,
    code: budget.signal.aborted ? "overall_deadline" : "finished",
    calls,
    unattemptedCalls: plannedCalls - calls,
    fixtures: options.fixtures.map((id) => {
      const own = rows.filter((row) => row.id === id);
      return {
        fixture: id,
        ...aggregate(
          own.map((row) => row.observation),
          Object.keys(keeperFixture(id).checks),
        ),
        ...answerTotals(own),
      };
    }),
    totals: { ...aggregate(rows.map((row) => row.observation)), ...answerTotals(rows) },
  };
}

/** The command-line entry: one JSON report line; exit 1 when refused or cut off. */
export async function keeperMain(args = process.argv.slice(2)): Promise<void> {
  await runCli(
    () => parseKeeperOptions(args).deadlineMs,
    () => runKeeperEvaluation(args),
    (report) => ["offline", "finished"].includes(report.code),
    "keeper_evaluation_failed",
  );
}

if (import.meta.main && /(?:^|[/\\])keeper\.ts$/.test(Bun.main)) await keeperMain();
