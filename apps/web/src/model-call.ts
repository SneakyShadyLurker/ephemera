import { type CallAccounting, callAccountingSchema } from "@ephemera/core";
import { z } from "zod";
import { notReached, signedOutNow } from "./signin/signin.ts";

/*
 * The protocol of a model call's answer as the server keeps it: which
 * statuses refuse before the model is asked, and the bounded calls' answer
 * of 200 at once and one JSON text when the call settles.
 */

/** The statuses with which Ephemera refuses a model call before making it. */
const REFUSED_BEFORE_CALL = [400, 404, 408, 409, 413, 422];

/**
 * Whether the server refused before any model call; it then records that no
 * call was made, so the usage ledger shows none running.
 */
export function refusedBeforeCall(
  status: number,
  onAccounting?: (accounting: CallAccounting) => void,
): boolean {
  const refused = REFUSED_BEFORE_CALL.includes(status);
  if (refused) onAccounting?.({ calls: [], truncated: false });
  return refused;
}

/** A model-call route's refusal body (core's `refusalBodySchema`). */
type RefusalSchema<C extends string> = z.ZodType<{ error: C | "request_timeout" }>;

/** Why a bounded model call gave nothing: the route's refusal, or what the tab saw of the request. */
export type CallFailure<C extends string> =
  | Exclude<C, "request_timeout">
  | "timeout"
  | "too_large"
  | "invalid"
  | "unreachable"
  | "signed_out";

/** A refusal's reason, when the body names one the route gives. */
function refusalNamed<C extends string>(
  refusals: RefusalSchema<C>,
  body: unknown,
): CallFailure<C> | undefined {
  const parsed = refusals.safeParse(body);
  if (!parsed.success) return undefined;
  const { error } = parsed.data;
  return error === "request_timeout" ? "timeout" : (error as Exclude<C, "request_timeout">);
}

/** The reason a status and body say, when the server itself answered. */
async function refusalOf<C extends string>(
  response: Response,
  refusals: RefusalSchema<C>,
): Promise<CallFailure<C>> {
  const refused = refusalNamed(refusals, await response.json().catch(() => undefined));
  if (refused !== undefined) return refused;
  if (response.status === 408) return "timeout";
  if (response.status === 413) return "too_large";
  if (response.status === 400) return "invalid";
  // A proxy's error page, or a status Ephemera does not answer: the answer may be lost.
  return "unreachable";
}

const accountingSchema = z.object({ accounting: callAccountingSchema });

/**
 * The answer of a call that, once the model is asked, answers 200 at once
 * and sends one JSON text when it settles, blank lines before it: what
 * `parse` reads, or the refusal it came to. What the model counted goes to
 * `onAccounting` either way.
 */
export async function settled<C extends string, T>(
  call: () => Promise<Response>,
  refusals: RefusalSchema<C>,
  parse: (body: unknown) => T | undefined,
  onAccounting?: (accounting: CallAccounting) => void,
): Promise<{ ok: true; value: T } | { ok: false; reason: CallFailure<C> }> {
  const failed = (reason: CallFailure<C>) => ({ ok: false, reason }) as const;
  let response: Response;
  try {
    response = await call();
  } catch (error) {
    return failed(signedOutNow(error) ? "signed_out" : "unreachable");
  }
  if (response.status !== 200) {
    refusedBeforeCall(response.status, onAccounting);
    return failed(await refusalOf(response, refusals));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Cut off while it arrived: the server may have finished the call.
    return failed("unreachable");
  }
  const accounting = accountingSchema.safeParse(body);
  if (accounting.success) onAccounting?.(accounting.data.accounting);
  const refused = refusalNamed(refusals, body);
  if (refused !== undefined) return failed(refused);
  const value = parse(body);
  return value === undefined ? failed("unreachable") : { ok: true, value };
}

/** A failure every bounded model call can meet. */
export type SharedCallFailure =
  | "unreachable"
  | "signed_out"
  | "timeout"
  | "upstream_busy"
  | "invalid"
  | "context_window_unknown"
  | "no_model";

/** A failure's way out: the call again, or the Settings that set the window or the model. */
export type CallFailureAction = "retry" | "window" | "settings";

/**
 * What a shared failure says after the call's subject ("The cast was not
 * read: "), naming the model that answers it ("cast", "memory"), and its way out.
 */
export function sharedCallFailure(
  reason: SharedCallFailure,
  model: string,
): { words: string; action: CallFailureAction } {
  switch (reason) {
    case "unreachable":
      return { words: notReached(), action: "retry" };
    case "signed_out":
      return { words: "you were signed out", action: "retry" };
    case "timeout":
      return { words: `the ${model} model took too long`, action: "retry" };
    case "upstream_busy":
      return { words: `the ${model} model is busy. Try again in a moment`, action: "retry" };
    case "invalid":
      return { words: "Ephemera refused the request", action: "retry" };
    case "context_window_unknown":
      return { words: `the ${model} model has no known context window`, action: "window" };
    case "no_model":
      return { words: "no model is chosen to write it", action: "settings" };
  }
}
