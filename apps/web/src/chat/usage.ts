import type { CallAccounting, CallPurpose, CallRecord } from "@ephemera/core";

export const LEDGER_LIMIT = 512;
export interface UsageRequest {
  id: string;
  generation: string | null;
  purpose: CallPurpose;
  model: string;
  order?: number;
}
export interface LedgerCall extends UsageRequest {
  record: CallRecord;
  /** The browser has no server receipt. A later receipt replaces this row. */
  unknown?: true;
}
export interface UsageLedger {
  calls: LedgerCall[];
  running: UsageRequest[];
  truncated: boolean;
}
export const emptyUsage = (): UsageLedger => ({ calls: [], running: [], truncated: false });
export interface UsageHandle {
  receive: (accounting: CallAccounting) => void;
  finish: (unknown?: "completed" | "failed" | "aborted") => void;
}
export function startUsage(ledger: UsageLedger, request: UsageRequest): UsageLedger {
  if (ledger.running.some((item) => item.id === request.id)) return ledger;
  if (ledger.running.length >= 64) return { ...ledger, truncated: true };
  return { ...ledger, running: [...ledger.running, request] };
}
export function receiveUsage(
  ledger: UsageLedger,
  request: UsageRequest,
  accounting: CallAccounting,
): UsageLedger {
  const calls = ledger.calls.filter((call) => !(call.id === request.id && call.unknown));
  const known = new Set(calls.map((call) => call.record.id));
  let truncated = ledger.truncated || accounting.truncated;
  for (const record of accounting.calls) {
    if (known.has(record.id)) continue;
    if (calls.length >= LEDGER_LIMIT) {
      truncated = true;
      continue;
    }
    calls.push({ ...request, purpose: record.purpose, model: record.model, record });
    known.add(record.id);
  }
  calls.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { calls, running: ledger.running.filter((item) => item.id !== request.id), truncated };
}
export function finishUsage(
  ledger: UsageLedger,
  request: UsageRequest,
  unknown?: "completed" | "failed" | "aborted",
): UsageLedger {
  const finished = { ...ledger, running: ledger.running.filter((item) => item.id !== request.id) };
  if (unknown === undefined || ledger.calls.some((call) => call.id === request.id)) return finished;
  if (finished.calls.length >= LEDGER_LIMIT) return { ...finished, truncated: true };
  const calls: LedgerCall[] = [
    ...finished.calls,
    {
      ...request,
      unknown: true,
      record: {
        id: request.id,
        purpose: request.purpose,
        model: request.model,
        status: unknown,
        usage: {},
      },
    },
  ];
  calls.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { ...finished, calls };
}

export function sumUsage(calls: readonly LedgerCall[]) {
  const counted = calls.filter(({ record }) => Object.keys(record.usage).length > 0);
  const sum = (field: "inputTokens" | "cachedTokens" | "outputTokens") => {
    const reporting = counted.filter(({ record }) => record.usage[field] !== undefined);
    return {
      value: reporting.reduce((n, { record }) => n + (record.usage[field] ?? 0), 0),
      reports: reporting.length,
      complete: reporting.length === counted.length && counted.length > 0,
    };
  };
  return {
    counted: counted.length,
    input: sum("inputTokens"),
    cached: sum("cachedTokens"),
    output: sum("outputTokens"),
  };
}
