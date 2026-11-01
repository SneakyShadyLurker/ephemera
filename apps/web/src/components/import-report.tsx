import type { ImportReport } from "@ephemera/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * An imported file's report: what became of it and, on request, what was
 * kept, changed and left out. Names and codes only, never the file's text.
 */

/** One file's line: why it was not imported, or `summary` and the report behind Show details. */
export function ImportReportLine({
  outcome,
  summary,
  onDismiss,
}: {
  outcome: { ok: false; file: string; reason: string } | { ok: true; report: ImportReport };
  /** What was imported, as a sentence: "Imported Harbour." */
  summary: string;
  onDismiss: () => void;
}) {
  const [details, setDetails] = useState(false);
  if (!outcome.ok) {
    return (
      <div role="status" className="grid justify-items-start gap-1 text-note arrive">
        <p className="text-pretty text-ember">
          {outcome.file} was not imported: {outcome.reason}.
        </p>
        <Button size="text" className="-ml-2" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }
  const { report } = outcome;
  const quiet = report.changed.length === 0 && report.skipped.length === 0;
  return (
    <div role="status" className="grid max-w-column gap-2 arrive">
      <p className="text-pretty text-ink text-note">
        {summary}
        {!quiet && <span className="text-reed"> Some settings changed or were left out.</span>}
      </p>
      <div className="-ml-2 flex flex-wrap gap-1">
        {hasReport(report) && (
          <Button size="text" aria-expanded={details} onClick={() => setDetails(!details)}>
            {details ? "Hide details" : "Show details"}
          </Button>
        )}
        <Button size="text" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {details && (
        <div className="grid gap-3 border-rush border-l pl-4 text-note transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0">
          <ReportGroups report={report} />
        </div>
      )}
    </div>
  );
}

/** Whether a report has anything to show behind Show details. */
export const hasReport = (report: ImportReport): boolean =>
  report.kept.length + report.changed.length + report.skipped.length > 0;

/** What was kept, changed and left out, each group only when it has lines. */
export function ReportGroups({ report }: { report: ImportReport }) {
  return (
    <>
      <ReportGroup title="Kept" items={report.kept} />
      <ReportGroup title="Changed" items={report.changed} />
      <ReportGroup title="Left out" items={report.skipped} />
    </>
  );
}

/** One group of report lines under its title, a level below the surrounding heading; nothing when it has none. */
export function ReportGroup({
  title,
  items,
  heading: Heading = "h3",
}: {
  title: string;
  items: string[];
  heading?: "h3" | "h4";
}) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-1">
      <Heading className="font-medium text-ink">{title}</Heading>
      <ul className="grid gap-1 text-pretty text-reed">
        {items.map((item, index) => (
          // Lines can repeat (two prompts with one name); their order is fixed.
          // biome-ignore lint/suspicious/noArrayIndexKey: a static list rendered once per report.
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
