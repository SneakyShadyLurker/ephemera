import { countText } from "../../apps/server/src/tokens.ts";
import { isRecord } from "../../packages/core/src/card/json.ts";
import {
  applyCastChanges,
  castAdmitsNew,
  resolveCastEntry,
} from "../../packages/core/src/cast/apply.ts";
import { groundedCastChanges } from "../../packages/core/src/cast/effective.ts";
import { castFieldLimit } from "../../packages/core/src/cast/limits.ts";
import {
  castLore,
  keeperInstructions,
  keeperMessage,
} from "../../packages/core/src/cast/prompt.ts";
import {
  type CastChanges,
  type CastRegister,
  castChangesSchema,
  castFieldText,
  clampCastChanges,
} from "../../packages/core/src/cast/register.ts";
import { repairObject } from "../../packages/core/src/memory/answer.ts";
import {
  fixtureBatches,
  KEEPER_CALLS_PER_RUN,
  KEEPER_FIXTURE_IDS,
  type KeeperFixture,
  type KeeperFixtureId,
  keeperFixture,
} from "./keeper-fixtures.ts";
import {
  aggregate,
  type ComparisonFetch,
  callBudget,
  callKey,
  checkCounts,
  chosenFixtures,
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
 * schema, then `applyCastChanges`), scored by the fixtures' checks. A
 * fixture of two batches takes two calls, the second over the register the
 * first answer left. Prints numbers and fixed identifiers only.
 */

interface KeeperOptions extends RunOptions {
  fixtures: KeeperFixtureId[];
}

/** The calls a run of `options` takes: one per batch of every chosen fixture, per repetition. */
const planned = (options: KeeperOptions): number =>
  options.repetitions *
  options.fixtures.reduce((sum, id) => sum + fixtureBatches(keeperFixture(id)).length, 0);

/** No flag reads config or writes anything; a run that needs more calls than allowed is refused. */
export function parseKeeperOptions(args: string[]): KeeperOptions {
  const options: KeeperOptions = {
    live: false,
    spread: false,
    model: "",
    repetitions: 2,
    maxCalls: KEEPER_CALLS_PER_RUN * 2,
    timeoutMs: 75000,
    deadlineMs: 1800000,
    outputCap: 8192,
    // The product sends no sampler and the provider's default effort for keeper calls.
    settings: {},
    fixtures: [...KEEPER_FIXTURE_IDS],
  };
  parseFlags(args, options, KEEPER_CALLS_PER_RUN * 3, (flag, value) => {
    if (flag !== "--fixtures") return false;
    options.fixtures = chosenFixtures(value, KEEPER_FIXTURE_IDS);
    return true;
  });
  if (planned(options) > options.maxCalls) throw new Refusal("call_budget_exceeded");
  return options;
}

/** The context window a fixture's lore is fitted to: a common size, far above any fixture's lorebook. */
const LORE_WINDOW = 32768;

/** The ids of the fixture's entries the owner removed. */
const removedIds = (fixture: KeeperFixture): Set<string> =>
  new Set(
    (fixture.removed ?? []).flatMap((name) => {
      const entry = resolveCastEntry(fixture.register, name);
      return entry === undefined ? [] : [entry.id];
    }),
  );

/**
 * The keeper call of a fixture's batch `step` as the product sends it: its
 * instructions, then one update message over `register` (the fixture's, or
 * the one the first answer left) without the entries the owner removed, with
 * the lore the batch's turns bring in of the fixture's lorebook.
 */
export function keeperWire(
  id: KeeperFixtureId,
  step = 0,
  register: CastRegister = keeperFixture(id).register,
): WireMessage[] {
  const fixture = keeperFixture(id);
  const { canon, lorebook, names, kind } = fixture;
  const turns = fixtureBatches(fixture)[step] ?? fixture.turns;
  const removed = removedIds(fixture);
  const shown = { entries: register.entries.filter((entry) => !removed.has(entry.id)) };
  const lore =
    lorebook === undefined
      ? null
      : castLore({
          card: { lorebook },
          names,
          linked: [],
          turns,
          window: LORE_WINDOW,
          count: countText,
        });
  return [
    { role: "system", content: keeperInstructions() },
    {
      role: "user",
      content: keeperMessage({
        canon,
        lore,
        names,
        register: shown,
        turns,
        mode: "update",
        full: !castAdmitsNew(shown),
        kind,
      }),
    },
  ];
}

/** Text values of a parsed answer past their field's bound: anchor and state fields, evidenced items' values, a list's items each. */
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
    for (const key of ["developments", "continuity", "hidden", "discovered"]) {
      const fields = change[key];
      if (isRecord(fields))
        count += Object.entries(fields)
          .flatMap(([field, item]) =>
            (Array.isArray(item) ? item : [item]).map((one) => [field, one] as const),
          )
          .filter(([field, item]) => isRecord(item) && over([field, item.value])).length;
    }
  }
  return count;
}

/** Introductions and evidenced items the changes carry: fields, knowledge items and hidden values, not a hidden field's end. */
const evidenced = (changes: CastChanges): number =>
  Object.values(changes.cast).reduce(
    (sum, change) =>
      sum +
      (change.introduce === undefined ? 0 : 1) +
      [change.developments, change.continuity, change.hidden, change.discovered]
        .flatMap((fields) => Object.values(fields ?? {}))
        .flat()
        .filter((item) => item !== undefined && item !== "").length,
    0,
  );

/** One valid answer: the register it left, its changes, and what it carried. */
export interface KeeperAnswer {
  after: CastRegister;
  changes: CastChanges;
  overBound: number;
  sent: number;
  kept: number;
}

