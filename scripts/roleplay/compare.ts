import { countMessage, countText, PRIMING } from "../../apps/server/src/tokens.ts";
import { upstreamSettings } from "../../apps/server/src/upstream.ts";
import { reportedUsage } from "../../apps/server/src/usage.ts";
import { REASONING_EFFORTS } from "../../packages/core/src/preset/sampler.ts";
import { assemblePrompt, flatten } from "../../packages/core/src/prompt/assemble.ts";
import type { CallSettings } from "../../packages/core/src/prompt/inspect.ts";
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

type Usage = ReturnType<typeof reportedUsage>;
const USAGE_FIELDS = ["inputTokens", "cachedTokens", "outputTokens", "reasoningTokens"] as const;
const VARIANTS: Variant[] = ["current", "concise"];
const LAYOUTS: Layout[] = ["current-layout", "tail-layout"];
type WireMessage = { role: "system" | "user" | "assistant"; content: string };
interface Options {
  live: boolean;
  model: string;
  repetitions: number;
  maxCalls: number;
  timeoutMs: number;
  deadlineMs: number;
  outputCap: number;
  settings: CallSettings;
}
class Refusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** No flag reads config or writes anything. Repetitions 3 exceeds the full matrix's 24-call ceiling. */
export function parseOptions(args: string[]): Options {
  const options: Options = {
    live: false,
    model: "",
    repetitions: 2,
    maxCalls: 20,
    timeoutMs: 75000,
    deadlineMs: 1800000,
    outputCap: 1536,
    settings: { reasoning: "low", temperature: 1, topP: 0.95 },
  };
  const seen = new Set<string>();
  for (let at = 0; at < args.length; at++) {
    const flag = args[at];
    if (flag === undefined || seen.has(flag)) throw new Refusal("invalid_arguments");
    seen.add(flag);
    if (flag === "--live") {
      options.live = true;
      continue;
    }
    const value = args[++at];
    if (value === undefined) throw new Refusal("invalid_arguments");
    const number = Number(value);
    const integer = (min: number, max: number) => {
      if (!Number.isSafeInteger(number) || number < min || number > max)
        throw new Refusal("invalid_bounds");
      return number;
    };
    switch (flag) {
      case "--model":
        if (!/^[a-zA-Z0-9._/-]{1,200}$/.test(value)) throw new Refusal("invalid_model");
        options.model = value;
        break;
      case "--repetitions":
        options.repetitions = integer(1, 3);
        break;
      case "--max-calls":
        options.maxCalls = integer(1, 24);
        break;
      case "--timeout-ms":
        options.timeoutMs = integer(1, 75000);
        break;
      case "--deadline-ms":
        options.deadlineMs = integer(1, 1800000);
        break;
      case "--output-cap":
        if (number !== 1536 && number !== 2048) throw new Refusal("invalid_bounds");
        options.outputCap = number;
        break;
      case "--reasoning": {
        const effort = REASONING_EFFORTS.find((item) => item === value);
        if (effort === undefined) throw new Refusal("invalid_reasoning");
        if (effort === "provider-default") delete options.settings.reasoning;
        else options.settings.reasoning = effort;
        break;
      }
      case "--temperature":
        if (!Number.isFinite(number) || number < 0 || number > 2)
          throw new Refusal("invalid_bounds");
        options.settings.temperature = number;
        break;
      case "--top-p":
        if (!Number.isFinite(number) || number <= 0 || number > 1)
          throw new Refusal("invalid_bounds");
        options.settings.topP = number;
        break;
      default:
        throw new Refusal("invalid_arguments");
    }
  }
  if (options.model === "") throw new Refusal("model_required");
  if (options.repetitions * FIXTURE_IDS.length * 2 + 4 > options.maxCalls)
    throw new Refusal("call_budget_exceeded");
  return options;
}

export function messages(input: Parameters<typeof assemblePrompt>[0]): WireMessage[] {
  return flatten(assemblePrompt(input)).map(({ role, content }) => ({ role, content }));
}
const estimate = (items: WireMessage[]) =>
  PRIMING + items.reduce((sum, item) => sum + countMessage(item), 0);

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

