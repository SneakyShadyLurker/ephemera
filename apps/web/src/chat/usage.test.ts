import type { CallAccounting, CallRecord } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { createChatStore } from "./store.ts";
import {
  emptyUsage,
  finishUsage,
  LEDGER_LIMIT,
  receiveUsage,
  startUsage,
  sumUsage,
} from "./usage.ts";

const request = {
  id: crypto.randomUUID(),
  generation: "first",
  model: "m",
  purpose: "narration" as const,
};
const record = (usage: CallRecord["usage"] = {}): CallRecord => ({
  id: crypto.randomUUID(),
  model: "m",
  purpose: "narration",
  status: "completed",
  usage,
});
const receipt = (...calls: CallRecord[]): CallAccounting => ({ calls, truncated: false });
describe("the tab's bounded usage ledger", () => {
  it("deduplicates provider IDs and replaces an unknown browser result with a late receipt", () => {
    const unknown = finishUsage(startUsage(emptyUsage(), request), request, "aborted");
    expect(unknown.calls[0]).toMatchObject({
      unknown: true,
      generation: "first",
      record: { status: "aborted", usage: {} },
    });
    const reported = receipt(record({ inputTokens: 20, outputTokens: 5 }));
    const settled = receiveUsage(unknown, request, reported);
    expect(settled.calls).toHaveLength(1);
    expect(settled.calls[0]?.unknown).toBeUndefined();
    expect(
      receiveUsage(settled, { ...request, id: crypto.randomUUID(), generation: "second" }, reported)
        .calls,
    ).toEqual(settled.calls);
  });
  it("does not count preflight or queued refusals as model work", () => {
    expect(finishUsage(startUsage(emptyUsage(), request), request).calls).toEqual([]);
    expect(receiveUsage(startUsage(emptyUsage(), request), request, receipt()).calls).toEqual([]);
  });
  it("bounds records without reopening deduplication of retained IDs and labels truncation", () => {
    let ledger = emptyUsage();
    const calls = Array.from({ length: LEDGER_LIMIT + 1 }, () => record({ inputTokens: 1 }));
    for (const call of calls) ledger = receiveUsage(ledger, request, receipt(call));
    expect(ledger.calls).toHaveLength(LEDGER_LIMIT);
    expect(ledger.truncated).toBe(true);
    expect(receiveUsage(ledger, request, receipt(calls[0] as CallRecord)).calls).toEqual(
      ledger.calls,
    );
  });
  it("does not invent a cached or output sum when a contributing call omitted it", () => {
    const ledger = receiveUsage(
      emptyUsage(),
      request,
      receipt(
        record({ inputTokens: 10, cachedTokens: 0, outputTokens: 0 }),
        record({ inputTokens: 20 }),
      ),
    );
    expect(sumUsage(ledger.calls)).toMatchObject({
      counted: 2,
      input: { value: 30, complete: true },
      cached: { reports: 1, complete: false },
      output: { reports: 1, complete: false },
    });
  });
  it("keeps input unknown too, excludes empty receipts from sums, and retains reported zeroes", () => {
    const ledger = receiveUsage(
      emptyUsage(),
      request,
      receipt(
        record({ inputTokens: 10, cachedTokens: 0, outputTokens: 0 }),
        record({ cachedTokens: 0, outputTokens: 0 }),
        record(),
      ),
    );
    expect(sumUsage(ledger.calls)).toMatchObject({
      counted: 2,
      input: { reports: 1, complete: false },
      cached: { value: 0, complete: true },
      output: { value: 0, complete: true },
    });
  });
  it("captures generation ownership and drops old handles after Clear", () => {
    const store = createChatStore(
      async function* () {},
      () => ({
        model: "m",
        characterId: null,
        personaId: null,
        samplerPresetId: null,
        promptPresetId: null,
        reasoning: null,
      }),
      {
        clock: () => ({ now: 0, timeZone: "UTC" }),
        fetchPreview: async () => ({ ok: false, error: "unavailable" }),
      },
    );
    const first = store.getState().trackUsage("cast.update", "m", "first");
    const second = store.getState().trackUsage("narration", "m", "second");
    second.receive(receipt(record()));
    first.receive(receipt(record()));
    expect(store.getState().usage.calls.map((call) => call.generation)).toEqual([
      "first",
      "second",
    ]);
    const late = store.getState().trackUsage("memory.opening", "m");
    store.getState().clear();
    late.receive(receipt(record()));
    late.finish("aborted");
    expect(store.getState().usage).toEqual(emptyUsage());
  });
});
