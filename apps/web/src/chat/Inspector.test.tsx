import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { countedSentence } from "./Inspector.tsx";
import { UsageDisclosure, UsageSection, usageSummary } from "./Usage.tsx";
import { emptyUsage, type LedgerCall } from "./usage.ts";

const counted = { inputTokens: 12_345, cachedTokens: 9_800 };

describe("the inspector's usage sentence", () => {
  it("says what the model read and wrote, reasoning included", () => {
    expect(countedSentence(12_000, { ...counted, outputTokens: 820, reasoningTokens: 210 })).toBe(
      "Estimated 12,000; the model counted 12,345, of which 9,800 were cached; it wrote 820, 210 of them reasoning.",
    );
  });

  it("stops at the input clause when the provider gave no output figures", () => {
    expect(countedSentence(12_000, { ...counted, outputTokens: null, reasoningTokens: null })).toBe(
      "Estimated 12,000; the model counted 12,345, of which 9,800 were cached.",
    );
  });

  it("leaves out a reasoning share of 0 and shows a cache figure of 0 as given", () => {
    expect(
      countedSentence(40, {
        inputTokens: 40,
        cachedTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
      }),
    ).toBe("Estimated 40; the model counted 40, of which 0 were cached; it wrote 2.");
  });
});

describe("the inspector's usage disclosures", () => {
  const call = (
    usage: LedgerCall["record"]["usage"],
    status: LedgerCall["record"]["status"] = "completed",
  ): LedgerCall => ({
    id: crypto.randomUUID(),
    generation: "g",
    purpose: "narration",
    model: "model-a",
    record: { id: crypto.randomUUID(), purpose: "narration", model: "model-a", status, usage },
  });
  it("shows reported counts while keeping missing cached/output figures unknown", () => {
    const calls = [
      call({ inputTokens: 100, cachedTokens: 0, outputTokens: 30, reasoningTokens: 10 }),
      call({ inputTokens: 40 }, "failed"),
    ];
    expect(usageSummary(calls, 1)).toBe("3 calls, 2 counted, 1 running: read 140");
    const html = renderToStaticMarkup(
      <UsageDisclosure label="This request" calls={calls} running={[]} truncated={false} />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('inert=""');
    expect(html).toContain('class="sr-only">not reported');
    expect(html).toContain("10 reasoning");
    expect(html).toContain("Failed or aborted attempts may have used tokens");
  });
  it("groups session purposes, omits an unreported cache column, and labels limits and exclusions", () => {
    const ledger = {
      ...emptyUsage(),
      calls: [call({ inputTokens: 5 }), call({})],
      truncated: true,
    };
    const html = renderToStaticMarkup(<UsageSection ledger={ledger} generation="g" preview />);
    expect(html).not.toContain("This request");
    expect(html).toContain("This session");
    expect(html).not.toContain(">Cached<");
    expect(html).toContain("Counted 1 of 2 calls");
    expect(html).toContain("Accounting truncated");
    expect(html).toContain("Image generation is excluded");
    expect(html).toContain("Counted in this tab only");
  });
});
