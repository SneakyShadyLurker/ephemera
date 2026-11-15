import { countMessage, PRIMING } from "../../apps/server/src/tokens.ts";
import { upstreamSettings } from "../../apps/server/src/upstream.ts";
import { reportedUsage } from "../../apps/server/src/usage.ts";
import { REASONING_EFFORTS } from "../../packages/core/src/preset/sampler.ts";
import type { CallSettings } from "../../packages/core/src/prompt/inspect.ts";

/*
 * What the roleplay evaluation scripts share: bounded option parsing, one
 * model call over the upstream's chat completions endpoint, usage totals,
 * outcome aggregation and the command-line entry. Nothing here prints or
 * keeps prompt text, model output or credentials.
 */

type Usage = ReturnType<typeof reportedUsage>;
const USAGE_FIELDS = ["inputTokens", "cachedTokens", "outputTokens", "reasoningTokens"] as const;
const OUTCOMES = ["completed", "length", "filtered", "error", "timeout", "unsupported"] as const;
export type WireMessage = { role: "system" | "user" | "assistant"; content: string };

/** A run's options every script reads; each script adds its own. */
export interface RunOptions {
  live: boolean;
  /**
   * A fresh cache key with every call instead of one per fixture. One key
   * keeps a run on one backend of a provider that routes by it, so two runs
   * then differ by backend as well as by prompt; spread, each samples them all.
   */
  spread: boolean;
  model: string;
  repetitions: number;
  maxCalls: number;
  timeoutMs: number;
  deadlineMs: number;
  outputCap: number;
  settings: CallSettings;
}
export class Refusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * `options` with the shared flags read from `args`: each at most once, every
 * value bounded, `--max-calls` up to `maxCalls`. `own` reads a script's own
 * flags and says whether it knew the flag. No flag reads config or writes
 * anything.
 */
export function parseFlags<T extends RunOptions>(
  args: string[],
  options: T,
  maxCalls: number,
  own: (flag: string, value: string) => boolean = () => false,
): T {
  const seen = new Set<string>();
  for (let at = 0; at < args.length; at++) {
    const flag = args[at];
    if (flag === undefined || seen.has(flag)) throw new Refusal("invalid_arguments");
    seen.add(flag);
    if (flag === "--live") {
      options.live = true;
      continue;
    }
    if (flag === "--spread") {
      options.spread = true;
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
        options.maxCalls = integer(1, maxCalls);
        break;
      case "--timeout-ms":
        options.timeoutMs = integer(1, 75000);
        break;
      case "--deadline-ms":
        options.deadlineMs = integer(1, 1800000);
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
        if (!own(flag, value)) throw new Refusal("invalid_arguments");
    }
  }
  if (options.model === "") throw new Refusal("model_required");
  return options;
}

/** A `--fixtures` value as the fixtures it names: known ids, comma-separated, each once. */
export function chosenFixtures<T extends string>(value: string, known: readonly T[]): T[] {
  const chosen = value.split(",");
  if (new Set(chosen).size !== chosen.length) throw new Refusal("invalid_arguments");
  return chosen.map((id) => {
    const found = known.find((item) => item === id);
    if (found === undefined) throw new Refusal("unknown_fixture");
    return found;
  });
}

/** Local estimate of a prompt's tokens. */
export const estimate = (items: WireMessage[]) =>
  PRIMING + items.reduce((sum, item) => sum + countMessage(item), 0);