type Outcome = "completed" | "length" | "filtered" | "error" | "timeout" | "unsupported";
interface Observation {
  outcome: Outcome;
  usage: Usage;
  durationMs: number;
  code?: string;
  status?: number;
  checks?: Record<string, boolean>;
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Raw presence is essential: SDK-normalized zeroes are not usage evidence. */
export function numericUsage(raw: unknown): Usage {
  const usage = raw as Parameters<typeof reportedUsage>[0]["raw"];
  return reportedUsage(usage === undefined ? {} : { raw: usage });
}

export function usageTotals(rows: Pick<Observation, "usage">[]) {
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => {
      const known = rows.flatMap((row) =>
        row.usage[field] === undefined ? [] : [row.usage[field]],
      );
      return [
        field,
        {
          total:
            rows.length > 0 && known.length === rows.length
              ? known.reduce((a, b) => a + b, 0)
              : null,
          reportedCalls: known.length,
        },
      ];
    }),
  );
}
function aggregate(rows: Observation[], checkIds: readonly string[] = []) {
  return {
    calls: rows.length,
    outcomes: Object.fromEntries(
      (["completed", "length", "filtered", "error", "timeout", "unsupported"] as const).map(
        (outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length],
      ),
    ),
    checks: Object.fromEntries(
      checkIds.map((id) => [
        id,
        {
          passed: rows.filter((row) => row.checks?.[id] === true).length,
          failed: rows.filter((row) => row.checks?.[id] === false).length,
          unscored: rows.filter((row) => row.checks?.[id] === undefined).length,
        },
      ]),
    ),
    usage: usageTotals(rows),
    durationMsDiagnostic: rows.reduce((sum, row) => sum + row.durationMs, 0),
    failures: rows
      .filter((row) => row.code !== undefined)
      .map(({ code, status }) => ({ code, ...(status === undefined ? {} : { status }) })),
  };
}

export type ComparisonFetch = (input: URL, init: RequestInit) => Promise<Response>;

interface Dependencies {
  env?: Record<string, string | undefined>;
  fetch?: ComparisonFetch;
}

