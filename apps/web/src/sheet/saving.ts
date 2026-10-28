import { conflictSchema, createdResponseSchema } from "@ephemera/core";
import { notReached, signedOutNow } from "../signin/signin.ts";

/*
 * How sheets talk to the API when saving, creating and deleting: one
 * timeout, one set of failure reasons, one result shape per kind of request.
 */

/** A save that has not answered by then is treated as unreachable and retried. */
export const SAVE_TIMEOUT_MS = 15_000;

/** Unsafe requests without a body still declare JSON (the API boundary requires it). */
const JSON_HEADERS = { headers: { "Content-Type": "application/json" } };

/** A bodiless unsafe request's client options: JSON declared, and the save timeout. */
export const unsafeOptions = () => ({
  ...JSON_HEADERS,
  init: { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) },
});
type UnsafeOptions = ReturnType<typeof unsafeOptions>;

/**
 * Why a save failed: only "unreachable" is worth retrying on a timer;
 * "signed_out" waits for the session to come back; "conflict" (another tab
 * saved first) waits for the owner to reload or keep their edits.
 */
export type SaveFailure =
  | "invalid"
  | "too_large"
  | "unreachable"
  | "gone"
  | "signed_out"
  | "conflict";

/** Every failure but a conflict, which only an edit made against a revision can meet. */
type PlainFailure = Exclude<SaveFailure, "conflict">;

/** A save that threw: signed out, or the server never answered (offline, the timeout). */
export const thrownFailure = (error: unknown): PlainFailure =>
  signedOutNow(error) ? "signed_out" : "unreachable";

export const failureOf = (status: number): PlainFailure =>
  status === 404
    ? "gone"
    : status === 413
      ? "too_large"
      : status === 400
        ? "invalid"
        : "unreachable";

/**
 * Why a create or save failed, in words after "Not created: " or "Not saved: ":
 * what the server refused in its own terms, anything else as the sign-in
 * state says (signed out, or Ephemera not reached).
 */
export function failureWords(failure: PlainFailure): string {
  if (failure === "too_large") return "it is larger than Ephemera allows";
  if (failure === "invalid") return "Ephemera refused it";
  if (failure === "gone") return "it was deleted";
  return notReached();
}

export type CreateResult = { ok: true } | { ok: false; reason: PlainFailure };

/**
 * A create or duplicate as the screen says it: the new entity's id, or why
 * not in words after "Not created: " or "Not duplicated: "; `refused` when
 * the server answered that it stored nothing for this request.
 */
export type CreateOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: string; refused?: true };

/** A create's result under `id` in words; invalid or too large is final for what was sent. */
export const createOutcome = (id: string, result: CreateResult): CreateOutcome =>
  result.ok
    ? { ok: true, id }
    : result.reason === "invalid" || result.reason === "too_large"
      ? { ok: false, reason: failureWords(result.reason), refused: true }
      : { ok: false, reason: failureWords(result.reason) };

/** Sends one create; a thrown fetch is signed out or unreachable. */
export async function creating(
  send: (init: { signal: AbortSignal }) => Promise<Response>,
): Promise<CreateResult> {
  try {
    const response = await send({ signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) });
    return response.ok ? { ok: true } : { ok: false, reason: failureOf(response.status) };
  } catch (error) {
    return { ok: false, reason: thrownFailure(error) };
  }
}

/** Sends one duplicate: the copy's id, or why there is none. */
export async function duplicating(
  send: (options: UnsafeOptions) => Promise<Response>,
): Promise<CreateOutcome> {
  try {
    const response = await send(unsafeOptions());
    if (!response.ok) return { ok: false, reason: failureWords(failureOf(response.status)) };
    return { ok: true, id: createdResponseSchema.parse(await response.json()).id };
  } catch (error) {
    return { ok: false, reason: failureWords(thrownFailure(error)) };
  }
}

/** Sends one delete; false when the server did not delete (already gone counts as deleted). */
export async function removing(
  send: (options: UnsafeOptions) => Promise<Response>,
): Promise<boolean> {
  try {
    const response = await send(unsafeOptions());
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * A save's outcome. What was saved carries the entity's new revision; a
 * conflict carries the revision another tab's save left.
 */
export type SaveResult<Saved extends { revision: number }> =
  | { ok: true; saved: Saved }
  /** `answered`: the server itself answered with the failure (an error status, not silence). */
  | { ok: false; reason: PlainFailure; answered?: boolean }
  | { ok: false; reason: "conflict"; revision: number };

/** Sends one save; a thrown fetch is signed out or unreachable. */
export async function saving<Saved extends { revision: number }>(
  send: (init: { signal: AbortSignal }) => Promise<Response>,
  read: (response: Response) => Promise<Saved>,
): Promise<SaveResult<Saved>> {
  try {
    const response = await send({ signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) });
    if (response.ok) return { ok: true, saved: await read(response) };
    if (response.status === 409) {
      const conflict = conflictSchema.safeParse(await response.json().catch(() => undefined));
      if (conflict.success)
        return { ok: false, reason: "conflict", revision: conflict.data.revision };
    }
    return { ok: false, reason: failureOf(response.status), answered: true };
  } catch (error) {
    return { ok: false, reason: thrownFailure(error) };
  }
}