export type Outcome = (typeof OUTCOMES)[number];
export interface Observation {
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

/** Each check's pass, fail and unscored counts over `rows`: a row without the check is unscored. */
export const checkCounts = (
  rows: readonly Pick<Observation, "checks">[],
  checkIds: readonly string[],
) =>
  Object.fromEntries(
    checkIds.map((id) => [
      id,
      {
        passed: rows.filter((row) => row.checks?.[id] === true).length,
        failed: rows.filter((row) => row.checks?.[id] === false).length,
        unscored: rows.filter((row) => row.checks?.[id] === undefined).length,
      },
    ]),
  );

export function aggregate(rows: Observation[], checkIds: readonly string[] = []) {
  return {
    calls: rows.length,
    outcomes: Object.fromEntries(
      OUTCOMES.map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length]),
    ),
    checks: checkCounts(rows, checkIds),
    usage: usageTotals(rows),
    durationMsDiagnostic: rows.reduce((sum, row) => sum + row.durationMs, 0),
    failures: rows
      .filter((row) => row.code !== undefined)
      .map(({ code, status }) => ({ code, ...(status === undefined ? {} : { status }) })),
  };
}

export type ComparisonFetch = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * The chat completions endpoint and key a live run calls, from
 * `EPHEMERA_UPSTREAM_BASE_URL` and `EPHEMERA_UPSTREAM_API_KEY`; a refusal
 * code when the URL is missing or not a plain http(s) one.
 */
export function upstreamEndpoint(
  env: Record<string, string | undefined>,
): { endpoint: URL; apiKey: string | undefined } | { code: string } {
  // Empty or unset for a local server that needs no key.
  const apiKey = env.EPHEMERA_UPSTREAM_API_KEY || undefined;
  try {
    if (!env.EPHEMERA_UPSTREAM_BASE_URL) throw new Refusal("upstream_environment_required");
    const endpoint = new URL(env.EPHEMERA_UPSTREAM_BASE_URL);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Refusal("invalid_upstream_url");
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
    return { endpoint, apiKey };
  } catch (error) {
    return { code: error instanceof Refusal ? error.code : "invalid_upstream_url" };
  }
}

/**
 * The cache key of one call: the fixture's own for the whole run, so a
 * provider's prompt cache serves its repetitions, or a fresh one under
 * `--spread`.
 */
export const callKey = (options: Pick<RunOptions, "spread">, fixtureKey: string): string =>
  options.spread ? crypto.randomUUID() : fixtureKey;

/** A run's call allowance: at most `maxCalls`, none once `deadlineMs` passed. */
export function callBudget(maxCalls: number, deadlineMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let calls = 0;
  return {
    signal: controller.signal,
    get calls() {
      return calls;
    },
    /** Whether one more call may start; counts it when it may. */
    take() {
      if (controller.signal.aborted || calls >= maxCalls) return false;
      calls++;
      return true;
    },
    close: () => clearTimeout(timer),
  };
}

/**
 * One model call, with no retry layer: one scheduled call consumes exactly
 * one HTTP attempt. The answer's text comes back only for a completed call,
 * unread: what counts as an answer is the caller's rule.
 */
export async function request(
  wire: WireMessage[],
  cacheKey: string,
  options: Pick<RunOptions, "model" | "timeoutMs" | "outputCap" | "settings">,
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
    return {
      observation: { outcome, usage, durationMs: durationMs() },
      ...(outcome === "completed" ? { text: String(message.content) } : {}),
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
 * A script's command-line run: the report as one JSON line, exit code 1
 * when `passed` says it did not pass or the run threw. A hard ceiling past
 * the run's deadline also covers a transport that ignores AbortSignal.
 */
export async function runCli<R>(
  deadline: () => number,
  run: () => Promise<R>,
  passed: (report: R) => boolean,
  failure: string,
): Promise<void> {
  let deadlineMs = 1000;
  try {
    deadlineMs = deadline() + 1000;
  } catch {
    /* Refused by the run, without any inference. */
  }
  const hardDeadline = setTimeout(() => {
    console.log(JSON.stringify({ version: 1, code: "cli_deadline" }));
    process.exit(1);
  }, deadlineMs);
  try {
    const report = await run();
    console.log(JSON.stringify(report));
    if (!passed(report)) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ version: 1, code: failure }));
    process.exitCode = 1;
  } finally {
    clearTimeout(hardDeadline);
  }
}