/** No retry layer: one scheduled comparison consumes exactly one HTTP attempt. */
async function infer(
  wire: WireMessage[],
  cacheKey: string,
  options: Options,
  endpoint: URL,
  apiKey: string | undefined,
  fetcher: ComparisonFetch,
  overall: AbortSignal,
): Promise<{ observation: Observation; text?: string }> {
  const started = performance.now();
  const signal = AbortSignal.any([overall, AbortSignal.timeout(options.timeoutMs)]);
  const durationMs = () => Math.max(0, Math.round(performance.now() - started));
  try {
    const shared = upstreamSettings(options.settings, cacheKey);
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        ...shared.headers,
      },
      body: JSON.stringify({
        model: options.model,
        messages: wire,
        stream: false,
        max_tokens: options.outputCap,
        temperature: shared.temperature,
        top_p: shared.topP,
        ...(shared.reasoning === undefined ? {} : { reasoning_effort: shared.reasoning }),
        ...shared.providerOptions?.upstream,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        observation: {
          outcome: "error",
          code: "http_error",
          status: response.status,
          usage: {},
          durationMs: durationMs(),
        },
      };
    }
    // Bound the in-memory response too, including reasoning and an uncooperative provider.
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Refusal("invalid_response");
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 262144) throw new Refusal("response_limit");
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const raw = object(JSON.parse(text));
    const usage = numericUsage(raw.usage);
    const choice = object(Array.isArray(raw.choices) ? raw.choices[0] : undefined);
    const message = object(choice.message);
    const finish = choice.finish_reason;
    const outcome: Outcome =
      finish === "length"
        ? "length"
        : finish === "content_filter" || message.refusal
          ? "filtered"
          : finish === "stop" &&
              typeof message.content === "string" &&
              message.content.trim() !== ""
            ? "completed"
            : "unsupported";
    // Inline reasoning is deliberately unscored, rather than treating its facts as answer text.
    const unparsed = outcome === "completed" && /^\s*<think>/i.test(String(message.content));
    return {
      observation: {
        outcome: unparsed ? "unsupported" : outcome,
        usage,
        durationMs: durationMs(),
        ...(unparsed ? { code: "inline_reasoning_unscored" } : {}),
      },
      ...(!unparsed && outcome === "completed" ? { text: String(message.content) } : {}),
    };
  } catch (error) {
    return {
      observation: {
        outcome: signal.aborted ? "timeout" : "error",
        code: signal.aborted
          ? "deadline"
          : error instanceof Refusal
            ? error.code
            : "request_failed",
        usage: {},
        durationMs: durationMs(),
      },
    };
  }
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
  let options: Options;
  try {
    options = parseOptions(args);
  } catch (error) {
    return { version: 1, code: error instanceof Refusal ? error.code : "invalid_arguments" };
  }
  const plannedCalls = options.repetitions * 8 + 4;
  const diagnostics = FIXTURE_IDS.map((id) => {
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
  const env = dependencies.env ?? process.env;
  // Empty or unset for a local server that needs no key.
  const apiKey = env.EPHEMERA_UPSTREAM_API_KEY || undefined;
  let endpoint: URL;
  try {
    if (!env.EPHEMERA_UPSTREAM_BASE_URL) throw new Refusal("upstream_environment_required");
    endpoint = new URL(env.EPHEMERA_UPSTREAM_BASE_URL);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Refusal("invalid_upstream_url");
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  } catch (error) {
    return {
      ...base,
      code: error instanceof Refusal ? error.code : "invalid_upstream_url",
      calls: 0,
      quality: "not_run",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.deadlineMs);
  const rows: { id: FixtureId; variant: Variant; repetition: number; observation: Observation }[] =
    [];
  const cacheRows: { layout: Layout; step: number; observation: Observation }[] = [];
  let calls = 0;
  const rootKey = crypto.randomUUID();
  const call = async (wire: WireMessage[], key: string) => {
    if (controller.signal.aborted || calls >= options.maxCalls) return undefined;
    calls++;
    return infer(
      wire,
      key,
      options,
      endpoint,
      apiKey,
      dependencies.fetch ?? globalThis.fetch,
      controller.signal,
    );
  };
  try {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      for (let index = 0; index < FIXTURE_IDS.length; index++) {
        const id = FIXTURE_IDS[index];
        if (id === undefined) continue;
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
    clearTimeout(timer);
  }
  const regressions = FIXTURE_IDS.flatMap((id) =>
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
  const incomplete =
    calls !== plannedCalls ||
    rows.some((row) => row.observation.outcome !== "completed") ||
    cacheRows.some((row) => row.observation.outcome !== "completed");
  return {
    ...base,
    code: controller.signal.aborted ? "overall_deadline" : "finished",
    calls,
    unattemptedCalls: plannedCalls - calls,
    quality:
      regressions.length > 0 ? "regression" : incomplete ? "incomplete" : "no_checked_regression",
    regressions,
    fixtures: FIXTURE_IDS.map((id) => ({
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
  // A hard CLI ceiling also covers a transport that ignores AbortSignal.
  let deadlineMs = 1000;
  try {
    deadlineMs = parseOptions(args).deadlineMs + 1000;
  } catch {
    /* Refused below, without any inference. */
  }
  const hardDeadline = setTimeout(() => {
    console.log(JSON.stringify({ version: 1, code: "cli_deadline" }));
    process.exit(1);
  }, deadlineMs);
  try {
    const report = await runComparison(args);
    console.log(JSON.stringify(report));
    if (
      !("code" in report) ||
      !["offline", "finished"].includes(report.code) ||
      ("quality" in report && ["regression", "incomplete"].includes(report.quality))
    )
      process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ version: 1, code: "comparison_failed" }));
    process.exitCode = 1;
  } finally {
    clearTimeout(hardDeadline);
  }
}

// Bun folds import.meta.main into a bundle's entry. Do not auto-run imported code on stdin.
if (import.meta.main && /(?:^|[/\\])compare\.ts$/.test(Bun.main)) await comparisonMain();
