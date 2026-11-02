import { type ReworkEvent, type ReworkRequest, reworkEventSchema } from "@ephemera/core";
import { z } from "zod";
import { api } from "../api.ts";
import { CreatorStreamError, readEvents } from "../creator/stream.ts";
import { type Refused, ReworkRefused } from "./store.ts";

const REFUSED: Record<Refused, true> = { payload_too_large: true, invalid_request: true };
const refusedBody = z.object({
  error: z.enum(Object.keys(REFUSED) as [Refused, ...Refused[]]),
});

/*
 * The rework's NDJSON stream (PRINCIPLES.md 1): the request and the sheet's
 * fields go out, the model's answer comes back, and nothing here keeps
 * either. The API client's one fetch owner throws `SignedOut` when the
 * sign-in redirect answers instead of Ephemera.
 */

/**
 * Asks for changes to a saved character: the answer as written, then one
 * result or error. A request the server refuses before the model sees it
 * (too large, or not valid) throws `ReworkRefused`.
 */
export async function streamRework(
  request: ReworkRequest,
  signal: AbortSignal,
): Promise<AsyncGenerator<ReworkEvent>> {
  const response = await api.creator.rework.$post({ json: request }, { init: { signal } });
  if (response.status === 400 || response.status === 413) {
    const refused = refusedBody.safeParse(await response.json().catch(() => undefined));
    if (refused.success) throw new ReworkRefused(refused.data.error);
  }
  if (!response.ok || response.body === null) throw new CreatorStreamError("http");
  return readEvents(response.body, reworkEventSchema);
}
