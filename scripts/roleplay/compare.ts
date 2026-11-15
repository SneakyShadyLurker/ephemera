import { countMessage, countText } from "../../apps/server/src/tokens.ts";
import { assemblePrompt, flatten } from "../../packages/core/src/prompt/assemble.ts";
import {
  CHECK_IDS,
  FIXTURE_IDS,
  type FixtureId,
  fixture,
  type Layout,
  loreFixture,
  score,
  type Variant,
} from "./fixtures.ts";
import {
  aggregate,
  type ComparisonFetch,
  callBudget,
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

export { type ComparisonFetch, numericUsage, usageTotals } from "./transport.ts";

const VARIANTS: Variant[] = ["current", "concise"];
const LAYOUTS: Layout[] = ["current-layout", "tail-layout"];

interface ComparisonOptions extends RunOptions {
  fixtures: FixtureId[];
}

/** Both variants of every chosen fixture per repetition, then the four cache-experiment calls. */
const planned = (options: ComparisonOptions): number =>
  options.repetitions * options.fixtures.length * VARIANTS.length + 4;

/**
 * No flag reads config or writes anything. Repetitions 3 exceeds the full
 * matrix's 24-call ceiling; `--fixtures` narrows the matrix, so a few
 * fixtures can run three times.
 */
export function parseOptions(args: string[]): ComparisonOptions {
  const options: ComparisonOptions = {
    live: false,
    model: "",
    repetitions: 2,
    maxCalls: 24,
    timeoutMs: 75000,
    deadlineMs: 1800000,
    outputCap: 1536,
    settings: { reasoning: "low", temperature: 1, topP: 0.95 },
    fixtures: [...FIXTURE_IDS],
  };
  parseFlags(args, options, 24, (flag, value) => {
    if (flag === "--fixtures") {
      options.fixtures = chosenFixtures(value, FIXTURE_IDS);
      return true;
    }
    if (flag !== "--output-cap") return false;
    const number = Number(value);
    if (number !== 1536 && number !== 2048) throw new Refusal("invalid_bounds");
    options.outputCap = number;
    return true;
  });
  if (planned(options) > options.maxCalls) throw new Refusal("call_budget_exceeded");
  return options;
}

export function messages(input: Parameters<typeof assemblePrompt>[0]): WireMessage[] {
  return flatten(assemblePrompt(input)).map(({ role, content }) => ({ role, content }));
}

/** Local whole-message and partial-text estimate only. It does not measure a provider cache. */
export function estimatedPrefix(before: WireMessage[], after: WireMessage[]) {
  let wholeMessages = 0;
  let tokens = 0;
  for (let at = 0; at < Math.min(before.length, after.length); at++) {
    const a = before[at];
    const b = after[at];
    if (a === undefined || b === undefined || a.role !== b.role) break;
    if (a.content === b.content) {
      wholeMessages++;
      tokens += countMessage(b);
      continue;
    }
    let chars = 0;
    while (
      chars < a.content.length &&
      chars < b.content.length &&
      a.content[chars] === b.content[chars]
    )
      chars++;
    tokens += countText(b.content.slice(0, chars));
    break;
  }
  return { wholeMessages, estimatedTokens: tokens };
}

interface Dependencies {
  env?: Record<string, string | undefined>;
  fetch?: ComparisonFetch;
}

/** One call; inline reasoning is deliberately unscored, rather than treating its facts as answer text. */
async function infer(
  ...input: Parameters<typeof request>
): Promise<{ observation: Observation; text?: string }> {
  const result = await request(...input);
  if (result.text === undefined || !/^\s*<think>/i.test(result.text)) return result;
  return {
    observation: {
      ...result.observation,
      outcome: "unsupported",
      code: "inline_reasoning_unscored",
    },
  };
}

/**
 * Machine report v1: diagnostics/cacheDiagnostics contain local estimates only.
 * fixtures[].variants contains check pass/fail/unscored counts; variants contains
 * narration totals. cacheExperiment has separate layout totals and two steps.
 * Usage totals are null unless every attempted call reported that raw numeric
 * field; reportedCalls records coverage. Outcome counts include unscored calls.
 * regressions counts paired current-pass/candidate-fail checks, never a ranking.
 * No prompts, output samples, reasoning, credentials or paths escape.
 */
export async function runComparison(args: string[], dependencies: Dependencies = {}) {
  let options: ComparisonOptions;
  try {
    options = parseOptions(args);
  } catch (error) {
    return { version: 1, code: error instanceof Refusal ? error.code : "invalid_arguments" };
  }
  const plannedCalls = planned(options);
  const diagnostics = options.fixtures.map((id) => {
    const current = messages(fixture(id, "current"));
    const concise = messages(fixture(id, "concise"));
    return {
      fixture: id,
      currentEstimatedPromptTokens: estimate(current),
      conciseEstimatedPromptTokens: estimate(concise),
      estimatedCommonPrefix: estimatedPrefix(current, concise),
    };
  });
  const cacheDiagnostics = LAYOUTS.map((layout) => {
    const first = messages(loreFixture(layout, "Harbor"));
    const second = messages(loreFixture(layout, "Market"));
    return {
      layout,
      firstEstimatedPromptTokens: estimate(first),
      secondEstimatedPromptTokens: estimate(second),
      estimatedCommonPrefix: estimatedPrefix(first, second),
    };
  });
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
    scoring: "bounded_heuristics_not_immersion_proof",
    prefix: "local_estimate_not_provider_cache",
    layout: "experiment_changes_authored_placement_semantics",
    diagnostics,
    cacheDiagnostics,
  };
  if (!options.live) return { ...base, code: "offline", calls: 0, quality: "not_run" };
  const upstream = upstreamEndpoint(dependencies.env ?? process.env);
  if ("code" in upstream) return { ...base, code: upstream.code, calls: 0, quality: "not_run" };
  const { endpoint, apiKey } = upstream;
  const budget = callBudget(options.maxCalls, options.deadlineMs);
  const rows: { id: FixtureId; variant: Variant; repetition: number; observation: Observation }[] =
    [];
  const cacheRows: { layout: Layout; step: number; observation: Observation }[] = [];
  const rootKey = crypto.randomUUID();
  const call = async (wire: WireMessage[], key: string) => {
    if (!budget.take()) return undefined;
    return infer(
      wire,
      key,
      options,
      endpoint,
      apiKey,
      dependencies.fetch ?? globalThis.fetch,
      budget.signal,
    );
  };
  try {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      for (const [index, id] of options.fixtures.entries()) {
        // Alternate the first variant across fixtures and repetitions.
        for (const variant of (repetition + index) % 2 === 0 ? VARIANTS : [...VARIANTS].reverse()) {
          const result = await call(messages(fixture(id, variant)), `${rootKey}-${id}-${variant}`);
          if (result === undefined) continue;
          if (result.text !== undefined) result.observation.checks = score(id, result.text);
          rows.push({ id, variant, repetition, observation: result.observation });
        }
      }
    }
    // Interleave layouts; only the pair within a layout shares an affinity key.
    for (const [step, place] of (["Harbor", "Market"] as const).entries()) {
      for (const layout of LAYOUTS) {
        const result = await call(messages(loreFixture(layout, place)), `${rootKey}-${layout}`);
        if (result !== undefined)
          cacheRows.push({ layout, step: step + 1, observation: result.observation });
      }
    }
  } finally {
    budget.close();
  }
  const regressions = options.fixtures.flatMap((id) =>
    CHECK_IDS[id].flatMap((check) => {
      let losses = 0;
      for (let repetition = 0; repetition < options.repetitions; repetition++) {
        const current = rows.find(
          (row) => row.id === id && row.repetition === repetition && row.variant === "current",
        );
        const concise = rows.find(
          (row) => row.id === id && row.repetition === repetition && row.variant === "concise",
        );
        if (
          current?.observation.checks?.[check] === true &&
          concise?.observation.checks?.[check] === false
        )
          losses++;
      }
      return losses > 0 ? [{ fixture: id, check, losses }] : [];
    }),
  );
  const calls = budget.calls;
  const incomplete =
    calls !== plannedCalls ||
    rows.some((row) => row.observation.outcome !== "completed") ||
    cacheRows.some((row) => row.observation.outcome !== "completed");
  return {
    ...base,
    code: budget.signal.aborted ? "overall_deadline" : "finished",
    calls,
    unattemptedCalls: plannedCalls - calls,
    quality:
      regressions.length > 0 ? "regression" : incomplete ? "incomplete" : "no_checked_regression",
    regressions,
    fixtures: options.fixtures.map((id) => ({
      fixture: id,
      variants: Object.fromEntries(
        VARIANTS.map((variant) => [
          variant,
          aggregate(
            rows
              .filter((row) => row.id === id && row.variant === variant)
              .map((row) => row.observation),
            CHECK_IDS[id],
          ),
        ]),
      ),
    })),
    variants: Object.fromEntries(
      VARIANTS.map((variant) => [
        variant,
        aggregate(rows.filter((row) => row.variant === variant).map((row) => row.observation)),
      ]),
    ),
    cacheExperiment: LAYOUTS.map((layout) => ({
      layout,
      ...aggregate(cacheRows.filter((row) => row.layout === layout).map((row) => row.observation)),
      steps: cacheRows
        .filter((row) => row.layout === layout)
        .map((row) => ({ step: row.step, ...aggregate([row.observation]) })),
    })),
  };
}

/** Explicit entry for Bun.build(write:false) bundles piped to `bun -`; no import.meta assumption. */
export async function comparisonMain(args = process.argv.slice(2)): Promise<void> {
  await runCli(
    () => parseOptions(args).deadlineMs,
    () => runComparison(args),
    (report) =>
      "code" in report &&
      ["offline", "finished"].includes(report.code) &&
      !("quality" in report && ["regression", "incomplete"].includes(report.quality)),
    "comparison_failed",
  );
}

// Bun folds import.meta.main into a bundle's entry. Do not auto-run imported code on stdin.
if (import.meta.main && /(?:^|[/\\])compare\.ts$/.test(Bun.main)) await comparisonMain();
