import {
  type CallAccounting,
  type CastRefusal,
  type CastSheet,
  type CastSheetRequest,
  type CastSheetResponse,
  type CastUpdateRequest,
  type CastUpdateResponse,
  castRefusalSchema,
  castSheetResponseSchema,
  castUpdateResponseSchema,
} from "@ephemera/core";
import { queryOptions } from "@tanstack/react-query";
import { api, entityError, entityRetry } from "../api.ts";
import { type CallFailure, settled } from "../model-call.ts";

/*
 * The cast keeper's calls and a character's cast sheet. A keeper call's
 * register and turns are chat content: they go in the request body only,
 * and its answer lives in the chat store. The sheet is character data read
 * from the card alone, cached in memory like every query.
 */

export const CAST_SHEET_KEY = (characterId: string) => ["cast-sheet", characterId] as const;

/**
 * Why a cast call gave nothing: the server's refusal, no answer
 * (`unreachable`, `signed_out`), or a request Ephemera refused or never
 * finished. Nothing was written either way.
 */
export type CastFailure = CallFailure<CastRefusal>;

export type CastUpdateOutcome =
  | { ok: true; response: CastUpdateResponse }
  | { ok: false; reason: CastFailure };

export type CastSheetOutcome =
  /** `current`: the sheet matches the card now, as the server answered. */
  { ok: true; sheet: CastSheet | null; current: boolean } | { ok: false; reason: CastFailure };

/** One keeper call: the changes the turns made to the register sent, and what the model counted. */
export async function updateCast(
  request: CastUpdateRequest,
  signal: AbortSignal,
  onAccounting?: (accounting: CallAccounting) => void,
): Promise<CastUpdateOutcome> {
  const outcome = await settled(
    () => api.cast.update.$post({ json: request }, { init: { signal } }),
    castRefusalSchema,
    (body) => castUpdateResponseSchema.safeParse(body).data,
    onAccounting,
  );
  return outcome.ok ? { ok: true, response: outcome.value } : outcome;
}

/** A character's stored cast sheet and whether it matches the card now; never generates one. */
export const castSheetQuery = (characterId: string) =>
  queryOptions({
    queryKey: CAST_SHEET_KEY(characterId),
    retry: entityRetry,
    queryFn: async ({ signal }): Promise<CastSheetResponse> => {
      const response = await api.cast.sheets[":characterId"].$get(
        { param: { characterId } },
        { init: { signal } },
      );
      if (!response.ok) throw entityError(response.status);
      return castSheetResponseSchema.parse(await response.json());
    },
  });

/**
 * The character's current cast sheet: the stored one when it matches the
 * card (and no `force`), else the one the server reads from the card now.
 * The server's job outlives a caller that stops waiting. A request that
 * joined a job begun for the card as it was gets a sheet that is not
 * current: it asks once more, which starts a job for the card now.
 */
export async function ensureCastSheet(
  characterId: string,
  request: CastSheetRequest,
  signal: AbortSignal,
  onAccounting?: (accounting: CallAccounting) => void,
): Promise<CastSheetOutcome> {
  const ask = async (): Promise<CastSheetOutcome> => {
    const outcome = await settled(
      () =>
        api.cast.sheets[":characterId"].$post(
          { param: { characterId }, json: request },
          { init: { signal } },
        ),
      castRefusalSchema,
      (body) => castSheetResponseSchema.safeParse(body).data,
      onAccounting,
    );
    return outcome.ok ? { ok: true, ...outcome.value } : outcome;
  };
  const first = await ask();
  return first.ok && !first.current ? ask() : first;
}