/**
 * A completed answer to a fixture's batch `step` read as the product reads
 * it: `repairObject` with the keeper's clamp and schema, then applied to
 * `register` over the batch's turns as shown, the fixture's removed entries
 * still removed. Undefined when no candidate validates. Values over a bound
 * are those of the candidate `repairObject` returns: the last one whose
 * clamped form passes the schema.
 */
export function readAnswer(
  id: KeeperFixtureId,
  text: string,
  step = 0,
  register: CastRegister = keeperFixture(id).register,
): KeeperAnswer | undefined {
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
  const shown = (fixtureBatches(fixture)[step] ?? fixture.turns).map((turn) => turn.content);
  let next = 0;
  const after = applyCastChanges(register, changes, {
    player: fixture.names.user,
    // Each batch mints ids of its own range.
    newId: () =>
      `00000000-0000-4000-9${String(step).padStart(3, "0")}-${String(++next).padStart(12, "0")}`,
    removed: removedIds(fixture),
    shown,
  });
  return {
    after,
    changes,
    overBound: candidates.findLast((candidate) => candidate.valid)?.overBound ?? 0,
    sent: evidenced(changes),
    kept: evidenced(groundedCastChanges(changes, shown)),
  };
}

/**
 * A fixture's checks over the valid answers to all its batches, in order;
 * a check with nothing to judge (null) is left out and so counts as unscored.
 */
export function fixtureChecks(
  id: KeeperFixtureId,
  answers: readonly KeeperAnswer[],
): Record<string, boolean> {
  const fixture = keeperFixture(id);
  const first = answers[0];
  const last = answers.at(-1);
  if (first === undefined || last === undefined) return {};
  const result = {
    before: fixture.register,
    first: first.after,
    after: last.after,
    changes: last.changes,
    overBound: answers.reduce((sum, answer) => sum + answer.overBound, 0),
  };
  return Object.fromEntries(
    Object.entries(fixture.checks).flatMap(([check, passes]) => {
      const passed = passes(result);
      return passed === null ? [] : [[check, passed]];
    }),
  );
}

/** One call: its outcome, and what its answer carried when it validated. */
interface Row {
  id: KeeperFixtureId;
  observation: Observation;
  answer?: KeeperAnswer;
}

/** One run of a fixture: its checks, once every batch had a valid answer. */
interface Run {
  id: KeeperFixtureId;
  checks?: Record<string, boolean>;
}

/** Counts beyond the call outcomes: completed answers that validated or not, and what the valid ones carried. */
function answerTotals(rows: Row[]) {
  const answers = rows.flatMap((row) => (row.answer === undefined ? [] : [row.answer]));
  const sum = (key: "overBound" | "sent" | "kept") =>
    answers.reduce((total, item) => total + item[key], 0);
  return {
    valid: answers.length,
    invalid: rows.filter((row) => row.observation.outcome === "completed" && !row.answer).length,
    valuesOverBound: sum("overBound"),
    evidenced: { sent: sum("sent"), kept: sum("kept") },
  };
}

interface Dependencies {
  env?: Record<string, string | undefined>;
  fetch?: ComparisonFetch;
}

/**
 * Report v1. diagnostics holds local prompt estimates only (a fixture's
 * first batch). fixtures[] and totals hold call outcomes, check
 * pass/fail/unscored counts per run of a fixture whose every batch had a
 * completed, valid answer (every other run is unscored, never a failed
 * check, as is a check with nothing to judge), valid and invalid answer
 * counts, values sent past a field bound, evidenced items sent and kept
 * after grounding, and usage totals (null unless every call reported the
 * field). cacheKeys says whether each call had a key of its own (`--spread`).
 * No prompts, fixture text, answers, reasoning, error bodies, credentials or
 * paths escape.
 */
export async function runKeeperEvaluation(args: string[], dependencies: Dependencies = {}) {
  let options: KeeperOptions;
  try {
    options = parseKeeperOptions(args);
  } catch (error) {
    return { version: 1, code: error instanceof Refusal ? error.code : "invalid_arguments" };
  }
  const plannedCalls = planned(options);
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
    cacheKeys: options.spread ? "per_call" : "per_fixture",
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
  const runs: Run[] = [];
  const rootKey = crypto.randomUUID();
  try {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      for (const id of options.fixtures) {
        const fixture = keeperFixture(id);
        const batches = fixtureBatches(fixture).length;
        const answers: KeeperAnswer[] = [];
        let register = fixture.register;
        let attempted = false;
        for (let step = 0; step < batches; step++) {
          if (!budget.take()) break;
          attempted = true;
          const { observation, text } = await request(
            keeperWire(id, step, register),
            callKey(options, `${rootKey}-${id}`),
            options,
            endpoint,
            apiKey,
            dependencies.fetch ?? globalThis.fetch,
            budget.signal,
          );
          // A truncated answer is no answer; every other completed one goes to the repair.
          const answer = text === undefined ? undefined : readAnswer(id, text, step, register);
          rows.push({ id, observation, ...(answer === undefined ? {} : { answer }) });
          // A batch without a valid answer leaves the next nothing to read.
          if (answer === undefined) break;
          answers.push(answer);
          register = answer.after;
        }
        if (attempted)
          runs.push({
            id,
            ...(answers.length === batches ? { checks: fixtureChecks(id, answers) } : {}),
          });
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
      const ownRuns = runs.filter((run) => run.id === id);
      return {
        fixture: id,
        ...aggregate(own.map((row) => row.observation)),
        runs: ownRuns.length,
        checks: checkCounts(ownRuns, Object.keys(keeperFixture(id).checks)),
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
