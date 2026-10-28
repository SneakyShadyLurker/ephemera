import type { ArtStreamEvent, CallAccounting, SceneRequest } from "@ephemera/core";
import { api } from "../api.ts";
import { artEvents } from "../creator/stream.ts";
import { refusedBeforeCall } from "../model-call.ts";

/**
 * Pictures the chat's current moment (PRINCIPLES.md 1): the scene source goes
 * out, progress and one PNG come back as the art stream's events, and
 * nothing here keeps either. A sign-in refusal throws `SignedOut`.
 */
export async function streamScene(
  request: SceneRequest,
  signal: AbortSignal,
  onAccounting?: (accounting: CallAccounting) => void,
): Promise<AsyncGenerator<ArtStreamEvent>> {
  const response = await api.scene.$post({ json: request }, { init: { signal } });
  refusedBeforeCall(response.status, onAccounting);
  const events = await artEvents(response);
  return (async function* () {
    for await (const event of events) {
      if ("accounting" in event && event.accounting !== undefined) {
        onAccounting?.(event.accounting);
        const { accounting: _accounting, ...content } = event;
        yield content;
      } else yield event;
    }
  })();
}
