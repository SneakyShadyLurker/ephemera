import type { CallPurpose } from "@ephemera/core";
import { useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { countOf, formatCount } from "@/lib/text";
import { type LedgerCall, sumUsage, type UsageLedger, type UsageRequest } from "./usage.ts";

const PURPOSE: Record<CallPurpose, string> = {
  narration: "Narration",
  "scene.prompt": "Scene prompt",
  "cast.update": "Cast keeper",
  "cast.sheet": "Cast sheet",
  "memory.remember": "Memory",
  "memory.chapter": "Chapter",
  "memory.opening": "Opening",
};
const missing = (
  <>
    <span aria-hidden="true">–</span>
    <span className="sr-only">not reported</span>
  </>
);
const count = (value: number | undefined) => (value === undefined ? missing : formatCount(value));

export function usageSummary(calls: readonly LedgerCall[], running: number): string {
  const sums = sumUsage(calls);
  const total = calls.length + running;
  const clauses = [countOf(total, "call")];
  if (sums.counted === 0) clauses.push("no counts reported");
  else if (sums.counted < total) clauses.push(`${sums.counted} counted`);
  if (running > 0) clauses.push(`${running} running`);
  const read = sums.input.complete ? `read ${formatCount(sums.input.value)}` : "";
  const cached = sums.cached.complete ? `${formatCount(sums.cached.value)} cached` : "";
  const wrote = sums.output.complete ? `wrote ${formatCount(sums.output.value)}` : "";
  const figures = [read, cached, wrote].filter(Boolean).join(", ");
  return `${clauses.join(", ")}${figures ? `: ${figures}` : ""}`;
}

const callStatus = ({ record, unknown }: LedgerCall): string => {
  if (unknown) return `${record.status}; no receipt`;
  if (Object.keys(record.usage).length === 0) {
    if (record.status === "failed") return "Failed before counting";
    if (record.status === "aborted") return "Stopped before counting";
    return "No counts reported";
  }
  return record.status === "completed" ? "" : record.status;
};

export function UsageSection({
  ledger,
  generation,
  preview,
}: {
  ledger: UsageLedger;
  generation: string | null;
  preview: boolean;
}) {
  if (ledger.calls.length === 0 && ledger.running.length === 0 && !ledger.truncated) return null;
  return (
    <section aria-label="Usage" className="grid gap-1 border-rush border-t px-5 py-4">
      <h3 className="pb-1 font-medium text-ink text-ui">Usage</h3>
      {!preview && (
        <UsageDisclosure
          label="This request"
          calls={ledger.calls.filter(
            (call) => generation !== null && call.generation === generation,
          )}
          running={ledger.running.filter(
            (call) => generation !== null && call.generation === generation,
          )}
          truncated={ledger.truncated}
        />
      )}
      <UsageDisclosure
        label="This session"
        calls={ledger.calls}
        running={ledger.running}
        truncated={ledger.truncated}
        session
      />
    </section>
  );
}

export function UsageDisclosure({
  label,
  calls,
  running,
  truncated,
  session = false,
}: {
  label: string;
  calls: LedgerCall[];
  running: UsageRequest[];
  truncated: boolean;
  session?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cached = calls.some(({ record }) => record.usage.cachedTokens !== undefined);
  const sums = sumUsage(calls);
  const total = calls.length + running.length;
  const groups = session
    ? [...new Set([...calls, ...running].map((call) => call.purpose))].map((purpose) => ({
        purpose,
        calls: calls.filter((call) => call.purpose === purpose),
        running: running.filter((call) => call.purpose === purpose),
      }))
    : [];
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="press flex min-h-12 w-full items-center gap-3 rounded-md px-1 text-left hover:bg-surface-hover touch:min-h-14"
      >
        <span className="grid min-w-0 flex-1">
          <span className="font-medium text-ink text-ui">{label}</span>
          <span className="text-meta text-reed tabular-nums">
            {usageSummary(calls, running.length)}
          </span>
        </span>
        <ChevronDownIcon
          size={16}
          className={cn(
            "text-reed transition-[rotate] duration-(--duration-arrive) ease-spring motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        inert={!open}
        className={cn(
          "overflow-hidden transition-[height,opacity] duration-(--duration-panel-in) ease-spring [interpolate-size:allow-keywords] motion-reduce:transition-opacity motion-reduce:duration-(--duration-quick)",
          open ? "h-auto opacity-100" : "h-0 opacity-0",
        )}
      >
        <table
          aria-label={`${label} usage`}
          className="w-full table-fixed text-left text-meta tabular-nums"
        >
          <thead className="text-reed">
            <tr>
              <th className="w-[44%] py-2 font-normal">{session ? "Purpose" : "Call / Purpose"}</th>
              <th className="py-2 text-right font-normal">Read</th>
              {cached && <th className="py-2 text-right font-normal">Cached</th>}
              <th className="py-2 text-right font-normal">Wrote</th>
            </tr>
          </thead>
          <tbody className="align-top text-ink">
            {session
              ? groups.map(({ purpose, calls: group, running: active }) => {
                  const summary = sumUsage(group);
                  const groupTotal = group.length + active.length;
                  const models = [...new Set([...group, ...active].map((call) => call.model))];
                  const counted = group.filter(
                    ({ record }) => Object.keys(record.usage).length > 0,
                  );
                  const reasoning = counted.every(
                    ({ record }) => record.usage.reasoningTokens !== undefined,
                  )
                    ? counted.reduce(
                        (sum, { record }) => sum + (record.usage.reasoningTokens ?? 0),
                        0,
                      )
                    : 0;
                  const statuses = [...new Set(group.map(callStatus).filter(Boolean))];
                  return (
                    <tr key={purpose}>
                      <th scope="row" className="break-words py-2 pr-3 font-normal">
                        <span>
                          {PURPOSE[purpose]} <span className="text-reed">({groupTotal})</span>
                        </span>
                        <span className="block break-words text-reed">
                          {models.length === 1 ? models[0] : "Multiple models"}
                        </span>
                        {summary.counted < groupTotal && (
                          <span className="block text-reed">
                            {summary.counted} of {groupTotal} counted
                          </span>
                        )}
                        {active.length > 0 && (
                          <span className="block text-reed">{active.length} running</span>
                        )}
                        {statuses.map((status) => (
                          <span key={status} className="block text-reed">
                            {group.filter((call) => callStatus(call) === status).length}{" "}
                            {status.toLowerCase()}
                          </span>
                        ))}
                      </th>
                      <td className="py-2 text-right">
                        {summary.input.complete ? formatCount(summary.input.value) : missing}
                      </td>
                      {cached && (
                        <td className="py-2 text-right">
                          {summary.cached.complete ? formatCount(summary.cached.value) : missing}
                        </td>
                      )}
                      <td className="py-2 text-right">
                        {summary.output.complete ? formatCount(summary.output.value) : missing}
                        {reasoning > 0 && (
                          <span className="block text-reed">
                            {formatCount(reasoning)} reasoning
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              : calls.map((call, index) => {
                  const { record } = call;
                  const status = callStatus(call);
                  return (
                    <tr key={record.id}>
                      <th scope="row" className="break-words py-2 pr-3 font-normal">
                        <span>
                          {index + 1}. {PURPOSE[record.purpose]}
                        </span>
                        <span className="block break-words text-reed">{record.model}</span>
                        {status && <span className="block text-reed">{status}</span>}
                      </th>
                      <td className="py-2 text-right">{count(record.usage.inputTokens)}</td>
                      {cached && (
                        <td className="py-2 text-right">{count(record.usage.cachedTokens)}</td>
                      )}
                      <td className="py-2 text-right">
                        {count(record.usage.outputTokens)}
                        {(record.usage.reasoningTokens ?? 0) > 0 && (
                          <span className="block text-reed">
                            {formatCount(record.usage.reasoningTokens ?? 0)} reasoning
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            {!session &&
              running.map((request) => (
                <tr key={request.id}>
                  <th scope="row" className="break-words py-2 pr-3 font-normal">
                    {PURPOSE[request.purpose]}
                    <span className="block break-words text-reed">{request.model}</span>
                    <span className="block text-reed">Running</span>
                  </th>
                  <td className="py-2 text-right">{missing}</td>
                  {cached && <td className="py-2 text-right">{missing}</td>}
                  <td className="py-2 text-right">{missing}</td>
                </tr>
              ))}
          </tbody>
          <tfoot className="border-rush border-t text-ink">
            <tr>
              <th scope="row" className="break-words py-2 pr-2 font-medium">
                {total > 0 && sums.counted === total
                  ? "Counted"
                  : `Counted ${sums.counted} of ${total} calls`}
              </th>
              <td className="py-2 text-right">
                {sums.input.complete ? formatCount(sums.input.value) : missing}
              </td>
              {cached && (
                <td className="py-2 text-right">
                  {sums.cached.complete ? formatCount(sums.cached.value) : missing}
                </td>
              )}
              <td className="py-2 text-right">
                {sums.output.complete ? formatCount(sums.output.value) : missing}
              </td>
            </tr>
          </tfoot>
        </table>
        <div className="grid gap-1 pt-1 pb-3 text-meta text-reed">
          {([sums.input, sums.cached, sums.output].some((field) => !field.complete) ||
            running.length > 0) && (
            <p>
              Unreported fields and running calls are unknown. Read, cached and wrote sums include
              counted calls only; each sum is unknown if any counted call omitted that field.
            </p>
          )}
          {calls.some(({ record }) => record.status !== "completed") && (
            <p>Failed or aborted attempts may have used tokens.</p>
          )}
          {calls.some(({ unknown }) => unknown) && (
            <p>Without a receipt, the number of provider attempts is unknown.</p>
          )}
          {truncated && (
            <p>
              Accounting truncated: the record limit was reached. Counts cover retained records
              only.
            </p>
          )}
          {session && (
            <>
              <p>Counted in this tab only; Clear or closing the tab drops them.</p>
              <p>Image generation is excluded.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
