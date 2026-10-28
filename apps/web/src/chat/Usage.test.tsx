import type { CallPurpose, CallRecord } from "@ephemera/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageDisclosure, usageSummary } from "./Usage.tsx";
import type { LedgerCall, UsageRequest } from "./usage.ts";

const call = (
  usage: CallRecord["usage"],
  status: CallRecord["status"] = "completed",
  purpose: CallPurpose = "narration",
): LedgerCall => ({
  id: crypto.randomUUID(),
  generation: "g",
  model: "model-a",
  purpose,
  record: { id: crypto.randomUUID(), model: "model-a", purpose, status, usage },
});
const running = (purpose: CallPurpose = "narration"): UsageRequest => ({
  id: crypto.randomUUID(),
  generation: "g",
  model: "model-a",
  purpose,
});
const render = (
  calls: LedgerCall[],
  active: UsageRequest[] = [],
  session = false,
  truncated = false,
) =>
  renderToStaticMarkup(
    <UsageDisclosure
      label="Usage"
      calls={calls}
      running={active}
      session={session}
      truncated={truncated}
    />,
  );
const section = (html: string, tag: string): string => {
  const content = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(html)?.[1];
  if (content === undefined) throw new Error(`Missing ${tag}`);
  return content;
};
const cells = (html: string): string[] =>
  [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/g, "").trim(),
  );

describe("usage coverage and disclosures", () => {
  it("counts running and finished calls together, retaining complete zero cache sums", () => {
    const calls = [call({ inputTokens: 20, cachedTokens: 0, outputTokens: 4 }), call({})];
    expect(usageSummary(calls, 1)).toBe(
      "3 calls, 1 counted, 1 running: read 20, 0 cached, wrote 4",
    );
    expect(usageSummary(calls.slice(0, 1), 0)).toBe("1 call: read 20, 0 cached, wrote 4");
    expect(usageSummary([call({})], 0)).toBe("1 call, no counts reported");
    expect(usageSummary([], 1)).toBe("1 call, no counts reported, 1 running");
    const html = render(calls, [running()]);
    expect(section(html, "tfoot")).toContain("Counted 1 of 3 calls");
    expect(cells(section(html, "tfoot"))).toEqual(["20", "0", "4"]);
    expect(section(html, "tbody")).toContain("No counts reported");
    expect(section(html, "tbody")).toContain("Running");
    expect(section(render(calls.slice(0, 1)), "tfoot")).toContain(">Counted</th>");
  });

  it("groups running calls with their purpose, including a purpose with no finished calls", () => {
    const html = render(
      [call({ inputTokens: 20 }), call({})],
      [running(), running("cast.update")],
      true,
    );
    const body = section(html, "tbody");
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1] ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Narration");
    expect(rows[0]).toContain("(3)");
    expect(rows[0]).toContain("1 of 3 counted");
    expect(rows[0]).toContain("1 running");
    expect(rows[0]).toContain("1 no counts reported");
    expect(cells(rows[0] ?? "")).toEqual(["20", "–not reported"]);
    expect(rows[1]).toContain("Cast keeper");
    expect(rows[1]).toContain("(1)");
    expect(rows[1]).toContain("0 of 1 counted");
    expect(rows[1]).toContain("1 running");
    expect(section(html, "tfoot")).toContain("Counted 1 of 4 calls");
    expect([...html.matchAll(/<th scope="row"/g)]).toHaveLength(3);
    expect(html).toContain("tabular-nums");
    expect(html).toContain("break-words");
  });

  it("distinguishes no-usage receipts from failure, Stop and a lost receipt", () => {
    const lost = { ...call({}, "aborted"), unknown: true as const };
    const html = render([call({}), call({}, "failed"), call({}, "aborted"), lost], [], true, true);
    expect(html).toContain("1 no counts reported");
    expect(html).toContain("1 failed before counting");
    expect(html).toContain("1 stopped before counting");
    expect(html).toContain("1 aborted; no receipt");
    expect(html).toContain("Without a receipt, the number of provider attempts is unknown.");
    expect(html).toContain("Failed or aborted attempts may have used tokens.");
    expect(html).toContain("Accounting truncated");
    expect(html).toContain("Counts cover retained records only.");
    expect(html).toContain("Counted in this tab only");
    expect(html).toContain("Image generation is excluded.");
    const request = section(
      render([call({}), call({}, "failed"), call({}, "aborted"), lost]),
      "tbody",
    );
    for (const status of [
      "No counts reported",
      "Failed before counting",
      "Stopped before counting",
      "aborted; no receipt",
    ]) {
      expect(request).toContain(status);
    }
  });

  it("hides every incomplete field sum while preserving individual reported figures", () => {
    const calls = [
      call({ inputTokens: 20, cachedTokens: 0, outputTokens: 4, reasoningTokens: 2 }),
      call({ outputTokens: 6 }),
      call({ inputTokens: 10, reasoningTokens: 3 }),
    ];
    expect(usageSummary(calls, 0)).toBe("3 calls");
    const request = render(calls);
    expect(cells(section(request, "tbody")).slice(0, 3)).toEqual(["20", "0", "42 reasoning"]);
    for (const session of [false, true]) {
      const html = render(calls, [], session);
      expect(cells(section(html, "tfoot"))).toEqual(Array(3).fill("–not reported"));
      if (session) {
        expect(cells(section(html, "tbody"))).toEqual(Array(3).fill("–not reported"));
        expect(section(html, "tbody")).not.toContain("5 reasoning");
      }
      expect(html).toContain("Read, cached and wrote sums include counted calls only");
      expect(html).toContain("each sum is unknown if any counted call omitted that field.");
    }
  });
});
